import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, constants, setPriority } from "node:os";
import { parseArgs } from "node:util";
import { BAG_RANKING, DUNGEONS, VAR_DIR } from "../src/config.ts";
import { useFastLuck } from "../src/hash.ts";
import { describe, slewNamed } from "../src/play.ts";
import { summary } from "../src/summary.ts";
import { ARMOR, NECK, RULES, VERSION, plan } from "../src/policy.ts";
import { poolIds, shortlist, unplayed, unranked } from "../src/live.ts";
import { toSnapshot, type Local } from "../src/engine/engine.ts";
import { act, newPracticeGame, startOf, syntheticGame, type Game } from "../src/practice.ts";

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
    rank: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    dungeon: { type: "string", default: "beast" },
  },
});
const DUNGEON_KEY = values.dungeon;
const DUNGEON = DUNGEONS[DUNGEON_KEY];
if (!DUNGEON) throw new Error(`--dungeon is one of ${Object.keys(DUNGEONS).join(", ")}`);
type Kept = { id: string; moves: number; local: Local };
const kept: Kept[] = values.late ? JSON.parse(readFileSync(values.late, "utf8")) : [];
const rolled = DUNGEON.rolledStart && !values.ids && !values.late;
const [from, to] = (values.seeds ?? (rolled ? "0-1" : values.late ? "0-20" : "0-500")).split("-").map(Number);

async function gearOf(game: string) {
  const worn = describe(await startOf(game), game).equipment;
  const greatness = (g: { xp: number }) => Math.min(20, Math.floor(Math.sqrt(g.xp)));
  const label = (slot: string) => worn.filter((g) => g.slot === slot).map((g) => `${g.name}${slot === "weapon" ? ` T${g.tier} ${g.type}` : ""} G${greatness(g)}`)[0] ?? "none";
  const armor = worn.filter((g) => ARMOR.includes(g.slot));
  const count = (type: string) => armor.filter((g) => g.type === type).length;
  const main = armor.map((g) => g.type).sort((a, b) => count(b) - count(a))[0];
  const neck = label("neck");
  return {
    weapon: label("weapon"),
    set: `${count(main)}/${ARMOR.length} ${main}`,
    t1: armor.filter((g) => g.tier === 1).length,
    armG: Math.round(armor.reduce((sum, g) => sum + greatness(g), 0) / ARMOR.length),
    neck: neck.startsWith(`${NECK[main]} `) ? `${neck} match` : neck,
    ring: label("ring"),
  };
}

type Ranked = { bag: number; game: string; policy?: string; mean?: number };
const ranking = (): Ranked[] => (existsSync(BAG_RANKING) ? JSON.parse(readFileSync(BAG_RANKING, "utf8")) : []);
function rank(rows: Ranked[]): void {
  mkdirSync(VAR_DIR, { recursive: true });
  writeFileSync(`${BAG_RANKING}.part`, JSON.stringify(rows.sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0))));
  renameSync(`${BAG_RANKING}.part`, BAG_RANKING);
}

const ids: (string | number | Kept)[] = values.late
  ? kept
  : rolled
  ? Array.from({ length: Number(values.starts) }, (_, i) => Number(values.from) + i)
  : values.ids
    ? JSON.parse(readFileSync(values.ids, "utf8")).map((x: string | { game: string }) => (typeof x === "string" ? x : x.game))
    : DUNGEON.benchmark;
type Pair = readonly [string | number | Kept, number];
const games: Pair[] = ids.flatMap((id) => Array.from({ length: to - from }, (_, i) => [id, from + i] as const));
const FIRST_SEEDS = 100;
const FULL_SEEDS = 500;
const SHORTLIST = 30;
const procs = Number(values.procs);
const MEAN_SLACK = 0.25;
const SHARE_SLACK = 1;
const DEEP = values.late ? [35, 40, 45] : [30, 35, 40];
const MARKS = [35, 40];
const [KILLS, NAMED, KINDS, MET, FLED, DIED] = [4, 5, 6, 7, 8, 9];
const NAMED_SLACK = 0.1;
const [CAUSE, TIER, GAP, HEALTH] = [10, 11, 12, 13];
const CAUSES = ["fleeing", "fighting", "ambush", "trap"];
const BANDS = [[1, 9], [10, 14], [15, 19], [20, 29], [30, 99]];
const reach = values.reach === "weapon" ? 1 : Number(values.reach ?? 0);
const reached = (state: ReturnType<typeof describe>) => (values.reach === "weapon" ? (state.equipment.find((g) => g.slot === "weapon")?.greatness ?? 0) >= 20 : state.level >= reach);
const defaults = { ...RULES };

