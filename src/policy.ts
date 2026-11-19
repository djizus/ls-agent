import type { Action } from "./codec.ts";
import { beastHit, yourHit } from "./combat.ts";
import { potionPrice } from "./items.ts";
import { shape, type State } from "./play.ts";

export const RULES = { potionPrice: 1, dexPerLevel: 1, weaponTier: 2, jewelryLevel: 12 };

const RINGS = ["Titanium Ring", "Silver Ring", "Gold Ring", "Platinum Ring", "Bronze Ring"];

const NECK: Record<string, string> = { Cloth: "Amulet", Hide: "Pendant", Metal: "Necklace" };

const MAX_GREATNESS = 20;
const MAX_STAT = 31;
const MAX_DROPS = 3;
const FALLBACK = ["vitality", "strength", "dexterity", "charisma", "intelligence", "wisdom"] as const;
const ARMOR = ["chest", "head", "waist", "foot", "hand"];

export type Plan = { actions: Action[]; why: string };

export function plan(s: State): Plan {
  const worn = (slot: string) => s.equipment.find((g) => g.slot === slot);
  if (s.beast) {
    const toKill = Math.ceil(s.beast.health / yourHit(worn("weapon"), s.stats, s.beast).normal);
    const taken = ARMOR.reduce((sum, slot) => sum + beastHit(s.beast!, worn(slot)).normal, 0) / ARMOR.length;
    const toDie = Math.ceil(s.health / taken);
    const fight = toKill < toDie || s.stats.dexterity === 0;
    return { actions: [{ type: fight ? "attack" : "flee" }], why: `${toKill} blows to kill it, ${toDie} to die: ${fight ? "fight" : "flee"}` };
  }
  const kept = (g: State["bag"][number]) => g.bonus?.vitality || g.bonus?.charisma || g.slot === "neck" || g.slot === "ring";
  const useless = s.bag.filter((g) => !kept(g)).slice(0, MAX_DROPS);
  const actions: Action[] = useless.map((g) => ({ type: "drop", item: g.id }));
  const why: string[] = useless.map((g) => `drop ${g.name}`);
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
    const same = actions.find((a) => a.type === "upgrade" && a.stat === stat);
    if (same && same.type === "upgrade") same.amount++;
    else actions.push({ type: "upgrade", stat, amount: 1 });
  }
  for (const a of actions) if (a.type === "upgrade") why.push(`+${a.amount} ${a.stat.slice(0, 3).toUpperCase()}`);
  let gold = s.gold;
  const price = (m: State["market"][number]) => Math.max(1, m.price - (stats.charisma - s.stats.charisma));
  const owned = new Set([...s.equipment, ...s.bag].map((g) => g.id));
  const buy = (m: State["market"][number], reason: string, equip = true) => {
    actions.push({ type: "buy", item: m.id, equip });
    owned.add(m.id);
    gold -= price(m);
    why.push(`${m.name} (${reason})`);
  };
  const offers = (slot: string) => s.market.filter((m) => m.slot === slot && !owned.has(m.id) && price(m) <= gold);
  const weapon = offers("weapon").filter((m) => m.tier <= RULES.weaponTier && m.tier < (worn("weapon")?.tier ?? 6)).sort((a, b) => a.tier - b.tier)[0];
  if (weapon) buy(weapon, `T${weapon.tier} weapon`);
  for (const slot of ARMOR) {
    const now = worn(slot);
    if (now && (now.greatness < MAX_GREATNESS || now.tier === 1)) continue;
    const pick = offers(slot).filter((m) => !now || m.tier < now.tier).sort((a, b) => (now ? a.tier - b.tier : 0) || price(a) - price(b))[0];
    if (pick) buy(pick, now ? `${slot} maxed, T${pick.tier} next` : `empty ${slot}`);
  }
  if (s.level >= RULES.jewelryLevel) {
    const types = ARMOR.map((slot) => worn(slot)?.type).filter(Boolean) as string[];
    const main = [...new Set(types)].sort((a, b) => types.filter((t) => t === b).length - types.filter((t) => t === a).length)[0];
    const neck = !worn("neck") && offers("neck").sort((a, b) => Number(b.name === NECK[main]) - Number(a.name === NECK[main]))[0];
    if (neck) buy(neck, "empty neck");
    const ring = !worn("ring") && offers("ring").sort((a, b) => RINGS.indexOf(a.name) - RINGS.indexOf(b.name))[0];
    if (ring) buy(ring, "empty ring");
  }
  return { actions: shape(s, [...actions, { type: "explore" }]), why: why.join(", ") || "explore" };
}
