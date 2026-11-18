#!/usr/bin/env bash
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/var/contract-check.json"
mkdir -p "$root/var"
log="$(cd "$root" && npm test 2>&1)"
passed=$(grep -m1 '^# pass' <<<"$log" | awk '{print $3}')
failed=$(grep -m1 '^# fail' <<<"$log" | awk '{print $3}')
failures=$(grep '^not ok' <<<"$log" | sed 's/^not ok [0-9]* - //' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))')
printf '{"at":%s,"passed":%s,"failed":%s,"failures":%s}\n' "$(date +%s000)" "${passed:-0}" "${failed:-1}" "$failures" > "$out.tmp" && mv "$out.tmp" "$out"
cat "$out"
[[ "${failed:-1}" == 0 ]]
