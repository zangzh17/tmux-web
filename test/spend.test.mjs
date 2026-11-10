import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, delay } from './helpers.mjs';

// Hand-written transcripts in a private ~/.claude/projects; `sleep` plays Claude (TMUX_WEB_CLAUDE_COMMAND) so a tmux session in a
// project directory shows that directory's newest conversation (no ~/.claude/sessions record here).
let dir;
let projects;
let work;
let other;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();
const lines = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const projectOf = (cwd, root = projects) => path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'));
// one answer: every content block is its own line with the same message id (and the final usage on the last)
const answer = (id, t, model, usage, cwd, blocks = 1) => Array.from({ length: blocks }, (_, i) => ({
  type: 'assistant', timestamp: iso(t + i), cwd, requestId: `req_${id}`, isSidechain: false,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x "usage":{ inside text' }], usage: i === blocks - 1 ? usage : { ...usage, output_tokens: 1 } },
}));
const u = (input, write5m, write1h, read, output, extra = {}) => ({
  input_tokens: input, cache_creation_input_tokens: write5m + write1h, cache_read_input_tokens: read, output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }, service_tier: 'standard', speed: 'standard', ...extra,
});
// Opus 5.5: $4 in, $20 out, $0.20 cache reads; writes 1.25x (5 min) / 2x (1 h) input
const OPUS = { u: u(1000, 2000, 1000, 10_000, 500), cost: 0.004 + (2000 * 1.25 + 1000 * 2) * 4e-6 + 0.002 + 0.01 };

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-spend-'));
  projects = path.join(dir, 'projects');
  work = path.join(dir, 'work');
  other = path.join(dir, 'other');
  for (const d of [work, other]) { fs.mkdirSync(d); fs.mkdirSync(projectOf(d), { recursive: true }); }
  fs.mkdirSync(projectOf(other, path.join(dir, 'projects2')), { recursive: true }); // the second test's own transcripts
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('spend: prices, one answer written as several lines, subagents, and the session card', async () => {
  const t = now();
  const conv = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(projectOf(work), `${conv}.jsonl`), lines([
    { type: 'ai-title', aiTitle: 'Fix the thing', sessionId: conv },
    { type: 'user', timestamp: iso(t - 5 * 3600), message: { role: 'user', content: 'hi' } },
    ...answer('msg_a', t - 5 * 3600, 'claude-opus-5-5', OPUS.u, work, 3), // three lines, counted once
    ...answer('msg_b', t - 600, 'claude-opus-5-5', u(100, 0, 0, 0, 100, { speed: 'fast' }), work), // fast: 2x (100*4 + 100*20)/1e6
    ...answer('msg_c', t - 300, 'claude-sonnet-5-5', u(0, 0, 0, 1_000_000, 0), work), // $0.10 of cache reads
    ...answer('msg_d', t - 200, 'claude-haiku-5-5', u(50_000, 0, 0, 60_000, 1000), work), // past 100k prompt: 5x
    ...answer('msg_e', t - 100, '<synthetic>', u(1, 1, 0, 1, 1), work), // not a real answer
  ]));
  const sub = path.join(projectOf(work), conv, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), lines(answer('msg_s', t - 60, 'claude-sonnet-5-5', u(0, 0, 0, 0, 100_000), work))); // $1 of output
  const fast = 2 * (100 * 4 + 100 * 20) / 1e6;
  const haiku = 5 * (50_000 * 0.1 + 60_000 * 0.01 + 1000 * 0.5) / 1e6;
  const recent = fast + 0.1 + haiku + 1;

  const api = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_PROJECTS: projects });
  try {
    api.start('busy', '-c', work, 'sleep 600');
    api.start('shell', '-c', other); // not Claude: no spend
    const { body } = await api.request('GET', '/api/sessions');
    const busy = body.sessions.find((s) => s.name === 'busy');
    near(busy.spend.total, OPUS.cost + recent, 'total');
    near(busy.spend.recent, recent, 'last two hours');
    assert.equal(busy.spend.since, t - 5 * 3600);
    assert.equal(busy.spend.pct, null, 'no usage history: no share of the week');
    assert.equal(busy.spend.spark.length, 48);
    near(busy.spend.spark.reduce((a, b) => a + b, 0), OPUS.cost + recent, 'the spark covers it all');
    near(busy.spend.spark[47], recent, 'the last half hour');
    assert.equal(body.sessions.find((s) => s.name === 'shell').spend, null);

    // Claude writes more: a later line of the same answer replaces its usage, a new answer adds
    fs.appendFileSync(path.join(projectOf(work), `${conv}.jsonl`), lines([
      ...answer('msg_c', t - 300, 'claude-sonnet-5-5', u(0, 0, 0, 2_000_000, 0), work), // now $0.20
      ...answer('msg_f', t - 30, 'claude-opus-5-5', OPUS.u, work),
    ]));
    const again = (await api.request('GET', '/api/sessions')).body.sessions.find((s) => s.name === 'busy');
    near(again.spend.total, 2 * OPUS.cost + recent + 0.1, 'after more lines');

    const { spend } = (await api.request('GET', '/api/usage')).body;
    assert.equal(spend.ready, true);
    near(spend.recent, recent + 0.1 + OPUS.cost, 'the account\'s last two hours');
    near(spend.week, 2 * OPUS.cost + recent + 0.1, 'the last 7 days, without a weekly window');
    assert.deepEqual(spend.groups.map((g) => [g.label, g.sub, g.live]), [['busy', 'Fix the thing', true]]);
    near(spend.kinds.week.read, 0.002 * 2 + 0.2 + 60_000 * 0.01 * 5 / 1e6, 'cache reads');
    assert.deepEqual(spend.models.week.map((m) => m.model), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
  } finally { await api.stop(); }
});

