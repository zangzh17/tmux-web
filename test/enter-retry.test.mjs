import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi, sessionPath, delay } from './helpers.mjs';

// A stand-in TUI (named claude for the API) that draws an input box between two rules and swallows the FIRST Enter, as agy
// now and then did: the message must still be sent (the API sees it left in the box and presses Enter again), and only once.
test('input: an Enter the TUI missed is pressed again, and a message ending in \\ is still sent', async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/tmux-web-enter-'));
  const tui = path.join(base, 'claude');
  const log = path.join(base, 'sent');
  fs.writeFileSync(tui, `#!/usr/bin/env python3
import os, sys, termios, tty
fd = sys.stdin.fileno(); tty.setraw(fd)
buf, enters = '', 0
def draw():
    sys.stdout.write('\\x1b[2J\\x1b[H' + '─' * 40 + '\\r\\n> ' + buf + '\\r\\n' + '─' * 40 + '\\r\\n'); sys.stdout.flush()
draw()
while True:
    data = os.read(fd, 4096).decode('utf-8', 'replace').replace('\\x1b[200~', '').replace('\\x1b[201~', '')
    for ch in data:
        if ch == '\\r':
            enters += 1
            if enters == 1: continue
            if buf.endswith('\\\\'): buf = buf[:-1] + '\\n'; continue
            if buf: open('${log}', 'a').write(buf + '\\n')
            buf = ''
        elif ch in '\\x15\\x7f': buf = ''
        elif ch >= ' ' or ch == '\\n': buf += ch
    draw()
`, { mode: 0o755 });
  const api = await startApi({ TMUX_WEB_CLAUDE_COMMAND: '^claude$', TMUX_WEB_INPUT_SETTLE_MS: '200' });
  try {
    const id = api.start('t', 'bash', '-c', `exec -a claude python3 '${tui}'`);
    await delay(600);
    const s = (await api.request('GET', '/api/sessions')).body.sessions.find((x) => x.id === id);
    assert.equal(s.agent, 'claude');
    assert.equal((await api.request('POST', sessionPath(id, 'input'), {}, { instance: s.instance, text: 'hello there' })).status, 200);
    assert.equal((await api.request('POST', sessionPath(id, 'input'), {}, { instance: s.instance, text: 'ends in a backslash \\\\' })).status, 200);
    await delay(300);
    assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), ['hello there', 'ends in a backslash \\\\ ']);
  } finally { await api.stop(); fs.rmSync(base, { recursive: true, force: true }); }
});
