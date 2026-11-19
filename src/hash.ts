import { createHash } from "node:crypto";
import { hash } from "starknet";

let fast = false;

export const useFastLuck = (): void => void (fast = true);

export function poseidon(values: bigint[]): bigint {
  if (!fast) return BigInt(hash.computePoseidonHashOnElements(values));
  return BigInt("0x" + createHash("sha256").update(values.join()).digest("hex")) >> 5n;
}
