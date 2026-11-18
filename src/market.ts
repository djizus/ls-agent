import { ec } from "starknet";
import type { Adventurer } from "./codec.ts";
import { ITEMS, priceOf } from "./items.ts";

export type MarketConfig = { pair01: bigint; pair23: bigint; pair4_enabled: bigint };
export type Offer = { id: number; price: number };

export const BEAST_MODE_MARKET: MarketConfig = {
  pair01: 0n,
  pair23: 0x3ffffffffffffffffffffffffe0000000000000000000000000n,
  pair4_enabled: 0x3ffffffffffffffffffffffffffffffffffffffffffffffffffn,
};

const ALL = (1n << 101n) - 1n;
const MARKET_SALT = BigInt("0x" + Buffer.from("MARKET").toString("hex"));

export function marketOf(adventurer: Adventurer, gameId: bigint | string, config = BEAST_MODE_MARKET): Offer[] {
  const masks = [config.pair01, config.pair23, config.pair4_enabled].flatMap((f) => [f & ALL, (f >> 101n) & ALL]);
  const [h0, h1, h2] = ec.starkCurve.poseidonSmall([BigInt(adventurer.level_salt), BigInt(gameId), MARKET_SALT]);
  const rolls = [h2, h1 >> 128n, h1, h0 >> 128n, h0];
  let open = ALL;
  rolls.forEach((roll, bit) => (open = (roll & ~masks[bit]) | ((roll | ~masks[bit]) & open)));
  open &= masks[5];
  return ITEMS.filter((item) => (open >> BigInt(item.id - 1)) & 1n).map((item) => ({
    id: item.id,
    price: priceOf(item.id, adventurer.stats.charisma),
  }));
}
