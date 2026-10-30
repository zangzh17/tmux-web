import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, sessionPath } from './helpers.mjs';

// Two Unix accounts served by one site, each by its own backend (here both run as the test user, with their own tmux servers):
// "main" (the home account, shared by boss and friend) and "sub" (kid's own account). boss is the admin.
const CONFIG = {
  home: 'main', accounts: ['sub'], unowned: 'viewers',
  users: {
    'boss@x.com': { name: 'Boss', admin: true },
    'friend@x.com': { name: 'Friend' },
    'kid@x.com': { name: 'Kid', account: 'sub' },
  },
};
const ALLOWED = 'boss@x.com friend@x.com kid@x.com';
let main; // the home account's backend
let sub; // kid's account's backend
const names = (res) => res.body.sessions.map((s) => s.name).sort();
const create = async (api, email, name) => { const r = await api.requestAs(email, 'POST', '/api/sessions', {}, { name }); assert.equal(r.status, 201, `${email} creates ${name}`); return r.body; };
const local = (api, name) => { const id = api.start(name, 'cat'); return { id, instance: api.tmux('display-message', '-p', '-t', id, '#{pid}:#{session_created}') }; };
const verify = (api, email, uri) => api.requestAs(email, 'GET', '/verify', { 'x-forwarded-uri': uri });
const term = (id, ro) => `/term/ws?arg=${encodeURIComponent(id)}${ro ? '&arg=ro' : ''}`;
let s; // name -> { id, instance }

before(async () => {
  main = await startApi({ ALLOWED_EMAILS: ALLOWED, TMUX_WEB_ACCOUNT: 'main' });
  sub = await startApi({ ALLOWED_EMAILS: ALLOWED, TMUX_WEB_ACCOUNT: 'sub' });
  for (const api of [main, sub]) api.writeUsers(CONFIG);
  // the home backend finds the other account's API where Caddy would: <run>/<account>/api.sock
  fs.mkdirSync(path.join(main.dir, 'run', 'sub'), { recursive: true });
  fs.symlinkSync(path.join(sub.dir, 'api.sock'), path.join(main.dir, 'run', 'sub', 'api.sock'));
  fs.mkdirSync(path.join(main.dir, 'accounts'));
  s = {
    bossMain: await create(main, 'boss@x.com', 'bossmain'),
    friend: await create(main, 'friend@x.com', 'friend1'),
    mainLocal: local(main, 'mainlocal'),
    kid: await create(sub, 'kid@x.com', 'kid1'),
    bossSub: await create(sub, 'boss@x.com', 'bosssub'),
    subLocal: local(sub, 'sublocal'),
  };
});
after(async () => {
  await main?.stop();
  await sub?.stop();
});

test('the home account: the admin sees everything, a shared-account person only their own', async () => {
  assert.deepEqual(names(await main.requestAs('boss@x.com', 'GET', '/api/sessions?owner=all')), ['bossmain', 'friend1', 'mainlocal']);
  assert.deepEqual(names(await main.requestAs('friend@x.com', 'GET', '/api/sessions')), ['friend1']);
  assert.deepEqual(names(await main.requestAs('friend@x.com', 'GET', '/api/sessions?owner=all')), ['friend1'], 'asking for more changes nothing');
  for (const id of [s.bossMain.id, s.mainLocal.id]) {
    assert.equal((await main.requestAs('friend@x.com', 'GET', sessionPath(id, 'history'))).status, 404);
    assert.equal((await verify(main, 'friend@x.com', term(id, true))).status, 404);
  }
  const boss = (await main.requestAs('boss@x.com', 'GET', '/api/sessions?owner=all')).body.sessions;
  assert.deepEqual(Object.fromEntries(boss.map((x) => [x.name, [x.access, x.foreign]])), { bossmain: ['full', false], friend1: ['full', true], mainlocal: ['full', false] });
  // the admin's own terminal-started sessions are theirs (their account), friend's are someone else's
  assert.equal((await verify(main, 'boss@x.com', term(s.friend.id))).status, 200);
});

