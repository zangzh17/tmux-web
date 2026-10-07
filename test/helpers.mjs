// Shared scaffolding for API tests: a signing-key issuer, the API server on a private socket, and a private tmux server (-L).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };

export async function startApi(extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-test-')));
  const socket = path.join(dir, 'api.sock');
  const tmuxSocket = `tmux-web-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
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
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  // A signed Access token for `email` (null: a token without any email claim, like a service token).
  const mint = (email, claims = {}) => {
    const data = `${b64({ alg: 'RS256', kid: 'test-key' })}.${b64({ iss: 'https://test.cloudflareaccess.com', aud: ['test-aud'], ...(email === null ? {} : { email }), exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  };
  const token = mint('owner@example.com');
  const usersFile = path.join(dir, 'users.json'); // never the real ~/.config/tmux-web/users.json

  const env = { ...process.env, TMUX_WEB_API_SOCK: socket, TMUX_BIN: wrapper, TMUX_WEB_PREVIEW: '0',
    CF_ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', CF_ACCESS_AUD: 'test-aud',
    CF_ACCESS_CERTS_URL: `http://127.0.0.1:${certs.address().port}/certs`, ALLOWED_EMAILS: 'owner@example.com', TMUX_WEB_USERS: usersFile, ...extraEnv };
  delete env.TMUX; // never inherit the developer's own tmux client
  delete env.TMUX_PANE;
  const server = spawn(process.execPath, [path.resolve('server.mjs')], { cwd: path.resolve('.'), stdio: 'ignore', env });
  for (let i = 0; !fs.existsSync(socket); i++) {
    if (i >= 50) throw new Error('API did not start');
    await delay(100);
  }

  // `body` (optional) is sent as JSON, or as-is when it is a string; without it a POST sends `{}`.
  const request = (method, endpoint, extra = {}, body) => new Promise((resolve, reject) => {
    const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : method === 'POST' ? '{}' : undefined;
    // framed explicitly: node sends the body of a DELETE (or GET) unframed otherwise
    const headers = { host: 'localhost:8890', origin: 'http://localhost:8890', 'content-type': 'application/json', 'cf-access-jwt-assertion': token,
      ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...extra };
    const req = http.request({ socketPath: socket, path: endpoint, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  // The same as `request`, signed in as `email`.
  const requestAs = (email, method, endpoint, extra = {}, body) => request(method, endpoint, { 'cf-access-jwt-assertion': mint(email), ...extra }, body);
  // users.json for the server under test: an object (or raw text); the mtime is moved on every write so a change is always seen.
  let writes = 0;
  const writeUsers = (value) => {
    fs.writeFileSync(usersFile, typeof value === 'string' ? value : JSON.stringify(value));
    const t = new Date(Date.now() + 1000 * ++writes);
    fs.utimesSync(usersFile, t, t);
  };

  // The first command that starts the tmux server must not hold our stdout pipe open (it would never return), hence stdio:'ignore'.
  const tmux = (...args) => execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', env }).trim();
  const start = (name, ...command) => {
    execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, 'new-session', '-d', '-x', '100', '-y', '30', '-s', name, ...command], { stdio: 'ignore', env });
    return tmux('display-message', '-p', '-t', `=${name}:`, '#{session_id}'); // trailing colon: '=name' alone is not a valid target here
  };
  const stop = async () => {
    server.kill('SIGTERM');
    try { execFileSync('/usr/bin/tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server */ }
    fs.rmSync(path.join(os.tmpdir(), `tmux-${process.getuid()}`, tmuxSocket), { force: true });
    await new Promise((resolve) => certs.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, request, requestAs, mint, writeUsers, usersFile, tmuxSocket, tmux, start, stop };
}

export const sessionPath = (id, view, query = '') => `/api/sessions/${encodeURIComponent(id)}/${view}${query}`;
