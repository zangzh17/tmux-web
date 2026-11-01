# tmux-web

Open the site (desktop or phone) -> create a named tmux session or tap an existing one to attach. The pencil on a list card
renames that session (a dialog; the same rules and request as renaming from inside it), **Close** ends it after a confirmation.
Returning to the list removes the terminal iframe and detaches that browser client. Closing the terminal page also
disconnects it (the ttyd ping handles abrupt network loss). The tmux session keeps running.
Inside a session, tap its title to edit the name; Enter or blur saves automatically, and Escape cancels.
**Read** (book icon) opens a read-only reading view with native scrolling, wrapping and text selection; the live terminal
keeps running underneath. **Copy** (next to it) opens an editable copy of the text instead (below). On a phone the
header buttons are icons only and always stay on one row (when they do not fit, the row scrolls sideways and fades at the edge
that has more; on a phone the rarely used A−, A+ and Close come last); the toolbar of the view is icons too: Files, Scratch,
Copy, Aa, Refresh, which scroll the same way, and **Done** (a word, so it is not taken for the session's Close), which never scrolls
away. It exists because the live terminal has no usable history for Claude Code (it runs on tmux's
alternate screen, so `history_size` is 0, and it draws at the width it had when it printed).

**Opening a session that runs Claude starts in this view**, with Render on: the page checks the foreground command (and, failing
that, whether the pane has a transcript) every time it is opened, and opens the conversation by itself. **Done** returns to the
terminal and it stays there until the page is opened again; a plain shell opens in the terminal as before.

* In a pane running Claude Code (`pane_current_command` matches `TMUX_WEB_CLAUDE_COMMAND`) it shows the **conversation**,
  rebuilt from **that pane's own** transcript file: Claude Code records every running instance in `~/.claude/sessions/<pid>.json`
  (its current `sessionId`, which follows `/clear` and `--resume`, and `tmux: "<session>:<window id>.<pane id>"`), and the pane's
  conversation is `~/.claude/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl`. (Taking "the newest file in the
  directory" instead made two Claude panes in one directory show each other's conversation.) A record only counts when its process
  runs under this pane, and a pane whose conversation has no file yet shows none rather than someone else's; a Claude that keeps
  no such record falls back to the newest file of the directory:
  your messages as bubbles with their time, Claude's replies rendered as Markdown (code highlighting, LaTeX math, tables),
  and consecutive tool calls/results folded into one `N steps · Bash ×2 · Read` capsule (red if a result failed; expand for
  the command and a folded result). Slash commands, `/compact` summaries and interruptions get their own small markers.
  It opens at the newest message; scroll up to load earlier ones (150 at a time), tap **Refresh** for new ones.
  **Render** is on every time Read opens; **View: Rendered** in the Aa panel switches Markdown/math/highlighting off for the view
  that is open (it used to be an eye button in the toolbar, too easily taken for the way out).
* **Copy** (on the terminal page's header, in the Read view's toolbar, and in the scratch terminal) opens a sheet like the
  scratch terminal's with an editable text box: change, cut and select freely, then **Copy selection** or **Copy all**; nothing
  typed there reaches a terminal, and the key bar is off while it is open. The text comes from the **Terminal** (tmux's scrollback,
  up to 5000 lines; a Claude session's is just its screen), the **Conversation** (Claude's, as plain text: your messages and
  Claude's replies exactly as written, speaker lines `You · 14:02` / `Claude`, tool calls as one `[Bash] command` line each,
  failed tool results as `✗ first line`, the newest 500 entries) or the **Scratch** terminal; it opens on the conversation in a
  Claude session and in the Read view. Wrap (long lines), Reload (the text again, edits gone), taller/shorter.
  In a pane that is not Claude it shows the tmux scrollback, as Read does.
* **You can answer from here.** In a Claude conversation a message box sits under the text. On a computer Enter sends and
  Shift+Enter starts a new line; on a phone Enter is a new line and **Send** sends. On a phone, while you write (the box focused,
  or not empty) the box takes the whole width and its buttons move to a row under it. The box grows with the text up to what the
  keyboard leaves (the heading, open panels and a strip of the conversation stay), and the line with the caret stays in view.
  The ⤢ button opens a **full-screen editor**: only the message, under one bar with **Conversation** (back, the message kept, at
  the place you were reading), the character count, Upload and Send; sending from it goes back to the conversation at the end.
  Esc on a keyboard leaves the editor first. Your message shows dimmed
  ("Sending…") until Claude's transcript has it, and the answer streams in by itself (the view polls every 1–2.5 s while it is
  open and the tab is visible). While Claude is running a one-line **Working…** row shows with **Stop** (sends Esc) and
  **Screen** (opens Screen & keys; on narrow phones the row drops the words "Claude is" so it never wraps). If you have scrolled
  up to read, new messages do not move you; a **↓ New messages** button appears instead, and nothing updates while you have
  text selected. The terminal button next to the box opens **Screen & keys**: the pane's current screen plus Esc, ↑, ↓, Enter,
  1, 2, 3, y, n, Tab, Shift+Tab and Clear, for permission prompts and menus that need a key rather than text. It opens by
  itself when Claude asks for permission ("Do you want to proceed?"), and after a slash command that only draws on the
  terminal (like `/cost`; such commands are not written to the transcript). If Claude exits, the box says so; **Refresh**
  checks again. After **Stop** Claude Code puts the interrupted prompt back in its input box; the next message you send
  replaces it rather than being glued onto it.
* In any other pane it shows the tmux scrollback (up to 2000 lines, wrapped lines joined); if that is unavailable, the
  current screen as xterm.js has it.
* Copying is native: long-press text on a phone, adjust the handles and choose Copy; drag and Ctrl/Cmd+C on a computer.
  There are no Copy buttons under the text. Code blocks have their own **Copy** button. Loading and error messages show in
  a thin line under the heading only while there is something to say.
  The keyboard stays hidden in this view. Tap **Done** to return, then tap the terminal when you want to type.
On desktop, hold **Shift** while dragging to select terminal text (**Option** on Mac), then
use **Ctrl/Cmd+C** (or the editable **Copy** sheet). With no text selected, Ctrl+C still interrupts
the running program. Right-click opens one local **Copy / Paste / Select all** menu; it does not
also open a tmux menu. Clipboard buttons use the browser clipboard, with a native-copy fallback.
Above the session list, **− n +** sets how many preview lines each card shows (0, 1, 2, 3, 5, 7, 10, 15, 20, 30 or 50; the middle
button hides the previews or brings them back). The default is 7, and the choice is remembered per browser. The API supplies up
to the last 50 nonempty output lines, including recent scrollback when the terminal is short. Long lines are truncated within
each card so they cannot expand the page past the screen width; a faded top line means there is more above.
A Claude session's card shows how full its conversation is (a small bar: amber from 50 %, red from 80 %; hover for the tokens).
The two rings in the header are what is left of the account's Claude **5-hour** and **weekly** limits. They open a panel with each
window from its start to its reset: the usage so far, an even pace (the faint diagonal) and where the pace so far leads, with
when it runs out if that comes before the reset. The panel starts open on a wide screen and closed on a phone; tapping the
rings opens or closes it, and that choice is remembered per device kind.
The Read view's **Aa** button opens a row with **Size** (A−/A+ or the slider, 80–500 %, scales everything in the text including code and
tool steps) and **Width** (Normal 760 px, Wide 1100 px, Full).
Display preferences (terminal font, Read size and width, and the view a Claude session opens in) are remembered per person
**and device kind** (phone, tablet, desktop: a touch screen whose short side is ≥ 600 CSS px is a tablet, so an iPad and an
iPhone keep their own sizes): in the browser, and on the server (`GET/PUT /api/prefs`, `TMUX_WEB_PREFS`, default
`~/.local/state/tmux-web/prefs.json`, mode 600, only whitelisted keys), so they survive Safari clearing site data and reach
another device of the same kind. A Claude session opens in Read only if Read (or Text) was the last view used; after **Done**
the next one opens in the terminal.
**Upload** (header, and the same button left of the Read view's message box) sends files, photos, a whole folder, or what is on
the **clipboard** (an image such as a screenshot, or a file: the Clipboard button reads it, the browser may ask first; or paste
into the box under it, or anywhere while the dialog is open). An image or file pasted straight into the terminal, the scratch
terminal or the message box is uploaded the same way, and Paste / Add to message puts its path there; a nameless or `image.png`
one is named `clipboard-<date>-<time>.<ext>`. It all goes to
a new folder under `TMUX_WEB_UPLOADS` (default `~/.cache/tmux-web/uploads/<date>-<time>-<hex>/`, mode 700). The page packs the
selection into one tar (a folder keeps its tree; browsers send no empty folders; iOS may not offer folder picking) and sends it in
8 MB pieces (`POST /api/uploads {size}`, `PUT /api/uploads/:id?offset=N`, `POST /api/uploads/:id/done`, `DELETE` cancels), so each
request stays under Cloudflare's body limit and a dropped piece is resent from where the server stands. The server unpacks it with
GNU tar after checking that it holds only plain files and folders with names inside the folder. Then **Paste into terminal**
(bracketed paste, no Enter; Claude Code turns a pasted image path into an attachment) or **Add to message** in Read puts the
shell-quoted paths in, and they are copied to the clipboard (Safari only allows that on a tap: Paste, Copy or Done).
Limits: `TMUX_WEB_UPLOAD_MAX_MB` (4096) per upload, 1 GB of disk kept free; folders are deleted after `TMUX_WEB_UPLOAD_DAYS` (7),
unfinished uploads after a day or an API restart.
When ttyd gives up on its socket and shows "Press ⏎ to Reconnect" (it does after any socket error, which is how iOS reports a
connection dropped while the page was in the background, and after a clean close), the page checks that the session still
exists and presses Enter for it (or loads the terminal again); at most five tries in two minutes. On a phone held sideways, Full
also gives the text the safe-area margin of the edge without the notch (the side is taken from `window.orientation`).
While the page is pinch-zoomed (`visualViewport.scale > 1`) it no longer follows the visual viewport (that resized and moved the
page on every pan step and flickered); keyboard tracking resumes at 1×.
On touch screens, printable characters typed into the live terminal are taken from the browser's `input` event and the
IME's committed text rather than from keydown: iOS's Chinese keyboard reports punctuation as keydown 229 or as the ASCII key
under it, which xterm.js turned into a doubled `，，` or a `,`. Control keys (Enter, Backspace, arrows, Ctrl chords) still go
through xterm. QA: change `20261015-reader-ime` (`qa/ime-qa.mjs`, `qa/reader-fmt.mjs`).
The top-left control of the Read view is **Detach** (back to the session list; the session keeps running); ✕ closes only the view.
The **Close** button on each list card and inside a session opens a confirmation dialog. Confirming ends that entire session,
including its windows and running programs, and returns to the list.

```
browser ─► Cloudflare Access (login) ─► cloudflared tunnel ─► Caddy 127.0.0.1:8890
                                                               ├─ forward_auth ─► server.mjs  (verifies Cf-Access-Jwt-Assertion)
                                                               ├─ /api/*       ─► server.mjs  (tmux session management) [unix socket]
                                                               ├─ /term/*      ─► ttyd        (xterm.js <-> pty)    [unix socket]
                                                               └─ /            ─► public/     (list page + phone-friendly terminal page)
```

* ttyd 1.7.7 (`~/.local/bin/ttyd`) is the terminal engine. `bin/tmux-web-attach` attaches to an *existing*
  session only. `POST /api/sessions` creates a detached session with a validated name (`[A-Za-z0-9][A-Za-z0-9_-]{0,47}`)
  before the browser attaches. `PATCH /api/sessions/:id` renames an existing session; renamed titles
  support Unicode letters/numbers, spaces, `-`, and `_`, up to 48 characters. `DELETE /api/sessions/:id`
  requires explicit `confirmed: true` and ends only that session. Rename and close also require the
  `instance` identity returned by the session API. All mutations require a valid Access JWT,
  JSON, and a matching Origin. No endpoint accepts arbitrary tmux commands; `input` only sends text or an allow-listed key to a Claude pane.
* Session links, the terminal connection, rename, and close use immutable tmux session IDs so a rename
  keeps the terminal connected and reconnects correctly. Existing links containing only a name still resolve.
  A server/birth identity also prevents an old tab from changing a new session that reuses an ID.
* ttyd and the API listen on Unix sockets in `$XDG_RUNTIME_DIR/tmux-web` (mode 0700) so other local users
  cannot reach them. Caddy binds loopback only and refuses anything without a valid Access JWT.
* Read-only views (GET only, behind the same Access check): `GET /api/sessions/:id/history?lines=N` returns the pane's
  scrollback; `GET /api/sessions/:id/transcript?before=I&count=N` (or `?after=I`) returns `{id, session, file, total, start, items}`
  for the Claude conversation, where `items` is `[start, start+items.length)` of the append-only item list (indexes never
  change within one `file`; a new file means a new conversation). Item kinds: user, assistant, tool, result, command,
  notice, summary. Tool inputs are cut to 6 lines/400 chars and results to 40 lines/4000 chars. The transcript is parsed
  incrementally and cached per file (only new bytes are read, only up to the last newline; 16 files, LRU), so a 260 MB
  transcript costs about 1.5 s the first time and milliseconds afterwards.
  `TMUX_WEB_CLAUDE_COMMAND` (regex, default `claude`, case-insensitive) says which panes count as Claude;
  `TMUX_WEB_CLAUDE_PROJECTS` overrides `~/.claude/projects`.
* `GET /api/sessions` gives each Claude session `context: {tokens, window, model}` (null otherwise, and with `?preview=0`):
  input + cache read + cache write of the conversation's newest main-chain answer, read from the end of its transcript, against
  a 1M window for the Claude 5 models (`TMUX_WEB_CONTEXT_1M`, a regex on the model id) or anything past 200k, else 200k. Right
  after a compaction it is `{compacted: true}` until Claude answers again.
* `GET /api/usage` returns `{now, at, error, fiveHour: {used, resetsAt}, sevenDay, history: [[time, 5-hour %, weekly %], ...]}`
  for the account's own Claude login: what Claude Code's `/usage` shows, from `api.anthropic.com/api/oauth/usage` with the
  access token in `~/.claude/.credentials.json` (`TMUX_WEB_CLAUDE_CREDENTIALS`). The API asks every 5 minutes, and when a page
  wants it and the last try is over 2 minutes old; it keeps 8 days of answers for the trend in `TMUX_WEB_USAGE` (default
  `~/.local/state/tmux-web/usage.json`, mode 600, no token in it). It never refreshes the login (that would rotate the refresh
  token under Claude Code): while the token is expired, `error` says so and the last answer stands. A 429 pauses it as long as
  `Retry-After` asks (15 minutes without one).
* **Scratch** (header) opens a throwaway shell over the lower part of the page (a floating window on a wide screen) in the
  session's directory: `POST /api/scratch {from}` or `{cwd}` makes a tmux session marked `@tmux_web_scratch` (no status line, in
  no list, at most 8). While it is open the key bar, the commands menu and Files type into it; it has its own **Paste** (a text
  box to paste into when the browser will not hand over the clipboard), **Copy** (its selection, or its output in the Copy sheet),
  taller/shorter, **minimise** (hidden, still running: a dot on Scratch, which brings it back) and **Close**, the only thing that
  ends it. Leaving the page leaves it running too: the next session page of this account finds it (`GET /api/scratch`, one's own,
  the most recently used first) and shows it again if it was up when left. Above the Read view it is shown as a modal of its own.
  The API ends one that has had neither a client nor any output for a day (`TMUX_WEB_SCRATCH_IDLE`, seconds). `exit` in it
  closes the panel.