type Run = { rows: (number | null)[][][]; snaps: Kept[] };

async function play(games: Pair[]): Promise<Run> {
  if (!values.exact) useFastLuck();
  const rows: (number | null)[][][] = [];
  const snaps: Kept[] = [];
  for (const [v, rules] of values.rules.entries()) {
    Object.assign(RULES, defaults, JSON.parse(rules));
    const out: (number | null)[][] = [];
    for (const [id, seed] of games) {
      const game: Game =
        typeof id === "number" ? await syntheticGame(id, seed) : typeof id === "string" ? await newPracticeGame(id, seed) : { id: id.id, seed: seed + 1, packets: Array(id.moves).fill(0n), start: toSnapshot(id.local), local: id.local };
      let state = describe(toSnapshot(game.local), game.id);
      const first = game.packets.length;
      const points: (number | null)[] = MARKS.map(() => null);
      let snapped = v > 0 || !reach;
      const tally = { kills: 0, named: 0, met: 0, fled: 0, died: 0 };
      const kinds = new Set<string>();
      let last = state;
      let lastMove = "explore";
      while (!state.over) {
        const spare = Object.values(state.baseStats).reduce((a, b) => a + b, 0) + state.statUpgradesAvailable - (state.level - 1);
        MARKS.forEach((mark, k) => (points[k] ??= state.level >= mark ? spare : null));
        if (!snapped && reached(state) && !state.beast) {
          snaps.push({ id: game.id, moves: game.packets.length, local: game.local });
          snapped = true;
        }
        const before = state;
        const actions = plan(before).actions;
        const move = actions[0].type;
        last = before;
        lastMove = move;
        state = describe(act(game, actions), game.id);
        const named = before.beast?.specialPrefix != null;
        if (!before.beast && state.beast?.specialPrefix != null) tally.met++;
        if (before.beast && !state.beast && !state.over && move === "attack") {
          tally.kills++;
          if (slewNamed(before, state, move)) {
            tally.named++;
            kinds.add(`${before.beast.id}:${before.beast.specialPrefix}:${before.beast.specialSuffix}`);
          }
        }
        if (before.beast && named && !state.beast && !state.over && move === "flee") tally.fled++;
        if (before.beast && named && state.over) tally.died++;
      }
      const cause = last.beast ? (lastMove === "flee" ? 0 : 1) : /trap/.test(state.happened.at(-1) ?? "") ? 3 : 2;
      out.push([state.level, game.packets.length - first, ...points, tally.kills, tally.named, kinds.size, tally.met, tally.fled, tally.died, cause, last.beast?.tier ?? null, last.beast ? last.beast.level - last.level : null, last.maxHealth]);
    }
    rows.push(out);
  }
  return { rows, snaps };
}


async function run(games: Pair[]): Promise<Run> {
  const shares = await Promise.all(
    Array.from({ length: procs }, (_, share) => new Promise<Run>((resolve, reject) => {
      const child = fork(process.argv[1], process.argv.slice(2));
      child.once("message", (m) => resolve(m as Run));
      child.once("exit", (code) => code && reject(new Error(`worker ${share} exited with ${code}`)));
      child.send(games.filter((_, i) => i % procs === share));
    })),
  );
  return { rows: values.rules.map((_, v) => games.map((_, i) => shares[i % procs].rows[v][Math.floor(i / procs)])), snaps: shares.flatMap((s) => s.snaps) };
}

function figures(own: (number | null)[][]) {
  const levels = own.map((g) => g[0]!).sort((a, b) => a - b);
  const s = summary(levels);
  const kills = summary(own.map((g) => g[NAMED]!));
  const share = (level: number) => +((100 * levels.filter((l) => l >= level).length) / levels.length).toFixed(1);
  return { mean: +s.mean.toFixed(1), med: s.median, p90: levels[Math.floor(levels.length * 0.9)], best: s.best, ge25: share(25), ge30: share(30), ge35: share(35), kills: kills.mean, killsSe: kills.se, games: levels.length, policy: VERSION };
}

