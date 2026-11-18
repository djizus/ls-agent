import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEON } from "./config.ts";
import { act, newPracticeGame, preview, replay } from "./practice.ts";

test("a practice game starts fresh, takes a move, and previews differ by luck", { timeout: 60_000 }, async () => {
  const game = newPracticeGame(DUNGEON.benchmark[1]);
  const start = await replay(game);
  assert.equal(start.adventurer.xp, 0);
  assert.equal(start.adventurer.equipment.weapon.id, 12);
  const after = await act(game, [{ type: "explore" }]);
  assert.equal(game.packets.length, 1);
  assert.ok(after.adventurer.beast_health > 0 || after.adventurer.xp > 0 || after.adventurer.gold !== start.adventurer.gold || after.adventurer.health !== start.adventurer.health);
  const points = after.adventurer.stat_upgrades_available;
  const upgrade = points > 0 ? [{ type: "upgrade" as const, stat: "vitality" as const, amount: points }] : [];
  const outcomes = await preview(game, [...upgrade, { type: after.adventurer.beast_health > 0 ? "attack" : "explore" }], 8);
  assert.ok(new Set(outcomes.map((o) => JSON.stringify(o.adventurer))).size > 1);
});
