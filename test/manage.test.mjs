import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, delay, sessionPath } from './helpers.mjs';

// manageOthers: a person who may also type into, rename and close other people's sessions (and so view them).
// boss manages everyone; lead manages bob and may only view alice; viewer may only view everyone; alice, bob, carol are plain.
// Sessions: a1 (alice) b1 (bob, a fake Claude) c1 (carol) loc1 (started in a terminal).
const CONFIG = {
  unowned: 'viewers',
  users: {
    'boss@x.com': { name: 'Boss', manageOthers: 'all' },
    'lead@x.com': { name: 'Lead', manageOthers: ['bob@x.com'], viewOthers: ['alice@x.com'] },
    'viewer@x.com': { name: 'Viewer', viewOthers: 'all' },
  },
};
const ALLOWED = 'owner@example.com boss@x.com lead@x.com viewer@x.com alice@x.com bob@x.com carol@x.com';
let api;
let dir;
let ids;
let log;
const as = (email, method, endpoint, extra, body) => api.requestAs(email, method, endpoint, extra, body);
const create = async (email, name) => { const r = await as(email, 'POST', '/api/sessions', {}, { name }); assert.equal(r.status, 201); return r.body; };
const access = async (email) => Object.fromEntries((await as(email, 'GET', '/api/sessions?owner=all')).body.sessions.map((s) => [s.name, s.access]));
const received = () => (fs.existsSync(log) ? Buffer.concat(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64'))).toString('utf8') : '');

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-manage-'));
  const script = path.join(dir, 'fake-claude.mjs');
  log = path.join(dir, 'b1.log');
  fs.writeFileSync(script, `import fs from 'node:fs';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdin.on('data', (d) => fs.appendFileSync(process.argv[2], d.toString('base64') + '\\n'));
fs.writeFileSync(process.argv[2] + '.ready', 'ready');
setInterval(() => {}, 1000);
`);
  api = await startApi({ ALLOWED_EMAILS: ALLOWED, TMUX_WEB_CLAUDE_COMMAND: '^node$', TMUX_WEB_INPUT_SETTLE_MS: '30' });
  api.writeUsers(CONFIG);
  ids = { a1: await create('alice@x.com', 'a1'), c1: await create('carol@x.com', 'c1') };
  const id = api.start('b1', process.execPath, script, log);
  for (let i = 0; !fs.existsSync(`${log}.ready`); i++) { assert.ok(i < 100, 'fake Claude did not start'); await delay(50); }
  await delay(300);
  api.tmux('set-option', '-t', id, '@tmux_web_owner', 'bob@x.com');
  ids.b1 = { id, instance: api.tmux('display-message', '-p', '-t', id, '#{pid}:#{session_created}') };
  const loc = api.start('loc1', 'cat');
  ids.loc1 = { id: loc, instance: api.tmux('display-message', '-p', '-t', loc, '#{pid}:#{session_created}') };
});
after(async () => {
  await api?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('manage gives full access to the people it covers, view gives read-only, everyone else nothing', async () => {
  assert.deepEqual(await access('boss@x.com'), { a1: 'full', b1: 'full', c1: 'full', loc1: 'full' });
  assert.deepEqual(await access('lead@x.com'), { a1: 'view', b1: 'full', loc1: 'full' }, 'carol is neither viewed nor managed');
  assert.deepEqual(await access('viewer@x.com'), { a1: 'view', b1: 'view', c1: 'view', loc1: 'full' });
  assert.deepEqual(await access('alice@x.com'), { a1: 'full' }, 'a plain user: own only (local sessions are for viewers here)');
  const list = (await as('boss@x.com', 'GET', '/api/sessions?owner=all')).body.sessions;
  assert.deepEqual(list.find((s) => s.name === 'b1').owner, { email: 'bob@x.com', name: 'bob' });
  assert.equal(list.find((s) => s.name === 'b1').mine, false, 'still not mine, even though I may manage it');
});

test('/api/me reports who may manage, and people covers both kinds of permission', async () => {
  const me = async (email) => (await as(email, 'GET', '/api/me')).body;
  assert.deepEqual([(await me('boss@x.com')).canManageOthers, (await me('boss@x.com')).canViewOthers], [true, true], 'managing implies viewing');
  assert.deepEqual((await me('boss@x.com')).people.map((p) => p.email), ['alice@x.com', 'bob@x.com', 'carol@x.com', 'lead@x.com', 'viewer@x.com']);
  const lead = await me('lead@x.com');
  assert.deepEqual([lead.canViewOthers, lead.canManageOthers, lead.people.map((p) => p.email)], [true, true, ['alice@x.com', 'bob@x.com']], 'view list and manage list are merged');
  const viewer = await me('viewer@x.com');
  assert.deepEqual([viewer.canViewOthers, viewer.canManageOthers], [true, false]);
  assert.deepEqual([(await me('alice@x.com')).canViewOthers, (await me('alice@x.com')).canManageOthers], [false, false]);
});

test('a manager can type into, rename and close someone elses session; a viewer still cannot', async () => {
  const b1 = ids.b1;
  const path1 = `/api/sessions/${encodeURIComponent(b1.id)}`;
  // a viewer is refused as before
  assert.equal((await as('viewer@x.com', 'POST', sessionPath(b1.id, 'input'), {}, { instance: b1.instance, key: 'Enter' })).status, 403);
  assert.equal((await as('viewer@x.com', 'PATCH', path1, {}, { instance: b1.instance, name: 'nope' })).status, 403);
  // lead manages bob: keys reach the pane, the name changes
  assert.equal((await as('lead@x.com', 'POST', sessionPath(b1.id, 'input'), {}, { instance: b1.instance, key: 'Escape' })).status, 200);
  for (let i = 0; i < 40 && !received(); i++) await delay(50);
  assert.equal(received(), '\x1b', 'the manager’s key arrived in bob’s pane');
  const renamed = await as('lead@x.com', 'PATCH', path1, {}, { instance: b1.instance, name: 'b1_renamed' });
  assert.deepEqual([renamed.status, renamed.body.name], [200, 'b1_renamed']);
  assert.ok((await as('bob@x.com', 'GET', '/api/sessions')).body.sessions.some((s) => s.name === 'b1_renamed'), 'the owner sees the new name');
  assert.equal((await as('lead@x.com', 'PATCH', path1, {}, { instance: b1.instance, name: 'b1' })).status, 200);
  // lead may only view alice, and does not exist for carol
  const a1 = ids.a1;
  assert.equal((await as('lead@x.com', 'PATCH', `/api/sessions/${encodeURIComponent(a1.id)}`, {}, { instance: a1.instance, name: 'x' })).status, 403);
  const c1 = ids.c1;
  assert.equal((await as('lead@x.com', 'DELETE', `/api/sessions/${encodeURIComponent(c1.id)}`, {}, { instance: c1.instance, confirmed: true })).status, 404);
  assert.ok((await access('carol@x.com')).c1, 'carol’s session is untouched');
  // boss may close anyone's, and a closed session is gone for its owner
  assert.deepEqual((await as('boss@x.com', 'DELETE', `/api/sessions/${encodeURIComponent(a1.id)}`, {}, { instance: a1.instance, confirmed: true })).body, { id: a1.id, closed: true });
  assert.deepEqual(await access('alice@x.com'), {}, 'alice no longer has a1');
  ids.a1 = await create('alice@x.com', 'a1'); // for the tests below
});

test('/verify lets a manager attach read-write, a viewer only read-only, and a stranger not at all', async () => {
  const n = (name) => ids[name].id.slice(1);
  const verify = async (email, name, tail = '') => (await as(email, 'GET', '/verify', { 'x-forwarded-uri': `/term/ws?arg=%24${n(name)}${tail}` })).status;
  assert.equal(await verify('boss@x.com', 'c1'), 200, 'manager: no ro needed');
  assert.equal(await verify('lead@x.com', 'b1'), 200);
  assert.equal(await verify('lead@x.com', 'a1'), 403, 'lead only views alice: ro required');
  assert.equal(await verify('lead@x.com', 'a1', '&arg=ro'), 200);
  assert.equal(await verify('lead@x.com', 'c1'), 404);
  assert.equal(await verify('viewer@x.com', 'b1'), 403);
  assert.equal(await verify('alice@x.com', 'b1'), 404);
});

test('permissions can be granted and revoked while running, and nonsense values grant nothing', async () => {
  const b1 = ids.b1;
  const input = (email) => as(email, 'POST', sessionPath(b1.id, 'input'), {}, { instance: b1.instance, key: 'Escape' });
  assert.equal((await input('viewer@x.com')).status, 403);
  api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'viewer@x.com': { name: 'Viewer', manageOthers: ['Bob@X.com'] } } }); // case-insensitive
  assert.equal((await input('viewer@x.com')).status, 200);
  assert.equal((await access('viewer@x.com')).b1, 'full');
  api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'viewer@x.com': { name: 'Viewer', manageOthers: 5, viewOthers: 'all' } } });
  assert.equal((await input('viewer@x.com')).status, 403, 'a bad manageOthers value means nobody, not everybody');
  api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'viewer@x.com': { name: 'Viewer', manageOthers: [], viewOthers: 'all' } } });
  assert.equal((await input('viewer@x.com')).status, 403, 'an empty list manages nobody');
  api.writeUsers({ ...CONFIG, users: { ...CONFIG.users, 'viewer@x.com': { name: 'Viewer', manageOthers: 'ALL' } } });
  assert.equal((await input('viewer@x.com')).status, 404, '"ALL" is not "all": no view and no manage');
  api.writeUsers(CONFIG);
  assert.equal((await input('viewer@x.com')).status, 403);
});

test('local sessions follow the unowned policy for managers like anyone: "viewers" counts people who manage', async () => {
  api.writeUsers({ unowned: 'viewers', users: { 'lead@x.com': { manageOthers: ['bob@x.com'] } } });
  assert.equal((await access('lead@x.com')).loc1, 'full', 'a manager is a viewer for this purpose');
  assert.equal((await access('alice@x.com')).loc1, undefined);
  api.writeUsers(CONFIG);
});
