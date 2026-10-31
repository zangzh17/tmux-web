#!/usr/bin/env node
// tmux-web API: Cloudflare Access JWT verification + tmux session management.
// Listens on a Unix socket only (dir is 0700). Caddy calls /verify via
// forward_auth for every request and proxies /api/* here; /api/* re-checks the
// JWT itself so the socket is safe even if the proxy config is wrong.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SOCK = process.env.TMUX_WEB_API_SOCK
  || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'tmux-web', 'api.sock');
const TMUX = process.env.TMUX_BIN || '/usr/bin/tmux';
const PREVIEW = process.env.TMUX_WEB_PREVIEW !== '0';
const SOCK_MODE = /^[0-7]{3}$/.test(process.env.TMUX_WEB_SOCK_MODE || '') ? parseInt(process.env.TMUX_WEB_SOCK_MODE, 8) : 0o600;

// ---- accounts: one backend per Unix account
// One site can serve several Unix accounts. Each runs its own copy of this API and ttyd as that account, with its sockets in
// /run/tmux-web/<account>/ (TMUX_WEB_RUN), and Caddy sends /a/<account>/api/* and /a/<account>/term/* there; everything else
// belongs to the home account. users.json says which account each person belongs to ("account", default: "home") and who may
// enter every account ("admin"). A backend lets in only its own account's people and admins, and checks that itself, so a
// request that reaches the wrong backend still finds nothing. Without "home" there is one account, the one this runs as.
const ACCOUNT = process.env.TMUX_WEB_ACCOUNT || os.userInfo().username;
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$(?![\s\S])/;
const RUN_DIR = process.env.TMUX_WEB_RUN || '/run/tmux-web';
// <dir>/<account> holds "on" or "off": that account's own systemd (tmux-web-switch.path) starts or stops its backend to match
const ACCOUNTS_DIR = process.env.TMUX_WEB_ACCOUNTS_DIR || '/etc/tmux-web/accounts';
// The multi-account units set this: without a users file that names the home account nobody gets in, rather than everybody
// becoming this account's operator.
const MULTI_ACCOUNT = process.env.TMUX_WEB_MULTI_ACCOUNT === '1';

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
  if (MULTI_ACCOUNT && !config().home) {
    logOnce(`[tmux-web] ${USERS_FILE} is missing or names no "home" account: refusing all requests`);
    return { ok: false, status: 503, reason: 'users file not configured' };
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
// Every session of an account runs as that one Unix user; the web layer only decides which of them a signed-in person is shown
// and may touch. A session started from the web is stamped with its owner (the tmux session option @tmux_web_owner, lowercased
// email); sessions started any other way carry no stamp and are "local".
// users.json (TMUX_WEB_USERS, default ~/.config/tmux-web/users.json), re-read when it changes:
//   { "unowned": "all" | "viewers" | "none",   who sees local sessions: everyone (default), only people who may view others, nobody
//     "home": "zihan", "accounts": ["xyp"],   several Unix accounts (see "accounts" above); both optional
//     "users": { "a@x.com": { "name": "Alice", "viewOthers": "all" | ["b@x.com"], "manageOthers": "all" | ["b@x.com"],
//                             "account": "xyp", "admin": true } } }
// viewOthers: may look at those people's sessions, read-only. manageOthers: may also type into, rename and close them, as if
// they were their own (and implies viewing). A person allowed in by Access but not listed is a plain user: shown their own
// and local sessions only. account: the Unix account this person works in (default: home). admin: may enter every account
// and do anything with every session in it. In an account other than home (somebody's own Unix account) its people may do
// anything with every session in it, local ones included: they all run as them anyway. Any session can also be shared with
// people of its account (@tmux_web_share), see shareSession.
const USERS_FILE = process.env.TMUX_WEB_USERS || path.join(os.homedir(), '.config', 'tmux-web', 'users.json');
const NO_USERS = { unowned: 'all', home: '', accounts: [], users: new Map() };
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
const accountName = (v) => typeof v === 'string' && ACCOUNT_NAME.test(v);
function parseUsers(raw) {
  if (!isObject(raw) || (raw.users !== undefined && !isObject(raw.users))) throw new Error('expected {"users": {...}}');
  const home = raw.home ?? '';
  if (home !== '' && !accountName(home)) throw new Error('"home" is not an account name');
  if (raw.accounts !== undefined && !(Array.isArray(raw.accounts) && raw.accounts.every(accountName))) throw new Error('"accounts" is not a list of account names');
  const accounts = [...new Set(raw.accounts || [])].filter((a) => a !== home);
  const users = new Map();
  for (const [email, entry] of Object.entries(raw.users || {})) {
    if (!isObject(entry)) throw new Error(`user ${email} is not an object`);
    if (entry.account !== undefined && !(accountName(entry.account) && (entry.account === home || accounts.includes(entry.account)))) {
      throw new Error(`user ${email}: "account" must be "home" or one of "accounts"`);
    }
    users.set(email.trim().toLowerCase(), {
      name: typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 48 ? entry.name.trim() : '',
      viewOthers: scopeOf(entry.viewOthers),
      manageOthers: scopeOf(entry.manageOthers),
      account: entry.account === home ? '' : entry.account || '',
      admin: entry.admin === true,
    });
  }
  // without a home account every backend would take a person without "account" for one of its own
  if (!home && accounts.length) throw new Error('"accounts" needs "home"');
  return { unowned: ['all', 'viewers', 'none'].includes(raw.unowned) ? raw.unowned : 'all', home, accounts, users };
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
const homeAccount = () => config().home || ACCOUNT;
const personal = () => ACCOUNT !== homeAccount(); // somebody's own Unix account, not the home one
const userFor = (email) => {
  const entry = config().users.get(email);
  return { email, name: displayName(email), viewOthers: entry?.viewOthers ?? null, manageOthers: entry?.manageOthers ?? null,
    account: entry?.account || homeAccount(), admin: !!entry?.admin };
};
const multiUser = () => !MULTI_USER_FORCED_OFF && config() !== NO_USERS;
// may this person use this backend at all (their own account, or an admin)
const mayEnter = (user) => !multiUser() || user.admin || user.account === ACCOUNT;
const mayViewOthers = (user) => user.admin || !!(user.viewOthers || user.manageOthers);
const covers = (scope, owner) => scope === 'all' || !!scope?.has(owner);
// @tmux_web_share: "a@x.com=view,b@x.com=full" -> Map(email -> 'view' | 'full'); anything malformed is ignored
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+$(?![\s\S])/;
const SHARE_LEVELS = new Set(['view', 'full']);
function shareOf(value) {
  const share = new Map();
  for (const part of String(value || '').split(',')) {
    const [email = '', level] = part.trim().toLowerCase().split('=');
    if (EMAIL.test(email) && SHARE_LEVELS.has(level)) share.set(email, level);
  }
  return share;
}
// 'full' (own, local when allowed, shared with me for control, someone else's that I may manage, anything in my own personal
// account, anything at all for an admin) | 'view' (someone else's, read-only) | null (not for this person)
function accessFor(user, owner, share = '') {
  if (!multiUser()) return 'full';
  if (!mayEnter(user)) return null;
  if (user.admin || owner === user.email || personal()) return 'full';
  let access = null;
  if (!owner) {
    const { unowned } = config();
    if (unowned === 'all' || (unowned === 'viewers' && mayViewOthers(user))) access = 'full';
  } else if (covers(user.manageOthers, owner)) access = 'full';
  else if (covers(user.viewOthers, owner)) access = 'view';
  const shared = shareOf(share).get(user.email);
  return access === 'full' || shared === 'full' ? 'full' : access || shared || null;
}
// Not this person's own session (someone else's, or a local one that is not theirs: in another account, or one they only see
// because it was shared with them): the page opens it read-only until they choose to take control, so a look does not resize
// the owner's window or type into it.
const foreign = (user, owner) => multiUser() && (owner ? owner !== user.email : !(user.account === ACCOUNT && accessFor(user, '') === 'full'));
const ownerOf = (owner) => (owner ? { email: owner, name: displayName(owner) } : null);
// who a session may be shared with: people of this account who are not admins (they see everything anyway)
const sharePeople = () => (multiUser() && !personal() ? [...config().users]
  .filter(([email, u]) => !u.admin && !u.account && EMAIL.test(email)).map(([email]) => ({ email, name: displayName(email) })) : []);

// ---- tmux
const FIELDS = ['session_id', 'pid', 'session_name', 'session_windows', 'session_attached', 'session_activity',
  'session_created', 'pane_current_command', 'pane_current_path', 'pane_id', '@tmux_web_owner', '@tmux_web_share', 'pane_pid'];
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
    .map(([id, serverPid, name, windows, attached, activity, created, command, cwd, paneId, owner, share, panePid]) => ({
      id, instance: `${serverPid}:${created}`, name, command,
      windows: +windows, attached: +attached, activity: +activity, created: +created,
      path: cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd,
      paneId, panePid: +panePid, cwd, owner: owner.trim().toLowerCase(), share,
    }));
}

// ?owner= is a list (repeated and/or comma separated) of: me, local, all (everything the caller may see) or an email.
// Default: my sessions plus the local ones. Anything the caller may not view is dropped, not reported. Sessions shared with
// the caller are always listed, and a personal account lists everything (it is all theirs).
function ownerSpecs(user, query) {
  if (!multiUser() || personal()) return ['all'];
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

const sharedWith = (share) => [...shareOf(share)].map(([email, level]) => ({ email, name: displayName(email), level }));
// light: the terminal page's switcher (?preview=0) wants names only, so neither previews nor Claude's context are read.
async function listSessions(user, specs, light) {
  const wanted = ({ owner, share }) => specs.includes('all') || shareOf(share).has(user.email)
    || (owner === user.email ? specs.includes('me') : owner ? specs.includes(owner) : specs.includes('local'));
  const rows = (await listRows()).filter((r) => accessFor(user, r.owner, r.share) && wanted(r));
  // previews are read only for what is returned: a session hidden by the filter never has its screen captured
  const sessions = await Promise.all(rows.map(async ({ paneId, panePid, cwd, owner, share, ...row }) => {
    const access = accessFor(user, owner, share);
    return {
      ...row, owner: multiUser() ? ownerOf(owner) : null, mine: multiUser() && owner === user.email, access, foreign: foreign(user, owner),
      share: access === 'full' && multiUser() ? sharedWith(share) : [], // whom it is shared with: for those who may change that
      sharedWithMe: shareOf(share).get(user.email) || null,
      preview: light ? [] : await peek(paneId),
      context: light || !CLAUDE_COMMAND.test(row.command) ? null : await claudeContext(paneId, panePid, cwd),
    };
  }));
  return sessions.sort((a, b) => b.activity - a.activity);
}

// GET /api/me: { multiUser, email, name, account, myAccount, admin, allowed, canViewOthers, canManageOthers, people, local,
// sharePeople }: who I am, which account this is and which one is mine (allowed: may I use this one), whose sessions I may
// look at or manage (the filter UI is only offered when there are people; none of it when multiUser is false), and whom I could
// share a session with.
async function whoAmI(user) {
  const base = { email: user.email, name: user.name, account: ACCOUNT, myAccount: user.account, admin: user.admin, allowed: mayEnter(user) };
  const none = { canViewOthers: false, canManageOthers: false, people: [], local: 0, sharePeople: [] };
  if (!multiUser()) return { multiUser: false, ...base, ...none };
  if (!mayEnter(user)) return { multiUser: true, ...base, ...none };
  const rows = await listRows();
  const owned = new Map();
  for (const r of rows) if (r.owner) owned.set(r.owner, (owned.get(r.owner) || 0) + 1);
  const scopes = user.admin ? ['all'] : [user.viewOthers, user.manageOthers];
  const members = [...config().users].filter(([, u]) => (u.account || homeAccount()) === ACCOUNT).map(([email]) => email);
  const emails = scopes.includes('all') ? [...new Set([...members, ...owned.keys()])]
    : [...new Set(scopes.flatMap((scope) => (scope ? [...scope] : [])))];
  // a personal account is all one person's: nothing to sort by owner there
  const people = personal() ? [] : emails.filter((e) => e !== user.email).map((email) => ({ email, name: displayName(email), sessions: owned.get(email) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  return { multiUser: true, ...base, canViewOthers: mayViewOthers(user), canManageOthers: user.admin || !!user.manageOthers, people,
    local: accessFor(user, '') ? rows.filter((r) => !r.owner).length : 0, sharePeople: sharePeople().filter((p) => p.email !== user.email) };
}

// GET /api/accounts -> { home, admin, accounts: [{ name, home, on, up }] }: the accounts this person may switch to, home first (an admin:
// all of them; anyone else: their own). on = its switch file says "on" (home is always on); up = its API answers right now. The
// page asks the home backend (/api/accounts, not relative), which can reach every account's socket.
const switchOf = (name) => { try { return fs.readFileSync(path.join(ACCOUNTS_DIR, name), 'utf8').trim(); } catch { return ''; } };
const reachable = (name) => new Promise((resolve) => {
  const sock = net.connect(path.join(RUN_DIR, name, 'api.sock'));
  const done = (ok) => { sock.destroy(); resolve(ok); };
  sock.setTimeout(500, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});
async function accountStates(user) {
  const home = homeAccount();
  const names = user.admin ? [home, ...config().accounts] : [user.account];
  const accounts = await Promise.all(names.map(async (name) => ({ name, home: name === home, on: name === home || switchOf(name) === 'on',
    up: name === ACCOUNT || name === home || await reachable(name) })));
  return { home, admin: user.admin, accounts };
}
// PUT /api/accounts/:name { on } (admins only) -> { name, on }: flips that account's switch file. Its own systemd
// (tmux-web-switch.path, running as that account) starts or stops its API and ttyd to match within a second or two; its tmux
// sessions keep running either way.
async function switchAccount(req, user, name) {
  const input = await readMutation(req);
  if (input.status) return input;
  if (!user.admin) return { status: 403, body: { error: 'only an admin can switch an account on or off' } };
  if (!config().accounts.includes(name)) return { status: 404, body: { error: 'no such account' } };
  const { on } = input.data;
  if (typeof on !== 'boolean') return { status: 400, body: { error: 'expected {"on": true or false}' } };
  const file = path.join(ACCOUNTS_DIR, name);
  const temp = path.join(ACCOUNTS_DIR, `.${name}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, on ? 'on\n' : 'off\n', { mode: 0o644 });
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    console.error(`[tmux-web] cannot switch ${name}: ${e.message}`);
    return { status: 500, body: { error: `cannot write ${file}` } };
  }
  return { status: 200, body: { name, on } };
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

// A mutation must come from this site's own pages: its Origin header names this host.
function sameOrigin(req) {
  const host = req.headers.host;
  let source;
  try { source = new URL(req.headers.origin); } catch { return false; }
  return !!host && source.host === host && (source.protocol === 'https:'
    || (source.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)));
}

async function readMutation(req, limit = 1024) {
  // Every mutation requires JSON and a matching Origin, including deletion.
  if (!sameOrigin(req)) return { status: 403, body: { error: 'origin not allowed' } };
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

// PUT /api/sessions/:id/share { instance, share: { "<email>": "view" | "full" } } -> { id, share: [{ email, name, level }] }
// Replaces whom the session is shared with ({} stops sharing). Only people from sharePeople can be named, never the owner.
// A person it is shared with sees it in their list (view: read-only; full: as if it were theirs). Needs 'full' access.
async function shareSession(req, id, owner) {
  const input = await readMutation(req, 4096);
  if (input.status) return input;
  const { instance, share } = input.data;
  if (typeof instance !== 'string' || !SESSION_INSTANCE.test(instance)) return { status: 400, body: { error: 'invalid session identity' } };
  if (!isObject(share)) return { status: 400, body: { error: 'expected {"share": {"<email>": "view" | "full"}}' } };
  const people = new Set(sharePeople().map((p) => p.email));
  const entries = [];
  for (const [raw, level] of Object.entries(share)) {
    const email = raw.trim().toLowerCase();
    if (!people.has(email) || email === owner || !SHARE_LEVELS.has(level)) return { status: 400, body: { error: `cannot share with ${raw}` } };
    entries.push(`${email}=${level}`);
  }
  const value = entries.sort().join(',');
  try {
    // identity check and change in one tmux command, as for rename/close (the emails passed EMAIL: no quotes or spaces)
    const command = value ? `set-option -t '${id}' @tmux_web_share '${value}'` : `set-option -u -t '${id}' @tmux_web_share`;
    const result = await tmux(['if-shell', '-F', '-t', id, `#{==:#{pid}:#{session_created},${instance}}`, command, "display-message -p 'tmux-web: stale session'"]);
    if (result.trim() === 'tmux-web: stale session') return gone;
  } catch (e) {
    if (missingSession(e)) return gone;
    throw e;
  }
  return { status: 200, body: { id, share: sharedWith(value) } };
}

// ---- read-only views: plain scrollback, and the Claude Code conversation behind a pane
const CLAUDE_COMMAND = new RegExp(process.env.TMUX_WEB_CLAUDE_COMMAND || 'claude', 'i');
const CLAUDE_PROJECTS = process.env.TMUX_WEB_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const gone = { status: 404, body: { error: 'session not found' } };
// What this person may do with session `id`: { access, owner }, or a 404 (a session they may not see does not exist for them).
async function resolveAccess(user, id) {
  let found, owner, share;
  try {
    // tmux answers display-message for an id that does not exist with an empty line and success, so the id must come back
    [found, owner = '', share = ''] = (await tmux(['display-message', '-p', '-t', id, '#{session_id}\t#{@tmux_web_owner}\t#{@tmux_web_share}'])).replace(/\n$/, '').split('\t');
  } catch (e) {
    if (missingTarget(e)) return gone;
    throw e;
  }
  if (found !== id) return gone;
  owner = owner.trim().toLowerCase();
  const access = accessFor(user, owner, share);
  return access ? { access, owner, share } : gone;
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
  if (!/^\/term(?:\/|$)/i.test(route)) return { status: 200 }; // the page itself: the same static files for everyone
  if (!mayEnter(user)) return { status: 403, reason: 'not your account' };
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
// This pane's own conversation when Claude says which it is (never another pane's: a conversation that has no file yet is
// simply not there); the newest file of the directory only for a Claude that keeps no such record.
async function paneTranscript(paneId, panePid, cwd) {
  const mine = await paneConversation(paneId, panePid);
  return mine ? transcriptOf(mine.sessionId, mine.cwd || cwd) : newestTranscript(cwd || '');
}

// How full a pane's Claude conversation is, for the session list: { tokens, window, model }, { compacted: true } or null. Claude Code's own meter
// counts what the last request sent, input + cache read + cache write of the newest main-chain assistant message. The window
// is not in the transcript: 1M for the Claude 5 models (TMUX_WEB_CONTEXT_1M, a pattern on the model id) and for anything
// already past 200k, 200k otherwise. After a compaction the count is unknown until Claude answers again: { compacted: true }.
// Only the end of the file is read (more of it until the message turns up), and the answer is kept until the file changes.
const CONTEXT_1M = new RegExp(process.env.TMUX_WEB_CONTEXT_1M || '^claude-[a-z]+-(?:[5-9]|\\d\\d)(?:\\D|$)|\\[1m\\]', 'i');
const CONTEXT_SCAN_MAX = 16 << 20;
const contextCache = new Map(); // file -> { size, mtimeMs, context }, LRU of 64
function lastUsage(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"') && !lines[i].includes('"isCompactSummary"')) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!isObject(rec) || rec.isSidechain) continue;
    if (rec.isCompactSummary) return { compacted: true };
    const used = rec.message?.usage;
    const model = typeof rec.message?.model === 'string' ? rec.message.model : '';
    if (rec.type !== 'assistant' || !isObject(used) || model === '<synthetic>') continue;
    const tokens = [used.input_tokens, used.cache_creation_input_tokens, used.cache_read_input_tokens].reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
    return { tokens, model };
  }
  return null;
}
async function claudeContext(paneId, panePid, cwd) {
  let fh;
  try {
    const file = await paneTranscript(paneId, panePid, cwd);
    if (!file) return null;
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    const known = contextCache.get(file);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.context;
    let found = null;
    for (let want = 256 << 10; ; want *= 4) {
      const from = Math.max(0, st.size - want);
      const buf = Buffer.alloc(st.size - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      let text = buf.toString('utf8', 0, bytesRead);
      if (from > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); } // starts mid-line
      text = text.slice(0, text.lastIndexOf('\n') + 1); // Claude may be mid-write
      found = lastUsage(text);
      if (found || from === 0 || want >= CONTEXT_SCAN_MAX) break;
    }
    const context = !found ? null : found.compacted ? { compacted: true }
      : { tokens: found.tokens, window: CONTEXT_1M.test(found.model) || found.tokens > 200_000 ? 1_000_000 : 200_000, model: found.model };
    contextCache.delete(file);
    contextCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, context });
    while (contextCache.size > 64) contextCache.delete(contextCache.keys().next().value);
    return context;
  } catch { return null; } finally { await fh?.close(); }
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
  const file = await paneTranscript(pane, +panePid, cwd);
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

// ---- uploads: files and folders from the browser, put where a session can use them (the page pastes their paths)
// The page packs what was picked into one tar (a folder keeps its tree; browsers send no empty folders) and sends it in pieces
// of at most UPLOAD_PIECE bytes, so a big upload stays under the proxy's request size limit and a failed piece is simply resent:
//   POST   /api/uploads { size }             -> 201 { id }      size = the whole tar, at most UPLOAD_MAX
//   PUT    /api/uploads/:id?offset=N <bytes> -> { received }    409 { received } when N is not where the upload stands
//   POST   /api/uploads/:id/done { top }     -> { dir, paths }  unpacked into a new folder under UPLOADS; paths = its top-level
//                                                                entries, in the order of `top` (the names the page packed)
//   DELETE /api/uploads/:id                  -> { ok }          cancel
// Only plain files and folders are unpacked: no links or devices, and no name that leaves the folder. A folder is removed
// UPLOAD_DAYS after its upload, an unfinished upload after a day (or when the API restarts: the list of uploads is in memory).
// TMUX_WEB_UPLOADS (default ~/.cache/tmux-web/uploads), TMUX_WEB_UPLOAD_MAX_MB (4096), TMUX_WEB_UPLOAD_DAYS (7).
const UPLOADS = process.env.TMUX_WEB_UPLOADS || path.join(os.homedir(), '.cache', 'tmux-web', 'uploads');
const UPLOAD_PARTS = path.join(UPLOADS, '.parts');
const UPLOAD_MAX = (+process.env.TMUX_WEB_UPLOAD_MAX_MB > 0 ? +process.env.TMUX_WEB_UPLOAD_MAX_MB : 4096) * 2 ** 20;
const UPLOAD_DAYS = +process.env.TMUX_WEB_UPLOAD_DAYS > 0 ? +process.env.TMUX_WEB_UPLOAD_DAYS : 7;
const UPLOAD_RESERVE = (process.env.TMUX_WEB_UPLOAD_RESERVE_MB ? +process.env.TMUX_WEB_UPLOAD_RESERVE_MB : 1024) * 2 ** 20; // disk left free
const UPLOAD_PIECE = 16 << 20;
const UPLOAD_ID = /^[0-9a-f]{24}$(?![\s\S])/;
const UPLOAD_DIR = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const TAR = process.env.TAR_BIN || 'tar';
const uploads = new Map(); // id -> { email, size, part, busy, at }
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const run = (exe, args, maxBuffer = 1 << 20) => new Promise((resolve, reject) => {
  execFile(exe, args, { timeout: 15 * 60_000, maxBuffer, env: { ...process.env, LC_ALL: 'C.UTF-8' } }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
  });
});
function sweepUploads() {
  const now = Date.now();
  for (const [id, up] of uploads) if (!up.busy && now - up.at > 86400_000) { uploads.delete(id); fs.rmSync(up.part, { force: true }); }
  for (const [dir, test, age] of [[UPLOADS, (n) => UPLOAD_DIR.test(n), UPLOAD_DAYS * 86400_000], [UPLOAD_PARTS, (n) => /^[0-9a-f]{24}\.tar$/.test(n), 86400_000]]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(test); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      try { if (now - fs.statSync(file).mtimeMs > age && !uploads.get(n.slice(0, 24))?.busy) fs.rmSync(file, { recursive: true, force: true }); } catch { /* gone */ }
    }
  }
}
async function startUpload(req, user) {
  const input = await readMutation(req);
  if (input.status) return input;
  const { size } = input.data;
  if (!Number.isSafeInteger(size) || size < 1024 || size % 512) return { status: 400, body: { error: 'invalid size' } };
  if (size > UPLOAD_MAX) return { status: 413, body: { error: `too large: at most ${Math.round(UPLOAD_MAX / 2 ** 20)} MB` } };
  if (uploads.size >= 32) sweepUploads();
  if (uploads.size >= 32) return { status: 429, body: { error: 'too many uploads at once' } };
  fs.mkdirSync(UPLOAD_PARTS, { recursive: true, mode: 0o700 });
  const { bavail, bsize } = await fs.promises.statfs(UPLOADS);
  if (bavail * bsize < size * 2 + UPLOAD_RESERVE) return { status: 507, body: { error: 'not enough disk space on the server' } };
  const id = crypto.randomBytes(12).toString('hex');
  const part = path.join(UPLOAD_PARTS, `${id}.tar`);
  fs.writeFileSync(part, '', { mode: 0o600 });
  uploads.set(id, { email: user.email, size, part, busy: false, at: Date.now() });
  return { status: 201, body: { id, piece: UPLOAD_PIECE } };
}
const uploadOf = (user, id) => { const up = uploads.get(id); return up && up.email === user.email ? up : null; };
async function uploadPiece(req, user, id, query) {
  const discard = (result) => { req.resume(); return result; };
  if (!sameOrigin(req)) return discard({ status: 403, body: { error: 'origin not allowed' } });
  const up = uploadOf(user, id);
  if (!up) return discard({ status: 404, body: { error: 'upload not found' } });
  const offset = num(query, 'offset');
  const received = sizeOf(up.part);
  if (up.busy || offset !== received) return discard({ status: 409, body: { received } });
  // counted as it arrives: a proxy may forward the piece chunked, without a Content-Length
  const limit = Math.min(UPLOAD_PIECE, up.size - received);
  if (+req.headers['content-length'] > limit) return discard({ status: 413, body: { error: 'piece too large' } });
  let bytes = 0;
  const counter = new Transform({ transform(chunk, _enc, done) { bytes += chunk.length; done(bytes > limit ? new Error('too large') : null, chunk); } });
  up.busy = true;
  up.at = Date.now();
  let complete = false;
  try { await pipeline(req, counter, fs.createWriteStream(up.part, { flags: 'a' })); complete = true; } catch { /* cut off: the page goes on from what arrived */ }
  finally { up.busy = false; }
  if (bytes > limit) { fs.truncateSync(up.part, received); return { status: 413, body: { error: 'piece too large' } }; }
  return { status: complete ? 200 : 409, body: { received: sizeOf(up.part) } };
}
function newUploadDir() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dir = path.join(UPLOADS, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}
async function finishUpload(req, user, id) {
  const input = await readMutation(req, 64 << 10);
  if (input.status) return input;
  const up = uploadOf(user, id);
  if (!up) return { status: 404, body: { error: 'upload not found' } };
  if (up.busy || sizeOf(up.part) !== up.size) return { status: 409, body: { received: sizeOf(up.part) } };
  const top = Array.isArray(input.data.top) ? input.data.top.filter((n) => typeof n === 'string') : [];
  up.busy = true;
  let dir = null;
  try {
    // tar -tv starts every line with the entry's type: '-' file, 'd' folder (l/h links, c/b/p devices and fifos are refused)
    const listing = await run(TAR, ['-tvf', up.part], 256 << 20);
    if (listing.split('\n').some((l) => l && !/^[-d]/.test(l))) return { status: 400, body: { error: 'only files and folders can be uploaded' } };
    const names = (await run(TAR, ['-tf', up.part], 256 << 20)).split('\n').filter(Boolean);
    if (!names.length || names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) return { status: 400, body: { error: 'invalid file names' } };
    dir = newUploadDir();
    await run(TAR, ['-xf', up.part, '-C', dir, '--no-same-owner', '--no-same-permissions']);
    const entries = fs.readdirSync(dir);
    const ordered = [...top.filter((n) => entries.includes(n)), ...entries.filter((n) => !top.includes(n)).sort()];
    return { status: 200, body: { dir, paths: [...new Set(ordered)].map((n) => path.join(dir, n)) } };
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (e.stderr !== undefined) { console.error('[tmux-web] upload unpack failed:', String(e.stderr).trim().split('\n')[0]); return { status: 400, body: { error: 'could not unpack the upload' } }; }
    throw e;
  } finally {
    uploads.delete(id);
    fs.rmSync(up.part, { force: true });
  }
}
function cancelUpload(req, user, id) {
  if (!sameOrigin(req)) return { status: 403, body: { error: 'origin not allowed' } };
  const up = uploadOf(user, id);
  if (!up) return { status: 404, body: { error: 'upload not found' } };
  uploads.delete(id);
  fs.rmSync(up.part, { force: true }); // a piece still arriving writes into an unlinked file
  return { status: 200, body: { ok: true } };
}

// ---- Claude plan usage: how much of this account's 5-hour and weekly limits is left, and how it went
// What Claude Code's /usage shows: GET api.anthropic.com/api/oauth/usage with the OAuth access token of this account's Claude
// login (~/.claude/.credentials.json). It is asked every 5 minutes, and when a page wants it and the last try is over 2 minutes
// old; the answers of the last 8 days are kept in TMUX_WEB_USAGE for the trend. The login is never refreshed here (that would
// rotate the refresh token under Claude Code, which refreshes it while it runs): while it is expired the last answer stands.
const CLAUDE_CREDENTIALS = process.env.TMUX_WEB_CLAUDE_CREDENTIALS || path.join(path.dirname(CLAUDE_PROJECTS), '.credentials.json');
const USAGE_URL = process.env.TMUX_WEB_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage';
const USAGE_FILE = process.env.TMUX_WEB_USAGE || path.join(os.homedir(), '.local', 'state', 'tmux-web', 'usage.json');
const USAGE_EVERY = 5 * 60_000;
const USAGE_FRESH = 2 * 60_000;
const USAGE_KEEP = 8 * 86400;
// samples: [time, 5-hour %, weekly %, 5-hour reset, weekly reset] in seconds, a % or reset null when the answer had none
const usage = { samples: null, error: null, tried: 0, pausedUntil: 0, inflight: null };
function usageSamples() {
  if (!usage.samples) {
    try {
      const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))?.samples;
      usage.samples = Array.isArray(saved) ? saved.filter((s) => Array.isArray(s) && s.length === 5 && Number.isFinite(s[0])) : [];
    } catch { usage.samples = []; }
  }
  return usage.samples;
}
function claudeToken() {
  let oauth;
  try { oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS, 'utf8'))?.claudeAiOauth; } catch (e) { return { error: e.code === 'ENOENT' ? 'not signed in' : 'unreadable login' }; }
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return { error: 'not signed in' };
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now() + 30_000) return { error: 'login expired' };
  return { token: oauth.accessToken };
}
const limitOf = (v) => {
  if (!isObject(v) || !Number.isFinite(v.utilization)) return null;
  const reset = Date.parse(v.resets_at);
  return { used: Math.min(100, Math.max(0, v.utilization)), resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : null };
};
function saveUsage(samples) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true, mode: 0o700 });
    const temp = `${USAGE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ samples })}\n`, { mode: 0o600 });
    fs.renameSync(temp, USAGE_FILE);
  } catch (e) { logOnce(`[tmux-web] could not save Claude usage: ${e.message}`); }
}
function pollUsage() {
  if (usage.inflight) return usage.inflight;
  if (Date.now() < usage.pausedUntil) return Promise.resolve();
  usage.tried = Date.now();
  usage.inflight = (async () => {
    const { token, error } = claudeToken();
    if (!token) { usage.error = error; return; }
    try {
      const res = await fetch(USAGE_URL, { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 429) {
        const wait = +res.headers.get('retry-after');
        usage.pausedUntil = Date.now() + (wait > 0 ? Math.min(wait, 3600) * 1000 : 15 * 60_000);
        usage.error = 'rate limited';
        return;
      }
      if (res.status === 401 || res.status === 403) { usage.error = 'login expired'; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const five = limitOf(body?.five_hour);
      const week = limitOf(body?.seven_day);
      if (!five && !week) throw new Error('no limits in the answer');
      const now = Math.floor(Date.now() / 1000);
      usage.samples = usageSamples().filter((s) => s[0] > now - USAGE_KEEP);
      usage.samples.push([now, five?.used ?? null, week?.used ?? null, five?.resetsAt ?? null, week?.resetsAt ?? null]);
      usage.error = null;
      saveUsage(usage.samples);
    } catch (e) {
      usage.error = 'unreachable';
      logOnce(`[tmux-web] Claude usage: ${e.message}`);
    }
  })().finally(() => { usage.inflight = null; });
  return usage.inflight;
}
// GET /api/usage -> { now, at, error, fiveHour: { used, resetsAt }, sevenDay, history: [[time, 5-hour %, weekly %], ...] }
//   at: when the newest answer came (null: never, nothing to show); error: why the last try failed, null when it did not.
//   used is a percentage; history covers 7 days, every answer of the last 6 hours and the last one of each half hour before.
async function usageReport() {
  if (Date.now() - usage.tried > USAGE_FRESH) await pollUsage();
  const now = Math.floor(Date.now() / 1000);
  const samples = usageSamples();
  const history = [];
  for (const [t, five, week] of samples) {
    if (t < now - 7 * 86400) continue;
    const prev = history.at(-1);
    if (prev && t < now - 6 * 3600 && Math.floor(prev[0] / 1800) === Math.floor(t / 1800)) history[history.length - 1] = [t, five, week];
    else history.push([t, five, week]);
  }
  const last = samples.at(-1);
  return { status: 200, body: { now, at: last?.[0] ?? null, error: usage.error,
    fiveHour: last?.[1] != null ? { used: last[1], resetsAt: last[3] } : null,
    sevenDay: last?.[2] != null ? { used: last[2], resetsAt: last[4] } : null, history } };
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
    // a person's preferences and the account switches live with the home account; the page asks for them there
    if (pathname === '/api/prefs' && req.method === 'GET') return sendJson(res, { status: 200, body: { prefs: prefsOf(readPrefs(), user.email) } });
    if (pathname === '/api/prefs' && req.method === 'PUT') return sendJson(res, await savePrefs(req, user));
    if (pathname === '/api/accounts' && req.method === 'GET') return sendJson(res, { status: 200, body: await accountStates(user) });
    const account = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
    if (account) {
      if (req.method !== 'PUT') return send(res, 405, 'method not allowed');
      return sendJson(res, await switchAccount(req, user, account[1]));
    }
    // everything else is this account's sessions and files
    if (!mayEnter(user)) return sendJson(res, { status: 403, body: { error: `this is the ${ACCOUNT} account`, account: user.account } });
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const specs = ownerSpecs(user, searchParams);
      const sessions = await listSessions(user, specs, searchParams.get('preview') === '0');
      return sendJson(res, { status: 200, body: { now: Math.floor(Date.now() / 1000), account: ACCOUNT, owners: specs, sessions } });
    }
    if (pathname === '/api/sessions' && req.method === 'POST') return sendJson(res, await createSession(req, user));
    if (pathname === '/api/usage' && req.method === 'GET') return sendJson(res, await usageReport());
    // every /api/sessions/:id... route: id syntax, method, then what this person may do with that session, and only then the body
    const sub = /^\/api\/sessions\/([^/]+)(?:\/(input|history|transcript|share))?$/.exec(pathname);
    if (sub) {
      const view = sub[2];
      const methods = view === 'input' ? ['POST'] : view === 'share' ? ['PUT'] : view ? ['GET'] : ['PATCH', 'DELETE'];
      if (!methods.includes(req.method)) return send(res, 405, 'method not allowed');
      let id;
      try { id = decodeURIComponent(sub[1]); } catch { return send(res, 400, 'invalid session id'); }
      if (!SESSION_ID.test(id)) return view ? sendJson(res, { status: 400, body: { error: 'invalid session id' } }) : sendJson(res, await changeSession(req, id));
      if (view === 'share') {
        const r = await resolveAccess(user, id);
        if (r.status) return sendJson(res, r);
        if (r.access !== 'full') return sendJson(res, { status: 403, body: { error: `read-only: this session belongs to ${displayName(r.owner)}` } });
        return sendJson(res, await shareSession(req, id, r.owner));
      }
      const refused = await gate(user, id, view === 'history' || view === 'transcript' ? 'view' : 'full');
      if (refused) return sendJson(res, refused);
      if (view === 'input') return sendJson(res, await sessionInput(req, id));
      if (view) return sendJson(res, await (view === 'history' ? sessionHistory : sessionTranscript)(id, searchParams));
      return sendJson(res, await changeSession(req, id));
    }
    if (pathname === '/api/uploads' && req.method === 'POST') return sendJson(res, await startUpload(req, user));
    const upload = /^\/api\/uploads\/([^/]+)(\/done)?$/.exec(pathname);
    if (upload) {
      if (!(upload[2] ? ['POST'] : ['PUT', 'DELETE']).includes(req.method)) return send(res, 405, 'method not allowed');
      if (!UPLOAD_ID.test(upload[1])) return sendJson(res, { status: 404, body: { error: 'upload not found' } });
      if (upload[2]) return sendJson(res, await finishUpload(req, user, upload[1]));
      return sendJson(res, req.method === 'PUT' ? await uploadPiece(req, user, upload[1], searchParams) : cancelUpload(req, user, upload[1]));
    }
    if (['/api/sessions', '/api/me', '/api/prefs', '/api/accounts', '/api/uploads', '/api/usage', '/verify'].includes(pathname)) return send(res, 405, 'method not allowed');
    return send(res, 404, 'not found');
  } catch (e) {
    console.error('[tmux-web] handler error:', e.message);
    return send(res, 500, 'internal error');
  }
});

sweepUploads();
setInterval(sweepUploads, 3600_000).unref();
setTimeout(pollUsage, 3000).unref();
setInterval(pollUsage, USAGE_EVERY).unref();
fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
fs.rmSync(SOCK, { force: true });
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, SOCK_MODE); // 660 when the front door runs as another user and gets in through the directory's group
  console.error(`[tmux-web] api for account ${ACCOUNT} listening on ${SOCK}; access ${TEAM && AUD ? `enforced for ${ISSUER}` : 'NOT CONFIGURED (all requests refused)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); fs.rmSync(SOCK, { force: true }); process.exit(0); });
}