test('spend: who sees the usage (users.json `usage`; admins always; another Unix account\'s people not by default)', async () => {
  const people = { 'boss@x.com': { admin: true, usage: false }, 'wfh@x.com': {}, 'off@x.com': { usage: false }, 'kid@x.com': { account: 'sub' } };
  const ALLOWED_EMAILS = Object.keys(people).join(' ');
  const shown = async (api, email) => {
    const me = (await api.requestAs(email, 'GET', '/api/me')).body;
    const usage = await api.requestAs(email, 'GET', '/api/usage');
    const card = (await api.requestAs(email, 'GET', '/api/sessions?owner=all')).body.sessions?.find((x) => x.claude);
    return [me.usage, usage.status, card ? card.spend !== null : null];
  };
  const main = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_PROJECTS: projects, ALLOWED_EMAILS });
  try {
    main.writeUsers({ home: 'main', accounts: ['sub'], users: people });
    for (const email of ['wfh@x.com', 'off@x.com']) main.tmux('set-option', '-t', main.start(`of-${email.split('@')[0]}`, '-c', work, 'sleep 600'), '@tmux_web_owner', email);
    assert.deepEqual(await shown(main, 'boss@x.com'), [true, 200, true], 'an admin, even with usage: false');
    assert.deepEqual(await shown(main, 'wfh@x.com'), [true, 200, true], 'the home account: shown by default');
    assert.deepEqual(await shown(main, 'off@x.com'), [false, 403, false], 'usage: false');
    assert.equal((await main.requestAs('off@x.com', 'GET', '/api/sessions')).body.sessions[0].context?.window > 0, true, 'the context bar stays');
  } finally { await main.stop(); }
  const sub = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_PROJECTS: projects, ALLOWED_EMAILS, TMUX_WEB_ACCOUNT: 'sub' });
  try {
    sub.writeUsers({ home: 'main', accounts: ['sub'], users: people });
    sub.start('kids', '-c', work, 'sleep 600');
    assert.deepEqual(await shown(sub, 'kid@x.com'), [false, 403, false], 'another Unix account: not by default');
    assert.deepEqual(await shown(sub, 'boss@x.com'), [true, 200, true], 'an admin there sees it');
    sub.writeUsers({ home: 'main', accounts: ['sub'], users: { ...people, 'kid@x.com': { account: 'sub', usage: true } } });
    assert.deepEqual(await shown(sub, 'kid@x.com'), [true, 200, true], 'unless usage: true');
  } finally { await sub.stop(); }
});

