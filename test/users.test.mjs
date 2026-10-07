import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startApi, delay, sessionPath } from './helpers.mjs';

// People: admin sees everyone, alice sees bob, bob and carol see only their own (carol is not listed in users.json at all).
// Sessions: a1 (alice) b1 b2 (bob) adm1 (admin) c1 (carol), loc1 loc2 (started in a terminal: local), fk (a fake Claude, bob's).
const CONFIG = {
  unowned: 'all',
  users: {
    'admin@x.com': { name: 'Admin', viewOthers: 'all' },
    'alice@x.com': { name: 'Alice', viewOthers: ['bob@x.com'] },
    'bob@x.com': { name: 'Bob' },
  },
};
const ALLOWED = 'owner@example.com admin@x.com alice@x.com bob@x.com carol@x.com';
let api;
let dir;
let ids; // name -> { id, instance }
let fk; // { id, instance, log }
const as = (email, method, endpoint, extra, body) => api.requestAs(email, method, endpoint, extra, body);
const create = async (email, name) => { const r = await as(email, 'POST', '/api/sessions', {}, { name }); assert.equal(r.status, 201, `${email} creates ${name}`); return r.body; };
const names = (res) => res.body.sessions.map((s) => s.name).sort();
const list = (email, query = '') => as(email, 'GET', `/api/sessions${query}`);
const owners = (res) => Object.fromEntries(res.body.sessions.map((s) => [s.name, s.owner?.email ?? null]));

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-users-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projects, work.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  fs.writeFileSync(path.join(projects, work.replace(/[^A-Za-z0-9]/g, '-'), 'c.jsonl'),
    `${JSON.stringify({ type: 'user', timestamp: '2026-10-06T00:00:00.000Z', message: { role: 'user', content: 'hello from bob' } })}\n`);
  const script = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const log = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdin.on('data', (d) => fs.appendFileSync(log, d.toString('base64') + '\\n'));
