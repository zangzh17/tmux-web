#!/usr/bin/env node
// tmux-web API: Cloudflare Access JWT verification + tmux session management.
// Listens on a Unix socket only (dir is 0700). Caddy calls /verify via
// forward_auth for every request and proxies /api/* here; /api/* re-checks the
// JWT itself so the socket is safe even if the proxy config is wrong.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const SOCK = process.env.TMUX_WEB_API_SOCK
  || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'tmux-web', 'api.sock');
const TMUX = process.env.TMUX_BIN || '/usr/bin/tmux';
const PREVIEW = process.env.TMUX_WEB_PREVIEW !== '0';

const normalizeTeam = (v) => {
  v = (v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return v && !v.includes('.') ? `${v}.cloudflareaccess.com` : v;
};
const TEAM = normalizeTeam(process.env.CF_ACCESS_TEAM_DOMAIN);
const AUD = (process.env.CF_ACCESS_AUD || '').trim();
const CERTS_URL = process.env.CF_ACCESS_CERTS_URL || (TEAM && `https://${TEAM}/cdn-cgi/access/certs`);
const ISSUER = process.env.CF_ACCESS_ISSUER || (TEAM && `https://${TEAM}`);
const EMAILS = new Set((process.env.ALLOWED_EMAILS || '').split(/[,\s]+/).filter(Boolean).map((s) => s.toLowerCase()));

// ---- logging (deny reasons are rate-limited: every asset request would repeat them)
const lastLogged = new Map();
function logOnce(msg) {
  const now = Date.now();
  if (now - (lastLogged.get(msg) || 0) < 60_000) return;
  lastLogged.set(msg, now);
  console.error(msg);
}

// ---- JWKS cache
let keys = new Map();
let keysFetchedAt = 0;
let lastAttempt = 0;
let inflight = null;

function refreshKeys() {
  if (inflight) return inflight;
  if (Date.now() - lastAttempt < 10_000) return Promise.resolve();
  lastAttempt = Date.now();
  inflight = (async () => {
    const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`certs endpoint returned ${res.status}`);
    const next = new Map();
    for (const jwk of (await res.json()).keys || []) {
      if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    if (!next.size) throw new Error('no RSA keys in certs response');
    keys = next;
    keysFetchedAt = Date.now();
  })().catch((e) => logOnce(`[tmux-web] JWKS refresh failed: ${e.message}`)).finally(() => { inflight = null; });
  return inflight;
}

async function getKey(kid) {
  if (!keys.has(kid) || Date.now() - keysFetchedAt > 3600_000) await refreshKeys();
  return keys.get(kid);
}

// ---- JWT verification
const b64u = (s) => Buffer.from(s, 'base64url');

async function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(b64u(parts[0]).toString());
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported alg/kid');
  const key = await getKey(header.kid);
  if (!key) throw new Error('unknown signing key');
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2]))) {
    throw new Error('bad signature');
  }
  const c = JSON.parse(b64u(parts[1]).toString());
  const now = Date.now() / 1000;
  if (c.iss !== ISSUER) throw new Error('bad issuer');
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(AUD)) throw new Error('bad audience');
  if (typeof c.exp !== 'number' || c.exp + 30 < now) throw new Error('token expired');
  if (typeof c.nbf === 'number' && c.nbf - 30 > now) throw new Error('token not yet valid');
  if (EMAILS.size && !EMAILS.has(String(c.email || '').toLowerCase())) throw new Error('email not allowed');
  return c;
}

async function authorize(req) {
  if (!TEAM || !AUD) {
    logOnce('[tmux-web] CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not set: refusing all requests');
    return { ok: false, status: 503, reason: 'access not configured' };
  }
  let token = req.headers['cf-access-jwt-assertion'];
  if (!token) token = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return { ok: false, status: 401, reason: 'no access token' };
  let claims;
  try {
    claims = await verifyJwt(token);
  } catch (e) {
    logOnce(`[tmux-web] denied: ${e.message}`);
    return { ok: false, status: 401, reason: 'invalid access token' };
  }
  // The web layer separates people by email (a service token has none, so it gets no identity at all).
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, status: 403, reason: 'identity has no email', json: true };
  return { ok: true, claims, user: userFor(email) };
}

