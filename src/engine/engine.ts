import { beastOf } from "../beast.ts";
import { SLOTS, STATS, encodePacket, type Action, type Adventurer, type Item, type Stats } from "../codec.ts";
import { greatness } from "../combat.ts";
import { basePrice, itemOf, levelOf, potionPrice, priceOf } from "../items.ts";
import { marketOf } from "../market.ts";
import type { Snapshot } from "../practice.ts";
import { MARKET } from "../settings.ts";
import { SUFFIX_GREATNESS, SUFFIXES, effectiveStats, suffixOf } from "../specials.ts";
import { beastHit, goldReward, obstacleHit, reduced, xpReward, yourHit, type Foe } from "./damage.ts";
import { beastRolls, crit, dodged, kindOf, rolls, round, salt, seeds, poseidon, type Seeds } from "./rolls.ts";
import { PREFIX_GREATNESS, specialsSeed } from "./specials.ts";

export const BASE_DAMAGE_REDUCTION = 35;
const BAG_SIZE = 15;
const MAX_ITEM_XP = 400;
const ARMOR_SLOTS = ["chest", "head", "waist", "foot", "hand"] as const;
const LOOT_BY_TIER = [
  [16, 12, 26, 31, 21, 36, 41, 76, 86, 81, 96, 91, 101, 46, 61, 66, 51, 71, 56],
  [45, 60, 65, 50, 55, 70, 75, 80, 85, 95, 100, 90, 20, 25, 30, 35, 40],
  [15, 11, 19, 24, 29, 34, 39, 44, 49, 64, 59, 69, 54, 74, 94, 99, 79, 84, 89],
  [10, 14, 18, 23, 28, 33, 38, 43, 53, 58, 63, 48, 68, 73, 78, 88, 83, 93, 98],
  [9, 13, 17, 22, 27, 32, 37, 42, 47, 52, 57, 67, 62, 72, 77, 82, 92, 97, 87],
];

export type Local = { adventurer: Adventurer; slots: Item[]; over: boolean };

export class Rejected extends Error {}

const reject = (reason: string): never => {
  throw new Rejected(reason);
};

export function fromSnapshot(s: Snapshot): Local {
  const slots = Array.from({ length: BAG_SIZE }, (_, i) => ({ ...(s.bag[i] ?? { id: 0, xp: 0 }) }));
  return { adventurer: structuredClone(s.adventurer), slots, over: s.over };
}

export const toSnapshot = (l: Local): Snapshot => ({ adventurer: l.adventurer, bag: l.slots.filter((i) => i.id !== 0).map((i) => ({ ...i })), over: l.over });

function decode(packet: bigint): Action[] {
  const count = Number((packet >> 240n) & 15n) + 1;
  const actions = Array.from({ length: count }, (_, i) => instruction(Number((packet >> BigInt(16 * i)) & 0xffffn)));
  if (encodePacket(actions) !== packet) reject("bh: invalid packet");
  return actions;
}

function instruction(word: number): Action {
  const arg = word >> 4;
  switch (word & 15) {
    case 1: return { type: "explore" };
    case 2: return { type: "attack", tillHealth: arg & 1023, spareBeast: (arg >> 10) as 0 | 1 | 2 };
    case 3: return { type: "flee", tillHealth: arg & 1023 };
    case 4: return { type: "upgrade", stat: STATS[arg & 7], amount: arg >> 3 };
    case 5: return { type: "buy", item: arg & 127, equip: arg >> 7 === 1 };
    case 6: return { type: "equip", item: arg };
    case 7: return { type: "drop", item: arg };
    case 9: return { type: "potions", qty: arg };
  }
  return reject("bh: invalid instruction");
}

const FAMILY: Record<Action["type"], string> = { upgrade: "upgrade", buy: "market", potions: "market", equip: "equip", drop: "drop", explore: "primary", attack: "primary", flee: "primary" };

function groups(actions: Action[]): Action[][] {
  const out: Action[][] = [];
  for (let i = 0; i < actions.length; ) {
    const family = FAMILY[actions[i].type];
    let j = i + 1;
    if (actions[i].type === "buy") {
      while (actions[j]?.type === "buy") j++;
      if (actions[j]?.type === "potions") j++;
    } else if (family !== "primary" && family !== "market") while (j < actions.length && FAMILY[actions[j].type] === family) j++;
    out.push(actions.slice(i, j));
    i = j;
  }
  for (const group of out) {
    const keys = group.flatMap((a) => (a.type === "upgrade" ? [`s${a.stat}`] : "item" in a ? [`${a.type}${a.item}`] : []));
    if (new Set(keys).size !== keys.length) reject("bh: duplicate instruction");
  }
  return out;
}

