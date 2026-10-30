#!/bin/bash
# tmux-web with several Unix accounts: the part that needs root. Run it once, and again after adding an account (it can be
# run any number of times), with the home account first:
#     sudo deploy/setup-root.sh zihan xyp
# Then, as the home account: deploy/install.sh. It does:
#   * /opt/tmux-web (the code) and /etc/tmux-web (env, users.json, accounts/), owned by the home account: deploying and
#     configuring need no sudo afterwards. (Whoever controls the home account controls every account through these.)
#   * ttyd and caddy copied from the home account's ~/.local/bin to /usr/local/bin (other accounts cannot read that).
#   * /run/tmux-web/<account>/ for every account, made at every boot (tmpfiles.d): the home account's private to it, every
#     other one owned by that account with the home account's group, so the front door (Caddy, run by the home account)
#     can reach its sockets and nobody else can.
#   * the user units in /etc/systemd/user (available to every account, started only where enabled).
#   * for every other account: linger (its systemd runs without a login), its switch file (off unless it exists already), and
#     tmux-web-switch.path/.service enabled, which start and stop its API and ttyd as the switch says.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: sudo $0 <home account> [<other account>...]" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
home=$1; shift
valid='^[a-z_][a-z0-9_-]{0,31}$'
for a in "$home" "$@"; do
  [[ $a =~ $valid ]] || { echo "not an account name: $a" >&2; exit 2; }
  id "$a" >/dev/null
done
group=$(id -gn "$home")
homedir=$(getent passwd "$home" | cut -d: -f6)

install -d -o "$home" -g "$group" -m 0755 /opt/tmux-web /opt/tmux-web/bin /etc/tmux-web /etc/tmux-web/accounts
# what the other accounts' tmux-web-switch.service runs, needed before it is started below (deploy/install.sh updates it)
install -o "$home" -g "$group" -m 0755 "$here/bin/tmux-web-switch" /opt/tmux-web/bin/
for bin in ttyd caddy; do
  if [ -x "$homedir/.local/bin/$bin" ]; then install -o root -g root -m 0755 "$homedir/.local/bin/$bin" "/usr/local/bin/$bin"
  elif [ ! -x "/usr/local/bin/$bin" ]; then echo "missing: $bin (put it in /usr/local/bin)" >&2; exit 1; fi
done
[ -x /usr/bin/node ] || { echo "missing: /usr/bin/node (Node 20+)" >&2; exit 1; }

{
  echo '# tmux-web: socket directories, one per account (deploy/setup-root.sh)'
  echo 'd /run/tmux-web 0755 root root -'
  echo "d /run/tmux-web/$home 0700 $home $group -"
  for a in "$@"; do echo "d /run/tmux-web/$a 2750 $a $group -"; done
} > /etc/tmpfiles.d/tmux-web.conf
systemd-tmpfiles --create /etc/tmpfiles.d/tmux-web.conf

install -o root -g root -m 0644 "$here"/deploy/units/* /etc/systemd/user/

for a in "$@"; do
  switch=/etc/tmux-web/accounts/$a
  [ -e "$switch" ] || { echo off > "$switch"; chown "$home:$group" "$switch"; chmod 0644 "$switch"; }
  loginctl enable-linger "$a"
  uid=$(id -u "$a")
  for _ in $(seq 50); do systemctl is-active --quiet "user@$uid.service" && break; sleep 0.2; done
  as() { runuser -u "$a" -- env XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }
  as systemctl --user daemon-reload
  as systemctl --user enable --now tmux-web-switch.path tmux-web-switch.service
  echo "$a: switch is $(cat "$switch") (/etc/tmux-web/accounts/$a)"
done
echo "done. Now, as $home: deploy/install.sh"