// ---- people: who may see whose sessions
// Every session runs as the one Unix user; the web layer only decides which of them a signed-in person is shown and may
// touch. A session started from the web is stamped with its owner (the tmux session option @tmux_web_owner, lowercased
// email); sessions started any other way carry no stamp and are "local".
// users.json (TMUX_WEB_USERS, default ~/.config/tmux-web/users.json), re-read when it changes:
//   { "unowned": "all" | "viewers" | "none",   who sees local sessions: everyone (default), only people who may view others, nobody
//     "users": { "a@x.com": { "name": "Alice", "viewOthers": "all" | ["b@x.com"], "manageOthers": "all" | ["b@x.com"] } } }
// viewOthers: may look at those people's sessions, read-only. manageOthers: may also type into, rename and close them, as if
// they were their own (and implies viewing). A person allowed in by Access but not listed is a plain user: shown their own
// and local sessions only.
const USERS_FILE = process.env.TMUX_WEB_USERS || path.join(os.homedir(), '.config', 'tmux-web', 'users.json');
const NO_USERS = { unowned: 'all', users: new Map() };
let usersConfig = NO_USERS;
// Multi-user is OPTIONAL. It is on exactly when a users file exists (and TMUX_WEB_MULTI_USER is not "0"); without one every
// person Access lets in is simply the operator: all sessions are shown to them and they may touch all of them, nothing is
// stamped with an owner, and /api/me says `multiUser: false` so the page shows none of the multi-user controls.
const MULTI_USER_FORCED_OFF = process.env.TMUX_WEB_MULTI_USER === '0';
let usersStamp = '';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// "all", or a non-empty set of lowercased emails, or null (nobody)
function scopeOf(value) {
  if (value === 'all') return 'all';
  const list = Array.isArray(value) ? new Set(value.filter((e) => typeof e === 'string').map((e) => e.trim().toLowerCase()).filter(Boolean)) : null;
  return list?.size ? list : null;
}
function parseUsers(raw) {
  if (!isObject(raw) || (raw.users !== undefined && !isObject(raw.users))) throw new Error('expected {"users": {...}}');
  const users = new Map();
  for (const [email, entry] of Object.entries(raw.users || {})) {
    if (!isObject(entry)) throw new Error(`user ${email} is not an object`);
    users.set(email.trim().toLowerCase(), {
      name: typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 48 ? entry.name.trim() : '',
      viewOthers: scopeOf(entry.viewOthers),
      manageOthers: scopeOf(entry.manageOthers),
    });
  }
  return { unowned: ['all', 'viewers', 'none'].includes(raw.unowned) ? raw.unowned : 'all', users };
}
function config() {
  let stamp = '';
  try { const st = fs.statSync(USERS_FILE, { bigint: true }); stamp = `${st.mtimeNs}:${st.size}:${st.ino}`; } catch { /* no file: no extra permissions */ }
  if (stamp === usersStamp) return usersConfig;
  usersStamp = stamp; // a broken file is read once per change, not once per request
  if (!stamp) return (usersConfig = NO_USERS);
  try { usersConfig = parseUsers(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))); }
  catch (e) { logOnce(`[tmux-web] ${USERS_FILE}: ${e.message}; keeping the previous permissions`); }
  return usersConfig;
}
const localPart = (email) => email.split('@')[0] || email;
const displayName = (email) => config().users.get(email)?.name || localPart(email);
const userFor = (email) => {
  const entry = config().users.get(email);
  return { email, name: displayName(email), viewOthers: entry?.viewOthers ?? null, manageOthers: entry?.manageOthers ?? null };
};
const multiUser = () => !MULTI_USER_FORCED_OFF && config() !== NO_USERS;
const mayViewOthers = (user) => !!(user.viewOthers || user.manageOthers);
const covers = (scope, owner) => scope === 'all' || !!scope?.has(owner);
// 'full' (own, local when allowed, or someone else's that I may manage) | 'view' (someone else's, read-only) | null (not for this person)
function accessFor(user, owner) {
  if (!multiUser()) return 'full';
  if (owner === user.email) return 'full';
  if (!owner) {
    const { unowned } = config();
    return unowned === 'all' || (unowned === 'viewers' && mayViewOthers(user)) ? 'full' : null;
  }
  if (covers(user.manageOthers, owner)) return 'full';
  return covers(user.viewOthers, owner) ? 'view' : null;
}
const ownerOf = (owner) => (owner ? { email: owner, name: displayName(owner) } : null);

// ---- tmux
const FIELDS = ['session_id', 'pid', 'session_name', 'session_windows', 'session_attached', 'session_activity',
  'session_created', 'pane_current_command', 'pane_current_path', 'pane_id', '@tmux_web_owner'];
const FMT = FIELDS.map((f) => `#{${f}}`).join('\t');

const tmux = (args, maxBuffer = 1 << 20) => new Promise((resolve, reject) => {
  execFile(TMUX, args, { timeout: 3000, maxBuffer }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
  });
});

async function peek(paneId) {
  if (!PREVIEW || !/^%\d+$/.test(paneId)) return [];
  try {
    return (await tmux(['capture-pane', '-p', '-S', '-100', '-t', paneId])).split('\n')
      .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, '').trimEnd())
      .filter((l) => l.trim()).slice(-50).map((l) => l.slice(0, 160));
  } catch { return []; }
}

async function listRows() {
  let out;
  try {
    out = await tmux(['list-sessions', '-F', FMT]);
  } catch (e) {
    if (/no server running|error connecting to|no sessions/i.test(e.stderr || '')) return [];
    throw e;
  }
  const home = os.homedir();
  return out.split('\n').filter(Boolean).map((l) => l.split('\t')).filter((f) => f.length === FIELDS.length)
    .map(([id, serverPid, name, windows, attached, activity, created, command, cwd, paneId, owner]) => ({
      id, instance: `${serverPid}:${created}`, name, command,
      windows: +windows, attached: +attached, activity: +activity, created: +created,
      path: cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd,
      paneId, owner: owner.trim().toLowerCase(),
    }));
}

// ?owner= is a list (repeated and/or comma separated) of: me, local, all (everything the caller may see) or an email.
// Default: my sessions plus the local ones. Anything the caller may not view is dropped, not reported.
function ownerSpecs(user, query) {
  if (!multiUser()) return ['all'];
  const asked = query.getAll('owner').flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean);
  const applied = new Set();
  for (const spec of asked.length ? asked : ['me', 'local']) {
    if (spec === 'me' || spec === user.email) applied.add('me');
    else if (spec === 'local') { if (accessFor(user, '')) applied.add('local'); }
    else if (spec === 'all') applied.add('all');
    else if (spec.includes('@') && accessFor(user, spec)) applied.add(spec);
  }
  return [...applied];
}

