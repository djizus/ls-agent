import assert from "node:assert/strict";
import { test } from "node:test";
import { BENCHMARK } from "./config.ts";
import { begin, commit, options } from "./play.ts";
import { act, newPracticeGame, preview, replay, type Snapshot } from "./practice.ts";

test("market and potions are open between fights, not only at level-up", { timeout: 120_000 }, async () => {
  let state = await begin(BENCHMARK[0]);
  while (state.beast || state.statUpgradesAvailable > 0 || state.health === state.maxHealth) {
    const points = state.statUpgradesAvailable;
    const upgrade = points > 0 ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : [];
    state = await commit([...upgrade, { type: state.beast ? "attack" : "explore" }]);
  }
  assert.ok(state.market.length > 0);
  assert.match(await options(state), /Potions cost \d+ gold each/);
  const healed = await commit([{ type: "potions", qty: 1 }, { type: "buy", item: state.market[0].id, equip: false }, { type: "explore" }]);
  assert.ok(healed.bag.some((b) => b.id === state.market[0].id));
});

test("attack and flee without a threshold run until the fight ends; tillHealth stops early", { timeout: 120_000 }, async () => {
  const game = newPracticeGame(BENCHMARK[4]);
  let snap = await replay(game);
  while (snap.adventurer.beast_health === 0) {
    const points = snap.adventurer.stat_upgrades_available;
    snap = await act(game, [...(points ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : []), { type: "explore" }]);
  }
  const ended = (o: Snapshot) => o.adventurer.health === 0 || o.adventurer.beast_health === 0;
  assert.ok((await preview(game, [{ type: "attack" }], 8)).every(ended));
  assert.ok((await preview(game, [{ type: "flee" }], 8)).every(ended));
  const floor = snap.adventurer.health - 1;
  assert.ok((await preview(game, [{ type: "attack", tillHealth: floor }], 8)).every((o) => o.adventurer.health > 0 && (o.adventurer.beast_health === 0 || o.adventurer.health <= floor)));
});