* **Files** (header) is a small file manager, working as this account's Unix user, that opens in the session's directory (the
  scratch terminal's while that is open): a tap opens a folder, the path bar goes back up (or to `/`), ⋯ on an entry offers cd,
  Scratch here, Insert path, Copy path, Rename and Delete (asks first; a folder goes with everything in it); for the folder shown:
  **cd here** (shells only), Insert path, Scratch here, New folder, `.hidden`, `~`. `GET /api/files?path=` (or `?from=<session>`)
  lists a folder, folders first; `POST /api/files {op: mkdir|rename|delete, path, name, to}` changes one entry (a single name,
  rename never replaces anything).
* `POST /api/sessions/:id/input` types into the session's Claude pane: `{instance, text}` or `{instance, key}`. It needs the
  same Access token, matching Origin, JSON body and session `instance` as rename/close, and it refuses (409) any pane that is
  not running Claude, so it cannot be used as a general way to type into a shell. `text` is control-character-stripped (so pasted
  text can never contain the bracketed-paste end marker), limited to 20000 characters, pasted with `tmux paste-buffer -p -r`
  and then submitted with Enter after a short settle delay (`TMUX_WEB_INPUT_SETTLE_MS` fixes it; default scales with length).
  First, if the input box on screen holds leftover text, it is emptied with `C-u`/`BSpace` (never `C-c`, whose second press quits Claude);
  a permission prompt or an unrecognised screen is left alone.
  `key` must be one of `Enter Escape Up Down Left Right Tab BTab C-u 1 2 3 4 5 y n`. `GET .../history?screen=1` returns only the
  visible screen, and transcript responses carry `busy` (a turn is running) and `asking` (a permission prompt is waiting), both read
  off the screen. That depends on Claude Code's wording (`✻ Creating…`, `✻ Coalescing… (7s · …)`, `Do you want to … 1. Yes`, checked
  against 2.1.291); if a future version changes it, `busy`/`asking` stay false and only the "Sending…" placeholder and the typing keep working.
