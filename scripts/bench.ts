import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { DUNGEON, DUNGEON_KEY } from "../src/config.ts";
import { useFastLuck } from "../src/hash.ts";
import { describe } from "../src/play.ts";
import { RULES, plan } from "../src/policy.ts";
import { toSnapshot, type Local } from "../src/engine/engine.ts";
import { act, newPracticeGame, syntheticGame, type Game } from "../src/practice.ts";

const { values } = parseArgs({
  options: {
    starts: { type: "string", default: "10000" },
    from: { type: "string", default: "0" },
    seeds: { type: "string" },
    procs: { type: "string", default: String(Math.max(1, Math.min(14, availableParallelism() - 2))) },
    rules: { type: "string", multiple: true, default: ["{}"] },
    ids: { type: "string" },
    "by-id": { type: "boolean", default: false },
    exact: { type: "boolean", default: false },
    gate: { type: "boolean", default: false },
    save: { type: "boolean", default: false },
    reach: { type: "string" },
    keep: { type: "string" },
    late: { type: "string" },
  },
});
type Kept = { id: string; moves: number; local: Local };
const kept: Kept[] = values.late ? JSON.parse(readFileSync(values.late, "utf8")) : [];
const rolled = DUNGEON.rolledStart && !values.ids && !values.late;
const [from, to] = (values.seeds ?? (rolled ? "0-1" : values.late ? "0-20" : "0-500")).split("-").map(Number);
const ids: (string | number | Kept)[] = values.late
  ? kept
  : rolled
  ? Array.from({ length: Number(values.starts) }, (_, i) => Number(values.from) + i)
  : values.ids
    ? JSON.parse(readFileSync(values.ids, "utf8")).map((x: string | { game: string }) => (typeof x === "string" ? x : x.game))
    : DUNGEON.benchmark;
const games = ids.flatMap((id) => Array.from({ length: to - from }, (_, i) => [id, from + i] as const));
const procs = Number(values.procs);
const MEAN_SLACK = 0.25;
const SHARE_SLACK = 1;
const DEEP = values.late ? [35, 40, 45] : [30, 35, 40];
const MARKS = [35, 40];
const [KILLS, NAMED, KINDS, MET, FLED, DIED] = [4, 5, 6, 7, 8, 9];
const NAMED_SLACK = 0.1;
const reach = Number(values.reach ?? 0);
const defaults = { ...RULES };

type Run = { rows: (number | null)[][][]; snaps: Kept[] };

async function play(share: number): Promise<Run> {
  if (!values.exact) useFastLuck();
  const rows: (number | null)[][][] = [];
  const snaps: Kept[] = [];
  for (const [v, rules] of values.rules.entries()) {
    Object.assign(RULES, defaults, JSON.parse(rules));
    const out: (number | null)[][] = [];
    for (const [i, [id, seed]] of games.entries()) {
      if (i % procs !== share) continue;
      const game: Game =
        typeof id === "number" ? await syntheticGame(id, seed) : typeof id === "string" ? await newPracticeGame(id, seed) : { id: id.id, seed: seed + 1, packets: Array(id.moves).fill(0n), start: toSnapshot(id.local), local: id.local };
      let state = describe(toSnapshot(game.local), game.id);
      const first = game.packets.length;
      const points: (number | null)[] = MARKS.map(() => null);
      let snapped = v > 0 || !reach;
      const tally = { kills: 0, named: 0, met: 0, fled: 0, died: 0 };
      const kinds = new Set<string>();
      while (!state.over) {
        const spare = Object.values(state.baseStats).reduce((a, b) => a + b, 0) + state.statUpgradesAvailable - (state.level - 1);
        MARKS.forEach((mark, k) => (points[k] ??= state.level >= mark ? spare : null));
        if (!snapped && state.level >= reach && !state.beast) {
          snaps.push({ id: game.id, moves: game.packets.length, local: game.local });
          snapped = true;
        }
        const before = state;
        const move = plan(state).actions[0].type;
        state = describe(act(game, plan(before).actions), game.id);
        const named = before.beast?.specialPrefix != null;
        if (!before.beast && state.beast?.specialPrefix != null) tally.met++;
        if (before.beast && !state.beast && !state.over && move === "attack") {
          tally.kills++;
          if (named) {
            tally.named++;
            kinds.add(`${before.beast.id}:${before.beast.specialPrefix}:${before.beast.specialSuffix}`);
          }
        }
        if (before.beast && named && !state.beast && !state.over && move === "flee") tally.fled++;
        if (before.beast && named && state.over) tally.died++;
      }
      out.push([state.level, game.packets.length - first, ...points, tally.kills, tally.named, kinds.size, tally.met, tally.fled, tally.died]);
    }
    rows.push(out);
  }
  return { rows, snaps };
}

