import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, sessionPath, delay } from './helpers.mjs';

// A private ~/.gemini/antigravity-cli with hand-built conversation databases (steps as protobuf, see gemini.mjs). `sleep` plays
// agy (TMUX_WEB_GEMINI_COMMAND) and holds presence/<id>.lock open, which is how the API finds the pane's conversation.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;

const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
// a message from [field, value] pairs: a number is a varint, a string or Buffer length-delimited, an array a nested message
const pb = (...pairs) => Buffer.concat(pairs.map(([f, v]) => {
  if (typeof v === 'number') return Buffer.concat([varint(f * 8), varint(v)]);
  const body = Array.isArray(v) ? pb(...v) : Buffer.from(v);
  return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
}));
const now = () => Math.floor(Date.now() / 1000);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
// model_usage: model, input, output (thinking included), cached, thinking, response
const usage = (model, input, output, cached, thinking) => [[1, model], [2, input], [3, output], [5, cached], [6, 24], [9, thinking], [10, output - thinking]];
const meta = (t, id, use) => [[1, [[1, t]]], ...(use ? [[9, usage(...use)]] : []), [35, id]];
const userStep = (t, id, text) => ({ type: 14, payload: pb([1, 14], [4, 3], [5, meta(t, id)], [19, [[2, text]]]) });
const reply = (t, id, text, calls = [], use = null, status = 3) => ({ type: 15, status,
  payload: pb([1, 15], [4, status], [5, meta(t, id, use)], [20, [[1, text], [3, 'thinking it over'], ...calls.map(([name, args]) => [7, [[1, `call_${name}`], [2, name], [3, JSON.stringify(args)]]])]]) });
const result = (t, id, text, status = 3, error = '') => ({ type: 132, status, error: error ? pb([2, error], [3, error]) : null,
  payload: pb([1, 132], [4, status], [5, meta(t, id)], [140, [[2, [[1, `Created At: x\nCompleted At: y\n${text}`]]]]]) });
const reminder = (t, id) => ({ type: 101, payload: pb([1, 101], [4, 3], [5, meta(t, id)], [114, [[1, 'Reminder: work efficiently']]]) });

function writeConversation(root, id, steps) {
  const file = path.join(root, 'conversations', `${id}.db`);
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))');
  const add = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?, ?, ?, ?, ?, ?)');
  steps.forEach((s, i) => {
    const p = s.payload;
    // the metadata column repeats field 5 of the payload
    let metaBuf = Buffer.alloc(0);
    for (let k = 0; k < p.length;) {
      let key = 0; let m = 1; let b;
      do { b = p[k++]; key += (b & 127) * m; m *= 128; } while (b & 128);
      let len = 0; m = 1;
      if (key % 8 === 0) { do { b = p[k++]; } while (b & 128); continue; }
      do { b = p[k++]; len += (b & 127) * m; m *= 128; } while (b & 128);
      if (Math.floor(key / 8) === 5) metaBuf = p.subarray(k, k + len);
      k += len;
    }
    add.run(i, s.type, s.status ?? 3, metaBuf, s.error ?? null, p);
  });
  db.close();
  const t = new Date(Date.now() + 1000); // a new signature even within the same second
  fs.utimesSync(file, t, t);
}
function writeSummaries(root, rows) {
  const file = path.join(root, 'conversation_summaries.db');
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', workspace_uris text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '', PRIMARY KEY (conversation_id))");
  const add = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) add.run(r.id, r.title || '', r.preview || '', r.cwd ? `file://${r.cwd}` : '', r.parent || '');
  db.close();
}

