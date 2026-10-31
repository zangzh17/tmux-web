import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi } from './helpers.mjs';

test('files: list a folder (or a session\'s), make, rename and delete entries', async () => {
  const api = await startApi();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-files-')));
  try {
    fs.mkdirSync(path.join(root, 'b-dir'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'file10'), '');
    fs.writeFileSync(path.join(root, 'file9'), '');
    fs.writeFileSync(path.join(root, '.hidden'), 'x');
    fs.symlinkSync(path.join(root, 'b-dir'), path.join(root, 'to-dir'));
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'broken'));
    const list = async (query) => api.request('GET', `/api/files${query}`);
    let res = await list(`?path=${encodeURIComponent(root)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.path, root);
    assert.equal(res.body.parent, path.dirname(root));
    assert.deepEqual(res.body.entries.map((e) => [e.name, e.type]),
      [['b-dir', 'dir'], ['to-dir', 'link-dir'], ['.hidden', 'file'], ['a.txt', 'file'], ['broken', 'link-broken'], ['file9', 'file'], ['file10', 'file']]);
    assert.equal(res.body.entries.find((e) => e.name === 'a.txt').size, 5);
    assert.equal(res.body.entries.find((e) => e.name === 'b-dir').size, null);
    assert.equal((await list(`?path=${encodeURIComponent(`${root}/b-dir/..`)}`)).body.path, root, 'normalised');
    assert.equal((await list('?path=/')).body.parent, null);
    // a session's directory, and home without anything
    const id = api.start('here', '-c', root, 'sleep 600');
    for (let i = 0; i < 20 && (await list(`?from=${encodeURIComponent(id)}`)).body.path !== root; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await list(`?from=${encodeURIComponent(id)}`)).body.path, root);
    assert.equal((await list('')).body.path, os.homedir());
    for (const q of ['?path=relative', '?from=here', `?path=${encodeURIComponent('/a\0b')}`]) assert.equal((await list(q)).status, 400, q);
    assert.equal((await list(`?path=${encodeURIComponent(path.join(root, 'nope'))}`)).status, 404);
    assert.equal((await list(`?path=${encodeURIComponent(path.join(root, 'a.txt'))}`)).status, 400, 'not a folder');

    const change = (body, extra = {}) => api.request('POST', '/api/files', extra, body);
    assert.deepEqual((await change({ op: 'mkdir', path: root, name: 'new folder' })).body, { ok: true });
    assert.ok(fs.statSync(path.join(root, 'new folder')).isDirectory());
    assert.equal((await change({ op: 'mkdir', path: root, name: 'new folder' })).status, 409);
    assert.equal((await change({ op: 'rename', path: root, name: 'a.txt', to: 'b.txt' })).status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'hello');
    assert.equal((await change({ op: 'rename', path: root, name: 'b.txt', to: 'file9' })).status, 409, 'never replaces');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'hello');
    assert.equal((await change({ op: 'rename', path: root, name: 'missing', to: 'x' })).status, 404);
    fs.writeFileSync(path.join(root, 'new folder', 'inside'), '');
    assert.equal((await change({ op: 'delete', path: root, name: 'new folder' })).status, 200, 'a folder with everything in it');
    assert.ok(!fs.existsSync(path.join(root, 'new folder')));
    assert.equal((await change({ op: 'delete', path: root, name: 'broken' })).status, 200, 'a link, not what it points to');
    assert.equal((await change({ op: 'delete', path: root, name: 'to-dir' })).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'b-dir')), 'deleting a link to a folder leaves the folder');
    for (const body of [{ op: 'mkdir', path: root, name: '../escape' }, { op: 'mkdir', path: root, name: '..' }, { op: 'delete', path: root, name: '' },
      { op: 'rename', path: root, name: 'b.txt', to: 'a/b' }, { op: 'chmod', path: root, name: 'b.txt' }, { op: 'mkdir', path: 'rel', name: 'x' }]) {
      assert.equal((await change(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await change({ op: 'mkdir', path: root, name: 'x' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await api.request('DELETE', '/api/files')).status, 405);
    // a scratch terminal can open in a folder from here
    const scratch = await api.request('POST', '/api/scratch', {}, { cwd: path.join(root, 'b-dir') });
    assert.equal(scratch.status, 201);
    assert.equal(scratch.body.path, path.join(root, 'b-dir'));
    assert.equal((await api.request('POST', '/api/scratch', {}, { cwd: path.join(root, 'nope') })).status, 404);
    assert.equal((await api.request('POST', '/api/scratch', {}, { cwd: 'rel' })).status, 400);
  } finally {
    await api.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