class Game {
  readonly a: Adventurer;
  readonly slots: Item[];
  readonly id: bigint;

  constructor(local: Local, gameId: string) {
    this.a = local.adventurer;
    this.slots = local.slots;
    this.id = BigInt(gameId);
  }

  stats(): Stats {
    return effectiveStats(this.a, this.slots, this.id);
  }

  maxHealth(): number {
    return Math.min(1023, 100 + 15 * this.stats().vitality);
  }

  heal(amount: number): void {
    this.a.health = Math.min(this.maxHealth(), this.a.health + amount);
  }

  hurt(amount: number): void {
    this.a.health = Math.max(0, this.a.health - amount);
  }

  addGold(amount: number): void {
    this.a.gold = Math.min(511, this.a.gold + amount);
  }

  addXp(amount: number): void {
    const before = levelOf(this.a.xp);
    this.a.xp = Math.min(32767, this.a.xp + amount);
    this.addPoints(levelOf(this.a.xp) - before);
  }

  addPoints(n: number): void {
    this.a.stat_upgrades_available = Math.min(15, this.a.stat_upgrades_available + n);
  }

  luck(): number {
    const { neck, ring } = this.a.equipment;
    const jewelry = (i: Item) => (i.id && ["neck", "ring"].includes(itemOf(i.id)!.slot) ? greatness(i) : 0);
    return greatness(neck) + greatness(ring) + (ring.id === 4 ? greatness(ring) : 0) + this.slots.reduce((n, i) => n + jewelry(i), 0);
  }

  owns(id: number): boolean {
    return Object.values(this.a.equipment).some((i) => i.id === id) || this.slots.some((i) => i.id === id);
  }

  bagFull(): boolean {
    return this.slots.every((i) => i.id !== 0);
  }

  toBag(item: Item): void {
    const slot = this.slots.find((i) => i.id === 0)!;
    slot.id = item.id;
    slot.xp = item.xp;
  }

  fromBag(id: number): Item | null {
    const slot = this.slots.find((i) => i.id === id);
    if (!slot) return null;
    const item = { ...slot };
    slot.id = 0;
    slot.xp = 0;
    return item;
  }

  equip(id: number): void {
    const item = this.fromBag(id) ?? { id, xp: 0 };
    const slot = itemOf(id)!.slot;
    if (this.a.equipment[slot].id !== 0) this.toBag(this.a.equipment[slot]);
    this.a.equipment[slot] = item;
  }

  foe(): Foe {
    const beast = beastOf(this.a, this.id)!;
    const special = beast.level >= PREFIX_GREATNESS;
    const r = special ? beastRolls(this.a.beast_salt, this.id, this.a.xp) : [];
    return { level: beast.level, tier: beast.tier, type: beast.type, prefix: special ? r[4] % 69 : null, suffix: special ? r[5] % 18 : null };
  }

  strike(foe: Foe, location: number, critRoll: number, reduction = 0): void {
    const armor = this.a.equipment[ARMOR_SLOTS[location % 5]];
    const hit = beastHit(this.a, foe, armor, this.id);
    const damage = crit(Math.min(levelOf(this.a.xp), 100), critRoll) ? hit.crit : hit.normal;
    this.hurt(reduction > 0 ? reduced(damage, reduction) : damage);
  }

  itemXp(amount: number, roll: number): void {
    for (const slot of SLOTS) {
      const item = this.a.equipment[slot];
      if (item.id === 0) continue;
      const before = greatness(item);
      item.xp = Math.min(MAX_ITEM_XP, item.xp + amount);
      const after = greatness(item);
      if (after <= before) continue;
      if (after === 20) this.addPoints(1);
      const suffix = before < SUFFIX_GREATNESS && after >= SUFFIX_GREATNESS;
      if (!suffix && !(before < PREFIX_GREATNESS && after >= PREFIX_GREATNESS)) continue;
      if (specialsSeed(this.a.item_specials_salt, this.id) === 0) this.a.item_specials_salt = roll & 16383 || 1;
      if (suffix) this.heal(15 * (SUFFIXES[suffixOf(item.id, this.a.item_specials_salt, this.id)].vitality ?? 0));
    }
  }

  levelSalt(start: number, s: Seeds): void {
    if (levelOf(this.a.xp) > start) this.a.level_salt = salt(s.market, 16383n);
  }

