import { beastOf, type Beast } from "./beast.ts";
import { STATS, type Action, type Item, type Stats } from "./codec.ts";
import { emit } from "./events.ts";
import { itemOf, levelOf, potionPrice, priceOf, type ItemType, type LootItem } from "./items.ts";
import { MAX_GREATNESS, type Hit } from "./combat.ts";
import { marketOf } from "./market.ts";
import { MARKET } from "./settings.ts";
import { BAG_STATS, SUFFIX_GREATNESS, SUFFIXES, effectiveStats, suffixOf } from "./specials.ts";
import { NECK, beastHit, yourHit } from "./engine/damage.ts";
import { actLive, liveGame, type Entry } from "./live.ts";
import { ARMOR_SLOTS, foeOf, toSnapshot } from "./engine/engine.ts";
import { act, audit, newPracticeGame, preview, revertReason, type Game, type Snapshot } from "./practice.ts";

type Worn = LootItem & { greatness: number; xp: number; suffix?: string; bonus?: Partial<Stats> };
type Gear = Worn & { toNext: number; grants: string[] };
type Offer = LootItem & { price: number };
export type State = {
  over: boolean;
  level: number;
  health: number;
  maxHealth: number;
  xp: number;
  gold: number;
  beast: Beast | null;
  hits: { yours: Hit; theirs: Hit[]; spare: { id: number; hit: Hit }[]; arms: { id: number; hit: Hit }[] } | null;
  statUpgradesAvailable: number;
  stats: Stats;
  baseStats: Stats;
  equipment: Gear[];
  bag: Gear[];
  market: Offer[];
  potionPrice: number;
  happened: string[];
  luck: number;
  buys: { attack: number; flee: number; trap: number; ambush: number; crit: number };
  purse: { potions: number; toFull: number; deal: (Offer & { why: string }) | null };
};
export const slewNamed = (before: Pick<State, "beast">, after: Pick<State, "beast" | "over">, move: string): boolean =>
  before.beast?.specialPrefix != null && !after.beast && !after.over && move === "attack";

type Recorded = { kind: string; state?: Pick<State, "beast" | "over">; actions?: { type: string }[] };

export function namedKills(events: Recorded[]): (NonNullable<State["beast"]> & { move: number })[] {
  const kills: (NonNullable<State["beast"]> & { move: number })[] = [];
  let before: Recorded["state"];
  let move: string | undefined;
  let moves = 0;
  for (const e of events) {
    if (e.kind === "decision") move = e.actions?.[0]?.type;
    if (e.kind !== "state" || !e.state) continue;
    if (before && move && slewNamed(before, e.state, move)) kills.push({ ...before.beast!, move: moves });
    if (move) moves++;
    before = e.state;
    move = undefined;
  }
  return kills;
}

export const namedSlain = (events: Recorded[]): number => namedKills(events).length;

type Stored = Pick<State, "over" | "level" | "health" | "maxHealth" | "xp" | "gold" | "beast" | "statUpgradesAvailable" | "stats" | "market"> &
  Partial<Pick<State, "baseStats" | "potionPrice" | "happened" | "hits">> & { equipment: Legacy[] | Record<string, Legacy>; bag: Legacy[] };
type Legacy = Omit<Worn, "greatness" | "xp"> & { greatness?: number; xp?: number; level?: number };

const ABBR: Record<string, string> = { strength: "STR", dexterity: "DEX", vitality: "VIT", intelligence: "INT", wisdom: "WIS", charisma: "CHA" };
const JEWELRY = ["neck", "ring"];
const MAX_HEALTH = 1023;
const DOUBLE_LUCK = "Silver Ring";
const ARMOR: string[] = [...ARMOR_SLOTS];
const RING: Record<string, (percent: number) => string> = {
  "Titanium Ring": (p) => `critical hits add ${p}% of attack`,
  "Gold Ring": (p) => `+${p}% gold from beasts`,
  "Platinum Ring": (p) => `+${p}% name-match damage`,
};

