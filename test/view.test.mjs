import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startApi } from './helpers.mjs';

test('view: a path (absolute, ~, or relative to a session) is resolved and told what kind of file it is', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-view-')));
  const api = await startApi({ HOME: root }); // ~ is this folder
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(root, 'page.html'), '<p>x</p>');
    fs.writeFileSync(path.join(root, 'pic.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n');
    fs.writeFileSync(path.join(root, 'notes'), 'plain words, no extension\n');
    fs.writeFileSync(path.join(root, 'blob'), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(root, 'data.csv'), 'a,b\n1,2\n');
    const view = async (p, from) => api.request('GET', `/api/files/view?path=${encodeURIComponent(p)}${from ? `&from=${encodeURIComponent(from)}` : ''}`);
    let res = await view(path.join(root, 'docs', 'README.md'));
    assert.equal(res.status, 200);
    assert.deepEqual({ ...res.body, mtime: 0 }, { type: 'file', path: path.join(root, 'docs', 'README.md'), name: 'README.md', dir: path.join(root, 'docs'), size: 5, mtime: 0, kind: 'markdown', ext: 'md', home: root });
    assert.equal((await view('~/page.html')).body.kind, 'html');
    assert.equal((await view('~/page.html')).body.path, path.join(root, 'page.html'));
    assert.equal((await view('pic.PNG')).body.kind, 'image', 'relative to home without a session; the extension in any case');
    assert.equal((await view('Makefile')).body.kind, 'text');
    assert.equal((await view('notes')).body.kind, 'text', 'no extension: looked at');
    assert.equal((await view('blob')).body.kind, 'binary');
    assert.equal((await view('data.csv')).body.kind, 'csv');
    assert.deepEqual((await view('~')).body, { type: 'dir', path: root, home: root });
    assert.equal((await view(`${root}/docs/../page.html`)).body.path, path.join(root, 'page.html'), 'normalised');
    // relative to the session's own directory
    const id = api.start('here', '-c', path.join(root, 'docs'), 'sleep 600');
    for (let i = 0; i < 20 && (await view('README.md', id)).status !== 200; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await view('README.md', id)).body.path, path.join(root, 'docs', 'README.md'));
    assert.equal((await view('README.md')).status, 404, 'not in home');
    assert.equal((await view('/dev/null')).status, 400, 'not a regular file');
    for (const q of ['', '?path=', `?path=${encodeURIComponent('a\0b')}`]) assert.equal((await api.request('GET', `/api/files/view${q}`)).status, 400, q);
    assert.equal((await api.request('POST', '/api/files/view')).status, 405);
  } finally {
    await api.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw: the bytes, never cached or sniffed, sandboxed, as text or a download when asked, one byte range', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-raw-')));
  const api = await startApi();
  // the shared helper parses JSON and drops the headers; this one keeps both, and the raw bytes
  const raw = (query, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(api.dir, 'api.sock'), path: `/api/files/raw${query}`, method,
      headers: { host: 'localhost:8890', 'cf-access-jwt-assertion': api.mint('owner@example.com'), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const page = path.join(root, 'my page.html');
    fs.writeFileSync(page, '<script>alert(1)</script>');
    const q = (p, extra = '') => `?path=${encodeURIComponent(p)}${extra}`;
    let res = await raw(q(page));
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '<script>alert(1)</script>');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.headers['cache-control'], /private/);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /^sandbox allow-scripts/);
    assert.doesNotMatch(res.headers['content-security-policy'], /allow-same-origin/);
    assert.equal(res.headers['content-disposition'], "inline; filename*=UTF-8''my%20page.html");
    assert.equal((await raw(q(page, '&text=1'))).headers['content-type'], 'text/plain; charset=utf-8');
    assert.match((await raw(q(page, '&download=1'))).headers['content-disposition'], /^attachment;/);
    // a byte range (iOS will not play a video without them), from the end, and one past the end
    const video = path.join(root, 'clip.mp4');
    fs.writeFileSync(video, '0123456789');
    res = await raw(q(video), { headers: { range: 'bytes=2-5' } });
    assert.equal(res.status, 206);
    assert.equal(res.body.toString(), '2345');
    assert.equal(res.headers['content-range'], 'bytes 2-5/10');
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal((await raw(q(video), { headers: { range: 'bytes=-3' } })).body.toString(), '789');
    assert.equal((await raw(q(video), { headers: { range: 'bytes=7-' } })).body.toString(), '789');
    const pdf = path.join(root, 'a.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4');
    res = await raw(q(pdf));
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['content-security-policy'], undefined, 'a sandboxed PDF would get no viewer');
    assert.match((await raw(q(pdf, '&text=1'))).headers['content-security-policy'], /^sandbox/);
    assert.equal((await raw(q(video), { headers: { range: 'bytes=20-' } })).status, 416);
    res = await raw(q(video), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], '10');
    assert.equal(res.body.length, 0);
    assert.equal((await raw(q(path.join(root, 'empty.txt')))).status, 404);
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    assert.equal((await raw(q(path.join(root, 'empty.txt')))).body.length, 0);
    for (const bad of [q('relative.txt'), q(root), '']) assert.equal((await raw(bad)).status, 400, bad);
    assert.equal((await raw(q(page), { method: 'POST' })).status, 405);
  } finally {
    await api.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
