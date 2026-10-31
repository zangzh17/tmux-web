import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, sessionPath } from './helpers.mjs';

// `sleep` plays Claude: TMUX_WEB_CLAUDE_COMMAND matches the pane's current command, as 'claude' does for the real thing.
let api;
let id;
let cwd;
let projects;
let projectDir;
let sessionsDir;
before(async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-claude-'));
  projects = path.join(dir, 'projects');
  cwd = path.join(dir, 'work space.v1');
  fs.mkdirSync(cwd);
  projectDir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  sessionsDir = path.join(dir, 'sessions'); // Claude Code's own ~/.claude/sessions: one <pid>.json per running instance
  fs.mkdirSync(sessionsDir);
  api = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^sleep$', TMUX_WEB_CLAUDE_PROJECTS: projects, TMUX_WEB_CLAUDE_SESSIONS: sessionsDir });
  id = api.start('claude1', '-c', cwd, 'sleep 600');
  api.cleanup = dir;
});
after(async () => {
  await api?.stop();
  if (api?.cleanup) fs.rmSync(api.cleanup, { recursive: true, force: true });
});

const file = (name = 'x.jsonl') => path.join(projectDir, name);
const write = (lines, name) => fs.writeFileSync(file(name), lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''));
const append = (text, name) => fs.appendFileSync(file(name), text);
const transcript = (query = '') => api.request('GET', sessionPath(id, 'transcript', query));
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 6, 0, 0, tick++)).toISOString();
const user = (content, extra = {}) => ({ type: 'user', timestamp: stamp(), message: { role: 'user', content }, ...extra });
const assistant = (...content) => ({ type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content } });
const result = (content, extra = {}) => user([{ type: 'tool_result', tool_use_id: 't1', content, ...extra }]);
const tool = (name, input) => assistant({ type: 'tool_use', id: 't1', name, input });
const stripTs = (items) => items.map(({ ts, ...rest }) => rest);

test('transcript classifies every kind of record', async () => {
  const reminder = '<system-reminder>\nmind the gap\n</system-reminder>';
  write([
    { type: 'mode', mode: 'normal' },
    { type: 'attachment', attachment: { type: 'environment' } },
    user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    user('side question', { isSidechain: true }),
    user(`${reminder}\nplease fix \u001b[31mthe\u001b[0m bug`),
    user(reminder),
    assistant({ type: 'thinking', thinking: '', signature: 'sig' }),
    assistant({ type: 'text', text: 'Looking now.\n' }),
    assistant({ type: 'text', text: '   ' }),
    tool('Bash', { command: 'ls -la', description: 'list' }),
    tool('Read', { file_path: '/etc/hostname' }),
    tool('NotebookEdit', { notebook_path: '/a.ipynb' }),
    tool('Task', { description: 'explore', prompt: 'long prompt' }),
    tool('Skill', { skill: 'init' }),
    tool('WebSearch', { query: 'tmux web' }),
    tool('Grep', { pattern: 'foo.*bar' }),
    tool('WebFetch', { url: 'https://example.com' }),
    tool('ExitPlanMode', { plan: '1. do it' }),
    tool('Weird', { a: 1, b: [2] }),
    tool('AskUserQuestion', { questions: [{ question: 'Which one?', options: [] }, { question: 'And then?' }] }),
    result('total 0\nfile.txt\n'),
    result([{ type: 'text', text: 'hello' }, { type: 'image', source: {} }, { type: 'tool_reference', tool_name: 'X' }], { is_error: true }),
    result('\u001b[1mbold\u001b[0m \u001b[?25hdone'),
    user([{ type: 'text', text: 'see this' }, { type: 'image', source: {} }]),
    user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    user('<command-name>/clear</command-name>\n<command-args></command-args>'),
    user('<local-command-stdout>Set model to opus</local-command-stdout>'),
    user('<local-command-stdout></local-command-stdout>'),
    user('<local-command-stderr>boom</local-command-stderr>'),
    user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed</summary>\n</task-notification>'),
    user('[Request interrupted by user for tool use]'),
    user('This session is being continued from a previous conversation that ran out of context.\nSummary...'),
    user('flagged summary text', { isCompactSummary: true }),
  ]);
  const res = await transcript();
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.equal(res.body.session, 'claude1');
  assert.match(res.body.file, /^[\w.-]+$/, 'file names the jsonl without its extension');
  assert.equal(res.body.start, 0);
  assert.equal(res.body.total, res.body.items.length);
  assert.ok(res.body.items.every((i) => /^\d{4}-\d\d-\d\dT/.test(i.ts)), 'ts passes the record timestamp through');
  assert.deepEqual(stripTs(res.body.items), [
    { kind: 'user', text: 'please fix the bug' },
    { kind: 'assistant', text: 'Looking now.' },
    { kind: 'tool', name: 'Bash', text: 'ls -la' },
    { kind: 'tool', name: 'Read', text: '/etc/hostname' },
    { kind: 'tool', name: 'NotebookEdit', text: '/a.ipynb' },
    { kind: 'tool', name: 'Task', text: 'explore' },
    { kind: 'tool', name: 'Skill', text: 'init' },
    { kind: 'tool', name: 'WebSearch', text: 'tmux web' },
    { kind: 'tool', name: 'Grep', text: 'foo.*bar' },
    { kind: 'tool', name: 'WebFetch', text: 'https://example.com' },
    { kind: 'tool', name: 'ExitPlanMode', text: '1. do it' },
    { kind: 'tool', name: 'Weird', text: '{"a":1,"b":[2]}' },
    { kind: 'tool', name: 'AskUserQuestion', text: 'Which one?\nAnd then?' },
    { kind: 'result', text: 'total 0\nfile.txt', error: false },
    { kind: 'result', text: 'hello\n[image]\n[tool_reference]', error: true },
    { kind: 'result', text: 'bold done', error: false },
    { kind: 'user', text: 'see this\n[image]' },
    { kind: 'command', text: '/model opus' },
    { kind: 'command', text: '/clear' },
    { kind: 'notice', text: 'Set model to opus' },
    { kind: 'notice', text: 'boom' },
    { kind: 'notice', text: 'Background task completed: Background command "sleep" completed' },
    { kind: 'notice', text: 'Interrupted' },
    { kind: 'summary', text: 'This session is being continued from a previous conversation that ran out of context.\nSummary...' },
    { kind: 'summary', text: 'flagged summary text' },
  ]);
});