  explore(entropy: bigint): void {
    if (this.a.beast_health > 0) reject("in battle");
    if (this.a.stat_upgrades_available > 0) reject("upgrades pending");
    const s = seeds(entropy, this.id, this.a);
    const start = levelOf(this.a.xp);
    const r = rolls(poseidon(this.a.xp, s.action));
    const stats = this.stats();
    if (r[7] % 3 === 0) {
      this.a.beast_salt = salt(s.action, 131071n);
      const b = beastRolls(this.a.beast_salt, this.id, this.a.xp);
      this.a.beast_health = Math.min(1023, 1 + (b[2] % (start * 20)) + healthBonus(start));
      if (!dodged(stats.wisdom, start, r[6])) this.strike(this.foe(), r[4], r[5], BASE_DAMAGE_REDUCTION);
    } else if (r[7] % 3 === 1) {
      const id = kindOf(r[0]);
      const foe: Foe = { level: 1 + (r[3] % (start * 3)) + levelBonus(start), tier: Math.floor(((id - 1) % 25) / 5) + 1, type: id < 26 ? "Magic" : id < 51 ? "Blade" : "Bludgeon", prefix: null, suffix: null };
      const armor = this.a.equipment[ARMOR_SLOTS[r[4] % 5]];
      const damage = reduced(obstacleHit(foe, armor, this.a.equipment.neck, crit(Math.min(start, 100), r[5])), BASE_DAMAGE_REDUCTION);
      if (!dodged(stats.intelligence, start, r[6])) this.hurt(damage);
      if (this.a.health > 0) {
        const xp = xpReward(foe, start);
        this.addXp(xp);
        this.itemXp(xp, r[2]);
      }
    } else {
      this.discover(start, r[4], r[5], r[6]);
      this.addXp(1);
    }
    this.levelSalt(start, s);
  }

  discover(level: number, kind: number, amount: number, pick: number): void {
    const roll = Math.floor((kind * 100 + 127) / 255);
    if (roll < 45) return this.addGold((amount % level) + 1);
    if (roll < 90) return this.heal(((amount % level) + 1) * 2);
    const tier = Math.floor((amount * 100 + 127) / 255);
    const list = LOOT_BY_TIER[tier < 50 ? 0 : tier < 80 ? 1 : tier < 92 ? 2 : tier < 98 ? 3 : 4];
    const id = list[pick % list.length];
    const slot = itemOf(id)!.slot;
    if (this.owns(id) || (this.bagFull() && this.a.equipment[slot].id !== 0)) return this.addGold(basePrice(itemOf(id)!.tier));
    if (this.a.equipment[slot].id === 0) this.a.equipment[slot] = { id, xp: 0 };
    else this.toBag({ id, xp: 0 });
  }

  attack(entropy: bigint, tillHealth: number, spare: number): void {
    if (this.a.beast_health === 0) reject("not in battle");
    const s = seeds(entropy, this.id, this.a);
    const start = levelOf(this.a.xp);
    const foe = this.foe();
    const hit = yourHit(this.a, this.stats().strength, foe, this.id);
    const luck = this.luck();
    const surest = luck >= 100 ? hit.crit : hit.normal;
    const best = luck === 0 ? hit.normal : hit.crit;
    for (let n = 1; !(spare === 1 && this.a.beast_health <= surest) && !(spare === 2 && this.a.beast_health <= best); n++) {
      const r = round(this.a.xp, n, s.action);
      const damage = crit(luck, r.yourCrit) ? hit.crit : hit.normal;
      if (damage >= this.a.beast_health) {
        this.a.beast_health = 0;
        this.addGold(goldReward(foe, this.a.equipment.ring));
        const xp = xpReward(foe, levelOf(this.a.xp));
        this.addXp(xp);
        this.itemXp(xp * 2, Number(s.action & 65535n));
        break;
      }
      this.a.beast_health -= damage;
      this.strike(foe, r.location, r.beastCrit);
      if (this.a.health === 0 || this.a.health <= tillHealth) break;
    }
    this.levelSalt(start, s);
  }

  flee(entropy: bigint, tillHealth: number): void {
    if (this.a.beast_health === 0) reject("not in battle");
    const dexterity = this.stats().dexterity;
    if (dexterity === 0) reject("dexterity is zero");
    const s = seeds(entropy, this.id, this.a);
    const start = levelOf(this.a.xp);
    const foe = this.foe();
    for (let n = 1; ; n++) {
      const r = dexterity >= start ? null : round(this.a.xp, n, s.action);
      if (!r || dodged(dexterity, start, r.flee)) {
        this.a.beast_health = 0;
        this.addXp(1);
        break;
      }
      this.strike(foe, r.location, r.beastCrit);
      if (this.a.health === 0 || this.a.health <= tillHealth) break;
    }
    this.levelSalt(start, s);
  }

