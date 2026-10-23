(() => {
  const params = new URLSearchParams(location.search);
  const requestedId = params.get('id');
  const requestedInstance = params.get('instance');
  let name = params.get('s');
  if (!name && !requestedId) { location.replace('./'); return; }
  // The build this page really runs (the ?v= of its own script tag); the commands menu shows it, so a stale page is easy to spot.
  const BUILD = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || '?'; } catch { return '?'; } })();
  let sessionId = null;
  let sessionInstance = null;
  let readOnly = false; // somebody else's session that we may look at but not touch
  const $title = document.getElementById('title');
  const $titleText = document.getElementById('title-text');
  const $input = document.getElementById('title-input');
  const $notice = document.getElementById('notice');
  const $close = document.getElementById('close-session');
  const $dialog = document.getElementById('close-dialog');
  const $confirm = document.getElementById('close-confirm');
  const $cancel = document.getElementById('close-cancel');
  const $closeError = document.getElementById('close-error');
  const renderName = () => {
    document.title = `${name || 'Session'} · tmux`;
    $titleText.textContent = name || 'Loading session…';
    $title.setAttribute('aria-label', `Rename session: ${name || ''}`);
  };
  renderName();

  const frame = document.getElementById('t');
  const detach = () => { if (frame.isConnected) frame.remove(); };
  window.addEventListener('pagehide', detach);
  window.addEventListener('pageshow', () => { if (!frame.isConnected) location.reload(); });
  const $keys = document.getElementById('keys');
  const store = {
    get: (k) => { try { return localStorage.getItem(`tmuxweb.${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`tmuxweb.${k}`, v); } catch { /* private mode */ } },
  };
  const coarse = matchMedia('(pointer: coarse)').matches
    || (navigator.maxTouchPoints > 0 && /iPhone|iPad|Macintosh|Android/.test(navigator.userAgent));
  // A phone and a tablet get their own key bar and keep their own sizes (see prefs). iPadOS says it is a Mac; its touch screen
  // (coarse) gives it away. The short side of the screen does not change when it is turned.
  const DEVICE = !coarse ? 'desktop' : Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone';
  // ---- display preferences: terminal font, Read view size and width, and the view a Claude session opens in. Read from this
  // browser at once, and kept on the server per person and device kind (api/prefs), so they come back after Safari clears the
  // site's data and follow the person to another device of the same kind. A value changed here before the server answers wins.
  const PREF_NAMES = ['fs', 'readScale', 'readWidth', 'view'];
  const prefs = (() => {
    const key = (n) => `${DEVICE}.${n}`;
    const touched = new Set();
    let queued = {};
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!Object.keys(queued).length) return;
      const body = JSON.stringify({ prefs: queued });
      queued = {};
      fetch('api/prefs', { method: 'PUT', credentials: 'same-origin', cache: 'no-store', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    };
    const push = (n, v) => { queued[key(n)] = v; clearTimeout(timer); timer = setTimeout(flush, 800); };
    addEventListener('pagehide', flush);
    const ready = (async () => {
      let saved = {};
      try {
        const res = await fetch('api/prefs', { credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) saved = (await res.json()).prefs || {};
        else return [];
      } catch { return []; }
      const changed = [];
      for (const n of PREF_NAMES) {
        const local = store.get(key(n)) ?? store.get(n);
        const theirs = saved[key(n)];
        if (touched.has(n) || theirs == null) { if (local != null && local !== theirs) push(n, local); continue; } // first time: the server learns this browser's
        if (theirs !== local) { store.set(key(n), theirs); changed.push(n); }
      }
      return changed;
    })();
    return {
      get: (n) => store.get(key(n)) ?? store.get(n), // the plain key is this browser's value from before device kinds
      ready,
      set(n, v) {
        v = String(v);
        touched.add(n);
        if (store.get(key(n)) === v) return;
        store.set(key(n), v);
        push(n, v);
      },
    };
  })();

  // ---- keep #app on the visual viewport (iOS keyboard shifts / doesn't resize the layout viewport)
  const vv = window.visualViewport;
  let fullViewportHeight = vv ? vv.height : innerHeight;
  let seenViewport = '';
  let lastHeight = vv ? vv.height : innerHeight;
  const syncViewport = () => {
    const root = document.documentElement.style;
    const height = vv ? vv.height : innerHeight;
    seenViewport = `${height}|${vv ? vv.offsetTop : 0}|${innerHeight}`;
    // Pinch-zoomed in: the visual viewport is now a window panning over the page, not the keyboard taking space. Following it
    // resized and moved the whole page (and the terminal's rows) on every pan step, and scrollTo pulled the pan back: it flickered.
    // Stay as laid out until the zoom goes back to 1.
    if (vv && vv.scale > 1.01) return;
    if (Math.abs(height - lastHeight) > 2) { lastHeight = height; layoutFixes = 0; layoutBoost = 0; } // a new situation: start the symptom check afresh
    fullViewportHeight = Math.max(fullViewportHeight, height);
    document.getElementById('app').classList.toggle('compact', coarse && (height <= 500 || fullViewportHeight - height > 140));
    root.setProperty('--vh', `${height}px`);
    root.setProperty('--vt', `${vv ? vv.offsetTop : 0}px`);
    if (!vv || vv.offsetTop) window.scrollTo(0, 0);
    requestAnimationFrame(layoutTerminal);
  };
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
  addEventListener('resize', syncViewport);
  // iOS does not always announce every change (the keyboard's AutoFill bar, a different keyboard): look again a few times a second.
  setInterval(() => { if (`${vv ? vv.height : innerHeight}|${vv ? vv.offsetTop : 0}|${innerHeight}` !== seenViewport) syncViewport(); }, 300);
  syncViewport();

  // ---- terminal handle (ttyd exposes the xterm.js instance as window.term)
  let w = null;
  const send = (seq) => { if (w && w.term) w.term.input(seq, true); };

  // ---- rename in place; immutable tmux IDs keep attach/reconnect and close on the same session
  let editing = false;
  let composing = false;
  let renamePending = null;
  let closing = false;
  let noticeTimer = null;
  const showNotice = (message, error = false, temporary = false) => {
    clearTimeout(noticeTimer);
    $notice.textContent = message;
    $notice.classList.toggle('error', error);
    $notice.hidden = false;
    if (temporary) noticeTimer = setTimeout(() => { $notice.hidden = true; }, 2400);
  };

  // ---- local clipboard actions; terminal selection is separate from tmux's mouse selection
  const $copy = document.getElementById('copy');
  const $read = document.getElementById('read');
  const $textDialog = document.getElementById('text-dialog');
  const $textHeading = document.getElementById('text-heading');
  const $textInstruction = document.getElementById('text-instruction');
  const $textScroll = document.getElementById('text-scroll');
  const $textTop = document.getElementById('text-top');
  const $textOutput = document.getElementById('text-output');
  const $textRender = document.getElementById('text-render');
  const $textView = document.getElementById('text-view');
  const $plain = document.getElementById('plain');
  const $textRefresh = document.getElementById('text-refresh');
  const $textStatus = document.getElementById('text-status');
  const $composer = document.getElementById('composer');
  const $composerInput = document.getElementById('composer-input');
  const $composerSend = document.getElementById('composer-send');
  const $composerError = document.getElementById('composer-error');
  const $working = document.getElementById('working');
  const $workingText = document.getElementById('working-text');
  const $workingWhat = document.getElementById('working-what');
  const $workingStop = document.getElementById('working-stop');
  const $workingScreen = document.getElementById('working-screen');
  const $workingNow = document.getElementById('working-now');
  const $jump = document.getElementById('jump-new');
  const $peek = document.getElementById('peek');
  const $peekScreen = document.getElementById('peek-screen');
  const $peekKeys = document.getElementById('peek-keys');
  const $peekToggle = document.getElementById('peek-toggle');
  const $menu = document.getElementById('terminal-menu');
  const $menuCopy = document.getElementById('menu-copy');
  const $clipboardStatus = document.getElementById('clipboard-status');
  let clipboardTimer = null;
  function clipboardNotice(message, error = false) {
    clearTimeout(clipboardTimer);
    if ($textDialog.open) {
      // the code block's own button already says "Copied"; only a failure needs words
      if (error) { setStatus(message, true); clipboardTimer = setTimeout(() => setStatus(''), 6000); }
      return;
    }
    const app = document.getElementById('app');
    app.style.setProperty('--clipboard-top', `${document.querySelector('header').getBoundingClientRect().bottom - app.getBoundingClientRect().top + 8}px`);
    $clipboardStatus.textContent = message;
    $clipboardStatus.classList.toggle('error', error);
    $clipboardStatus.hidden = false;
    clipboardTimer = setTimeout(() => { $clipboardStatus.hidden = true; }, error ? 6000 : 4000);
  }
  const isMac = /Mac/.test(navigator.platform);
  const selectionHint = coarse
    ? 'Tap Read, then long-press the text to select and copy it.'
    : `Click Read, or hold ${isMac ? 'Option' : 'Shift'} and drag, then press ${isMac ? 'Cmd' : 'Ctrl'}+C or click Copy.`;
  document.getElementById('selection-hint').textContent = selectionHint;
  $copy.title = `Copy selected text · ${selectionHint}`;
  const selection = () => w?.term?.getSelection() || '';

  // ---- reader. The live terminal has no usable scrollback (Claude Code runs on the alternate screen and
  // draws at the old width), so Read shows, in order of preference: the Claude conversation from its
  // transcript file, the tmux scrollback, or the screen as xterm.js has it. Native scrolling, wrapping and
  // text selection; the live terminal is untouched.
  const PAGE = 150;
  const plainHint = coarse
    ? 'Long-press text, adjust the handles, then choose Copy.'
    : 'Drag to select text, then press Ctrl/Cmd+C.';
  let mode = null; // 'chat' | 'history' | 'screen'
  let textView = false; // chat mode shown as raw text (the Plain text button), not as bubbles
  let generation = 0; // bumps on open/close so late responses are dropped
  let renderOn = true; // every Read starts rendered; the Render button only changes the view that is open
  const chat = { items: [], start: 0, total: 0, file: null, loading: false, retryAt: 0 };
  let atBottom = true; // the reader is at (or following) the newest message
  const pending = []; // messages sent from here that the transcript does not show yet: { text, after, at }
  let busy = false; // a Claude turn is running (the server reads this from the pane)
  let asking = false; // a permission prompt is waiting for a key
  let askingShown = false; // the screen panel was already opened for the current prompt
  let pollTimer = null;
  let fastUntil = 0; // poll quickly until then (just sent something)
  let peekOpen = false;
  let sending = false;

  async function getJson(endpoint) {
    const res = await fetch(`api/sessions/${encodeURIComponent(sessionId)}/${endpoint}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }
  // A thin line under the heading, only there while it has something to say (loading, errors).
  const setStatus = (message, error = false) => { $textStatus.textContent = message; $textStatus.classList.toggle('error', error); $textStatus.hidden = !message; };
  // A scroll event for our own scrolling arrives a frame later, when the layout may already have changed again, so it
  // must not be used to decide whether the reader is at the bottom (see the scroll handler).
  let programmaticUntil = 0;
  const toBottom = () => { programmaticUntil = performance.now() + 200; atBottom = true; $textScroll.scrollTop = $textScroll.scrollHeight; };

  // -- vendored renderer, loaded the first time it is needed (served from this site, no external network)
  let libs = null;
  const addTag = (tag, props) => new Promise((resolve, reject) => {
    const node = Object.assign(document.createElement(tag), props);
    node.onload = resolve;
    node.onerror = () => reject(new Error(`Could not load ${props.src || props.href}`));
    document.head.append(node);
  });
  const addScript = (src) => addTag('script', { src, async: false });
  function loadLibs() {
    libs ||= (async () => {
      await Promise.all([
        addTag('link', { rel: 'stylesheet', href: 'vendor/katex.min.css' }),
        addScript('vendor/marked.min.js'), addScript('vendor/purify.min.js'), addScript('vendor/katex.min.js'), addScript('vendor/highlight.min.js'),
      ]);
      await addScript('vendor/matlab.min.js'); // registers itself on window.hljs, so it must come after highlight.js
      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.hasAttribute('href')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      });
      marked.use({ renderer: {
        code: ({ text, lang }) => codeBlock(text, lang),
        image: ({ href, text }) => `<a href="${esc(href || '')}">[image${text ? `: ${esc(text)}` : ''}]</a>`, // never fetch remote images
      } });
    })().catch((error) => { libs = null; throw error; });
    return libs;
  }
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LANG_ALIAS = { sh: 'bash', zsh: 'bash', console: 'bash', shell: 'bash', py: 'python', js: 'javascript', ts: 'typescript', m: 'matlab', yml: 'yaml' };
  const libsReady = () => typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined' && typeof katex !== 'undefined' && typeof hljs !== 'undefined';
  function highlight(text, lang) {
    lang = Object.hasOwn(LANG_ALIAS, lang) ? LANG_ALIAS[lang] : lang;
    try {
      if (lang && hljs.getLanguage(lang)) return { html: hljs.highlight(text, { language: lang, ignoreIllegals: true }).value, lang };
      if (!lang && text.length < 4000) {
        const guess = hljs.highlightAuto(text);
        if (guess.relevance >= 5) return { html: guess.value, lang: guess.language };
      }
    } catch { /* fall back to plain text */ }
    return { html: esc(text), lang };
  }
  function codeBlock(text, info) {
    const given = (info || '').trim().split(/\s+/)[0].toLowerCase();
    const shown = highlight(text, given);
    return `<div class="code-block"><div class="code-head"><span>${esc(shown.lang || given || 'text')}</span><span class="copy-code" role="button" tabindex="0">Copy</span></div><pre><code class="hljs">${shown.html}</code></pre></div>`;
  }
  // $x$, $$x$$, \(x\), \[x\]; `$HOME` and `$5` stay as they are.
  const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\w$])/g;
  const INLINE_CODE = /(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\1(?!`)/g;
  // Apply fn to everything except fenced code blocks and inline code spans.
  function mapOutsideCode(src, fn) {
    const parts = [];
    let text = [];
    let code = null;
    let fence = null;
    for (const line of src.split('\n')) {
      if (fence) {
        code.push(line);
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { parts.push({ code: true, text: code.join('\n') }); code = fence = null; }
        continue;
      }
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
        if (text.length) { parts.push({ code: false, text: text.join('\n') }); text = []; }
        fence = open[1];
        code = [line];
        continue;
      }
      text.push(line);
    }
    if (code) parts.push({ code: true, text: code.join('\n') });
    if (text.length) parts.push({ code: false, text: text.join('\n') });
    return parts.map((part) => {
      if (part.code) return part.text;
      let last = 0;
      let out = '';
      for (const span of part.text.matchAll(INLINE_CODE)) {
        out += fn(part.text.slice(last, span.index)) + span[0];
        last = span.index + span[0].length;
      }
      return out + fn(part.text.slice(last));
    }).join('\n');
  }
  function markdown(src) {
    const maths = [];
    const tag = `MATHX${Math.random().toString(36).slice(2, 8)}Q`; // per call, so code that mentions a placeholder cannot forge one
    const hidden = mapOutsideCode(src, (t) => t.replace(MATH, (_m, a, b, c, d) => {
      maths.push({ tex: (a ?? b ?? c ?? d).trim(), display: a !== undefined || b !== undefined });
      return `${tag}${maths.length - 1}X`;
    }));
    const html = DOMPurify.sanitize(marked.parse(hidden, { gfm: true, breaks: true }), {
      FORBID_TAGS: ['style', 'img', 'picture', 'source', 'video', 'audio', 'form', 'input', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'],
    });
    return html.replace(new RegExp(`${tag}(\\d+)X`, 'g'), (_m, i) => {
      const m = maths[+i];
      return m ? katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }) : '';
    });
  }

  // -- conversation layout: the whole loaded list is laid out again on every change
  const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function formatTime(ts) {
    const date = new Date(ts);
    if (!ts || Number.isNaN(+date)) return '';
    return (date.toDateString() === new Date().toDateString() ? timeOnly : dateTime).format(date);
  }
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const fill = (item, node, rich) => {
    if (rich && renderOn && libsReady()) {
      try { node.className += ' md'; node.innerHTML = (item.html ??= markdown(item.text)); return; } catch { node.className = node.className.replace(' md', ''); }
    }
    node.textContent = item.text;
  };
  const toolCode = (item) => {
    const pre = make('pre');
    const code = make('code');
    if (item.name === 'Bash' && renderOn && libsReady()) { code.className = 'hljs'; code.innerHTML = highlight(item.text, 'bash').html; } else code.textContent = item.text;
    pre.append(code);
    return pre;
  };
  function resultNode(item, index) {
    const lines = item.text ? item.text.split('\n') : [];
    const first = (lines.find((l) => l.trim()) || '').trim().slice(0, 200) || '(empty)';
    const node = make('details', `res${item.error ? ' err' : ''}`);
    node.dataset.key = `r${index}`;
    node.append(make('summary', null, null));
    node.firstChild.append(make('span', 's-text', `${first} · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`));
    node.append(make('pre', null, item.text || ''));
    return node;
  }
  function stepsNode(group) {
    const tools = group.filter(([item]) => item.kind === 'tool');
    const counts = new Map();
    for (const [item] of tools) counts.set(item.name || 'Tool', (counts.get(item.name || 'Tool') || 0) + 1);
    const total = tools.length || group.length;
    const label = [`${total} ${total === 1 ? 'step' : 'steps'}`, ...[...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))].join(' · ');
    const node = make('details', `steps${group.some(([item]) => item.error) ? ' err' : ''}`);
    node.dataset.key = `s${group[0][1]}`;
    const summary = make('summary', null, null);
    summary.append(make('span', 's-text', label));
    summary.title = label;
    node.append(summary);
    // A result belongs to the oldest tool still waiting for one; results with no tool (page cut) stand alone.
    let waiting = [];
    const entries = [];
    for (const [item, index] of group) {
      if (item.kind === 'tool') { const entry = { tool: [item, index], result: null }; entries.push(entry); waiting.push(entry); }
      else if (waiting.length) waiting.shift().result = [item, index];
      else entries.push({ tool: null, result: [item, index] });
    }
    waiting = null;
    for (const { tool, result } of entries) {
      const step = make('div', 'step');
      if (tool) step.append(make('span', 'tool-name', tool[0].name || 'Tool'), toolCode(tool[0]));
      if (result) step.append(resultNode(result[0], result[1]));
      node.append(step);
    }
    return node;
  }
  function bubbleNodes(frag, items, start, typed) {
    let claude = false;
    let group = [];
    const flush = () => { if (group.length) { frag.append(stepsNode(group)); group = []; } };
    items.forEach((item, i) => {
      const index = start + i;
      if (item.kind === 'tool' || item.kind === 'result') { group.push([item, index]); return; }
      flush();
      if (item.kind === 'user') {
        if (typed.has(i)) return;
        claude = false;
        const msg = make('div', 'msg user');
        const bubble = make('div', 'bubble');
        bubble.append(make('div', 'body', item.text));
        msg.append(bubble);
        if (item.ts) msg.append(make('div', 'time', formatTime(item.ts)));
        frag.append(msg);
      } else if (item.kind === 'assistant') {
        if (!claude) { frag.append(make('div', 'who', '✻ Claude')); claude = true; }
        const msg = make('div', 'msg asst');
        const body = make('div', 'body');
        fill(item, body, true);
        msg.append(body);
        frag.append(msg);
      } else if (item.kind === 'command') {
        claude = false;
        const msg = make('div', 'msg cmd');
        msg.append(make('div', 'cmd-pill', item.text));
        if (item.ts) msg.append(make('div', 'time', formatTime(item.ts)));
        frag.append(msg);
      } else if (item.kind === 'summary') {
        claude = false;
        const node = make('details', 'summary');
        node.dataset.key = `m${index}`;
        node.append(make('summary', null, 'Context compacted · summary'));
        const body = make('div', 'body');
        fill(item, body, true);
        node.append(body);
        frag.append(node);
      } else {
        frag.append(make('div', 'note', item.text));
      }
    });
    flush();
    dropSeenPending();
    for (const entry of pending) {
      const msg = make('div', 'msg user pending');
      const bubble = make('div', 'bubble');
      bubble.append(make('div', 'body', entry.text));
      msg.append(bubble, make('div', 'time', entry.sent ? 'Sent' : 'Sending…'));
      frag.append(msg);
    }
    if (!items.length && !pending.length) frag.append(make('div', 'note', 'No messages yet.'));
  }
  // Plain-text view: the conversation as one run of raw text (Markdown source as written, no folding, no wrapping added), so
  // selecting and copying gives exactly what is on screen. Tool calls are one line; results only appear when they failed.
  function rawNodes(frag, items, _start, typed) {
    const text = (t) => document.createTextNode(t);
    const who = (label, cls = '') => make('span', `raw-who${cls}`, label);
    let claude = false;
    let tools = false;
    const endTools = () => { if (tools) { frag.append(text('\n')); tools = false; } };
    const oneLine = (t) => { const line = (t || '').split('\n').find((l) => l.trim()) || ''; return line.length > 160 ? `${line.slice(0, 160)}…` : line; };
    items.forEach((item, i) => {
      if (item.kind === 'tool') { claude = false; tools = true; frag.append(make('span', 'raw-meta', `[${item.name || 'Tool'}] ${oneLine(item.text)}\n`)); return; }
      if (item.kind === 'result') { if (item.error) { tools = true; frag.append(make('span', 'raw-meta', `  ✗ ${oneLine(item.text)}\n`)); } return; }
      endTools();
      if (item.kind === 'user') {
        if (typed.has(i)) return;
        claude = false;
        frag.append(who(`You${item.ts ? ` · ${formatTime(item.ts)}` : ''}`), text(`\n${item.text}\n\n`));
      } else if (item.kind === 'assistant') {
        if (!claude) { frag.append(who('Claude', ' claude'), text('\n')); claude = true; }
        frag.append(text(`${item.text}\n\n`));
      } else if (item.kind === 'command') {
        claude = false;
        frag.append(make('span', 'raw-meta', `${item.text}\n\n`));
      } else if (item.kind === 'summary') {
        claude = false;
        frag.append(who('Context summary'), text(`\n${item.text}\n\n`));
      } else frag.append(make('span', 'raw-meta', `${item.text}\n\n`));
    });
    endTools();
    dropSeenPending();
    for (const entry of pending) {
      const block = make('span', 'raw-pending');
      block.append(who(`You · ${entry.sent ? 'Sent' : 'Sending…'}`), text(`\n${entry.text}\n\n`));
      frag.append(block);
    }
    if (!items.length && !pending.length) frag.append(text('No messages yet.\n'));
  }
  // Where the reader stays: `bottom` follows the newest message; `keepTop` is for content appended below (scrollTop unchanged);
  // by default the distance from the bottom is kept, which is right when earlier messages are inserted above.
  function layoutChat({ bottom = false, keepTop = false } = {}) {
    const top = $textScroll.scrollTop;
    const fromBottom = $textScroll.scrollHeight - top;
    const opened = new Set([...$textOutput.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
    const { items, start } = chat;
    // A typed slash command is logged twice (the typed text, then a command record); show the record once.
    const typed = new Set();
    items.forEach((item, i) => {
      if (item.kind !== 'user' || !/^\/\S/.test(item.text.trim())) return;
      const word = item.text.trim().split(/\s/)[0];
      for (let j = i + 1; j <= i + 3 && j < items.length; j++) {
        if (items[j].kind === 'command' && items[j].text.trim().split(/\s/)[0] === word) { typed.add(i); if (!items[j].ts) items[j].ts = item.ts; break; }
      }
    });
    const frag = document.createDocumentFragment();
    (textView ? rawNodes : bubbleNodes)(frag, items, start, typed);
    $textOutput.replaceChildren(frag);
    for (const node of $textOutput.querySelectorAll('details[data-key]')) if (opened.has(node.dataset.key)) node.open = true;
    $textTop.textContent = chat.start > 0 ? (chat.loading ? 'Loading earlier messages…' : 'Scroll up for earlier messages') : 'Start of the conversation';
    $textTop.hidden = false;
    if (bottom) toBottom(); else { programmaticUntil = performance.now() + 200; $textScroll.scrollTop = keepTop ? top : $textScroll.scrollHeight - fromBottom; }
    atBottom = nearBottom();
  }
  const chatStatus = () => setStatus('');
  async function loadOlder() {
    if (mode !== 'chat' || chat.loading || chat.start <= 0 || Date.now() < chat.retryAt) return;
    const gen = generation;
    chat.loading = true;
    $textTop.textContent = 'Loading earlier messages…';
    let more = false;
    try {
      const data = await getJson(`transcript?before=${chat.start}&count=${PAGE}`);
      if (gen !== generation) return;
      // The newest transcript file can change under us (new conversation); never splice two of them together.
      if (data.file !== chat.file || data.start + data.items.length !== chat.start) { chat.loading = false; await refreshChat(true); return; }
      chat.items = data.items.concat(chat.items);
      chat.start = data.start;
      chat.total = Math.max(chat.total, data.total);
      chat.loading = false;
      layoutChat();
      more = true;
    } catch {
      if (gen !== generation) return;
      chat.retryAt = Date.now() + 3000;
      $textTop.textContent = 'Could not load earlier messages · scroll again to retry';
    } finally { if (gen === generation) chat.loading = false; }
    if (more && $textScroll.scrollTop < 600 && chat.start > 0) void loadOlder();
  }
  // Refreshes run one at a time: a poll and a tap on Refresh must not both append the same items.
  let refreshQueue = Promise.resolve();
  function refreshChat(reload = false, quiet = false) {
    const run = refreshQueue.catch(() => {}).then(() => doRefresh(reload, quiet));
    refreshQueue = run;
    return run;
  }
  const nearBottom = () => $textScroll.scrollHeight - $textScroll.scrollTop - $textScroll.clientHeight < 120;
  async function doRefresh(reload, quiet) {
    const gen = generation;
    const end = chat.start + chat.items.length;
    let data = await getJson(reload ? `transcript?count=${PAGE}` : `transcript?after=${end}`);
    if (gen !== generation) return;
    busy = !!data.busy;
    asking = !!data.asking;
    const stick = !quiet || nearBottom();
    let grew = true;
    // Indexes only mean something inside one transcript file; a different file (new conversation) starts over.
    if (reload || data.file !== chat.file || data.start !== end) {
      Object.assign(chat, { items: data.items, start: data.start, file: data.file, total: data.total });
    } else {
      chat.items = chat.items.concat(data.items);
      // The server returns at most 500 per request.
      while (data.start + data.items.length < data.total && data.items.length) {
        data = await getJson(`transcript?after=${chat.start + chat.items.length}`);
        if (gen !== generation) return;
        if (data.file !== chat.file) return doRefresh(true, quiet);
        chat.items = chat.items.concat(data.items);
      }
      chat.total = data.total;
      grew = chat.start + chat.items.length > end;
    }
    setComposerEnabled(true);
    if (quiet && !grew && !(pending.length && dropSeenPending())) { updateWorking(); return; } // a poll with nothing new changes nothing
    layoutChat({ bottom: stick, keepTop: !stick });
    if (!stick && grew) $jump.hidden = false;
    chatStatus();
    updateWorking();
  }

  // -- plain text: tmux scrollback, or the screen xterm.js is showing
  function screenText() {
    const term = w?.term;
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines = [];
    const end = Math.min(buffer.length, buffer.viewportY + term.rows);
    for (let row = buffer.viewportY; row < end; row++) {
      const line = buffer.getLine(row);
      const continues = row + 1 < end && buffer.getLine(row + 1)?.isWrapped;
      const text = line?.translateToString(!continues, 0, term.cols) || '';
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n').replace(/\n+$/, '');
  }
  function showPlain(kind, text) {
    mode = kind;
    $textDialog.classList.remove('claude');
    $textHeading.textContent = kind === 'history' ? 'History' : 'Screen';
    $textView.hidden = true; // already plain text
    $textInstruction.textContent = kind === 'screen' ? `Current screen; the terminal keeps running. ${plainHint}` : plainHint;
    $textInstruction.hidden = false;
    $textRender.hidden = true;
    $textTop.hidden = true;
    $composer.hidden = true;
    $working.hidden = true;
    stopPolling();
    $textOutput.className = 'plain';
    const options = w?.term?.options;
    $textOutput.style.fontFamily = options?.fontFamily || '';
    $textOutput.style.fontSize = options ? `${options.fontSize}px` : '';
    $textOutput.textContent = text;
    setStatus(text ? '' : 'Nothing to show yet');
    toBottom();
  }
  async function populate() {
    const gen = ++generation;
    stopPolling();
    pending.length = 0;
    busy = false;
    asking = false;
    $textRefresh.disabled = true;
    setStatus('Loading…');
    try {
      let data = null;
      try { data = await getJson(`transcript?count=${PAGE}`); } catch { /* not a Claude pane, or unavailable: use the scrollback */ }
      if (gen !== generation) return;
      if (data) {
        mode = 'chat';
        Object.assign(chat, { items: data.items, start: data.start, total: data.total, file: data.file, loading: false, retryAt: 0 });
        busy = !!data.busy;
        asking = !!data.asking;
        $textDialog.classList.add('claude');
        $textInstruction.hidden = true;
        $textRender.setAttribute('aria-pressed', String(renderOn));
        applyChatView();
        if (renderOn) {
          try { await loadLibs(); } catch { if (gen === generation) setStatus('Could not load the renderer · showing plain text', true); }
          if (gen !== generation) return;
        }
        $composer.hidden = readOnly; // before the layout: it takes height, and "at the bottom" must be measured without it changing
        setComposerEnabled(true);
        layoutChat({ bottom: true });
        if (!$textStatus.classList.contains('error')) chatStatus();
        updateWorking();
        pollSoon(2000);
        return;
      }
      let text = null;
      try { text = (await getJson('history?lines=2000')).text; } catch { /* use the screen */ }
      if (gen !== generation) return;
      if (text != null) showPlain('history', text);
      else showPlain('screen', screenText());
    } finally { if (gen === generation) $textRefresh.disabled = false; }
  }
  // The conversation as bubbles (Render applies) or as raw text. The terminal fallbacks above are always plain.
  function applyChatView() {
    $textHeading.textContent = textView ? 'Plain text' : 'Conversation';
    $textRender.hidden = textView;
    $textView.hidden = false;
    $textView.setAttribute('aria-pressed', String(textView));
    $textOutput.className = textView ? 'plain raw' : 'chat';
    $textOutput.style.fontFamily = $textOutput.style.fontSize = '';
  }
  let opener = $read;
  function openReader(asText = false, from = $read) {
    if (!sessionId || $textDialog.open) return;
    opener = from;
    textView = asText;
    prefs.set('view', asText ? 'text' : 'read'); // the next Claude session opens the same way
    hideMenu();
    $clipboardStatus.hidden = true;
    w?.term?.blur();
    renderOn = true;
    mode = null;
    $textOutput.replaceChildren();
    $textTop.hidden = true;
    $textDialog.showModal();
    $textScroll.scrollTop = 0;
    document.getElementById('text-done').focus({ preventScroll: true });
    void populate();
  }

  // -- talking to Claude: a composer under the conversation, polling for the answer, and a few raw keys
  const normText = (t) => t.replace(/\s+/g, ' ').trim();
  function dropSeenPending() {
    let dropped = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      const seen = chat.items.some((item, k) => chat.start + k >= entry.after && (item.kind === 'user' || item.kind === 'command') && normText(item.text) === normText(entry.text));
      // A slash command often opens a screen of its own and is never written to the transcript, so it is not kept waiting long.
      if (seen || Date.now() - entry.at > (entry.text.startsWith('/') ? 12000 : 45000)) { pending.splice(i, 1); dropped = true; }
    }
    return dropped;
  }
  function updateWorking() {
    const on = mode === 'chat' && (busy || asking || pending.length > 0);
    if (!on) { $working.hidden = true; askingShown = false; return; }
    // Keep the newest message in view only when the row first appears under a reader who was already at the bottom.
    const stick = $working.hidden && nearBottom();
    $workingWhat.textContent = asking ? 'asking for permission.' : 'working…';
    $workingStop.hidden = $workingScreen.hidden = readOnly;
    // a message sent while Claude works waits in its queue; this sends it at once (Claude Code's Ctrl+X Ctrl+S)
    $workingNow.hidden = readOnly || !busy || asking || !pending.some((entry) => entry.sent);
    $working.hidden = false;
    if (stick) toBottom();
    // A prompt needs a key, not text: show the screen once per prompt (closing it keeps it closed until the next one).
    if (asking && !askingShown && !readOnly) { askingShown = true; setPeek(true); }
    if (!asking) askingShown = false;
  }
  function setComposerEnabled(on) {
    $composerInput.disabled = !on;
    $composerInput.placeholder = on ? 'Message Claude…' : 'Claude is not running in this session. Tap Refresh to check again.';
    syncSend();
  }
  const syncSend = () => { $composerSend.disabled = sending || $composerInput.disabled || !$composerInput.value.trim(); };
  function autoGrow() {
    $composerInput.style.height = 'auto';
    $composerInput.style.height = `${Math.min($composerInput.scrollHeight + 2, Math.round(innerHeight * 0.32))}px`;
  }
  function composerError(message) { $composerError.textContent = message; $composerError.hidden = false; }
  async function postInput(body) {
    let res;
    try {
      res = await fetch(`api/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance: sessionInstance, ...body }),
      });
    } catch { throw new Error('No connection. Check your network and try again.'); }
    if (res.ok) return;
    throw new Error({
      404: 'This session has ended or changed. Close this view and open it again.',
      409: 'Claude is not running in this session any more.',
      400: 'That could not be sent (empty, too long, or invalid).',
      413: 'That message is too long.',
    }[res.status] || 'Could not send. Try again, or reload and sign in again if this continues.');
  }
  async function sendMessage() {
    const text = $composerInput.value.replace(/\r\n?/g, '\n').trim();
    if (!text || sending || mode !== 'chat' || readOnly) return;
    sending = true;
    syncSend();
    $composerError.hidden = true;
    const entry = { text, after: chat.start + chat.items.length, at: Date.now() };
    pending.push(entry);
    layoutChat({ bottom: true });
    updateWorking();
    try {
      await postInput({ text });
      entry.sent = true;
      $composerInput.value = '';
      autoGrow();
      fastUntil = Date.now() + 10000;
      pollSoon(500);
      layoutChat({ bottom: nearBottom() });
      // Slash commands like /cost draw their result on the terminal screen, not in the conversation: show it.
      if (text.startsWith('/')) setTimeout(() => { if (mode === 'chat' && pending.includes(entry) && !peekOpen) setPeek(true); }, 1500);
    } catch (error) {
      pending.splice(pending.indexOf(entry), 1);
      layoutChat({ bottom: true });
      updateWorking();
      composerError(error.message);
    } finally { sending = false; syncSend(); }
  }
  async function sendKey(key) {
    $composerError.hidden = true;
    try {
      await postInput({ key });
      fastUntil = Date.now() + 8000;
      pollSoon(400);
    } catch (error) { composerError(error.message); }
  }
  async function updatePeek() {
    const { text } = await getJson('history?screen=1');
    const lines = text.split('\n');
    $peekScreen.textContent = lines.slice(-18).join('\n');
    $peekScreen.scrollTop = $peekScreen.scrollHeight;
  }
  function setPeek(on) {
    peekOpen = on;
    $peek.hidden = !on;
    $peekToggle.setAttribute('aria-pressed', String(on));
    if (on) { void updatePeek().catch(() => { $peekScreen.textContent = 'Could not read the terminal screen.'; }); pollSoon(1500); }
  }
  const liveSelection = () => {
    const range = window.getSelection();
    return !!range && !range.isCollapsed && $textOutput.contains(range.anchorNode);
  };
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function pollSoon(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, ms);
  }
  async function pollTick() {
    pollTimer = null;
    if (mode !== 'chat' || !$textDialog.open) return;
    const gen = generation;
    let delay = Date.now() < fastUntil ? 1000 : 2500;
    try {
      // Relaying the list would wipe a selection in progress, and a hidden tab needs no updates.
      if (!document.hidden && !liveSelection() && !chat.loading) await refreshChat(false, true);
      if (peekOpen && !document.hidden && gen === generation) await updatePeek();
    } catch (error) {
      if (gen !== generation) return;
      if (error.status === 404) { busy = false; updateWorking(); setComposerEnabled(false); return; } // Claude left this pane; Refresh checks again
      delay = 6000;
    }
    if (gen === generation && mode === 'chat') { updateWorking(); pollSoon(delay); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'chat' && $textDialog.open) pollSoon(0); });

  // Keyboard and taps: Enter sends on desktop; on a phone Enter is a new line and Send sends.
  $composerInput.addEventListener('input', () => { autoGrow(); syncSend(); $composerError.hidden = true; });
  $composerInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (coarse && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    void sendMessage();
  });
  $composerInput.addEventListener('focus', () => { $textDialog.classList.add('typing'); });
  $composerInput.addEventListener('blur', () => { $textDialog.classList.remove('typing'); });
  $composerSend.addEventListener('click', () => { void sendMessage(); });
  $peekToggle.addEventListener('click', () => setPeek(!peekOpen));
  document.getElementById('working-screen').addEventListener('click', () => setPeek(true));
  document.getElementById('working-stop').addEventListener('click', () => { void sendKey('Escape'); });
  $workingNow.addEventListener('click', () => { void sendKey('SendNow'); });
  $jump.addEventListener('click', () => { toBottom(); $jump.hidden = true; });
  for (const [label, key, title] of [['Esc', 'Escape', 'Interrupt / cancel'], ['↑', 'Up'], ['↓', 'Down'], ['Enter', 'Enter'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['Tab', 'Tab'], ['⇧Tab', 'BTab', 'Shift+Tab (cycle permission mode)'], ['Clear', 'C-u', 'Clear the input line']]) {
    const button = make('button', null, label);
    button.type = 'button';
    button.dataset.key = key;
    if (title) { button.title = title; button.setAttribute('aria-label', title); }
    $peekKeys.append(button);
  }
  $peekKeys.addEventListener('click', (event) => {
    const key = event.target.closest('button')?.dataset.key;
    if (key) void sendKey(key);
  });
  // Tapping these must not take focus from the message box, or the keyboard drops and the layout jumps under the finger.
  for (const node of [$composerSend, $peekToggle, $peekKeys, $jump, document.getElementById('working-stop'), document.getElementById('working-screen'), $workingNow]) {
    node.addEventListener('pointerdown', (event) => event.preventDefault());
  }

  // Text size and reading width: an Aa panel under the heading, remembered per browser.
  const $fmt = document.getElementById('text-fmt'), $fmtPanel = document.getElementById('text-fmt-panel'), $scale = document.getElementById('text-scale');
  // Up to five times the normal size: on a phone held at arm's length, or an iPad across the room, 160 % was not enough.
  const SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7, 2, 2.3, 2.6, 3, 3.5, 4, 4.5, 5];
  const $scaleRange = document.getElementById('text-scale-range');
  $scaleRange.max = String(SCALES.length - 1);
  let readScale = 1;
  let readWidth = 'normal';
  // a stored size that is not a step any more (an older list) goes to the nearest step
  const nearestScale = (v) => SCALES.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), 1);
  function loadReadFormat() {
    const scale = +prefs.get('readScale');
    readScale = scale > 0 ? nearestScale(scale) : 1;
    const width = prefs.get('readWidth');
    readWidth = ['normal', 'wide', 'full'].includes(width) ? width : 'normal';
  }
  loadReadFormat();
  function applyReadFormat() {
    $textDialog.style.setProperty('--read-scale', String(readScale));
    $textDialog.dataset.width = readWidth;
    // which long edge the notch is on: rotated a quarter turn left (90) puts it on the left
    const angle = typeof window.orientation === 'number' ? window.orientation : screen.orientation?.angle;
    $textDialog.dataset.notch = !coarse ? '' : angle === 90 ? 'left' : angle === 270 || angle === -90 ? 'right' : '';
    $scale.textContent = `${Math.round(readScale * 100)}%`;
    $scaleRange.value = String(SCALES.indexOf(readScale));
    $scaleRange.setAttribute('aria-valuetext', `${Math.round(readScale * 100)}%`);
    for (const b of $fmtPanel.querySelectorAll('[data-width]')) b.setAttribute('aria-pressed', String(b.dataset.width === readWidth));
    const [smaller, larger] = $fmtPanel.querySelectorAll('[data-scale]');
    smaller.disabled = readScale === SCALES[0];
    larger.disabled = readScale === SCALES.at(-1);
  }
  $fmt.addEventListener('click', () => {
    const open = $fmtPanel.hidden;
    $fmtPanel.hidden = !open;
    $fmt.setAttribute('aria-pressed', String(open));
    $fmt.setAttribute('aria-expanded', String(open));
  });
  // keep the reader's place: remember how far through the text we are, restore it after the reflow
  function changeReadFormat(change) {
    const box = $textScroll, ratio = box.scrollHeight > box.clientHeight ? box.scrollTop / (box.scrollHeight - box.clientHeight) : 1;
    change();
    prefs.set('readScale', readScale);
    prefs.set('readWidth', readWidth);
    applyReadFormat();
    if (ratio > 0.995) toBottom();
    else { programmaticUntil = performance.now() + 200; box.scrollTop = ratio * (box.scrollHeight - box.clientHeight); }
  }
  $fmtPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    changeReadFormat(() => {
      if (button.dataset.scale) readScale = SCALES[Math.min(SCALES.length - 1, Math.max(0, SCALES.indexOf(readScale) + +button.dataset.scale))];
      if (button.dataset.width) readWidth = button.dataset.width;
    });
  });
  $scaleRange.addEventListener('input', () => changeReadFormat(() => { readScale = SCALES[+$scaleRange.value] ?? readScale; }));
  void prefs.ready.then((changed) => { if (changed.includes('readScale') || changed.includes('readWidth')) { loadReadFormat(); applyReadFormat(); } });
  // Taps here must not take focus from the message box either.
  for (const node of [$fmt, $fmtPanel]) node.addEventListener('pointerdown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  applyReadFormat();
  addEventListener('orientationchange', applyReadFormat);
  screen.orientation?.addEventListener?.('change', applyReadFormat);

  document.getElementById('text-instruction').textContent = plainHint;
  $read.addEventListener('click', () => openReader(false, $read));
  $plain.addEventListener('click', () => openReader(true, $plain));
  $textView.addEventListener('click', () => {
    if (mode !== 'chat') return;
    textView = !textView;
    applyChatView();
    layoutChat({ bottom: true });
  });
  document.getElementById('text-done').addEventListener('click', () => $textDialog.close());
  $textDialog.addEventListener('close', () => {
    prefs.set('view', 'term');
    generation++;
    mode = null;
    Object.assign(chat, { items: [], start: 0, total: 0, file: null, loading: false });
    stopPolling();
    pending.length = 0;
    busy = false;
    asking = false;
    askingShown = false;
    peekOpen = false;
    $peek.hidden = true;
    $peekToggle.setAttribute('aria-pressed', 'false');
    $composer.hidden = true;
    $working.hidden = true;
    $jump.hidden = true;
    $composerError.hidden = true;
    $composerInput.value = '';
    autoGrow();
    $textDialog.classList.remove('typing');
    const range = window.getSelection();
    if ($textOutput.contains(range?.anchorNode)) range.removeAllRanges();
    $textOutput.replaceChildren();
    $textDialog.classList.remove('claude');
    opener.focus({ preventScroll: true });
    if (!coarse) w?.term?.focus();
  });
  $textRefresh.addEventListener('click', async () => {
    if ($textRefresh.disabled) return;
    $textRefresh.disabled = true;
    try {
      if (mode === 'chat') {
        if (renderOn && !libsReady()) { try { await loadLibs(); } catch { /* shown as plain text below */ } } // retry after a failed load
        await refreshChat();
      } else await populate();
    } catch { setStatus('Could not refresh. Try again, or refresh and sign in again if this continues.', true); }
    finally { $textRefresh.disabled = false; }
  });
  $textRender.addEventListener('click', async () => {
    renderOn = !renderOn;
    $textRender.setAttribute('aria-pressed', String(renderOn));
    if (renderOn) {
      try { await loadLibs(); chatStatus(); } catch { setStatus('Could not load the renderer · showing plain text', true); }
    }
    if (mode === 'chat') layoutChat();
  });
  // The reading area changes size when the keyboard opens, the message box grows or the screen panel opens;
  // a reader who was at the bottom stays at the bottom.
  $textScroll.addEventListener('scroll', () => {
    if (performance.now() >= programmaticUntil) atBottom = nearBottom();
    if (mode !== 'chat') return;
    if ($textScroll.scrollTop < 600) void loadOlder();
    if (atBottom) $jump.hidden = true;
  }, { passive: true });
  new ResizeObserver(() => { if (atBottom && mode === 'chat' && $textDialog.open) toBottom(); }).observe($textScroll);
  $textOutput.addEventListener('click', async (event) => {
    const button = event.target.closest?.('.copy-code');
    const code = button?.closest('.code-block')?.querySelector('code');
    if (!code) return;
    const ok = await copyText(code.textContent);
    button.textContent = ok ? 'Copied' : 'Copy';
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  $textOutput.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList?.contains('copy-code')) { event.preventDefault(); event.target.click(); }
  });
  function hideMenu(focusTerminal = false) {
    $menu.hidden = true;
    if (focusTerminal) w?.term?.focus();
  }
  function legacyCopy(text) {
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    ($textDialog.open ? $textDialog : document.body).append(textarea);
    textarea.select();
    try { return document.execCommand('copy'); }
    finally { textarea.remove(); previousFocus?.focus(); }
  }
  async function copySelection() {
    const text = selection();
    hideMenu();
    if (!text) { clipboardNotice(selectionHint); if (!$textDialog.open) w?.term?.focus(); return; }
    await copyText(text);
  }
  async function copyText(text) {
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(text);
      } catch {
        if (!legacyCopy(text)) throw new Error('Clipboard access blocked');
      }
      clipboardNotice('Copied to clipboard');
      return true;
    } catch {
      clipboardNotice(coarse && $textDialog.open
        ? 'Clipboard access was blocked. Long-press the text and choose Copy from the selection menu.'
        : `Clipboard access was blocked. Allow clipboard access or use ${isMac ? 'Cmd' : 'Ctrl'}+C to copy the selected text.`, true);
      return false;
    } finally { if (!$textDialog.open) w?.term?.focus(); }
  }
  function copyKey(event) {
    if ($textDialog.open) return; // the reading view is plain text: the browser's own copy does it
    if (event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'c' || !selection()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void copySelection();
  }
  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    copyKey(event);
  }, true);
  $copy.addEventListener('click', () => { void copySelection(); });
  $menuCopy.addEventListener('click', () => { void copySelection(); });
  document.getElementById('menu-select-all').addEventListener('click', () => {
    w?.term?.selectAll();
    hideMenu(true);
  });
  document.getElementById('menu-paste').addEventListener('click', async () => {
    hideMenu();
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard API unavailable');
      const text = await navigator.clipboard.readText();
      w?.term?.paste(text);
    } catch {
      clipboardNotice(`Use ${isMac ? 'Cmd' : 'Ctrl'}+V to paste, or allow clipboard access for this site.`, true);
    } finally { w?.term?.focus(); }
  });
  function openMenu(x, y) {
    $menuCopy.disabled = !selection();
    $menu.hidden = false;
    const rect = $menu.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;
    $menu.style.left = `${Math.max(left + 8, Math.min(x, left + width - rect.width - 8))}px`;
    $menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - rect.height - 8))}px`;
    $menu.querySelector('button:not(:disabled)')?.focus();
  }
  $menu.addEventListener('contextmenu', (event) => { event.preventDefault(); });
  $menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Tab') { hideMenu(event.key === 'Escape'); return; }
    const buttons = [...$menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$menu.contains(event.target)) hideMenu();
  });
  window.addEventListener('resize', () => hideMenu());

  // ---- upload: files or a folder into a new folder on the server (api/uploads), then their paths are pasted into the terminal
  // or the Read view's message box, and copied. What was picked is packed into one tar here (a folder keeps its tree) and sent
  // in pieces: the proxy limits the size of one request, and a piece that fails is just sent again from where the server stands.
  const $upload = document.getElementById('upload');
  const $uploadDialog = document.getElementById('upload-dialog');
  const $uploadPick = document.getElementById('upload-pick');
  const $uploadFiles = document.getElementById('upload-files');
  const $uploadFolder = document.getElementById('upload-folder');
  const $uploadProgress = document.getElementById('upload-progress');
  const $uploadWhat = document.getElementById('upload-what');
  const $uploadBar = document.getElementById('upload-bar');
  const $uploadCount = document.getElementById('upload-count');
  const $uploadResult = document.getElementById('upload-result');
  const $uploadDoneText = document.getElementById('upload-done-text');
  const $uploadPaths = document.getElementById('upload-paths');
  const $uploadError = document.getElementById('upload-error');
  const $uploadClose = document.getElementById('upload-close');
  const $uploadCopy = document.getElementById('upload-copy');
  const $uploadPaste = document.getElementById('upload-paste');
  const canPickFolder = 'webkitdirectory' in $uploadFolder;
  if (!canPickFolder) { document.getElementById('upload-pick-folder').hidden = true; $uploadPick.querySelector('.upload-choices').classList.add('one'); }
  let uploadTarget = 'term'; // where Paste puts the paths: 'term' or 'composer' (the Read view's message box)
  let uploading = null; // { id, xhr, cancelled } while sending
  let uploadText = '';
  let uploadCopied = false;
  const copyUploaded = () => (uploadCopied || !uploadText ? Promise.resolve(uploadCopied)
    : navigator.clipboard?.writeText(uploadText.trim()).then(() => {
      if (!uploadCopied) $uploadDoneText.textContent += ' (copied)';
      return (uploadCopied = true);
    }, () => false) ?? Promise.resolve(false));
  const enc = new TextEncoder();
  const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(0)} KB` : n < 2 ** 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
  // A shell word: left bare when that is safe, otherwise in single quotes.
  const shellWord = (p) => (/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
  function tarHeader(name, size, mtime, type) {
    const h = new Uint8Array(512);
    const put = (text, at, len) => h.set(enc.encode(text).subarray(0, len), at);
    const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
    put(name, 0, 100);
    put(oct(0o644, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(size, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    put('        ', 148, 8);
    put(type, 156, 1);
    put('ustar\0' + '00', 257, 8);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return h;
  }
  const pad = (n) => new Uint8Array((512 - (n % 512)) % 512);
  // ustar holds names of up to 100 ASCII bytes; anything longer or non-ASCII (中文 names) goes in a pax record before the entry.
  function tarOf(entries) {
    const parts = [];
    for (const { name, file } of entries) {
      const mtime = Math.floor((file.lastModified || Date.now()) / 1000);
      if (enc.encode(name).length > 100 || /[^\x20-\x7e]/.test(name)) {
        const body = ` path=${name}\n`; // "<length> path=<name>\n", where <length> counts its own digits too
        const n = enc.encode(body).length;
        let len = n + 1;
        while (len !== n + String(len).length) len = n + String(len).length;
        const record = enc.encode(`${len}${body}`);
        parts.push(tarHeader('PaxHeader', record.length, mtime, 'x'), record, pad(record.length));
      }
      parts.push(tarHeader(name.replace(/[^\x20-\x7e]/g, '_').slice(-100), file.size, mtime, '0'), file, pad(file.size));
    }
    parts.push(new Uint8Array(1024));
    return new Blob(parts);
  }
  // Names as the tar will hold them: no empty, '.' or '..' parts; two picked files with one name (photos often are
  // image.jpg) become "image.jpg" and "image (2).jpg".
  function tarEntries(files, folder) {
    const taken = new Set();
    return files.map((file) => {
      let name = (folder && file.webkitRelativePath || file.name).split('/').filter((p) => p && p !== '.' && p !== '..').join('/').replace(/[\u0000-\u001f\u007f]/g, '_') || 'file';
      if (!folder) {
        const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
        for (let i = 2; taken.has(name); i++) name = `${name.slice(0, dot).replace(/ \(\d+\)$/, '')} (${i})${name.slice(dot)}`;
        taken.add(name);
      }
      return { name, file };
    });
  }
  function uploadView(state) {
    $uploadPick.hidden = state !== 'pick';
    $uploadProgress.hidden = state !== 'sending';
    $uploadResult.hidden = state !== 'done';
    $uploadCopy.hidden = $uploadPaste.hidden = state !== 'done';
    if (state !== 'done') $uploadError.hidden = true;
    $uploadClose.textContent = state === 'done' ? 'Done' : 'Cancel';
  }
  function openUpload(target) {
    if ($uploadDialog.open) return;
    uploadTarget = target;
    hideMenu();
    hideCmdMenu();
    uploadView('pick');
    $uploadDialog.showModal();
  }
  const uploadApi = (method, endpoint, body) => fetch(`api/uploads${endpoint}`, {
    method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  // One piece with XMLHttpRequest, for its upload progress (fetch has none): resolves with { status, body }.
  const sendPiece = (id, at, blob, onProgress) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    uploading.xhr = xhr;
    xhr.open('PUT', `api/uploads/${id}?offset=${at}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => { let body = {}; try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ } resolve({ status: xhr.status, body }); };
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => resolve({ status: 0, body: {} });
    xhr.send(blob);
  });
  async function uploadPicked(files, folder) {
    if (!files.length) return;
    const entries = tarEntries(files, folder);
    const top = [...new Set(entries.map((e) => e.name.split('/')[0]))];
    const tar = tarOf(entries);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    $uploadWhat.textContent = folder ? `Folder “${top[0]}”: ${files.length} file${files.length === 1 ? '' : 's'}, ${formatBytes(bytes)}`
      : files.length === 1 ? `“${top[0]}”, ${formatBytes(bytes)}` : `${files.length} files, ${formatBytes(bytes)}`;
    $uploadBar.value = 0;
    $uploadCount.textContent = 'Starting…';
    uploadView('sending');
    const job = uploading = { id: null, xhr: null, cancelled: false };
    const fail = (message) => { if (job.cancelled) return; uploading = null; uploadView('pick'); $uploadError.textContent = message; $uploadError.hidden = false; };
    try {
      let res = await uploadApi('POST', '', { size: tar.size });
      if (!res.ok) { const why = (await res.json().catch(() => ({}))).error; return fail(`Upload refused: ${why || `HTTP ${res.status}`}`); }
      const { id, piece: max } = await res.json();
      job.id = id;
      const piece = Math.min(max || 8 << 20, 8 << 20);
      let at = 0;
      let failures = 0;
      const started = Date.now();
      while (at < tar.size) {
        if (job.cancelled) return;
        const r = await sendPiece(id, at, tar.slice(at, Math.min(tar.size, at + piece)), (loaded) => {
          const done = Math.min(tar.size, at + loaded);
          $uploadBar.value = done / tar.size;
          const rate = done / Math.max(1, (Date.now() - started) / 1000);
          $uploadCount.textContent = `${formatBytes(done)} of ${formatBytes(tar.size)}${done > 2 ** 20 ? ` · ${formatBytes(rate)}/s` : ''}`;
        });
        if (job.cancelled) return;
        if ((r.status === 200 || r.status === 409) && Number.isSafeInteger(r.body.received)) { at = r.body.received; failures = 0; continue; }
        if (r.status === 404) return fail('The upload was dropped by the server (it may have restarted). Try again.');
        if (r.status && r.status < 500 && r.status !== 429) return fail(`Upload refused: ${r.body.error || `HTTP ${r.status}`}`);
        if (++failures > 6) return fail('The connection keeps failing. Check your network and try again.');
        $uploadCount.textContent = `Connection lost, retrying (${failures})…`;
        await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
      }
      $uploadBar.value = 1;
      $uploadCount.textContent = 'Unpacking…';
      res = await uploadApi('POST', `/${id}/done`, { top });
      const body = await res.json().catch(() => ({}));
      if (job.cancelled) return;
      if (!res.ok || !Array.isArray(body.paths)) return fail(`Upload failed: ${body.error || `HTTP ${res.status}`}`);
      uploading = null;
      showUploaded(body.paths);
    } catch {
      fail('No connection. Check your network and try again.');
    }
  }
  function showUploaded(paths) {
    uploadText = `${paths.map(shellWord).join(' ')} `;
    $uploadPaths.value = paths.join('\n');
    const toComposer = uploadTarget === 'composer';
    $uploadPaste.textContent = toComposer ? 'Add to message' : 'Paste into terminal';
    uploadView('done');
    $uploadPaths.style.height = 'auto'; // as tall as the wrapped paths (the CSS caps it)
    $uploadPaths.style.height = `${$uploadPaths.scrollHeight + 2}px`;
    $uploadPaste.hidden = toComposer ? $composerInput.disabled : readOnly;
    $uploadDoneText.textContent = `Uploaded ${paths.length === 1 ? 'to' : `${paths.length} items to`}:`;
    // Copied at once where the browser allows it. Safari only lets a tap write the clipboard, so there the tap on Paste,
    // Copy or Done does it.
    uploadCopied = false;
    void copyUploaded();
    ($uploadPaste.hidden ? $uploadCopy : $uploadPaste).focus();
  }
  function cancelUpload() {
    const job = uploading;
    uploading = null;
    if (!job) return;
    job.cancelled = true;
    job.xhr?.abort();
    if (job.id) uploadApi('DELETE', `/${job.id}`).catch(() => {});
  }
  $upload.addEventListener('click', () => openUpload('term'));
  document.getElementById('composer-attach').addEventListener('click', () => openUpload('composer'));
  document.getElementById('upload-pick-files').addEventListener('click', () => { $uploadFiles.value = ''; $uploadFiles.click(); });
  document.getElementById('upload-pick-folder').addEventListener('click', () => { $uploadFolder.value = ''; $uploadFolder.click(); });
  $uploadFiles.addEventListener('change', () => { void uploadPicked([...$uploadFiles.files], false); });
  $uploadFolder.addEventListener('change', () => { void uploadPicked([...$uploadFolder.files], true); });
  $uploadClose.addEventListener('click', () => {
    if (!$uploadResult.hidden) void copyUploaded();
    $uploadDialog.close();
  });
  $uploadDialog.addEventListener('close', () => {
    cancelUpload();
    if (uploadTarget === 'composer' && $textDialog.open) return;
    if (!coarse) w?.term?.focus();
  });
  $uploadCopy.addEventListener('click', async () => {
    uploadCopied = false;
    let ok = await copyUploaded();
    if (!ok) { // no Clipboard API: copy the box's text, now the one line that is pasted
      $uploadPaths.value = uploadText.trim();
      $uploadPaths.focus();
      $uploadPaths.select();
      try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    }
    $uploadCopy.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => { $uploadCopy.textContent = 'Copy'; }, 1600);
  });
  $uploadPaste.addEventListener('click', () => {
    void copyUploaded();
    $uploadDialog.close();
    if (uploadTarget === 'composer') {
      const value = $composerInput.value;
      const at = $composerInput.selectionStart ?? value.length;
      const before = value.slice(0, at);
      const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${uploadText}`;
      $composerInput.value = before + insert + value.slice($composerInput.selectionEnd ?? at);
      $composerInput.setSelectionRange(at + insert.length, at + insert.length);
      autoGrow();
      syncSend();
      $composerInput.focus();
    } else {
      w?.term?.paste(uploadText); // bracketed when the program asked for it: Claude Code then attaches a pasted image path
      if (!coarse) w?.term?.focus();
    }
  });

  const updateUrl = () => {
    const url = new URL(location.href);
    url.searchParams.set('s', name);
    url.searchParams.set('id', sessionId);
    url.searchParams.set('instance', sessionInstance);
    history.replaceState(null, '', url);
  };
  function beginRename() {
    if (!sessionId || renamePending || closing) return;
    editing = true;
    $input.value = name;
    $input.removeAttribute('aria-invalid');
    $title.hidden = true;
    $input.hidden = false;
    $input.focus();
    $input.select();
    showNotice('Press Enter or click away to save · Esc to cancel');
  }
  function endRename() {
    editing = false;
    $input.hidden = true;
    $title.hidden = false;
    $input.removeAttribute('aria-invalid');
  }
  function saveRename() {
    if (renamePending) return renamePending;
    if (!editing) return Promise.resolve(true);
    const next = $input.value.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,47}$/u.test(next)) {
      $input.setAttribute('aria-invalid', 'true');
      showNotice('Use 1–48 characters starting with a letter or number. Letters, numbers, spaces, - and _ are allowed.', true);
      $input.focus();
      return Promise.resolve(false);
    }
    endRename();
    if (next === name) { $notice.hidden = true; return Promise.resolve(true); }
    $title.disabled = true;
    showNotice('Saving name…');
    renamePending = (async () => {
      try {
        const res = await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: next, instance: sessionInstance }),
        });
        if (res.status === 409) throw new Error('That name is already in use. Choose another name.');
        if (res.status === 404) throw new Error('This session has ended. Return to the session list.');
        if (!res.ok) throw new Error('Could not rename the session. Try again, or refresh and sign in again if this continues.');
        name = (await res.json()).name;
        renderName();
        updateUrl();
        showNotice('Name saved', false, true);
        return true;
      } catch (error) {
        editing = true;
        $input.value = next;
        $title.hidden = true;
        $input.hidden = false;
        $input.setAttribute('aria-invalid', 'true');
        $input.focus();
        showNotice(error.message, true);
        return false;
      } finally {
        renamePending = null;
        $title.disabled = false;
      }
    })();
    return renamePending;
  }
  $title.addEventListener('click', beginRename);
  document.getElementById('rename').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!composing) void saveRename();
  });
  $input.addEventListener('blur', () => { if (!composing) void saveRename(); });
  $input.addEventListener('compositionstart', () => { composing = true; });
  $input.addEventListener('compositionend', () => {
    composing = false;
    if (editing && document.activeElement !== $input) void saveRename();
  });
  $input.addEventListener('input', () => { $input.removeAttribute('aria-invalid'); });
  $input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    endRename();
    $notice.hidden = true;
    w?.term?.focus();
  });
  document.getElementById('back').addEventListener('click', async (event) => {
    event.preventDefault();
    if (await saveRename()) { detach(); location.assign('./'); }
  });

  // ---- explicitly confirmed session destruction
  $close.addEventListener('click', async () => {
    if (!sessionId || closing || $dialog.open) return;
    $close.disabled = true;
    const saved = await saveRename();
    $close.disabled = false;
    if (!saved) return;
    document.getElementById('close-name').textContent = name;
    $closeError.hidden = true;
    $dialog.showModal();
    $cancel.focus();
  });
  $cancel.addEventListener('click', () => { if (!closing) $dialog.close(); });
  $dialog.addEventListener('cancel', (event) => { if (closing) event.preventDefault(); });
  $confirm.addEventListener('click', async () => {
    if (closing) return;
    closing = true;
    $confirm.disabled = $cancel.disabled = $close.disabled = true;
    $confirm.textContent = 'Closing…';
    $closeError.hidden = true;
    try {
      const res = await fetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, instance: sessionInstance }),
      });
      // Already gone is also a successful exit; never fall back to a name or another session.
      if (!res.ok && res.status !== 404) throw new Error('Could not close the session. Try again, or refresh and sign in again if this continues.');
      detach();
      location.replace('./');
    } catch (error) {
      $closeError.textContent = error.message;
      $closeError.hidden = false;
      closing = false;
      $confirm.disabled = $cancel.disabled = $close.disabled = false;
      $confirm.textContent = 'Close session';
    }
  });

  // ---- key bar
  // Up/down and left/right are told apart by colour, and on a phone a key sits between the two pairs so a thumb does not hit
  // the wrong one. A tablet has room for bigger keys, Ctrl+C and Send now, and arrows laid out as arrows, with Enter in the middle.
  // Page up/down are not on the bar: they float as bubbles on both edges of the terminal (#pager-left/right).
  const K = {
    esc: { l: 'Esc', s: '\x1b' }, menu: { menu: true, title: 'Common commands' }, clear: { l: 'Clear', s: '\x15', title: 'Clear input (Ctrl+U)' },
    up: { l: '↑', s: '\x1b[A', rep: 1, cls: 'v', title: 'Up' }, down: { l: '↓', s: '\x1b[B', rep: 1, cls: 'v', title: 'Down' },
    left: { l: '←', s: '\x1b[D', rep: 1, cls: 'h', title: 'Left' }, right: { l: '→', s: '\x1b[C', rep: 1, cls: 'h', title: 'Right' },
    tab: { l: 'Tab', s: '\t' }, btab: { l: '⇧Tab', s: '\x1b[Z', title: 'Shift+Tab (Claude: cycle the permission mode)' },
    ctrlc: { l: '^C', s: '\x03', cls: 'warn', title: 'Ctrl+C: interrupt (pressed twice, it quits Claude)' },
    // Claude Code's chat:sendNow chord: a message queued while Claude works is sent at once, interrupting the turn
    now: { l: 'Send now', s: '\x18\x13', cls: 'now', title: 'Send now (Ctrl+X Ctrl+S): Claude sends the queued message at once, interrupting its turn' },
    pipe: { l: '|', s: '|' }, slash: { l: '/', s: '/' }, tilde: { l: '~', s: '~' },
    enter: { l: 'Enter', s: '\r', cls: 'enter', title: 'Enter' },
    pgup: { svg: '<path d="m7 11 5-5 5 5M7 18l5-5 5 5"/>', s: '\x1b[5~', rep: 1, title: 'Page up' },
    pgdn: { svg: '<path d="m7 6 5 5 5-5M7 13l5 5 5-5"/>', s: '\x1b[6~', rep: 1, title: 'Page down' },
  };
  const BAR = DEVICE === 'tablet'
    ? { main: ['esc', 'menu', 'ctrlc', 'clear', 'tab', 'now', 'btab', 'pipe', 'slash', 'tilde'], pad: ['up', 'left', 'enter', 'right', 'down'] }
    : { main: ['esc', 'menu', 'clear', 'up', 'down', 'tab', 'left', 'right', 'pipe', 'slash', 'tilde', 'enter'] };
  // The commands menu (the second key). Typed text is submitted with a separate Enter a moment later: Claude Code treats text that
  // arrives together with a newline as a paste and would not submit it. `claude` is the only one with a guard: typed into a
  // running Claude it would be sent to it as a message. A row with `chips` is one row of choices (/effort max, xhigh, …).
  const COMMANDS = [
    { name: 'claude', hint: 'Start, skip permissions', text: 'claude --dangerously-skip-permissions', enter: true, notInClaude: true },
    { name: '/resume', hint: 'Pick a past conversation', text: '/resume', enter: true },
    { name: '/compact', hint: 'Compress the context', text: '/compact', enter: true },
    { name: '/model', hint: 'Switch the model', text: '/model', enter: true },
    { name: '/effort', hint: 'Set the thinking effort', text: '/effort', enter: true },
    { name: '/effort', chips: ['max', 'xhigh', 'high', 'medium', 'low'] },
    { name: 'Send now', hint: 'Queued message, at once', text: '\x18\x13', title: 'Ctrl+X Ctrl+S' },
    { name: 'Ctrl-C', hint: 'Interrupt', text: '\x03', title: 'Ctrl+C' },
  ];
  const $cmdMenu = document.getElementById('cmd-menu');
  let $cmdButton = null;
  const hideCmdMenu = () => {
    if ($cmdMenu.hidden) return;
    $cmdMenu.hidden = true;
    $cmdButton?.setAttribute('aria-expanded', 'false');
  };
  function keyButton(k, pos) {
    const b = document.createElement('button');
    b.type = 'button';
    if (k.cls) b.className = k.cls;
    if (pos) b.dataset.pos = pos;
    if (k.menu) {
      b.className = 'cmds';
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 8 4 4-4 4M13 17h5"/></svg>';
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      $cmdButton = b;
    } else if (k.svg) b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${k.svg}</svg>`;
    else b.textContent = k.l;
    if (k.title) { b.title = k.title; b.setAttribute('aria-label', k.title); }
    let holdTimer = null;
    let repeatTimer = null;
    let gesture = null;
    const stopRepeat = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); holdTimer = repeatTimer = null; };
    const cancel = () => { stopRepeat(); gesture = null; };
    const fire = k.menu ? () => toggleCmdMenu() : () => send(k.s);
    // Preserve terminal focus; touch-action allows native horizontal scrolling.
    // A tap fires on release, so starting a swipe never sends a key.
    b.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      cancel();
      gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, repeated: false };
      if (k.rep) holdTimer = setTimeout(() => {
        if (!gesture || gesture.moved) return;
        gesture.repeated = true;
        fire();
        repeatTimer = setInterval(fire, 70);
      }, 350);
    });
    b.addEventListener('pointermove', (e) => {
      if (!gesture || gesture.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8) {
        gesture.moved = true;
        stopRepeat();
      }
    });
    b.addEventListener('pointerup', (e) => {
      if (!gesture || gesture.id !== e.pointerId) return;
      const r = b.getBoundingClientRect();
      const tapped = !gesture.moved && !gesture.repeated
        && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      cancel();
      if (tapped) fire();
    });
    for (const type of ['pointercancel', 'pointerleave', 'lostpointercapture']) b.addEventListener(type, cancel);
    b.addEventListener('click', (e) => { e.preventDefault(); if (e.detail === 0) fire(); });
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  $keys.classList.add(DEVICE);
  document.getElementById('app').classList.add(`dev-${DEVICE}`);
  if (BAR.pad) {
    const main = Object.assign(document.createElement('div'), { className: 'kmain' });
    const pad = Object.assign(document.createElement('div'), { className: 'dpad' });
    main.append(...BAR.main.map((n) => keyButton(K[n])));
    pad.append(...BAR.pad.map((n) => keyButton(K[n], n)));
    $keys.append(main, pad);
  } else $keys.append(...BAR.main.map((n) => keyButton(K[n])));
  for (const side of ['left', 'right']) document.getElementById(`pager-${side}`).append(keyButton(K.pgup), keyButton(K.pgdn));
  const keepFocus = (node) => node.addEventListener('mousedown', (e) => e.preventDefault()); // keep the terminal's focus (and the phone keyboard)
  const cmdRows = COMMANDS.map((c) => {
    if (c.chips) {
      const row = document.createElement('div');
      row.className = 'c-chips';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `${c.name} …`);
      const name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = c.name;
      row.append(name);
      for (const value of c.chips) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.setAttribute('role', 'menuitem');
        chip.textContent = value;
        chip.title = `${c.name} ${value}`;
        keepFocus(chip);
        chip.addEventListener('click', () => { void runCommand({ text: chip.title, enter: true }, chip); });
        row.append(chip);
      }
      $cmdMenu.append(row);
      return null;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.title = c.title || c.text;
    const name = document.createElement('span');
    name.className = 'c-name';
    name.textContent = c.name;
    const hint = document.createElement('span');
    hint.className = 'c-hint';
    hint.textContent = c.hint;
    row.append(name, hint);
    keepFocus(row);
    row.addEventListener('click', () => { void runCommand(c, row); });
    $cmdMenu.append(row);
    return { c, row, hint };
  }).filter(Boolean);
  const $cmdInfo = document.createElement('div');
  $cmdInfo.className = 'c-info';
  $cmdMenu.append($cmdInfo);
  // Is Claude the foreground program of this pane? Positive detection only: if the check fails the command is allowed.
  async function claudeRunning() {
    try {
      const res = await fetch('api/sessions?owner=all&preview=0', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return false;
      const mine = (await res.json()).sessions.find((s) => s.id === sessionId);
      if (mine) lastRow = mine;
      return !!mine && /claude/i.test(mine.command || '');
    } catch { return false; }
  }
  function toggleCmdMenu() {
    if (!$cmdMenu.hidden) { hideCmdMenu(); return; }
    const app = document.getElementById('app');
    const appBox = app.getBoundingClientRect();
    const btn = $cmdButton.getBoundingClientRect();
    $cmdMenu.hidden = false;
    $cmdButton.setAttribute('aria-expanded', 'true');
    $cmdMenu.style.bottom = `${app.clientHeight - $keys.offsetTop + 6}px`;
    $cmdMenu.style.left = `${Math.max(6, Math.min(btn.left - appBox.left, appBox.width - $cmdMenu.offsetWidth - 6))}px`;
    for (const r of cmdRows) { r.row.disabled = false; r.hint.textContent = r.c.hint; }
    $cmdInfo.textContent = diagText();
    void claudeRunning().then((running) => {
      if ($cmdMenu.hidden) return;
      $cmdInfo.textContent = diagText();
      for (const r of cmdRows) if (r.c.notInClaude && running) { r.row.disabled = true; r.hint.textContent = 'Already running'; }
      const focused = document.activeElement;
      if (!coarse && (!$cmdMenu.contains(focused) || focused.disabled)) cmdRows.find((r) => !r.row.disabled)?.row.focus(); // the focused row was just disabled
    });
    if (!coarse) cmdRows.find((r) => !r.row.disabled)?.row.focus();
  }
  async function runCommand(c, row) {
    if (c.notInClaude && await claudeRunning()) { row.disabled = true; row.querySelector('.c-hint').textContent = 'Already running'; return; }
    hideCmdMenu();
    send(c.text);
    if (c.enter) setTimeout(() => send('\r'), 150);
    if (!coarse) w?.term?.focus();
  }
  // Esc closes the menu wherever the focus is (in the terminal too, where it must not also reach the program).
  const escapeMenu = (event) => {
    if (event.key !== 'Escape' || $cmdMenu.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideCmdMenu();
    if ($cmdMenu.contains(document.activeElement)) $cmdButton.focus();
  };
  document.addEventListener('keydown', escapeMenu, true);
  $cmdMenu.addEventListener('keydown', (event) => {
    const buttons = [...$cmdMenu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$cmdMenu.contains(event.target) && !$cmdButton.contains(event.target)) hideCmdMenu();
  });
  window.addEventListener('resize', hideCmdMenu);
  const $kb = document.getElementById('kb');
  const showKeys = (on) => {
    if (!on) hideCmdMenu();
    $keys.hidden = !on;
    document.getElementById('app').classList.toggle('pagers', on && coarse);
    $kb.setAttribute('aria-pressed', String(on));
    $kb.setAttribute('aria-label', on ? 'Hide key bar' : 'Show key bar');
    $kb.title = on ? 'Hide terminal key bar' : 'Show terminal key bar';
    store.set('keys', on ? '1' : '0');
    requestAnimationFrame(layoutTerminal);
  };
  showKeys(store.get('keys') != null ? store.get('keys') === '1' : coarse);
  $kb.addEventListener('click', () => showKeys($keys.hidden));

  // ---- font size
  let fs = +prefs.get('fs') || (innerWidth < 600 ? 13 : 14);
  function applyFont(n, save = true) {
    fs = Math.max(9, Math.min(36, n));
    if (save) prefs.set('fs', fs);
    layoutTerminal();
  }
  void prefs.ready.then((changed) => { if (changed.includes('fs') && +prefs.get('fs')) applyFont(+prefs.get('fs'), false); });
  // Size the terminal for the room it really has. On a phone the keyboard, iOS's AutoFill bar and Safari's own bars can leave
  // only ~190px. Claude Code needs MIN_ROWS rows or so (tmux's status line included) to show its notices, rules, input line and
  // footer; with fewer, its input line falls off the bottom of the screen and the cursor is left sitting on the rule under it. So when the terminal would be shorter than that
  // the title bar folds away and the key bar slims down; if that is still not enough the font shrinks, down to 9px, and below
  // FLOOR_ROWS even the key bar steps aside. The font size the user chose (`fs`) is never changed, and everything reverts when
  // the keyboard goes away. Runs when the viewport, the key bar or the terminal's own box changes (ResizeObserver, see below).
  const MIN_ROWS = 13; // Claude's own bottom block (notices, hint, rules, input, status line, footer) is ~8-10 rows in a long session
  const FLOOR_ROWS = 7;
  let layoutFixes = 0; // steps taken because the cursor was found on a rule line (checkCursor)
  let layoutBoost = 0; // 1 = hold the tight layout and one font step smaller, whatever the row count says
  let checkTimer = null;
  let lastRow = null; // the session's row from the last list fetch (clients attached, foreground command)
  const RULE = /^\s*[─━═]{6,}[\s│┘·]*$/; // tmux pads a window that is smaller than the screen with ·'s and a │ ┘ border
  const cursorOnRule = (term) => {
    const b = term?.buffer?.active;
    const line = b && b.getLine(b.baseY + b.cursorY);
    return !!line && RULE.test(line.translateToString(true));
  };
  function layoutTerminal() {
    const term = w?.term;
    if (!term || !term.options) return;
    const app = document.getElementById('app');
    const screen = w.document.querySelector('.xterm-screen');
    const ratio = screen && term.rows && term.options.fontSize ? screen.getBoundingClientRect().height / term.rows / term.options.fontSize : 1.32; // cell height per px of font
    const rowsFor = (size, padding) => Math.floor((frame.clientHeight - padding) / (size * ratio));
    const smallest = () => Math.max(9, Math.min(fs, Math.floor(((frame.clientHeight - 4) / (MIN_ROWS * ratio)) * 2) / 2)); // the largest font (in half pixels) that gives MIN_ROWS
    app.classList.remove('tight', 'squeezed');
    let tight = false;
    let size = fs;
    if (coarse && app.classList.contains('compact') && (rowsFor(fs, 10) < MIN_ROWS || layoutBoost)) {
      app.classList.add('tight');
      tight = true;
      if (rowsFor(fs, 4) < MIN_ROWS) size = smallest();
      if (rowsFor(size, 4) < FLOOR_ROWS) { app.classList.add('squeezed'); size = smallest(); }
      if (layoutBoost) size = Math.max(9, size - 1);
    }
    w.document.documentElement.classList.toggle('tight', tight); // trims ttyd's 5px padding around the screen
    if (term.options.fontSize !== size) { term.options.fontSize = size; setTimeout(() => term.fit(), 60); } else term.fit();
    scheduleCheck(900);
  }
  // The symptom itself: with the keyboard up the cursor sits on a line of ───── (Claude's input line is off the bottom, or tmux
  // and this screen disagree about the size). First nudge the size (tmux re-reads it and Claude redraws), then give the
  // terminal more room (only when it is short). Never sends anything to the program, and stops after two steps until the viewport changes again.
  function scheduleCheck(delay) { clearTimeout(checkTimer); checkTimer = setTimeout(checkCursor, delay); }
  function checkCursor() {
    const term = w?.term;
    if (!term?.buffer || !document.getElementById('app').classList.contains('compact') || !cursorOnRule(term)) return;
    if (layoutFixes === 0) {
      layoutFixes = 1;
      term.resize(term.cols, Math.max(2, term.rows - 1));
      setTimeout(() => term.fit(), 150);
      scheduleCheck(1800);
    } else if (layoutFixes === 1) {
      layoutFixes = 2;
      if (term.rows < 16) { layoutBoost = 1; layoutTerminal(); } // with more rows than that, more room is not what is missing
    }
  }
  if (window.ResizeObserver) {
    let burst = 0;
    setInterval(() => { burst = 0; }, 1000);
    new ResizeObserver(() => { if (++burst < 12) requestAnimationFrame(layoutTerminal); }).observe(frame);
  }
  // What the commands menu shows under the commands: enough to tell what this phone is doing without a developer console.
  function diagText() {
    const term = w?.term;
    const app = document.getElementById('app');
    const mode = app.classList.contains('squeezed') ? 'squeezed' : app.classList.contains('tight') ? 'tight' : app.classList.contains('compact') ? 'compact' : 'normal';
    if (!term) return `UI ${BUILD}`;
    return [`UI ${BUILD}`, `${term.cols}×${term.rows}`, `font ${term.options.fontSize}${term.options.fontSize !== fs ? `/${fs}` : ''}`, `view ${Math.round(vv ? vv.height : innerHeight)}px`, mode,
      lastRow ? `clients ${lastRow.attached}` : '', cursorOnRule(term) ? 'cursor on a rule' : '', layoutFixes ? `fix ${layoutFixes}` : ''].filter(Boolean).join(' · ');
  }
  document.getElementById('fs-').addEventListener('click', () => applyFont(fs - 1));
  document.getElementById('fs+').addEventListener('click', () => applyFont(fs + 1));

  // ---- desktop: draw the screen on a canvas
  // ttyd is started with rendererType=dom. The DOM renderer lays a row out with the browser's own text flow and only corrects
  // each run's width with a letter-spacing computed from a measurement; a glyph that the font (or its fallback) draws wider or
  // narrower than that measurement (fullwidth punctuation, ❯ ● ⏸ ✻ …, all over Claude's screen) pushes the rest of the row off
  // the cell grid. A drag selection works on the grid, so it then starts a character late or early and ends away from the
  // pointer. The canvas renderer puts every glyph in its own cell, so what you see is what the grid selects. It is xterm.js's own
  // addon (vendor/xterm-addon-canvas.js, @xterm/addon-canvas 0.7.0, which pairs with the xterm 5.4/5.5 core inside ttyd 1.7.7; the older
  // xterm-addon-canvas 0.5 throws on it), run inside the terminal's
  // document. Phones keep the DOM renderer, and so does a desktop that sets localStorage tmuxweb.renderer to "dom".
  function loadCanvasRenderer() {
    if (store.get('renderer') === 'dom') return;
    const attach = () => {
      try {
        w.term.loadAddon(new w.CanvasAddon.CanvasAddon());
        w.term.refresh(0, w.term.rows - 1);
        layoutTerminal();
      } catch { /* the DOM renderer stays */ }
    };
    try {
      if (w.CanvasAddon) { attach(); return; }
      const script = w.document.createElement('script');
      script.src = new URL('vendor/xterm-addon-canvas.js?v=0.7.0', document.baseURI).href;
      script.onload = attach;
      w.document.head.appendChild(script);
    } catch { /* the DOM renderer stays */ }
  }

  // ---- phone keyboards: printable text comes from what the browser inserts, not from keydown
  // iOS's Chinese keyboard reports a punctuation key with keydown 229 ("IME busy") or with the ASCII key it sits on ("," for ，),
  // and only the input event that follows carries the real character. xterm.js trusts the keydown, so ， arrived twice or as ",",
  // and a mark typed right after a pinyin commit overtook the commit. Here xterm still gets the control keys (Enter, Backspace,
  // arrows, Ctrl/Alt chords); every printable character is sent from the input event or from the composition's result instead.
  function softKeyboardInput(doc) {
    const ta = doc.querySelector('.xterm-helper-textarea');
    if (!ta) return;
    let composing = false; let committed = null;
    const own = (event) => event.target === ta;
    const printable = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && (e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process' || [...e.key].length === 1);
    const tidy = () => setTimeout(() => { if (!composing) ta.value = ''; }, 0);
    const keep = (e) => { if (own(e)) e.stopImmediatePropagation(); };
    doc.addEventListener('keydown', (e) => { if (own(e) && (composing || e.isComposing || printable(e))) e.stopImmediatePropagation(); }, true);
    doc.addEventListener('keypress', keep, true);
    doc.addEventListener('compositionstart', (e) => { keep(e); if (own(e)) composing = true; }, true);
    doc.addEventListener('compositionupdate', keep, true);
    doc.addEventListener('compositionend', (e) => {
      if (!own(e)) return;
      e.stopImmediatePropagation();
      composing = false;
      if (e.data) { send(e.data); committed = e.data; setTimeout(() => { committed = null; }, 80); }
      tidy();
    }, true);
    doc.addEventListener('input', (e) => {
      if (!own(e)) return;
      e.stopImmediatePropagation();
      if (composing || e.isComposing || /Composition/.test(e.inputType || '')) return;
      const data = e.data ?? e.dataTransfer?.getData('text/plain');
      if (data && committed !== null && data === committed) { committed = null; return; } // Safari repeats the commit as an input event
      if (data && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText')) send(data);
      tidy(); // Enter, Backspace and the like already went to xterm as keys
    }, true);
  }

  // ---- wire up once ttyd has created the terminal
  function setup() {
    const doc = w.document;
    const theme = { background: '#0b0e14', foreground: '#d6dae3', cursor: '#6ea8ff', selectionBackground: '#33467c',
      black: '#1b1f2a', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
      brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#b9f27c', brightYellow: '#ffc777', brightBlue: '#9abdf5', brightMagenta: '#c9a9ff', brightCyan: '#a4daff', brightWhite: '#e6e9ef' };
    w.term.options.theme = theme;
    // CJK glyphs fall back per character, so no CJK mono font here (it would win and make Latin text narrow/tall).
    w.term.options.fontFamily = '"JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
    w.term.options.macOptionClickForcesSelection = true;
    w.term.options.altClickMovesCursor = false;
    doc.body.style.background = theme.background;
    const tightStyle = doc.createElement('style');
    tightStyle.textContent = 'html.tight #terminal-container .terminal { padding: 2px; height: calc(100% - 4px); }';
    doc.head.appendChild(tightStyle);
    doc.querySelector('.xterm-helper-textarea')?.setAttribute('autocomplete', 'off'); // best effort: no iOS AutoFill bar (it eats ~90px)
    if (coarse && !readOnly) softKeyboardInput(doc);
    doc.documentElement.style.background = theme.background;
    const box = doc.getElementById('terminal-container');
    if (box) box.style.touchAction = 'none';
    applyFont(fs, false);
    if (!coarse) loadCanvasRenderer();
    w.term.onCursorMove(() => scheduleCheck(900));
    if (readOnly) w.term.options.disableStdin = true;
    else if (!coarse) w.term.focus();
    $copy.disabled = false;

    // Ctrl/Cmd+C copies a local selection; with no selection, Ctrl+C still reaches the program.
    doc.addEventListener('keydown', copyKey, true);
    // Also supply real text for native Copy and ttyd's selection-copy callback.
    doc.addEventListener('copy', (event) => {
      const text = selection();
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }, true);

    // The local clipboard menu owns right-click; do not send a second click to tmux.
    const rightClick = (event) => event.button === 2 || (isMac && event.button === 0 && event.ctrlKey);
    for (const type of ['mousedown', 'mouseup']) {
      doc.addEventListener(type, (event) => {
        if (!rightClick(event)) { if (type === 'mousedown') hideMenu(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }
    doc.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = frame.getBoundingClientRect();
      openMenu(rect.left + event.clientX, rect.top + event.clientY);
    }, true);
    doc.addEventListener('scroll', () => hideMenu(), true);
    doc.addEventListener('pointerdown', hideCmdMenu, true);
    doc.addEventListener('keydown', escapeMenu, true);

    // On a touch screen a tap must not reach the program as a mouse click. tmux (mouse on) and Claude Code both ask for mouse
    // tracking, so the tap that brings up the keyboard would also click inside Claude's screen: it moves the text cursor to the
    // tapped row or presses whatever control is drawn there. So xterm never turns tracking on here (the programs' request is only
    // remembered); the swipe below still reaches tmux as wheel events, and taps still focus the terminal.
    let appMouse = false;
    const TRACKING = new Set([9, 1000, 1002, 1003]);
    if (coarse) {
      const track = (on) => (params) => {
        const modes = params.flat();
        if (!modes.some((m) => TRACKING.has(m))) return false;
        appMouse = on;
        if (!on) return false; // let the reset through
        const rest = modes.filter((m) => !TRACKING.has(m)); // e.g. the 1006 (encoding) that comes with them
        if (rest.length) w.term.write(`\x1b[?${rest.join(';')}h`);
        return true;
      };
      w.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
      w.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
      // tracking may already be on (tmux asks as soon as it attaches)
      if (w.term.modes.mouseTrackingMode !== 'none') w.term.write('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l', () => { appMouse = true; });
    }
    const mouseWanted = () => (coarse ? appMouse : w.term.modes.mouseTrackingMode !== 'none');

    // One-finger vertical swipe -> mouse-wheel events, so tmux (mouse on) scrolls its history.
    let lastY = null; let acc = 0; let active = false;
    doc.addEventListener('touchstart', (e) => {
      active = e.touches.length === 1 && mouseWanted();
      lastY = active ? e.touches[0].clientY : null; acc = 0;
    }, { passive: true });
    doc.addEventListener('touchmove', (e) => {
      if (!active || e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      acc += t.clientY - lastY; lastY = t.clientY;
      const screen = doc.querySelector('.xterm-screen');
      if (!screen) return;
      const r = screen.getBoundingClientRect();
      const step = (r.height / w.term.rows) * 2.5;
      const col = Math.min(w.term.cols, Math.max(1, Math.floor(((t.clientX - r.left) / r.width) * w.term.cols) + 1));
      const row = Math.min(w.term.rows, Math.max(1, Math.floor(((t.clientY - r.top) / r.height) * w.term.rows) + 1));
      while (Math.abs(acc) >= step) {
        // finger down = look at older output = wheel up (64); finger up = wheel down (65)
        send(`\x1b[<${acc > 0 ? 64 : 65};${col};${row}M`);
        acc -= Math.sign(acc) * step;
      }
    }, { passive: false });
  }

  // ---- reconnect without asking
  // ttyd reconnects by itself only after a close it takes for a hiccup. Any socket error (what iOS reports for a socket it
  // dropped while the page was in the background or the phone asleep) and every clean close (the tmux client exited) leave it
  // showing "Press ⏎ to Reconnect" and waiting for a key. Nobody needs to be asked: if the session is still there, the page
  // presses Enter for them (ttyd's own reconnect), or loads the terminal again if ttyd does not take it. Paced, and only in front.
  let reconnects = [];
  let reconnecting = false;
  const askingToReconnect = () => {
    const el = w?.term?.element;
    return !!el && [...el.children].some((n) => /Press ⏎ to Reconnect/.test(n.textContent) && !n.className && n.style.opacity !== '0');
  };
  async function sessionStillThere() {
    try {
      const res = await fetch('api/sessions?owner=all&preview=0', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return true; // cannot tell (signed out?): try anyway, loading the terminal again shows what is wrong
      return (await res.json()).sessions.some((x) => x.id === sessionId && x.instance === sessionInstance);
    } catch { return true; }
  }
  async function reconnectIfAsked() {
    if (reconnecting || closing || document.hidden || !askingToReconnect()) return;
    const now = Date.now();
    reconnects = reconnects.filter((t) => now - t < 120000);
    if (reconnects.length >= 5) { showNotice('The terminal keeps disconnecting. Reload the page to try again.', true); return; }
    reconnecting = true;
    try {
      if (reconnects.length) await new Promise((resolve) => setTimeout(resolve, 1500 * reconnects.length));
      if (!askingToReconnect() || document.hidden) return;
      if (!(await sessionStillThere())) { showNotice('This session has ended. Return to the session list.', true); return; }
      reconnects.push(Date.now());
      const ta = w.document.querySelector('.xterm-helper-textarea');
      const enter = new w.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      for (const k of ['keyCode', 'which']) Object.defineProperty(enter, k, { get: () => 13 }); // xterm.js reads keyCode
      ta?.dispatchEvent(enter);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (askingToReconnect()) frame.src = frame.src; // ttyd did not take the key: load the terminal again
    } finally { reconnecting = false; }
  }
  setInterval(() => { void reconnectIfAsked(); }, 1500);
  document.addEventListener('visibilitychange', () => { void reconnectIfAsked(); });

  let setupTimer = null;
  frame.addEventListener('load', () => {
    clearInterval(setupTimer);
    w = frame.contentWindow;
    const t0 = Date.now();
    setupTimer = setInterval(() => {
      if (w.term && w.term.options) { clearInterval(setupTimer); setup(); }
      else if (Date.now() - t0 > 15000) clearInterval(setupTimer);
    }, 100);
  });
  // The foreground command says it; failing that (a wrapper, a renamed binary) ask for the conversation itself.
  async function isClaudePane(session) {
    if (/claude/i.test(session.command || '')) return true;
    try { await getJson('transcript?count=1'); return true; } catch { return false; }
  }
  async function connect() {
    try {
      const res = await fetch('api/sessions?owner=all&preview=0', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load the session. Refresh and sign in again.');
      const { sessions } = await res.json();
      const session = sessions.find((s) => requestedId
        ? s.id === requestedId && (requestedInstance ? s.instance === requestedInstance : s.name === name)
        : s.name === name);
      if (!session) throw new Error('This session has ended or been renamed. Return to the session list.');
      sessionId = session.id;
      sessionInstance = session.instance;
      name = session.name;
      renderName();
      updateUrl();
      readOnly = session.access === 'view';
      $title.disabled = $close.disabled = $read.disabled = $plain.disabled = false;
      if (readOnly) {
        // The server enforces this too (it refuses a non-owner's terminal without `ro`, and tmux attaches read-only);
        // this just removes the controls that could not work.
        $title.disabled = true;
        $close.hidden = $kb.hidden = $keys.hidden = true;
        document.getElementById('app').classList.remove('pagers');
        $title.title = '';
        showNotice(`Viewing ${session.owner?.name || 'another user'}'s session · read-only`);
      } else if (session.owner && !session.mine) {
        // allowed to manage it: a reminder, because what is typed here goes to them
        showNotice(`${session.owner.name}'s session · you can control it, so what you type goes to them`);
      }
      frame.src = `term/?arg=${encodeURIComponent(sessionId)}${readOnly ? '&arg=ro' : ''}`;
      // If Claude is what runs in it, open the way the last session was left on this kind of device: in the Read view (the
      // rendered conversation, also the default), as plain text, or (after Done) in the terminal.
      if (await isClaudePane(session)) {
        await Promise.race([prefs.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
        const view = prefs.get('view');
        if (view !== 'term') openReader(view === 'text', view === 'text' ? $plain : $read);
      }
    } catch (error) {
      showNotice(error.message, true);
    }
  }
  void connect();
})();