test('a typed slash command is kept twice (user text, then the command record) for the frontend to merge', async () => {
  write([
    user('/model opus'),
    user('<command-name>/model</command-name>\n<command-args>opus</command-args>'),
  ]);
  assert.deepEqual(stripTs((await transcript()).body.items), [
    { kind: 'user', text: '/model opus' },
    { kind: 'command', text: '/model opus' },
  ]);
});

test('transcript truncates tool text, results, and keeps long assistant text whole', async () => {
  const long = 'x'.repeat(1000);
  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  write([
    tool('Bash', { command: Array.from({ length: 10 }, (_, i) => `echo ${i}`).join('\n') }),
    tool('Bash', { command: long }),
    result(many),
    result('y'.repeat(9000)),
    result(Array.from({ length: 40 }, (_, i) => `ok ${i}`).join('\n')),
    assistant({ type: 'text', text: long }),
  ]);
  const { items } = (await transcript()).body;
  assert.equal(items[0].text, 'echo 0\necho 1\necho 2\necho 3\necho 4\necho 5…', '6 lines');
  assert.equal(items[1].text, `${'x'.repeat(400)}…`, '400 chars');
  assert.equal(items[2].text, `${many.split('\n').slice(0, 40).join('\n')}…`, '40 lines');
  assert.equal(items[3].text, `${'y'.repeat(4000)}…`, '4000 chars');
  assert.ok(!items[4].text.endsWith('…'), 'exactly 40 lines is not truncated');
  assert.equal(items[5].text, long);
});

test('transcript pages backwards with stable indexes', async () => {
  write(Array.from({ length: 12 }, (_, i) => user(`m${i}`)));
  const texts = (r) => r.body.items.map((i) => i.text);
  let res = await transcript('?count=5');
  assert.deepEqual([res.body.total, res.body.start, texts(res)], [12, 7, ['m7', 'm8', 'm9', 'm10', 'm11']]);
  res = await transcript('?before=7&count=5');
  assert.deepEqual([res.body.total, res.body.start, texts(res)], [12, 2, ['m2', 'm3', 'm4', 'm5', 'm6']]);
  res = await transcript('?before=2&count=5');
  assert.deepEqual([res.body.start, texts(res)], [0, ['m0', 'm1']]);
  res = await transcript('?before=0');
  assert.deepEqual([res.status, res.body.start, res.body.items], [200, 0, []]);
  res = await transcript('?before=9999&count=2');
  assert.deepEqual([res.body.start, texts(res)], [10, ['m10', 'm11']], 'before is clamped to total');
  res = await transcript('?after=10');
  assert.deepEqual([res.body.start, res.body.total, texts(res)], [10, 12, ['m10', 'm11']]);
  res = await transcript('?after=12');
  assert.deepEqual([res.body.start, res.body.items], [12, []]);
  res = await transcript('?after=9999');
  assert.deepEqual([res.body.start, res.body.items], [12, []], 'after is clamped to total');
  res = await transcript('?count=0');
  assert.equal(res.body.items.length, 1, 'count is at least 1');
  for (const bad of ['?before=x', '?after=-1', '?count=1.5', '?before=']) {
    assert.equal((await transcript(bad)).status, 400, bad);
  }

  write(Array.from({ length: 700 }, (_, i) => user(`n${i}`)));
  res = await transcript('?count=99999');
  assert.deepEqual([res.body.total, res.body.start, res.body.items.length], [700, 200, 500], 'count is capped at 500');
  res = await transcript();
  assert.deepEqual([res.body.start, res.body.items.length], [550, 150], 'default count is 150');
});

