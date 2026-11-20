(() => {
  const $list = document.getElementById('list');
  const $notice = document.getElementById('notice');
  const $refresh = document.getElementById('refresh');
  const $create = document.getElementById('create');
  const $name = document.getElementById('session-name');
  const $createButton = document.getElementById('create-button');
  const $createError = document.getElementById('create-error');
  const $previewLess = document.getElementById('preview-less');
  const $previewMore = document.getElementById('preview-more');
  const $previewToggle = document.getElementById('preview-toggle');
  const $previewValue = document.getElementById('preview-value');
  const $listTitle = document.getElementById('list-title');
  const $closeDialog = document.getElementById('close-dialog');
  const $closeConfirm = document.getElementById('close-confirm');
  const $closeCancel = document.getElementById('close-cancel');
  const $closeError = document.getElementById('close-error');
  const $whoami = document.getElementById('whoami');
  const $renameDialog = document.getElementById('rename-dialog');
  const $renameForm = document.getElementById('rename-form');
  const $renameInput = document.getElementById('rename-input');
  const $renameError = document.getElementById('rename-error');
  const $renameSave = document.getElementById('rename-save');
  const $renameCancel = document.getElementById('rename-cancel');
  const $ownerFilter = document.getElementById('owner-filter');
  const $ownerOptions = document.getElementById('owner-options');
  const $heading = document.querySelector('h1');
  const $accountBar = document.getElementById('account-bar');
  const $accountOptions = document.getElementById('account-options');
  const $accountOff = document.getElementById('account-off');
  const $accountOffText = document.getElementById('account-off-text');
  const $accountOn = document.getElementById('account-on');
  const $shareDialog = document.getElementById('share-dialog');
  const $sharePeople = document.getElementById('share-people');
  const $shareError = document.getElementById('share-error');
  const $shareSave = document.getElementById('share-save');
  const $shareCancel = document.getElementById('share-cancel');
  let shareTarget = null;
  let sharing = false;
  let closeTarget = null;
  let closing = false;
  let renameTarget = null;
  let renaming = false;
  let loadRequest = 0;
  document.getElementById('host').textContent = location.hostname;

  const PREVIEW_LINES = [0, 1, 2, 3, 5, 7, 10, 15, 20, 30, 50];
  let previewLines = 7;
  try {
    const saved = localStorage.getItem('tmuxweb.previewLines');
    if (saved !== null && PREVIEW_LINES.includes(Number(saved))) previewLines = Number(saved);
  } catch { /* private mode */ }
  let previewShown = previewLines || 7; // what the middle button brings back after hiding the previews
  // Whose sessions to list: 'me' (started here), 'local' (started outside the web page) and other people's emails.
  // Only people the server says we may view are offered; it also ignores anything we are not allowed to ask for.
  let me = null; // from api/me; null until known, { canViewOthers: false } on a server without it
  let meStatus = 0; // HTTP status of the last api/me (0: none yet, or no answer)
  let selected = new Set(['me', 'local']);
  try {
    const saved = JSON.parse(localStorage.getItem('tmuxweb.owners'));
    if (Array.isArray(saved) && saved.every((v) => typeof v === 'string')) selected = new Set(saved);
  } catch { /* private mode or nothing saved */ }
  let lastJson = '';
  let latestData = null;
  let timer = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const ago = (sec) => {
    if (sec < 45) return 'Just now';
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  };
  const tokens = (n) => (n >= 999_500 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  // dollars: cents below $100, whole dollars up to $10k, then thousands
  const money = (v) => (v > 0 && v < 0.005 ? '<$0.01' : v >= 9_995 ? `$${+(v / 1000).toFixed(v >= 99_950 ? 0 : 1)}k`
    : v >= 99.95 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${(v || 0).toFixed(2)}`);
  const moneyShort = (v) => (v >= 9.995 ? money(v).replace(/\.\d\d$/, '') : money(v));
  // a share of the weekly limit: ≈0.4%, ≈3.7%, ≈21%
  const weekPct = (p) => `≈${p > 0 && p < 0.1 ? '<0.1' : p < 9.95 ? String(Math.round(p * 10) / 10) : String(Math.round(p))}%`;

  // The coding agents a session can run (api/sessions `agent`): each has its color (--claude, --gemini) and mark on the cards,
  // the list's filter and the usage panel; a session running neither is a plain terminal.
  const AGENTS = { claude: { label: 'Claude', glyph: '✻' }, gemini: { label: 'Gemini', glyph: '✦' } };
  const KINDS = [
    { key: 'all', label: 'All' },
    { key: 'claude', label: 'Claude', glyph: '✻' },
    { key: 'gemini', label: 'Gemini', glyph: '✦' },
    { key: 'shell', label: 'Terminal', glyph: '›' },
  ];
  const kindOf = (s) => s.agent || (s.claude ? 'claude' : 'shell');
  let kindFilter = 'all';
  try { const saved = localStorage.getItem('tmuxweb.kind'); if (KINDS.some((k) => k.key === saved)) kindFilter = saved; } catch { /* private mode */ }
  function agentTag(agent) {
    const a = AGENTS[agent];
    const tag = el('span', `agent-tag ${agent}`);
    tag.append(el('span', 'agent-glyph', a.glyph), document.createTextNode(a.label));
    return tag;
  }

  // An agent session's spend: its conversation's total and the last two hours (for Claude each with the share of the weekly
  // limit it comes to; Gemini's limits cannot be read), and a sparkline of its last 24 hours in half hours (the last four, i.e.
  // the last two hours, in full color).
  function spendStrip(sp, now, agent = 'claude') {
    const box = el('div', 'spend');
    const stat = (value, label, pct, hot) => {
      const node = el('span', `sp-stat${hot ? ' hot' : ''}`);
      node.append(el('b', null, money(value)), el('span', 'sp-lbl', label));
      if (pct != null) node.append(el('span', 'sp-wk', `${weekPct(pct)} wk`));
      return node;
    };
    const stats = el('div', 'sp-stats');
    stats.append(stat(sp.total, 'total', sp.pct?.[0]), stat(sp.recent, 'last 2 h', sp.pct?.[1], true));
    const share = (p) => (p != null ? `, ${weekPct(p)} of the weekly limit` : '');
    box.title = `${agent === 'gemini' ? 'Gemini spend at Google’s API prices' : 'Claude spend at API prices'}. This conversation: ${money(sp.total)}${share(sp.pct?.[0])}${sp.tokens ? ` (${tokens(sp.tokens)} tokens)` : ''}${sp.since ? ` since ${clock(sp.since, true)}` : ''}. Last 2 hours: ${money(sp.recent)}${share(sp.pct?.[1])}.`;
    box.append(stats, sparkline(sp, now));
    return box;
  }
  function sparkline(sp, now) {
    const n = sp.spark.length;
    const W = n * 10;
    const H = 26;
    const max = Math.max(...sp.spark);
    const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    svg.append(svgEl('rect', { class: 'spark-band', x: W - 40, y: 0, width: 40, height: H }), svgEl('line', { class: 'spark-base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    let peak = -1;
    sp.spark.forEach((v, i) => {
      if (!(v > 0)) return;
      if (peak < 0 || v > sp.spark[peak]) peak = i;
      const h = Math.max(2, (v / max) * (H - 3));
      const bar = svgEl('rect', { class: i >= n - 4 ? 'hot' : '', x: i * 10 + 1.5, y: H - 1 - h, width: 7, height: h });
      const t0 = now - (n - i) * sp.step;
      bar.append(svgEl('title'));
      bar.firstChild.textContent = `${clock(t0)}–${clock(t0 + sp.step)}: ${money(v)}`;
      svg.append(bar);
    });
    svg.setAttribute('aria-label', peak < 0 ? 'Nothing spent in the last 24 hours' : `Spend over the last 24 hours in half hours; the most, ${money(sp.spark[peak])}, from ${clock(now - (n - peak) * sp.step)}`);
    return svg;
  }

  // How full a Claude session's conversation is: a small bar, amber from half, red from 80%. Just compacted: not known yet.
  function contextMeter({ tokens: used, window, compacted }, agent = 'claude') {
    const who = AGENTS[agent]?.label || 'Claude';
    if (compacted) {
      const meter = el('span', 'ctx compacted', 'ctx compacted');
      meter.prepend(el('span', 'ctx-bar'));
      meter.title = 'Claude just compacted this conversation; the size shows again after its next answer';
      return meter;
    }
    const pct = Math.min(100, Math.round((used / window) * 100));
    const meter = el('span', `ctx${pct >= 80 ? ' bad' : pct >= 50 ? ' warn' : ''}`);
    meter.title = `${who} context: ${tokens(used)} of ${tokens(window)} tokens (${pct}%)`;
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', `${who} context used`);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-valuetext', `${pct}%, ${tokens(used)} of ${tokens(window)} tokens`);
    const bar = el('span', 'ctx-bar');
    const fill = el('i');
    fill.style.width = `${Math.max(pct, 4)}%`;
    bar.append(fill);
    meter.append(bar, el('b', null, `${pct}%`), document.createTextNode(' ctx'));
    return meter;
  }

  // Everything about owners is multi-user: a server without it (no users.json) says `multiUser: false` and none of it is shown.
  function ownerTag(s) {
    if (!me?.multiUser) return [];
    const tags = [];
    if (!s.mine) {
      if (!s.owner) tags.push(el('span', 'owner-tag local', s.sharedWithMe ? 'Shared with you' : 'Local'));
      else tags.push(el('span', `owner-tag${s.access === 'view' ? ' view' : ''}`, s.owner.name));
      if (s.access === 'view') tags.push(el('span', 'owner-tag view', 'View only'));
    }
    if (s.share?.length) {
      const shared = el('span', 'owner-tag shared', `Shared with ${s.share.map((p) => p.name).join(', ')}`);
      shared.title = s.share.map((p) => `${p.name}: ${p.level === 'full' ? 'control' : 'view only'}`).join(' · ');
      tags.push(shared);
    }
    return tags;
  }

  function card(s, now) {
    const kind = kindOf(s);
    const a = el('a', `card kind-${kind}`);
    a.href = `term.html?s=${encodeURIComponent(s.name)}&id=${encodeURIComponent(s.id)}&instance=${encodeURIComponent(s.instance)}`;
    const row = el('div', 'row');
    row.append(el('span', 'name', s.name));
    const meta = el('div', 'meta');
    if (AGENTS[kind]) meta.append(agentTag(kind));
    if (s.context) meta.append(contextMeter(s.context, kind));
    meta.append(...ownerTag(s));
    meta.append(el('span', null, `${s.windows} ${s.windows === 1 ? 'window' : 'windows'}`));
    meta.append(s.attached > 0 ? el('span', 'badge-on', `● Attached ×${s.attached}`) : el('span', null, 'Detached'));
    meta.append(el('span', null, ago(Math.max(0, now - s.activity))));
    const where = el('div', 'where');
    where.append(el('b', null, s.command), document.createTextNode(` · ${s.path}`));
    a.append(row, meta, where);
    if (s.spend) a.append(spendStrip(s.spend, now, kind));
    if (previewLines && s.preview && s.preview.length) {
      const preview = el('pre', `peek${s.preview.length > previewLines ? ' cut' : ''}`);
      for (const line of s.preview.slice(-previewLines)) preview.append(el('span', 'peek-line', line));
      a.append(preview);
    }
    const li = el('li', 'session-card');
    li.dataset.sessionId = s.id;
    const actions = el('div', 'session-actions');
    const rename = el('button', 'session-rename');
    rename.type = 'button';
    rename.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    rename.title = `Rename session: ${s.name}`;
    rename.setAttribute('aria-label', `Rename session: ${s.name}`);
    rename.setAttribute('aria-haspopup', 'dialog');
    rename.addEventListener('click', () => {
      if (renaming || $renameDialog.open) return;
      renameTarget = { id: s.id, instance: s.instance, name: s.name };
      $renameInput.value = s.name;
      $renameInput.removeAttribute('aria-invalid');
      $renameError.hidden = true;
      $renameDialog.showModal();
      $renameInput.focus();
      $renameInput.select();
    });
    // shared with people of this account (the server says who could be); not with the session's own owner
    const sharable = s.access === 'full' && (me?.sharePeople || []).some((p) => p.email !== s.owner?.email);
    const share = el('button', 'session-share');
    share.type = 'button';
    share.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    share.title = s.share?.length ? `Shared with ${s.share.map((p) => p.name).join(', ')}: change` : `Share session: ${s.name}`;
    share.setAttribute('aria-label', share.title);
    share.setAttribute('aria-haspopup', 'dialog');
    if (s.share?.length) share.dataset.shared = '';
    share.addEventListener('click', () => openShare(s));
    const close = el('button', 'session-close', 'Close');
    close.type = 'button';
    close.title = `Close session: ${s.name}`;
    close.setAttribute('aria-label', `Close session: ${s.name}`);
    close.setAttribute('aria-haspopup', 'dialog');
    close.addEventListener('click', () => {
      if (closing || $closeDialog.open) return;
      closeTarget = { id: s.id, instance: s.instance, name: s.name };
      document.getElementById('close-name').textContent = s.name;
      document.getElementById('close-owner').textContent = me?.multiUser && s.owner && !s.mine ? ` (${s.owner.name}'s session)` : '';
      $closeError.hidden = true;
      $closeDialog.showModal();
      $closeCancel.focus();
    });
    if (s.access === 'view') li.append(a); // somebody else's session: look, don't touch
    else { actions.append(...(sharable ? [share] : []), rename, close); li.append(a, actions); }
    li.classList.toggle('shareable', sharable && s.access !== 'view');
    return li;
  }

  function render(data) {
    latestData = data;
    const json = JSON.stringify({ data, previewLines, kindFilter, who: me?.email, sharePeople: me?.sharePeople });
    if (json === lastJson) return;
    lastJson = json;
    $listTitle.textContent = data.sessions.length ? `${data.sessions.length} ${data.sessions.length === 1 ? 'session' : 'sessions'}` : 'Sessions';
    renderKinds(data.sessions);
    $list.replaceChildren();
    if (!data.sessions.length) {
      const li = el('li', 'empty');
      li.textContent = 'No tmux sessions yet. Create one above to get started.';
      $list.append(li);
      return;
    }
    const shown = data.sessions.filter((s) => kindFilter === 'all' || kindOf(s) === kindFilter);
    if (!shown.length) {
      const li = el('li', 'empty');
      const all = el('button', 'link-btn', 'Show all sessions');
      all.type = 'button';
      all.addEventListener('click', () => setKind('all'));
      li.append(document.createTextNode(`No ${{ claude: 'Claude', gemini: 'Gemini', shell: 'plain terminal' }[kindFilter]} sessions right now. `), all);
      $list.append(li);
      return;
    }
    for (const s of shown) $list.append(card(s, data.now));
  }

  // ---- what kind of session to list: all, Claude, Gemini or plain terminals (a segmented control with counts, remembered in
  // this browser). Shown once the list holds more than one kind; a kind with nothing in it is left out unless it is the choice.
  const $kindFilter = document.getElementById('kind-filter');
  function setKind(key) {
    kindFilter = key;
    try { localStorage.setItem('tmuxweb.kind', key); } catch { /* private mode */ }
    if (latestData) render(latestData);
  }
  function renderKinds(sessions) {
    const count = { all: sessions.length, claude: 0, gemini: 0, shell: 0 };
    for (const s of sessions) count[kindOf(s)]++;
    const kinds = ['claude', 'gemini', 'shell'].filter((k) => count[k] > 0).length;
    $kindFilter.hidden = kinds < 2 && kindFilter === 'all';
    $listTitle.classList.toggle('with-kinds', !$kindFilter.hidden);
    if ($kindFilter.hidden) { $kindFilter.replaceChildren(); return; }
    $kindFilter.replaceChildren(...KINDS.filter((k) => k.key === 'all' || count[k.key] > 0 || k.key === kindFilter).map((k) => {
      const b = el('button', `kind-${k.key}`);
      b.type = 'button';
      if (k.glyph) b.append(el('span', 'kind-glyph', k.glyph));
      b.append(document.createTextNode(k.label), el('span', 'count', String(count[k.key])));
      b.setAttribute('aria-pressed', String(kindFilter === k.key));
      b.title = k.key === 'all' ? 'Every session' : k.key === 'shell' ? 'Sessions running neither Claude nor Gemini' : `Sessions running ${k.label}`;
      b.addEventListener('click', () => setKind(kindFilter === k.key && k.key !== 'all' ? 'all' : k.key));
      return b;
    }));
  }

  function saveSelection() {
    try { localStorage.setItem('tmuxweb.owners', JSON.stringify([...selected])); } catch { /* private mode */ }
  }
  // Drop choices that no longer make sense (a person we may no longer view, or nothing at all).
  function sanitizeSelection() {
    if (!me?.canViewOthers) { selected = new Set(['me', 'local']); return; }
    const known = new Set(['me', 'local', ...me.people.map((p) => p.email)]);
    selected = new Set([...selected].filter((v) => known.has(v)));
    if (!selected.size) selected = new Set(['me', 'local']);
  }
  function renderOwners() {
    // the row only earns its place when there is somebody else to look at
    const someoneElse = !!me?.canViewOthers && me.people.length > 0;
    $ownerFilter.hidden = !someoneElse;
    $listTitle.hidden = someoneElse;
    $whoami.hidden = !(me?.multiUser && me.email);
    const elsewhere = !!me?.myAccount && me.account !== me.myAccount; // an admin in another account
    if (!$whoami.hidden) $whoami.textContent = `Signed in as ${me.name} · ${me.email}${elsewhere ? ` · in the ${me.account} account` : ''}`;
    $heading.textContent = 'Tmux sessions';
    if (elsewhere) $heading.append(el('span', 'muted', ` · ${me.account}`));
    document.title = elsewhere ? `Tmux sessions · ${me.account}` : 'Tmux sessions';
    if (!someoneElse) { $ownerOptions.replaceChildren(); return; }
    const choices = [{ key: 'me', label: 'Mine' }];
    if (me.local > 0 || selected.has('local')) choices.push({ key: 'local', label: 'Local', count: me.local });
    for (const p of me.people) choices.push({ key: p.email, label: p.name, count: p.sessions, title: p.email });
    const all = choices.every((c) => selected.has(c.key));
    const buttons = choices.map((c) => {
      const b = el('button', null, c.label);
      b.type = 'button';
      if (c.title) b.title = c.title;
      if (c.count != null) b.append(el('span', 'count', String(c.count)));
      b.setAttribute('aria-pressed', String(selected.has(c.key)));
      b.addEventListener('click', () => {
        if (selected.has(c.key) && selected.size > 1) selected.delete(c.key); else selected.add(c.key);
        saveSelection(); renderOwners(); load();
      });
      return b;
    });
    const every = el('button', null, 'Everyone');
    every.type = 'button';
    every.setAttribute('aria-pressed', String(all));
    every.addEventListener('click', () => {
      selected = all ? new Set(['me', 'local']) : new Set(choices.map((c) => c.key));
      saveSelection(); renderOwners(); load();
    });
    $ownerOptions.replaceChildren(...buttons, every);
  }
  async function loadMe() {
    meStatus = 0;
    try {
      const res = await fetch('api/me', { cache: 'no-store', credentials: 'same-origin' });
      meStatus = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      me = await res.json();
    } catch { me ||= { canViewOthers: false }; }
    sanitizeSelection();
    renderOwners();
  }

  // ---- accounts. This page may be another Unix account's (/a/<account>/: its api/ and term/ go to that account's own backend).
  // Which accounts there are, and their on/off switches, come from the home backend (/api/accounts), which answers even while
  // this account's backend is off. Only an admin gets more than their own account, and the switches.
  const pathAccount = /^\/a\/([a-z_][a-z0-9_-]{0,31})\//.exec(location.pathname)?.[1] || null;
  let accounts = null; // { home, admin, accounts: [{ name, home, on, up }] }
  const switching = new Set();
  const accountUrl = (name) => (name === accounts?.home ? '/' : `/a/${name}/`);
  const currentAccount = () => (meStatus === 200 && me?.account) || pathAccount || accounts?.home;
  const stateOf = (a) => (a.home || (a.on && a.up) ? 'up' : a.on || a.up ? 'busy' : 'off'); // busy: starting or stopping
  const STATE_TEXT = { up: 'running', busy: 'starting or stopping', off: 'off' };
  async function loadAccounts() {
    try {
      const res = await fetch('/api/accounts', { cache: 'no-store', credentials: 'same-origin' });
      if (res.ok) accounts = await res.json();
    } catch { /* keep the last answer */ }
  }
  function renderAccounts() {
    const list = accounts?.admin ? accounts.accounts : [];
    $accountBar.hidden = list.length < 2;
    if ($accountBar.hidden) { $accountOptions.replaceChildren(); return; }
    const here = currentAccount();
    $accountOptions.replaceChildren(...list.map((a) => {
      const item = el('span', 'account-item');
      const state = stateOf(a);
      const chip = el('a', 'account-chip', a.name);
      chip.href = accountUrl(a.name);
      chip.prepend(el('span', `account-dot ${state}`));
      chip.title = a.home ? `${a.name}: the home account` : `${a.name}: ${STATE_TEXT[state]}`;
      chip.setAttribute('aria-label', chip.title);
      if (a.name === here) chip.setAttribute('aria-current', 'page');
      item.append(chip);
      if (!a.home) {
        const flip = el('button', `account-switch${a.on ? '' : ' turn-on'}`, a.on ? 'Turn off' : 'Turn on');
        flip.type = 'button';
        flip.setAttribute('aria-label', `${a.on ? 'Turn off' : 'Turn on'} the ${a.name} account`);
        flip.title = a.on ? `Turn the ${a.name} account off here (its sessions keep running)` : `Turn the ${a.name} account on`;
        flip.disabled = switching.has(a.name);
        flip.addEventListener('click', () => flipAccount(a.name, !a.on));
        item.append(flip);
      }
      return item;
    }));
  }
  // The account's own systemd starts or stops its backend a second or two after the switch file changes.
  async function flipAccount(name, on) {
    if (!name || switching.has(name)) return;
    switching.add(name);
    renderAccounts();
    $accountOn.disabled = true;
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
        method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const wait of [700, 1000, 1500, 2500]) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        await loadAccounts();
        if (accounts?.accounts.find((a) => a.name === name)?.up === on) break;
      }
    } catch {
      $notice.textContent = `Could not turn the ${name} account ${on ? 'on' : 'off'}. Try again, or refresh and sign in again.`;
      $notice.hidden = false;
    } finally {
      switching.delete(name);
      $accountOn.disabled = false;
      renderAccounts();
      load();
    }
  }
  $accountOn.addEventListener('click', () => flipAccount(currentAccount(), true));
  // This page's account cannot be used now: its backend is off, or the person belongs to another account whose is.
  function showOff(text, canTurnOn) {
    document.body.classList.add('off');
    $accountOff.hidden = false;
    $accountOffText.textContent = text;
    $accountOn.hidden = !canTurnOn;
    $notice.hidden = true;
  }
  function hideOff() {
    document.body.classList.remove('off');
    $accountOff.hidden = true;
  }
  const OWN_OFF = 'The web terminal for your account is turned off. Ask an admin to turn it on; this page opens it as soon as it is.';
  // false when the list cannot be shown here (off, or redirected to the person's own account)
  function accountUsable() {
    if (me?.allowed === false && meStatus === 200) {
      // somebody of another account on this account's page: off to their own one when it runs
      const mine = accounts?.accounts.find((a) => a.name === me.myAccount);
      if (mine && stateOf(mine) === 'up') { location.replace(accountUrl(mine.name)); return false; }
      showOff(OWN_OFF, false);
      return false;
    }
    if (meStatus !== 200 && pathAccount) {
      const here = accounts?.accounts.find((a) => a.name === pathAccount);
      if (here && stateOf(here) !== 'up') {
        const starting = here.on && !here.up;
        showOff(starting ? `The ${here.name} account is starting…` : accounts.admin ? `The ${here.name} account is turned off here. Its sessions keep running.` : OWN_OFF, accounts.admin && !here.on);
        return false;
      }
    }
    hideOff();
    return true;
  }

  // ---- preview lines: − and + step through PREVIEW_LINES, the middle button hides the previews or brings them back
  function updatePreview() {
    const i = PREVIEW_LINES.indexOf(previewLines);
    $previewLess.disabled = i <= 0;
    $previewMore.disabled = i >= PREVIEW_LINES.length - 1;
    $previewValue.textContent = previewLines ? String(previewLines) : 'Off';
    $previewToggle.classList.toggle('off', !previewLines);
    $previewToggle.title = previewLines ? `Preview: the last ${previewLines} ${previewLines === 1 ? 'line' : 'lines'} of each session. Hide previews` : 'Previews are hidden. Show them';
    $previewToggle.setAttribute('aria-label', $previewToggle.title);
  }
  function setPreview(lines) {
    previewLines = lines;
    if (lines) previewShown = lines;
    try { localStorage.setItem('tmuxweb.previewLines', String(lines)); } catch { /* private mode */ }
    updatePreview();
    if (latestData) render(latestData);
  }
  const stepPreview = (by) => setPreview(PREVIEW_LINES[Math.min(PREVIEW_LINES.length - 1, Math.max(0, PREVIEW_LINES.indexOf(previewLines) + by))]);
  $previewLess.addEventListener('click', () => stepPreview(-1));
  $previewMore.addEventListener('click', () => stepPreview(1));
  $previewToggle.addEventListener('click', () => setPreview(previewLines ? 0 : previewShown));
  updatePreview();

  // ---- Claude usage of this account (api/usage). Two rings in the header: what is left of the 5-hour and the weekly limit. They
  // open a panel with each window's trend: its usage so far against an even pace (the dotted diagonal), and where the average
  // pace so far leads. The panel starts open on a wide screen and closed on a phone; a choice is remembered per device kind.
  // Everything is built once and then updated, so the rings, numbers and dots move to new values instead of jumping.
  const $usagePill = document.getElementById('usage-pill');
  const $usagePanel = document.getElementById('usage-panel');
  const $usageGrid = document.getElementById('usage-grid');
  const $usageNote = document.getElementById('usage-note');
  const LIMITS = [
    { key: 'fiveHour', short: '5h', name: '5-hour limit', span: 5 * 3600, col: 1 },
    { key: 'sevenDay', short: '7d', name: 'Weekly limit', span: 7 * 86400, col: 2 },
  ];
  const USAGE_ERRORS = {
    'login expired': 'Claude’s login here has expired; the numbers move again once Claude runs',
    'not signed in': 'Claude is signed out on this account',
    'unreadable login': 'Claude’s login file could not be read',
    'rate limited': 'Anthropic asked to slow down; trying again later',
    unreachable: 'Anthropic could not be reached; trying again',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const RING = 'M18 3.5a14.5 14.5 0 1 1 0 29a14.5 14.5 0 1 1 0-29'; // a circle from the top, clockwise
  const Y = (pct) => 96 - pct * 0.92; // chart: 0..100 % in a 300 x 100 box, a little room at the top and bottom
  const severity = (left) => (left <= 20 ? 'bad' : left <= 50 ? 'warn' : 'ok'); // as in the statusline
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const usageKind = () => (matchMedia('(max-width: 719px)').matches ? 'phone' : 'desktop');
  const span = (s) => {
    const m = Math.max(0, Math.round(s / 60));
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
  };
  const clock = (t, day) => new Date(t * 1000).toLocaleString([], day ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
  let usage = null;
  let usageOpen = null; // null until there is something to show
  const parts = {};

  function countTo(node, to) {
    const from = Number(node.dataset.value ?? 0);
    node.dataset.value = String(to);
    if (from === to || reducedMotion.matches) { node.textContent = String(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      if (node.dataset.value !== String(to)) return; // a newer value took over
      const k = Math.min(1, (t - t0) / 900);
      node.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function buildUsage() {
    for (const lim of LIMITS) {
      const p = parts[lim.key] = {};
      p.gauge = el('span', 'gauge');
      const ring = svgEl('svg', { class: 'ring', viewBox: '0 0 36 36', 'aria-hidden': 'true' });
      p.ring = svgEl('path', { class: 'ring-fill', d: RING, pathLength: 100 });
      p.ring.style.strokeDasharray = '0 100';
      ring.append(svgEl('path', { class: 'ring-track', d: RING, pathLength: 100 }), p.ring);
      p.num = el('span', 'gauge-num', '0');
      const text = el('span', 'gauge-text');
      text.append(p.num, el('span', 'gauge-label', lim.short));
      p.gauge.append(ring, text);
      $usagePill.append(p.gauge);

      p.card = el('article', 'u-card');
      const head = el('div', 'u-head');
      p.big = el('b', 'u-num', '0');
      const left = el('span', 'u-left');
      left.append(p.big, document.createTextNode(' left'));
      head.append(el('span', 'u-title', lim.name), left);
      p.chart = svgEl('svg', { class: 'u-chart', viewBox: '0 0 300 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      const fill = svgEl('linearGradient', { id: `u-fill-${lim.key}`, x1: 0, y1: 0, x2: 0, y2: 1 });
      fill.append(svgEl('stop', { offset: 0, 'stop-color': 'currentColor', 'stop-opacity': 0.34 }), svgEl('stop', { offset: 1, 'stop-color': 'currentColor', 'stop-opacity': 0.03 }));
      const defs = svgEl('defs');
      defs.append(fill);
      p.area = svgEl('path', { class: 'area', fill: `url(#u-fill-${lim.key})` });
      p.line = svgEl('path', { class: 'line' });
      p.gap = svgEl('path', { class: 'gap' });
      p.proj = svgEl('path', { class: 'proj' });
      p.now = svgEl('line', { class: 'now', y1: 0, y2: 100 });
      p.chart.append(defs, svgEl('line', { class: 'limit', x1: 0, x2: 300, y1: Y(100), y2: Y(100) }), svgEl('line', { class: 'base', x1: 0, x2: 300, y1: Y(0), y2: Y(0) }),
        svgEl('path', { class: 'pace', d: `M0 ${Y(0)}L300 ${Y(100)}` }), p.now, p.area, p.gap, p.line, p.proj);
      const sweep = el('div', 'u-sweep');
      sweep.append(p.chart);
      p.dot = el('span', 'u-dot');
      const plot = el('div', 'u-plot');
      plot.append(sweep, p.dot);
      p.axis = el('div', 'u-axis');
      p.foot = el('p', 'u-foot');
      p.card.append(head, plot, p.axis, p.foot);
      $usageGrid.append(p.card);
    }
    parts.pillSpend = el('span', 'pill-spend');
    parts.pillSpendNum = el('b', null, '$0');
    parts.pillSpend.append(parts.pillSpendNum, el('span', 'gauge-label', '2 h'));
    parts.pillSpend.hidden = true;
    parts.pillGemini = el('span', 'pill-spend gemini');
    parts.pillGeminiNum = el('b', null, '$0');
    const gLabel = el('span', 'gauge-label');
    gLabel.append(el('span', 'agent-glyph', '✦'), document.createTextNode('2 h'));
    parts.pillGemini.append(parts.pillGeminiNum, gLabel);
    parts.pillGemini.hidden = true;
    const chev = svgEl('svg', { class: 'usage-chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    chev.append(svgEl('path', { d: 'M3 4.5 6 7.5 9 4.5' }));
    $usagePill.append(parts.pillSpend, parts.pillGemini, chev);
  }

  // One window: x is its time from start to reset, y the share used. A window that has ended since the last answer is a new one
  // that has not started yet (it opens with the next message).
  function drawLimit(lim, p, cur, now) {
    const open = cur.resetsAt != null && cur.resetsAt > now;
    const used = open ? cur.used : 0;
    const start = open ? cur.resetsAt - lim.span : now;
    const end = start + lim.span;
    const X = (t) => Math.min(300, Math.max(0, ((t - start) / lim.span) * 300));
    const pts = open ? (usage.history || []).filter((h) => h[0] >= start && h[0] <= now && h[lim.col] != null).map((h) => [h[0], h[lim.col]]) : [];
    if (open) pts.push([now, used]);
    // from the window's start (nothing used) to the first answer: solid when that is close, dotted when it is a guess
    const guessed = open && pts[0][0] - start > 20 * 60;
    if (open && !guessed) pts.unshift([start, 0]);
    const path = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
    if (path) {
      p.line.setAttribute('d', path);
      p.area.setAttribute('d', `${path}L${X(pts.at(-1)[0]).toFixed(1)} ${Y(0)}L${X(pts[0][0]).toFixed(1)} ${Y(0)}Z`);
    } else { p.line.removeAttribute('d'); p.area.removeAttribute('d'); }
    if (guessed) p.gap.setAttribute('d', `M0 ${Y(0)}L${X(pts[0][0]).toFixed(1)} ${Y(pts[0][1]).toFixed(1)}`); else p.gap.removeAttribute('d');
    // where the average pace so far leads: out before the reset, or how much is used by then
    const elapsed = now - start;
    const rate = used / Math.max(elapsed, 1);
    let runsOut = null;
    let byReset = null;
    if (open && elapsed > lim.span * 0.08 && used >= 1) {
      const full = now + (100 - used) / rate;
      if (full < end) runsOut = full; else byReset = Math.min(100, used + rate * (end - now));
      const to = Math.min(full, end);
      p.proj.setAttribute('d', `M${X(now).toFixed(1)} ${Y(used).toFixed(1)}L${X(to).toFixed(1)} ${Y(Math.min(100, used + rate * (to - now))).toFixed(1)}`);
    } else p.proj.removeAttribute('d');
    p.now.setAttribute('x1', X(now).toFixed(1));
    p.now.setAttribute('x2', X(now).toFixed(1));
    p.dot.style.left = `${(X(now) / 3).toFixed(2)}%`;
    p.dot.style.top = `${Y(used).toFixed(2)}%`;
    const day = lim.span > 86400;
    const key = el('span', 'u-key');
    key.append(el('i'), document.createTextNode('even pace'));
    if (p.proj.hasAttribute('d')) key.append(el('i', 'proj'), document.createTextNode('this pace'));
    p.axis.replaceChildren(el('span', null, open ? clock(start, day) : 'Now'), key, el('span', null, open ? `Resets ${clock(end, day)}` : `+${span(lim.span)}`));
    if (!open) { p.foot.replaceChildren(document.createTextNode('Not started: it opens with your next message.')); return; }
    const foot = [document.createTextNode('Resets in '), el('b', null, span(end - now))];
    if (runsOut) foot.push(document.createTextNode(' · '), el('span', 'alarm', `runs out in ~${span(runsOut - now)} at this pace`));
    else if (byReset != null) foot.push(document.createTextNode(` · about ${Math.round(byReset)}% used by then at this pace`));
    p.foot.replaceChildren(...foot);
  }

  function setUsageOpen(open, remember) {
    usageOpen = open;
    $usagePanel.classList.toggle('open', open);
    $usagePill.setAttribute('aria-expanded', String(open));
    if (remember) { try { localStorage.setItem(`tmuxweb.usageOpen.${usageKind()}`, open ? '1' : '0'); } catch { /* private mode */ } }
    if (open) {
      for (const card of [...LIMITS.map((lim) => parts[lim.key].card), $spendCard]) { // draw the charts in again
        card.classList.remove('draw');
        void card.offsetWidth;
        card.classList.add('draw');
      }
    }
    labelUsage();
  }
  function labelUsage() {
    const said = LIMITS.filter((lim) => !parts[lim.key].gauge.hidden).map((lim) => `${lim.name}: ${parts[lim.key].num.dataset.value}% left`);
    if (!parts.pillSpend.hidden) said.push(`last 2 hours: ${money(usage.spend.recent)} at API prices`);
    const gemini = !parts.pillGemini.hidden ? ` Gemini: ${money(usage.gemini.recent)} in the last 2 hours at Google’s API prices.` : '';
    $usagePill.title = `Claude usage. ${said.join(', ')}.${gemini}`;
    $usagePill.setAttribute('aria-label', `${$usagePill.title}. ${usageOpen ? 'Hide' : 'Show'} the trend`);
  }
  $usagePill.addEventListener('click', () => setUsageOpen(!usageOpen, true));

  function renderUsage() {
    const limits = usage?.at != null && LIMITS.some((lim) => usage[lim.key]);
    const shown = limits || !!usage?.spend?.ready || !!usage?.gemini?.ready;
    $usagePill.hidden = $usagePanel.hidden = !shown;
    if (!shown) return;
    const fresh = !$usagePill.childElementCount;
    if (fresh) buildUsage();
    const now = Date.now() / 1000;
    for (const lim of LIMITS) {
      const p = parts[lim.key];
      const cur = usage[lim.key];
      p.gauge.hidden = p.card.hidden = !cur;
      if (!cur) continue;
      const left = Math.round(100 - (cur.resetsAt != null && cur.resetsAt <= now ? 0 : cur.used));
      p.gauge.dataset.sev = p.card.dataset.sev = severity(left);
      const ring = () => { p.ring.style.strokeDasharray = `${left} 100`; };
      if (fresh) requestAnimationFrame(() => requestAnimationFrame(ring)); else ring(); // from empty on the first answer
      countTo(p.num, left);
      countTo(p.big, left);
      drawLimit(lim, p, cur, now);
    }
    const age = usage.at != null ? now - usage.at : 0;
    $usagePill.classList.toggle('stale', age > 15 * 60);
    const problem = usage.error && USAGE_ERRORS[usage.error];
    $usageNote.textContent = usage.at == null ? problem || '' : problem || age > 15 * 60 ? `Updated ${ago(age).toLowerCase()}${problem ? ` · ${problem}` : ''}` : '';
    parts.pillSpend.hidden = !usage.spend?.ready;
    if (usage.spend?.ready) {
      parts.pillSpendNum.textContent = moneyShort(usage.spend.recent);
      parts.pillSpend.classList.toggle('alone', !limits);
    }
    // Gemini's part of the pill once it has been used this week (and its tab in the panel whenever agy is here at all)
    const geminiUsed = !!usage.gemini?.ready && (usage.gemini.week > 0 || usage.gemini.recent > 0);
    parts.pillGemini.hidden = !geminiUsed;
    if (geminiUsed) {
      parts.pillGeminiNum.textContent = moneyShort(usage.gemini.recent);
      parts.pillGemini.classList.toggle('alone', !limits && parts.pillSpend.hidden);
      parts.pillGemini.dataset.sev = severity(minLeft(usage.gemini.quota)); // a Gemini limit running low colors its number
    }
    renderTabs();
    renderSpend();
    if (usageOpen === null) {
      let saved = null;
      try { saved = localStorage.getItem(`tmuxweb.usageOpen.${usageKind()}`); } catch { /* private mode */ }
      requestAnimationFrame(() => setUsageOpen(saved === null ? usageKind() === 'desktop' : saved === '1', false));
    } else labelUsage();
  }

  // ---- the panel's two accounts, counted apart: Claude (its limits and its spend) and Gemini (its spend; agy's quota cannot be
  // read). Tabs at the top when there is a Gemini part at all; the choice is remembered in this browser.
  const $usageTabs = document.getElementById('usage-tabs');
  let provider = 'claude';
  try { if (localStorage.getItem('tmuxweb.usageTab') === 'gemini') provider = 'gemini'; } catch { /* private mode */ }
  const tabParts = {};
  function renderTabs() {
    const gemini = usage?.gemini;
    $usageTabs.hidden = !gemini;
    if (!gemini && provider === 'gemini') provider = 'claude';
    if (!tabParts.claude) {
      for (const key of ['claude', 'gemini']) {
        const b = el('button', `usage-tab ${key}`);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        const name = el('span', 'usage-tab-name');
        name.append(el('span', 'agent-glyph', AGENTS[key].glyph), document.createTextNode(AGENTS[key].label));
        const sub = el('span', 'usage-tab-sub');
        b.append(name, sub);
        b.addEventListener('click', () => {
          if (provider === key) return;
          provider = key;
          try { localStorage.setItem('tmuxweb.usageTab', key); } catch { /* private mode */ }
          hoverAt = -1;
          renderTabs();
          renderSpend();
          for (const card of [...LIMITS.map((lim) => parts[lim.key]?.card).filter(Boolean), $spendCard]) { card.classList.remove('draw'); void card.offsetWidth; card.classList.add('draw'); }
        });
        tabParts[key] = { b, sub };
        $usageTabs.append(b);
      }
    }
    const claudeLeft = LIMITS.filter((lim) => usage?.[lim.key]).map((lim) => `${parts[lim.key]?.num.dataset.value ?? '–'}% ${lim.short}`).join(' · ');
    tabParts.claude.sub.textContent = [claudeLeft && `${claudeLeft} left`, usage?.spend?.ready ? `${moneyShort(usage.spend.week)} wk` : ''].filter(Boolean).join(' · ') || 'limits and spend';
    const gLeft = minLeft(gemini?.quota);
    tabParts.gemini.sub.textContent = [gemini?.ready ? `${moneyShort(gemini.week)} · 7 d` : gemini ? 'reading…' : '', gemini?.quota?.groups.length ? `${Math.round(gLeft)}% left` : ''].filter(Boolean).join(' · ');
    for (const key of ['claude', 'gemini']) {
      tabParts[key].b.setAttribute('aria-selected', String(provider === key));
      tabParts[key].b.tabIndex = provider === key ? 0 : -1;
    }
    $usagePanel.dataset.provider = provider;
    $usageGrid.hidden = provider !== 'claude';
    renderGeminiLimits();
  }

  // ---- Gemini's limits as Google reports them for agy's login (api/usage gemini.quota): groups of models sharing a 5-hour and a
  // weekly limit, each a ring of what is left and when it resets, and single models below 100%. On Google AI Ultra the Gemini 4
  // models are in no group: they have no reported limit, which the card says rather than showing nothing.
  const $geminiLimits = document.getElementById('gemini-limits');
  const GQ_ERRORS = {
    'login expired': 'agy’s login here has expired; the numbers move again once agy runs',
    'not signed in': 'agy is signed out on this account',
    'unreadable login': 'agy’s login could not be read from the keyring',
    'login refused': 'Google refused agy’s login',
    'rate limited': 'Google asked to slow down; trying again later',
    unreachable: 'Google could not be reached; trying again',
  };
  const WINDOW_NAME = { '5h': '5-hour', weekly: 'Weekly', daily: 'Daily' };
  const minLeft = (q) => Math.min(100, ...(q?.groups || []).flatMap((g) => g.buckets.map((b) => b.left)));
  function gqRing(left) {
    const svg = svgEl('svg', { class: 'ring', viewBox: '0 0 36 36', 'aria-hidden': 'true' });
    const fill = svgEl('path', { class: 'ring-fill', d: RING, pathLength: 100 });
    fill.style.strokeDasharray = `${left} 100`;
    svg.append(svgEl('path', { class: 'ring-track', d: RING, pathLength: 100 }), fill);
    return svg;
  }
  function renderGeminiLimits() {
    const q = usage?.gemini?.quota;
    $geminiLimits.hidden = provider !== 'gemini' || !q;
    if ($geminiLimits.hidden) return;
    const now = Date.now() / 1000;
    const head = el('div', 'sp-head');
    const title = el('h3', null, 'Limits');
    if (q.plan) title.append(el('small', null, q.plan));
    head.append(title);
    const body = [head];
    for (const g of q.groups) {
      const row = el('div', 'gq-group');
      const name = el('div', 'gq-name');
      name.append(el('b', null, g.name || 'Models'), el('span', null, g.about));
      const gauges = el('div', 'gq-gauges');
      for (const b of g.buckets) {
        const open = b.resetsAt == null || b.resetsAt > now;
        const left = Math.round(open ? b.left : 100);
        const gauge = el('div', 'gq-gauge');
        gauge.dataset.sev = severity(left);
        const text = el('div', 'gq-text');
        const num = el('b', 'gq-num', String(left));
        const label = el('span', 'gq-label', `${WINDOW_NAME[b.window] || b.window || b.name} left`);
        text.append(num, label, el('span', 'gq-reset', b.resetsAt ? (open ? `resets in ${span(b.resetsAt - now)}` : 'reset') : ''));
        gauge.append(gqRing(left), text);
        gauge.title = `${b.name || b.window}: ${left}% left${b.resetsAt ? `, resets ${clock(b.resetsAt, true)}` : ''}`;
        gauges.append(gauge);
      }
      row.append(name, gauges);
      body.push(row);
    }
    const low = q.models.filter((m) => m.left < 100);
    if (low.length) {
      const list = el('div', 'gq-models');
      list.append(el('span', 'gq-models-label', 'Models below 100%'));
      for (const m of low.sort((a, b) => a.left - b.left)) {
        const chip = el('span', 'gq-chip');
        chip.dataset.sev = severity(m.left);
        chip.append(document.createTextNode(`${modelName(m.model.replace(/-(low|medium|high)$/, ''))}${/-(low|medium|high)$/.test(m.model) ? ` ${m.model.split('-').pop()}` : ''} `), el('b', null, `${Math.round(m.left)}%`));
        list.append(chip);
      }
      body.push(list);
    }
    const geminiCovered = q.groups.some((g) => /gemini/i.test(`${g.name} ${g.about}`));
    const notes = [];
    if (!q.groups.length && q.at == null) notes.push(GQ_ERRORS[q.error] || 'Asking Google for the limits…');
    else {
      if (!geminiCovered) notes.push(`Google reports no limit for the Gemini 4 models${q.plan ? ` on ${q.plan}` : ''}; the limits above are for the other models agy can run.`);
      if (q.error && GQ_ERRORS[q.error]) notes.push(`${GQ_ERRORS[q.error]}${q.at ? ` · updated ${ago(now - q.at).toLowerCase()}` : ''}.`);
    }
    body.push(el('p', 'gq-note', notes.join(' ')));
    $geminiLimits.replaceChildren(...body);
  }
  $usageTabs?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || $usageTabs.hidden) return;
    e.preventDefault();
    tabParts[provider === 'claude' ? 'gemini' : 'claude'].b.click();
    tabParts[provider].b.focus();
  });
  const spendData = () => (provider === 'gemini' ? usage?.gemini : usage?.spend);

  let spendRetry = null;
  async function loadUsage() {
    if (me?.usage === false) { usage = null; renderUsage(); return; } // not shown to this person (users.json `usage`)
    try {
      const res = await fetch('api/usage', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 403) usage = null; // same, asked before api/me answered
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
      else usage = await res.json();
    } catch { /* keep the last answer */ }
    renderUsage();
    // the first reading of the transcripts takes a few seconds: ask again soon rather than in a minute
    clearTimeout(spendRetry);
    if (((usage?.spend && !usage.spend.ready) || (usage?.gemini && !usage.gemini.ready)) && !document.hidden) spendRetry = setTimeout(loadUsage, 3000);
  }

  // ---- what Claude cost at API prices (api/usage `spend`): the week so far and the last two hours, each as a share of the weekly
  // limit too, what 1 % of the week costs, spend over the last 24 hours (half hours) or 7 days (4 hours of this clock) by
  // conversation: the five biggest of the range in their colors, all the rest grey, with a tooltip per bar (hover, tap or the
  // arrow keys), the same as a list (the legend and the numbers without hovering), and what the money went on.
  const $spendCard = document.getElementById('spend-card');
  const RANGES = { day: { short: '24 h', long: 'last 24 hours' }, week: { short: '7 d', long: 'last 7 days' } };
  let spendRange = 'day';
  try { if (localStorage.getItem('tmuxweb.spendRange') === 'week') spendRange = 'week'; } catch { /* private mode */ }
  const sp = {}; // the card's parts, built once
  let chart = null; // what the plot shows, for the hover layer
  let hoverAt = -1;
  const cap = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;
  const modelName = (m) => {
    const x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(m);
    if (x) return `${cap(x[1])} ${x[2]}${x[3] ? `.${x[3]}` : ''}`;
    const g = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-lite)?)-(low|medium|high|xhigh)$/.exec(m); // gemini-4-neon-high: Neon 4 · high
    if (g) return `${cap(g[2])} ${g[1]} · ${g[3]}`;
    const n = /^gemini-model-(\d+)$/.exec(m);
    return n ? `Gemini #${n[1]}` : m;
  };
  const niceCeil = (v) => {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].find((m) => v <= m * p * 1.0001) * p;
  };
  const shortWhen = (t) => { const d = new Date(t * 1000); return d.toLocaleString([], { weekday: 'short', hour: 'numeric', ...(d.getMinutes() ? { minute: '2-digit' } : {}) }); };
  const axisMoney = (v) => (v >= 1000 ? `$${+(v / 1000).toFixed(1)}k` : `$${+v.toFixed(2)}`);

  function buildSpend() {
    const head = el('div', 'sp-head');
    const title = el('h3', null, 'Spend');
    title.id = 'spend-title';
    sp.titleSmall = el('small', null, 'at API prices');
    title.append(sp.titleSmall);
    sp.seg = el('div', 'seg');
    sp.seg.setAttribute('role', 'group');
    sp.seg.setAttribute('aria-label', 'Range');
    for (const [key, range] of Object.entries(RANGES)) {
      const b = el('button', null, range.short);
      b.type = 'button';
      b.dataset.range = key;
      b.title = `Show the ${range.long}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        spendRange = key;
        try { localStorage.setItem('tmuxweb.spendRange', key); } catch { /* private mode */ }
        hoverAt = -1;
        renderSpend();
        $spendCard.classList.remove('draw');
        void $spendCard.offsetWidth;
        $spendCard.classList.add('draw');
      });
      sp.seg.append(b);
    }
    head.append(title, sp.seg);
    sp.tiles = el('div', 'sp-tiles');
    sp.plot = el('div', 'sp-plot');
    sp.plot.tabIndex = 0;
    sp.plot.setAttribute('role', 'img');
    sp.svg = svgEl('svg', { class: 'sp-chart', 'aria-hidden': 'true' });
    sp.empty = el('div', 'sp-empty');
    sp.tip = el('div', 'sp-tip');
    sp.tip.hidden = true;
    sp.plot.append(sp.svg, sp.empty, sp.tip);
    sp.axis = el('div', 'sp-axis');
    sp.axis.setAttribute('aria-hidden', 'true');
    const main = el('div', 'sp-main');
    main.append(sp.plot, sp.axis);
    sp.list = el('ol', 'sp-list');
    sp.mix = el('div', 'sp-mix');
    const body = el('div', 'sp-body'); // chart, list, mix: one column, or the list beside the other two on a wide screen
    body.append(main, sp.list, sp.mix);
    sp.note = el('p', 'sp-note');
    $spendCard.append(head, sp.tiles, body, sp.note);
    const at = (e) => {
      if (!chart) return -1;
      const r = sp.plot.getBoundingClientRect();
      return Math.min(chart.n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * chart.n)));
    };
    sp.plot.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') hover(at(e)); });
    sp.plot.addEventListener('pointerdown', (e) => hover(at(e)));
    sp.plot.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover(-1); });
    sp.plot.addEventListener('blur', () => hover(-1));
    sp.plot.addEventListener('keydown', (e) => {
      if (!chart) return;
      const to = { ArrowLeft: hoverAt < 0 ? chart.n - 1 : hoverAt - 1, ArrowRight: hoverAt < 0 ? chart.n - 1 : hoverAt + 1, Home: 0, End: chart.n - 1, Escape: -1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      hover(to < 0 ? -1 : Math.min(chart.n - 1, Math.max(0, to)));
    });
    document.addEventListener('pointerdown', (e) => { if (hoverAt >= 0 && !sp.plot.contains(e.target)) hover(-1); });
    if ('ResizeObserver' in window) new ResizeObserver(() => drawChart()).observe(sp.plot);
  }

  // The buckets of the range and each conversation's numbers in them.
  function spendView(s) {
    let buckets;
    let of;
    if (spendRange === 'day') {
      const { start, step, n } = s.halves;
      buckets = Array.from({ length: n }, (_, i) => ({ t0: start + i * step, t1: start + (i + 1) * step }));
      of = (g) => g.halves;
    } else {
      // 4-hour steps of this browser's clock (midnight, 4 AM, ...), summed from the hourly numbers; a DST change just makes one longer
      const { start, step, n } = s.hours;
      const all = [];
      const into = new Array(n);
      for (let h = 0; h < n; h++) {
        const t = start + h * step;
        const d = new Date(t * 1000);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${Math.floor(d.getHours() / 4)}`;
        if (all.at(-1)?.key !== key) all.push({ key, t0: t, t1: t + step }); else all.at(-1).t1 = t + step;
        into[h] = all.length - 1;
      }
      const last = into[Math.min(n - 1, Math.max(0, Math.floor((usage.now - start) / step)))];
      const first = Math.max(0, last - 41);
      buckets = all.slice(first, last + 1);
      of = (g) => {
        const out = new Array(buckets.length).fill(0);
        g.hours.forEach((v, h) => { const b = into[h] - first; if (v && b >= 0 && b < out.length) out[b] += v; });
        return out;
      };
    }
    const keyOf = (g) => `${g.label}\n${g.sub}`;
    const all = s.groups.map((g) => { const vals = of(g); return { g, vals, total: vals.reduce((a, b) => a + b, 0) }; });
    const shown = all.filter((x) => !x.g.rest && x.total > 0).sort((a, b) => b.total - a.total).slice(0, 5);
    // a color follows its conversation: the week's five biggest keep theirs in either range, the others take the free ones in order
    const reserved = s.groups.filter((g) => !g.rest && g.cost > 0).slice(0, 5).map(keyOf);
    const taken = new Set();
    for (const x of shown) { const i = reserved.indexOf(keyOf(x.g)); if (i >= 0) { x.slot = i + 1; taken.add(x.slot); } }
    for (const x of shown) if (!x.slot) { x.slot = [1, 2, 3, 4, 5].find((k) => !taken.has(k)); taken.add(x.slot); }
    const series = shown.map((x) => ({ slot: x.slot, label: x.g.label, sub: x.g.sub, live: x.g.live, vals: x.vals, total: x.total }));
    const other = { slot: 0, label: 'Everything else', sub: 'other conversations', live: false, vals: new Array(buckets.length).fill(0), total: 0 };
    for (const x of all) if (!shown.includes(x)) { x.vals.forEach((v, i) => { other.vals[i] += v; }); other.total += x.total; }
    if (other.total > 0.00005) series.push(other);
    return { buckets, series, total: series.reduce((a, x) => a + x.total, 0) };
  }

  // A rounded top on the top segment of a bar only; the base stays square on the baseline.
  const topRounded = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h);
    return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
  };
  function drawChart() {
    const view = sp.view;
    if (!view || $spendCard.hidden) return;
    const W = sp.plot.clientWidth;
    const H = sp.plot.clientHeight;
    if (!W || !H) return;
    const n = view.buckets.length;
    const totals = view.buckets.map((_, i) => view.series.reduce((a, x) => a + x.vals[i], 0));
    const top = niceCeil(Math.max(...totals));
    const head = 14; // room for the top gridline's label
    const scale = (H - 1 - head) / top;
    const Yv = (v) => H - 1 - v * scale;
    const svg = sp.svg;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    const t0 = view.buckets[0].t0;
    const t1 = view.buckets.at(-1).t1;
    const X = (t) => ((t - t0) / (t1 - t0)) * W;
    if (spendRange === 'day') { // the last two hours, as on the session cards
      const x = X(Math.max(t0, usage.now - 7200));
      svg.append(svgEl('rect', { class: 'band', x, y: 0, width: W - x, height: H, rx: 4 }));
    }
    const labels = [];
    for (const v of [top / 2, top]) {
      const y = Math.round(Yv(v)) + 0.5;
      svg.append(svgEl('line', { class: 'grid', x1: 0, x2: W, y1: y, y2: y }));
      const label = svgEl('text', { class: 'ylab', x: 1, y: y - 4 });
      label.textContent = axisMoney(v);
      labels.push(label); // drawn over the bars, with a halo of the surface
    }
    const slot = W / n;
    const bw = Math.max(1.5, Math.min(24, slot - 2));
    const GAP = 2;
    const bars = [];
    view.buckets.forEach((_, i) => {
      const g = svgEl('g', { class: 'bar' });
      const x = i * slot + (slot - bw) / 2;
      const segs = view.series.map((s) => ({ s, h: s.vals[i] * scale })).filter((p) => p.h > 0);
      let y = H - 1;
      segs.forEach((p, k) => {
        const last = k === segs.length - 1;
        let h = p.h - (k ? GAP : 0);
        if (h < 1) { if (!last) return; h = Math.max(h, 1.5); }
        const yTop = y - (k ? GAP : 0) - h;
        if (last) g.append(svgEl('path', { class: `f${p.s.slot}`, d: topRounded(x, yTop, bw, h, 4) }));
        else g.append(svgEl('rect', { class: `f${p.s.slot}`, x, y: yTop, width: bw, height: h }));
        y = yTop;
      });
      svg.append(g);
      bars.push(g);
    });
    svg.append(svgEl('line', { class: 'base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }), ...labels);
    chart = { n, slot, bars, view, W };
    sp.empty.textContent = view.total > 0 ? '' : `Nothing spent in the ${RANGES[spendRange].long}`;
    sp.empty.hidden = view.total > 0;
    // time axis: 24 h every six hours of this clock (midnight as the weekday), 7 d each day's name in the middle of its part
    const ticks = [];
    if (spendRange === 'day') {
      const d = new Date(t0 * 1000);
      d.setMinutes(0, 0, 0);
      for (d.setHours(d.getHours() + 1); d.getTime() / 1000 < t1; d.setHours(d.getHours() + 1)) {
        if (d.getHours() % 6) continue;
        const t = d.getTime() / 1000;
        ticks.push({ x: X(t), text: d.getHours() ? d.toLocaleTimeString([], { hour: 'numeric' }) : d.toLocaleDateString([], { weekday: 'short' }) });
      }
      ticks.push({ x: W, text: 'now', cls: 'end' });
    } else {
      const d = new Date(t0 * 1000);
      d.setHours(0, 0, 0, 0);
      for (; d.getTime() / 1000 < t1; d.setDate(d.getDate() + 1)) {
        const a = Math.max(t0, d.getTime() / 1000);
        const next = new Date(d);
        next.setDate(next.getDate() + 1);
        const b = Math.min(t1, next.getTime() / 1000);
        if (X(b) - X(a) < 30) continue;
        ticks.push({ x: (X(a) + X(b)) / 2, text: d.toLocaleDateString([], { weekday: 'short' }) });
        if (a > t0) { const x = Math.round(X(a)) + 0.5; svg.insertBefore(svgEl('line', { class: 'grid', x1: x, x2: x, y1: head, y2: H - 1 }), svg.firstChild); }
      }
    }
    sp.axis.replaceChildren(...ticks.filter((t, i) => t.cls || ticks.every((u, j) => j === i || !u.cls || Math.abs(u.x - t.x) > 46)).map((t) => {
      const span = el('span', t.cls || null, t.text);
      span.style.left = `${(t.x / W) * 100}%`;
      return span;
    }));
    const busiest = totals.indexOf(Math.max(...totals));
    sp.plot.setAttribute('aria-label', view.total > 0 ? `Spend over the ${RANGES[spendRange].long}: ${money(view.total)}, the most (${money(totals[busiest])}) in ${span(view.buckets[busiest].t1 - view.buckets[busiest].t0)} from ${clock(view.buckets[busiest].t0, spendRange === 'week')}. Arrow keys read each bar.` : sp.empty.textContent);
    hover(hoverAt < n ? hoverAt : -1);
  }

  function hover(i) {
    if (!chart || i < 0) {
      hoverAt = -1;
      sp.plot?.classList.remove('hovering');
      if (sp.tip) sp.tip.hidden = true;
      chart?.bars.forEach((b) => b.classList.remove('on'));
      return;
    }
    hoverAt = i;
    sp.plot.classList.add('hovering');
    chart.bars.forEach((b, k) => b.classList.toggle('on', k === i));
    const b = chart.view.buckets[i];
    const week = spendRange === 'week';
    const rows = chart.view.series.map((s) => ({ s, v: s.vals[i] })).filter((r) => r.v > 0).sort((a, c) => c.v - a.v);
    const total = rows.reduce((a, r) => a + r.v, 0);
    const headRow = el('div', 'sp-tip-head');
    const end = Math.min(b.t1, usage.now);
    headRow.append(el('span', null, `${clock(b.t0, week)}–${end >= usage.now - 60 ? 'now' : clock(b.t1)}`), el('b', null, money(total)));
    sp.tip.replaceChildren(headRow, ...(rows.length ? rows.map(({ s, v }) => {
      const row = el('div', `sp-tip-row k${s.slot}`);
      row.append(el('i'), el('b', null, money(v)), el('span', null, s.label));
      return row;
    }) : [el('div', 'sp-tip-row', 'Nothing spent')]));
    sp.tip.hidden = false;
    // beside the bar, on the side with more room, so it never covers the bar it describes
    const x = (i + 0.5) * chart.slot;
    const w = sp.tip.offsetWidth;
    const left = x > chart.W / 2 ? Math.max(0, x - chart.slot / 2 - 8 - w) : Math.min(chart.W - w, x + chart.slot / 2 + 8);
    sp.tip.style.transform = `translate(${Math.round(left)}px, 0)`;
  }

  function drawTiles(s) {
    if (provider === 'gemini') { drawGeminiTiles(s); return; }
    const rate = s.rate;
    const tile = (label, value, sub, cls) => {
      const t = el('div', `tile${cls ? ` ${cls}` : ''}`);
      const subNode = el('span', 'tile-sub');
      subNode.append(...sub);
      t.append(el('span', 'tile-label', label), el('b', 'tile-val', value), subNode);
      return t;
    };
    const share = (p) => (p == null ? [] : [el('b', null, weekPct(p)), ' of the week']);
    const days = rate ? Math.max(1, Math.round((usage.now - rate.from) / 86400)) : 0;
    sp.tiles.replaceChildren(
      tile('This week', money(s.week), [...share(s.pct?.[0]), `${s.pct ? ' · ' : ''}since ${shortWhen(s.weekStart)}`]),
      tile('Last 2 hours', money(s.recent), share(s.pct?.[1]).length ? share(s.pct?.[1]) : ['at API prices'], 'hot'),
      tile('1% of the week', rate ? `≈ ${money(1 / rate.perDollar)}` : '—', [rate ? `measured over ${days} day${days === 1 ? '' : 's'}` : 'needs more usage history'], 'rate'),
    );
  }

  // Gemini has no limit to measure against: the week's money and conversations, the last two hours, and the tokens.
  function drawGeminiTiles(s) {
    const tile = (label, value, sub, cls) => {
      const t = el('div', `tile${cls ? ` ${cls}` : ''}`);
      const subNode = el('span', 'tile-sub');
      subNode.append(...sub);
      t.append(el('span', 'tile-label', label), el('b', 'tile-val', value), subNode);
      return t;
    };
    const n = s.conversations;
    sp.tiles.replaceChildren(
      tile('Last 7 days', money(s.week), [el('b', null, String(n)), ` conversation${n === 1 ? '' : 's'}`]),
      tile('Last 2 hours', money(s.recent), ['at API prices'], 'hot'),
      tile(`Tokens · ${RANGES[spendRange].short}`, tokens(s.tokens[spendRange]), ['input, cached and output'], 'rate'),
    );
  }

  function drawList(view, s) {
    const max = Math.max(0.0001, ...view.series.map((x) => x.total));
    sp.list.setAttribute('aria-label', `Spend by conversation, ${RANGES[spendRange].long}`);
    if (!view.series.length) { sp.list.replaceChildren(el('li', 'sp-row sp-sub', `Nothing spent in the ${RANGES[spendRange].long}.`)); return; }
    sp.list.replaceChildren(...view.series.map((x) => {
      const li = el('li', `sp-row k${x.slot}`);
      const name = el('span', 'sp-name');
      name.append(el('span', null, x.label));
      if (x.live) { const open = el('span', 'sp-open', 'open'); open.title = 'Open now in a tmux session'; name.append(open); }
      const prop = el('span', 'sp-prop');
      const fill = el('i');
      fill.style.width = `${Math.max(1.5, (x.total / max) * 100)}%`;
      prop.append(fill);
      const pct = s.rate ? weekPct(x.total * s.rate.perDollar) : '';
      li.title = `${x.label}${x.sub ? ` · ${x.sub}` : ''}: ${money(x.total)} in the ${RANGES[spendRange].long}${pct ? `, ${pct} of the weekly limit` : ''}`;
      li.append(el('span', 'sp-sw'), name, el('span', 'sp-amt', money(x.total)), el('span', 'sp-sub', x.sub || ''), el('span', 'sp-rowpct', pct ? `${pct} wk` : ''), prop);
      return li;
    }));
  }

  // one whole in up to four parts (the rest folded into the fourth), shades of one blue so they never look like conversations
  function mixPart(title, parts) {
    const box = el('div', 'mix');
    const total = parts.reduce((a, p) => a + p.value, 0);
    let list = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
    if (list.length > 4) list = [...list.slice(0, 3), { name: 'Other', value: list.slice(3).reduce((a, p) => a + p.value, 0) }];
    const head = el('div', 'mix-head');
    head.append(el('span', null, title), el('span', null, money(total)));
    const bar = el('div', 'mix-bar');
    bar.setAttribute('role', 'img');
    const key = el('div', 'mix-key');
    const pctOf = (v) => { const p = (v / total) * 100; return p < 1 ? '<1%' : `${Math.round(p)}%`; };
    bar.setAttribute('aria-label', `${title}: ${list.map((p) => `${p.name} ${pctOf(p.value)}`).join(', ') || 'nothing'}`);
    list.forEach((p, i) => {
      const part = el('i', `q${i + 1}`);
      part.style.flex = `${p.value} 1 0`;
      part.title = `${p.name}: ${money(p.value)} (${pctOf(p.value)})`;
      bar.append(part);
      const item = el('span', `q${i + 1}`, `${p.name} `);
      item.append(el('b', null, pctOf(p.value)));
      key.append(item);
    });
    box.append(head, bar, key);
    return box;
  }

  function renderSpend() {
    const s = spendData();
    $spendCard.hidden = !s;
    if (!s) return;
    if (!sp.seg) buildSpend();
    const gemini = provider === 'gemini';
    $spendCard.dataset.provider = provider;
    sp.titleSmall.textContent = gemini ? 'at Google’s API prices' : 'at API prices';
    for (const b of sp.seg.children) b.setAttribute('aria-pressed', String(b.dataset.range === spendRange));
    $spendCard.classList.toggle('wait', !s.ready);
    if (!s.ready) {
      if (!sp.view) {
        sp.tiles.replaceChildren();
        sp.empty.hidden = false;
        sp.empty.textContent = gemini ? 'Reading Gemini’s conversations…' : 'Reading Claude’s transcripts…';
      }
      sp.note.textContent = `Counting what ${gemini ? 'Gemini’s' : 'Claude’s'} conversations on this machine cost; the first time takes a few seconds.`;
      return;
    }
    drawTiles(s);
    sp.view = spendView(s);
    drawChart();
    drawList(sp.view, s);
    const TOKEN_KINDS = gemini ? [['read', 'Cached input'], ['input', 'Input'], ['output', 'Response'], ['thinking', 'Thinking']]
      : [['read', 'Cache reads'], ['write', 'Cache writes'], ['output', 'Output'], ['input', 'Input']];
    sp.mix.replaceChildren(
      mixPart(`Tokens · ${RANGES[spendRange].long}`, TOKEN_KINDS.map(([k, name]) => ({ name, value: s.kinds[spendRange][k] }))),
      mixPart(`Models · ${RANGES[spendRange].long}`, s.models[spendRange].map((m) => ({ name: modelName(m.model), value: m.cost }))),
    );
    if (gemini) {
      sp.note.textContent = 'What the same tokens would cost on Google’s Gemini API at list prices (thinking billed as output), from every generation in the Antigravity CLI’s (agy) conversations on this machine, subagents included. Counted apart from Claude; agy’s own quota cannot be read here, so there is no share of a limit.';
      return;
    }
    const rate = s.rate;
    sp.note.textContent = `What the same tokens would cost on the API, from each answer in the transcripts of Claude Code on this machine (subagents included). ${rate
      ? `Share of the week: the weekly limit rose ${rate.pct}% while ${money(rate.cost)} was spent here since ${new Date(rate.from * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}; use of this Claude login elsewhere (claude.ai, another computer) makes the shares read a little high.`
      : 'A share of the weekly limit shows once there is enough usage history to compare with.'}`;
  }

  async function load() {
    const request = ++loadRequest;
    $refresh.classList.add('spin');
    try {
      if (!me || me.canViewOthers || meStatus !== 200) await loadMe(); // people and counts change; a plain user needs it only once
      if (me.admin || accounts?.admin || me.allowed === false || meStatus !== 200) await loadAccounts();
      if (request !== loadRequest) return;
      renderAccounts();
      if (!accountUsable()) return;
      if (meStatus !== 200) throw new Error(`HTTP ${meStatus}`);
      const query = me.canViewOthers ? `?${[...selected].map((v) => `owner=${encodeURIComponent(v)}`).join('&')}` : '';
      const res = await fetch(`api/sessions${query}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request !== loadRequest) return;
      render(data);
      $notice.hidden = true;
    } catch (e) {
      if (request !== loadRequest) return;
      meStatus = 0; // ask again next time: this account's backend may have just been turned off
      $notice.textContent = 'Could not load sessions. Retrying automatically. If this continues, refresh and sign in again.';
      $notice.hidden = false;
      if (!lastJson) $list.replaceChildren();
    } finally {
      if (request === loadRequest) $refresh.classList.remove('spin');
    }
  }

  let usageTimer = null;
  const start = () => {
    load(); clearInterval(timer); timer = setInterval(load, 4000);
    loadUsage(); clearInterval(usageTimer); usageTimer = setInterval(loadUsage, 60_000);
  };
  const stop = () => { clearInterval(timer); timer = null; clearInterval(usageTimer); usageTimer = null; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('pageshow', (e) => { if (e.persisted) start(); });
  $refresh.addEventListener('click', () => { load(); loadUsage(); });
  // ---- rename: a dialog with the name in it; the same rules and the same request as renaming from inside a session
  const NAME_RULE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,47}$/u;
  $renameCancel.addEventListener('click', () => { if (!renaming) $renameDialog.close(); });
  $renameDialog.addEventListener('cancel', (event) => { if (renaming) event.preventDefault(); });
  $renameDialog.addEventListener('close', () => {
    const card = [...$list.children].find((node) => node.dataset.sessionId === renameTarget?.id);
    renameTarget = null;
    (card?.querySelector('.session-rename') || $refresh).focus();
  });
  $renameInput.addEventListener('input', () => { $renameInput.removeAttribute('aria-invalid'); $renameError.hidden = true; });
  $renameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!renameTarget || renaming) return;
    const target = renameTarget;
    const next = $renameInput.value.trim();
    const fail = (message) => { $renameInput.setAttribute('aria-invalid', 'true'); $renameError.textContent = message; $renameError.hidden = false; $renameInput.focus(); };
    if (!NAME_RULE.test(next)) return fail('Use 1–48 characters starting with a letter or number. Letters, numbers, spaces, - and _ are allowed.');
    if (next === target.name) { $renameDialog.close(); return; }
    renaming = true;
    $renameSave.disabled = $renameCancel.disabled = $renameInput.disabled = true;
    $renameSave.textContent = 'Saving…';
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(target.id)}`, {
        method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: next, instance: target.instance }),
      });
      if (res.status === 409) throw new Error('That name is already in use. Choose another name.');
      if (res.status === 404) throw new Error('This session has ended. Refresh the list.');
      if (!res.ok) throw new Error('Could not rename the session. Try again, or refresh and sign in again if this continues.');
      const saved = (await res.json()).name || next;
      if (latestData) render({ ...latestData, sessions: latestData.sessions.map((s) => (s.id === target.id && s.instance === target.instance ? { ...s, name: saved } : s)) });
      $renameDialog.close();
      await load();
      const again = [...$list.children].find((node) => node.dataset.sessionId === target.id); // the list was just re-rendered
      (again?.querySelector('.session-rename') || $refresh).focus();
    } catch (error) {
      renaming = false;
      $renameSave.disabled = $renameCancel.disabled = $renameInput.disabled = false;
      $renameSave.textContent = 'Save';
      fail(error.message);
      return;
    }
    renaming = false;
    $renameSave.disabled = $renameCancel.disabled = $renameInput.disabled = false;
    $renameSave.textContent = 'Save';
  });
  // ---- share: Off / View / Control for each person of this account who could get it
  function openShare(s) {
    if (sharing || $shareDialog.open) return;
    shareTarget = { id: s.id, instance: s.instance };
    document.getElementById('share-name').textContent = s.name;
    const current = new Map((s.share || []).map((p) => [p.email, p.level]));
    $sharePeople.replaceChildren(...me.sharePeople.filter((p) => p.email !== s.owner?.email).map((p, i) => {
      const row = el('div', 'share-row');
      const who = el('div', 'share-who', p.name);
      who.append(el('small', null, p.email));
      const levels = el('div', 'share-levels');
      levels.setAttribute('role', 'radiogroup');
      levels.setAttribute('aria-label', `Share with ${p.name}`);
      for (const [value, label] of [['', 'Off'], ['view', 'View'], ['full', 'Control']]) {
        const option = el('label');
        const input = el('input');
        input.type = 'radio';
        input.name = `share-${i}`;
        input.value = value;
        input.dataset.email = p.email;
        input.checked = (current.get(p.email) || '') === value;
        option.append(input, el('span', null, label));
        levels.append(option);
      }
      row.append(who, levels);
      return row;
    }));
    $shareError.hidden = true;
    $shareDialog.showModal();
    $sharePeople.querySelector('input:checked')?.focus();
  }
  $shareCancel.addEventListener('click', () => { if (!sharing) $shareDialog.close(); });
  $shareDialog.addEventListener('cancel', (event) => { if (sharing) event.preventDefault(); });
  $shareDialog.addEventListener('close', () => {
    const card = [...$list.children].find((node) => node.dataset.sessionId === shareTarget?.id);
    shareTarget = null;
    (card?.querySelector('.session-share') || $refresh).focus();
  });
  $shareSave.addEventListener('click', async () => {
    if (!shareTarget || sharing) return;
    const share = {};
    for (const input of $sharePeople.querySelectorAll('input:checked')) if (input.value) share[input.dataset.email] = input.value;
    sharing = true;
    $shareSave.disabled = $shareCancel.disabled = true;
    $shareSave.textContent = 'Saving…';
    $shareError.hidden = true;
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(shareTarget.id)}/share`, {
        method: 'PUT', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance: shareTarget.instance, share }),
      });
      if (res.status === 404) throw new Error('This session has ended. Refresh the list.');
      if (!res.ok) throw new Error('Could not change who it is shared with. Try again, or refresh and sign in again if this continues.');
      $shareDialog.close();
      await load();
    } catch (error) {
      $shareError.textContent = error.message;
      $shareError.hidden = false;
    } finally {
      sharing = false;
      $shareSave.disabled = $shareCancel.disabled = false;
      $shareSave.textContent = 'Save';
    }
  });
  $closeCancel.addEventListener('click', () => { if (!closing) $closeDialog.close(); });
  $closeDialog.addEventListener('cancel', (event) => { if (closing) event.preventDefault(); });
  $closeDialog.addEventListener('close', () => {
    const card = [...$list.children].find(node => node.dataset.sessionId === closeTarget?.id);
    closeTarget = null;
    (card?.querySelector('.session-close') || $refresh).focus();
  });
  $closeConfirm.addEventListener('click', async () => {
    if (!closeTarget || closing) return;
    const target = closeTarget;
    closing = true;
    $closeConfirm.disabled = $closeCancel.disabled = true;
    $closeConfirm.textContent = 'Closing…';
    $closeError.hidden = true;
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(target.id)}`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, instance: target.instance }),
      });
      if (!res.ok && res.status !== 404) throw new Error('Could not close the session. Try again, or refresh and sign in again if this continues.');
      if (latestData) render({ ...latestData, sessions: latestData.sessions.filter(s => s.id !== target.id || s.instance !== target.instance) });
      $closeDialog.close();
      await load();
    } catch (error) {
      $closeError.textContent = error.message;
      $closeError.hidden = false;
    } finally {
      closing = false;
      $closeConfirm.disabled = $closeCancel.disabled = false;
      $closeConfirm.textContent = 'Close session';
    }
  });
  $create.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!$create.reportValidity()) return;
    const name = $name.value;
    $createButton.disabled = true;
    $createButton.textContent = 'Creating…';
    $createError.hidden = true;
    try {
      const res = await fetch('api/sessions', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (res.status === 409) throw new Error('That name is already in use. Choose another name or open the existing session below.');
      if (!res.ok) throw new Error(`Creation failed (HTTP ${res.status}). Try again or refresh and sign in again.`);
      const session = await res.json();
      location.assign(`term.html?s=${encodeURIComponent(session.name)}&id=${encodeURIComponent(session.id)}&instance=${encodeURIComponent(session.instance)}`);
    } catch (error) {
      $createError.textContent = error.message || 'Could not create the session. Please try again.';
      $createError.hidden = false;
      $createButton.disabled = false;
      $createButton.textContent = 'Create & open';
    }
  });
  start();
})();