export function enrich(s: Stored): State {
  const worn = Object.values(s.equipment);
  const armor = worn.filter((g) => ARMOR.includes(g.slot));
  const market = Array.isArray(s.market) ? s.market : [];
  const gear = (held: boolean) => (g: Legacy): Gear => {
    const greatness = Math.min(MAX_GREATNESS, g.greatness ?? g.level ?? 1);
    const xp = g.xp ?? greatness ** 2;
    const jewel = JEWELRY.includes(g.slot);
    const bonus = Object.entries(g.bonus ?? {}).filter(([stat]) => held || BAG_STATS.includes(stat as keyof Stats));
    const matching = armor.filter((a) => NECK[a.type] === g.name).length;
    return {
      ...g,
      greatness,
      xp,
      toNext: greatness >= MAX_GREATNESS ? 0 : (greatness + 1) ** 2 - xp,
      grants: [
        ...bonus.map(([stat, n]) => `+${n} ${stat}`),
        ...(jewel ? [held && g.name === DOUBLE_LUCK ? `+${2 * greatness} luck (doubled while worn)` : `+${greatness} luck`] : []),
        ...(held && g.slot === "neck" ? [`${Object.keys(NECK).find((type) => NECK[type as ItemType] === g.name)} armor blocks ${3 * greatness}% more (${matching} of ${ARMOR.length} worn)`] : []),
        ...(held && RING[g.name] ? [RING[g.name](3 * greatness)] : []),
      ],
    };
  };
  const equipment = worn.map(gear(true));
  const bag = s.bag.map(gear(false));
  const granted = (stat: keyof Stats) => [...equipment, ...bag.filter(() => BAG_STATS.includes(stat))].reduce((n, g) => n + (g.bonus?.[stat] ?? 0), 0);
  const luck = [...equipment, ...bag].reduce((n, g) => n + (JEWELRY.includes(g.slot) ? g.greatness * (g.name === DOUBLE_LUCK && equipment.includes(g) ? 2 : 1) : 0), 0);
  const chance = (stat: number) => Math.min(100, Math.round((100 * stat) / s.level));
  const price = s.potionPrice ?? potionPrice(s.level, s.stats.charisma);
  const owned = new Set([...equipment, ...bag].map((g) => g.id));
  const deals = market.flatMap((m) => {
    const now = equipment.find((g) => g.slot === m.slot);
    if (owned.has(m.id) || (now && (JEWELRY.includes(m.slot) || m.tier >= now.tier))) return [];
    return [{ ...m, why: now ? `tier ${m.tier} over tier ${now.tier}` : `empty ${m.slot}` }];
  });
  return {
    ...s,
    equipment,
    bag,
    market,
    baseStats: s.baseStats ?? (Object.fromEntries(STATS.map((stat) => [stat, s.stats[stat] - granted(stat)])) as Stats),
    potionPrice: price,
    happened: s.happened ?? [],
    hits: s.hits ?? null,
    luck,
    buys: { attack: 10 * s.stats.strength, flee: chance(s.stats.dexterity), trap: chance(s.stats.intelligence), ambush: chance(s.stats.wisdom), crit: Math.min(100, luck) },
    purse: { potions: Math.floor(s.gold / price), toFull: Math.ceil((s.maxHealth - s.health) / 10), deal: deals.sort((a, b) => a.price - b.price || a.tier - b.tier)[0] ?? null },
  };
}

