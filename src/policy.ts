import type { Action } from "./codec.ts";
import { potionPrice } from "./items.ts";
import { shape, type State } from "./play.ts";

export const RULES = { potionPrice: 1, dexPerLevel: 0.9, weaponCatchUp: 5, jewelryLevel: 8, jewelryReserve: 2, armorReserve: 0.5, fightRisk: 0.35, swapGain: 0.05, weaponReserve: 3 };

const RINGS = ["Titanium Ring", "Silver Ring", "Gold Ring", "Platinum Ring", "Bronze Ring"];

const NECK: Record<string, string> = { Cloth: "Amulet", Hide: "Pendant", Metal: "Necklace" };

const MAX_GREATNESS = 20;
const MAX_STAT = 31;
const MAX_ROUNDS = 30;
const MAX_ACTIONS = 15;
const KEPT = 9;
const STRONG: Record<string, string> = { Magic: "Metal", Blade: "Cloth", Bludgeon: "Hide" };
const WEAK: Record<string, string> = { Magic: "Hide", Blade: "Metal", Bludgeon: "Cloth" };
const SURE = 0.999999;
const BAG_SIZE = 15;
const FALLBACK = ["vitality", "strength", "dexterity", "charisma", "intelligence", "wisdom"] as const;
const ARMOR = ["chest", "head", "waist", "foot", "hand"];
const JEWELRY = ["neck", "ring"];

export type Plan = { actions: Action[]; why: string };
type Gear = State["bag"][number];
type Offer = State["market"][number];

const maxed = (g: Gear) => g.greatness >= MAX_GREATNESS;

type Blow = { damage: number; chance: number };

function odds(mine: Blow[], theirs: Blow[], flee: number) {
  const merged = new Map<number, number>();
  for (const x of theirs) merged.set(x.damage, (merged.get(x.damage) ?? 0) + x.chance);
  const strikes = [...merged].map(([damage, chance]) => ({ damage, chance }));
  const reach = Math.max(...mine.map((m) => m.damage)) * MAX_ROUNDS;
  const won = new Map<number, number>();
  const fight = (h: number, b: number, left: number): number => {
    if (left === 0) return 0;
    const key = h * 2048 + b;
    const known = won.get(key);
    if (known !== undefined) return known;
    let win = 0;
    for (const m of mine) {
      if (m.damage >= b) win += m.chance;
      else for (const x of strikes) if (x.damage < h) win += m.chance * x.chance * fight(h - x.damage, b - m.damage, left - 1);
    }
    won.set(key, win);
    return win;
  };
  const fled = new Map<number, number>();
  const run = (h: number): number => {
    const known = fled.get(h);
    if (known !== undefined) return known;
    let out = flee;
    for (const x of strikes) if (x.damage < h) out += (1 - flee) * x.chance * run(h - x.damage);
    fled.set(h, out);
    return out;
  };
  return {
    strikes,
    win: (health: number, beast: number) => (reach < beast ? 0 : fight(health, beast, MAX_ROUNDS)),
    escape: (health: number) => (flee <= 0 || flee >= 1 ? Math.max(0, Math.min(1, flee)) : run(health)),
  };
}