test('another account\'s person cannot use the home backend at all, but is told where to go', async () => {
  const me = await main.requestAs('kid@x.com', 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.allowed, me.body.account, me.body.myAccount, me.body.people, me.body.sharePeople], [false, 'main', 'sub', [], []]);
  const refused = await main.requestAs('kid@x.com', 'GET', '/api/sessions');
  assert.deepEqual([refused.status, refused.body.account], [403, 'sub']);
  assert.equal((await main.requestAs('kid@x.com', 'POST', '/api/sessions', {}, { name: 'sneak' })).status, 403);
  assert.equal((await main.requestAs('kid@x.com', 'GET', sessionPath(s.mainLocal.id, 'history'))).status, 403);
  assert.equal((await main.requestAs('kid@x.com', 'POST', '/api/uploads', {}, { size: 2048 })).status, 403);
  assert.equal((await verify(main, 'kid@x.com', term(s.mainLocal.id, true))).status, 403);
  assert.equal((await verify(main, 'kid@x.com', '/term/')).status, 403, 'not even ttyd\'s page');
  assert.equal((await verify(main, 'kid@x.com', '/index.html')).status, 200, 'the static page is the same for everyone');
  // preferences live with the home account for everybody
  assert.equal((await main.requestAs('kid@x.com', 'PUT', '/api/prefs', {}, { prefs: { 'phone.fs': '15' } })).status, 200);
});

test('a personal account: its person may do anything in it, nobody else but an admin gets in', async () => {
  const kid = await sub.requestAs('kid@x.com', 'GET', '/api/sessions');
  assert.deepEqual(names(kid), ['bosssub', 'kid1', 'sublocal'], 'everything, local ones included, with no filter');
  assert.ok(kid.body.sessions.every((x) => x.access === 'full'));
  assert.deepEqual(Object.fromEntries(kid.body.sessions.map((x) => [x.name, x.foreign])), { bosssub: true, kid1: false, sublocal: false });
  const me = (await sub.requestAs('kid@x.com', 'GET', '/api/me')).body;
  assert.deepEqual([me.allowed, me.account, me.myAccount, me.people, me.sharePeople], [true, 'sub', 'sub', [], []]);
  assert.equal(sub.tmux('show-options', '-v', '-t', s.bossSub.id, '@tmux_web_owner'), 'boss@x.com', 'what the admin starts there says so');
  assert.equal((await verify(sub, 'kid@x.com', term(s.bossSub.id))).status, 200);
  // friend belongs to the home account
  assert.equal((await sub.requestAs('friend@x.com', 'GET', '/api/sessions')).status, 403);
  assert.equal((await sub.requestAs('friend@x.com', 'GET', '/api/me')).body.allowed, false);
  assert.equal((await verify(sub, 'friend@x.com', term(s.subLocal.id, true))).status, 403);
  // the admin may do anything, and sees all of it as somebody else's except what they started
  const boss = (await sub.requestAs('boss@x.com', 'GET', '/api/sessions')).body.sessions;
  assert.deepEqual(Object.fromEntries(boss.map((x) => [x.name, [x.access, x.foreign]])), { bosssub: ['full', false], kid1: ['full', true], sublocal: ['full', true] });
  assert.equal((await sub.requestAs('boss@x.com', 'GET', '/api/me')).body.people.length, 0, 'no owner filter in a personal account');
  const renamed = await sub.requestAs('boss@x.com', 'PATCH', `/api/sessions/${encodeURIComponent(s.kid.id)}`, {}, { name: 'kid1', instance: s.kid.instance });
  assert.equal(renamed.status, 200);
});

