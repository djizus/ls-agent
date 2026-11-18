import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { beastOf } from "./beast.ts";
import { decodeAdventurer } from "./codec.ts";

const fixtures = JSON.parse(readFileSync(new URL("./beast.fixtures.json", import.meta.url), "utf8"));
const blank = decodeAdventurer(0n);

test("derives the beast the live game API reports", () => {
  for (const f of fixtures) {
    const adventurer = { ...blank, xp: f.xp, beast_salt: f.beast_salt, beast_health: f.beast_health };
    assert.deepEqual(beastOf(adventurer, BigInt(f.gameId)), f.beast, f.gameId);
  }
  assert.ok(fixtures.length >= 30);
});

test("has no beast when beast health is zero", () => {
  assert.equal(beastOf({ ...blank, xp: 358, beast_salt: 109648 }, 1n), null);
});
