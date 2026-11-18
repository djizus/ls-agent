import type { Action } from "./codec.ts";
import { beastHit, yourHit } from "./combat.ts";
import { potionPrice } from "./items.ts";
import { shape, type State } from "./play.ts";

export const RULES = { potionPrice: 1, dexPerLevel: 1, weaponTier: 2 };

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
  const actions: Action[] = [];
  const why: string[] = [];
  const stats = { ...s.stats };
  for (let i = 0; i < s.statUpgradesAvailable; i++) {
    const stat =
      potionPrice(s.level, stats.charisma) > RULES.potionPrice ? "charisma" : stats.dexterity < RULES.dexPerLevel * s.level ? "dexterity" : "vitality";
    stats[stat]++;
    const same = actions.find((a) => a.type === "upgrade" && a.stat === stat);
    if (same && same.type === "upgrade") same.amount++;
    else actions.push({ type: "upgrade", stat, amount: 1 });
  }
  for (const a of actions) if (a.type === "upgrade") why.push(`+${a.amount} ${a.stat.slice(0, 3).toUpperCase()}`);
  let gold = s.gold;
  const price = (m: State["market"][number]) => Math.max(1, m.price - (stats.charisma - s.stats.charisma));
  const owned = new Set([...s.equipment, ...s.bag].map((g) => g.id));
  const buy = (m: State["market"][number], reason: string) => {
    actions.push({ type: "buy", item: m.id, equip: true });
    gold -= price(m);
    why.push(`${m.name} (${reason})`);
  };
  const offers = (slot: string) => s.market.filter((m) => m.slot === slot && !owned.has(m.id) && price(m) <= gold);
  const weapon = offers("weapon").filter((m) => m.tier <= RULES.weaponTier && m.tier < (worn("weapon")?.tier ?? 6)).sort((a, b) => a.tier - b.tier)[0];
  if (weapon) buy(weapon, `T${weapon.tier} weapon`);
  for (const slot of ARMOR) {
    if (worn(slot)) continue;
    const cheapest = offers(slot).sort((a, b) => price(a) - price(b))[0];
    if (cheapest) buy(cheapest, `empty ${slot}`);
  }
  return { actions: shape(s, [...actions, { type: "explore" }]), why: why.join(", ") || "explore" };
}
