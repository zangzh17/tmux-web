import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, delay, sessionPath } from './helpers.mjs';

let api;
let id;
before(async () => {
  api = await startApi();
  id = api.start('hist', 'sh');
});
after(async () => { await api?.stop(); });

const history = (query = '') => api.request('GET', sessionPath(id, 'history', query));

test('history returns scrollback text, joins wrapped lines, and trims trailing whitespace', async () => {
  // The marker only appears contiguously in the program's output, never in the echoed command line.
  api.tmux('send-keys', '-t', id, `printf 'MARK%s\\n' 12345; printf '%0250d\\n' 7; printf 'pad   \\n\\n\\n'`, 'Enter');
  let res;
  for (let i = 0; i < 40; i++) {
    res = await history();
    if (res.body.text?.includes('MARK12345') && res.body.text.includes('0'.repeat(249) + '7')) break;
    await delay(100);
  }
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  const lines = res.body.text.split('\n');
  assert.ok(lines.some((l) => /^(?:\$ )?MARK12345$/.test(l)), 'marker is printed as a line of its own (the prompt may precede it)');
  assert.ok(lines.includes('0'.repeat(249) + '7'), 'a 250-column line wrapped over a 100-column pane comes back as one line (-J)');
  assert.ok(lines.includes('pad'), 'trailing spaces trimmed');
  assert.ok(!res.body.text.endsWith('\n') && !/[ \t]$/m.test(res.body.text), 'no trailing blank lines or whitespace');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(res.body.text), 'control characters stripped');
});

test('history accepts a lines limit and falls back to the default for nonsense', async () => {
  for (const lines of ['1', '5000', '999999', '0', 'abc', '-3']) {
    assert.equal((await history(`?lines=${lines}`)).status, 200, `lines=${lines}`);
  }
});

test('history rejects names, unknown IDs, other methods, and missing credentials', async () => {
  assert.equal((await api.request('GET', '/api/sessions/hist/history')).status, 400, 'a name is not an ID');
  assert.equal((await api.request('GET', '/api/sessions/%240%3Bls/history')).status, 400);
  assert.equal((await api.request('GET', sessionPath('$999', 'history'))).status, 404);
  assert.equal((await api.request('POST', sessionPath(id, 'history'))).status, 405);
  assert.equal((await api.request('DELETE', sessionPath(id, 'history'))).status, 405);
  assert.equal((await api.request('GET', sessionPath(id, 'history'), { 'cf-access-jwt-assertion': '' })).status, 401);
  assert.equal((await api.request('GET', `/api/sessions/${encodeURIComponent(id)}`)).status, 405, 'plain session route is unchanged');
});
