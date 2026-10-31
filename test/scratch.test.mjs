import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApi, delay } from './helpers.mjs';

test('scratch terminals: opened in the session\'s directory, in no list, closed like a session, swept when left', async () => {
  const api = await startApi({ TMUX_WEB_SCRATCH_IDLE: '2' });
  try {
    const dir = fs.realpathSync(api.dir);
    const from = api.start('work', '-c', dir, 'sleep 600');
    const res = await api.request('POST', '/api/scratch', {}, { from });
    assert.equal(res.status, 201);
    assert.match(res.body.id, /^\$\d+$/);
    assert.match(res.body.name, /^scratch-[0-9a-f]{8}$/);
    assert.equal(res.body.path, dir);
    const where = () => api.tmux('display-message', '-p', '-t', res.body.id, '#{pane_current_path}');
    for (let i = 0; i < 20 && where() !== dir; i++) await delay(100); // the shell takes a moment to start there
    assert.equal(where(), dir);
    assert.equal(api.tmux('show-options', '-v', '-t', res.body.id, '@tmux_web_scratch'), '1');
    assert.equal(api.tmux('show-options', '-v', '-t', res.body.id, 'status'), 'off');
    const names = async () => (await api.request('GET', '/api/sessions?owner=all')).body.sessions.map((s) => s.name);
    assert.deepEqual(await names(), ['work'], 'no list shows it');
    // the terminal may attach to it like to any session of one's own
    const verify = await api.request('GET', '/verify', { 'x-forwarded-uri': `/term/ws?arg=${encodeURIComponent(res.body.id)}` });
    assert.equal(verify.status, 200);
    // closed like a session
    const closed = await api.request('DELETE', `/api/sessions/${encodeURIComponent(res.body.id)}`, {}, { confirmed: true, instance: res.body.instance });
    assert.deepEqual(closed.body, { id: res.body.id, closed: true });
    // without `from` (or one that does not exist) it opens at home
    const home = await api.request('POST', '/api/scratch', {}, {});
    assert.equal(home.status, 201);
    assert.equal((await api.request('POST', '/api/scratch', {}, { from: '$999' })).body.path, home.body.path);
    for (const from of ['work', 5, '$1;ls']) assert.equal((await api.request('POST', '/api/scratch', {}, { from })).status, 400, String(from));
    assert.equal((await api.request('POST', '/api/scratch', { origin: 'https://evil.example' }, {})).status, 403);
    assert.equal((await api.request('GET', '/api/scratch')).status, 405);
    // nobody attached for longer than TMUX_WEB_SCRATCH_IDLE (2 s here): the sweep ends them, and leaves real sessions alone
    const scratch = () => api.tmux('list-sessions', '-F', '#{@tmux_web_scratch}').split('\n').filter((v) => v === '1').length;
    assert.equal(scratch(), 2);
    for (let i = 0; i < 40 && scratch(); i++) await delay(250);
    assert.equal(scratch(), 0);
    assert.deepEqual(await names(), ['work']);
  } finally { await api.stop(); }
});

test('scratch terminals: at most 8 at a time', async () => {
  const api = await startApi();
  try {
    for (let i = 0; i < 8; i++) assert.equal((await api.request('POST', '/api/scratch', {}, {})).status, 201);
    assert.equal((await api.request('POST', '/api/scratch', {}, {})).status, 429);
  } finally { await api.stop(); }
});
