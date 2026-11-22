import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

process.env.LS_VAR_DIR = `${mkdtempSync(`${tmpdir()}/ls-loop-`)}/`;
const { LOOP, beastSince, bestBag, nextStep } = await import("./loop.ts");
const { db } = await import("./db.ts");
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

test("README.md and AGENTS.md state the loop's numbers and the spend floor as the code has them", () => {
  const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const need = STRK_FLOOR + LOOP.reserveStrk;
  const said = {
    "README.md": [`STRK ≥ ${need} ?`, `wait ${LOOP.recheckMs / 60_000} min`, `${LOOP.beastGames} Beast Mode games`, `costs ≤ ${LOOP.bagCapSurvivor} SURVIVOR`, `never spends its last ${STRK_FLOOR} STRK`, `less than ${need} STRK: the ${STRK_FLOOR} it keeps, plus ${LOOP.reserveStrk}`, `pays at most ${LOOP.bagCapSurvivor}`],
    "AGENTS.md": [`${need} STRK is the ${STRK_FLOOR} STRK spend floor plus ${LOOP.reserveStrk}`, `Under ${STRK_FLOOR} STRK (\`STRK_FLOOR\``],
  };
  for (const [file, lines] of Object.entries(said)) for (const line of lines) assert.ok(read(file).includes(line), `${file}: ${line}`);
});

test("a fresh loop counts the Beast Mode games started after the last Loot Dungeon game in the database, so 80 played by hand go straight to the Loot step", () => {
  const add = (mode: string, at: number) => db.prepare("INSERT INTO games (mode, game_id, strategy, started_at) VALUES (?, ?, 's', ?)").run(mode, `0x${at}`, at);
  for (let at = 1; at <= 5; at++) add("beast", at);
  add("lootBag", 10);
  for (let at = 11; at <= 90; at++) add("beast", at);
  add("practice", 95);
  assert.equal(beastSince(), 80);
  assert.deepEqual(nextStep(100, beastSince(), false), { kind: "loot" });
});
