import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEONS } from "./config.ts";
import { act, newPracticeGame, replay } from "./practice.ts";

test("a practice game starts fresh and takes a move", { timeout: 60_000 }, async () => {
  const game = await newPracticeGame(DUNGEONS.beast.benchmark[1]);
  const start = await replay(game);
  assert.equal(start.adventurer.xp, 0);
  assert.equal(start.adventurer.equipment.weapon.id, 12);
  const after = act(game, [{ type: "explore" }]);
  assert.equal(game.packets.length, 1);
  assert.ok(after.adventurer.beast_health > 0 || after.adventurer.xp > 0 || after.adventurer.gold !== start.adventurer.gold || after.adventurer.health !== start.adventurer.health);
});