export function plan(s: State): Plan {
  const worn = (slot: string) => s.equipment.find((g) => g.slot === slot);
  if (s.beast && s.hits) {
    const lucky = Math.min(100, s.luck) / 100;
    const crit = Math.min(100, s.level) / 100;
    const mine = [{ damage: s.hits.yours.normal, chance: 1 - lucky }, { damage: s.hits.yours.crit, chance: lucky }];
    const blows = (hits: { normal: number; crit: number }[]) => hits.flatMap((h) => [{ damage: h.normal, chance: (1 - crit) / ARMOR.length }, { damage: h.crit, chance: crit / ARMOR.length }]);
    const theirs = blows(s.hits.theirs);
    const flee = s.stats.dexterity >= s.level ? 1 : s.stats.dexterity / s.level;
    const asWorn = odds(mine, theirs, flee);
    const win = asWorn.win(s.health, s.beast.health);
    const escape = asWorn.escape(s.health);
    const fight = win + RULES.fightRisk >= escape;
    const pct = (n: number) => `${Math.round(100 * n)}%`;
    const spare = (slot: string, i: number) =>
      s.bag
        .filter((g) => g.slot === slot)
        .map((g) => ({ g, hit: s.hits!.spare.find((x) => x.id === g.id)!.hit }))
        .filter((x) => x.hit.normal < s.hits!.theirs[i].normal)
        .sort((a, b) => a.hit.normal - b.hit.normal)[0];
    const better = ARMOR.map(spare);
    const arms = s.bag
      .filter((g) => g.slot === "weapon" && g.tier === 1)
      .map((g) => ({ g, hit: s.hits!.arms.find((x) => x.id === g.id)!.hit }))
      .filter((x) => x.hit.normal > s.hits!.yours.normal);
    if (win < SURE && (better.some(Boolean) || arms.length)) {
      const armor = better.flatMap((x) => (x ? [x.g] : []));
      const sets = [{ gear: [] as Gear[], hits: theirs }, ...(armor.length ? [{ gear: armor, hits: blows(ARMOR.map((_, i) => better[i]?.hit ?? s.hits!.theirs[i])) }] : [])];
      const blades = [{ gear: [] as Gear[], hits: mine }, ...arms.map((x) => ({ gear: [x.g], hits: [{ damage: x.hit.normal, chance: 1 - lucky }, { damage: x.hit.crit, chance: lucky }] }))];
      const options = blades
        .flatMap((blade) => sets.map((set) => ({ gear: [...blade.gear, ...set.gear], blade: blade.hits, set: set.hits })))
        .filter((o) => o.gear.length)
        .map((o) => {
          const after = odds(o.blade, o.set, flee);
          return { gear: o.gear, value: after.strikes.reduce((sum, x) => sum + (x.damage < s.health ? x.chance * Math.max(after.win(s.health - x.damage, s.beast!.health) + RULES.fightRisk, after.escape(s.health - x.damage)) : 0), 0) };
        })
        .sort((a, b) => b.value - a.value);
      if (options[0].value > Math.max(win + RULES.fightRisk, escape) + RULES.swapGain) return { actions: options[0].gear.map((g) => ({ type: "equip" as const, item: g.id })), why: `${pct(win)} to win as equipped, better with ${options[0].gear.map((g) => g.name).join(", ")}` };
    }
    const attack: Action = win > SURE ? { type: "attack" } : { type: "attack", tillHealth: s.health - 1 };
    return { actions: [fight ? attack : { type: "flee" }], why: `${pct(win)} to win the fight, ${pct(escape)} to escape: ${fight ? "fight" : "flee"}` };
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
  const real = (slot: string): Gear | undefined => {
    const mine = [...s.equipment, ...s.bag].filter((g) => g.slot === slot);
    const done = mine.filter(maxed);
    if (!done.length) return mine.sort((a, b) => b.greatness - a.greatness)[0];
    const cap = Math.min(...done.map((g) => g.tier));
    const top = done.filter((g) => g.tier === cap);
    return mine.filter((g) => g.tier < cap).sort((a, b) => b.greatness - a.greatness)[0] ?? top.find((g) => g === worn(slot)) ?? top[0];
  };
  const use = (g: Gear) => (g.slot === "weapon" && g.tier === 1 ? KEPT : JEWELRY.includes(g.slot) ? 2 : g === real(g.slot) ? KEPT : maxed(g) || g.tier < (real(g.slot)?.tier ?? 6) ? 1 : 0);
  const makeRoom = () => {
    if (room > 0) return true;
    const stash = (g: Gear) => (g.bonus?.vitality ?? 0) + (g.bonus?.charisma ?? 0);
    const out = bag.filter((g) => stash(g) <= 1 && use(g) < KEPT && !(buys.length && g.bonus?.charisma)).sort((a, b) => use(a) + stash(a) - use(b) - stash(b) || b.tier - a.tier || a.greatness - b.greatness)[0];
    if (!out) return false;
    bag.splice(bag.indexOf(out), 1);
    drops.push({ type: "drop", item: out.id });
    stats.charisma -= out.bonus?.charisma ?? 0;
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
  const next = (slot: string, tier: number, reserve = 0): Gear | Offer | undefined => [...stowed(slot), ...offers(slot, reserve)].filter((c) => c.tier < tier).sort((a, b) => a.tier - b.tier)[0];

  const weapon = worn("weapon");
  const finest = [...s.equipment, ...s.bag].filter((g) => g.slot === "weapon" && g.tier === 1);
  const first = finest.find(maxed);
  if (first) {
    const learning = finest.filter((g) => !maxed(g)).sort((a, b) => b.greatness - a.greatness)[0];
    const counter = Object.keys(STRONG).find((type) => STRONG[type] === WEAK[first.type]);
    const fresh = offers("weapon", RULES.weaponReserve * fullHeal)
      .filter((m) => m.tier === 1 && !finest.some((g) => g.type === m.type))
      .sort((a, b) => Number(b.type === counter) - Number(a.type === counter))[0];
    if (learning && learning !== weapon && bag.includes(learning)) take(learning, "weapon to level");
    else if (!learning && fresh && makeRoom()) {
      room--;
      buys.push({ type: "buy", item: fresh.id, equip: false });
      owned.add(fresh.id);
      gold -= price(fresh);
      why.push(`${fresh.name} (another weapon type to level)`);
    }
  } else {
    const blade = next("weapon", Math.min(2, weapon?.tier ?? 6));
    if (blade && (!weapon || maxed(weapon) || weapon.greatness * (6 - weapon.tier) <= RULES.weaponCatchUp * (6 - blade.tier))) take(blade, "T1 weapon");
  }
  for (const slot of ARMOR) {
    const now = real(slot);
    const pick = now ? (maxed(now) ? next(slot, now.tier, RULES.armorReserve * fullHeal) : undefined) : offers(slot).sort((a, b) => price(a) - price(b))[0];
    if (pick) take(pick, now ? `${slot} maxed, T${pick.tier} next` : `empty ${slot}`);
    else if (now && now !== worn(slot) && bag.includes(now)) take(now, `${slot} back on`);
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
  const packet = () => shape(s, [...drops, ...upgrades, ...equips, ...buys, { type: "explore" }]);
  while (packet().length > MAX_ACTIONS) (buys.length ? buys : equips).pop();
  return { actions: packet(), why: why.join(", ") || "explore" };
}
