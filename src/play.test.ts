import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEON } from "./config.ts";
import { begin, commit, current, enrich, render, shape, type State } from "./play.ts";
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

test("potion price formula matches the contract; explores are healed first", { timeout: 300_000 }, async () => {
  const hurtWithGold = async (id: string): Promise<State | undefined> => {
    await begin(id);
    let state = current();
    while (state.beast || state.statUpgradesAvailable > 0 || state.health > state.maxHealth - 20 || state.gold < 2) {
      if (state.statUpgradesAvailable > 0) {
        state = await commit(shape(state, [{ type: "upgrade", stat: "charisma", amount: state.statUpgradesAvailable }, { type: "explore" }]));
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

test("a stored state gains luck, chances, grants and purse, whatever its age", () => {
  const worn = (id: number, name: string, slot: string, type: string, tier: number, extra: object) => ({ id, name, slot, type, tier, ...extra });
  const state = enrich({
    over: false, level: 20, health: 100, maxHealth: 250, xp: 400, gold: 30, beast: null, statUpgradesAvailable: 0,
    stats: { strength: 4, dexterity: 10, vitality: 10, intelligence: 2, wisdom: 5, charisma: 9 },
    equipment: {
      chest: worn(50, "Hard Leather Armor", "chest", "Hide", 4, { level: 16, bonus: { wisdom: 3 } }),
      neck: worn(1, "Pendant", "neck", "Necklace", 1, { greatness: 10, xp: 100 }),
      ring: worn(4, "Silver Ring", "ring", "Ring", 2, { greatness: 6, xp: 40 }),
    },
    bag: [worn(8, "Gold Ring", "ring", "Ring", 1, { greatness: 3, xp: 9 }), worn(61, "Leather Belt", "waist", "Hide", 5, { greatness: 15, xp: 225, bonus: { vitality: 2, dexterity: 1 } })],
    market: [worn(49, "Studded Leather Armor", "chest", "Hide", 3, { price: 3 }), worn(56, "Cap", "head", "Hide", 5, { price: 1 }), worn(7, "Titanium Ring", "ring", "Ring", 1, { price: 11 })],
  } as unknown as Parameters<typeof enrich>[0]);
  assert.equal(state.luck, 10 + 2 * 6 + 3);
  assert.deepEqual(state.buys, { attack: 40, flee: 50, trap: 10, ambush: 25, crit: 25 });
  assert.deepEqual(state.baseStats, { strength: 4, dexterity: 10, vitality: 8, intelligence: 2, wisdom: 2, charisma: 9 });
  assert.deepEqual(state.equipment.map((g) => [g.greatness, g.toNext, g.grants]), [
    [16, 33, ["+3 wisdom"]],
    [10, 21, ["+10 luck", "Hide armor blocks 30% more (1 of 5 worn)"]],
    [6, 9, ["+12 luck (doubled while worn)"]],
  ]);
  assert.deepEqual(state.bag.map((g) => g.grants), [["+3 luck"], ["+2 vitality"]]);
  assert.deepEqual(state.purse, { potions: 15, toFull: 15, deal: { ...state.market[1], why: "empty head" } });
  assert.deepEqual(enrich(state), state);
});
