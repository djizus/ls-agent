import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

process.env.LS_VAR_DIR = `${mkdtempSync(`${tmpdir()}/ls-loop-`)}/`;
const { LOOP, bestBag, nextStep } = await import("./loop.ts");
const { bagRefusal } = await import("./live.ts");
const { STRK_FLOOR } = await import("./config.ts");

const HELD = ["0x3", "0x1c878b901144c4a000161c1", "0x100000000001e7e0000040000000006", "0x1c878ba01144c53000b1e41", "0x100000000001f050000040000000006", "0x1c878ba01144c5600057861", "0x100000000001e7e0000040000000006"];
const SURVIVOR = (n: number) => BigInt(n * 1e6) * 10n ** 12n;

test("the loop waits under the floor plus a round's reserve, plays the Beast Mode games left to 80, then one Loot Dungeon game, and resumes an unfinished one first", () => {
  assert.equal(LOOP.beastGames, 80);
  assert.deepEqual(nextStep(29.9, 0, false), { kind: "wait", need: 30 });
  assert.deepEqual(nextStep(10, 80, true), { kind: "wait", need: 30 });
  assert.deepEqual(nextStep(30, 0, false), { kind: "beast", games: 80 });
  assert.deepEqual(nextStep(30, 79, false), { kind: "beast", games: 1 });
  assert.deepEqual(nextStep(30, 80, false), { kind: "loot" });
  assert.deepEqual(nextStep(30, 3, true), { kind: "loot" });
});

test("the bag played is the one with the most named kills a game among the ranked bags the pool holds", () => {
  const rows = [{ bag: 7962, kills: 9 }, { bag: 7806, kills: 2 }, { bag: 7941, kills: 3 }, { bag: 7900 }];
  assert.deepEqual(bestBag(rows, HELD), { bag: 7941, kills: 3, n: 1 });
  assert.equal(bestBag([{ bag: 7962, kills: 9 }, { bag: 7900 }], HELD), undefined);
});

test("the loop skips the bag with the purchase's own refusal when its price is over the 100 SURVIVOR cap or more than the wallet holds", () => {
  const held = ["0x0100000000001e7e00000400000000060000000001c878b901144c4a000161c1"];
  const entry = { bag: 7806, maxSurvivor: LOOP.bagCapSurvivor };
  const quote = (price: number) => ({ price: SURVIVOR(price), protocolFee: 0n, royalty: 0n });
  assert.equal(bagRefusal(held, quote(100), entry, SURVIVOR(100)), null);
  assert.equal(bagRefusal(held, quote(100.5), entry, SURVIVOR(200)), "bag 7806 costs 100.5 SURVIVOR, over the 100 limit");
  assert.equal(bagRefusal(held, quote(84), entry, SURVIVOR(50)), "bag 7806 costs 84 SURVIVOR and the wallet holds 50");
  assert.equal(bagRefusal([], quote(84), entry, SURVIVOR(200)), "the pool holds no game of bag 7806");
});

test("the README states the loop's numbers and the spend floor as the code has them", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = (name: string) => readme.split("\n").find((line) => line.startsWith(`| ${name} |`)) ?? "";
  const loop = row("The loop");
  for (const said of [`${LOOP.beastGames} Beast Mode games`, `at most ${LOOP.bagCapSurvivor} SURVIVOR`, `Under ${STRK_FLOOR + LOOP.reserveStrk} STRK (the floor plus ${LOOP.reserveStrk}`, `every ${LOOP.recheckMs / 60_000} minutes`]) assert.ok(loop.includes(said), said);
  assert.ok(row("Spend floor").startsWith(`| Spend floor | ${STRK_FLOOR} STRK, \`STRK_FLOOR\``));
  assert.ok(readme.includes(`while the balance is under ${STRK_FLOOR} STRK`));
});
