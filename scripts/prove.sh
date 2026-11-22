#!/usr/bin/env bash
set -euo pipefail
games="${1:-1}"
dungeon="${2:-beast}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/var/evidence/$(date +%Y%m%d-%H%M%S)"
port="${LS_PROVE_PORT:-4199}"
mkdir -p "$out"
[[ -f "$HOME/.config/ls-agent/env" ]] && set -a && source "$HOME/.config/ls-agent/env" && set +a

LS_HOST=127.0.0.1 LS_PORT="$port" LS_VAR_DIR="$out/" node --disable-warning=ExperimentalWarning "$root/src/main.ts" > "$out/service.log" 2>&1 &
service=$!
trap 'kill $service 2>/dev/null; wait $service 2>/dev/null || true' EXIT
for _ in $(seq 40); do curl -sf "127.0.0.1:$port/" > /dev/null && break; sleep 0.5; done

curl -sN "127.0.0.1:$port/events" | sed -un 's/^data: //p' > "$out/events.jsonl" &
stream=$!
sleep 1
if [[ "$games" == cycle ]]; then
  curl -sf -XPOST "127.0.0.1:$port/api/play" -d '{"cycle":true}' > /dev/null
  timeout 300 bash -c "until grep -q '\"kind\":\"cycle\",\"on\":false' '$out/events.jsonl'; do sleep 1; done" || echo "timed out" >> "$out/service.log"
  curl -sf "127.0.0.1:$port/api/cycle" > "$out/cycle.json"
  kill $stream 2>/dev/null || true
  grep '"kind":"cycle"' "$out/events.jsonl"
  echo "evidence: $out"
  exit
fi
curl -sf -XPOST "127.0.0.1:$port/api/play" -d "{\"games\":$games,\"dungeon\":\"$dungeon\"}" > /dev/null
timeout "${LS_PROVE_TIMEOUT:-3600}" bash -c "until grep -q '\"text\":\"batch done\"' '$out/events.jsonl'; do sleep 2; done" || echo "timed out" >> "$out/service.log"
kill $stream 2>/dev/null || true
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
console.log(JSON.stringify(new DatabaseSync(process.argv[1], { readOnly: true }).prepare("SELECT * FROM games ORDER BY id DESC").all()));
' "$out/ls.sqlite" > "$out/games.json"

node -e '
const g = require(process.argv[1]);
const kinds = {};
for (const l of require("fs").readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) { const k = JSON.parse(l).kind; kinds[k] = (kinds[k] || 0) + 1; }
console.log(JSON.stringify({ games: g.map(({ id, level, xp, moves, cost_usd }) => ({ id, level, xp, moves, cost_usd })), events: kinds }, null, 1));
' "$out/games.json" "$out/events.jsonl"
echo "evidence: $out"
