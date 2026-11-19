import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEON } from "./config.ts";
import { begin, commit, current, render, shape, type State } from "./play.ts";
import { act, newPracticeGame, preview, replay, type Snapshot } from "./practice.ts";

test("market and potions are open between fights, not only at level-up", { timeout: 120_000 }, async () => {
  await begin(DUNGEON.benchmark[0]);
  let state = current();
  while (state.beast || state.statUpgradesAvailable > 0 || state.health === state.maxHealth) {
    const points = state.statUpgradesAvailable;
    const upgrade = points > 0 ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : [];
    state = await commit([...upgrade, { type: state.beast ? "attack" : "explore" }]);
  }
  assert.ok(state.market.length > 0);
  assert.match(render(state), /Potions: \d+ gold each/);
  const healed = await commit([{ type: "potions", qty: 1 }, { type: "buy", item: state.market[0].id, equip: false }, { type: "explore" }]);
  assert.ok(healed.bag.some((b) => b.id === state.market[0].id));
});

test("attack and flee without a threshold run until the fight ends; tillHealth stops early", { timeout: 120_000 }, async () => {
  const game = await newPracticeGame(DUNGEON.benchmark[4]);
  let snap = await replay(game);
  while (snap.adventurer.beast_health === 0) {
    const points = snap.adventurer.stat_upgrades_available;
    snap = act(game, [...(points ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : []), { type: "explore" }]);
  }
  const ended = (o: Snapshot) => o.adventurer.health === 0 || o.adventurer.beast_health === 0;
  assert.ok((preview(game, [{ type: "attack" }], 8)).every(ended));
  assert.ok((preview(game, [{ type: "flee" }], 8)).every(ended));
  const floor = snap.adventurer.health - 1;
  assert.ok((preview(game, [{ type: "attack", tillHealth: floor }], 8)).every((o) => o.adventurer.health > 0 && (o.adventurer.beast_health === 0 || o.adventurer.health <= floor)));
});

test("potion price formula matches the contract; explores are healed first and pending points hold the explore", { timeout: 300_000 }, async () => {
  const hurtWithGold = async (id: string): Promise<State | undefined> => {
    await begin(id);
    let state = current();
    while (state.beast || state.statUpgradesAvailable > 0 || state.health > state.maxHealth - 20 || state.gold < 2) {
      if (state.statUpgradesAvailable > 0) {
        const pending = shape(state, [{ type: "upgrade", stat: "charisma", amount: state.statUpgradesAvailable }, { type: "explore" }]);
        assert.deepEqual(pending.map((a) => a.type), ["upgrade"]);
        state = await commit(pending);
        continue;
      }
      state = await commit(state.beast ? [{ type: "attack" }] : [{ type: "explore" }]);
      if (state.over) return undefined;
    }
    return state;
  };
  let state: State | undefined;
  for (const id of DUNGEON.benchmark) if ((state = await hurtWithGold(id))) break;
  assert.ok(state, "no benchmark adventurer reached a hurt state with gold");
  const goldBefore = state.gold;
  const healthBefore = state.health;
  const healed = shape(state, [{ type: "explore" }]);
  const potions = healed.find((a) => a.type === "potions");
  assert.ok(potions && potions.type === "potions");
  assert.equal(potions.qty, Math.min(Math.ceil((state.maxHealth - state.health) / 10), Math.floor(state.gold / state.potionPrice)));
  assert.equal(shape(state, [{ type: "explore" }], state.gold).some((a) => a.type === "potions"), false);
  const half = shape(state, [{ type: "explore" }], Math.floor(state.gold / 2)).find((a) => a.type === "potions");
  assert.ok(!half || (half.type === "potions" && half.qty * state.potionPrice <= state.gold - Math.floor(state.gold / 2)));
  const one = await commit([{ type: "potions", qty: 1 }]);
  assert.equal(goldBefore - one.gold, state.potionPrice);
  assert.equal(one.health, Math.min(healthBefore + 10, state.maxHealth));
});
