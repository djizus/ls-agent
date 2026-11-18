import { beastOf, type Beast } from "./beast.ts";
import type { Action, Item } from "./codec.ts";
import { emit } from "./events.ts";
import { itemOf, levelOf, type LootItem } from "./items.ts";
import { marketOf } from "./market.ts";
import { act, newPracticeGame, preview, replay, revertReason, type Game, type Snapshot } from "./practice.ts";

type Gear = LootItem & { greatness: number };
export type State = {
  over: boolean;
  level: number;
  health: number;
  maxHealth: number;
  xp: number;
  gold: number;
  beast: Beast | null;
  statUpgradesAvailable: number;
  stats: Snapshot["adventurer"]["stats"];
  equipment: Gear[];
  bag: Gear[];
  market: (LootItem & { price: number })[];
};


const gear = (i: Item): Gear => ({ ...itemOf(i.id)!, greatness: levelOf(i.xp) });

export function describe(s: Snapshot, id: string): State {
  const a = s.adventurer;
  return {
    over: s.over,
    level: levelOf(a.xp),
    health: a.health,
    maxHealth: 100 + 15 * a.stats.vitality,
    xp: a.xp,
    gold: a.gold,
    beast: beastOf(a, BigInt(id)),
    statUpgradesAvailable: a.stat_upgrades_available,
    stats: a.stats,
    equipment: Object.values(a.equipment).filter((i) => i.id).map(gear),
    bag: s.bag.map(gear),
    market: a.beast_health === 0 ? marketOf(a, id).map((o) => ({ ...itemOf(o.id)!, price: o.price })) : [],
  };
}

const item = (g: LootItem) => `${g.name} [${g.id}] T${g.tier} ${g.type}`;

export function render(s: State): string {
  const st = s.stats;
  const lines = [
    s.over ? "DEAD." : s.beast ? "IN BATTLE." : "Exploring.",
    `Level ${s.level} | HP ${s.health}/${s.maxHealth} | Gold ${s.gold} | XP ${s.xp} | Stat points ${s.statUpgradesAvailable}`,
    `Stats STR ${st.strength} DEX ${st.dexterity} VIT ${st.vitality} INT ${st.intelligence} WIS ${st.wisdom} CHA ${st.charisma}`,
    `Equipped: ${s.equipment.map((g) => `${g.slot}: ${item(g)} G${g.greatness}`).join("; ")}`,
    `Bag: ${s.bag.map((g) => `${item(g)} G${g.greatness}`).join("; ") || "empty"}`,
  ];
  if (s.beast) lines.push(`Beast: ${s.beast.name} level ${s.beast.level} T${s.beast.tier} ${s.beast.type}, ${s.beast.health} HP`);
  if (s.market.length) lines.push(`Market: ${s.market.map((m) => `${item(m)} ${m.slot} ${m.price}g`).join("; ")}`);
  return lines.join("\n");
}

export type Phase = "battle" | "explore";

let game: Game | undefined;
let last: Snapshot | undefined;

function state(): State {
  const s = describe(last!, game!.id);
  emit({ kind: "state", game: game!.id, state: s });
  return s;
}

export function phase(s: State): Phase {
  return s.beast ? "battle" : "explore";
}

export async function begin(id: string): Promise<State> {
  game = newPracticeGame(id);
  last = await replay(game);
  return state();
}

export async function commit(actions: Action[]): Promise<State> {
  try {
    last = await act(game!, actions);
  } catch (err) {
    throw new Error(revertReason(err));
  }
  return state();
}

export async function forecast(actions: Action[], samples: number): Promise<string> {
  if (!game || last?.over) return "No game in progress.";
  try {
    const outcomes = await preview(game, actions, samples);
    const hp = outcomes.map((o) => o.adventurer.health).sort((x, y) => x - y);
    const xp = outcomes.map((o) => o.adventurer.xp - last!.adventurer.xp).sort((x, y) => x - y);
    const rate = (n: number) => `${Math.round((100 * n) / samples)}%`;
    const mid = Math.floor(samples / 2);
    return `death ${rate(hp.filter((h) => h === 0).length)}, still in battle ${rate(outcomes.filter((o) => o.adventurer.beast_health > 0).length)}, HP after worst ${hp[0]} median ${hp[mid]} best ${hp[samples - 1]}, XP gained median ${xp[mid]}`;
  } catch (err) {
    return `rejected: ${revertReason(err)}`;
  }
}

export async function options(s: State): Promise<string> {
  if (s.statUpgradesAvailable > 0) return "Spend your stat points in this decision; the simulations resume after.";
  const moves: Action[] = s.beast ? [{ type: "attack" }, { type: "flee" }] : [{ type: "explore" }];
  const lines = await Promise.all(moves.map(async (m) => `- ${m.type} once: ${await forecast([m], 16)}`));
  const potion = !s.beast && s.health < s.maxHealth ? await potionPrice() : undefined;
  return [`Simulated outcomes (16 samples each):`, ...lines, potion && `Potions cost ${potion} gold each (10 HP).`].filter(Boolean).join("\n");
}

async function potionPrice(): Promise<number | undefined> {
  const before = last!.adventurer.gold;
  const [after] = await preview(game!, [{ type: "potions", qty: 1 }], 1).catch(() => []);
  return after && before - after.adventurer.gold;
}

export function snapshot(): State | undefined {
  return last && game && describe(last, game.id);
}

export function movesMade(): number {
  return game?.packets.length ?? 0;
}