fs.writeFileSync(log + '.ready', 'ready');
setInterval(() => {}, 1000);
`);
  api = await startApi({ ALLOWED_EMAILS: ALLOWED, TMUX_WEB_PREVIEW: '1', TMUX_WEB_CLAUDE_COMMAND: '^node$', TMUX_WEB_INPUT_SETTLE_MS: '30', TMUX_WEB_CLAUDE_PROJECTS: projects });
  api.writeUsers(CONFIG);
  ids = {};
  for (const [email, name] of [['alice@x.com', 'a1'], ['bob@x.com', 'b1'], ['bob@x.com', 'b2'], ['admin@x.com', 'adm1'], ['carol@x.com', 'c1']]) ids[name] = await create(email, name);
  for (const name of ['loc1', 'loc2']) { const id = api.start(name, 'cat'); ids[name] = { id, instance: api.tmux('display-message', '-p', '-t', id, '#{pid}:#{session_created}') }; }
  const log = path.join(dir, 'fk.log');
  const id = api.start('fk', '-c', work, process.execPath, script, log);
  for (let i = 0; !fs.existsSync(`${log}.ready`); i++) { assert.ok(i < 100, 'fake Claude did not start'); await delay(50); }
  await delay(300);
  api.tmux('set-option', '-t', id, '@tmux_web_owner', 'bob@x.com'); // what POST would have stamped
  fk = { id, instance: api.tmux('display-message', '-p', '-t', id, '#{pid}:#{session_created}'), log };
  ids.fk = fk;
});
after(async () => {
  await api?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const received = () => (fs.existsSync(fk.log) ? fs.readFileSync(fk.log, 'utf8') : '');

test('a session created from the web is stamped with its owner (lowercased) and says so', async () => {
  const r = await as('Alice@X.com', 'POST', '/api/sessions', {}, { name: 'stamp1' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.owner, { email: 'alice@x.com', name: 'Alice' });
  assert.equal(api.tmux('show-options', '-v', '-t', r.body.id, '@tmux_web_owner'), 'alice@x.com');
  assert.equal(api.tmux('show-options', '-v', '-t', ids.a1.id, '@tmux_web_owner'), 'alice@x.com');
  // an unlisted person gets their email's local part as the name
  assert.deepEqual((await create('carol@x.com', 'stamp2')).owner, { email: 'carol@x.com', name: 'carol' });
});

test('if the owner cannot be stamped the new session is removed, never left unowned', async () => {
  const bin = path.join(api.dir, 'tmux');
  const original = fs.readFileSync(bin, 'utf8');
  fs.writeFileSync(bin, original.replace('exec ', 'case " $* " in *" set-option "*) exit 1;; esac\nexec '), { mode: 0o700 });
  try {
    const r = await as('bob@x.com', 'POST', '/api/sessions', {}, { name: 'unstamped' });
    assert.equal(r.status, 500);
  } finally { fs.writeFileSync(bin, original, { mode: 0o700 }); }
  assert.ok(!api.tmux('list-sessions', '-F', '#{session_name}').split('\n').includes('unstamped'), 'the half-created session is gone');
});

test('the default list is my sessions plus local ones, with owner, mine and access on each', async () => {
  const res = await list('alice@x.com');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.owners, ['me', 'local']);
  assert.deepEqual(names(res), ['a1', 'loc1', 'loc2', 'stamp1']);
  const a1 = res.body.sessions.find((s) => s.name === 'a1');
  assert.deepEqual([a1.owner, a1.mine, a1.access], [{ email: 'alice@x.com', name: 'Alice' }, true, 'full']);
  const loc = res.body.sessions.find((s) => s.name === 'loc1');
  assert.deepEqual([loc.owner, loc.mine, loc.access], [null, false, 'full']);
  for (const key of ['id', 'instance', 'name', 'command', 'windows', 'attached', 'activity', 'created', 'path', 'preview']) assert.ok(key in a1, `existing field ${key}`);
  assert.deepEqual(names(await list('bob@x.com')), ['b1', 'b2', 'fk', 'loc1', 'loc2']);
  assert.deepEqual(names(await list('carol@x.com')), ['c1', 'loc1', 'loc2', 'stamp2']);
  assert.deepEqual(names(await list('owner@example.com')), ['loc1', 'loc2'], 'someone with no sessions still sees the local ones');
});

test('owner= filters: me, local, emails, all, comma and repeated, case-insensitive', async () => {
  const q = async (email, query) => { const r = await list(email, query); assert.equal(r.status, 200); return r; };
  assert.deepEqual(names(await q('admin@x.com', '?owner=me')), ['adm1']);
  assert.deepEqual(names(await q('admin@x.com', '?owner=local')), ['loc1', 'loc2']);
  const bobs = await q('admin@x.com', '?owner=BOB@x.com');
  assert.deepEqual([names(bobs), bobs.body.owners], [['b1', 'b2', 'fk'], ['bob@x.com']]);
  assert.ok(bobs.body.sessions.every((s) => s.access === 'view' && !s.mine), "someone else's sessions are view-only");
  assert.deepEqual(names(await q('admin@x.com', '?owner=me,bob@x.com')), ['adm1', 'b1', 'b2', 'fk']);
  assert.deepEqual(names(await q('admin@x.com', '?owner=me&owner=local&owner=carol@x.com')), ['adm1', 'c1', 'loc1', 'loc2', 'stamp2']);
  assert.deepEqual(names(await q('admin@x.com', '?owner=all')), ['a1', 'adm1', 'b1', 'b2', 'c1', 'fk', 'loc1', 'loc2', 'stamp1', 'stamp2']);
  const own = await q('admin@x.com', '?owner=Admin@X.com');
  assert.deepEqual([names(own), own.body.owners], [['adm1'], ['me']], 'my own address is just "me"');
  assert.deepEqual(names(await q('admin@x.com', '?owner=,')), ['adm1', 'loc1', 'loc2'], 'nothing usable asked: the default');
  // alice may view bob only: everything else is dropped, not refused
  const alice = await q('alice@x.com', '?owner=bob@x.com,carol@x.com,admin@x.com,nobody');
  assert.deepEqual([names(alice), alice.body.owners], [['b1', 'b2', 'fk'], ['bob@x.com']]);
  assert.deepEqual(names(await q('alice@x.com', '?owner=all')), ['a1', 'b1', 'b2', 'fk', 'loc1', 'loc2', 'stamp1']);
  const none = await q('bob@x.com', '?owner=alice@x.com&owner=admin@x.com');
  assert.deepEqual([none.body.owners, none.body.sessions], [[], []]);
  assert.deepEqual(names(await q('bob@x.com', '?owner=all')), ['b1', 'b2', 'fk', 'loc1', 'loc2']);
});

test('previews are read only for the sessions that are returned, and preview=0 reads none', async () => {
  const bin = path.join(api.dir, 'tmux');
  const original = fs.readFileSync(bin, 'utf8');
  const log = path.join(dir, 'tmux-calls.log');
  fs.writeFileSync(bin, original.replace('exec ', `echo "$*" >> ${log}\nexec `), { mode: 0o700 });
  try {
    api.tmux('send-keys', '-t', ids.loc1.id, 'LOCAL_MARKER', 'Enter');
    await delay(200);
    const pane = (name) => api.tmux('display-message', '-p', '-t', ids[name].id, '#{pane_id}');
    const captured = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.startsWith('capture-pane')).map((l) => l.split(' ').at(-1));
    const res = await list('bob@x.com');
    assert.ok(res.body.sessions.find((s) => s.name === 'loc1').preview.some((l) => l.includes('LOCAL_MARKER')), 'previews still work');
    const seen = captured();
    assert.ok(seen.includes(pane('b1')) && seen.includes(pane('loc1')), 'what is shown is previewed');
    for (const hidden of ['a1', 'adm1', 'c1']) assert.ok(!seen.includes(pane(hidden)), `${hidden}'s screen is never captured for bob`);
    fs.rmSync(log);
    const bare = await list('admin@x.com', '?owner=all&preview=0');
    assert.ok(bare.body.sessions.length >= 9 && bare.body.sessions.every((s) => Array.isArray(s.preview) && s.preview.length === 0));
    assert.deepEqual(captured(), [], 'preview=0 captures nothing');
  } finally { fs.writeFileSync(bin, original, { mode: 0o700 }); }
});

