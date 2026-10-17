import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApi } from './helpers.mjs';

test('display preferences are kept per person and per device kind', async () => {
  const api = await startApi({ ALLOWED_EMAILS: 'owner@example.com,other@example.com' });
  try {
    assert.deepEqual((await api.request('GET', '/api/prefs')).body, { prefs: {} });
    let res = await api.request('PUT', '/api/prefs', {}, { prefs: { 'phone.fs': '15', 'tablet.readScale': '2.2', 'phone.view': 'read' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.prefs, { 'phone.fs': '15', 'tablet.readScale': '2.2', 'phone.view': 'read' });
    res = await api.request('PUT', '/api/prefs', {}, { prefs: { 'phone.view': 'term', 'tablet.readScale': null } });
    assert.deepEqual(res.body.prefs, { 'phone.fs': '15', 'phone.view': 'term' });
    assert.deepEqual((await api.request('GET', '/api/prefs')).body.prefs, { 'phone.fs': '15', 'phone.view': 'term' });
    // somebody else starts empty
    assert.deepEqual((await api.requestAs('other@example.com', 'GET', '/api/prefs')).body, { prefs: {} });
    assert.equal(fs.statSync(path.join(api.dir, 'prefs.json')).mode & 0o777, 0o600);
    // unknown keys, odd values, other origins and methods are refused, and nothing is stored
    for (const prefs of [{ 'phone.color': 'red' }, { 'watch.fs': '12' }, { 'phone.fs': 15 }, { 'phone.fs': '<b>' }, { 'phone.fs': 'x'.repeat(17) }, []]) {
      assert.equal((await api.request('PUT', '/api/prefs', {}, { prefs })).status, 400, JSON.stringify(prefs));
    }
    assert.equal((await api.request('PUT', '/api/prefs', { origin: 'https://evil.example' }, { prefs: { 'phone.fs': '9' } })).status, 403);
    assert.equal((await api.request('POST', '/api/prefs', {}, { prefs: {} })).status, 405);
    assert.deepEqual((await api.request('GET', '/api/prefs')).body.prefs, { 'phone.fs': '15', 'phone.view': 'term' });
  } finally { await api.stop(); }
});
