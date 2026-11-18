import { beastOf } from "./beast.ts";
import type { Action } from "./codec.ts";
import { emit } from "./events.ts";
import { act, newPracticeGame, preview, replay, revertReason, type Game, type Snapshot } from "./practice.ts";

let game: Game | undefined;
let last: Snapshot | undefined;

const level = (xp: number) => Math.max(1, Math.floor(Math.sqrt(xp)));

export function describe(s: Snapshot): object {
  const a = s.adventurer;
  const beast = game ? beastOf(a, BigInt(game.id)) : null;
  return {
    over: s.over,
    level: level(a.xp),
    health: a.health,
    xp: a.xp,
    gold: a.gold,
    inBattle: a.beast_health > 0,
    beast,
    statUpgradesAvailable: a.stat_upgrades_available,
    stats: a.stats,
    equipment: a.equipment,
    bag: s.bag,
  };
}

export async function startGame(): Promise<object> {
  game = await newPracticeGame();
  last = await replay(game);
  emit({ kind: "status", text: `practice game ${game.id}` });
  return describe(last);
}

export async function move(actions: Action[]): Promise<object | string> {
  if (!game || last?.over) return "No game in progress: call new_game.";
  try {
    last = await act(game, actions);
    return describe(last);
  } catch (err) {
    return `Rejected by the game: ${revertReason(err)}`;
  }
}

export async function forecast(actions: Action[], samples: number): Promise<object | string> {
  if (!game || last?.over) return "No game in progress: call new_game.";
  try {
    const outcomes = await preview(game, actions, samples);
    const hp = outcomes.map((o) => o.adventurer.health).sort((x, y) => x - y);
    const pick = (q: number) => hp[Math.floor(q * (hp.length - 1))];
    return {
      samples,
      deathRate: outcomes.filter((o) => o.adventurer.health === 0).length / samples,
      stillInBattleRate: outcomes.filter((o) => o.adventurer.beast_health > 0).length / samples,
      healthAfter: { worst: hp[0], p25: pick(0.25), median: pick(0.5), best: hp[hp.length - 1] },
      xpGainMedian: outcomes.map((o) => o.adventurer.xp - last!.adventurer.xp).sort((x, y) => x - y)[Math.floor(samples / 2)],
    };
  } catch (err) {
    return `Rejected by the game: ${revertReason(err)}`;
  }
}

export function gameOver(): boolean {
  return Boolean(last?.over);
}

export function reset(): void {
  game = undefined;
  last = undefined;
}

export function currentGame(): Game | undefined {
  return game;
}

export function snapshot(): Snapshot | undefined {
  return last;
}
