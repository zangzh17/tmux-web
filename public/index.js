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

  // How full a Claude session's conversation is: a small bar, amber from half, red from 80%. Just compacted: not known yet.
  function contextMeter({ tokens: used, window, compacted }) {
    if (compacted) {
      const meter = el('span', 'ctx compacted', 'ctx compacted');
      meter.prepend(el('span', 'ctx-bar'));
      meter.title = 'Claude just compacted this conversation; the size shows again after its next answer';
      return meter;
    }
    const pct = Math.min(100, Math.round((used / window) * 100));
    const meter = el('span', `ctx${pct >= 80 ? ' bad' : pct >= 50 ? ' warn' : ''}`);
    meter.title = `Claude context: ${tokens(used)} of ${tokens(window)} tokens (${pct}%)`;
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Claude context used');
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
    const a = el('a', 'card');
    a.href = `term.html?s=${encodeURIComponent(s.name)}&id=${encodeURIComponent(s.id)}&instance=${encodeURIComponent(s.instance)}`;
    const row = el('div', 'row');
    row.append(el('span', 'name', s.name));
    const meta = el('div', 'meta');
    if (s.context) meta.append(contextMeter(s.context));
    meta.append(...ownerTag(s));
    meta.append(el('span', null, `${s.windows} ${s.windows === 1 ? 'window' : 'windows'}`));
    meta.append(s.attached > 0 ? el('span', 'badge-on', `● Attached ×${s.attached}`) : el('span', null, 'Detached'));
    meta.append(el('span', null, ago(Math.max(0, now - s.activity))));
    const where = el('div', 'where');
    where.append(el('b', null, s.command), document.createTextNode(` · ${s.path}`));
    a.append(row, meta, where);
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
    const json = JSON.stringify({ data, previewLines, who: me?.email, sharePeople: me?.sharePeople });
    if (json === lastJson) return;
    lastJson = json;
    $listTitle.textContent = data.sessions.length ? `${data.sessions.length} ${data.sessions.length === 1 ? 'session' : 'sessions'}` : 'Sessions';
    $list.replaceChildren();
    if (!data.sessions.length) {
      const li = el('li', 'empty');
      li.textContent = 'No tmux sessions yet. Create one above to get started.';
      $list.append(li);
      return;
    }
    for (const s of data.sessions) $list.append(card(s, data.now));
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
    const chev = svgEl('svg', { class: 'usage-chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    chev.append(svgEl('path', { d: 'M3 4.5 6 7.5 9 4.5' }));
    $usagePill.append(chev);
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
      for (const lim of LIMITS) { // draw the charts in again
        parts[lim.key].card.classList.remove('draw');
        void parts[lim.key].card.offsetWidth;
        parts[lim.key].card.classList.add('draw');
      }
    }
    labelUsage();
  }
  function labelUsage() {
    const said = LIMITS.filter((lim) => !parts[lim.key].gauge.hidden).map((lim) => `${lim.name}: ${parts[lim.key].num.dataset.value}% left`);
    $usagePill.title = `Claude usage. ${said.join(', ')}`;
    $usagePill.setAttribute('aria-label', `${$usagePill.title}. ${usageOpen ? 'Hide' : 'Show'} the trend`);
  }
  $usagePill.addEventListener('click', () => setUsageOpen(!usageOpen, true));

  function renderUsage() {
    const shown = usage?.at != null && LIMITS.some((lim) => usage[lim.key]);
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
    const age = now - usage.at;
    $usagePill.classList.toggle('stale', age > 15 * 60);
    const problem = usage.error && USAGE_ERRORS[usage.error];
    $usageNote.textContent = problem || age > 15 * 60 ? `Updated ${ago(age).toLowerCase()}${problem ? ` · ${problem}` : ''}` : '';
    if (usageOpen === null) {
      let saved = null;
      try { saved = localStorage.getItem(`tmuxweb.usageOpen.${usageKind()}`); } catch { /* private mode */ }
      requestAnimationFrame(() => setUsageOpen(saved === null ? usageKind() === 'desktop' : saved === '1', false));
    } else labelUsage();
  }

  async function loadUsage() {
    try {
      const res = await fetch('api/usage', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      usage = await res.json();
    } catch { /* keep the last answer */ }
    renderUsage();
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
