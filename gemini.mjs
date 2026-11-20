// Gemini through the Antigravity CLI (`agy`): its conversations, read from the CLI's own files, for the Read view, the session
// cards and the spend analysis. Nothing here writes to those files or talks to Google.
//
// agy keeps one SQLite database per conversation, ~/.gemini/antigravity-cli/conversations/<uuid>.db (WAL mode), with a
// `steps` table: one row per step, `idx` counting from 0, `step_type`, `status`, `error_details` and the step itself as a
// protobuf (`step_payload`, its field 5 repeated as `metadata`). There is no schema to go by; the fields used here were read
// off agy 1.5 (the CLI also logs a few steps as text, which names them):
//   step types   14 user input (19.2 the text), 15 model response (20.1 the reply, 20.3 its thinking, 20.7 the tool calls:
//                1 id, 2 name, 3 arguments as JSON), 132 a tool's result (5.4 the call, 140.2.1 the output, 148.3 a background
//                command's output, 31.2 an error), 23 a context summary, 101 an injected reminder (not shown)
//   status       3 done, 4 invalid, 5 cleared, 6 cancelled, 7 error; 0-2 and 8-10 not finished (8 generating, 9 waiting
//                for the user's approval)
//   metadata     1 created (seconds), 9 the generation's model_usage: 1 model (a number, see GEMINI_MODELS), 2 input tokens
//                (not cached), 3 output tokens (thinking included), 5 cached input tokens, 9 thinking, 10 response;
//                35 the step's own id (a changed id at a known index means the conversation was rewound)
// Which conversation a pane shows: the agy process under the pane keeps presence/<uuid>.lock of its conversation open the whole
// time (the database itself only while it works), which follows /new, --conversation and resuming (/proc/<pid>/fd); failing
// that, the CLI's own "last conversation per directory".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GEMINI_COMMAND = new RegExp(process.env.TMUX_WEB_GEMINI_COMMAND || '^(?:agy|antigravity|gemini)$', 'i');
export const GEMINI_DIR = process.env.TMUX_WEB_GEMINI_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CONVERSATIONS = path.join(GEMINI_DIR, 'conversations');
const PRESENCE = path.join(GEMINI_DIR, 'presence');
const SUMMARIES = path.join(GEMINI_DIR, 'conversation_summaries.db');
const LAST_CONVERSATIONS = path.join(GEMINI_DIR, 'cache', 'last_conversations.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// node:sqlite (Node 22) prints an ExperimentalWarning once; it is loaded only when there is a Gemini conversation to read.
let sqlite = null;
async function openDb(file) {
  if (!sqlite) {
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => (/sqlite/i.test(String(warning)) ? undefined : emit.call(process, warning, ...rest));
    try { sqlite = await import('node:sqlite'); } finally { process.emitWarning = emit; }
  }
  return new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 });
}
function withDb(db, task) { try { return task(db); } finally { try { db.close(); } catch { /* closed */ } } }

// ---- protobuf without a schema: a message is a list of [field, value], value a number (varint) or a Buffer (length-delimited)
function fields(buf) {
  const out = [];
  let i = 0;
  const n = buf.length;
  const varint = () => {
    let r = 0;
    let m = 1;
    let b;
    do {
      if (i >= n) throw new RangeError('truncated');
      b = buf[i++];
      r += (b & 127) * m;
      m *= 128;
    } while (b & 128);
    return r;
  };
  while (i < n) {
    const key = varint();
    const f = Math.floor(key / 8);
    const w = key % 8;
    if (w === 0) out.push([f, varint()]);
    else if (w === 2) { const len = varint(); if (i + len > n) throw new RangeError('truncated'); out.push([f, buf.subarray(i, i + len)]); i += len; }
    else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new RangeError('wire type');
  }
  return out;
}
const msg = (v) => { if (!Buffer.isBuffer(v)) return []; try { return fields(v); } catch { return []; } };
const one = (m, f) => m.find((e) => e[0] === f)?.[1];
const many = (m, f) => m.filter((e) => e[0] === f).map((e) => e[1]);
const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');
const num = (v) => (typeof v === 'number' ? v : 0);
const at = (m, ...fieldPath) => { let cur = m; for (const f of fieldPath.slice(0, -1)) cur = msg(one(cur, f)); return one(cur, fieldPath.at(-1)); };
const buf = (v) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));

