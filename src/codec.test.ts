import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAdventurer, encodePacket } from "./codec.ts";

test("decodes a live game's starting adventurer after one simulated explore", () => {
  const a = decodeAdventurer(0x4abe0000000060084a20000520004730000000000000000000000000000000cn);
  assert.deepEqual(
    { health: a.health, xp: a.xp, gold: a.gold, upgrades: a.stat_upgrades_available, stats: a.stats, weapon: a.equipment.weapon, level_salt: a.level_salt },
    { health: 115, xp: 1, gold: 41, upgrades: 0, stats: { strength: 2, dexterity: 5, vitality: 1, intelligence: 1, wisdom: 0, charisma: 3 }, weapon: { id: 12, xp: 0 }, level_salt: 9567 },
  );
});

test("encodes packets exactly as the live client does", () => {
  assert.equal(encodePacket([{ type: "explore" }]), 0x1n);
  assert.equal(encodePacket([{ type: "attack" }]), 0x2n);
  assert.equal(
    encodePacket([{ type: "upgrade", stat: "dexterity", amount: 1 }, { type: "explore", tillDamage: 1 }]),
    (1n << 240n) | (0x11n << 16n) | 0x94n,
  );
});