const summary = (levels: number[]) => {
  const sorted = [...levels].sort((a, b) => a - b);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const se = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length - 1) / levels.length);
  const share = (n: number) => +((100 * levels.filter((l) => l >= n).length) / levels.length).toFixed(1);
  return { games: levels.length, mean: +mean.toFixed(2), se: +se.toFixed(2), median: sorted[sorted.length >> 1], "26+": share(26), "30+": share(30), "35+": share(35), "40+": share(40), "45+": share(45), best: sorted.at(-1) };
};

if (process.send) {
  process.send(await play(Number(process.env.BENCH_SHARE)));
} else {
  const started = Date.now();
  const shares = await Promise.all(
    Array.from({ length: procs }, (_, share) => new Promise<Run>((resolve, reject) => {
      const child = fork(process.argv[1], process.argv.slice(2), { env: { ...process.env, BENCH_SHARE: String(share) } });
      child.once("message", (m) => resolve(m as Run));
      child.once("exit", (code) => code && reject(new Error(`worker ${share} exited with ${code}`)));
    })),
  );
  const order = games.map((_, i) => [i % procs, Math.floor(i / procs)] as const);
  values.rules.forEach((rules, v) => {
    const games = order.map(([share, at]) => shares[share].rows[v][at]);
    const levels = games.map((g) => g[0]!);
    const average = (column: number) => {
      const seen = games.map((g) => g[column]).filter((x): x is number => x !== null);
      return seen.length ? +(seen.reduce((a, b) => a + b, 0) / seen.length).toFixed(1) : null;
    };
    const total = (column: number) => games.reduce((n, g) => n + g[column]!, 0);
    const named = summary(games.map((g) => g[NAMED]!));
    const of = (column: number) => +((100 * total(column)) / Math.max(1, total(MET))).toFixed(1);
    console.log(rules, JSON.stringify({ ...summary(levels), moves: average(1), ...Object.fromEntries(MARKS.map((mark, k) => [`points at ${mark}`, average(2 + k)])) }));
    console.log(`  kills per game ${(total(KILLS) / games.length).toFixed(2)}; named ${named.mean} ± ${named.se}, distinct ${(total(KINDS) / games.length).toFixed(2)}, per 100 moves ${((100 * total(NAMED)) / total(1)).toFixed(2)}; named beasts met ${(total(MET) / games.length).toFixed(2)}: killed ${of(NAMED)}%, fled ${of(FLED)}%, died to ${of(DIED)}%`);
    if (v > 0) {
      const base = order.map(([share, at]) => shares[share].rows[0][at][0]!);
      const d = summary(levels.map((l, i) => l - base[i]));
      const moved = DEEP.map((n) => {
        const s = summary(levels.map((l, i) => 100 * (Number(l >= n) - Number(base[i] >= n))));
        return `${n}+ ${s.mean > 0 ? "+" : ""}${s.mean} ± ${s.se}`;
      });
      const first = order.map(([share, at]) => shares[share].rows[0][at][NAMED]!);
      const k = summary(games.map((g, i) => g[NAMED]! - first[i]));
      console.log(`  against the first: named kills ${k.mean > 0 ? "+" : ""}${k.mean} ± ${k.se}; ${d.mean > 0 ? "+" : ""}${d.mean} ± ${d.se} levels; share in points: ${moved.join(", ")}`);
    }
    if (values["by-id"]) ids.forEach((id, n) => console.log(" ", String(id).slice(-8), JSON.stringify(summary(levels.slice(n * (to - from), (n + 1) * (to - from))))));
  });
  const baselineFile = new URL("baseline.json", import.meta.url);
  const baselines: Record<string, { mean: number; "30+": number; named?: number }> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};
  const now = summary(order.map(([share, at]) => shares[share].rows[0][at][0]!));
  const kills = summary(order.map(([share, at]) => shares[share].rows[0][at][NAMED]!)).mean;
  if (values.keep) writeFileSync(values.keep, JSON.stringify(shares.flatMap((s) => s.snaps)));
  if (values.save) {
    baselines[DUNGEON_KEY] = { mean: now.mean, "30+": now["30+"], named: kills };
    writeFileSync(baselineFile, JSON.stringify(baselines, null, 2) + "\n");
  }
  if (values.gate) {
    const base = baselines[DUNGEON_KEY];
    if (!base) throw new Error(`no baseline for ${DUNGEON_KEY}: run with --save first`);
    const worse = now.mean < base.mean - MEAN_SLACK || now["30+"] < base["30+"] - SHARE_SLACK || kills < (base.named ?? 0) - NAMED_SLACK;
    console.log(`gate ${worse ? "FAILED" : "passed"}: mean ${now.mean} against ${base.mean}, 30+ ${now["30+"]}% against ${base["30+"]}%, named kills ${kills} against ${base.named ?? "none"}`);
    if (worse) process.exitCode = 1;
  }
  console.log(`${games.length * values.rules.length} games in ${((Date.now() - started) / 1000).toFixed(1)} s on ${procs} processes${values.exact ? ", contract hash" : ", fast luck"}`);
}
