import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

process.env.LS_VAR_DIR = `${mkdtempSync(`${tmpdir()}/ls-cycle-`)}/`;
const { CYCLE, bestBag } = await import("./cycle.ts");
const { bagRefusal } = await import("./live.ts");
const { STRK_FLOOR } = await import("./config.ts");

const HELD = ["0x3", "0x1c878b901144c4a000161c1", "0x100000000001e7e0000040000000006", "0x1c878ba01144c53000b1e41", "0x100000000001f050000040000000006", "0x1c878ba01144c5600057861", "0x100000000001e7e0000040000000006"];
const SURVIVOR = (n: number) => BigInt(n * 1e6) * 10n ** 12n;

test("the bag played is the one with the most named kills a game among the ranked bags the pool holds", () => {
  const rows = [{ bag: 7962, kills: 9 }, { bag: 7806, kills: 2 }, { bag: 7941, kills: 3 }, { bag: 7900 }];
  assert.deepEqual(bestBag(rows, HELD), { bag: 7941, kills: 3, n: 1 });
  assert.equal(bestBag([{ bag: 7962, kills: 9 }, { bag: 7900 }], HELD), undefined);
});

test("the cycle skips the bag with the purchase's own refusal when its price is over the 100 SURVIVOR cap or more than the wallet holds", () => {
  const held = ["0x0100000000001e7e00000400000000060000000001c878b901144c4a000161c1"];
  const entry = { bag: 7806, maxSurvivor: CYCLE.bagCapSurvivor };
  const quote = (price: number) => ({ price: SURVIVOR(price), protocolFee: 0n, royalty: 0n });
  assert.equal(bagRefusal(held, quote(100), entry, SURVIVOR(100)), null);
  assert.equal(bagRefusal(held, quote(100.5), entry, SURVIVOR(200)), "bag 7806 costs 100.5 SURVIVOR, over the 100 limit");
  assert.equal(bagRefusal(held, quote(84), entry, SURVIVOR(50)), "bag 7806 costs 84 SURVIVOR and the wallet holds 50");
  assert.equal(bagRefusal([], quote(84), entry, SURVIVOR(200)), "the pool holds no game of bag 7806");
});

test("README.md and AGENTS.md state the cycle's numbers and the spend floor as the code has them", () => {
  const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const said = {
    "README.md": [`${CYCLE.beastGames} Beast Mode games`, `costs ≤ ${CYCLE.bagCapSurvivor} SURVIVOR`, `never spends its last ${STRK_FLOOR} STRK`, `pays at most ${CYCLE.bagCapSurvivor}`],
    "AGENTS.md": [`Under ${STRK_FLOOR} STRK (\`STRK_FLOOR\``],
  };
  for (const [file, lines] of Object.entries(said)) for (const line of lines) assert.ok(read(file).includes(line), `${file}: ${line}`);
});