async function listSessions(user, specs, withPreview) {
  const wanted = (owner) => specs.includes('all') || (owner === user.email ? specs.includes('me') : owner ? specs.includes(owner) : specs.includes('local'));
  const rows = (await listRows()).filter((r) => accessFor(user, r.owner) && wanted(r.owner));
  // previews are read only for what is returned: a session hidden by the filter never has its screen captured
  const sessions = await Promise.all(rows.map(async ({ paneId, owner, ...row }) => ({
    ...row, owner: multiUser() ? ownerOf(owner) : null, mine: multiUser() && owner === user.email, access: accessFor(user, owner),
    preview: withPreview ? await peek(paneId) : [],
  })));
  return sessions.sort((a, b) => b.activity - a.activity);
}

// GET /api/me: { multiUser, email, name, canViewOthers, canManageOthers, people, local }: who I am and whose sessions I may look at
// or manage (the filter UI is only offered when canViewOthers; none of it when multiUser is false).
async function whoAmI(user) {
  if (!multiUser()) return { multiUser: false, email: user.email, name: user.name, canViewOthers: false, canManageOthers: false, people: [], local: 0 };
  const rows = await listRows();
  const owned = new Map();
  for (const r of rows) if (r.owner) owned.set(r.owner, (owned.get(r.owner) || 0) + 1);
  const scopes = [user.viewOthers, user.manageOthers];
  const emails = scopes.includes('all') ? [...new Set([...config().users.keys(), ...owned.keys()])]
    : [...new Set(scopes.flatMap((scope) => (scope ? [...scope] : [])))];
  const people = emails.filter((e) => e !== user.email).map((email) => ({ email, name: displayName(email), sessions: owned.get(email) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  return { multiUser: true, email: user.email, name: user.name, canViewOthers: mayViewOthers(user), canManageOthers: !!user.manageOthers, people,
    local: accessFor(user, '') ? rows.filter((r) => !r.owner).length : 0 };
}

// ---- per-person display preferences (font sizes, Read view size/width, which view a session opens in)
// Kept here as well as in the browser so they survive Safari clearing site data and follow the person to another device of the
// same kind: keys are "<phone|tablet|desktop>.<name>", so an iPhone and an iPad keep their own sizes. One small JSON file,
// { "<email>": { "<key>": "<value>" } }, written atomically (TMUX_WEB_PREFS, default ~/.local/state/tmux-web/prefs.json).
const PREFS_FILE = process.env.TMUX_WEB_PREFS || path.join(os.homedir(), '.local', 'state', 'tmux-web', 'prefs.json');
const PREF_KEY = /^(?:phone|tablet|desktop)\.(?:fs|readScale|readWidth|view)$(?![\s\S])/;
const PREF_VALUE = /^[A-Za-z0-9.-]{1,16}$(?![\s\S])/;
let prefsWrite = Promise.resolve();
function readPrefs() {
  try { const all = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); return isObject(all) ? all : {}; } catch { return {}; }
}
const prefsOf = (all, email) => (isObject(all[email]) ? Object.fromEntries(Object.entries(all[email]).filter(([k, v]) => PREF_KEY.test(k) && typeof v === 'string' && PREF_VALUE.test(v))) : {});
// PUT /api/prefs { prefs: { key: value | null } }: merged into what is stored (null removes a key); answers with the result.
async function savePrefs(req, user) {
  const input = await readMutation(req, 4096);
  if (input.status) return input;
  const { prefs } = input.data;
  if (!isObject(prefs) || Object.entries(prefs).some(([k, v]) => !PREF_KEY.test(k) || (v !== null && (typeof v !== 'string' || !PREF_VALUE.test(v))))) {
    return { status: 400, body: { error: 'invalid preferences' } };
  }
  const run = prefsWrite.then(() => {
    const all = readPrefs();
    const mine = { ...prefsOf(all, user.email) };
    for (const [k, v] of Object.entries(prefs)) { if (v === null) delete mine[k]; else mine[k] = v; }
    all[user.email] = mine;
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true, mode: 0o700 });
    const temp = `${PREFS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(all, null, 1)}\n`, { mode: 0o600 });
    fs.renameSync(temp, PREFS_FILE);
    return mine;
  });
  prefsWrite = run.catch(() => {});
  return { status: 200, body: { prefs: await run } };
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$(?![\s\S])/;
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,47}$(?![\s\S])/u;
const SESSION_ID = /^\$\d+$(?![\s\S])/;
const SESSION_INSTANCE = /^\d+:\d+$(?![\s\S])/;
const missingSession = (e) => /can't find session|no server running|error connecting to|no sessions/i.test(e.stderr || '');
// display-message/capture-pane take a target-pane, so a dead session ID is reported as a missing pane.
const missingTarget = (e) => missingSession(e) || /can't find (?:pane|window)/i.test(e.stderr || '');

async function readMutation(req, limit = 1024) {
  // Every mutation requires JSON and a matching Origin, including deletion.
  const origin = req.headers.origin;
  const host = req.headers.host;
  let source;
  try { source = new URL(origin); } catch { return { status: 403, body: { error: 'origin not allowed' } }; }
  if (!host || source.host !== host || (source.protocol !== 'https:'
    && !(source.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)))) {
    return { status: 403, body: { error: 'origin not allowed' } };
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
    return { status: 415, body: { error: 'expected JSON' } };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) return { status: 413, body: { error: 'request too large' } };
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid body');
    return { data };
  } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
}

