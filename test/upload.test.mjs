import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startApi } from './helpers.mjs';

// A tar of `files` ({ 'name': 'content' }) made by GNU tar in a scratch folder; `extra` are more tar arguments.
function tarOf(api, files, extra = []) {
  const src = fs.mkdtempSync(path.join(api.dir, 'src-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, name), content);
  }
  return execFileSync('tar', ['-cf', '-', '-C', src, ...extra, ...Object.keys(files).map((n) => n.split('/')[0]).filter((n, i, a) => a.indexOf(n) === i)]);
}
const octet = { 'content-type': 'application/octet-stream' };

async function upload(api, tar, top, as = 'owner@example.com', piece = 4096) {
  const call = (...args) => api.requestAs(as, ...args);
  const start = await call('POST', '/api/uploads', {}, { size: tar.length });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const { id } = start.body;
  for (let at = 0; at < tar.length; at += piece) {
    const res = await call('PUT', `/api/uploads/${id}?offset=${at}`, octet, tar.subarray(at, at + piece));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.received, Math.min(tar.length, at + piece));
  }
  return { id, done: await call('POST', `/api/uploads/${id}/done`, {}, { top }) };
}

test('files and folders are uploaded in pieces and unpacked into a new folder', async () => {
  const api = await startApi();
  try {
    const tar = tarOf(api, { 'notes 1.txt': 'hello\n', 'proj/a/b.txt': 'deep\n', 'proj/c.md': '# c\n', '图片.png': Buffer.alloc(9000, 7) });
    const { done } = await upload(api, tar, ['proj', 'notes 1.txt', '图片.png']);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const { dir, paths } = done.body;
    assert.equal(path.dirname(dir), path.join(api.dir, 'uploads'));
    assert.match(path.basename(dir), /^\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.deepEqual(paths, ['proj', 'notes 1.txt', '图片.png'].map((n) => path.join(dir, n)));
    assert.equal(fs.readFileSync(path.join(dir, 'proj/a/b.txt'), 'utf8'), 'deep\n');
    assert.equal(fs.statSync(path.join(dir, '图片.png')).size, 9000);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.join(api.dir, 'uploads', '.parts')), []); // the packed upload is gone
  } finally { await api.stop(); }
});

test('a piece out of place is refused with where the upload stands, and the upload can go on from there', async () => {
  const api = await startApi({ ALLOWED_EMAILS: 'owner@example.com,other@example.com' });
  try {
    const tar = tarOf(api, { 'x.bin': Buffer.alloc(5000, 1) });
    const { id } = (await api.request('POST', '/api/uploads', {}, { size: tar.length })).body;
    assert.equal((await api.request('PUT', `/api/uploads/${id}?offset=0`, octet, tar.subarray(0, 4096))).status, 200);
    let res = await api.request('PUT', `/api/uploads/${id}?offset=0`, octet, tar.subarray(0, 4096)); // sent twice
    assert.deepEqual([res.status, res.body], [409, { received: 4096 }]);
    // finishing early is refused too
    assert.equal((await api.request('POST', `/api/uploads/${id}/done`, {}, {})).status, 409);
    // more than declared
    res = await api.request('PUT', `/api/uploads/${id}?offset=4096`, octet, Buffer.concat([tar.subarray(4096), Buffer.alloc(512)]));
    assert.equal(res.status, 413);
    assert.equal((await api.request('PUT', `/api/uploads/${id}?offset=4096`, octet, tar.subarray(4096))).status, 200);
    // somebody else cannot touch it
    assert.equal((await api.requestAs('other@example.com', 'POST', `/api/uploads/${id}/done`, {}, {})).status, 404);
    // nor can another site
    assert.equal((await api.request('POST', `/api/uploads/${id}/done`, { origin: 'https://evil.example' }, {})).status, 403);
    assert.equal((await api.request('PUT', `/api/uploads/${id}?offset=0`, { ...octet, origin: 'https://evil.example' }, tar.subarray(0, 512))).status, 403);
    assert.equal((await api.request('POST', `/api/uploads/${id}/done`, {}, {})).status, 200);
    assert.equal((await api.request('POST', `/api/uploads/${id}/done`, {}, {})).status, 404); // only once
  } finally { await api.stop(); }
}, { timeout: 30000 });

