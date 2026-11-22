#!/usr/bin/env bash
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/var/contract-check.json"
mkdir -p "$root/var"
cd "$root" && npm run contract 2>&1 | node -e '
const fs = require("fs");
const [out] = process.argv.slice(1);
let log = "";
process.stdin.on("data", (d) => (log += d)).on("end", () => {
  const count = (name) => Number(log.match(new RegExp(`^# ${name} (\\d+)`, "m"))?.[1] ?? NaN);
  const passed = count("pass") || 0;
  const failed = Number.isNaN(count("fail")) ? 1 : count("fail");
  const failures = [...log.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  let before = null;
  try { before = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
  const at = Date.now();
  const since = failed ? (before?.failed && before.since ? before.since : at) : null;
  fs.writeFileSync(out + ".tmp", JSON.stringify({ at, passed, failed, since, failures }) + "\n");
  fs.renameSync(out + ".tmp", out);
  console.log(fs.readFileSync(out, "utf8"));
  process.exit(failed ? 1 : 0);
});
' "$out"