test('/api/me: who I am and whose sessions I may look at', async () => {
  const admin = await as('admin@x.com', 'GET', '/api/me');
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body, {
    multiUser: true, email: 'admin@x.com', name: 'Admin', canViewOthers: true, canManageOthers: false, local: 2,
    people: [{ email: 'alice@x.com', name: 'Alice', sessions: 2 }, { email: 'bob@x.com', name: 'Bob', sessions: 3 }, { email: 'carol@x.com', name: 'carol', sessions: 2 }],
  });
  const alice = await as('alice@x.com', 'GET', '/api/me');
  assert.deepEqual(alice.body, { multiUser: true, email: 'alice@x.com', name: 'Alice', canViewOthers: true, canManageOthers: false, local: 2, people: [{ email: 'bob@x.com', name: 'Bob', sessions: 3 }] });
  const bob = await as('bob@x.com', 'GET', '/api/me');
  assert.deepEqual(bob.body, { multiUser: true, email: 'bob@x.com', name: 'Bob', canViewOthers: false, canManageOthers: false, local: 2, people: [] });
  const carol = await as('carol@x.com', 'GET', '/api/me');
  assert.deepEqual([carol.body.name, carol.body.canViewOthers, carol.body.people], ['carol', false, []]);
  assert.equal((await as('bob@x.com', 'POST', '/api/me')).status, 405);
  assert.equal((await api.request('GET', '/api/me', { 'cf-access-jwt-assertion': '' })).status, 401);
});

test('a list may name someone who has no sessions yet; listing yourself adds nothing', async () => {
  api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'alice@x.com': { name: 'Alice', viewOthers: ['dave@x.com', 'alice@x.com', 'bob@x.com'] } } });
  try {
    const me = await as('alice@x.com', 'GET', '/api/me');
    assert.deepEqual(me.body.people.map((p) => [p.email, p.name, p.sessions]), [['bob@x.com', 'Bob', 3], ['dave@x.com', 'dave', 0]]);
  } finally { api.writeUsers(CONFIG); }
});