const FINAL = new Set([3, 4, 5, 6, 7, 11, 12]);
const WAITING = 9;

// ---- models and prices. The model is a number in the usage record; these were matched against the model each run was
// started with. TMUX_WEB_GEMINI_MODELS (JSON {"1530": "gemini-4-neon-xhigh"}) adds or corrects numbers.
const GEMINI_MODELS = {
  1319: 'gemini-3.8-flash-medium', 1320: 'gemini-3.8-flash-low', 1418: 'gemini-4-argon-medium', 1526: 'gemini-4-hydrogen-medium',
  1532: 'gemini-4-neon-high', 1533: 'gemini-4-neon-medium', 1534: 'gemini-4-neon-low',
};
try { Object.assign(GEMINI_MODELS, JSON.parse(process.env.TMUX_WEB_GEMINI_MODELS || '{}')); } catch { /* ignored */ }
export const geminiModelName = (n) => GEMINI_MODELS[n] || (n ? `gemini-model-${n}` : 'gemini');
// $ per million tokens [from (unix time), input, output (thinking included), cached input], the list prices published for
// Google's API (Gemini 4 Argon doubles on 2026-12-01, 3.8 Flash on 2027-01-01). Anything not listed is priced as Neon.
const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
const GEMINI_PRICES = [
  [/neon|carbon|orchestrator/, [[0, 3, 15, 0.15]]],
  [/hydrogen/, [[0, 1.5, 7.5, 0.075]]],
  [/argon/, [[0, 2, 10, 0.1], [D(2026, 12, 1), 4, 20, 0.2]]],
  [/flash-lite/, [[0, 0.3, 2.5, 0.03]]],
  [/flash/, [[0, 0.75, 3.75, 0.075], [D(2027, 1, 1), 1.5, 7.5, 0.15]]],
  [/claude-opus/, [[0, 4, 20, 0.2]]],
  [/claude-sonnet/, [[0, 2, 10, 0.1]]],
];
const cents = (v) => Math.round(v * 1e7) / 1e7;
// one generation -> [input $, cached input $, response $, thinking $, tokens]
export function geminiCost(model, t, u) {
  const table = GEMINI_PRICES.find(([re]) => re.test(model))?.[1] || GEMINI_PRICES[0][1];
  const [, pin, pout, pread] = table.filter((p) => p[0] <= t).at(-1) || table[0];
  const think = Math.min(u.output, u.thinking);
  const k = 1e-6;
  return [u.input * pin * k, u.cached * pread * k, (u.output - think) * pout * k, think * pout * k].map(cents).concat(u.input + u.cached + u.output);
}
function usageOf(meta) {
  const raw = one(meta, 9);
  if (!Buffer.isBuffer(raw)) return null;
  const u = msg(raw);
  const output = num(one(u, 3));
  const input = num(one(u, 2));
  if (!output && !input) return null;
  return { model: num(one(u, 1)), input, cached: num(one(u, 5)), output, thinking: num(one(u, 9)) };
}

