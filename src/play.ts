import { beastOf, type Beast } from "./beast.ts";
import type { Action, Item } from "./codec.ts";
import { emit } from "./events.ts";
import { itemOf, levelOf, potionPrice, priceOf, type LootItem } from "./items.ts";
import { beastHit, yourHit } from "./combat.ts";
import { marketOf } from "./market.ts";
import { MARKET } from "./settings.ts";
import { SUFFIX_GREATNESS, SUFFIXES, effectiveStats, suffixOf } from "./specials.ts";
import { act, audit, newPracticeGame, preview, revertReason, type Game, type Snapshot } from "./practice.ts";

type Gear = LootItem & { greatness: number; xp: number; suffix?: string; bonus?: Partial<State["stats"]> };
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
    return { ...itemOf(i.id)!, greatness, xp: i.xp, ...(suffix && { suffix, bonus: SUFFIXES[suffix] }) };
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
const attack = (g: LootItem, greatness: number) => (g.slot === "weapon" ? `attack ${greatness * (6 - g.tier)}` : "");
const growth = (g: Gear) => (g.greatness >= 20 ? "maxed" : `${(g.greatness + 1) ** 2 - g.xp} xp to G${g.greatness + 1}${g.greatness < 15 ? `, suffix at G15` : ""}`);
const owned = (g: Gear) =>
  `${item(g)} G${g.greatness}${g.suffix ? ` ${g.suffix} (${Object.entries(g.bonus!).map(([k, v]) => `+${v} ${ABBR[k]}`).join(" ")})` : ""} (${[attack(g, g.greatness), growth(g)].filter(Boolean).join(", ")})`;

export function render(s: State): string {
  const st = s.stats;
  const lines = [
    s.over ? "DEAD." : s.beast ? "IN BATTLE." : "Exploring.",
    `Level ${s.level} | HP ${s.health}/${s.maxHealth} | Gold ${s.gold} | XP ${s.xp} | Stat points ${s.statUpgradesAvailable}`,
    `Stats (with item bonuses) STR ${st.strength} DEX ${st.dexterity} VIT ${st.vitality} INT ${st.intelligence} WIS ${st.wisdom} CHA ${st.charisma}`,
    `Equipped: ${s.equipment.map((g) => `${g.slot}: ${owned(g)}`).join("; ")}`,
    `Bag: ${s.bag.map(owned).join("; ") || "empty"}`,
  ];
  if (s.beast) {
    const worn = (slot: string) => s.equipment.find((g) => g.slot === slot);
    const mine = yourHit(worn("weapon"), s.stats, s.beast);
    const blows = Math.ceil(s.beast.health / mine.normal);
    const theirs = ["chest", "head", "waist", "foot", "hand"].map((slot) => `${slot} ${beastHit(s.beast!, worn(slot)).normal}`);
    lines.push(`Beast: ${s.beast.name} level ${s.beast.level} T${s.beast.tier} ${s.beast.type}, ${s.beast.health} HP`);
    lines.push(`Your hit: ${mine.normal} damage (${mine.crit} on a crit), so ${blows} blows to kill. Its hit by slot struck: ${theirs.join(", ")} (double on a crit, ${s.level}% chance).`);
  }
  if (!s.beast) lines.push(`Potions: ${s.potionPrice} gold each, ${Math.ceil((s.maxHealth - s.health) / 10)} to reach full health.`);
  if (s.market.length) lines.push(`Market (items start at G1): ${s.market.map((m) => `${item(m)} ${m.slot} ${m.price}g${m.slot === "weapon" ? ` (${attack(m, 1)}, ${attack(m, 20)} at G20)` : ""}`).join("; ")}`);
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
  game = await newPracticeGame(id);
  last = game.start;
  return state();
}

export async function commit(actions: Action[]): Promise<State> {
  try {
    last = act(game!, actions);
  } catch (err) {
    throw new Error(revertReason(err));
  }
  return state();
}

const SAMPLES = 8;

export type Odds = { death: number; ongoing: number; hp: [number, number, number]; xp: number; gold: number };
export type Option = { move: string; label: string } & (Odds | { error: string });

export async function odds(actions: Action[], samples: number): Promise<Odds> {
  const outcomes = preview(game!, actions, samples);
  const pick = (values: number[]) => values.sort((x, y) => x - y)[Math.floor(samples / 2)];
  const hp = outcomes.map((o) => o.adventurer.health).sort((x, y) => x - y);
  return {
    death: outcomes.filter((o) => o.adventurer.health === 0).length / samples,
    ongoing: outcomes.filter((o) => o.adventurer.beast_health > 0).length / samples,
    hp: [hp[0], hp[Math.floor(samples / 2)], hp[samples - 1]],
    xp: pick(outcomes.map((o) => o.adventurer.xp - last!.adventurer.xp)),
    gold: pick(outcomes.map((o) => o.adventurer.gold - last!.adventurer.gold)),
  };
}

export function describeOdds(o: Odds): string {
  const pct = (n: number) => `${Math.round(100 * n)}%`;
  return `death ${pct(o.death)}, still in battle ${pct(o.ongoing)}, HP after worst ${o.hp[0]} median ${o.hp[1]} best ${o.hp[2]}, XP gained median ${o.xp}, gold change median ${o.gold}`;
}

export async function forecast(actions: Action[], samples: number): Promise<string> {
  if (!game || last?.over) return "No game in progress.";
  try {
    return describeOdds(await odds(actions, samples));
  } catch (err) {
    return `rejected: ${revertReason(err)}`;
  }
}

const LABEL: Record<string, string> = { attack: "fight until it ends", flee: "flee until escaped", explore: "explore one step (after the automatic heal)" };

export async function options(s: State): Promise<Option[]> {
  if (s.statUpgradesAvailable > 0) return [];
  const moves: Action[] = s.beast ? [{ type: "attack" }, { type: "flee" }] : [{ type: "explore" }];
  return Promise.all(
    moves.map(async (m) => {
      try {
        return { move: m.type, label: LABEL[m.type], ...(await odds(shape(s, [m]), SAMPLES)) };
      } catch (err) {
        return { move: m.type, label: LABEL[m.type], error: revertReason(err) };
      }
    }),
  );
}

export function describeOptions(s: State, list: Option[]): string {
  if (s.statUpgradesAvailable > 0) return "Stat points are pending: this decision applies your upgrades and purchases only; you choose what to do next with the odds in front of you.";
  return [`Simulated outcomes (${SAMPLES} samples each):`, ...list.map((o) => `- ${o.label}: ${"error" in o ? `rejected: ${o.error}` : describeOdds(o)}`)].join("\n");
}

const RANDOM = new Set(["explore", "attack", "flee"]);

export function auditGame(): Promise<string | undefined> {
  return audit(game!);
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
