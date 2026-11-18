import { beastOf, type Beast } from "./beast.ts";
import type { Action, Item } from "./codec.ts";
import { emit } from "./events.ts";
import { itemOf, levelOf, potionPrice, priceOf, type LootItem } from "./items.ts";
import { marketOf } from "./market.ts";
import { MARKET } from "./settings.ts";
import { SUFFIX_GREATNESS, SUFFIXES, effectiveStats, suffixOf } from "./specials.ts";
import { act, newPracticeGame, preview, replay, revertReason, type Game, type Snapshot } from "./practice.ts";

type Gear = LootItem & { greatness: number; suffix?: string; bonus?: Partial<State["stats"]> };
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
  potionPrice: number;
};



export function describe(s: Snapshot, id: string): State {
  const a = { ...s.adventurer, stats: effectiveStats(s.adventurer, s.bag, id) };
  const gear = (i: Item): Gear => {
    const greatness = levelOf(i.xp);
    const suffix = greatness >= SUFFIX_GREATNESS ? suffixOf(i.id, a.item_specials_salt, id) : undefined;
    return { ...itemOf(i.id)!, greatness, ...(suffix && { suffix, bonus: SUFFIXES[suffix] }) };
  };
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
    potionPrice: potionPrice(levelOf(a.xp), a.stats.charisma),
    market: a.beast_health === 0 ? marketOf(a, id, MARKET).map((o) => ({ ...itemOf(o.id)!, price: o.price })) : [],
  };
}

const ABBR: Record<string, string> = { strength: "STR", dexterity: "DEX", vitality: "VIT", intelligence: "INT", wisdom: "WIS", charisma: "CHA" };
const item = (g: LootItem) => `${g.name} [${g.id}] T${g.tier} ${g.type}`;
const owned = (g: Gear) => `${item(g)} G${g.greatness}${g.suffix ? ` ${g.suffix} (${Object.entries(g.bonus!).map(([k, v]) => `+${v} ${ABBR[k]}`).join(" ")})` : ""}`;

export function render(s: State): string {
  const st = s.stats;
  const lines = [
    s.over ? "DEAD." : s.beast ? "IN BATTLE." : "Exploring.",
    `Level ${s.level} | HP ${s.health}/${s.maxHealth} | Gold ${s.gold} | XP ${s.xp} | Stat points ${s.statUpgradesAvailable}`,
    `Stats (with item bonuses) STR ${st.strength} DEX ${st.dexterity} VIT ${st.vitality} INT ${st.intelligence} WIS ${st.wisdom} CHA ${st.charisma}`,
    `Equipped: ${s.equipment.map((g) => `${g.slot}: ${owned(g)}`).join("; ")}`,
    `Bag: ${s.bag.map(owned).join("; ") || "empty"}`,
  ];
  if (s.beast) lines.push(`Beast: ${s.beast.name} level ${s.beast.level} T${s.beast.tier} ${s.beast.type}, ${s.beast.health} HP`);
  if (!s.beast) lines.push(`Potions: ${s.potionPrice} gold each, ${Math.ceil((s.maxHealth - s.health) / 10)} to reach full health.`);
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
    const gold = outcomes.map((o) => o.adventurer.gold - last!.adventurer.gold).sort((x, y) => x - y);
    return `death ${rate(hp.filter((h) => h === 0).length)}, still in battle ${rate(outcomes.filter((o) => o.adventurer.beast_health > 0).length)}, HP after worst ${hp[0]} median ${hp[mid]} best ${hp[samples - 1]}, XP gained median ${xp[mid]}, gold change median ${gold[mid]}`;
  } catch (err) {
    return `rejected: ${revertReason(err)}`;
  }
}

export async function options(s: State): Promise<string> {
  if (s.statUpgradesAvailable > 0) return "Stat points are pending: this decision applies your upgrades and purchases only; you choose what to do next with the odds in front of you.";
  const moves: Action[] = s.beast ? [{ type: "attack" }, { type: "flee" }] : [{ type: "explore" }];
  const label = { attack: "fight until it ends", flee: "flee until escaped", explore: "explore one step (after the automatic heal)" } as Record<string, string>;
  const lines = await Promise.all(moves.map(async (m) => `- ${label[m.type]}: ${await forecast(shape(s, [m]), 16)}`));
  return [`Simulated outcomes (16 samples each):`, ...lines].join("\n");
}

const RANDOM = new Set(["explore", "attack", "flee"]);

export async function verify(s: State, actions: Action[]): Promise<string | undefined> {
  const fixed = actions.filter((a) => !RANDOM.has(a.type));
  if (!fixed.length || fixed.some((a) => a.type === "equip" || a.type === "drop")) return;
  const ups = (stat: string) => fixed.reduce((n, a) => n + (a.type === "upgrade" && a.stat === stat ? a.amount : 0), 0);
  const charisma = s.stats.charisma + ups("charisma");
  const potions = fixed.reduce((n, a) => n + (a.type === "potions" ? a.qty : 0), 0);
  const maxHealth = s.maxHealth + 15 * ups("vitality");
  const expected = {
    gold: fixed.reduce((g, a) => g - (a.type === "buy" ? priceOf(a.item, charisma) : 0), s.gold) - potions * potionPrice(s.level, charisma),
    health: Math.min(s.health + 15 * ups("vitality") + 10 * potions, maxHealth),
  };
  const [after] = await preview(game!, fixed, 1);
  const actual = { gold: after.adventurer.gold, health: after.adventurer.health };
  if (expected.gold !== actual.gold || expected.health !== actual.health) return `predicted ${JSON.stringify(expected)}, contract ${JSON.stringify(actual)} for ${JSON.stringify(fixed)}`;
}

export function shape(s: State, actions: Action[], reserve = 0): Action[] {
  if (s.statUpgradesAvailable > 0) return actions.filter((a) => !RANDOM.has(a.type));
  if (s.beast) return actions;
  const ups = (stat: string) => actions.reduce((n, a) => n + (a.type === "upgrade" && a.stat === stat ? a.amount : 0), 0);
  const charisma = s.stats.charisma + ups("charisma");
  const maxHealth = s.maxHealth + 15 * ups("vitality");
  const health = s.health + 15 * ups("vitality");
  const gold = actions.reduce((g, a) => g - (a.type === "buy" ? priceOf(a.item, charisma) : 0), s.gold);
  const price = potionPrice(s.level, charisma);
  const wanted = actions.reduce((n, a) => n + (a.type === "potions" ? a.qty : 0), 0);
  const needed = Math.ceil((maxHealth - health) / 10);
  const exploring = actions.at(-1)?.type === "explore";
  const healing = exploring ? Math.min(needed, Math.floor(Math.max(0, gold - reserve) / price)) : 0;
  const qty = Math.min(Math.max(wanted, healing), needed, Math.floor(gold / price));
  const rest = actions.filter((a) => a.type !== "potions");
  const random = rest.filter((a) => RANDOM.has(a.type));
  const fixed = rest.filter((a) => !RANDOM.has(a.type));
  return [...fixed, ...(qty > 0 ? [{ type: "potions" as const, qty }] : []), ...random];
}

export function snapshot(): State | undefined {
  return last && game && describe(last, game.id);
}

export function movesMade(): number {
  return game?.packets.length ?? 0;
}