* `server.mjs` is zero-dependency Node. It fails closed: until `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set
  in `~/.config/tmux-web/env`, every request gets 503.

## Install

Requirements: Linux with systemd user services, tmux 3.x, Node 20+, [ttyd](https://github.com/tsl0922/ttyd) 1.7+, [Caddy](https://caddyserver.com) 2.x
(both single binaries; the examples expect them in `~/.local/bin`), and a Cloudflare Access application in front of the site: the
API accepts **only** a valid Cloudflare Access JWT (there is no password login), and refuses everything until it is configured.

1. Put the checkout somewhere (the example units assume `~/tmux-web`; adjust them if it is elsewhere).
2. Copy `systemd/tmux-web-*.service` to `~/.config/systemd/user/`, and `systemd/tmux-web-api.service.d/session-lifetime.conf` to
   `~/.config/systemd/user/tmux-web-api.service.d/` (it keeps tmux sessions alive across API restarts, see below).
3. `mkdir -p ~/.config/tmux-web && cp env.example ~/.config/tmux-web/env && chmod 600 ~/.config/tmux-web/env`, then fill it in (below).
4. `systemctl --user daemon-reload && systemctl --user enable --now tmux-web-ttyd tmux-web-api tmux-web-caddy`
   (`loginctl enable-linger $USER` keeps them running when you are logged out).
5. Point a Cloudflare Tunnel (or any reverse proxy) at `http://127.0.0.1:8890`. Caddy binds loopback only.
6. In `~/.tmux.conf`: `set -g mouse on` and `set -g history-limit 20000` (the list/phone scrolling expects them).

