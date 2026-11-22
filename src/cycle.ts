import { existsSync, readFileSync } from "node:fs";
import { BAG_RANKING, DUNGEONS, SURVIVOR, dungeonOf } from "./config.ts";
import { emit } from "./events.ts";
import { bagMarket, bagRefusal, forSale, liveIds, poolIds, units } from "./live.ts";
import { halt, play, running } from "./runner.ts";
import { balanceOf } from "./wallet.ts";

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
  if (liveIds().some((id) => dungeonOf(id) === "lootBag")) {
    say("resuming the unfinished Loot Dungeon game");
    await play(1, true, "lootBag");
    return "the unfinished Loot Dungeon game was played";
  }
  const pool = DUNGEONS.lootBag.pool!;
  const rows = existsSync(BAG_RANKING) ? (JSON.parse(readFileSync(BAG_RANKING, "utf8")) as Ranked[]) : [];
  const best = bestBag(rows, await poolIds(pool));
  if (!best) return "no Loot Dungeon game: the pool holds no ranked bag";
  const [{ held, quote }, survivor] = await Promise.all([bagMarket(pool, best.bag), balanceOf(SURVIVOR)]);
  const entry = { bag: best.bag, maxSurvivor: CYCLE.bagCapSurvivor };
  const refused = bagRefusal(held, quote, entry, survivor);
  if (refused) return `no Loot Dungeon game on the bag with the most named kills (${best.kills} a game): ${refused}`;
  if (stopped) return "stopped before the Loot Dungeon game";
  if (running()) return "no Loot Dungeon game: another batch is running";
  say(`Loot Dungeon game on bag ${best.bag} (${best.kills} named kills a game) for ${units(quote.price)} SURVIVOR`);
  await play(1, true, "lootBag", entry);
  return `the Loot Dungeon game on bag ${best.bag} was played`;
}

async function run(): Promise<void> {
  try {
    say(`${CYCLE.beastGames} Beast Mode games`);
    await play(CYCLE.beastGames, true, "beast");
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
