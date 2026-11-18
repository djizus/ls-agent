#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.config/systemd/user"
ln -sf "$root/deploy/ls-agent.service" "$HOME/.config/systemd/user/ls-agent.service"
cp "$root/deploy/traefik.yml" /opt/traefik/ls-agent.yml
systemctl --user daemon-reload
systemctl --user enable --now ls-agent
systemctl --user restart ls-agent
