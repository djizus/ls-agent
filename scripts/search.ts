import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    grid: { type: "string" },
    base: { type: "string", default: "{}" },
    starts: { type: "string", default: "20000" },
    from: { type: "string", default: "100000" },
    confirm: { type: "string", default: "50000" },
    level: { type: "string", default: "35" },
    procs: { type: "string", default: "14" },
  },
});
const grid: Record<string, number[]> = JSON.parse(values.grid!);
const bench = new URL("bench.ts", import.meta.url).pathname;

function moves(variants: object[], starts: string, from: string): { rules: string; move: number; se: number }[] {
  const args = ["--disable-warning=ExperimentalWarning", bench, "--starts", starts, "--from", from, "--procs", values.procs, ...variants.flatMap((v) => ["--rules", JSON.stringify(v)])];
  const out = execFileSync("node", args, { encoding: "utf8", maxBuffer: 1e8 });
  console.log(out.trim());
  const found = [...out.matchAll(new RegExp(`${values.level}\\+ ([+-]?[\\d.]+) ± ([\\d.]+)`, "g"))];
  return found.map((m, i) => ({ rules: JSON.stringify(variants[i + 1]), move: Number(m[1]), se: Number(m[2]) }));
}

let best: Record<string, number> = JSON.parse(values.base);
for (let changed = true, pass = 1; changed; pass++) {
  changed = false;
  for (const [field, options] of Object.entries(grid)) {
    const others = options.filter((o) => o !== best[field]);
    const top = moves([best, ...others.map((o) => ({ ...best, [field]: o }))], values.starts, values.from).sort((a, b) => b.move - a.move)[0];
    if (top.move <= top.se) continue;
    best = JSON.parse(top.rules);
    changed = true;
    console.log(`pass ${pass}: ${field} -> ${best[field]} (${values.level}+ share +${top.move} ± ${top.se} points)`);
  }
}
console.log(`selected ${JSON.stringify(best)}; confirming on ${values.confirm} fresh starts`);
moves([JSON.parse(values.base), best], values.confirm, "0");