test('the unowned policy decides who sees local sessions', async () => {
  const withPolicy = (unowned) => api.writeUsers({ ...CONFIG, unowned });
  try {
    withPolicy('viewers');
    assert.deepEqual(names(await list('alice@x.com', '?owner=local')), ['loc1', 'loc2']);
    assert.deepEqual(names(await list('admin@x.com', '?owner=local')), ['loc1', 'loc2']);
    for (const email of ['bob@x.com', 'carol@x.com', 'owner@example.com']) {
      assert.deepEqual(names(await list(email, '?owner=local')), [], `${email} gets no local sessions`);
      assert.equal((await as(email, 'GET', sessionPath(ids.loc1.id, 'history'))).status, 404);
      assert.equal((await as(email, 'GET', '/api/me')).body.local, 0);
    }
    assert.equal((await as('alice@x.com', 'GET', '/api/me')).body.local, 2);
    assert.equal((await as('alice@x.com', 'GET', sessionPath(ids.loc1.id, 'history'))).status, 200);
    withPolicy('none');
    for (const email of ['admin@x.com', 'alice@x.com', 'bob@x.com']) {
      assert.deepEqual(names(await list(email, '?owner=all&owner=local')).filter((n) => n.startsWith('loc')), [], `${email}: nobody sees local sessions`);
      assert.equal((await as(email, 'GET', sessionPath(ids.loc1.id, 'history'))).status, 404);
    }
    assert.equal((await as('admin@x.com', 'GET', '/api/me')).body.local, 0);
    withPolicy('nonsense');
    assert.deepEqual(names(await list('bob@x.com')), ['b1', 'b2', 'fk', 'loc1', 'loc2'], 'an unknown policy is "all"');
  } finally { api.writeUsers(CONFIG); }
});

test('someone with no right to a session gets 404 everywhere, and nothing is probed through the body', async () => {
  const target = ids.a1;
  const missing = { id: '$99999', instance: '1:1' };
  const attempts = (who, t) => [
    ['history', () => as(who, 'GET', sessionPath(t.id, 'history'))],
    ['transcript', () => as(who, 'GET', sessionPath(t.id, 'transcript'))],
    ['PATCH', () => as(who, 'PATCH', `/api/sessions/${encodeURIComponent(t.id)}`, {}, { instance: t.instance, name: 'taken' })],
    ['DELETE', () => as(who, 'DELETE', `/api/sessions/${encodeURIComponent(t.id)}`, {}, { instance: t.instance, confirmed: true })],
    ['input', () => as(who, 'POST', sessionPath(t.id, 'input'), {}, { instance: t.instance, text: 'hi' })],
    // wrong origin, wrong content type, nonsense body: still a plain 404, not a 403/415/400 that would confirm it exists
    ['PATCH bad origin', () => as(who, 'PATCH', `/api/sessions/${encodeURIComponent(t.id)}`, { origin: 'https://evil.example' }, { name: 'x' })],
    ['DELETE bad type', () => as(who, 'DELETE', `/api/sessions/${encodeURIComponent(t.id)}`, { 'content-type': 'text/plain' }, 'nope')],
    ['input bad body', () => as(who, 'POST', sessionPath(t.id, 'input'), {}, '{not json')],
  ];
  const real = await Promise.all(attempts('bob@x.com', target).map(([, run]) => run()));
  const absent = await Promise.all(attempts('bob@x.com', missing).map(([, run]) => run()));
  real.forEach((r, i) => {
    assert.deepEqual([r.status, r.body], [404, { error: 'session not found' }], attempts('bob@x.com', target)[i][0]);
    assert.deepEqual(r, absent[i], 'identical to a session that does not exist');
  });
  // unlisted and plain people are no different, and an admin-only session is as hidden from alice
  assert.equal((await as('carol@x.com', 'GET', sessionPath(ids.b1.id, 'history'))).status, 404);
  assert.equal((await as('alice@x.com', 'GET', sessionPath(ids.c1.id, 'history'))).status, 404);
  assert.equal((await as('alice@x.com', 'DELETE', `/api/sessions/${encodeURIComponent(ids.adm1.id)}`, {}, { instance: ids.adm1.instance, confirmed: true })).status, 404);
  // nothing happened
  const still = names(await list('admin@x.com', '?owner=all'));
  assert.ok(['a1', 'adm1', 'b1', 'c1'].every((n) => still.includes(n)));
  assert.equal(received(), '', 'nothing was typed anywhere');
  // the id syntax is still checked first and for everyone
  assert.equal((await as('bob@x.com', 'GET', '/api/sessions/new_project/history')).status, 400);
  assert.equal((await as('bob@x.com', 'PATCH', '/api/sessions/new_project', {}, { name: 'x' })).status, 400);
});