export function describe(s: Snapshot, id: string): State {
  const a = { ...s.adventurer, stats: effectiveStats(s.adventurer, s.bag, id) };
  const gear = (i: Item): Worn => {
    const greatness = levelOf(i.xp);
    const suffix = greatness >= SUFFIX_GREATNESS ? suffixOf(i.id, a.item_specials_salt, id) : undefined;
    return { ...itemOf(i.id)!, greatness, xp: i.xp, ...(suffix && { suffix, bonus: SUFFIXES[suffix] }) };
  };
  const foe = a.beast_health > 0 ? foeOf(a, BigInt(id)) : null;
  return enrich({
    over: s.over,
    level: levelOf(a.xp),
    health: a.health,
    maxHealth: Math.min(MAX_HEALTH, 100 + 15 * a.stats.vitality),
    xp: a.xp,
    gold: a.gold,
    beast: beastOf(a, BigInt(id)),
    hits: foe && {
      yours: yourHit(a, a.stats.strength, foe, BigInt(id)),
      theirs: ARMOR_SLOTS.map((slot) => beastHit(a, foe, a.equipment[slot], BigInt(id))),
      spare: s.bag.filter((i) => ARMOR.includes(itemOf(i.id)!.slot)).map((i) => ({ id: i.id, hit: beastHit(a, foe, i, BigInt(id)) })),
      arms: s.bag.filter((i) => itemOf(i.id)!.slot === "weapon").map((i) => {
        const armed = { ...s.adventurer, equipment: { ...s.adventurer.equipment, weapon: i } };
        const rest = [...s.bag.filter((b) => b.id !== i.id), s.adventurer.equipment.weapon];
        return { id: i.id, hit: yourHit({ ...a, equipment: armed.equipment }, effectiveStats(armed, rest, id).strength, foe, BigInt(id)) };
      }),
    },
    statUpgradesAvailable: a.stat_upgrades_available,
    stats: a.stats,
    baseStats: s.adventurer.stats,
    equipment: Object.values(a.equipment).filter((i) => i.id).map(gear),
    bag: s.bag.map(gear),
    potionPrice: potionPrice(levelOf(a.xp), a.stats.charisma),
    happened: s.log ?? [],
    market: a.beast_health === 0 ? marketOf(a, id, MARKET).map((o) => ({ ...itemOf(o.id)!, price: o.price })) : [],
  });
}

const item = (g: LootItem) => `${g.name} [${g.id}] T${g.tier} ${g.type}`;
const attack = (g: LootItem, greatness: number) => (g.slot === "weapon" ? `attack ${greatness * (6 - g.tier)}` : "");
const growth = (g: Gear) => (g.toNext === 0 ? "maxed" : `${g.toNext} xp to G${g.greatness + 1}${g.greatness < 15 ? `, suffix at G15` : ""}`);
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
  if (s.beast && s.hits) {
    const mine = s.hits.yours;
    const blows = Math.ceil(s.beast.health / mine.normal);
    const theirs = ARMOR_SLOTS.map((slot, i) => `${slot} ${s.hits!.theirs[i].normal}`);
    lines.push(`Beast: ${s.beast.name} level ${s.beast.level} T${s.beast.tier} ${s.beast.type}, ${s.beast.health} HP`);
    lines.push(`Your hit: ${mine.normal} damage (${mine.crit} on a crit), so ${blows} blows to kill. Its hit by slot struck: ${theirs.join(", ")} (double on a crit, ${s.level}% chance).`);
  }
  if (!s.beast) lines.push(`Potions: ${s.potionPrice} gold each, ${Math.ceil((s.maxHealth - s.health) / 10)} to reach full health.`);
  if (s.market.length) lines.push(`Market (items start at G1): ${s.market.map((m) => `${item(m)} ${m.slot} ${m.price}g${m.slot === "weapon" ? ` (${attack(m, 1)}, ${attack(m, 20)} at G20)` : ""}`).join("; ")}`);
  return lines.join("\n");
}

export type Phase = "battle" | "explore";

export type Table = { game: Game; last: Snapshot; row?: number };

export const tables: Table[] = [];

function state(t: Table): State {
  const s = describe(t.last, t.game.id);
  emit({ kind: "state", game: t.game.id, state: s, row: t.row });
  return s;
}

export function phase(s: State): Phase {
  return s.beast ? "battle" : "explore";
}

export async function begin(id: string | undefined, seed = 0, entry?: Entry, resumed?: string): Promise<Table> {
  const game = id ? await newPracticeGame(id, seed) : await liveGame(entry, resumed);
  const table = { game, last: toSnapshot(game.local) };
  tables.push(table);
  return table;
}

export const leave = (t: Table): void => void tables.splice(tables.indexOf(t), 1);

export const current = (t: Table): State => state(t);

export type Committed = { state: State; strk: number } | { error: Error };

export async function commit(moves: { table: Table; actions: Action[] }[]): Promise<Committed[]> {
  const live = moves.filter((m) => m.table.game.chain);
  const sent = live.length ? await actLive(live.map((m) => ({ game: m.table.game, actions: m.actions }))) : [];
  return moves.map((m) => {
    try {
      const moved = m.table.game.chain ? sent[live.indexOf(m)] : { snapshot: act(m.table.game, m.actions), strk: 0 };
      if ("error" in moved) throw moved.error;
      m.table.last = moved.snapshot;
      return { state: state(m.table), strk: moved.strk };
    } catch (err) {
      return { error: new Error(revertReason(err)) };
    }
  });
}

