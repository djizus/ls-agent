import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createTransactionReceipt } from "starknet";
import { included } from "./wallet.ts";

const receipt = (fields: object) => createTransactionReceipt({ type: "INVOKE", transaction_hash: "0x1", actual_fee: { amount: "0x0", unit: "FRI" }, finality_status: "PRE_CONFIRMED", messages_sent: [], events: [], execution_resources: { l1_gas: 0, l1_data_gas: 0, l2_gas: 0 }, execution_status: "SUCCEEDED", ...fields } as never);
const tick = async () => {};

test("a transaction whose receipt never shows a block fails once the wait is over", async () => {
  let reads = 0;
  const pending = async () => (reads++, receipt({}));
  await assert.rejects(included("0x1", pending, tick, 50), /transaction 0x1 not included within/);
  assert.ok(reads > 1);
});

test("a transaction is included once its receipt shows success in a block, and fails at once when reverted", async () => {
  const landed = receipt({ finality_status: "ACCEPTED_ON_L2", block_hash: "0xb", block_number: 7 });
  assert.deepEqual(await included("0x1", async () => landed, tick, 50), landed.value);
  await assert.rejects(included("0x1", async () => receipt({ execution_status: "REVERTED", revert_reason: "no", block_hash: "0xb", block_number: 7 }), tick, 60_000), /transaction 0x1 failed/);
});

test("no outside request leaves without the bound", () => {
  const src = new URL(".", import.meta.url).pathname;
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const found = (pattern: RegExp, allowed: string) => files.filter((f) => f !== allowed && pattern.test(readFileSync(src + f, "utf8")));
  assert.deepEqual(found(/\bfetch\(/, "net.ts"), []);
  assert.deepEqual(found(/new RpcProvider\(/, "wallet.ts"), []);
  assert.deepEqual(found(/waitForTransaction\(/, ""), []);
});
