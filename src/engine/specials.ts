import type { Item } from "../codec.ts";
import { greatness } from "../combat.ts";
import { itemOf, type Slot } from "../items.ts";
import { pinned } from "../specials.ts";
import { poseidon } from "./rolls.ts";

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

export const PREFIX_GREATNESS = 19;

export const specialsSeed = (salt: number, gameId: bigint): number => (salt === 0 ? 0 : Number(poseidon(salt, gameId) % 65536n));

export function specialsOf(item: Item, salt: number, gameId: bigint): { prefix: number; suffix: number } | null {
  if (!item.id || greatness(item) < PREFIX_GREATNESS) return null;
  const pin = pinned(item.id, gameId);
  if (pin) return { prefix: pin.prefix, suffix: pin.second };
  const seed = specialsSeed(salt, gameId);
  const order = SLOT_ORDER[itemOf(item.id)!.slot];
  const entropy = seed + item.id > 65535 ? seed - item.id : seed + item.id;
  const index = (entropy % 101) * order.length + order.indexOf(item.id);
  return { prefix: index % 69, suffix: index % 18 };
}
