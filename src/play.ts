import { beastOf } from "./beast.ts";
import type { Action, Item } from "./codec.ts";
import { itemOf, levelOf, priceOf } from "./items.ts";
import { marketOf } from "./market.ts";
import { emit } from "./events.ts";
import { act, newPracticeGame, preview, replay, revertReason, type Game, type Snapshot } from "./practice.ts";

let game: Game | undefined;
let last: Snapshot | undefined;

const gear = (i: Item) => {
  const item = itemOf(i.id);
  return item && { id: i.id, name: item.name, slot: item.slot, type: item.type, tier: item.tier, level: levelOf(i.xp) };
};

export function describe(s: Snapshot): object {
  const a = s.adventurer;
  const beast = game ? beastOf(a, BigInt(game.id)) : null;
  return {
    over: s.over,
    level: levelOf(a.xp),
    health: a.health,
    xp: a.xp,
    gold: a.gold,
    inBattle: a.beast_health > 0,
    beast,
    statUpgradesAvailable: a.stat_upgrades_available,
    stats: a.stats,
    equipment: Object.fromEntries(Object.entries(a.equipment).filter(([, i]) => i.id).map(([slot, i]) => [slot, gear(i)])),
    bag: s.bag.map(gear),
    market: a.stat_upgrades_available > 0 && game
      ? marketOf(a, game.id).map((o) => ({ ...gear({ id: o.id, xp: 0 })!, level: undefined, price: priceOf(o.id, a.stats.charisma) }))
      : "closed: opens when stat upgrades are available",
  };
}

function publish(): object {
  const state = describe(last!);
  emit({ kind: "state", game: game!.id, state });
  return state;
}

export async function startGame(): Promise<object> {
  game = await newPracticeGame();
  last = await replay(game);
  emit({ kind: "status", text: `practice game ${game.id}` });
  return publish();
}

export async function move(actions: Action[]): Promise<object | string> {
  if (!game || last?.over) return "No game in progress: call new_game.";
  try {
    last = await act(game, actions);
    return publish();
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
