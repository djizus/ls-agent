import { existsSync, readFileSync } from "node:fs";
import { BAG_RANKING, DUNGEONS, dungeonOf } from "./config.ts";
import { emit } from "./events.ts";
import { bagOf, forSale, liveIds, poolIds } from "./live.ts";
import { halt, play, running } from "./runner.ts";

export const CYCLE = { beastGames: 40, bagCapSurvivor: 100 };

type Ranked = { bag: number; kills?: number };

export function bestBag<Row extends Ranked>(rows: Row[], ids: string[]): Row | undefined {
  return forSale(rows.filter((row) => row.kills !== undefined), ids).sort((a, b) => b.kills! - a.kills!)[0];
}

let last = { on: false, text: "", at: 0 };
let cycling = false;
let stopped = false;

const say = (text: string, on = true): void => {
  last = { on, text, at: Date.now() };
  emit({ kind: "cycle", on, text });
};

export const cycleStatus = () => last;

async function loot(): Promise<string> {
  const unfinished = liveIds().find((id) => dungeonOf(id) === "lootBag");
  const rows = existsSync(BAG_RANKING) ? (JSON.parse(readFileSync(BAG_RANKING, "utf8")) as Ranked[]) : [];
  const best = unfinished ? { bag: bagOf(unfinished), kills: undefined } : bestBag(rows, await poolIds(DUNGEONS.lootBag.pool!));
  if (!best) return "no Loot Dungeon game: the pool holds no ranked bag";
  if (stopped) return "stopped before the Loot Dungeon game";
  const run = await play({ seats: [{ dungeon: "lootBag", bag: best.bag, maxSurvivor: CYCLE.bagCapSurvivor }] });
  if ("refused" in run) return `no Loot Dungeon game on bag ${best.bag}: ${run.refused}`;
  say(unfinished ? `resuming the unfinished Loot Dungeon game on bag ${best.bag}` : `Loot Dungeon game on bag ${best.bag} (${best.kills} named kills a game)`);
  await run.done;
  return `the Loot Dungeon game on bag ${best.bag} was played`;
}

async function run(): Promise<void> {
  try {
    say(`${CYCLE.beastGames} Beast Mode games`);
    const beasts = await play({ seats: Array.from({ length: CYCLE.beastGames }, () => ({ dungeon: "beast" })) });
    if ("refused" in beasts) return say(`stopped: ${beasts.refused}`, false);
    await beasts.done;
    if (stopped) return say("stopped", false);
    say("the Loot Dungeon step");
    say(`cycle done: ${await loot().catch((err) => `the Loot Dungeon step failed: ${(err as Error).message.slice(0, 200)}`)}`, false);
  } finally {
    cycling = false;
  }
}

export function startCycle(): boolean {
  if (cycling || running()) return false;
  cycling = true;
  stopped = false;
  void run();
  return true;
}

export function stopCycle(): void {
  stopped = true;
  halt();
}