async function createSession(req, user) {
  const input = await readMutation(req);
  if (input.status) return input;
  const { name } = input.data;
  if (typeof name !== 'string' || !SESSION_NAME.test(name)) {
    return { status: 400, body: { error: 'invalid session name' } };
  }
  let id, instance;
  try {
    [id, instance] = (await tmux(['new-session', '-d', '-s', name, '-c', os.homedir(), '-P', '-F', '#{session_id}\t#{pid}:#{session_created}'])).trim().split('\t');
  } catch (e) {
    if (/duplicate session/i.test(e.stderr || '')) return { status: 409, body: { error: 'session already exists' } };
    throw e;
  }
  try {
    if (multiUser()) await tmux(['set-option', '-t', id, '@tmux_web_owner', user.email]);
  } catch (e) {
    // never leave a web-created session without an owner (it would show up as local for everyone)
    await tmux(['kill-session', '-t', id]).catch(() => {});
    throw e;
  }
  return { status: 201, body: { id, instance, name, owner: ownerOf(user.email) } };
}

async function changeSession(req, id) {
  if (!SESSION_ID.test(id)) return { status: 400, body: { error: 'invalid session id' } };
  const input = await readMutation(req);
  if (input.status) return input;
  const { name, confirmed, instance } = input.data;
  if (typeof instance !== 'string' || !SESSION_INSTANCE.test(instance)) {
    return { status: 400, body: { error: 'invalid session identity' } };
  }
  if (req.method === 'PATCH' && (typeof name !== 'string' || !DISPLAY_NAME.test(name))) {
    return { status: 400, body: { error: 'invalid session name' } };
  }
  if (req.method === 'DELETE' && confirmed !== true) {
    return { status: 400, body: { error: 'confirmation required' } };
  }
  try {
    // IDs can be reused after the last session ends and a new server starts.
    // Check server/birth identity and mutate in one tmux command. -F evaluates
    // a tmux format, not a shell; validated names contain no quotes/metacharacters.
    const command = req.method === 'PATCH' ? `rename-session -t '${id}' '${name}'` : `kill-session -t '${id}'`;
    const result = await tmux(['if-shell', '-F', '-t', id,
      `#{==:#{pid}:#{session_created},${instance}}`, command, "display-message -p 'tmux-web: stale session'"]);
    if (result.trim() === 'tmux-web: stale session') return { status: 404, body: { error: 'session not found' } };
    return { status: 200, body: req.method === 'PATCH' ? { id, instance, name } : { id, closed: true } };
  } catch (e) {
    if (missingSession(e)) return { status: 404, body: { error: 'session not found' } };
    if (/duplicate session/i.test(e.stderr || '')) return { status: 409, body: { error: 'session already exists' } };
    throw e;
  }
}

// ---- read-only views: plain scrollback, and the Claude Code conversation behind a pane
const CLAUDE_COMMAND = new RegExp(process.env.TMUX_WEB_CLAUDE_COMMAND || 'claude', 'i');
const CLAUDE_PROJECTS = process.env.TMUX_WEB_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const gone = { status: 404, body: { error: 'session not found' } };
// What this person may do with session `id`: { access, owner }, or a 404 (a session they may not see does not exist for them).
async function resolveAccess(user, id) {
  let found, owner;
  try {
    // tmux answers display-message for an id that does not exist with an empty line and success, so the id must come back
    [found, owner = ''] = (await tmux(['display-message', '-p', '-t', id, '#{session_id}\t#{@tmux_web_owner}'])).replace(/\n$/, '').split('\t');
  } catch (e) {
    if (missingTarget(e)) return gone;
    throw e;
  }
  if (found !== id) return gone;
  owner = owner.trim().toLowerCase();
  const access = accessFor(user, owner);
  return access ? { access, owner } : gone;
}
// null when `need` is allowed; otherwise the refusal (404 unseen, 403 read-only)
async function gate(user, id, need) {
  const r = await resolveAccess(user, id);
  if (r.status) return r;
  return need === 'full' && r.access !== 'full'
    ? { status: 403, body: { error: `read-only: this session belongs to ${displayName(r.owner)}` } } : null;
}

