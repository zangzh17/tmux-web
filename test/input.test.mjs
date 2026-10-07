import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, delay, sessionPath } from './helpers.mjs';

// A fake Claude TUI: raw stdin, bracketed paste enabled, every received chunk appended to a log. Its process is `node`,
// so TMUX_WEB_CLAUDE_COMMAND='^node$' makes it count as Claude, as 'claude' does for the real thing.
let api;
let dir;
let claude; // { id, instance, log }
let plain; // a `cat` pane: not Claude
let busyPane; // { id, screen: path } a node pane that prints whatever is written to its screen file
let startEditor; // starts a fake with a Claude-style input box that really edits (C-u, BSpace)
before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tmux-web-input-'));
  const script = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const log = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdin.on('data', (d) => fs.appendFileSync(log, d.toString('base64') + '\\n'));
fs.writeFileSync(log + '.ready', 'ready');
setInterval(() => {}, 1000);
`);
  const projects = path.join(dir, 'projects');
  const work = path.join(dir, 'busy work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(projects, work.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  fs.writeFileSync(path.join(projects, work.replace(/[^A-Za-z0-9]/g, '-'), 'c.jsonl'),
    `${JSON.stringify({ type: 'user', timestamp: '2026-10-06T00:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`);
  const screenScript = path.join(dir, 'screen.mjs');
  fs.writeFileSync(screenScript, `import fs from 'node:fs';
let last;
setInterval(() => {
  let now;
  try { now = fs.readFileSync(process.argv[2], 'utf8'); } catch { return; }
  if (now !== last) { last = now; process.stdout.write('\\x1b[2J\\x1b[H' + now.replace(/\\n/g, '\\r\\n')); }
}, 50);
`);
  api = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^node$', TMUX_WEB_INPUT_SETTLE_MS: '30', TMUX_WEB_CLAUDE_PROJECTS: projects });
  const log = path.join(dir, 'claude.log');
  const id = api.start('claude1', '-c', dir, process.execPath, script, log);
  for (let i = 0; !fs.existsSync(`${log}.ready`); i++) { assert.ok(i < 100, 'fake Claude did not start'); await delay(50); }
  await delay(300); // tmux has read the bracketed-paste request
  const info = (await api.request('GET', '/api/sessions')).body.sessions.find((s) => s.id === id);
  claude = { id, instance: info.instance, log };
  busyPane = { id: api.start('busy1', '-c', work, process.execPath, screenScript, path.join(dir, 'screen.txt')), screen: path.join(dir, 'screen.txt') };
  const editorScript = path.join(dir, 'fake-editor.mjs');
  fs.writeFileSync(editorScript, `import fs from 'node:fs';
const [base, mode, ...rest] = process.argv.slice(2);
let input = rest.join(' ').replace(/\\\\n/g, '\\n');
let paste = false;
const rule = '\u2500'.repeat(40);
function draw() {
  const rows = input === '' ? ['\u276f Try "something to do"'] : input.split('\\n').map((l, i) => (i ? '  ' : '\u276f ') + l);
  const ask = mode === 'ask' ? ['Bash command', '  echo hi', 'Do you want to proceed?', ' \u276f 1. Yes', '   2. No'] : [];
  process.stdout.write('\\x1b[2J\\x1b[H' + [...ask, rule, ...rows, rule, '  ? for shortcuts'].join('\\r\\n'));
}
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(base + '.keys', Buffer.from(chunk).toString('base64') + '\\n');
  for (const tok of chunk.match(/\\x1b\\[200~|\\x1b\\[201~|[\\s\\S]/g)) {
    if (tok === '\\x1b[200~') paste = true;
    else if (tok === '\\x1b[201~') paste = false;
    else if (paste) input += tok === '\\r' ? '\\n' : tok;
    else if (tok === '\\r') { fs.appendFileSync(base + '.sent', JSON.stringify(input) + '\\n'); input = ''; }
    else if (mode === 'stuck') continue; // ignores every edit
    else if (tok === '\\x15') input = input.slice(0, input.lastIndexOf('\\n') + 1);
    else if (tok === '\\x7f') input = input.slice(0, -1);
  }
  draw();
});
draw();
fs.writeFileSync(base + '.ready', 'ready');
`);
  // helper: a fresh editor pane with the given mode and leftover text
  startEditor = async (name, mode, leftover = '') => {
    const base = path.join(dir, `${name}.log`);
    const id = api.start(name, '-c', dir, process.execPath, editorScript, base, mode, leftover);
    for (let i = 0; !fs.existsSync(`${base}.ready`); i++) { assert.ok(i < 100, 'fake editor did not start'); await delay(50); }
    await delay(300);
    const info = (await api.request('GET', '/api/sessions')).body.sessions.find((s) => s.id === id);
    return { id, instance: info.instance, base };
  };
  const catId = api.start('plain1', 'cat');
  plain = { id: catId, instance: (await api.request('GET', '/api/sessions')).body.sessions.find((s) => s.id === catId).instance };
});
after(async () => {
  await api?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const received = () => (fs.existsSync(claude.log)
  ? Buffer.concat(fs.readFileSync(claude.log, 'utf8').split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64'))).toString('utf8') : '');
const reset = () => fs.rmSync(claude.log, { force: true });
// Wait until the program has received `want` bytes (or is clearly never going to), then return what it got.
async function settled(want, timeout = 3000) {
  for (let t = 0; want !== undefined && t < timeout; t += 25) {
    if (received().length >= want.length) break;
    await delay(25);
  }
  await delay(120); // anything extra that was wrongly sent would show up now
  return received();
}
const input = (body, extra = {}, target = claude, method = 'POST') => api.request(method, sessionPath(target.id, 'input'), extra, body === undefined ? undefined : { instance: target.instance, ...body });
const PASTE = (t) => `\x1b[200~${t}\x1b[201~`;

test('single-line text is pasted as one bracketed paste and then submitted with Enter', async () => {
  reset();
  const res = await input({ text: 'hello claude' });
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(await settled(`${PASTE('hello claude')}\r`), `${PASTE('hello claude')}\r`);
});

test('multi-line text keeps its line feeds inside the paste, with tabs, unicode, and trailing blank lines trimmed', async () => {
  reset();
  const res = await input({ text: 'line one\r\n\tindented 中文 ✻\r\nline three  \n\n \r\n' });
  assert.equal(res.status, 200);
  const want = `${PASTE('line one\n\tindented 中文 ✻\nline three')}\r`;
  assert.equal(await settled(want), want);
});

test('control characters are stripped so pasted text cannot end the bracketed paste', async () => {
  reset();
  const res = await input({ text: 'a\x1b[201~rm -rf /\x1b[200~b\x07c\x00d\x7fe\x85f\x9bg\x0bh\x0ci' });
  assert.equal(res.status, 200);
  const got = await settled();
  assert.equal(got, `${PASTE('a[201~rm -rf /[200~bcdefghi')}\r`);
  assert.equal(got.split('\x1b[201~').length, 2, 'exactly one paste terminator: the one tmux added');
  assert.equal(got.split('\x1b').length, 3, 'the only escapes are the two paste markers');
});

test('empty, whitespace-only, control-only and oversize text are rejected and nothing is delivered', async () => {
  reset();
  for (const text of ['', '   ', '\n\n\t \r\n', '\x1b\x07\x00']) {
    assert.equal((await input({ text })).status, 400, `reject ${JSON.stringify(text)}`);
  }
  assert.equal((await input({ text: 'a'.repeat(20001) })).status, 400, 'over 20000 characters');
  for (const text of [5, null, ['a'], { a: 1 }, true]) assert.equal((await input({ text })).status, 400, `reject text ${JSON.stringify(text)}`);
  assert.equal(await settled(), '');
});

test('exactly one of text and key is required, and the instance must be well-formed', async () => {
  reset();
  assert.equal((await input({ text: 'x', key: 'Enter' })).status, 400);
  assert.equal((await input({})).status, 400);
  for (const instance of [undefined, 5, '', '12', 'a:b', '1:2\n', '1:2:3']) {
    const res = await api.request('POST', sessionPath(claude.id, 'input'), {}, { instance, text: 'x' });
    assert.equal(res.status, 400, `reject instance ${JSON.stringify(instance)}`);
  }
  assert.equal(await settled(), '');
});

test('every allowlisted key delivers what tmux sends for it', async () => {
  const bytes = { Enter: '\r', Escape: '\x1b', Tab: '\t', BTab: '\x1b[Z', 'C-u': '\x15', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', y: 'y', n: 'n' };
  for (const [key, want] of Object.entries(bytes)) {
    reset();
    const res = await input({ key });
    assert.deepEqual([res.status, res.body], [200, { ok: true }], key);
    assert.equal(await settled(want), want, `key ${key}`);
  }
  for (const key of ['Up', 'Down', 'Left', 'Right']) {
    reset();
    assert.equal((await input({ key })).status, 200);
    assert.match(await settled('\x1b[A'), new RegExp(`^\\x1b[\\[O]${{ Up: 'A', Down: 'B', Right: 'C', Left: 'D' }[key]}$`), `key ${key}`);
  }
});

test('keys outside the allowlist are rejected and nothing is delivered', async () => {
  reset();
  for (const key of ['C-c', 'C-d', 'Enter;ls', 'F1', 'enter', 'a', '6', ' ', '', 'Enter Enter', '-l', 'BSpace', 5, null, ['Enter']]) {
    assert.equal((await input({ key })).status, 400, `reject key ${JSON.stringify(key)}`);
  }
  assert.equal(await settled(), '');
});

test('a stale instance, an unknown session or a malformed ID never receives input', async () => {
  reset();
  const stale = await api.request('POST', sessionPath(claude.id, 'input'), {}, { instance: '1:1', text: 'for the old tab' });
  assert.deepEqual([stale.status, stale.body], [404, { error: 'session not found' }]);
  assert.equal((await api.request('POST', sessionPath(claude.id, 'input'), {}, { instance: '1:1', key: 'Enter' })).status, 404);
  assert.equal((await api.request('POST', sessionPath('$9999', 'input'), {}, { instance: claude.instance, text: 'x' })).status, 404);
  assert.equal((await api.request('POST', sessionPath('claude1', 'input'), {}, { instance: claude.instance, text: 'x' })).status, 400, 'a name is not an ID');
  assert.equal((await api.request('POST', '/api/sessions/%E0%A4%A/input', {}, { instance: claude.instance, text: 'x' })).status, 400);
  assert.equal(await settled(), '');
});

test('a pane that is not running Claude answers 409 and gets nothing', async () => {
  const res = await input({ text: 'hi' }, {}, plain);
  assert.deepEqual([res.status, res.body], [409, { error: 'no Claude in this pane' }]);
  assert.equal((await input({ key: 'Enter' }, {}, plain)).status, 409);
  await delay(150);
  assert.ok(!api.tmux('capture-pane', '-p', '-t', plain.id).includes('hi'), 'cat never saw the text');
});

test('input requires a token, a matching Origin, a JSON body and the POST method', async () => {
  reset();
  const want = { text: 'no way' };
  assert.equal((await input(want, { 'cf-access-jwt-assertion': '' })).status, 401);
  assert.equal((await input(want, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await input(want, { origin: '' })).status, 403);
  assert.equal((await input(want, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await api.request('POST', sessionPath(claude.id, 'input'), {}, '{not json')).status, 400);
  assert.equal((await api.request('POST', sessionPath(claude.id, 'input'), {}, '[1]')).status, 400);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await input(undefined, {}, claude, method)).status, 405, method);
  assert.equal((await api.request('GET', sessionPath(claude.id, 'input'))).status, 405);
  assert.equal(await settled(), '');
});

test('concurrent sends arrive as complete pastes and Enters, never interleaved', async () => {
  reset();
  const first = 'first '.repeat(300);
  const second = 'second\nmessage';
  const [a, b, c] = await Promise.all([input({ text: first }), input({ text: second }), input({ key: 'Escape' })]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  // Requests race to the server, so their order is not fixed; each one must still arrive whole.
  const units = [`${PASTE(first.trim())}\r`, `${PASTE(second)}\r`, '\x1b'];
  const got = await settled(units.join(''));
  assert.equal(got.length, units.join('').length);
  const parts = got.match(/\x1b\[200~[\s\S]*?\x1b\[201~\r|\x1b/g);
  assert.equal(parts.join(''), got, 'nothing outside whole pastes and the Escape');
  assert.deepEqual([...parts].sort(), [...units].sort());
});

test('history?screen=1 returns only the visible screen', async () => {
  const sh = api.start('screen1', 'sh');
  api.tmux('send-keys', '-t', sh, `i=1; while [ $i -le 80 ]; do printf 'ROW%03d\\n' $i; i=$((i+1)); done`, 'Enter');
  let full;
  for (let i = 0; i < 50; i++) {
    full = await api.request('GET', sessionPath(sh, 'history'));
    if (full.body.text?.includes('ROW080')) break;
    await delay(100);
  }
  assert.ok(full.body.text.includes('ROW001'), 'the default call includes scrollback');
  const screen = await api.request('GET', sessionPath(sh, 'history', '?screen=1&lines=5000'));
  assert.equal(screen.status, 200);
  assert.equal(screen.body.id, sh);
  assert.ok(screen.body.text.includes('ROW080') && !screen.body.text.includes('ROW001'), 'earliest rows are not on the screen');
  assert.ok(screen.body.text.split('\n').length <= 30, 'at most the 30 visible rows');
  assert.equal((await api.request('GET', sessionPath('$9999', 'history', '?screen=1'))).status, 404);
  assert.equal((await api.request('GET', sessionPath('screen1', 'history', '?screen=1'))).status, 400);
});

test('transcript reports busy and asking from what Claude Code shows on screen, and only then', async () => {
  const show = async (text, marker) => {
    fs.writeFileSync(busyPane.screen, text);
    for (let i = 0; i < 60 && !api.tmux('capture-pane', '-p', '-t', busyPane.id).includes(marker); i++) await delay(50);
    assert.ok(api.tmux('capture-pane', '-p', '-t', busyPane.id).includes(marker), 'the fake screen is up');
    return (await api.request('GET', sessionPath(busyPane.id, 'transcript'))).body;
  };
  // the three spinner shapes seen from Claude Code (2.1.291 prints the first two, older versions the third)
  const working = await show('\u273b Effecting\u2026 (7s \u00b7 \u2193 557 tokens)\n\u276f \n', 'Effecting');
  assert.deepEqual([working.busy, working.asking], [true, false]);
  assert.equal(working.total, 1, 'the transcript itself is unaffected');
  assert.equal((await show('\u00b7 Enchanting\u2026 (0s \u00b7 thinking)\n', 'Enchanting')).busy, true);
  // the first ~2 s of a real turn show only the bare verb, with no timer yet
  for (const glyph of ['\u273b', '\u00b7', '*', '\u2722', '\u2736', '\u273d']) {
    assert.equal((await show(`${glyph} Creating\u2026\n\u276f \n`, 'Creating')).busy, true, `bare spinner ${glyph}`);
  }
  assert.equal((await show('\u273b Pondering\u2026 (12s \u00b7 esc to interrupt)\n', 'Pondering')).busy, true);
  assert.equal((await show('ESC TO INTERRUPT in capitals\n', 'ESC TO')).busy, true, 'case-insensitive');
  // a finished turn, and ordinary text that merely looks similar, are not busy
  const done = await show('\u273b Worked for 5s \u00b7 done 5:55 AM\n\u276f \n', 'Worked for');
  assert.deepEqual([done.busy, done.asking], [false, false]);
  assert.equal((await show('It took 12s (about a dozen) to finish\n', 'dozen')).busy, false);
  assert.equal((await show('Loading\u2026 the data is ready\n\u25cf Creating a file\u2026 done\n', 'ready')).busy, false, 'ordinary text with an ellipsis');
  // a permission prompt
  const ask = await show('Bash command\n  echo hi\nDo you want to proceed?\n \u276f 1. Yes\n   2. No\n', 'proceed');
  assert.deepEqual([ask.busy, ask.asking], [false, true]);
  const idle = await show('\u273b Done.\n> \n? for shortcuts\n', 'Done.');
  assert.deepEqual([idle.busy, idle.asking], [false, false]);
  assert.deepEqual(Object.keys(idle).sort(), ['asking', 'busy', 'file', 'id', 'items', 'session', 'start', 'total']);
  // no extra field on the 404 paths
  const other = await api.request('GET', sessionPath(plain.id, 'transcript'));
  assert.equal(other.status, 404);
  assert.ok(!('busy' in other.body));
});

// ---- leftovers in the input box (Claude Code restores an interrupted prompt there)
const sent = (e) => (fs.existsSync(`${e.base}.sent`) ? fs.readFileSync(`${e.base}.sent`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const keysSeen = (e) => (fs.existsSync(`${e.base}.keys`)
  ? Buffer.concat(fs.readFileSync(`${e.base}.keys`, 'utf8').split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64'))).toString('latin1') : '');
const post = (e, body) => api.request('POST', sessionPath(e.id, 'input'), {}, { instance: e.instance, ...body });

test('a message is not glued onto text left in the input box', async () => {
  for (const [name, leftover] of [['left1', 'old restored prompt'], ['left2', 'first\\nsecond\\nthird\\nfourth'], ['left3', `${'long '.repeat(40)}end`]]) {
    const e = await startEditor(name, 'normal', leftover);
    const res = await post(e, { text: 'new message' });
    assert.equal(res.status, 200, name);
    await delay(300);
    assert.deepEqual(sent(e), ['new message'], `${name}: only the new text was submitted`);
  }
});

test('an empty input box (placeholder showing) gets no clearing keys', async () => {
  const e = await startEditor('empty1', 'normal');
  assert.equal((await post(e, { text: 'hello' })).status, 200);
  await delay(300);
  assert.deepEqual(sent(e), ['hello']);
  const keys = keysSeen(e);
  assert.ok(!keys.includes('\x15') && !keys.includes('\x7f'), 'no C-u or BSpace on an empty box');
  assert.ok(!keys.includes('\x03'), 'never Ctrl-C, whose second press quits Claude');
});

test('a permission prompt is left alone: the text goes in as sent, nothing is cleared', async () => {
  const e = await startEditor('ask1', 'ask', 'half typed');
  assert.equal((await post(e, { text: 'because' })).status, 200);
  await delay(300);
  const keys = keysSeen(e);
  assert.ok(!keys.includes('\x15') && !keys.includes('\x7f'), 'no clearing keys while a prompt is waiting');
});

test('a box that will not clear does not hang the request, and the keys sent are bounded', async () => {
  const e = await startEditor('stuck1', 'stuck', 'cannot remove me');
  const t0 = Date.now();
  assert.equal((await post(e, { text: 'still delivered' })).status, 200);
  assert.ok(Date.now() - t0 < 4000, 'returns promptly');
  await delay(300);
  assert.equal(keysSeen(e).split('\x15').length - 1 <= 3 * 4, true, 'at most three rounds of clearing');
  assert.equal(sent(e).length, 1, 'the message was still submitted');
});
