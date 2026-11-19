import { poseidon as felt } from "../hash.ts";
import { cached } from "../cache.ts";
import type { Adventurer } from "../codec.ts";

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;

export const poseidon = (...values: (bigint | number | string)[]): bigint => felt(values.map((v) => BigInt(v)));

export function rolls(value: bigint): number[] {
  const t = value & U128;
  return [t >> 96n, (t >> 64n) & 0xffffffffn, (t >> 48n) & 0xffffn, (t >> 32n) & 0xffffn, (t >> 24n) & 0xffn, (t >> 16n) & 0xffn, (t >> 8n) & 0xffn, t & 0xffn].map(Number);
}

export type Seeds = { action: bigint; market: bigint };

export function seeds(entropy: bigint, gameId: bigint, adventurer: Adventurer): Seeds {
  const { xp, health, beast_health } = adventurer;
  const inner = beast_health > 0 ? poseidon(xp, gameId, health) : poseidon(xp, gameId);
  const t = poseidon(entropy, inner) & U128;
  return { action: t >> 64n, market: t & U64 };
}

export type Round = { flee: number; yourCrit: number; beastCrit: number; location: number };

export function round(xp: number, n: number, seed: bigint): Round {
  const r = Number(poseidon(xp, seed, n) & 0xffffffffn);
  return { flee: r >>> 24, yourCrit: (r >>> 16) & 255, beastCrit: (r >>> 8) & 255, location: r & 255 };
}

export const salt = (seed: bigint, mask: bigint): number => Number(seed & mask) || 1;

export const beastRolls = (beastSalt: number, gameId: bigint, xp: number): number[] =>
  cached(`beast:${beastSalt}:${gameId}:${xp}`, () => rolls(poseidon(xp, poseidon(beastSalt, gameId, xp) & U64)));

export const kindOf = (roll: number): number => (roll % 15) * 5 + (Math.floor(roll / 15) % 5) + 1;

export const crit = (chance: number, roll: number): boolean => chance * 256 > 100 * roll;

export const dodged = (stat: number, level: number, roll: number): boolean => stat >= level || stat > Math.floor((level * roll) / 255);