test('a half-written last line is ignored until it is complete', async () => {
  write([user('one'), user('two')]);
  const third = JSON.stringify(user('thrée 中文'));
  const whole = Buffer.from(third);
  const cut = whole.subarray(0, whole.indexOf('中') + 1); // ends inside a three-byte character
  fs.appendFileSync(file(), cut);
  let res = await transcript();
  assert.deepEqual([res.body.total, res.body.items.map((i) => i.text)], [2, ['one', 'two']]);
  res = await transcript();
  assert.equal(res.body.total, 2, 'a repeated read does not re-count or lose the partial bytes');
  fs.appendFileSync(file(), Buffer.concat([whole.subarray(cut.length), Buffer.from('\n')]));
  append(`${JSON.stringify(user('four'))}\n`);
  res = await transcript('?after=2');
  assert.deepEqual([res.body.start, res.body.total, res.body.items.map((i) => i.text)], [2, 4, ['thrée 中文', 'four']]);
  assert.deepEqual((await transcript('?count=2')).body.items.map((i) => i.text), ['thrée 中文', 'four']);
});

test('garbage lines are skipped, and a replaced file starts over', async () => {
  write(['not json', '{"truncated":', user('kept'), '', '[1,2]', 'null']);
  assert.deepEqual((await transcript()).body.items.map((i) => i.text), ['kept']);
  write([user('a'), user('b'), user('c'), user('d')]);
  assert.equal((await transcript()).body.total, 4);
  write([user('fresh')]);
  const res = await transcript();
  assert.deepEqual([res.body.total, res.body.items.map((i) => i.text)], [1, ['fresh']], 'a shorter rewrite resets the cache');
});

test('the most recently modified transcript in the pane directory is used', async () => {
  write([user('old')], 'old.jsonl');
  write([user('new')], 'new.jsonl');
  fs.utimesSync(file('old.jsonl'), 1_700_000_000, 1_700_000_000);
  fs.utimesSync(file('new.jsonl'), 1_800_000_000, 1_800_000_000);
  fs.writeFileSync(file('ignored.txt'), 'x');
  fs.utimesSync(file('ignored.txt'), 1_900_000_000, 1_900_000_000);
  assert.deepEqual((await transcript()).body.items.map((i) => i.text), ['new']);
  fs.utimesSync(file('old.jsonl'), 1_950_000_000, 1_950_000_000);
  assert.deepEqual((await transcript()).body.items.map((i) => i.text), ['old']);
  for (const name of ['old.jsonl', 'new.jsonl', 'ignored.txt', 'x.jsonl']) fs.rmSync(file(name));
  assert.equal((await transcript()).status, 404, 'no transcript files');
  fs.rmSync(projectDir, { recursive: true });
  assert.equal((await transcript()).status, 404, 'no project directory');
  fs.mkdirSync(projectDir, { recursive: true });
  write([user('back')]);
  assert.equal((await transcript()).status, 200);
});

test('transcript answers 404 for non-Claude panes and unknown IDs, and enforces ID and method rules', async () => {
  const other = api.start('plain', 'cat');
  assert.equal((await api.request('GET', sessionPath(other, 'transcript'))).status, 404, 'pane is not running Claude');
  assert.equal((await api.request('GET', sessionPath('$999', 'transcript'))).status, 404);
  assert.equal((await api.request('GET', '/api/sessions/claude1/transcript')).status, 400, 'a name is not an ID');
  assert.equal((await api.request('POST', sessionPath(id, 'transcript'))).status, 405);
  assert.equal((await api.request('GET', sessionPath(id, 'transcript'), { 'cf-access-jwt-assertion': '' })).status, 401);
  assert.equal((await api.request('GET', sessionPath(id, 'transcript', '?before=1'), { 'cf-access-jwt-assertion': 'garbage' })).status, 401);
});

