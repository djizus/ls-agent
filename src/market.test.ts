import assert from "node:assert/strict";
import { test } from "node:test";
import { SLOTS, encodePacket, type Action } from "./codec.ts";
import { DUNGEONS } from "./config.ts";
import { ITEMS, itemOf, priceOf } from "./items.ts";
import { marketOf } from "./market.ts";
import { settingsOf } from "./settings.ts";
import { act, hashes, newPracticeGame, replay, revertReason, type Game, type Snapshot } from "./practice.ts";

const NOT_ON_MARKET = "item does not exist";
const NOT_ENOUGH_GOLD = "not enough gold";

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 10) out.push(...(await Promise.all(items.slice(i, i + 10).map(run))));
  return out;
}

async function reachLevelUp(levelUps: number): Promise<{ game: Game; state: Snapshot }> {
  for (const id of DUNGEONS.beast.benchmark) {
    const game = await newPracticeGame(id);
    let state = await replay(game);
    let seen = 0;
    while (!state.over && game.packets.length < 120) {
      const a = state.adventurer;
      if (a.stat_upgrades_available > 0 && ++seen === levelUps) return { game, state };
      const move: Action = a.beast_health > 0 ? { type: "attack" } : { type: "explore" };
      const actions: Action[] = a.stat_upgrades_available > 0 ? [{ type: "upgrade", stat: "vitality", amount: a.stat_upgrades_available }, move] : [move];
      state = act(game, actions);
    }
  }
  throw new Error(`no benchmark game reached level-up ${levelUps}`);
}

async function tryBuy(game: Game, state: Snapshot, item: number): Promise<{ gold: number } | { error: string }> {
  const upgrade: Action = { type: "upgrade", stat: "vitality", amount: state.adventurer.stat_upgrades_available };
  const packet = encodePacket([upgrade, { type: "buy", item, equip: false }]);
  try {
    const after = await replay(game, [...game.packets, packet], [...hashes(game), "0x1"]);
    return { gold: after.adventurer.gold };
  } catch (error) {
    return { error: revertReason(error) };
  }
}

test("items table names, slots and prices", () => {
  assert.equal(ITEMS.length, 101);
  assert.deepEqual(ITEMS[11], { id: 12, name: "Wand", slot: "weapon", type: "Magic", tier: 5 });
  assert.deepEqual(ITEMS[41], { id: 42, name: "Katana", slot: "weapon", type: "Blade", tier: 1 });
  assert.deepEqual(ITEMS[100], { id: 101, name: "Heavy Gloves", slot: "hand", type: "Metal", tier: 5 });
  assert.equal(itemOf(4)!.name, "Silver Ring");
  assert.deepEqual(SLOTS.map((s) => ITEMS.filter((i) => i.slot === s).length), [18, 15, 15, 15, 15, 15, 3, 5]);
  assert.deepEqual([priceOf(42, 0), priceOf(42, 5), priceOf(12, 3), priceOf(12, 9)], [20, 15, 1, 1]);
});

for (const levelUps of [1, 2, 3]) {
  test(`market at level-up ${levelUps} matches the contract`, { timeout: 600_000 }, async () => {
    const { game, state } = await reachLevelUp(levelUps);
    const a = state.adventurer;
    const owned = new Set([...Object.values(a.equipment), ...state.bag].map((i) => i.id));
    const offers = marketOf(a, game.id, settingsOf(game.id).market).filter((o) => !owned.has(o.id));
    const listed = new Set(offers.map((o) => o.id));
    const unlisted = ITEMS.map((i) => i.id).filter((id) => !listed.has(id) && !owned.has(id)).sort((x, y) => ((x * 7919 + levelUps) % 101) - ((y * 7919 + levelUps) % 101)).slice(0, 12);
    assert.ok(offers.length > 5);

    const bought = await inBatches(offers, (o) => tryBuy(game, state, o.id));
    offers.forEach((o, i) => {
      const r = bought[i];
      const label = `${itemOf(o.id)!.name} (${o.id}) at ${o.price}, gold ${a.gold}`;
      if (o.price > a.gold) assert.deepEqual(r, { error: NOT_ENOUGH_GOLD }, label);
      else assert.deepEqual(r, { gold: a.gold - o.price }, label);
    });

    const refused = await inBatches(unlisted, (id) => tryBuy(game, state, id));
    unlisted.forEach((id, i) => assert.deepEqual(refused[i], { error: NOT_ON_MARKET }, `${itemOf(id)!.name} (${id})`));
  });
}
