import assert from "node:assert/strict";
import { test } from "node:test";
import { BENCHMARK } from "./config.ts";
import { begin, commit, options } from "./play.ts";

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