// /verify for the terminal: ttyd's WebSocket never passes through /api, so Caddy's forward_auth call is the only gate in
// front of it. Caddy hands us the original URI in X-Forwarded-Uri (it overwrites a client-sent one). A terminal request
// names its session as ?arg=%24<digits> (ttyd --url-arg), plus &arg=ro for a read-only attach, which anyone who only
// has 'view' access must use (bin/tmux-web-attach turns it into tmux's read-only, ignore-size client).
const TERM_ARGS = /^\?arg=(?:%24|\$)(\d+)(?:&arg=(ro))?$/;
async function verifyTerminal(user, uri) {
  let url;
  let route;
  try {
    url = new URL(uri, 'http://local');
    route = path.posix.normalize(decodeURIComponent(url.pathname));
  } catch { return { status: 403, reason: 'bad request' }; }
  if (!/^\/term(?:\/|$)/i.test(route)) return { status: 200 };
  const match = TERM_ARGS.exec(url.search);
  if (!match) {
    const names = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    // the shell session is chosen by the arguments, so the WebSocket must carry exactly one well-formed choice
    if (/^\/term\/ws\/*$/i.test(route) || names.includes('arg')) return { status: 403, reason: 'bad terminal request' };
    return { status: 200 };
  }
  const r = await resolveAccess(user, `$${match[1]}`);
  if (r.status) return { status: 404, reason: 'session not found' };
  if (r.access !== 'full' && !match[2]) return { status: 403, reason: 'read-only: attach with arg=ro' };
  return { status: 200 };
}
// undefined when the parameter is absent, NaN when malformed
const num = (query, key) => { const v = query.get(key); return v == null ? undefined : /^\d{1,9}$/.test(v) ? +v : NaN; };

// GET /api/sessions/:id/history?lines=N -> { id, text }: the pane's last N (default 2000, max 5000) scrollback
// lines plus its screen, wrapped lines joined. With history_size 0 (Claude in the alternate screen) that is just the screen.
// ?screen=1 -> just the visible screen (lines is ignored), e.g. to see what a Claude prompt is asking.
async function sessionHistory(id, query) {
  const lines = Math.min(5000, num(query, 'lines') || 2000);
  const range = query.get('screen') === '1' ? [] : ['-S', `-${lines}`];
  try {
    const out = await tmux(['capture-pane', '-p', '-J', '-t', id, ...range], 16 << 20);
    const text = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');
    return { status: 200, body: { id, text } };
  } catch (e) {
    if (missingTarget(e)) return gone;
    throw e;
  }
}

// Claude Code appends one JSON record per line to ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<uuid>.jsonl.
// The file is append-only, so the item list parsed from it only ever grows and an item's index never changes.
const tidy = (s) => String(s ?? '').replace(ANSI, '').trimEnd();
const clip = (s, maxLines, maxChars) => {
  const rows = s.split('\n');
  let out = rows.length > maxLines ? rows.slice(0, maxLines).join('\n') : s;
  let cut = rows.length > maxLines;
  if (out.length > maxChars) { out = out.slice(0, maxChars).replace(/[\ud800-\udbff]$/, ''); cut = true; }
  return cut ? `${out}…` : out;
};
const TOOL_KEYS = ['command', 'file_path', 'notebook_path', 'description', 'subject', 'skill', 'query', 'pattern', 'prompt', 'url', 'plan'];

function toolText(name, input) {
  if (!input || typeof input !== 'object') return clip(tidy(input), 6, 400);
  const asked = name === 'AskUserQuestion' && Array.isArray(input.questions)
    ? input.questions.map((q) => (typeof q === 'string' ? q : q?.question ?? '')).filter(Boolean).join('\n') : '';
  const key = TOOL_KEYS.find((k) => input[k] != null);
  const v = asked || (key ? input[key] : input);
  return clip(tidy(typeof v === 'string' ? v : JSON.stringify(v)), 6, 400);
}

const resultText = (content) => typeof content === 'string' ? content : !Array.isArray(content) ? ''
  : content.map((b) => typeof b === 'string' ? b : b?.type === 'text' ? b.text ?? '' : `[${b?.type || 'unknown'}]`).join('\n');

function userItem(raw, rec, ts) {
  const s = tidy(raw).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!s) return null;
  const tag = (n) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(s)?.[1].trim() ?? '';
  if (rec.isCompactSummary || s.startsWith('This session is being continued from a previous conversation')) return { kind: 'summary', text: s, ts };
  if (s.includes('<command-name>')) return { kind: 'command', text: `${tag('command-name')} ${tag('command-args')}`.trim(), ts };
  if (/<local-command-(?:stdout|stderr)>/.test(s)) {
    const text = s.replace(/<\/?local-command-(?:stdout|stderr)>/g, '').trim();
    return text ? { kind: 'notice', text, ts } : null;
  }
  if (s.includes('<task-notification>')) {
    return { kind: 'notice', text: `Background task ${tag('status') || 'update'}${tag('summary') ? `: ${tag('summary')}` : ''}`, ts };
  }
  if (s.startsWith('[Request interrupted by user')) return { kind: 'notice', text: 'Interrupted', ts };
  return { kind: 'user', text: s, ts };
}

// One JSONL record -> zero or more items { kind, text, ts, name?, error? }; ts is the record's ISO timestamp or null.
// kind: user | assistant | tool (name = tool name) | result (error = is_error) | command | notice | summary.
function classify(rec) {
  const msg = rec?.message;
  if (!msg || rec.isSidechain || rec.isMeta) return [];
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
  const out = [];
  const role = msg.role ?? rec.type;
  if (role === 'assistant') {
    for (const b of blocks) {
      if (b?.type === 'text') {
        const text = tidy(b.text).trim();
        if (text) out.push({ kind: 'assistant', text, ts });
      } else if (b?.type === 'tool_use') {
        out.push({ kind: 'tool', name: String(b.name || ''), text: toolText(b.name, b.input), ts });
      }
    }
  } else if (role === 'user') {
    const texts = [];
    for (const b of blocks) {
      if (b?.type === 'tool_result') out.push({ kind: 'result', text: clip(tidy(resultText(b.content)), 40, 4000), ts, error: b.is_error === true });
      else if (b?.type === 'text') texts.push(b.text ?? '');
      else if (b?.type === 'image') texts.push('[image]');
    }
    const item = userItem(texts.join('\n'), rec, ts);
    if (item) out.push(item);
  }
  return out;
}

// Per-file cache { ino, offset, tail, items, chain }: only bytes past `offset` are read, and only up to the last '\n'
// (Claude may be mid-write), so a half-written final line is picked up by a later request. `tail` is the 64 bytes
// before `offset`; if they changed (or the file shrank/was replaced) the file was rewritten and parsing starts over. LRU of 16 files.
const claudeFiles = new Map();
function claudeEntry(file) {
  let entry = claudeFiles.get(file);
  if (entry) claudeFiles.delete(file); else entry = { ino: 0, offset: 0, tail: Buffer.alloc(0), items: [], chain: Promise.resolve() };
  claudeFiles.set(file, entry);
  while (claudeFiles.size > 16) claudeFiles.delete(claudeFiles.keys().next().value);
  return entry;
}

async function advance(entry, file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    let intact = st.ino === entry.ino && st.size >= entry.offset;
    if (intact && entry.offset) {
      const probe = Buffer.alloc(entry.tail.length);
      const { bytesRead } = await fh.read(probe, 0, probe.length, entry.offset - probe.length);
      intact = bytesRead === probe.length && probe.equals(entry.tail);
    }
    if (!intact) Object.assign(entry, { ino: st.ino, offset: 0, tail: Buffer.alloc(0), items: [] });
    if (st.size === entry.offset) return;
    const buf = Buffer.allocUnsafe(Math.min(4 << 20, st.size - entry.offset));
    let pos = entry.offset;
    let carry = Buffer.alloc(0);
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const nl = data.lastIndexOf(10);
      if (nl >= 0) {
        for (const line of data.toString('utf8', 0, nl + 1).split('\n')) {
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          entry.items.push(...classify(rec));
        }
      }
      carry = Buffer.from(nl >= 0 ? data.subarray(nl + 1) : data);
      entry.offset = pos - carry.length;
    }
    const tail = Buffer.alloc(Math.min(64, entry.offset));
    await fh.read(tail, 0, tail.length, entry.offset - tail.length);
    entry.tail = tail;
  } finally { await fh.close(); }
}

// Which conversation is this pane showing? Claude Code keeps ~/.claude/sessions/<pid>.json for every running instance: its
// current sessionId (it follows /clear and --resume) and `tmux: "<session>:<window id>.<pane id>"`. The newest file in a
// directory is only whoever wrote last, so with two Claude panes in the same directory each would show the other's
// conversation. Pane ids repeat across tmux servers, so a record only counts when its process runs under this pane.
const CLAUDE_SESSIONS = process.env.TMUX_WEB_CLAUDE_SESSIONS || path.join(path.dirname(CLAUDE_PROJECTS), 'sessions');
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HAS_PROC = fs.existsSync('/proc/self/stat');
async function ancestorsOf(pid) { // the process itself first (a session may run `claude` as its only command), then its parents
  const out = [pid];
  for (let i = 0; i < 40 && pid > 1; i++) {
    let stat;
    try { stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'); } catch { break; }
    pid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    if (!pid) break;
    out.push(pid);
  }
  return out;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function paneConversation(paneId, panePid) {
  let names;
  try { names = (await fs.promises.readdir(CLAUDE_SESSIONS)).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  const found = [];
  await Promise.all(names.map(async (n) => {
    try {
      const rec = JSON.parse(await fs.promises.readFile(path.join(CLAUDE_SESSIONS, n), 'utf8')); // only <pid>.json: the .key files next to them are secrets
      const pid = parseInt(n, 10);
      if (typeof rec.tmux !== 'string' || !rec.tmux.endsWith(`.${paneId}`) || !SESSION_UUID.test(rec.sessionId || '')) return;
      if (HAS_PROC ? !(await ancestorsOf(pid)).includes(panePid) : !pidAlive(pid)) return;
      found.push(rec);
    } catch { /* unreadable, half-written or gone */ }
  }));
  return found.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] ?? null;
}
const transcriptPaths = new Map(); // sessionId -> file, once found
async function transcriptOf(sessionId, cwd) {
  const known = transcriptPaths.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  const dirs = [path.join(CLAUDE_PROJECTS, (cwd || '').replace(/[^A-Za-z0-9]/g, '-'))];
  try { for (const d of await fs.promises.readdir(CLAUDE_PROJECTS)) dirs.push(path.join(CLAUDE_PROJECTS, d)); } catch { /* none */ }
  for (const dir of dirs) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) { transcriptPaths.set(sessionId, file); return file; }
  }
  return null;
}
async function newestTranscript(cwd) {
  const dir = path.join(CLAUDE_PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  let names;
  try { names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return null; }
  const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(dir, n)).then((s) => ({ file: path.join(dir, n), mtime: s.mtimeMs }), () => null)));
  return stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}