**Cloudflare Access.** Create a self-hosted Access application for your hostname with an allow policy for the people who may use it.
Put your team domain (`yourteam.cloudflareaccess.com`) and the application's AUD tag in `~/.config/tmux-web/env`
(`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`); `ALLOWED_EMAILS` is an optional second check at the origin. If you add someone to the
policy, add them there too and `systemctl --user restart tmux-web-api`. Multi-user separation is **off** unless you create a users file
(see "Users and permissions").

## Users and permissions (optional)

**Multi-user is optional and off by default.** It is on exactly when a users file exists (`~/.config/tmux-web/users.json`, or
`TMUX_WEB_USERS`; `TMUX_WEB_MULTI_USER=0` forces it off even then). Without one, everybody Access lets in is simply the
operator: every session is shown to and usable by all of them, nothing is stamped with an owner, `/api/me` answers
`multiUser: false`, and the page shows none of what follows (no "Signed in as", no owner tags, no "Show sessions from" row, no
read-only views). Everything below describes the mode a users file switches on.

Several people can sign in (everyone in the Access policy and `ALLOWED_EMAILS`). Every session still runs as the one Unix
user; the web layer keeps them apart by **who started a session on the page**.

* A session made with **Create & open** records its creator's Access email in tmux (session option `@tmux_web_owner`).
  Sessions started any other way (a terminal, before this feature) have no owner and are shown as **Local**.