test('sharing: the owner (or an admin) shares a session with someone of the account, read-only or for control', async () => {
  const share = (email, id, instance, value) => main.requestAs(email, 'PUT', sessionPath(id, 'share'), {}, { instance, share: value });
  const friendSees = async () => (await main.requestAs('friend@x.com', 'GET', '/api/sessions')).body.sessions.find((x) => x.id === s.mainLocal.id);
  assert.deepEqual((await main.requestAs('boss@x.com', 'GET', '/api/me')).body.sharePeople, [{ email: 'friend@x.com', name: 'Friend' }]);
  assert.equal(await friendSees(), undefined);

  let r = await share('boss@x.com', s.mainLocal.id, s.mainLocal.instance, { 'Friend@X.com': 'view' });
  assert.deepEqual([r.status, r.body.share], [200, [{ email: 'friend@x.com', name: 'Friend', level: 'view' }]]);
  assert.equal(main.tmux('show-options', '-v', '-t', s.mainLocal.id, '@tmux_web_share'), 'friend@x.com=view');
  const seen = await friendSees();
  assert.deepEqual([seen?.access, seen?.foreign, seen?.share], ['view', true, []], 'listed for them, read-only, without the share list');
  assert.equal((await main.requestAs('friend@x.com', 'GET', sessionPath(s.mainLocal.id, 'history'))).status, 200);
  assert.equal((await main.requestAs('friend@x.com', 'POST', sessionPath(s.mainLocal.id, 'input'), {}, { instance: s.mainLocal.instance, key: 'Enter' })).status, 403);
  assert.equal((await verify(main, 'friend@x.com', term(s.mainLocal.id))).status, 403);
  assert.equal((await verify(main, 'friend@x.com', term(s.mainLocal.id, true))).status, 200);
  assert.equal((await share('friend@x.com', s.mainLocal.id, s.mainLocal.instance, {})).status, 403, 'only someone with full access changes it');
  const boss = (await main.requestAs('boss@x.com', 'GET', '/api/sessions?owner=all')).body.sessions.find((x) => x.id === s.mainLocal.id);
  assert.deepEqual(boss.share, [{ email: 'friend@x.com', name: 'Friend', level: 'view' }]);

  r = await share('boss@x.com', s.mainLocal.id, s.mainLocal.instance, { 'friend@x.com': 'full' });
  assert.equal(r.status, 200);
  assert.equal((await friendSees())?.access, 'full');
  assert.equal((await verify(main, 'friend@x.com', term(s.mainLocal.id))).status, 200);

  // nobody else: not the admin (sees everything anyway), not another account's person, not the owner, not a stranger
  for (const who of ['boss@x.com', 'kid@x.com', 'nobody@x.com', 'x\'y@x.com']) {
    assert.equal((await share('boss@x.com', s.mainLocal.id, s.mainLocal.instance, { [who]: 'view' })).status, 400, who);
  }
  assert.equal((await share('boss@x.com', s.friend.id, s.friend.instance, { 'friend@x.com': 'view' })).status, 400, 'not with its own owner');
  assert.equal((await share('boss@x.com', s.mainLocal.id, s.mainLocal.instance, { 'friend@x.com': 'all' })).status, 400);
  assert.equal((await share('boss@x.com', s.mainLocal.id, '1:1', {})).status, 404, 'a stale tab changes nothing');
  assert.equal(main.tmux('show-options', '-v', '-t', s.mainLocal.id, '@tmux_web_share'), 'friend@x.com=full');
  assert.equal((await main.requestAs('boss@x.com', 'GET', sessionPath(s.mainLocal.id, 'share'))).status, 405);

  r = await share('boss@x.com', s.mainLocal.id, s.mainLocal.instance, {});
  assert.deepEqual([r.status, r.body.share], [200, []]);
  assert.equal(await friendSees(), undefined, 'stopped');
  assert.equal((await verify(main, 'friend@x.com', term(s.mainLocal.id, true))).status, 404);
  // friend has nobody to share with
  assert.deepEqual((await main.requestAs('friend@x.com', 'GET', '/api/me')).body.sharePeople, []);
  // in a personal account there is nothing to share: everybody who gets in may do anything already
  assert.equal((await sub.requestAs('kid@x.com', 'PUT', sessionPath(s.kid.id, 'share'), {}, { instance: s.kid.instance, share: { 'friend@x.com': 'view' } })).status, 400);
});