// GET /api/sessions/:id/transcript -> { id, session, file, total, start, items, busy, asking }
//   session = tmux session name; file = the transcript's jsonl name (indexes are only valid within one file,
//   and the newest file changes when a new conversation starts, so clients compare it between requests)
//   total = number of items parsed so far (complete lines only); start = absolute index of items[0];
//   items = [start, start + items.length) of the full list, so more history exists while start > 0 and
//   more recent items exist while start + items.length < total.
//   ?before=I&count=N -> [I-N, I)   (I clamped to total; default I = total, i.e. the newest N)
//   ?after=I&count=N  -> [I, I+N)   (wins over `before`; default N = 500, so normally [I, total))
//   count: default 150, max 500. 404 when the pane isn't running Claude (TMUX_WEB_CLAUDE_COMMAND) or has no transcript.
//   busy / asking: read from the pane's visible screen (one extra capture-pane per successful request; false if that fails):
//   busy = a turn is running, asking = a permission prompt is waiting for a key.
// Claude Code's own wording on screen. It has changed between versions (older: "(12s · esc to interrupt)"), so match the
// shape of the spinner line instead. In 2.1.x it is a glyph, a capitalised verb and an ellipsis; for the first couple of
// seconds that is all there is ("✻ Creating…"), then a timer follows ("✻ Coalescing… (7s · ↓ 557 tokens)"). The finished
// line ("✻ Worked for 5s · done 5:55 AM") has no ellipsis and does not match. A permission prompt is "Do you want to
// proceed?" followed by "❯ 1. Yes".
const SCREEN_BUSY = /esc to interrupt|^\s*[·*✢✳✶✻✽]\s+\p{Lu}\p{L}*…|…\s*\(\d+\s*[smh]\b/imu;
const SCREEN_ASKING = /Do you want to[\s\S]*\b1\.\s+Yes\b/;
async function sessionTranscript(id, query) {
  const before = num(query, 'before');
  const after = num(query, 'after');
  const asked = num(query, 'count');
  if ([before, after, asked].some(Number.isNaN)) return { status: 400, body: { error: 'invalid range' } };
  let session, command, cwd, pane, panePid;
  try {
    [session, command, cwd, pane, panePid] = (await tmux(['display-message', '-p', '-t', id, '#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_id}\t#{pane_pid}'])).replace(/\n$/, '').split('\t');
  } catch (e) {
    if (missingTarget(e)) return gone;
    throw e;
  }
  if (!CLAUDE_COMMAND.test(command || '')) return { status: 404, body: { error: 'no Claude conversation in this session' } };
  // This pane's own conversation when Claude says which it is (never another pane's: a conversation that has no file yet is
  // simply not there); the newest file of the directory only for a Claude that keeps no such record.
  const mine = await paneConversation(pane, +panePid);
  const file = mine ? await transcriptOf(mine.sessionId, mine.cwd || cwd) : await newestTranscript(cwd || '');
  if (!file) return { status: 404, body: { error: 'no Claude transcript found' } };
  const entry = claudeEntry(file);
  const run = entry.chain.then(() => advance(entry, file));
  entry.chain = run.catch(() => {});
  try { await run; } catch (e) {
    if (e.code === 'ENOENT') return { status: 404, body: { error: 'no Claude transcript found' } };
    throw e;
  }
  const total = entry.items.length;
  const count = Math.min(500, Math.max(1, asked ?? (after === undefined ? 150 : 500)));
  let start, end;
  if (after !== undefined) { start = Math.min(after, total); end = Math.min(total, start + count); }
  else { end = Math.min(before ?? total, total); start = Math.max(0, end - count); }
  const screen = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '');
  return { status: 200, body: { id, session, file: path.basename(file, '.jsonl'), total, start, items: entry.items.slice(start, end),
    busy: SCREEN_BUSY.test(screen), asking: SCREEN_ASKING.test(screen) } };
}