// ---- which conversation a pane shows
const childrenOf = async (pid) => {
  try { return (await fs.promises.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
};
async function openConversations(pid) {
  let names;
  try { names = await fs.promises.readdir(`/proc/${pid}/fd`); } catch { return []; }
  const found = new Set();
  await Promise.all(names.map(async (fd) => {
    try {
      const target = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`);
      const dir = path.dirname(target);
      const m = dir === PRESENCE ? /^([0-9a-f-]{36})\.lock$/i.exec(path.basename(target)) : dir === CONVERSATIONS ? /^([0-9a-f-]{36})\.db$/i.exec(path.basename(target)) : null;
      if (m && UUID.test(m[1])) found.add(m[1]);
    } catch { /* gone */ }
  }));
  return [...found];
}
let lastConversations = { at: 0, map: {} };
async function lastConversationOf(cwd) {
  if (Date.now() - lastConversations.at > 3000) {
    let map = {};
    try { const v = JSON.parse(await fs.promises.readFile(LAST_CONVERSATIONS, 'utf8')); if (isObject(v)) map = v; } catch { /* none */ }
    lastConversations = { at: Date.now(), map };
  }
  const id = lastConversations.map[cwd];
  return typeof id === 'string' && UUID.test(id) ? id : null;
}
// The pane's agy (the pane's own process or one under it, three levels at most) and the conversation it has open: the main
// one when it also has subagents' open (those have a parent), else the most recently written.
export async function geminiPaneConversation(panePid, cwd) {
  let level = [panePid];
  const ids = new Set();
  for (let depth = 0; depth < 4 && level.length && !ids.size; depth++) {
    for (const pid of level) for (const id of await openConversations(pid)) ids.add(id);
    if (ids.size) break;
    level = (await Promise.all(level.map(childrenOf))).flat().slice(0, 64);
  }
  if (!ids.size) { const id = cwd ? await lastConversationOf(cwd) : null; return id ? { id, guessed: true } : null; }
  if (ids.size === 1) return { id: [...ids][0] };
  const info = await summaries();
  const scored = await Promise.all([...ids].map(async (id) => ({ id, parent: !!info.get(id)?.parent, mtime: (await dbSignature(id)).mtime })));
  scored.sort((a, b) => a.parent - b.parent || b.mtime - a.mtime);
  return { id: scored[0].id };
}

// size and time of a conversation's database and its WAL: agy writes the WAL, so the database file alone hardly changes
async function dbSignature(id) {
  const base = path.join(CONVERSATIONS, `${id}.db`);
  const [db, wal] = await Promise.all([fs.promises.stat(base).catch(() => null), fs.promises.stat(`${base}-wal`).catch(() => null)]);
  if (!db) return { sig: '', mtime: 0, exists: false };
  return { sig: `${db.ino}:${db.size}:${db.mtimeMs}:${wal?.size ?? -1}:${wal?.mtimeMs ?? 0}`, mtime: Math.max(db.mtimeMs, wal?.mtimeMs || 0), exists: true };
}

// Titles, directories and parents of conversations, from agy's own index (conversation_summaries.db), read at most every 10 s.
let summaryCache = { at: 0, map: new Map() };
export async function summaries() {
  if (Date.now() - summaryCache.at < 10_000) return summaryCache.map;
  const map = new Map();
  try {
    const db = await openDb(SUMMARIES);
    withDb(db, () => {
      for (const r of db.prepare('SELECT conversation_id AS id, title, preview, workspace_uris AS ws, parent_conversation_id AS parent FROM conversation_summaries').all()) {
        let cwd = '';
        const first = String(r.ws || '').split(/[\s,]+/).map((s) => s.replace(/^\[?"?|"?\]?$/g, '')).find((s) => s.startsWith('file://'));
        if (first) { try { cwd = decodeURIComponent(new URL(first).pathname); } catch { /* odd */ } }
        map.set(String(r.id), { title: String(r.title || '').trim().slice(0, 120), preview: String(r.preview || '').trim().split('\n')[0].slice(0, 120), cwd, parent: String(r.parent || '') });
      }
    });
  } catch { /* no index yet */ }
  summaryCache = { at: Date.now(), map };
  return map;
}

// ---- a conversation as the Read view's items: { kind, text, ts, name?, error? }, the same kinds as Claude's (see server.mjs)
const tidy = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
const clip = (s, maxLines, maxChars) => {
  const rows = s.split('\n');
  let out = rows.length > maxLines ? rows.slice(0, maxLines).join('\n') : s;
  let cut = rows.length > maxLines;
  if (out.length > maxChars) { out = out.slice(0, maxChars).replace(/[\ud800-\udbff]$/, ''); cut = true; }
  return cut ? `${out}…` : out;
};
const TOOL_KEYS = ['CommandLine', 'command', 'AbsolutePath', 'Path', 'TargetFile', 'path', 'file_path', 'Query', 'query', 'Url', 'url', 'Pattern', 'pattern', 'Prompt', 'prompt', 'Message', 'message', 'Task', 'toolSummary'];
function toolText(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { return clip(tidy(raw), 6, 400); }
  if (!isObject(input)) return clip(tidy(raw), 6, 400);
  const key = TOOL_KEYS.find((k) => input[k] != null && input[k] !== '');
  const v = key ? input[key] : input;
  return clip(tidy(typeof v === 'string' ? v : JSON.stringify(v)), 6, 400);
}
const iso = (meta) => { const t = num(at(meta, 1, 1)); return t ? new Date(t * 1000).toISOString() : null; };
const resultBody = (s) => s.replace(/^(?:Created At: [^\n]*\n)?(?:Completed At: [^\n]*\n)?/, '');

// One step -> zero or more items. `pendingResult`: a tool still running long after the conversation moved on.
function stepItems(r, pendingResult) {
  const p = msg(buf(r.step_payload));
  const meta = msg(one(p, 5));
  const ts = iso(meta);
  const out = [];
  if (r.step_type === 14) {
    const input = msg(one(p, 19));
    const text = tidy(str(one(input, 2)) || str(at(input, 3, 1))).trim();
    if (text) out.push(/^\/[a-z][\w-]*(?:\s|$)/i.test(text) && !text.includes('\n') ? { kind: 'command', text, ts } : { kind: 'user', text, ts });
  } else if (r.step_type === 15) {
    const resp = msg(one(p, 20));
    const text = tidy(str(one(resp, 1)) || str(one(resp, 8))).trim();
    if (text) out.push({ kind: 'assistant', text, ts });
    for (const call of many(resp, 7)) {
      const c = msg(call);
      out.push({ kind: 'tool', name: str(one(c, 2)) || 'tool', text: toolText(str(one(c, 3))), ts });
    }
    if (!text && !out.length && r.status === 7) out.push({ kind: 'notice', text: `Gemini stopped with an error${errorText(r, p) ? `: ${errorText(r, p)}` : ''}`, ts });
  } else if (r.step_type === 132) {
    const error = r.status === 7 || r.status === 4;
    let text;
    if (pendingResult) text = 'Still running when this was read';
    else if (r.status === 6) text = 'Cancelled';
    else if (error) text = errorText(r, p) || 'Failed';
    else text = resultBody(tidy(str(at(p, 140, 2, 1)) || str(at(p, 148, 3))));
    out.push({ kind: 'result', text: clip(text.trim(), 40, 4000), ts, error });
  } else if (r.step_type === 23) {
    out.push({ kind: 'notice', text: 'Context summarised', ts });
  }
  return out;
}
const errorText = (r, p) => tidy(str(at(msg(buf(r.error_details)), 2)) || str(at(p, 31, 2))).split('\n')[0].slice(0, 400);

// Per conversation: { sig, gen, next, key, items, busy, asking, usage }. Only finished steps become items, in order, so the list
// only grows and an index never changes within one `gen`; a step that is not finished holds back the steps after it, unless it
// is a tool running in the background (over two minutes old with finished steps after it). A step id that changed at a known
// index (agy rewinds a conversation by rewriting its steps) starts the list over with a new `gen`.
const transcripts = new Map(); // LRU of 16
const STUCK = 120;
export async function geminiTranscript(id) {
  let entry = transcripts.get(id);
  if (entry) transcripts.delete(id); else entry = { sig: '', gen: 1, next: 0, key: '', items: [], busy: false, asking: false, usage: null, mtime: 0, chain: Promise.resolve() };
  transcripts.set(id, entry);
  while (transcripts.size > 16) transcripts.delete(transcripts.keys().next().value);
  const run = entry.chain.then(() => advanceTranscript(id, entry));
  entry.chain = run.catch(() => {});
  await run;
  return entry;
}
async function advanceTranscript(id, entry) {
  const { sig, exists, mtime } = await dbSignature(id);
  if (!exists) { const e = new Error('no such conversation'); e.code = 'ENOENT'; throw e; }
  entry.mtime = mtime;
  if (sig === entry.sig) return;
  const db = await openDb(path.join(CONVERSATIONS, `${id}.db`));
  withDb(db, () => {
    if (entry.next > 0) {
      const prev = db.prepare('SELECT metadata FROM steps WHERE idx = ?').get(entry.next - 1);
      if (!prev || str(one(msg(buf(prev.metadata)), 35)) !== entry.key) Object.assign(entry, { gen: entry.gen + 1, next: 0, key: '', items: [] });
    }
    const rows = db.prepare('SELECT idx, step_type, status, error_details, step_payload FROM steps WHERE idx >= ? ORDER BY idx').all(entry.next);
    const now = Date.now() / 1000;
    let blocked = false;
    rows.forEach((r, i) => {
      if (blocked) return;
      let pendingResult = false;
      if (!FINAL.has(r.status)) {
        const created = num(at(msg(buf(r.step_payload)), 5, 1, 1));
        const later = rows.slice(i + 1).some((x) => FINAL.has(x.status));
        if (r.step_type !== 132 || !later || now - created < STUCK) { blocked = true; return; }
        pendingResult = true;
      }
      entry.items.push(...stepItems(r, pendingResult));
      entry.next = r.idx + 1;
      entry.key = str(at(msg(buf(r.step_payload)), 5, 35));
    });
    // working: a step is not finished, or the last one leaves Gemini something to do (a question, a result, tool calls);
    // a conversation untouched for ten minutes is not working, whatever its last step says (agy may have been killed)
    const tail = db.prepare('SELECT step_type, status, step_payload FROM steps WHERE step_type <> 101 ORDER BY idx DESC LIMIT 12').all();
    const fresh = now - mtime / 1000 < 600;
    const last = tail[0];
    const lastCalls = last && last.step_type === 15 && many(msg(one(msg(buf(last.step_payload)), 20)), 7).length > 0;
    entry.asking = fresh && tail.some((r) => r.status === WAITING);
    entry.busy = fresh && !entry.asking && !!last && (tail.some((r) => !FINAL.has(r.status) && r.status !== WAITING) || last.step_type === 14 || last.step_type === 132 || lastCalls);
    // how full the context is: the newest generation's input, cached input included
    entry.usage = null;
    for (const r of db.prepare('SELECT metadata FROM steps WHERE step_type IN (15, 23) ORDER BY idx DESC LIMIT 6').all()) {
      const u = usageOf(msg(buf(r.metadata)));
      if (u) { entry.usage = u; break; }
    }
  });
  entry.sig = sig;
}

// How full a conversation is, for the session card: { tokens, window, model }. Gemini 4 and 3.8 take a million tokens.
export function geminiContext(entry) {
  const u = entry?.usage;
  if (!u) return null;
  const tokens = u.input + u.cached;
  return { tokens, window: 1_048_576, model: geminiModelName(u.model) };
}

// ---- spend: every generation of every conversation touched in the last `days`, priced as above. Per database { sig, next,
// key, pend: [idx of unfinished steps], ev: [[time, model, input $, cached $, response $, thinking $, tokens, idx]], pinned }.
// Only rows past `next` are read, and the unfinished ones again. Kept in TMUX_WEB_GEMINI_SPEND (no text, only numbers).
const SPEND_FILE = process.env.TMUX_WEB_GEMINI_SPEND || path.join(os.homedir(), '.local', 'state', 'tmux-web', 'gemini-spend.json');
const SPEND_VERSION = 1;
export const gspend = { dbs: new Map(), models: [], modelIds: new Map(), ready: false, scan: null, loading: null, version: 0, saveTimer: null };
const modelId = (m) => { let i = gspend.modelIds.get(m); if (i === undefined) { i = gspend.models.push(m) - 1; gspend.modelIds.set(m, i); } return i; };
const freshDb = () => ({ sig: '', next: 0, key: '', pend: [], ev: [], pinned: 0, chain: Promise.resolve() });
function withSpendDb(id, task) {
  let e = gspend.dbs.get(id);
  if (!e) gspend.dbs.set(id, e = freshDb());
  const run = e.chain.then(() => task(e));
  e.chain = run.catch(() => {});
  return run;
}
function eventOf(r) {
  const meta = msg(buf(r.metadata));
  const u = usageOf(meta);
  const t = num(at(meta, 1, 1));
  if (!u || !t) return null;
  const model = geminiModelName(u.model);
  return [t, modelId(model), ...geminiCost(model, t, u), r.idx];
}
async function advanceSpend(id, e) {
  const { sig, exists } = await dbSignature(id);
  if (!exists || sig === e.sig) return;
  const db = await openDb(path.join(CONVERSATIONS, `${id}.db`));
  withDb(db, () => {
    if (e.next > 0) {
      const prev = db.prepare('SELECT metadata FROM steps WHERE idx = ?').get(e.next - 1);
      if (!prev || str(one(msg(buf(prev.metadata)), 35)) !== e.key) Object.assign(e, { next: 0, key: '', pend: [], ev: [] });
    }
    const again = e.pend.length ? db.prepare(`SELECT idx, status, metadata FROM steps WHERE idx IN (${e.pend.map(() => '?').join(',')})`).all(...e.pend) : [];
    const rows = db.prepare('SELECT idx, status, metadata FROM steps WHERE idx >= ? ORDER BY idx').all(e.next);
    const pend = [];
    for (const r of [...again, ...rows]) {
      if (!FINAL.has(r.status)) { pend.push(r.idx); continue; }
      const ev = eventOf(r);
      if (ev) { const k = e.ev.findIndex((x) => x[7] === r.idx); if (k >= 0) e.ev[k] = ev; else e.ev.push(ev); }
    }
    if (rows.length) { e.next = rows.at(-1).idx + 1; e.key = str(one(msg(buf(rows.at(-1).metadata)), 35)); }
    e.pend = pend.slice(-64);
  });
  e.sig = sig;
  gspend.version++;
}
const touch = (id, pin) => withSpendDb(id, async (e) => { if (pin) e.pinned = Date.now(); await advanceSpend(id, e); });

async function loadSpend() {
  gspend.loading ||= (async () => {
    try {
      const saved = JSON.parse(await fs.promises.readFile(SPEND_FILE, 'utf8'));
      if (saved?.v !== SPEND_VERSION || !Array.isArray(saved.models) || !isObject(saved.dbs)) return;
      saved.models.forEach((m) => modelId(String(m)));
      const n = gspend.models.length;
      for (const [id, s] of Object.entries(saved.dbs)) {
        if (!UUID.test(id) || !isObject(s) || !Array.isArray(s.ev) || gspend.dbs.has(id)) continue;
        gspend.dbs.set(id, { ...freshDb(), sig: String(s.sig || ''), next: +s.next || 0, key: String(s.key || ''),
          pend: Array.isArray(s.pend) ? s.pend.filter(Number.isInteger) : [], ev: s.ev.filter((x) => Array.isArray(x) && x.length === 8 && x.every(Number.isFinite) && x[1] >= 0 && x[1] < n) });
      }
    } catch { /* none yet */ }
  })();
  return gspend.loading;
}
function saveSoon() {
  if (gspend.saveTimer) return;
  gspend.saveTimer = setTimeout(() => {
    gspend.saveTimer = null;
    const dbs = {};
    for (const [id, e] of gspend.dbs) if (e.sig) dbs[id] = { sig: e.sig, next: e.next, key: e.key, pend: e.pend, ev: e.ev };
    try {
      fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true, mode: 0o700 });
      const temp = `${SPEND_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ v: SPEND_VERSION, models: gspend.models, dbs }), { mode: 0o600 });
      fs.renameSync(temp, SPEND_FILE);
    } catch { /* tried again with the next change */ }
  }, +process.env.TMUX_WEB_SPEND_SAVE_MS >= 0 && process.env.TMUX_WEB_SPEND_SAVE_MS ? +process.env.TMUX_WEB_SPEND_SAVE_MS : 20_000);
  gspend.saveTimer.unref();
}
async function candidates(days) {
  const since = Date.now() - days * 86400_000;
  let names;
  try { names = (await fs.promises.readdir(CONVERSATIONS)).filter((n) => /^[0-9a-f-]{36}\.db$/i.test(n)); } catch { return []; }
  const ids = await Promise.all(names.map(async (n) => {
    const id = n.slice(0, -3);
    return (await dbSignature(id)).mtime >= since ? id : null;
  }));
  return ids.filter(Boolean);
}
export function scanGeminiSpend(days) {
  gspend.scan ||= (async () => {
    await loadSpend();
    const before = gspend.version;
    const ids = await candidates(days);
    for (const id of ids) await touch(id, false).catch(() => {});
    const listed = new Set(ids);
    for (const [id, e] of gspend.dbs) if (!listed.has(id) && Date.now() - e.pinned > 3600_000) { gspend.dbs.delete(id); gspend.version++; }
    gspend.ready = true;
    if (gspend.version !== before) saveSoon();
  })().catch(() => {}).finally(() => { gspend.scan = null; });
  return gspend.scan;
}
// A conversation's events now (a session card asks), its subagents' included.
export async function geminiConversationEvents(id, days) {
  await loadSpend();
  const info = await summaries();
  const ids = [id, ...[...info].filter(([, s]) => s.parent === id).map(([child]) => child)];
  for (const one of ids) await touch(one, true).catch(() => {});
  if (!gspend.ready && !gspend.scan) scanGeminiSpend(days);
  return ids.flatMap((one) => gspend.dbs.get(one)?.ev || []);
}
