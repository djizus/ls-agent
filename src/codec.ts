import { z } from "zod";
export type Item = { id: number; xp: number };
export type Stats = { strength: number; dexterity: number; vitality: number; intelligence: number; wisdom: number; charisma: number };
export type Adventurer = {
  health: number;
  xp: number;
  gold: number;
  beast_health: number;
  stat_upgrades_available: number;
  stats: Stats;
  equipment: Record<(typeof SLOTS)[number], Item>;
  item_specials_salt: number;
  beast_salt: number;
  level_salt: number;
};

export const SLOTS = ["weapon", "chest", "head", "waist", "foot", "hand", "neck", "ring"] as const;
export const STATS = ["strength", "dexterity", "vitality", "intelligence", "wisdom", "charisma"] as const;

export const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("explore"), tillDamage: z.number().int().min(0).max(2047).optional(), tillGold: z.number().int().min(0).max(511).optional() }),
  z.object({ type: z.literal("attack"), tillHealth: z.number().int().min(0).max(1023).optional(), spareBeast: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional() }),
  z.object({ type: z.literal("flee"), tillHealth: z.number().int().min(0).max(1023).optional() }),
  z.object({ type: z.literal("upgrade"), stat: z.enum(STATS), amount: z.number().int().min(1).max(15) }),
  z.object({ type: z.literal("buy"), item: z.number().int().min(1).max(101), equip: z.boolean() }),
  z.object({ type: z.literal("equip"), item: z.number().int().min(1).max(101) }),
  z.object({ type: z.literal("drop"), item: z.number().int().min(1).max(101) }),
  z.object({ type: z.literal("potions"), qty: z.number().int().min(1).max(255) }),
]);
export const actions = z.array(action).min(1).max(15);
export type Action = z.infer<typeof action>;

const item = (v: bigint): Item => ({ id: Number(v & 127n), xp: Number(v >> 7n) });

export function decodeAdventurer(packed: bigint): Adventurer {
  let low = packed & ((1n << 128n) - 1n);
  const gear: Item[] = [];
  for (const _ of SLOTS) {
    gear.push(item(low & 0xffffn));
    low >>= 16n;
  }
  let rest = packed >> 128n;
  const take = (bits: bigint) => {
    const v = Number(rest & ((1n << bits) - 1n));
    rest >>= bits;
    return v;
  };
  const health = take(10n), xp = take(15n), gold = take(9n), beast_health = take(10n), stat_upgrades_available = take(4n);
  const stats = Object.fromEntries(STATS.map((s) => [s, take(5n)])) as Stats;
  return {
    health, xp, gold, beast_health, stat_upgrades_available, stats,
    equipment: Object.fromEntries(SLOTS.map((s, i) => [s, gear[i]])) as Adventurer["equipment"],
    item_specials_salt: take(14n),
    beast_salt: take(17n),
    level_salt: take(14n),
  };
}

export function decodeBag(packed: bigint): Item[] {
  const bag: Item[] = [];
  for (let i = 0; i < 15; i++) bag.push(item((packed >> BigInt(16 * i)) & 0xffffn));
  return bag.filter((b) => b.id !== 0);
}

function word(a: Action): number {
  switch (a.type) {
    case "explore": return 1 | ((a.tillDamage ?? 0) << 4) | ((a.tillGold ?? 0) << 15);
    case "attack": return 2 | ((a.tillHealth ?? 0) << 4) | ((a.spareBeast ?? 0) << 14);
    case "flee": return 3 | ((a.tillHealth ?? 0) << 4);
    case "upgrade": return 4 | (STATS.indexOf(a.stat) << 4) | (a.amount << 7);
    case "buy": return 5 | (a.item << 4) | (Number(a.equip) << 11);
    case "equip": return 6 | (a.item << 4);
    case "drop": return 7 | (a.item << 4);
    case "potions": return 9 | (a.qty << 4);
  }
}

export function encodePacket(actions: Action[]): bigint {
  if (actions.length < 1 || actions.length > 15) throw new Error("a packet holds 1 to 15 actions");
  let packet = BigInt(actions.length - 1) << 240n;
  actions.forEach((a, i) => (packet |= BigInt(word(a)) << BigInt(16 * i)));
  return packet;
}
