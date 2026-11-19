import assert from "node:assert/strict";
import { test } from "node:test";
import { itemOf } from "./items.ts";
import { enrich, type State } from "./play.ts";
import { plan } from "./policy.ts";

const KATANA = 42, FALCHION = 43, SCIMITAR = 44, SHORT_SWORD = 46;
const HOLY_CHESTPLATE = 77, PLATE_MAIL = 79, SHIRT = 21;
const PLATINUM_RING = 6, TITANIUM_RING = 7, GOLD_RING = 8;
const JUNK = [SHIRT, 26, 31, 36, 41, 51, 56, 61, 66, 71, 81, 86, 91, 96, 101];

const gear = (id: number, greatness: number, bonus?: State["bag"][number]["bonus"]) => ({ ...itemOf(id)!, greatness, ...(bonus && { suffix: "of Giant", bonus }) });
const offer = (id: number, price: number) => ({ ...itemOf(id)!, price });
const stats = { strength: 0, dexterity: 20, vitality: 0, intelligence: 0, wisdom: 0, charisma: 10 };

const state = (over: Partial<Parameters<typeof enrich>[0]>): State =>
  enrich({ over: false, level: 20, health: 100, maxHealth: 100, xp: 400, gold: 50, beast: null, statUpgradesAvailable: 0, stats, equipment: [], bag: [], market: [], ...over });

test("bag items are kept while there is room", () => {
  assert.deepEqual(plan(state({ bag: [gear(SHIRT, 1)] })).actions, [{ type: "explore" }]);
});

test("a full bag gives up its least useful item for a purchase, and never one with a vitality or charisma bonus", () => {
  const maxed = { equipment: [gear(PLATE_MAIL, 20)], market: [offer(HOLY_CHESTPLATE, 10)] };
  assert.deepEqual(plan(state({ ...maxed, bag: JUNK.map((id) => gear(id, 1)) })).actions, [
    { type: "drop", item: SHIRT },
    { type: "buy", item: HOLY_CHESTPLATE, equip: true },
    { type: "explore" },
  ]);
  assert.deepEqual(plan(state({ ...maxed, bag: JUNK.map((id) => gear(id, 15, { vitality: 3 })) })).actions, [{ type: "explore" }]);
});

test("a kept piece of a better tier is worn when the worn one is maxed", () => {
  assert.deepEqual(plan(state({ equipment: [gear(PLATE_MAIL, 20)], bag: [gear(HOLY_CHESTPLATE, 1)] })).actions, [{ type: "equip", item: HOLY_CHESTPLATE }, { type: "explore" }]);
  assert.deepEqual(plan(state({ equipment: [gear(PLATE_MAIL, 19)], bag: [gear(HOLY_CHESTPLATE, 1)] })).actions, [{ type: "explore" }]);
});

test("a tier 1 weapon replaces the worn one only when it would catch up by greatness 5, or the worn one is maxed", () => {
  const buys = (worn: number, greatness: number, offered: number) =>
    plan(state({ equipment: [gear(worn, greatness)], market: [offer(offered, 10)] })).actions.some((a) => a.type === "buy" && a.item === offered);
  assert.equal(buys(SHORT_SWORD, 20, KATANA), true);
  assert.equal(buys(SCIMITAR, 8, KATANA), true);
  assert.equal(buys(SCIMITAR, 9, KATANA), false);
  assert.equal(buys(SCIMITAR, 20, KATANA), true);
  assert.equal(buys(SHORT_SWORD, 1, FALCHION), false);
});

test("gold needed to heal to full is not spent on gear", () => {
  const maxed = { equipment: [gear(PLATE_MAIL, 20)], market: [offer(HOLY_CHESTPLATE, 10)], health: 60 };
  assert.deepEqual(plan(state({ ...maxed, gold: 14 })).actions, [{ type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "potions", qty: 4 }, { type: "explore" }]);
  assert.deepEqual(plan(state({ ...maxed, gold: 13 })).actions, [{ type: "potions", qty: 4 }, { type: "explore" }]);
});

test("a maxed ring makes way for the next one, bought only with two full heals of gold to spare", () => {
  const maxed = { equipment: [gear(TITANIUM_RING, 20)], market: [offer(GOLD_RING, 10)] };
  assert.deepEqual(plan(state({ ...maxed, gold: 30 })).actions, [{ type: "buy", item: GOLD_RING, equip: true }, { type: "explore" }]);
  assert.deepEqual(plan(state({ ...maxed, gold: 29 })).actions, [{ type: "explore" }]);
  assert.deepEqual(plan(state({ equipment: [gear(TITANIUM_RING, 19)], market: [offer(GOLD_RING, 10)] })).actions, [{ type: "explore" }]);
  assert.deepEqual(plan(state({ ...maxed, bag: [gear(PLATINUM_RING, 5)] })).actions, [{ type: "equip", item: PLATINUM_RING }, { type: "explore" }]);
  assert.deepEqual(plan(state({ equipment: [gear(GOLD_RING, 20)], bag: [gear(TITANIUM_RING, 20)] })).actions, [{ type: "equip", item: TITANIUM_RING }, { type: "explore" }]);
  assert.deepEqual(plan(state({ equipment: [gear(TITANIUM_RING, 20)], bag: [gear(GOLD_RING, 20)] })).actions, [{ type: "explore" }]);
});

test("a drop that takes vitality or charisma away is counted before healing and pricing", () => {
  const maxed = { equipment: [gear(PLATE_MAIL, 20)], market: [offer(HOLY_CHESTPLATE, 10)] };
  const stash = JUNK.slice(1).map((id) => gear(id, 15, { vitality: 3 }));
  const sturdy = state({ ...maxed, maxHealth: 115, health: 105, bag: [gear(SHIRT, 15, { vitality: 1 }), ...stash] });
  assert.deepEqual(plan(sturdy).actions, [{ type: "drop", item: SHIRT }, { type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "explore" }]);
  const charming = state({ ...maxed, health: 60, gold: 14, bag: [gear(SHIRT, 15, { charisma: 1 }), ...stash] });
  assert.deepEqual(plan(charming).actions, [{ type: "drop", item: SHIRT }, { type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "potions", qty: 1 }, { type: "explore" }]);
});