  market(group: Action[]): void {
    if (this.a.beast_health > 0) reject("in battle");
    if (this.a.stat_upgrades_available > 0) reject("market closed");
    const charisma = this.stats().charisma;
    const buys = group.filter((a) => a.type === "buy");
    const open = buys.length ? new Set(marketOf(this.a, this.id, MARKET).map((o) => o.id)) : new Set<number>();
    const pay = (price: number) => {
      if (this.a.gold < price) reject("not enough gold");
      this.a.gold -= price;
    };
    const later: number[] = [];
    for (const b of buys) {
      if (!open.has(b.item)) reject("item does not exist");
      pay(priceOf(b.item, charisma));
      if (b.equip) later.push(b.item);
      else {
        if (this.owns(b.item)) reject("item already owned");
        if (this.bagFull()) reject("bag is full");
        this.toBag({ id: b.item, xp: 0 });
      }
    }
    for (const id of later) {
      if (this.owns(id)) reject("item already owned");
      if (this.a.equipment[itemOf(id)!.slot].id !== 0 && this.bagFull()) reject("bag is full");
      this.equip(id);
    }
    const potions = group.find((a) => a.type === "potions");
    if (potions) {
      pay(potionPrice(levelOf(this.a.xp), this.stats().charisma) * potions.qty);
      if (this.a.health + 10 * potions.qty >= this.maxHealth() + 10) reject("health full");
      this.heal(10 * potions.qty);
    }
  }

  upgrade(group: Action[]): void {
    if (this.a.beast_health > 0) reject("in battle");
    if (this.a.stat_upgrades_available === 0) reject("no upgrades available");
    const add = Object.fromEntries(STATS.map((s) => [s, 0])) as Stats;
    for (const a of group) if (a.type === "upgrade") add[a.stat] += a.amount;
    const total = STATS.reduce((n, s) => n + add[s], 0);
    if (total > this.a.stat_upgrades_available) reject("insufficient stat upgrades");
    if (total < this.a.stat_upgrades_available) reject("must use all stats");
    if (STATS.some((s) => this.a.stats[s] + add[s] > 31)) reject("stat overflow");
    for (const s of STATS) this.a.stats[s] += add[s];
    this.a.stat_upgrades_available = 0;
    if (add.vitality > 0) this.heal(15 * add.vitality);
  }

  equipGroup(group: Action[], entropy: bigint): void {
    if (group.length > 8) reject("too many items");
    for (const a of group) {
      if (a.type !== "equip") continue;
      if (!this.slots.some((i) => i.id === a.item)) reject("Item not in bag");
      this.equip(a.item);
    }
    if (this.a.beast_health === 0) return;
    const r = round(this.a.xp, 0, seeds(entropy, this.id, this.a).action);
    this.strike(this.foe(), r.location, r.beastCrit);
  }

  drop(group: Action[]): void {
    if (this.a.beast_health > 0) reject("in battle");
    for (const a of group) {
      if (a.type !== "drop") continue;
      const slot = SLOTS.find((s) => this.a.equipment[s].id === a.item);
      if (slot) this.a.equipment[slot] = { id: 0, xp: 0 };
      else if (!this.fromBag(a.item)) reject("Item not owned by adventurer");
      this.a.health = Math.min(this.a.health, this.maxHealth());
    }
  }

  apply(group: Action[], entropy: bigint): void {
    const a = group[0];
    switch (a.type) {
      case "explore": return this.explore(entropy);
      case "attack": return this.attack(entropy, a.tillHealth ?? 0, a.spareBeast ?? 0);
      case "flee": return this.flee(entropy, a.tillHealth ?? 0);
      case "buy":
      case "potions": return this.market(group);
      case "upgrade": return this.upgrade(group);
      case "equip": return this.equipGroup(group, entropy);
      case "drop": return this.drop(group);
    }
  }
}

const levelBonus = (level: number): number => (level >= 50 ? 80 : level >= 40 ? 40 : level >= 30 ? 20 : level >= 20 ? 10 : 0);
const healthBonus = (level: number): number => (level >= 50 ? 500 : level >= 40 ? 400 : level >= 30 ? 200 : level >= 20 ? 100 : 10);

export function step(local: Local, gameId: string, packet: bigint, hash: string | bigint): Local {
  if (local.over) return local;
  const next = { adventurer: structuredClone(local.adventurer), slots: local.slots.map((i) => ({ ...i })), over: false };
  const game = new Game(next, gameId);
  for (const group of groups(decode(packet))) {
    game.apply(group, BigInt(hash));
    if (next.adventurer.health === 0) break;
  }
  next.over = next.adventurer.health === 0;
  return next;
}

export function replayLocal(start: Snapshot, gameId: string, packets: bigint[], hashes: (string | bigint)[]): Snapshot {
  return toSnapshot(packets.reduce((l, p, i) => step(l, gameId, p, hashes[i]), fromSnapshot(start)));
}
