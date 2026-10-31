import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startApi } from './helpers.mjs';

// A stand-in for api.anthropic.com/api/oauth/usage: answers with `reply` and records what it was sent.
let anthropic;
let reply;
const asked = [];
let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-web-usage-'));
  anthropic = http.createServer((req, res) => {
    asked.push({ url: req.url, authorization: req.headers.authorization, beta: req.headers['anthropic-beta'] });
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise((resolve) => anthropic.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString();
// a fresh API with its own Claude login (`oauth`, or none) and saved samples
async function apiWith(name, { oauth, samples } = {}) {
  const credentials = path.join(dir, `${name}.credentials.json`);
  const saved = path.join(dir, `${name}.usage.json`);
  if (oauth) fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: oauth }));
  if (samples) fs.writeFileSync(saved, JSON.stringify({ samples }));
  asked.length = 0;
  const api = await startApi({ TMUX_WEB_CLAUDE_CREDENTIALS: credentials, TMUX_WEB_USAGE: saved, TMUX_WEB_USAGE_URL: `http://127.0.0.1:${anthropic.address().port}/api/oauth/usage` });
  return { api, saved };
}
const login = (extra = {}) => ({ accessToken: 'test-access-token', refreshToken: 'test-refresh-token', expiresAt: Date.now() + 3600_000, ...extra });

test('usage: the 5-hour and weekly limits of the Claude login, kept for the trend', async () => {
  const t = now();
  const fiveReset = t + 3 * 3600;
  const weekReset = t + 4 * 86400;
  reply = { status: 200, body: { five_hour: { utilization: 12.0, resets_at: iso(fiveReset) }, seven_day: { utilization: 31.5, resets_at: iso(weekReset) }, seven_day_opus: null } };
  const old = [
    [t - 9 * 86400, 1, 1, null, null], // past the week: not in the history
    [t - 2 * 86400 - 600, 5, 20, null, null], [t - 2 * 86400 - 300, 6, 21, null, null], [t - 2 * 86400 + 1200, 7, 22, null, null], // two half hours
    [t - 3600, 9, 30, null, null], [t - 1800, 10, 31, null, null], // the last 6 hours: every answer
  ];
  const { api, saved } = await apiWith('ok', { oauth: login(), samples: old });
  try {
    const res = await api.request('GET', '/api/usage');
    assert.equal(res.status, 200);
    assert.deepEqual(asked.map((a) => [a.url, a.authorization, a.beta]), [['/api/oauth/usage', 'Bearer test-access-token', 'oauth-2025-04-20']]);
    assert.equal(res.body.error, null);
    assert.deepEqual(res.body.fiveHour, { used: 12, resetsAt: fiveReset });
    assert.deepEqual(res.body.sevenDay, { used: 31.5, resetsAt: weekReset });
    assert.ok(Math.abs(res.body.at - t) <= 2 && Math.abs(res.body.now - t) <= 2);
    const history = res.body.history;
    assert.equal(history.length, 5, JSON.stringify(history));
    assert.ok(history.every((p) => p.length === 3) && history[0][0] > t - 7 * 86400, 'a week of [time, 5-hour, weekly]');
    assert.deepEqual(history.slice(-3).map((p) => p.slice(1)), [[9, 30], [10, 31], [12, 31.5]]);
    // asked again within 2 minutes: the last answer, without asking Anthropic
    assert.equal((await api.request('GET', '/api/usage')).body.fiveHour.used, 12);
    assert.equal(asked.length, 1);
    const kept = JSON.parse(fs.readFileSync(saved, 'utf8')).samples;
    assert.equal(kept.length, 6, 'older than 8 days dropped, the new answer added');
    assert.deepEqual(kept.at(-1).slice(1), [12, 31.5, fiveReset, weekReset]);
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(saved, 'utf8').includes('test-access-token'));
    assert.equal((await api.request('POST', '/api/usage')).status, 405);
  } finally { await api.stop(); }
});

test('usage: no login, an expired one, a refused one or a rate limit leave the last answer as it was', async () => {
  reply = { status: 200, body: { five_hour: { utilization: 50, resets_at: iso(now() + 60) } } };
  let { api } = await apiWith('none');
  try {
    const { now: when, ...body } = (await api.request('GET', '/api/usage')).body;
    assert.ok(Math.abs(when - now()) <= 2);
    assert.deepEqual(body, { at: null, error: 'not signed in', fiveHour: null, sevenDay: null, history: [] });
    assert.equal(asked.length, 0);
  } finally { await api.stop(); }

  const t = now();
  const last = [[t - 600, 40, 60, t + 3600, t + 86400]];
  ({ api } = await apiWith('expired', { oauth: login({ expiresAt: Date.now() - 1000 }), samples: last }));
  try {
    const body = (await api.request('GET', '/api/usage')).body;
    assert.equal(asked.length, 0, 'an expired login is not even tried (Claude Code refreshes it, not this)');
    assert.equal(body.error, 'login expired');
    assert.deepEqual([body.at, body.fiveHour, body.sevenDay], [t - 600, { used: 40, resetsAt: t + 3600 }, { used: 60, resetsAt: t + 86400 }]);
  } finally { await api.stop(); }

  reply = { status: 401, body: { error: 'invalid token' } };
  ({ api } = await apiWith('refused', { oauth: login(), samples: last }));
  try {
    const body = (await api.request('GET', '/api/usage')).body;
    assert.deepEqual([asked.length, body.error, body.fiveHour.used], [1, 'login expired', 40]);
  } finally { await api.stop(); }

  reply = { status: 429, headers: { 'retry-after': '600' }, body: { error: 'rate limited' } };
  ({ api } = await apiWith('limited', { oauth: login(), samples: last }));
  try {
    const body = (await api.request('GET', '/api/usage')).body;
    assert.deepEqual([asked.length, body.error, body.sevenDay.used], [1, 'rate limited', 60]);
  } finally { await api.stop(); }

  reply = { status: 200, body: { unrelated: true } };
  ({ api } = await apiWith('odd', { oauth: login(), samples: last }));
  try {
    const body = (await api.request('GET', '/api/usage')).body;
    assert.deepEqual([body.error, body.history.length], ['unreachable', 1], 'an answer without limits is not recorded');
  } finally { await api.stop(); }
});
