import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, sessionPath, delay } from './helpers.mjs';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
const pb = (...pairs) => Buffer.concat(pairs.map(([f, v]) => {
  if (typeof v === 'number') return Buffer.concat([varint(f * 8), varint(v)]);
  const body = Array.isArray(v) ? pb(...v) : Buffer.from(v);
  return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
}));
// agy's conversation with one message in it (an empty one has nothing to stash or fork: see agentFacts)
export function oneMessage(root, id) {
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'conversations', `${id}.db`));
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, status integer, metadata blob, error_details blob, step_payload blob)');
  const meta = pb([1, [[1, Math.floor(Date.now() / 1000) - 60]]], [35, 's0']);
  db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, ?)').run(meta, pb([1, 14], [4, 3], [5, [[1, [[1, Math.floor(Date.now() / 1000) - 60]]], [35, 's0']]], [19, [[2, 'hi']]]));
  db.close();
}

// Stash and fork with stand-ins: `fakeagy` plays agy (holds its conversation's presence lock, quits on /exit, says "Forked
// conversation." on /fork) and is also what resume/fork type (TMUX_WEB_AGY_BIN), writing its arguments to a file.
test('stash: quit agy, keep its start, resume it; fork: a new session sent /fork; nothing for a plain shell', async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/tmux-web-stash-'));
  const gem = path.join(base, 'gemini');
  fs.mkdirSync(path.join(gem, 'presence'), { recursive: true });
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const conv = 'aaaaaaaa-2222-4333-8444-555555555555';
  const lock = path.join(gem, 'presence', `${conv}.lock`);
  fs.writeFileSync(lock, '');
  oneMessage(gem, conv);
  const fake = path.join(base, 'fakeagy');
  const args = path.join(base, 'args');
  fs.writeFileSync(fake, `#!/bin/sh
echo "$@" >> '${args}'
[ "$1" = --lock ] && { exec 9<>"$2"; shift 2; }
printf '>\\n? for shortcuts\\n'
while IFS= read -r l; do
  case "$l" in */exit) exit 0 ;; */fork) echo "Forked conversation." ;; esac
done
`, { mode: 0o755 });
  const api = await startApi({ TMUX_WEB_GEMINI_DIR: gem, TMUX_WEB_GEMINI_COMMAND: '^fakeagy$', TMUX_WEB_CLAUDE_COMMAND: '^never$', TMUX_WEB_AGY_BIN: fake });
  try {
    const id = api.start('gem', 'bash', '-c', `cd '${work}' && exec -a fakeagy /bin/sh '${fake}' --lock '${lock}' --dangerously-skip-permissions --model 'Gemini 4 Neon' --print-timeout 3s`);
    await delay(400);
    const s = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === id);
    assert.equal(s.agent, 'gemini');

    // fork: a new session gem-fork in the same folder, given `agy --conversation <id>` with the safe flags, then /fork
    const forked = await api.request('POST', sessionPath(id, 'fork'), {}, { instance: s.instance });
    assert.equal(forked.status, 201, JSON.stringify(forked.body));
    assert.deepEqual([forked.body.name, forked.body.forked], ['gem-fork', true]);
    assert.equal(api.tmux('display-message', '-p', '-t', forked.body.id, '#{pane_current_path}'), work);
    assert.match(fs.readFileSync(args, 'utf8'), new RegExp(`--conversation ${conv} --dangerously-skip-permissions --model Gemini 4 Neon\\n`));
    assert.ok((await api.request('GET', '/api/sessions')).body.sessions.some((x) => x.id === id), 'the original is untouched');

    // stash: agy quits, its one-pane session closes, the entry can be listed, resumed (old name, old folder) and is then gone
    const stashed = await api.request('POST', sessionPath(id, 'stash'), {}, { instance: s.instance });
    assert.equal(stashed.status, 200, JSON.stringify(stashed.body));
    assert.equal(stashed.body.stash.agent, 'gemini');
    await delay(200);
    assert.ok(!(await api.request('GET', '/api/sessions')).body.sessions.some((x) => x.id === id), 'the session is closed');
    let list = (await api.request('GET', '/api/stash')).body.stash;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'gem');
    assert.equal(list[0].command, `${fake} --conversation ${conv} --dangerously-skip-permissions --model 'Gemini 4 Neon'`);
    // rename (the name Resume will use) and fork from the stash (a new session; the entry stays)
    assert.equal((await api.request('PATCH', `/api/stash/${list[0].id}`, {}, { name: 'bad/name' })).status, 400);
    assert.equal((await api.request('PATCH', `/api/stash/${list[0].id}`, {}, { name: 'gem two' })).status, 200);
    const sf = await api.request('POST', `/api/stash/${list[0].id}/fork`, {}, {});
    assert.equal(sf.status, 201, JSON.stringify(sf.body));
    assert.deepEqual([sf.body.name, sf.body.forked], ['gem two-fork', true]);
    list = (await api.request('GET', '/api/stash')).body.stash;
    assert.deepEqual(list.map((e) => e.name), ['gem two'], 'the entry stays, renamed');
    const resumed = await api.request('POST', `/api/stash/${list[0].id}/resume`, {}, {});
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
    assert.equal(resumed.body.name, 'gem two');
    await delay(500);
    assert.equal(api.tmux('display-message', '-p', '-t', resumed.body.id, '#{pane_current_path}'), work);
    assert.equal(fs.readFileSync(args, 'utf8').trim().split('\n').length, 4, 'started, forked, forked from the stash, resumed');
    list = (await api.request('GET', '/api/stash')).body.stash;
    assert.equal(list.length, 0);
    assert.equal((await api.request('POST', `/api/stash/${'0'.repeat(12)}/resume`, {}, {})).status, 404);
    assert.equal((await api.request('DELETE', `/api/stash/${'0'.repeat(12)}`, {}, {})).status, 404);
    assert.equal((await api.request('GET', `/api/stash/${'0'.repeat(12)}`)).status, 405);

    // a plain shell has nothing to stash or fork; a stale instance is refused
    const sh = api.start('sh', 'sh');
    const row = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === sh);
    assert.equal((await api.request('POST', sessionPath(sh, 'stash'), {}, { instance: row.instance })).status, 409);
    assert.equal((await api.request('POST', sessionPath(sh, 'fork'), {}, { instance: '1:2' })).status, 404);
  } finally { await api.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('switch: agy quits, its conversation is written out, claude starts in the same pane with that file to read', async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/tmux-web-switch-'));
  const gem = path.join(base, 'gemini');
  fs.mkdirSync(path.join(gem, 'presence'), { recursive: true });
  const conv = 'cccccccc-2222-4333-8444-555555555555';
  const lock = path.join(gem, 'presence', `${conv}.lock`);
  fs.writeFileSync(lock, '');
  oneMessage(gem, conv);
  const fake = path.join(base, 'fakeagy');
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = --lock ] && { exec 9<>"$2"; shift 2; }\nprintf '>\\n? for shortcuts\\n'\nwhile IFS= read -r l; do case "$l" in */exit) exit 0 ;; esac; done\n`, { mode: 0o755 });
  const args = path.join(base, 'claude-args');
  const claude = path.join(base, 'claude-stand-in');
  fs.writeFileSync(claude, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${args}'\n`, { mode: 0o755 });
  const handoffs = path.join(base, 'handoff');
  const api = await startApi({ TMUX_WEB_GEMINI_DIR: gem, TMUX_WEB_GEMINI_COMMAND: '^fakeagy$', TMUX_WEB_CLAUDE_COMMAND: '^never$', TMUX_WEB_CLAUDE_BIN: claude, TMUX_WEB_HANDOFF: handoffs });
  try {
    // agy as the pane's own program: refused (quitting it would end the session)
    const bare = api.start('bare', 'bash', '-c', `exec -a fakeagy /bin/sh '${fake}' --lock '${lock}'`);
    await delay(400);
    let row = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === bare);
    assert.equal((await api.request('POST', sessionPath(bare, 'switch'), {}, { instance: row.instance })).status, 409);
    api.tmux('kill-session', '-t', bare);
    // agy started from a shell
    const id = api.start('sw', 'bash', '--norc', '--noprofile', '-i');
    await delay(300);
    api.tmux('send-keys', '-t', id, '-l', `(exec -a fakeagy /bin/sh '${fake}' --lock '${lock}' --dangerously-skip-permissions)`);
    api.tmux('send-keys', '-t', id, 'Enter');
    await delay(600);
    row = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === id);
    assert.equal(row.agent, 'gemini');
    const r = await api.request('POST', sessionPath(id, 'switch'), {}, { instance: row.instance });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.agent, 'claude');
    const md = fs.readFileSync(r.body.handoff, 'utf8');
    assert.match(md, /^# Hand-off: sw/);
    assert.match(md, new RegExp(`conversations/${conv}\\.db`));
    assert.match(md, new RegExp(`agy --conversation ${conv}`));
    assert.match(md, /## User[^\n]*\n\nhi\n/);
    await delay(800);
    const argv = fs.readFileSync(args, 'utf8').trim().split('\n');
    assert.equal(argv[0], '--dangerously-skip-permissions', 'carried over from agy');
    assert.ok(argv[1].includes(r.body.handoff), argv[1]);
    assert.ok((await api.request('GET', '/api/sessions')).body.sessions.some((x) => x.id === id), 'the session stays');
  } finally { await api.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