let dir;
before(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-gemini-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NEON = 1532; // gemini-4-neon-high: $3 in, $15 out, $0.15 cached
const FLASH = 1319; // gemini-3.8-flash-medium: $0.75 / $3.75 / $0.075

test('gemini: the pane\'s conversation in the list, the Read view, input and the spend panel', async () => {
  const root = path.join(dir, 'gemini');
  const work = path.join(dir, 'work');
  for (const d of ['conversations', 'presence', 'cache']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(work);
  const conv = '11111111-2222-4333-8444-555555555555';
  const child = '66666666-2222-4333-8444-555555555555';
  const run = '77777777-2222-4333-8444-555555555555';
  const t = now();
  const steps = [
    userStep(t - 600, 's0', 'Fix the bug'),
    reminder(t - 599, 's1'),
    reply(t - 598, 's2', 'Looking.', [['run_command', { CommandLine: 'git status', toolSummary: 'status' }], ['read_file', { Path: '/x/y.js' }]], [NEON, 10_000, 2_000, 90_000, 500]),
    result(t - 590, 's3', 'On branch main'),
    result(t - 589, 's4', '', 7, 'file does not exist'),
    reply(t - 300, 's5', 'Done: the bug is fixed.', [], [NEON, 1_000, 100, 120_000, 0]),
  ];
  writeConversation(root, conv, steps);
  writeConversation(root, child, [reply(t - 595, 'c0', 'sub', [], [FLASH, 1_000_000, 0, 0, 0])]); // a subagent: $0.75
  writeConversation(root, run, [userStep(t - 9000, 'r0', 'hi'), reply(t - 8990, 'r1', 'hello', [], [FLASH, 0, 1_000_000, 0, 200_000])]); // $3.75
  writeSummaries(root, [{ id: conv, title: 'Bug hunt', cwd: work }, { id: child, parent: conv, cwd: work }, { id: run, preview: 'hi', cwd: '/tmp/score-gemini-call-abcdefgh/work' }]);
  const lock = path.join(root, 'presence', `${conv}.lock`);
  fs.writeFileSync(lock, '');
  const neon = (i, o, c) => (i * 3 + o * 15 + c * 0.15) / 1e6;
  const own = neon(10_000, 2_000, 90_000) + neon(1_000, 100, 120_000);

  const api = await startApi({ TMUX_WEB_GEMINI_DIR: root, TMUX_WEB_GEMINI_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_COMMAND: '^never$' });
  try {
    const id = api.start('gem', 'sh', '-c', `cd '${work}' && exec 9<>'${lock}' && exec sleep 600`);
    await delay(300);
    const s = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === id);
    assert.equal(s.agent, 'gemini');
    assert.equal(s.claude, false);
    assert.deepEqual(s.context, { tokens: 121_000, window: 1_048_576, model: 'gemini-4-neon-high' }, 'the newest generation: input + cached');
    near(s.spend.total, own + 0.75, 'the conversation and its subagent');
    near(s.spend.recent, own + 0.75, 'all of it in the last two hours');
    assert.equal(s.spend.pct, null, 'no limit to measure a share of');
    assert.equal(s.spend.spark.length, 48);

    let tr = (await api.request('GET', sessionPath(id, 'transcript'))).body;
    assert.equal(tr.agent, 'gemini');
    assert.equal(tr.file, `${conv}.1`);
    assert.deepEqual(tr.items.map((i) => [i.kind, i.name ?? null, i.text, i.error ?? null]), [
      ['user', null, 'Fix the bug', null],
      ['assistant', null, 'Looking.', null],
      ['tool', 'run_command', 'git status', null],
      ['tool', 'read_file', '/x/y.js', null],
      ['result', null, 'On branch main', false],
      ['result', null, 'file does not exist', true],
      ['assistant', null, 'Done: the bug is fixed.', null],
    ]);
    assert.equal(tr.items[0].ts, new Date((t - 600) * 1000).toISOString());
    assert.equal(tr.busy, false);
    assert.equal(tr.asking, false);

    // a new message, then a reply still being written: not shown until it is finished, and the pane is working
    writeConversation(root, conv, [...steps, userStep(t - 10, 's6', 'And the tests?'), reply(t - 5, 's7', 'Half', [], null, 8)]);
    tr = (await api.request('GET', sessionPath(id, 'transcript', `?after=${tr.total}`))).body;
    assert.deepEqual([tr.file, tr.start, tr.items.map((i) => i.text), tr.busy], [`${conv}.1`, 7, ['And the tests?'], true]);
    // finished, and a tool waiting for approval after it: asking
    writeConversation(root, conv, [...steps, userStep(t - 10, 's6', 'And the tests?'), reply(t - 5, 's7', 'Running them.', [['run_command', { CommandLine: 'npm test' }]], [NEON, 10, 10, 0, 0]),
      { ...result(t - 4, 's8', ''), status: 9, payload: pb([1, 132], [4, 9], [5, meta(t - 4, 's8')]) }]);
    tr = (await api.request('GET', sessionPath(id, 'transcript', '?after=8'))).body;
    assert.deepEqual([tr.items.map((i) => i.kind), tr.busy, tr.asking], [['assistant', 'tool'], false, true]);
    // rewound: the step at a known index has another id, so the list starts over under a new name
    writeConversation(root, conv, [userStep(t - 600, 'x0', 'Start again')]);
    tr = (await api.request('GET', sessionPath(id, 'transcript'))).body;
    assert.deepEqual([tr.file, tr.total, tr.items.map((i) => i.text), tr.busy], [`${conv}.2`, 1, ['Start again'], true]);
    writeConversation(root, conv, steps);

    // input reaches a Gemini pane; Claude's Send now chord does not
    const instance = s.instance;
    assert.equal((await api.request('POST', sessionPath(id, 'input'), {}, { instance, key: 'Enter' })).status, 200);
    assert.equal((await api.request('POST', sessionPath(id, 'input'), {}, { instance, key: 'SendNow' })).status, 400);

    // the panel: Gemini apart from Claude, the open conversation by its session's name, the `agy -p` run by its directory
    const g = (await api.request('GET', '/api/usage')).body.gemini;
    assert.equal(g.ready, true);
    near(g.week, own + 0.75 + 3.75, 'everything in the last 7 days');
    near(g.recent, own + 0.75, 'the last two hours');
    assert.equal(g.conversations, 2, 'the subagent counts with its conversation');
    const open = g.groups.find((x) => x.live);
    assert.deepEqual([open.label, open.sub], ['gem', 'Bug hunt']);
    near(open.cost, own + 0.75, 'the open conversation');
    const other = g.groups.find((x) => !x.live);
    assert.deepEqual([other.label, other.sub], ['hi', '/tmp/score-gemini-call-*/work']);
    near(g.kinds.week.thinking, 200_000 * 3.75 / 1e6 + 500 * 15 / 1e6, 'thinking priced as output, shown apart');
    assert.deepEqual(g.models.week.map((m) => m.model), ['gemini-3.8-flash-medium', 'gemini-4-neon-high']);
    assert.equal(g.tokens.week, 10_000 + 2_000 + 90_000 + 1_000 + 100 + 120_000 + 1_000_000 + 1_000_000);
  } finally { await api.stop(); }
});

test('gemini quota: agy\'s own /usage panel read in a private tmux (trust prompt, groups, windows), and agy ended afterwards', async () => {
  const root = path.join(dir, 'gemini-q');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  const fake = path.join(dir, 'fake-agy.mjs');
  const pidFile = path.join(dir, 'fake-agy.pid');
  // draws what agy 1.5 draws: a trust question, a prompt between rules, and on `/usage` + Enter the Models & Quota panel
  fs.writeFileSync(fake, `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGHUP', () => {}); // like agy: a killed tmux does not end it
process.stdin.setRawMode(true);
const out = (s) => process.stdout.write(s.replace(/\\n/g, '\\r\\n'));
let trusted = false; let typed = '';
out('Do you trust the contents of this project?\\n> Yes, I trust this folder\\n  No, exit\\n');
process.stdin.on('data', (d) => {
  const k = d.toString();
  if (!trusted) { if (k.includes('\\r')) { trusted = true; out('\\x1b[2J\\x1b[H  user@example.com (Google AI Ultra)\\n' + '─'.repeat(40) + '\\n>\\n' + '─'.repeat(40) + '\\n'); } return; }
  typed += k;
  if (typed.includes('/usage') && k.includes('\\r')) out('└ Models & Quota\\n  Account: user@example.com\\nGEMINI MODELS\\n  Models within this group: Gemini 4 Neon, Gemini 4 Argon,\\n  Weekly Limit Remaining\\n    [████░] 91.07%\\n    Refreshes in 155h 44m\\n  Five Hour Limit Remaining\\n    [████░] 8.5%\\n    Refreshes in 4h 52m\\nCLAUDE AND GPT MODELS\\n  Models within this group: Claude Opus 5.5\\n  Weekly Limit Remaining\\n    [█████] 100.00%\\n    Quota available\\n  ↑/↓ Scroll · esc Close\\n');
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const api = await startApi({ TMUX_WEB_GEMINI_DIR: root, TMUX_WEB_AGY_BIN: fake, TMUX_WEB_AGY_DIR: path.join(dir, 'agy-usage') });
  try {
    let q = (await api.request('GET', '/api/usage')).body.gemini.quota;
    assert.equal(q.reading, true, 'the first answer starts a reading in the background');
    for (let i = 0; i < 60 && (q.reading || q.at == null); i++) { await delay(250); q = (await api.request('GET', '/api/usage')).body.gemini.quota; }
    const t = Math.floor(Date.now() / 1000);
    assert.deepEqual([q.error, q.plan], [null, 'Google AI Ultra']);
    assert.deepEqual(q.groups.map((g) => [g.name, g.about, g.buckets.map((b) => [b.window, b.left])]), [
      ['Gemini Models', 'Gemini 4 Neon, Gemini 4 Argon', [['weekly', 91.07], ['5h', 8.5]]],
      ['Claude and GPT Models', 'Claude Opus 5.5', [['weekly', 100]]],
    ]);
    assert.ok(Math.abs(q.groups[0].buckets[0].resetsAt - (t + 155 * 3600 + 44 * 60)) < 30);
    assert.equal(q.groups[1].buckets[0].resetsAt, null, 'quota available: nothing to refresh');
    const pid = +fs.readFileSync(pidFile, 'utf8');
    await delay(300);
    assert.throws(() => process.kill(pid, 0), 'agy was ended by its PID');
    assert.equal((await api.request('GET', '/api/sessions')).body.sessions.length, 0, 'the private tmux is not in the list');
  } finally { await api.stop(); }
});