test('/api/accounts: the admin sees every account and switches the others on and off; everyone else sees their own', async () => {
  const states = async (email) => (await main.requestAs(email, 'GET', '/api/accounts')).body;
  assert.deepEqual(await states('boss@x.com'), { home: 'main', admin: true, accounts: [
    { name: 'main', home: true, on: true, up: true }, { name: 'sub', home: false, on: false, up: true }] }, 'its API answers although its switch is off');
  assert.deepEqual(await states('kid@x.com'), { home: 'main', admin: false, accounts: [{ name: 'sub', home: false, on: false, up: true }] });
  assert.deepEqual(await states('friend@x.com'), { home: 'main', admin: false, accounts: [{ name: 'main', home: true, on: true, up: true }] });
  const flip = (email, name, body, extra) => main.requestAs(email, 'PUT', `/api/accounts/${name}`, extra, body);
  const file = path.join(main.dir, 'accounts', 'sub');
  assert.equal((await flip('boss@x.com', 'sub', { on: true })).status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'on\n');
  assert.equal((await states('kid@x.com')).accounts[0].on, true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sub'], 'written by rename, nothing left behind');
  assert.equal((await flip('boss@x.com', 'sub', { on: false })).status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'off\n');
  assert.equal((await flip('kid@x.com', 'sub', { on: true })).status, 403, 'not their own either');
  assert.equal((await flip('friend@x.com', 'sub', { on: true })).status, 403);
  assert.equal((await flip('boss@x.com', 'main', { on: false })).status, 404, 'the home account cannot be switched off');
  assert.equal((await flip('boss@x.com', '..', { on: true })).status, 404);
  assert.equal((await flip('boss@x.com', 'sub', { on: 'yes' })).status, 400);
  assert.equal((await flip('boss@x.com', 'sub', { on: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await main.requestAs('boss@x.com', 'POST', '/api/accounts')).status, 405);
  assert.equal(fs.readFileSync(file, 'utf8'), 'off\n');
  // an account whose API is not there is reported down
  fs.rmSync(path.join(main.dir, 'run', 'sub', 'api.sock'));
  try { assert.equal((await states('boss@x.com')).accounts[1].up, false); }
  finally { fs.symlinkSync(path.join(sub.dir, 'api.sock'), path.join(main.dir, 'run', 'sub', 'api.sock')); }
});

test('a users file that puts people in accounts without naming the home one is refused; the last good one stays', async () => {
  try {
    for (const broken of [{ ...CONFIG, home: undefined }, { ...CONFIG, home: 'Main!' }, { ...CONFIG, accounts: ['../etc'] },
      { ...CONFIG, users: { ...CONFIG.users, 'kid@x.com': { account: 'elsewhere' } } }]) {
      sub.writeUsers(broken);
      assert.equal((await sub.requestAs('friend@x.com', 'GET', '/api/sessions')).status, 403, JSON.stringify(broken));
      assert.equal((await sub.requestAs('kid@x.com', 'GET', '/api/sessions')).status, 200);
    }
  } finally { sub.writeUsers(CONFIG); }
});

test('TMUX_WEB_MULTI_ACCOUNT=1 refuses everything until the users file names the home account', async () => {
  const api = await startApi({ ALLOWED_EMAILS: ALLOWED, TMUX_WEB_ACCOUNT: 'sub', TMUX_WEB_MULTI_ACCOUNT: '1', TMUX_WEB_SOCK_MODE: '660' });
  try {
    assert.equal(fs.statSync(path.join(api.dir, 'api.sock')).mode & 0o777, 0o660);
    for (const email of ['friend@x.com', 'kid@x.com', 'boss@x.com']) assert.equal((await api.requestAs(email, 'GET', '/api/sessions')).status, 503);
    api.writeUsers({ users: { 'boss@x.com': { admin: true } } }); // no "home"
    assert.equal((await api.requestAs('boss@x.com', 'GET', '/api/me')).status, 503);
    api.writeUsers(CONFIG);
    assert.equal((await api.requestAs('friend@x.com', 'GET', '/api/sessions')).status, 403);
    assert.equal((await api.requestAs('kid@x.com', 'GET', '/api/sessions')).status, 200);
  } finally { await api.stop(); }
});