test('links, names outside the folder, bad sizes and unknown ids are refused', async () => {
  const api = await startApi({ ALLOWED_EMAILS: 'owner@example.com,other@example.com', TMUX_WEB_UPLOAD_MAX_MB: '1' });
  try {
    const src = fs.mkdtempSync(path.join(api.dir, 'link-'));
    fs.writeFileSync(path.join(src, 'real'), 'x');
    fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
    const linked = execFileSync('tar', ['-cf', '-', '-C', src, 'real', 'link']);
    let { done } = await upload(api, linked, []);
    assert.deepEqual([done.status, done.body], [400, { error: 'only files and folders can be uploaded' }]);
    fs.mkdirSync(path.join(src, 'in'));
    const escaping = execFileSync('tar', ['-cPf', '-', '-C', path.join(src, 'in'), '../real']);
    ({ done } = await upload(api, escaping, []));
    assert.deepEqual([done.status, done.body], [400, { error: 'invalid file names' }]);
    assert.deepEqual(fs.readdirSync(path.join(api.dir, 'uploads')).filter((n) => n !== '.parts'), []); // nothing left behind
    for (const size of [0, 100, 1025, '2048', 2 ** 21]) {
      assert.equal((await api.request('POST', '/api/uploads', {}, { size })).status, size === 2 ** 21 ? 413 : 400, String(size));
    }
    assert.equal((await api.request('PUT', '/api/uploads/0123456789abcdef01234567?offset=0', octet, Buffer.alloc(512))).status, 404);
    assert.equal((await api.request('PUT', '/api/uploads/nope?offset=0', octet, Buffer.alloc(512))).status, 404);
    assert.equal((await api.request('GET', '/api/uploads')).status, 405);
    // cancel
    const { id } = (await api.request('POST', '/api/uploads', {}, { size: 2048 })).body;
    assert.equal((await api.requestAs('other@example.com', 'DELETE', `/api/uploads/${id}`)).status, 404);
    assert.equal((await api.request('DELETE', `/api/uploads/${id}`)).status, 200);
    assert.equal((await api.request('PUT', `/api/uploads/${id}?offset=0`, octet, Buffer.alloc(512))).status, 404);
  } finally { await api.stop(); }
});

test('a piece forwarded chunked (no Content-Length) is counted as it arrives, and too much is refused and undone', async () => {
  const api = await startApi();
  // a PUT written in two parts with Transfer-Encoding: chunked, as a proxy may forward it
  const chunked = (endpoint, parts) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(api.dir, 'api.sock'), path: endpoint, method: 'PUT', headers: {
      host: 'localhost:8890', origin: 'http://localhost:8890', 'content-type': 'application/octet-stream', 'cf-access-jwt-assertion': api.mint('owner@example.com') } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    for (const p of parts) req.write(p);
    req.end();
  });
  try {
    const tar = tarOf(api, { 'a.txt': Buffer.alloc(3000, 65) });
    const { id } = (await api.request('POST', '/api/uploads', {}, { size: tar.length })).body;
    let res = await chunked(`/api/uploads/${id}?offset=0`, [tar.subarray(0, 1000), tar.subarray(1000, 2048)]);
    assert.deepEqual([res.status, res.body], [200, { received: 2048 }]);
    res = await chunked(`/api/uploads/${id}?offset=2048`, [tar.subarray(2048), Buffer.alloc(512)]); // 512 bytes too many
    assert.equal(res.status, 413);
    res = await chunked(`/api/uploads/${id}?offset=2048`, [tar.subarray(2048)]); // nothing of the refused piece was kept
    assert.deepEqual([res.status, res.body], [200, { received: tar.length }]);
    const done = await api.request('POST', `/api/uploads/${id}/done`, {}, { top: ['a.txt'] });
    assert.equal(fs.readFileSync(done.body.paths[0], 'utf8'), 'A'.repeat(3000));
  } finally { await api.stop(); }
});