test('a view-only person can read someone elses session but change nothing in it', async () => {
  const bobs = ids.fk;
  const url = encodeURIComponent(bobs.id);
  const history = await as('alice@x.com', 'GET', sessionPath(bobs.id, 'history'));
  assert.equal(history.status, 200);
  const transcript = await as('alice@x.com', 'GET', sessionPath(bobs.id, 'transcript'));
  assert.deepEqual([transcript.status, transcript.body.items.map((i) => i.text)], [200, ['hello from bob']]);
  assert.equal((await as('admin@x.com', 'GET', sessionPath(bobs.id, 'history', '?screen=1'))).status, 200);
  const refused = [
    await as('alice@x.com', 'PATCH', `/api/sessions/${url}`, {}, { instance: bobs.instance, name: 'mine_now' }),
    await as('alice@x.com', 'DELETE', `/api/sessions/${url}`, {}, { instance: bobs.instance, confirmed: true }),
    await as('alice@x.com', 'POST', sessionPath(bobs.id, 'input'), {}, { instance: bobs.instance, text: 'rm -rf everything' }),
    await as('alice@x.com', 'POST', sessionPath(bobs.id, 'input'), {}, { instance: bobs.instance, key: 'Enter' }),
    await as('admin@x.com', 'POST', sessionPath(bobs.id, 'input'), {}, { instance: bobs.instance, key: 'Escape' }),
  ];
  refused.forEach((r, i) => assert.deepEqual([r.status, r.body], [403, { error: 'read-only: this session belongs to Bob' }], `refusal ${i}`));
  await delay(300);
  assert.equal(received(), '', 'nothing reached the pane');
  const after = (await list('bob@x.com')).body.sessions.find((s) => s.id === bobs.id);
  assert.equal(after.name, 'fk', 'not renamed');
  // the owner can still do all of it
  assert.equal((await as('bob@x.com', 'POST', sessionPath(bobs.id, 'input'), {}, { instance: bobs.instance, key: 'Enter' })).status, 200);
  for (let i = 0; i < 40 && !received(); i++) await delay(50);
  assert.ok(received().length > 0, "the owner's key arrived");
});

test('emails are compared case-insensitively', async () => {
  const me = await as('Alice@X.com', 'GET', '/api/me');
  assert.deepEqual([me.body.email, me.body.name, me.body.canViewOthers], ['alice@x.com', 'Alice', true]);
  assert.deepEqual(names(await list('ALICE@x.COM', '?owner=Bob@X.com')), ['b1', 'b2', 'fk']);
});