* The list shows your own sessions and the Local ones. Nobody else's, unless `users.json` lets you (below). Then a
  **Show sessions from** row appears (Mine, Local, each person you may view, Everyone); the choice is remembered per
  browser. People without that right never see the row, and the server ignores any filter they try to send.
* If you may only **view** someone else's session it opens **read-only**: you can watch the terminal and use **Read** (the
  conversation updates live), but there is no message box, key bar, rename or Close, and tmux attaches the client
  `read-only,ignore-size` so it cannot type or resize the owner's window. If you may **manage** it, it behaves like your own
  (read-write terminal, message box, rename, Close), with a reminder at the top and the owner named in the Close confirmation. A session you may not see answers 404 on every route, including the terminal WebSocket.
* The terminal WebSocket goes browser → Caddy → ttyd and never touches the API, so it is checked in `/verify`: Caddy hands it the
  real request URI (`X-Forwarded-Uri`; a client-sent copy is overwritten), and only `?arg=$N` (owner or Local) or
  `?arg=$N&arg=ro` (view-only) for a session you may see is let through; anything else on `/term/ws` is refused.

`~/.config/tmux-web/users.json` (path overridable with `TMUX_WEB_USERS`; see `users.example.json`; re-read when it changes,
and a broken edit keeps the last good version) holds only what differs from a plain user (the `//` notes are for illustration; real JSON has no comments):

    { "unowned": "all",                                  // who sees Local sessions: "all" (default), "viewers", "none"
      "users": { "owner@example.com": { "name": "Owner", "manageOthers": "all" },
                 "alice@example.com": { "name": "Alice", "viewOthers": ["bob@example.com"] } } }

`viewOthers` and `manageOthers` each take `"all"` or a list of emails. Managing implies viewing, so a superuser needs only
`"manageOthers": "all"`. "Viewers" in the `unowned` setting means anyone with either permission.

A signed-in email that is not listed is a plain user: it sees its own sessions (and Local ones per `unowned`) and nobody else's.
To add a person: add the email to the Access policy **and** `ALLOWED_EMAILS` (restart the API), then, if they should see
others, to `users.json`.

**Sharing.** Whoever may control a session (its owner, an admin, someone with `manageOthers`) can share it with other people of
the same account: the people icon on its card, then **Off / View / Control** for each person. They then see it in their list
("Shared with you" when it is a local one): View opens it read-only as above, Control as if it were theirs. The card shows
"Shared with …". It is kept in the tmux session option `@tmux_web_share` (`PUT /api/sessions/:id/share {instance, share:
{email: "view"|"full"}}`; `{}` stops sharing). Admins are never offered (they see everything anyway), nor the session's owner.

