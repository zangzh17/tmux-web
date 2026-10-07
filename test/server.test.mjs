import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('session create, rename, and confirmed close require Access and preserve exact session identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-test-'));
  const socket = path.join(dir, 'api.sock');
  const tmuxSocket = `tmux-web-test-${process.pid}`;
  const wrapper = path.join(dir, 'tmux');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/tmux -L ${tmuxSocket} "$@"\n`, { mode: 0o700 });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  const certs = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => certs.listen(0, '127.0.0.1', resolve));
  const certsPort = certs.address().port;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'test-key' });
  const payload = b64({ iss: 'https://test.cloudflareaccess.com', aud: ['test-aud'], email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 60 });
  const data = `${header}.${payload}`;
  const token = `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  const server = spawn(process.execPath, [path.resolve('server.mjs')], {
    cwd: path.resolve('.'), stdio: 'ignore',
    env: { ...process.env, TMUX_WEB_API_SOCK: socket, TMUX_BIN: wrapper, TMUX_WEB_PREVIEW: '0',
      CF_ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', CF_ACCESS_AUD: 'test-aud',
      CF_ACCESS_CERTS_URL: `http://127.0.0.1:${certsPort}/certs`, ALLOWED_EMAILS: 'owner@example.com' },
  });
  const request = (method, body, extra = {}, endpoint = '/api/sessions') => new Promise((resolve, reject) => {
    const rawBody = body == null ? undefined : JSON.stringify(body);
    const headers = { host: 'localhost:8890', origin: 'http://localhost:8890', 'content-type': 'application/json',
      'cf-access-jwt-assertion': token, ...extra };
    if (rawBody != null) headers['content-length'] = Buffer.byteLength(rawBody);
    const req = http.request({ socketPath: socket, path: endpoint, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(rawBody);
  });

  try {
    for (let i = 0; !fs.existsSync(socket); i++) {
      assert.ok(i < 50, 'API did not start');
      await delay(100);
    }
    assert.equal((await request('POST', { name: 'new_project' }, { 'cf-access-jwt-assertion': '' })).status, 401);
    assert.equal((await request('POST', { name: 'bad:name' })).status, 400);
    assert.equal((await request('POST', { name: 'other' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('POST', { name: 'bad\n' })).status, 400);
    const created = await request('POST', { name: 'new_project' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'new_project');
    assert.match(created.body.id, /^\$\d+$/);
    assert.match(created.body.instance, /^\d+:\d+$/);
    assert.equal((await request('POST', { name: 'new_project' })).status, 409);
    const list = await request('GET');
    assert.equal(list.status, 200);
    assert.ok(list.body.sessions.some((s) => s.name === 'new_project' && s.id === created.body.id));

    const endpoint = `/api/sessions/${encodeURIComponent(created.body.id)}`;
    const change = (method, body, headers = {}) => request(method, { instance: created.body.instance, ...body }, headers, endpoint);
    const peer = await request('POST', { name: 'new_project_peer' });
    assert.equal(peer.status, 201);
    for (const method of ['PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { name: 'renamed' } : { confirmed: true };
      assert.equal((await change(method, body, { 'cf-access-jwt-assertion': '' })).status, 401, `${method} requires authentication`);
      assert.equal((await change(method, body, { origin: 'https://evil.example' })).status, 403);
      assert.equal((await change(method, body, { origin: '' })).status, 403);
      assert.equal((await change(method, body, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await request(method, body, {}, '/api/sessions/new_project')).status, 400);
    }
    for (const name of ['', 'bad:name', 'bad.name', 'bad\n', 'tab\tname', '-leading', 'a'.repeat(49)]) {
      assert.equal((await change('PATCH', { name })).status, 400, `reject unsafe rename ${JSON.stringify(name)}`);
    }
    assert.equal((await change('PATCH', { name: 'new_project_peer' })).status, 409);
    assert.equal((await change('DELETE', {})).status, 400);
    assert.equal((await change('DELETE', { confirmed: false })).status, 400);
    assert.equal((await change('DELETE', { confirmed: 'true' })).status, 400);

    const run = (args) => execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' }).trim();
    const pane = run(['display-message', '-p', '-t', created.body.id, '#{pane_id}']);
    run(['new-window', '-d', '-t', created.body.id, 'sleep 120']);
    assert.deepEqual(await change('PATCH', { name: '中文 工作' }), {
      status: 200, body: { id: created.body.id, instance: created.body.instance, name: '中文 工作' },
    });
    assert.equal(run(['display-message', '-p', '-t', created.body.id, '#{pane_id}']), pane, 'rename preserves active pane');
    assert.equal(run(['display-message', '-p', '-t', created.body.id, '#{session_windows}']), '2', 'rename preserves every window');
    assert.equal(run(['has-session', '-t', `=${created.body.id}`]), '', 'existing attach wrapper resolves stable ID');
    const renamed = await request('GET');
    assert.ok(renamed.body.sessions.some((s) => s.id === created.body.id && s.name === '中文 工作'));
    const reusedName = await request('POST', { name: 'new_project' });
    assert.equal(reusedName.status, 201);

    assert.deepEqual(await change('DELETE', { confirmed: true }), {
      status: 200, body: { id: created.body.id, closed: true },
    });
    const remaining = (await request('GET')).body.sessions;
    assert.ok(!remaining.some((s) => s.id === created.body.id), 'selected session and all its windows are gone');
    assert.ok(remaining.some((s) => s.id === peer.body.id), 'similar name session survives');
    assert.ok(remaining.some((s) => s.id === reusedName.body.id), 'new session using the old name survives');
    assert.equal((await change('DELETE', { confirmed: true })).status, 404);
    assert.equal((await change('PATCH', { name: 'gone' })).status, 404);
    assert.equal((await request('GET', null, {}, endpoint)).status, 405);

    run(['kill-server']);
    const replacement = await request('POST', { name: 'after_restart' });
    assert.equal(replacement.status, 201);
    assert.equal(replacement.body.id, created.body.id, 'a new tmux server reuses the original ID');
    assert.notEqual(replacement.body.instance, created.body.instance);
    assert.equal((await change('PATCH', { name: 'stale_tab_rename' })).status, 404);
    assert.equal((await change('DELETE', { confirmed: true })).status, 404);
    assert.ok((await request('GET')).body.sessions.some((s) => s.name === 'after_restart'), 'stale tab cannot alter or close a replacement session');
    assert.equal((await change('PATCH', { name: 'replacement_renamed', instance: replacement.body.instance })).status, 200);
  } finally {
    server.kill('SIGTERM');
    try { execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
    await new Promise((resolve) => certs.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
