import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BAG_RANKING, DUNGEONS, STRK_FLOOR, SURVIVOR, VAR_DIR, dungeonOf } from "./config.ts";
import { db } from "./db.ts";
import { emit } from "./events.ts";
import { bagMarket, bagRefusal, forSale, liveIds, poolIds, units } from "./live.ts";
import { halt, play, running } from "./runner.ts";
import { balanceOf, strkBalance } from "./wallet.ts";

export const LOOP = { beastGames: 40, bagCapSurvivor: 100, reserveStrk: 10, recheckMs: 300_000 };

const file = `${VAR_DIR}loop.json`;

type Step = { kind: "wait"; need: number } | { kind: "beast"; games: number } | { kind: "loot" };

export function nextStep(strk: number, beastSince: number, lootUnfinished: boolean): Step {
  const need = STRK_FLOOR + LOOP.reserveStrk;
  if (strk < need) return { kind: "wait", need };
  if (lootUnfinished || beastSince >= LOOP.beastGames) return { kind: "loot" };
  return { kind: "beast", games: LOOP.beastGames - beastSince };
}

type Ranked = { bag: number; kills?: number };

export function bestBag<Row extends Ranked>(rows: Row[], ids: string[]): Row | undefined {
  return forSale(rows.filter((row) => row.kills !== undefined), ids).sort((a, b) => b.kills! - a.kills!)[0];
}

let last = { on: false, text: "off", at: 0 };
let wake: () => void = () => {};
let looping = false;

const on = (): boolean => existsSync(file);
const attempted = (): number => (on() ? (JSON.parse(readFileSync(file, "utf8")).attempt ?? 0) : 0);
const mark = (): void => writeFileSync(file, JSON.stringify({ attempt: Date.now() }));
const say = (text: string): void => {
  last = { on: on(), text, at: Date.now() };
  emit({ kind: "loop", on: last.on, text });
};
const pause = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  wake = () => (clearTimeout(timer), resolve());
});

export const loopStatus = () => last;

export const beastSince = (): number =>
  (db.prepare("SELECT count(*) AS n FROM games WHERE mode = 'beast' AND started_at > max(?, (SELECT coalesce(max(started_at), 0) FROM games WHERE mode = 'lootBag'))").get(attempted()) as { n: number }).n;

const lootLeft = (): boolean => liveIds().some((id) => dungeonOf(id) === "lootBag");

async function loot(unfinished: boolean): Promise<boolean> {
  if (unfinished) {
    say("resuming the unfinished Loot Dungeon game");
    await play(1, true, "lootBag");
    return !lootLeft();
  }
  const pool = DUNGEONS.lootBag.pool!;
  const rows = existsSync(BAG_RANKING) ? (JSON.parse(readFileSync(BAG_RANKING, "utf8")) as Ranked[]) : [];
  const best = bestBag(rows, await poolIds(pool));
  const offer = best && (await Promise.all([bagMarket(pool, best.bag), balanceOf(SURVIVOR)]));
  if (!on() || running()) return false;
  mark();
  if (!best || !offer) return say("no Loot Dungeon game: the pool holds no ranked bag"), true;
  const [{ held, quote }, survivor] = offer;
  const entry = { bag: best.bag, maxSurvivor: LOOP.bagCapSurvivor };
  const refused = bagRefusal(held, quote, entry, survivor);
  if (refused) return say(`no Loot Dungeon game on the bag with the most named kills (${best.kills} a game): ${refused}`), true;
  say(`Loot Dungeon game on bag ${best.bag} (${best.kills} named kills a game) for ${units(quote.price)} SURVIVOR`);
  await play(1, true, "lootBag", entry);
  return true;
}

async function beast(games: number, before: number): Promise<boolean> {
  say(`Beast Mode batch of ${games} games (${before} of ${LOOP.beastGames} played since the last Loot Dungeon game)`);
  await play(games, true, "beast");
  say(`Beast Mode batch done: ${beastSince() - before} games started`);
  return beastSince() !== before;
}

const idle = (why: string): Promise<void> => (say(`${why}; next look in ${LOOP.recheckMs / 60_000} min`), pause(LOOP.recheckMs));

async function run(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    while (on()) {
      const held = await strkBalance().catch(() => null);
      if (!on()) break;
      if (held === null) {
        await idle("could not read the STRK balance");
        continue;
      }
      if (running()) {
        await idle("another batch is running");
        continue;
      }
      const strk = Number(held) / 1e18;
      const before = beastSince();
      const unfinished = lootLeft();
      const step = nextStep(strk, before, unfinished);
      if (step.kind === "wait") {
        await idle(`waiting for STRK: ${strk.toFixed(1)} held, ${step.need} needed to go on`);
        continue;
      }
      const moved = step.kind === "loot" ? await loot(unfinished).catch((err) => (say(`Loot Dungeon step failed: ${(err as Error).message.slice(0, 200)}`), false)) : await beast(step.games, before);
      if (!moved && on()) await idle(step.kind === "loot" ? "the Loot Dungeon step did not go through" : "the batch started no game");
    }
  } finally {
    looping = false;
  }
}

export function startLoop(): void {
  if (!on()) writeFileSync(file, "{}");
  void run();
}

export function resumeLoop(): void {
  if (on()) void run();
}

export function stopLoop(): void {
  rmSync(file, { force: true });
  halt();
  wake();
  say("off");
}