**Somebody else's session opens read-only.** A session that is not your own (someone else's, a local one you only see because it
was shared, any session of another account) attaches read-only even when you may control it, so a look does not resize their
window or type into it. **Take control** in the bar under the title reloads it read-write (`?control=1`); **View only** goes back.

**What this is not.** It separates people in the web UI and API; it is not a security boundary between Unix accounts. Anyone who
can open a terminal here can run any command as this user, so they could read other sessions through tmux itself, read files
or kill the tmux server. Give an account only to someone you would give that shell to. `unowned: "all"` means every user
can use your own terminal-started sessions (including Claude ones); use `"viewers"` or `"none"` to keep them to yourself.
For people who should not share a Unix user, see the next section.

## Several Unix accounts (optional)

One site can also serve several Unix accounts, so that someone works as their own Unix user. Every account runs its own copy
of the API and ttyd as that user (its sessions, `~/.claude` transcripts and uploads are its own), with its sockets in
`/run/tmux-web/<account>/`. One Caddy, run by the **home** account, sends `/a/<account>/api/*` and `/a/<account>/term/*` there;
everything without `/a/` is the home account's. The page is the same everywhere (its links are relative, so under
`/a/<account>/` it talks to that account); everybody's display preferences (`/api/prefs`) and the account switches
(`/api/accounts`) are kept by the home account.

    browser ─► Access ─► cloudflared ─► Caddy 127.0.0.1:8890 (run by the home account)
                                         ├─ /api/*, /term/*            ─► /run/tmux-web/<home>/   API + ttyd as the home account
                                         ├─ /a/<acct>/api/*, /term/*   ─► /run/tmux-web/<acct>/   API + ttyd as <acct>
                                         └─ the page, also /a/<acct>/  ─► /opt/tmux-web/public

`/etc/tmux-web/users.json` (see `deploy/users.example.json`):

    { "home": "zihan", "accounts": ["xyp"], "unowned": "viewers",
      "users": { "zihan@example.com": { "name": "Zihan", "admin": true },        // every account, every session
                 "wfh@example.com":   { "name": "wfh" },                          // the home account: own sessions (and shared ones)
                 "xyp@example.com":   { "name": "xyp", "account": "xyp" } } }     // the xyp account only, all of it

* `home` is the account that runs Caddy; a person without `account` works in it. `accounts` lists the others. `admin` may enter
  every account and do anything with every session there.
* Each backend lets in only its own account's people and admins, and checks that itself (a request that reaches the wrong
  backend finds nothing): anyone else gets 403 from its API and its terminals. Its `/api/me` then says `allowed: false` and the
  person's `myAccount`, and the page moves them to `/a/<myAccount>/`.
* In an account other than home, its people may do anything with every session in it, local ones too (they all run as them),
  and there is no owner filter. In the home account everything in the previous section applies (owners, `unowned`, sharing).
* An admin gets an **Account** row: a chip per account (green: running, amber: starting or stopping, grey: off) and **Turn on /
  Turn off** for the others. Off stops that account's API and ttyd (about 100 MB), never its tmux sessions. The switch is
  the file `/etc/tmux-web/accounts/<account>` (`on`/`off`, also fine to edit by hand); the account's own `tmux-web-switch.path`
  (a systemd user unit, running as that account) starts or stops the two to match within a second or two. While an account is
  off its page says so, with **Turn it on** for an admin; its own people are told to ask an admin, and the page opens their
  account by itself once it is on.
* A backend started with `TMUX_WEB_MULTI_ACCOUNT=1` (the units do) refuses every request while the users file is missing or
  names no `home`, instead of treating everybody as its operator.

**What this is and is not.** Each account's sessions run as its own Unix user, so file permissions between accounts hold. But the
home account controls the others: it runs the front door, owns `/opt/tmux-web` (the code every account runs) and `/etc/tmux-web`,
and can reach every account's sockets, so anyone who can run commands as the home account (in a terminal here too) can act as
any account. Also check the other accounts' Unix groups: `sudo`, `lxd` or `docker` make an account root-equivalent, whatever the
web allows.

**Install** (systemd, Node 20+ at `/usr/bin/node`, ttyd and caddy in the home account's `~/.local/bin` or in `/usr/local/bin`):

1. `sudo deploy/setup-root.sh <home> <account>...`, once and again after adding an account. It makes `/opt/tmux-web` and
   `/etc/tmux-web` owned by the home account (no sudo needed afterwards), copies ttyd and caddy to `/usr/local/bin`, makes the socket
   directories at every boot (tmpfiles.d; another account's is `2750 <account>:<home's group>`, so only the front door gets in),
   installs the units in `/etc/systemd/user`, and for every other account turns on linger, writes its switch (`off` unless it
   exists) and enables `tmux-web-switch.path`.
2. As the home account, `deploy/install.sh`: copies the checkout to `/opt/tmux-web`, the first time also `~/.config/tmux-web/env`
   and `users.json` to `/etc/tmux-web/` and the old per-user units to `~/.config/tmux-web/old-units`, then (re)starts the home
   account's API, ttyd and Caddy; accounts that are on restart with the new code. Run it again after every change.
3. Edit `/etc/tmux-web/users.json` (re-read on change). Add every person to the Access policy and to `ALLOWED_EMAILS` in
   `/etc/tmux-web/env`; after changing env, run `deploy/install.sh` again (accounts that are off read it when turned on).

## Services (systemd --user)

    systemctl --user status tmux-web-ttyd tmux-web-api tmux-web-caddy
    journalctl --user -u tmux-web-api -f        # shows why a token was denied
    systemctl --user restart tmux-web-api       # after editing ~/.config/tmux-web/env
    systemctl --user restart tmux-web-ttyd      # detaches all web clients (sessions survive)

The API service needs `systemd/tmux-web-api.service.d/session-lifetime.conf` installed at
`~/.config/systemd/user/tmux-web-api.service.d/session-lifetime.conf`, followed by
`systemctl --user daemon-reload`. Its `KillMode=process` keeps a tmux server spawned by the API
running across API restarts; the systemd default would terminate every session in that process group.

## Desktop notes

* **Selecting text** while tmux or Claude Code has mouse tracking on: hold Option (Mac) or Shift (elsewhere) and drag; that forces
  xterm.js's own selection instead of sending the mouse to the program.
* The screen is drawn on a **canvas** (xterm.js's canvas addon, `public/vendor/xterm-addon-canvas.js`, loaded into the terminal page),
  not with ttyd's `rendererType=dom` text layout. The DOM renderer lays a row out with the browser's own text flow and corrects each
  run's width with a letter-spacing computed from a measurement; a glyph drawn wider or narrower than measured (fullwidth
  punctuation, `❯ ● ⏸ ✻` and the like, all over Claude's screen) pushed the rest of the row off the cell grid, so a drag selection
  started a character late or early (the first character "eaten") and ended away from the pointer. On a canvas every glyph sits in its
  own cell. Phones keep the DOM renderer; `localStorage.setItem('tmuxweb.renderer', 'dom')` switches a desktop back.
  The addon must pair with the xterm.js inside ttyd (`@xterm/addon-canvas` 0.7.0 for ttyd 1.7.7; 0.5 throws on it): re-test after a ttyd upgrade.

## Phone notes

* Key bar (phone, two rows of seven with Enter, shown as ⏎, down the right edge): Esc, the commands key (`>_`), Tab, ^U, ↑ ↓, ⌫ /
  ^A, ← →, ^E, |, /, ~ (^A start of line, ^E end, ^U clear back to the start). Up/down and left/right are two colours and never
  one pair right above the other. On a touch screen ← or → held opens a small row of **×5 ×10 ×20** over the key: slide onto
  one and let go, or let go and tap one. Desktop: the same keys in one row. Tablet: bigger keys, plus ^C, **Send now** (Claude Code's
  Ctrl+X Ctrl+S, `chat:sendNow`: a message queued while Claude works is sent at once, interrupting the turn) and ⇧Tab, with the
  arrows as a cross and Enter in its middle. Page up/down are round bubbles on both edges of the terminal, shown with the key bar.
  The Read view shows **Send now** next to Stop while a message you sent waits for a busy Claude (API key `SendNow`).
  The commands key opens a small menu above the bar: **claude** (types `claude --dangerously-skip-permissions` and Enter),
  **/resume**, **/compact**, **/model**, **/effort**, a row of `/effort max | xhigh | high | medium | low`, **Send now** (typed, then Enter a moment later as a separate keystroke, because Claude Code treats text that
  arrives together with a newline as a paste), **Paste** and **Ctrl-C**. Claude's own commands and Send now only show while
  Claude runs in the session (the session list's `claude` field), and `claude` only while it does not. With the phone keyboard up the menu is a compact grid of six chips. `claude` is greyed out ("Already running") while Claude is the
  pane's foreground program, since it would be sent to Claude as a message. The menu closes on a tap elsewhere, Esc, or a
  second tap on the key; with a keyboard, arrows/Home/End move and Enter chooses.
  A tap sends its key on release; horizontal swipes scroll the compact bar without sending keys.
  Arrows and page keys repeat when held without moving.
  The outlined keyboard icon and **Key bar** label toggle it; the highlighted state means it is visible.
* When the phone keyboard opens or vertical space is short, the header becomes one compact row
  and the key bar becomes one horizontally scrollable row. The terminal refits to the visual viewport. The keyboard is told
  from a turned screen by comparing heights at the same width (an iPad turned on its side stays in the normal layout), and while it
  is up the home-indicator inset is not kept free (it is under the keyboard). With a short view and the keyboard up, Screen & keys
  shows only its keys while you type.
* Every button on a touch screen is at least about 36–44 px; the Read view's Detach is a 44 px target set apart from the tools.
* If the keyboard (plus iOS's AutoFill bar and Safari's bars, or a zoomed page) leaves the terminal fewer than 13 rows, Claude
  Code may not fit its screen (its bottom block alone is 8-10 rows in a long session): its input line falls off the bottom and the cursor ends up on the rule under it. In that case the
  title bar folds away, the key bar slims down and, only if still needed, the font shrinks in half-pixel steps (never below 9px; the saved size is
  untouched). Everything comes back when the keyboard closes. The hidden input also asks iOS not to show AutoFill.
  The layout is re-checked whenever the viewport, the key bar or the terminal's own box changes, and four times a second for
  the viewport itself (iOS does not always announce a change). If the cursor is still found on a line of ───── while the
  keyboard is up, the page first nudges the size (tmux re-reads it and Claude redraws), then, on a short screen, takes one more
  font step; it never types anything into the program, and starts afresh when the viewport height changes. Below 7 rows even
  the key bar steps aside. The commands menu ends with a small grey line (build, columns×rows, font, view height, mode,
  attached clients, and the flags above): that is what to send along when the phone looks wrong.
* A tap on the terminal focuses it (the keyboard opens) but is never sent to the program as a mouse click: tmux and Claude
  Code both ask for mouse tracking, and Claude Code moves its text cursor to a clicked column, so on a touch screen the tap that
  opened the keyboard used to move the cursor into the middle of the input. On touch devices xterm.js therefore keeps mouse
  tracking off (the programs' request is remembered); computers are unchanged.
* One-finger swipe scrolls tmux history (needs `set -g mouse on`, which `~/.tmux.conf` has, plus
  `set -g history-limit 20000`). For anything longer, use **Read**.
* If a tmux window is `window-size manual` (e.g. after `resize-window`), a larger client only gets dots around it;
  `tmux set -w -t SESSION:WINDOW -u window-size` puts it back to automatic.
* `A-`/`A+` change the font size (remembered per browser).

## Tests

Run `node --test test/*.test.mjs` (the plain `node --test test/` form does not work on Node 22). Every test starts its own
`tmux -L` server and Access signing keys, so it never touches real sessions. `server.test.mjs` covers authentication,
Origin/content-type restrictions, name validation and conflicts, rename without pane/window loss, explicit close
confirmation, and survival of other sessions. `history.test.mjs` and `transcript.test.mjs` cover the read-only views
(hand-written jsonl: backward pagination, every classification, truncation, ANSI, a half-written last line, non-Claude panes
→ 404, two Claude panes in one directory each getting their own conversation; `TMUX_WEB_CLAUDE_COMMAND='^sleep$'` lets a `sleep` pane stand in for Claude). `input.test.mjs` drives a fake Claude terminal (bracketed paste on) to check exactly which bytes arrive. `users.test.mjs` covers ownership, the per-user list, the permission matrix on every route, `/verify` for terminals,
config reloads, and multi-user being off without a users file. `accounts.test.mjs` runs a home and a personal account side by
side: who may enter which, admins, sharing, `/api/accounts` and the switches, and refusing everything without a valid users file.
`scratch.test.mjs` and `files.test.mjs` cover scratch terminals (directory, hidden from lists, close, sweep, the cap) and the
file API (listing, links, mkdir, rename without replacing, delete, refused names). `usage.test.mjs` runs `/api/usage` against a stand-in for Anthropic: the request it makes, the history it keeps, and no login, an
expired or refused one, a rate limit and an odd answer. `helpers.mjs` is the shared scaffolding; it points every test at its own
Claude login file and an unreachable usage URL, so no test reads the real login or asks Anthropic.

## Vendored libraries

`public/vendor/` serves the reading view's renderer from this site, so the phone needs no outside network:
marked 15, DOMPurify 3, KaTeX 0.16 (woff2 fonts only; the CSS is rewritten to match), highlight.js 11 (common build plus
`matlab`). They load when Read first opens a conversation. See `public/vendor/README.md` for versions and how to update.

For browser checks, use a separate stack with a test Access issuer, private sockets and an isolated
tmux server. Check inline editing, persistent terminal/reconnect, keyboard visibility, cancel/error/
confirm close flows, return to the list, and narrow mobile layouts.
