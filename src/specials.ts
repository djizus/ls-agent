import { hash } from "starknet";
import type { Adventurer, Item, Stats } from "./codec.ts";
import { itemOf, levelOf, type Slot } from "./items.ts";

export const SUFFIX_GREATNESS = 15;

export const SUFFIXES: Record<string, Partial<Stats>> = {
  "of Power": { strength: 3 },
  "of Giant": { vitality: 3 },
  "of Titans": { strength: 2, charisma: 1 },
  "of Skill": { dexterity: 3 },
  "of Perfection": { strength: 1, dexterity: 1, vitality: 1 },
  "of Brilliance": { intelligence: 3 },
  "of Enlightenment": { wisdom: 3 },
  "of Protection": { vitality: 2, dexterity: 1 },
  "of Anger": { strength: 2, dexterity: 1 },
  "of Rage": { strength: 1, charisma: 1, wisdom: 1 },
  "of Fury": { vitality: 1, charisma: 1, intelligence: 1 },
  "of Vitriol": { intelligence: 2, wisdom: 1 },
  "of the Fox": { dexterity: 2, charisma: 1 },
  "of Detection": { wisdom: 2, dexterity: 1 },
  "of Reflection": { intelligence: 1, wisdom: 2 },
  "of the Twins": { charisma: 3 },
};

const NAMES = Object.keys(SUFFIXES);
export const BAG_STATS: (keyof Stats)[] = ["vitality", "charisma"];

const SLOT_ORDER: Record<Slot, number[]> = {
  weapon: [72, 73, 74, 75, 76, 42, 43, 44, 45, 46, 9, 10, 11, 12, 13, 14, 15, 16],
  chest: [17, 18, 19, 20, 21, 47, 48, 49, 50, 51, 77, 78, 79, 80, 81],
  head: [82, 83, 84, 85, 86, 52, 53, 54, 55, 56, 22, 23, 24, 25, 26],
  waist: [87, 88, 89, 90, 91, 57, 58, 59, 60, 61, 27, 28, 29, 30, 31],
  foot: [92, 93, 94, 95, 96, 62, 63, 64, 65, 66, 32, 33, 34, 35, 36],
  hand: [97, 98, 99, 100, 101, 67, 68, 69, 70, 71, 37, 38, 39, 40, 41],
  neck: [2, 3, 1],
  ring: [8, 4, 5, 6, 7],
};

const PIN_SLOTS: Slot[] = ["weapon", "chest", "head", "waist", "foot", "hand", "neck", "ring"];
const pins = new Map<bigint, bigint>();

export const pinSpecials = (gameId: bigint | string, packed: bigint | string): void => void pins.set(BigInt(gameId), BigInt(packed));

export function pinned(itemId: number, gameId: bigint | string): { suffix: number; prefix: number; second: number } | undefined {
  const packed = pins.get(BigInt(gameId));
  const slot = BigInt(PIN_SLOTS.indexOf(itemOf(itemId)!.slot));
  if (!packed || Number((packed >> (136n + 8n * slot)) & 255n) !== itemId) return undefined;
  const bits = (packed >> (17n * slot)) & 131071n;
  return { suffix: Number(bits & 31n) - 1, prefix: Number((bits >> 5n) & 127n) - 1, second: Number((bits >> 12n) & 31n) - 1 };
}

export function suffixOf(itemId: number, salt: number, gameId: bigint | string): string {
  const pin = pinned(itemId, gameId);
  if (pin) return NAMES[pin.suffix];
  const seed = Number(BigInt(hash.computePoseidonHashOnElements([BigInt(salt), BigInt(gameId)])) % 65536n);
  const order = SLOT_ORDER[itemOf(itemId)!.slot];
  const entropy = seed + itemId > 65535 ? seed - itemId : seed + itemId;
  return NAMES[((entropy % 101) * order.length + order.indexOf(itemId)) % NAMES.length];
}

export function effectiveStats(adventurer: Adventurer, bag: Item[], gameId: bigint | string): Stats {
  const stats = { ...adventurer.stats };
  const salt = adventurer.item_specials_salt;
  const boost = (item: Item, only?: (keyof Stats)[]) => {
    if (item.id === 0 || levelOf(item.xp) < SUFFIX_GREATNESS || (!salt && !pinned(item.id, gameId))) return;
    for (const [stat, n] of Object.entries(SUFFIXES[suffixOf(item.id, salt, gameId)]) as [keyof Stats, number][])
      if (!only || only.includes(stat)) stats[stat] += n;
  };
  Object.values(adventurer.equipment).forEach((item) => boost(item));
  bag.forEach((item) => boost(item, BAG_STATS));
  return stats;
}
