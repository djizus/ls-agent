import type { Action } from "./codec.ts";
import { beastHit, yourHit } from "./combat.ts";
import { potionPrice } from "./items.ts";
import { shape, type State } from "./play.ts";

export const RULES = { potionPrice: 1, dexPerLevel: 1, weaponCatchUp: 5, jewelryLevel: 12, jewelryReserve: 2 };

const RINGS = ["Titanium Ring", "Silver Ring", "Gold Ring", "Platinum Ring", "Bronze Ring"];

const NECK: Record<string, string> = { Cloth: "Amulet", Hide: "Pendant", Metal: "Necklace" };

const MAX_GREATNESS = 20;
const MAX_STAT = 31;
const BAG_SIZE = 15;
const FALLBACK = ["vitality", "strength", "dexterity", "charisma", "intelligence", "wisdom"] as const;
const ARMOR = ["chest", "head", "waist", "foot", "hand"];
const JEWELRY = ["neck", "ring"];

export type Plan = { actions: Action[]; why: string };
type Gear = State["bag"][number];
type Offer = State["market"][number];

const maxed = (g: Gear) => g.greatness >= MAX_GREATNESS;

export function plan(s: State): Plan {
  const worn = (slot: string) => s.equipment.find((g) => g.slot === slot);
  if (s.beast) {
    const toKill = Math.ceil(s.beast.health / yourHit(worn("weapon"), s.stats, s.beast).normal);
    const taken = ARMOR.reduce((sum, slot) => sum + beastHit(s.beast!, worn(slot)).normal, 0) / ARMOR.length;
    const toDie = Math.ceil(s.health / taken);
    const fight = toKill < toDie || s.stats.dexterity === 0;
    return { actions: [{ type: fight ? "attack" : "flee" }], why: `${toKill} blows to kill it, ${toDie} to die: ${fight ? "fight" : "flee"}` };
  }
  const upgrades: Action[] = [];
  const why: string[] = [];
  const stats = { ...s.stats };
  const base = { ...s.baseStats };
  for (let i = 0; i < s.statUpgradesAvailable; i++) {
    const wanted = [
      ...(potionPrice(s.level, stats.charisma) > RULES.potionPrice ? ["charisma" as const] : []),
      ...(stats.dexterity < RULES.dexPerLevel * s.level ? ["dexterity" as const] : []),
      ...FALLBACK,
    ];
    const stat = wanted.find((w) => base[w] < MAX_STAT)!;
    stats[stat]++;
    base[stat]++;
    const same = upgrades.find((a) => a.type === "upgrade" && a.stat === stat);
    if (same && same.type === "upgrade") same.amount++;
    else upgrades.push({ type: "upgrade", stat, amount: 1 });
  }
  for (const a of upgrades) if (a.type === "upgrade") why.push(`+${a.amount} ${a.stat.slice(0, 3).toUpperCase()}`);
  const potion = potionPrice(s.level, stats.charisma);
  const fullHeal = potion * Math.ceil((s.maxHealth + 15 * (stats.vitality - s.stats.vitality)) / 10);
  let gold = s.gold - potion * Math.ceil((s.maxHealth - s.health) / 10);
  const price = (m: Offer) => Math.max(1, m.price - (stats.charisma - s.stats.charisma));
  const bag = [...s.bag];
  let room = BAG_SIZE - bag.length;
  const drops: Action[] = [];
  const equips: Action[] = [];
  const buys: Action[] = [];
  const owned = new Set([...s.equipment, ...s.bag].map((g) => g.id));
  const use = (g: Gear) => (JEWELRY.includes(g.slot) ? 2 : g.tier < (worn(g.slot)?.tier ?? 6) ? 1 : 0);
  const makeRoom = () => {
    if (room > 0) return true;
    const out = bag.filter((g) => !g.bonus?.vitality && !g.bonus?.charisma).sort((a, b) => use(a) - use(b) || b.tier - a.tier || a.greatness - b.greatness)[0];
    if (!out) return false;
    bag.splice(bag.indexOf(out), 1);
    drops.push({ type: "drop", item: out.id });
    why.push(`drop ${out.name}`);
    room++;
    return true;
  };
  const take = (pick: Gear | Offer, reason: string) => {
    if ("greatness" in pick) {
      equips.push({ type: "equip", item: pick.id });
      bag.splice(bag.indexOf(pick), 1);
    } else {
      if (worn(pick.slot) && !makeRoom()) return;
      if (worn(pick.slot)) room--;
      buys.push({ type: "buy", item: pick.id, equip: true });
      owned.add(pick.id);
      gold -= price(pick);
    }
    why.push(`${pick.name} (${reason})`);
  };
  const stowed = (slot: string) => bag.filter((g) => g.slot === slot);
  const offers = (slot: string, reserve = 0) => s.market.filter((m) => m.slot === slot && !owned.has(m.id) && price(m) <= gold - reserve);
  const next = (slot: string, tier: number): Gear | Offer | undefined => [...stowed(slot), ...offers(slot)].filter((c) => c.tier < tier).sort((a, b) => a.tier - b.tier)[0];

  const weapon = worn("weapon");
  const blade = next("weapon", Math.min(2, weapon?.tier ?? 6));
  if (blade && (!weapon || maxed(weapon) || weapon.greatness * (6 - weapon.tier) <= RULES.weaponCatchUp * (6 - blade.tier))) take(blade, "T1 weapon");
  for (const slot of ARMOR) {
    const now = worn(slot);
    const pick = now ? maxed(now) && next(slot, now.tier) : offers(slot).sort((a, b) => price(a) - price(b))[0];
    if (pick) take(pick, now ? `${slot} maxed, T${pick.tier} next` : `empty ${slot}`);
  }
  const types = ARMOR.map((slot) => worn(slot)?.type).filter(Boolean) as string[];
  const main = [...new Set(types)].sort((a, b) => types.filter((t) => t === b).length - types.filter((t) => t === a).length)[0];
  const liked: Record<string, (name: string) => number> = { neck: (name) => -Number(name === NECK[main]), ring: (name) => RINGS.indexOf(name) };
  for (const slot of JEWELRY) {
    const now = worn(slot);
    const order = (a: { name: string }, b: { name: string }) => liked[slot](a.name) - liked[slot](b.name);
    if (!now) {
      const pick = s.level >= RULES.jewelryLevel && offers(slot).sort(order)[0];
      if (pick) take(pick, `empty ${slot}`);
      continue;
    }
    if (!maxed(now)) continue;
    const fresh = stowed(slot).filter((g) => !maxed(g)).sort((a, b) => b.greatness - a.greatness)[0] ?? offers(slot, RULES.jewelryReserve * fullHeal).sort(order)[0];
    const best = stowed(slot).sort(order)[0];
    if (fresh) take(fresh, `${slot} maxed, level the next`);
    else if (best && order(best, now) < 0) take(best, `best ${slot}`);
  }
  return { actions: shape(s, [...drops, ...upgrades, ...equips, ...buys, { type: "explore" }]), why: why.join(", ") || "explore" };
}