test('spend: the weekly rate from the usage history, labels by who may see what, and a restart from the saved index', async () => {
  const t = now();
  const root = path.join(dir, 'projects2');
  const a = 'aaaaaaaa-0000-4000-8000-000000000001';
  const b = 'bbbbbbbb-0000-4000-8000-000000000002';
  const p = path.join(projectOf(other, root), `${a}.jsonl`);
  // $2 spent while the weekly limit went 10% -> 14% (and $1 more before the history starts)
  fs.writeFileSync(p, lines([
    { type: 'ai-title', aiTitle: 'Finished work', sessionId: a },
    ...answer('msg_1', t - 3 * 86400, 'claude-sonnet-5-5', u(0, 0, 0, 0, 100_000), other),
    ...answer('msg_2', t - 2 * 86400 + 60, 'claude-sonnet-5-5', u(0, 0, 0, 0, 100_000), other),
    ...answer('msg_3', t - 2 * 86400 + 360, 'claude-sonnet-5-5', u(0, 0, 0, 0, 100_000), other),
  ]));
  fs.writeFileSync(path.join(projectOf(other, root), `${b}.jsonl`), lines(answer('msg_4', t - 100, 'claude-sonnet-5-5', u(0, 0, 0, 0, 10_000), other))); // untitled
  fs.utimesSync(p, t - 3600, t - 3600); // b is the directory's newest (two writes in a row can share a coarse timestamp)
  const reset = t + 3 * 86400;
  const samples = [[t - 2 * 86400, null, 10, null, reset], [t - 2 * 86400 + 300, null, 12, null, reset], [t - 2 * 86400 + 600, null, 14, null, reset + 1], [t - 60, null, 14, null, reset]];
  const usageFile = path.join(dir, 'usage.json');
  fs.writeFileSync(usageFile, JSON.stringify({ samples }));
  const spendFile = path.join(dir, 'spend.json');
  const env = { TMUX_WEB_CLAUDE_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_PROJECTS: root, TMUX_WEB_USAGE: usageFile, TMUX_WEB_SPEND: spendFile, TMUX_WEB_SPEND_SAVE_MS: '50', ALLOWED_EMAILS: 'boss@x.com wfh@x.com' };
  let api = await startApi(env);
  try {
    api.writeUsers({ unowned: 'viewers', users: { 'boss@x.com': { admin: true }, 'wfh@x.com': {} } });
    const mine = api.start('mine', '-c', other, 'sleep 600'); // shows conversation b, the newest of the directory
    api.tmux('set-option', '-t', mine, '@tmux_web_owner', 'wfh@x.com');
    const boss = (await api.requestAs('boss@x.com', 'GET', '/api/usage')).body.spend;
    near(boss.rate.perDollar, 4 / 2, '% of the week per dollar');
    assert.deepEqual([boss.rate.pct, boss.rate.cost, boss.rate.from], [4, 2, t - 2 * 86400]);
    assert.equal(boss.weekStart, reset - 7 * 86400);
    near(boss.week, 3 + 0.1, 'since the window opened (4 days ago)');
    near(boss.pct[0], 3.1 * 2, 'its share');
    assert.deepEqual(boss.groups.map((g) => [g.label, g.live]), [['Finished work', false], ['mine', true]]);
    const wfh = (await api.requestAs('wfh@x.com', 'GET', '/api/usage')).body.spend;
    assert.deepEqual(wfh.groups.map((g) => [g.label, g.live, g.rest]), [['mine', true, undefined], ['', false, 1]], 'a finished conversation is not theirs to read about');
    const card = (await api.requestAs('wfh@x.com', 'GET', '/api/sessions')).body.sessions[0].spend;
    near(card.total, 0.1, 'their session');
    near(card.pct[0], 0.2, 'as a share of the week');
    await delay(300); // the index is saved
  } finally { await api.stop(); }

  // restarted: the saved index is used and only the new bytes are read (the same answer continuing is still counted once)
  const saved = JSON.parse(fs.readFileSync(spendFile, 'utf8'));
  assert.ok(saved.files[p] && !JSON.stringify(saved).includes('inside text'), 'times and costs only, no text');
  fs.appendFileSync(p, lines(answer('msg_3', t - 2 * 86400 + 360, 'claude-sonnet-5-5', u(0, 0, 0, 0, 200_000), other)));
  api = await startApi(env);
  try {
    api.writeUsers({ unowned: 'viewers', users: { 'boss@x.com': { admin: true } } });
    let spend;
    for (let i = 0; i < 20 && !(spend = (await api.requestAs('boss@x.com', 'GET', '/api/usage')).body.spend).ready; i++) await delay(100);
    near(spend.groups.find((g) => g.label === 'Finished work').cost, 1 + 1 + 2, 'msg_3 replaced, not added');
  } finally { await api.stop(); }
});