test('users.json changes apply without a restart; a broken file keeps the last good permissions', async () => {
  const canSeeBob = async () => names(await list('alice@x.com', '?owner=bob@x.com')).length > 0;
  try {
    assert.equal(await canSeeBob(), true);
    api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'alice@x.com': { name: 'Alice' } } }); // revoked
    assert.equal(await canSeeBob(), false);
    assert.equal((await as('alice@x.com', 'GET', '/api/me')).body.canViewOthers, false);
    assert.equal((await as('alice@x.com', 'GET', sessionPath(ids.b1.id, 'history'))).status, 404);
    api.writeUsers(CONFIG); // granted again
    assert.equal(await canSeeBob(), true);
    for (const broken of ['{not json', '[]', '{"users": 5}', '{"users": {"alice@x.com": "yes"}}', '']) {
      api.writeUsers(broken);
      assert.equal(await canSeeBob(), true, `still allowed after ${JSON.stringify(broken)}`);
      assert.equal((await as('admin@x.com', 'GET', '/api/me')).body.canViewOthers, true);
    }
    api.writeUsers({ ...CONFIG, users: { 'alice@x.com': { name: 'Alice', viewOthers: 'all' } } }); // a good one replaces it
    assert.deepEqual([(await as('admin@x.com', 'GET', '/api/me')).body.canViewOthers, names(await list('alice@x.com', '?owner=carol@x.com')).length > 0], [false, true]);
    fs.rmSync(api.usersFile); // no file: multi-user is off (see the next test): nobody is separated from anybody
    assert.deepEqual((await as('alice@x.com', 'GET', '/api/me')).body, { multiUser: false, email: 'alice@x.com', name: 'alice', canViewOthers: false, canManageOthers: false, people: [], local: 0 });
    assert.deepEqual(names(await list('bob@x.com')), ['a1', 'adm1', 'b1', 'b2', 'c1', 'fk', 'loc1', 'loc2', 'stamp1', 'stamp2'], 'everything is shown to everybody');
  } finally { api.writeUsers(CONFIG); }
});

test('a token without an email is refused everywhere', async () => {
  const bare = await startApi({ ALLOWED_EMAILS: '' }); // with an allow-list such a token is already rejected as 401
  try {
    const call = (method, endpoint, extra = {}) => bare.request(method, endpoint, { 'cf-access-jwt-assertion': bare.mint(null), ...extra });
    for (const [method, endpoint] of [['GET', '/api/me'], ['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/sessions/%241/history'], ['PATCH', '/api/sessions/%241'], ['POST', '/api/sessions/%241/input'], ['GET', '/verify']]) {
      const r = await call(method, endpoint);
      assert.deepEqual([r.status, r.body], [403, { error: 'identity has no email' }], `${method} ${endpoint}`);
    }
    assert.equal((await bare.requestAs('someone@x.com', 'GET', '/api/me')).status, 200, 'a token with an email is fine');
  } finally { await bare.stop(); }
});