if (process.send) {
  process.once("message", async (games: Pair[]) => process.send!(await play(games)));
} else if (values.rank) {
  const started = Date.now();
  setPriority(constants.priority.PRIORITY_LOW);
  const [rows, pool] = [ranking(), await poolIds(DUNGEONS.lootBag.pool!)];
  const added = unranked(pool, rows.map((row) => row.bag));
  for (const { bag, game } of added) rows.push({ bag, ...(await gearOf(game)), game });
  rank(rows);
  const played = new Map<string, (number | null)[][]>();
  const replay = async (due: Ranked[], seeds: (game: string) => number) => {
    if (!due.length) return 0;
    const pairs = due.flatMap((row) => Array.from({ length: seeds(row.game) }, (_, i) => [row.game, (played.get(row.game)?.length ?? 0) + i] as const));
    const { rows } = await run(pairs);
    pairs.forEach(([game], i) => played.set(game, [...(played.get(game) ?? []), rows[0][i]]));
    rank(ranking().map((row) => (due.some((d) => d.game === row.game) ? { ...row, ...figures(played.get(row.game)!) } : row)));
    return pairs.length;
  };
  const stale = unplayed(rows, pool, values.all ? VERSION : undefined);
  let count = await replay(stale, () => FIRST_SEEDS);
  let deepened = 0;
  const best = () => shortlist(ranking(), pool, SHORTLIST, FULL_SEEDS).filter((row) => values.all || played.has(row.game));
  for (let more = best(); more.length; more = best()) {
    count += await replay(more, (game) => FULL_SEEDS - (played.get(game)?.length ?? 0));
    deepened += more.length;
  }
  console.log(`policy ${VERSION}: ${added.length} bags added from the pool${added.length ? ` (${added.map((a) => a.bag).join(", ")})` : ""}, ${stale.length} replayed on ${FIRST_SEEDS} seeds, ${deepened} among the best ${SHORTLIST} by level or by named kills brought to ${FULL_SEEDS}; ${count} games in ${((Date.now() - started) / 1000).toFixed(1)} s on ${procs} processes`);
} else {
  const started = Date.now();
  const { rows: played, snaps } = await run(games);
  values.rules.forEach((rules, v) => {
    const games = played[v];
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
    for (const [low, high] of BANDS) {
      const dead = games.filter((g) => g[0]! >= low && g[0]! <= high);
      if (!dead.length) continue;
      const by = CAUSES.map((name, c) => `${name} ${Math.round((100 * dead.filter((g) => g[CAUSE] === c).length) / dead.length)}%`);
      const battle = dead.filter((g) => g[TIER] !== null);
      const mean = (column: number, of = dead) => (of.reduce((n, g) => n + g[column]!, 0) / Math.max(1, of.length)).toFixed(column === TIER ? 1 : 0);
      console.log(`  deaths at level ${low}-${high === 99 ? "" : high}: ${((100 * dead.length) / games.length).toFixed(1)}% of games; ${by.join(", ")}; max health ${mean(HEALTH)}; in battle: beast tier ${mean(TIER, battle)}, ${mean(GAP, battle)} levels above us`);
    }
    if (v > 0) {
      const base = played[0].map((g) => g[0]!);
      const d = summary(levels.map((l, i) => l - base[i]));
      const moved = DEEP.map((n) => {
        const s = summary(levels.map((l, i) => 100 * (Number(l >= n) - Number(base[i] >= n))));
        return `${n}+ ${s.mean > 0 ? "+" : ""}${s.mean} ± ${s.se}`;
      });
      const first = played[0].map((g) => g[NAMED]!);
      const k = summary(games.map((g, i) => g[NAMED]! - first[i]));
      console.log(`  against the first: named kills ${k.mean > 0 ? "+" : ""}${k.mean} ± ${k.se}; ${d.mean > 0 ? "+" : ""}${d.mean} ± ${d.se} levels; share in points: ${moved.join(", ")}`);
    }
    if (values["by-id"])
      ids.forEach((id, n) => {
        const own = games.slice(n * (to - from), (n + 1) * (to - from));
        const kills = summary(own.map((g) => g[NAMED]!));
        console.log(" ", String(typeof id === "object" ? id.id : id).slice(-8), JSON.stringify({ ...summary(own.map((g) => g[0]!)), "named kills": kills.mean, "named se": kills.se }));
      });
  });
  const baselineFile = new URL("baseline.json", import.meta.url);
  const baselines: Record<string, { games?: number; mean: number; "30+": number; named?: number }> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : {};
  const now = summary(played[0].map((g) => g[0]!));
  const kills = summary(played[0].map((g) => g[NAMED]!)).mean;
  if (values.keep) writeFileSync(values.keep, JSON.stringify(snaps));
  if (values.save) {
    baselines[DUNGEON_KEY] = { games: now.games, mean: now.mean, "30+": now["30+"], named: kills };
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