// POST /api/sessions/:id/input { instance, text } | { instance, key } -> { ok: true }: type into the session's Claude pane.
//   text (<= 20000 chars) is pasted (bracketed, LF kept) and then submitted with Enter after a settle delay, so a
//   multi-line message is one submission; key is one of INPUT_KEYS (Esc to interrupt, arrows/digits/y/n for prompts).
//   The input box is emptied first if it holds leftovers (see clearPrompt). Control characters are stripped from text, ESC above all: a pasted ESC[201~ must not end the bracketed paste and
//   turn the rest into keystrokes. 404 when the session is gone or `instance` is stale, 409 when the pane isn't Claude.
// SendNow is Claude Code's chat:sendNow chord (Ctrl+X Ctrl+S): a message queued while Claude works is sent at once, interrupting the turn.
const INPUT_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'C-u', '1', '2', '3', '4', '5', 'y', 'n', 'SendNow']);
const INPUT_MAX = 20000;
const INPUT_SETTLE = process.env.TMUX_WEB_INPUT_SETTLE_MS;
const settleMs = (text) => (/^\d+$/.test(INPUT_SETTLE || '') ? +INPUT_SETTLE : Math.min(1500, 150 + text.length / 10));
// Claude Code puts an interrupted prompt back into its input box, so a pasted message would be glued onto it (seen with
// Esc during a turn). Before pasting, read the box off the screen (the rows between the last two ─── rules) and, only when it
// holds text, empty it with C-u (clears one line) + BSpace (joins to the line above), once per row plus spare, then check.
// Both keys are harmless on an empty box (unlike C-c, whose second press quits Claude). A permission prompt, or a screen
// without a recognisable box, is left alone; after three tries we paste anyway.
const PROMPT_RULE = /^─{20,}/;
function promptRows(screen) {
  const lines = screen.split('\n');
  const end = lines.findLastIndex((l) => PROMPT_RULE.test(l));
  const start = end > 0 ? lines.slice(0, end).findLastIndex((l) => PROMPT_RULE.test(l)) : -1;
  return start < 0 ? null : lines.slice(start + 1, end);
}
const promptHasText = (rows) => rows.join('\n').replace(/^\s*❯\s*/, '').replace(/^Try ".*"\s*$/s, '').trim() !== '';
async function clearPrompt(pane) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const screen = await tmux(['capture-pane', '-p', '-t', pane]).catch(() => '');
    const rows = SCREEN_ASKING.test(screen) ? null : promptRows(screen);
    if (!rows || !promptHasText(rows)) return;
    await tmux(['send-keys', '-t', pane, ...Array.from({ length: Math.max(rows.length, 3) + 1 }, () => ['C-u', 'BSpace']).flat()]);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}
