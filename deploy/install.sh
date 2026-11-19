#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.config/systemd/user"
for unit in ls-agent.service ls-agent-check.service ls-agent-check.timer; do
  ln -sf "$root/deploy/$unit" "$HOME/.config/systemd/user/$unit"
done
. "$HOME/.config/ls-agent/env"
sed "s/ls.example.com/${LS_DOMAIN:?set LS_DOMAIN in ~\/.config\/ls-agent\/env}/" "$root/deploy/traefik.yml" > /opt/traefik/ls-agent.yml
systemctl --user daemon-reload
systemctl --user enable --now ls-agent ls-agent-check.timer
systemctl --user restart ls-agent