test('/verify decides who may open a terminal: owners freely, others read-only, strangers not at all', async () => {
  const n = (name) => ids[name].id.slice(1);
  const verify = async (email, uri) => (await as(email, 'GET', '/verify', uri === undefined ? {} : { 'x-forwarded-uri': uri })).status;
  const ws = (name, tail = '') => `/term/ws?arg=%24${n(name)}${tail}`;
  // my own: with or without ro, encoded or literal $
  assert.equal(await verify('alice@x.com', ws('a1')), 200);
  assert.equal(await verify('alice@x.com', ws('a1', '&arg=ro')), 200);
  assert.equal(await verify('alice@x.com', `/term/ws?arg=$${n('a1')}`), 200);
  assert.equal(await verify('alice@x.com', `/term/?arg=%24${n('a1')}`), 200, 'the page itself');
  // local sessions follow the unowned policy (all, by default)
  assert.equal(await verify('bob@x.com', ws('loc1')), 200);
  // someone else's: only read-only, and only with permission
  assert.equal(await verify('alice@x.com', ws('b1')), 403, 'view access must say ro');
  assert.equal(await verify('alice@x.com', ws('b1', '&arg=ro')), 200);
  assert.equal(await verify('admin@x.com', ws('c1')), 403);
  assert.equal(await verify('admin@x.com', ws('c1', '&arg=ro')), 200);
  assert.equal(await verify('alice@x.com', ws('c1', '&arg=ro')), 404, 'no permission: it does not exist');
  assert.equal(await verify('bob@x.com', ws('a1')), 404);
  assert.equal(await verify('bob@x.com', ws('a1', '&arg=ro')), 404);
  assert.equal(await verify('carol@x.com', `/term/?arg=%24${n('b1')}&arg=ro`), 404);
  assert.equal(await verify('bob@x.com', '/term/ws?arg=%2499999&arg=ro'), 404, 'no such session');
  // the session choice must be exactly one well-formed argument
  for (const bad of ['/term/ws', '/term/ws?', `/term/ws?arg=%24${n('b1')}&arg=ro&arg=x`, '/term/ws?arg=b1', `/term/ws?arg=%24${n('b1')}%0a`, `/term/ws?arg=%2524${n('b1')}`,
    '/term/ws?arg=%24', `/term/ws?ARG=%24${n('b1')}`, `/term/ws?arg=%24${n('b1')}&arg=RO`, `/term/ws?arg=ro&arg=%24${n('b1')}`, `/term/ws?x=1&arg=%24${n('b1')}`,
    `/term/ws?arg=%24${n('b1')}&x=1`, `/term/ws?ar%67=%24${n('b1')}`, `/term/?arg=nonsense`, `/term/ws/`]) {
    assert.equal(await verify('bob@x.com', bad), 403, `refused: ${bad}`);
  }
  // paths that spell /term differently are held to the same rules
  assert.equal(await verify('bob@x.com', ws('a1').replace('/term', '/TERM')), 404);
  assert.equal(await verify('bob@x.com', '/term/../term/ws'), 403);
  assert.equal(await verify('bob@x.com', '/foo/..%2fterm/ws'), 403);
  assert.equal(await verify('bob@x.com', '/t%65rm/ws'), 403);
  // everything else on /term, and everything that is not /term, is not this check's business
  for (const ok of ['/term/token', '/term/', '/term', '/term/index.js?v=3', '/', '/index.html', '/api/sessions?arg=whatever', '/termx/ws', '/x/term/ws']) {
    assert.equal(await verify('bob@x.com', ok), 200, `untouched: ${ok}`);
  }
  assert.equal(await verify('bob@x.com', undefined), 200, 'no forwarded URI: just the login check');
  assert.equal((await api.request('GET', '/verify', { 'cf-access-jwt-assertion': '', 'x-forwarded-uri': ws('a1') })).status, 401);
});

