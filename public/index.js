(() => {
  const $list = document.getElementById('list');
  const $notice = document.getElementById('notice');
  const $refresh = document.getElementById('refresh');
  const $create = document.getElementById('create');
  const $name = document.getElementById('session-name');
  const $createButton = document.getElementById('create-button');
  const $createError = document.getElementById('create-error');
  const $previewButtons = document.querySelectorAll('#preview-options button');
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
  let closeTarget = null;
  let closing = false;
  let renameTarget = null;
  let renaming = false;
  let loadRequest = 0;
  document.getElementById('host').textContent = location.hostname;

  const PREVIEW_LINES = [0, 1, 2, 5, 7, 10, 15, 20, 30, 50];
  let previewLines = 7;
  try {
    const saved = localStorage.getItem('tmuxweb.previewLines');
    if (saved !== null && PREVIEW_LINES.includes(Number(saved))) previewLines = Number(saved);
  } catch { /* private mode */ }
  // Whose sessions to list: 'me' (started here), 'local' (started outside the web page) and other people's emails.
  // Only people the server says we may view are offered; it also ignores anything we are not allowed to ask for.
  let me = null; // from /api/me; null until known, { canViewOthers: false } on a server without it
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

  // Everything about owners is multi-user: a server without it (no users.json) says `multiUser: false` and none of it is shown.
  function ownerTag(s) {
    if (!me?.multiUser || s.mine) return [];
    if (!s.owner) return [el('span', 'owner-tag local', 'Local')];
    return [el('span', `owner-tag${s.access === 'view' ? ' view' : ''}`, s.owner.name), ...(s.access === 'view' ? [el('span', 'owner-tag view', 'View only')] : [])];
  }

  function card(s, now) {
    const a = el('a', 'card');
    a.href = `term.html?s=${encodeURIComponent(s.name)}&id=${encodeURIComponent(s.id)}&instance=${encodeURIComponent(s.instance)}`;
    const row = el('div', 'row');
    row.append(el('span', 'name', s.name));
    const meta = el('div', 'meta');
    meta.append(...ownerTag(s));
    meta.append(el('span', null, `${s.windows} ${s.windows === 1 ? 'window' : 'windows'}`));
    meta.append(s.attached > 0 ? el('span', 'badge-on', `● Attached ×${s.attached}`) : el('span', null, 'Detached'));
    meta.append(el('span', null, ago(Math.max(0, now - s.activity))));
    const where = el('div', 'where');
    where.append(el('b', null, s.command), document.createTextNode(` · ${s.path}`));
    a.append(row, meta, where);
    if (previewLines && s.preview && s.preview.length) {
      const preview = el('pre', 'peek');
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
    else { actions.append(rename, close); li.append(a, actions); }
    return li;
  }

  function render(data) {
    latestData = data;
    const json = JSON.stringify({ data, previewLines, who: me?.email });
    if (json === lastJson) return;
    lastJson = json;
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
    $whoami.hidden = !(me?.multiUser && me.email);
    if (!$whoami.hidden) $whoami.textContent = `Signed in as ${me.name} · ${me.email}`;
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
    try {
      const res = await fetch('api/me', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      me = await res.json();
    } catch { me ||= { canViewOthers: false }; }
    sanitizeSelection();
    renderOwners();
  }

  function updatePreviewButtons() {
    for (const button of $previewButtons) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.lines) === previewLines));
    }
  }
  for (const button of $previewButtons) {
    button.addEventListener('click', () => {
      previewLines = Number(button.dataset.lines);
      try { localStorage.setItem('tmuxweb.previewLines', String(previewLines)); } catch { /* private mode */ }
      updatePreviewButtons();
      if (latestData) render(latestData);
    });
  }
  updatePreviewButtons();

  async function load() {
    const request = ++loadRequest;
    $refresh.classList.add('spin');
    try {
      if (!me || me.canViewOthers) await loadMe(); // people and counts change; a plain user needs it only once
      const query = me.canViewOthers ? `?${[...selected].map((v) => `owner=${encodeURIComponent(v)}`).join('&')}` : '';
      const res = await fetch(`api/sessions${query}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request !== loadRequest) return;
      render(data);
      $notice.hidden = true;
    } catch (e) {
      if (request !== loadRequest) return;
      $notice.textContent = 'Could not load sessions. Retrying automatically. If this continues, refresh and sign in again.';
      $notice.hidden = false;
      if (!lastJson) $list.replaceChildren();
    } finally {
      if (request === loadRequest) $refresh.classList.remove('spin');
    }
  }

  const start = () => { load(); clearInterval(timer); timer = setInterval(load, 4000); };
  const stop = () => { clearInterval(timer); timer = null; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('pageshow', (e) => { if (e.persisted) start(); });
  $refresh.addEventListener('click', load);
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
