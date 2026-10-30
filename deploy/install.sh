#!/bin/bash
# tmux-web with several Unix accounts: put this checkout in /opt/tmux-web and (re)start the home account's services; every
# other account that is switched on restarts too, to load the new code. Run it as the home account, after
# sudo deploy/setup-root.sh. Sessions keep running; open pages reconnect by themselves.
# The first time it also moves a single-account install's units out of the way (to ~/.config/tmux-web/old-units) and copies
# ~/.config/tmux-web/env and users.json to /etc/tmux-web unless they are there already.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
[ -w /opt/tmux-web ] && [ -w /etc/tmux-web/accounts ] || { echo "run sudo deploy/setup-root.sh first" >&2; exit 1; }

rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$here"/server.mjs "$here"/Caddyfile "$here"/public /opt/tmux-web/
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rwx,Fgo=rx "$here"/bin /opt/tmux-web/

for f in env users.json; do
  if [ ! -e "/etc/tmux-web/$f" ] && [ -e "$HOME/.config/tmux-web/$f" ]; then
    install -m 0644 "$HOME/.config/tmux-web/$f" "/etc/tmux-web/$f"
    echo "copied ~/.config/tmux-web/$f to /etc/tmux-web/$f"
  fi
done
# the new backends refuse every request until users.json names the home account: stop here rather than take the site down
if ! grep -q '"home"' /etc/tmux-web/users.json 2>/dev/null; then
  echo 'stopped: /etc/tmux-web/users.json names no "home" account (see deploy/users.example.json); nothing was restarted' >&2
  exit 1
fi

units=(tmux-web-api.service tmux-web-ttyd.service tmux-web-caddy.service)
if compgen -G "$HOME/.config/systemd/user/tmux-web-*" >/dev/null; then
  systemctl --user disable --now "${units[@]}" || true
  mkdir -p "$HOME/.config/tmux-web/old-units"
  mv "$HOME"/.config/systemd/user/tmux-web-* "$HOME/.config/tmux-web/old-units/"
  echo "moved the old per-user units to ~/.config/tmux-web/old-units"
fi
systemctl --user daemon-reload
systemctl --user enable "${units[@]}"
systemctl --user restart "${units[@]}"

# rewriting "on" makes an account's tmux-web-switch.path restart its backend with the new code
for switch in /etc/tmux-web/accounts/*; do
  [ -f "$switch" ] && [ "$(cat "$switch")" = on ] || continue
  name=$(basename "$switch")
  echo on > "/etc/tmux-web/accounts/.$name.tmp" && mv "/etc/tmux-web/accounts/.$name.tmp" "$switch"
  echo "$name: restarting"
done
systemctl --user --no-pager status "${units[@]}" | grep -E '^\S|Active:'
