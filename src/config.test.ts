import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEONS, SYNTHETIC, dungeonOf } from "./config.ts";

test("a game belongs to the dungeon whose settings its id carries, and a generated start to Beast Mode", () => {
  assert.equal(dungeonOf(DUNGEONS.beast.benchmark[0]), "beast");
  assert.equal(dungeonOf(DUNGEONS.lootBag.benchmark[0]), "lootBag");
  assert.equal(dungeonOf(SYNTHETIC + 7n), "beast");
  assert.throws(() => dungeonOf("0x000000000000000000000100000000090000000001c893c8011811d300050681"), /no known dungeon \(settings 9\)/);
});