test('two Claude panes in one directory each show their own conversation, never the other one', async () => {
  const uuidA = '11111111-1111-4111-8111-111111111111';
  const uuidB = '22222222-2222-4222-8222-222222222222';
  const idB = api.start('claude2', '-c', cwd, 'sleep 600');
  const info = (target) => api.tmux('display-message', '-p', '-t', target, '#{pane_pid} #{pane_id} #{session_name}').split(' ');
  const [pidA, paneA, nameA] = info(id);
  const [pidB, paneB, nameB] = info(idB);
  const record = (pid, pane, name, sessionId, extra = {}) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid: +pid, sessionId, cwd, startedAt: Date.now(), tmux: `${name}:@0.${pane}`, ...extra }));
  write([user('conversation A')], `${uuidA}.jsonl`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  write([user('conversation B')], `${uuidB}.jsonl`); // newer: what "the newest file in the directory" would pick for both panes
  const first = (r) => r.body.items.find((item) => item.kind === 'user')?.text;
  try {
    record(pidA, paneA, nameA, uuidA);
    record(pidB, paneB, nameB, uuidB);
    const a = await transcript();
    const b = await api.request('GET', sessionPath(idB, 'transcript'));
    assert.equal(a.status, 200); assert.equal(a.body.file, uuidA); assert.equal(first(a), 'conversation A');
    assert.equal(b.status, 200); assert.equal(b.body.file, uuidB); assert.equal(first(b), 'conversation B');

    // /clear in A: the record moves to a new conversation that has no file yet -> 404, not B's conversation
    record(pidA, paneA, nameA, '33333333-3333-4333-8333-333333333333');
    assert.equal((await transcript()).status, 404);
    record(pidA, paneA, nameA, uuidA);

    // a record that belongs to another tmux server (the same pane id, a process that is not under this pane) is ignored
    fs.rmSync(path.join(sessionsDir, `${pidA}.json`));
    fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: uuidB, cwd, startedAt: Date.now() + 1, tmux: `other:@0.${paneA}` }));
    const stranger = await transcript();
    assert.equal(stranger.status, 200); assert.equal(stranger.body.file, uuidB, 'no record of its own: the newest file of the directory, as before');
    fs.rmSync(path.join(sessionsDir, `${process.pid}.json`));

    // a half-written record is skipped, and so are files that are not <pid>.json (Claude keeps secrets next to them)
    fs.writeFileSync(path.join(sessionsDir, `${pidA}.json`), '{"pid":');
    fs.writeFileSync(path.join(sessionsDir, `${pidA}.deadbeef.key`), uuidA);
    assert.equal((await transcript()).body.file, uuidB);
  } finally {
    for (const n of fs.readdirSync(sessionsDir)) fs.rmSync(path.join(sessionsDir, n), { force: true });
    fs.rmSync(file(`${uuidA}.jsonl`), { force: true });
    fs.rmSync(file(`${uuidB}.jsonl`), { force: true });
  }
});

test('the session list says how full each Claude conversation is', async () => {
  const answer = (input, read, write, model = 'claude-opus-5-5', extra = {}) => ({ type: 'assistant', timestamp: stamp(), ...extra,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 999 } } });
  const line = (rec) => `${JSON.stringify(rec)}\n`;
  const context = async (query = '') => (await api.request('GET', `/api/sessions${query}`)).body.sessions.find((s) => s.id === id)?.context;
  const plain = api.start('notclaude', 'cat'); // not Claude: TMUX_WEB_CLAUDE_COMMAND is ^sleep$ here
  try {
    write([user('hi'), answer(10, 50_000, 2_000), answer(5, 1, 1, 'claude-opus-5-5', { isSidechain: true })], 'ctx.jsonl');
    assert.deepEqual(await context(), { tokens: 52_010, window: 1_000_000, model: 'claude-opus-5-5' }, 'input + cache read + cache write; a subagent does not count');
    append(line(answer(100, 150_000, 0, 'claude-opus-4-8')), 'ctx.jsonl');
    assert.deepEqual(await context(), { tokens: 150_100, window: 200_000, model: 'claude-opus-4-8' }, 'an older model has 200k');
    append(line(result('x'.repeat(700_000))), 'ctx.jsonl');
    assert.equal((await context())?.tokens, 150_100, 'found behind a long tool result (the end of the file is read, more as needed)');
    append(line(answer(0, 250_000, 0, 'claude-opus-4-8')), 'ctx.jsonl');
    assert.equal((await context())?.window, 1_000_000, 'past 200k the window must be 1M');
    append('{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":7', 'ctx.jsonl');
    assert.equal((await context())?.tokens, 250_000, 'a half-written last line is not read');
    append(`\n${line(user('summary of the conversation', { isCompactSummary: true }))}`, 'ctx.jsonl');
    assert.deepEqual(await context(), { compacted: true }, 'compacted: unknown until Claude answers again');
    append(line(answer(3, 20_000, 0)), 'ctx.jsonl');
    assert.equal((await context())?.tokens, 20_003);
    assert.equal(await context('?preview=0'), null, 'the light list reads no transcript');
    assert.equal((await api.request('GET', '/api/sessions')).body.sessions.find((s) => s.id === plain)?.context, null, 'not Claude: none');
  } finally {
    fs.rmSync(file('ctx.jsonl'), { force: true });
    api.tmux('kill-session', '-t', plain);
  }
});
