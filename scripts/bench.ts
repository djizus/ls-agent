import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { DUNGEON } from "../src/config.ts";
import { useFastLuck } from "../src/hash.ts";
import { describe } from "../src/play.ts";
import { RULES, plan } from "../src/policy.ts";
import { act, newPracticeGame } from "../src/practice.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "0-10" },
    procs: { type: "string", default: String(Math.max(1, Math.min(14, availableParallelism() - 2))) },
    rules: { type: "string", multiple: true, default: ["{}"] },
    ids: { type: "string" },
    "by-id": { type: "boolean", default: false },
    exact: { type: "boolean", default: false },
  },
});
const [from, to] = values.seeds.split("-").map(Number);
const ids: string[] = values.ids ? JSON.parse(readFileSync(values.ids, "utf8")).map((x: string | { game: string }) => (typeof x === "string" ? x : x.game)) : DUNGEON.benchmark;
const games = ids.flatMap((id) => Array.from({ length: to - from }, (_, i) => [id, from + i] as const));
const procs = Number(values.procs);
const defaults = { ...RULES };

async function play(share: number): Promise<number[][]> {
  if (!values.exact) useFastLuck();
  const out: number[][] = [];
  for (const rules of values.rules) {
    Object.assign(RULES, defaults, JSON.parse(rules));
    const levels: number[] = [];
    for (const [i, [id, seed]] of games.entries()) {
      if (i % procs !== share) continue;
      const game = await newPracticeGame(id, seed);
      let state = describe(game.start, id);
      while (!state.over) state = describe(act(game, plan(state).actions), id);
      levels.push(state.level);
    }
    out.push(levels);
  }
  return out;
}

const summary = (levels: number[]) => {
  const sorted = [...levels].sort((a, b) => a - b);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const se = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length - 1) / levels.length);
  const share = (n: number) => +((100 * levels.filter((l) => l >= n).length) / levels.length).toFixed(1);
  return { games: levels.length, mean: +mean.toFixed(2), se: +se.toFixed(2), median: sorted[sorted.length >> 1], "26+": share(26), "30+": share(30), "35+": share(35), best: sorted.at(-1) };
};

if (process.send) {
  process.send(await play(Number(process.env.BENCH_SHARE)));
} else {
  const started = Date.now();
  const shares = await Promise.all(
    Array.from({ length: procs }, (_, share) => new Promise<number[][]>((resolve, reject) => {
      const child = fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, BENCH_SHARE: String(share) } });
      child.once("message", (m) => resolve(m as number[][]));
      child.once("exit", (code) => code && reject(new Error(`worker ${share} exited with ${code}`)));
    })),
  );
  const order = games.map((_, i) => [i % procs, Math.floor(i / procs)] as const);
  values.rules.forEach((rules, v) => {
    const levels = order.map(([share, at]) => shares[share][v][at]);
    console.log(rules, JSON.stringify(summary(levels)));
    if (v > 0) {
      const base = order.map(([share, at]) => shares[share][0][at]);
      const d = summary(levels.map((l, i) => l - base[i]));
      console.log(`  against the first: ${d.mean > 0 ? "+" : ""}${d.mean} ± ${d.se} levels`);
    }
    if (values["by-id"]) ids.forEach((id, n) => console.log(" ", id.slice(-8), JSON.stringify(summary(levels.slice(n * (to - from), (n + 1) * (to - from))))));
  });
  console.log(`${games.length * values.rules.length} games in ${((Date.now() - started) / 1000).toFixed(1)} s on ${procs} processes${values.exact ? ", contract hash" : ", fast luck"}`);
}