const inputLocks = new Map();
let inputSeq = 0;
// Deliveries to one pane run one at a time, so two quick sends cannot interleave a paste with the other's Enter.
function serialized(pane, task) {
  const run = (inputLocks.get(pane) || Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  inputLocks.set(pane, tail);
  tail.then(() => { if (inputLocks.get(pane) === tail) inputLocks.delete(pane); });
  return run;
}

async function sessionInput(req, id) {
  const input = await readMutation(req, 128 << 10);
  if (input.status) return input;
  const { instance, text, key } = input.data;
  if (typeof instance !== 'string' || !SESSION_INSTANCE.test(instance)) return { status: 400, body: { error: 'invalid session identity' } };
  if ((text === undefined) === (key === undefined)) return { status: 400, body: { error: 'send exactly one of text or key' } };
  let message;
  if (text !== undefined) {
    if (typeof text !== 'string') return { status: 400, body: { error: 'invalid text' } };
    message = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+$/, '');
    if (!message || message.length > INPUT_MAX) return { status: 400, body: { error: message ? 'message too long' : 'empty message' } };
  } else if (typeof key !== 'string' || !INPUT_KEYS.has(key)) {
    return { status: 400, body: { error: 'key not allowed' } };
  }
  let live, command, pane;
  try {
    [live, command, pane] = (await tmux(['display-message', '-p', '-t', id, '#{pid}:#{session_created}\t#{pane_current_command}\t#{pane_id}'])).replace(/\n$/, '').split('\t');
  } catch (e) {
    if (missingTarget(e)) return gone;
    throw e;
  }
  if (live !== instance) return gone; // a reused ID must never receive input meant for an old tab
  if (!CLAUDE_COMMAND.test(command || '') || !/^%\d+$/.test(pane || '')) return { status: 409, body: { error: 'no Claude in this pane' } };
  await serialized(pane, async () => {
    if (message === undefined) { await tmux(['send-keys', '-t', pane, ...(key === 'SendNow' ? ['C-x', 'C-s'] : [key])]); return; }
    await clearPrompt(pane);
    const name = `tmux-web-${process.pid}-${++inputSeq}`;
    try {
      await tmux(['set-buffer', '-b', name, '--', message]);
      await tmux(['paste-buffer', '-p', '-r', '-d', '-b', name, '-t', pane]);
    } catch (e) {
      await tmux(['delete-buffer', '-b', name]).catch(() => {});
      throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, settleMs(message))); // let the TUI take the paste before Enter submits it
    await tmux(['send-keys', '-t', pane, 'Enter']);
  });
  return { status: 200, body: { ok: true } };
}

// ---- HTTP
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const sendJson = (res, result) => send(res, result.status, JSON.stringify(result.body), 'application/json');
const deny = (res, auth) => (auth.json ? sendJson(res, { status: auth.status, body: { error: auth.reason } }) : send(res, auth.status, auth.reason));

const server = http.createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://local');
    const auth = await authorize(req);
    if (!auth.ok) return deny(res, auth);
    const { user } = auth;
    if (pathname === '/verify') {
      const forwarded = req.headers['x-forwarded-uri'];
      const result = typeof forwarded === 'string' ? await verifyTerminal(user, forwarded) : { status: 200 };
      return result.status === 200 ? send(res, 200, 'ok') : send(res, result.status, result.reason);
    }
    if (pathname === '/api/me' && req.method === 'GET') return sendJson(res, { status: 200, body: await whoAmI(user) });
    if (pathname === '/api/prefs' && req.method === 'GET') return sendJson(res, { status: 200, body: { prefs: prefsOf(readPrefs(), user.email) } });
    if (pathname === '/api/prefs' && req.method === 'PUT') return sendJson(res, await savePrefs(req, user));
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const specs = ownerSpecs(user, searchParams);
      const sessions = await listSessions(user, specs, searchParams.get('preview') !== '0');
      return sendJson(res, { status: 200, body: { now: Math.floor(Date.now() / 1000), owners: specs, sessions } });
    }
    if (pathname === '/api/sessions' && req.method === 'POST') return sendJson(res, await createSession(req, user));
    // every /api/sessions/:id... route: id syntax, method, then what this person may do with that session, and only then the body
    const sub = /^\/api\/sessions\/([^/]+)(?:\/(input|history|transcript))?$/.exec(pathname);
    if (sub) {
      const view = sub[2];
      const methods = view === 'input' ? ['POST'] : view ? ['GET'] : ['PATCH', 'DELETE'];
      if (!methods.includes(req.method)) return send(res, 405, 'method not allowed');
      let id;
      try { id = decodeURIComponent(sub[1]); } catch { return send(res, 400, 'invalid session id'); }
      if (!SESSION_ID.test(id)) return view ? sendJson(res, { status: 400, body: { error: 'invalid session id' } }) : sendJson(res, await changeSession(req, id));
      const refused = await gate(user, id, view === 'history' || view === 'transcript' ? 'view' : 'full');
      if (refused) return sendJson(res, refused);
      if (view === 'input') return sendJson(res, await sessionInput(req, id));
      if (view) return sendJson(res, await (view === 'history' ? sessionHistory : sessionTranscript)(id, searchParams));
      return sendJson(res, await changeSession(req, id));
    }
    if (pathname === '/api/sessions' || pathname === '/api/me' || pathname === '/api/prefs' || pathname === '/verify') return send(res, 405, 'method not allowed');
    return send(res, 404, 'not found');
  } catch (e) {
    console.error('[tmux-web] handler error:', e.message);
    return send(res, 500, 'internal error');
  }
});

fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
fs.rmSync(SOCK, { force: true });
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o600);
  console.error(`[tmux-web] api listening on ${SOCK}; access ${TEAM && AUD ? `enforced for ${ISSUER}` : 'NOT CONFIGURED (all requests refused)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); fs.rmSync(SOCK, { force: true }); process.exit(0); });
}