const SAMPLES = 8;

export type Odds = { death: number; ongoing: number; hp: [number, number, number]; xp: number; gold: number };
export type Option = { move: string; label: string } & (Odds | { error: string });

export async function odds(t: Table, actions: Action[], samples: number): Promise<Odds> {
  const outcomes = preview(t.game, actions, samples);
  const pick = (values: number[]) => values.sort((x, y) => x - y)[Math.floor(samples / 2)];
  const hp = outcomes.map((o) => o.adventurer.health).sort((x, y) => x - y);
  return {
    death: outcomes.filter((o) => o.adventurer.health === 0).length / samples,
    ongoing: outcomes.filter((o) => o.adventurer.beast_health > 0).length / samples,
    hp: [hp[0], hp[Math.floor(samples / 2)], hp[samples - 1]],
    xp: pick(outcomes.map((o) => o.adventurer.xp - t.last.adventurer.xp)),
    gold: pick(outcomes.map((o) => o.adventurer.gold - t.last.adventurer.gold)),
  };
}

export function describeOdds(o: Odds): string {
  const pct = (n: number) => `${Math.round(100 * n)}%`;
  return `death ${pct(o.death)}, still in battle ${pct(o.ongoing)}, HP after worst ${o.hp[0]} median ${o.hp[1]} best ${o.hp[2]}, XP gained median ${o.xp}, gold change median ${o.gold}`;
}

export async function forecast(actions: Action[], samples: number): Promise<string> {
  const [t] = tables;
  if (!t || t.last.over) return "No game in progress.";
  try {
    return describeOdds(await odds(t, actions, samples));
  } catch (err) {
    return `rejected: ${revertReason(err)}`;
  }
}

const LABEL: Record<string, string> = { attack: "fight until it ends", flee: "flee until escaped", explore: "explore one step (after the automatic heal)" };

export async function options(t: Table, s: State): Promise<Option[]> {
  if (s.statUpgradesAvailable > 0) return [];
  const moves: Action[] = s.beast ? [{ type: "attack" }, { type: "flee" }] : [{ type: "explore" }];
  return Promise.all(
    moves.map(async (m) => {
      try {
        return { move: m.type, label: LABEL[m.type], ...(await odds(t, shape(s, [m]), SAMPLES)) };
      } catch (err) {
        return { move: m.type, label: LABEL[m.type], error: revertReason(err) };
      }
    }),
  );
}

export function describeOptions(s: State, list: Option[]): string {
  if (!list.length) return "";
  return [`Simulated outcomes (${SAMPLES} samples each):`, ...list.map((o) => `- ${o.label}: ${"error" in o ? `rejected: ${o.error}` : describeOdds(o)}`)].join("\n");
}

const RANDOM = new Set(["explore", "attack", "flee"]);

export const auditGame = (t: Table): Promise<string | undefined> => audit(t.game);

export function shape(s: State, actions: Action[], reserve = 0): Action[] {
  if (s.beast) return actions;
  const ups = (stat: string) => actions.reduce((n, a) => n + (a.type === "upgrade" && a.stat === stat ? a.amount : 0), 0);
  const lost = (stat: "vitality" | "charisma") => actions.reduce((n, a) => n + (a.type === "drop" ? ([...s.bag, ...s.equipment].find((g) => g.id === a.item)?.bonus?.[stat] ?? 0) : 0), 0);
  const charisma = s.stats.charisma + ups("charisma") - lost("charisma");
  const maxHealth = s.maxHealth + 15 * (ups("vitality") - lost("vitality"));
  const health = Math.min(s.health, s.maxHealth - 15 * lost("vitality")) + 15 * ups("vitality");
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

export const seated = (row: number): Table | undefined => tables.find((t) => t.row === row);

export const snapshot = (t: Table | undefined = tables.at(-1)): State | undefined => t && describe(t.last, t.game.id);