// ---- the attach wrapper really produces a read-only, size-ignoring client (needs a pty: run under script(1))
test('bin/tmux-web-attach <id> ro attaches read-only and ignore-size; without ro it is a normal client', async (t) => {
  const probe = spawn('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' });
  const worked = await new Promise((resolve) => { probe.on('exit', (code) => resolve(code === 0)); probe.on('error', () => resolve(false)); });
  if (!worked) return t.skip('script(1) cannot allocate a pty here');
  const wrapper = path.join(dir, 'attach');
  fs.writeFileSync(wrapper, fs.readFileSync(path.resolve('bin/tmux-web-attach'), 'utf8').replaceAll('/usr/bin/tmux', `/usr/bin/tmux -L ${api.tmuxSocket}`), { mode: 0o700 });
  const id = api.start('wrapped', 'cat');
  const attach = (...args) => spawn('script', ['-qefc', `${wrapper} '${id}' ${args.join(' ')}`, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' } });
  const clients = () => api.tmux('list-clients', '-F', '#{client_flags}').split('\n').filter(Boolean);
  const waitClient = async () => { for (let i = 0; i < 100 && !clients().length; i++) await delay(50); assert.ok(clients().length, 'a client attached'); };
  const detachAll = async (child) => { child.kill('SIGHUP'); for (let i = 0; i < 100 && clients().length; i++) await delay(50); };

  const viewer = attach('ro');
  try {
    await waitClient();
    const flags = clients()[0].split(',');
    assert.ok(flags.includes('read-only') && flags.includes('ignore-size'), `flags: ${flags}`);
    viewer.stdin.write('VIEWER_TYPED\n');
    await delay(600);
    assert.ok(!api.tmux('capture-pane', '-p', '-t', id).includes('VIEWER_TYPED'), 'a read-only client cannot type into the session');
  } finally { await detachAll(viewer); }

  const owner = attach();
  try {
    await waitClient();
    const flags = clients()[0].split(',');
    assert.ok(!flags.includes('read-only') && !flags.includes('ignore-size'), `flags: ${flags}`);
    owner.stdin.write('OWNER_TYPED\n');
    for (let i = 0; i < 60 && !api.tmux('capture-pane', '-p', '-t', id).includes('OWNER_TYPED'); i++) await delay(50);
    assert.ok(api.tmux('capture-pane', '-p', '-t', id).includes('OWNER_TYPED'), 'a normal client can');
  } finally { await detachAll(owner); }
});

test('multi-user is optional: with no users file, everybody Access lets in shares every session and no owner is recorded or shown', async () => {
  const solo = await startApi({ ALLOWED_EMAILS: 'a@x.com b@x.com' }); // its users file does not exist
  const call = (email, method, endpoint, body) => solo.requestAs(email, method, endpoint, {}, body);
  try {
    const made = await call('a@x.com', 'POST', '/api/sessions', { name: 'shared' });
    assert.equal(made.status, 201);
    assert.throws(() => solo.tmux('show-options', '-t', made.body.id, '-v', '@tmux_web_owner'), /invalid option/, 'no owner stamp is written (the option does not exist)');
    const loc = solo.start('typed', 'cat'); // started in a terminal
    for (const email of ['a@x.com', 'b@x.com']) {
      const rows = (await call(email, 'GET', '/api/sessions')).body.sessions;
      assert.deepEqual(rows.map((s) => s.name).sort(), ['shared', 'typed'], `${email} sees everything`);
      assert.ok(rows.every((s) => s.owner === null && s.mine === false && s.access === 'full'), 'no owner, full access');
      const me = (await call(email, 'GET', '/api/me')).body;
      assert.deepEqual([me.multiUser, me.canViewOthers, me.canManageOthers, me.people, me.local], [false, false, false, [], 0]);
    }
    assert.equal((await call('b@x.com', 'GET', '/api/sessions?owner=a@x.com&owner=nobody@x.com')).body.sessions.length, 2, 'the owner filter has no meaning and is ignored');
    // b may use a's session like their own: read it, rename it, open its terminal, close it
    assert.equal((await call('b@x.com', 'GET', sessionPath(made.body.id, 'history'))).status, 200);
    const instance = made.body.instance;
    assert.equal((await call('b@x.com', 'PATCH', `/api/sessions/${encodeURIComponent(made.body.id)}`, { name: 'renamed', instance })).status, 200);
    assert.equal((await solo.requestAs('b@x.com', 'GET', '/verify', { 'x-forwarded-uri': `/term/ws?arg=%24${made.body.id.slice(1)}` })).status, 200);
    assert.equal((await call('b@x.com', 'DELETE', `/api/sessions/${encodeURIComponent(made.body.id)}`, { confirmed: true, instance })).status, 200);
    // a session an earlier multi-user period stamped is not shown as somebody's either
    solo.tmux('set-option', '-t', loc, '@tmux_web_owner', 'a@x.com');
    const stamped = (await call('b@x.com', 'GET', '/api/sessions')).body.sessions.find((s) => s.name === 'typed');
    assert.deepEqual([stamped.owner, stamped.mine, stamped.access], [null, false, 'full']);
  } finally { await solo.stop(); }
});

test('TMUX_WEB_MULTI_USER=0 switches multi-user off even when a users file exists', async () => {
  const off = await startApi({ ALLOWED_EMAILS: 'a@x.com b@x.com', TMUX_WEB_MULTI_USER: '0' });
  try {
    off.writeUsers({ users: { 'a@x.com': { name: 'A' }, 'b@x.com': { name: 'B' } } });
    assert.equal((await off.requestAs('a@x.com', 'POST', '/api/sessions', {}, { name: 'one' })).status, 201);
    assert.deepEqual((await off.requestAs('b@x.com', 'GET', '/api/sessions')).body.sessions.map((s) => s.name), ['one']);
    assert.equal((await off.requestAs('b@x.com', 'GET', '/api/me')).body.multiUser, false);
  } finally { await off.stop(); }
});
