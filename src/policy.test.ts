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

const REST = [22, 27, 32, 37].map((id) => gear(id, 20));

test("bag items are kept while there is room", () => {
  assert.deepEqual(plan(state({ equipment: [gear(PLATE_MAIL, 5)], bag: [gear(SHIRT, 1)] })).actions, [{ type: "explore" }]);
});

test("a full bag gives up its least useful item for a purchase, and never one with a vitality or charisma bonus", () => {
  const maxed = { equipment: [gear(PLATE_MAIL, 20), ...REST], market: [offer(HOLY_CHESTPLATE, 10)] };
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

test("an armor upgrade is bought with the gold left after a full heal now and half a full heal kept back", () => {
  const maxed = { equipment: [gear(PLATE_MAIL, 20)], market: [offer(HOLY_CHESTPLATE, 10)], health: 60 };
  assert.deepEqual(plan(state({ ...maxed, gold: 19 })).actions, [{ type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "potions", qty: 4 }, { type: "explore" }]);
  assert.deepEqual(plan(state({ ...maxed, gold: 18 })).actions, [{ type: "potions", qty: 4 }, { type: "explore" }]);
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
  const maxed = { equipment: [gear(PLATE_MAIL, 20), ...REST], market: [offer(HOLY_CHESTPLATE, 10)] };
  const stash = JUNK.slice(1).map((id) => gear(id, 15, { vitality: 3 }));
  const sturdy = state({ ...maxed, maxHealth: 115, health: 105, bag: [gear(SHIRT, 15, { vitality: 1 }), ...stash] });
  assert.deepEqual(plan(sturdy).actions, [{ type: "drop", item: SHIRT }, { type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "explore" }]);
  const charming = state({ ...maxed, health: 60, gold: 19, bag: [gear(SHIRT, 15, { charisma: 1 }), ...stash] });
  assert.deepEqual(plan(charming).actions, [{ type: "drop", item: SHIRT }, { type: "buy", item: HOLY_CHESTPLATE, equip: true }, { type: "potions", qty: 4 }, { type: "explore" }]);
});

const beast = (health: number) => ({ id: 29, name: "Dragon", baseName: "Dragon", tier: 1, type: "Blade" as const, level: 30, health, specialPrefix: null, specialSuffix: null, isCollectable: false });
const hits = (yours: number, normal: number, crit: number, spare: { id: number; hit: { normal: number; crit: number } }[] = []) => ({ yours: { normal: yours, crit: 2 * yours }, theirs: Array.from({ length: 5 }, () => ({ normal, crit })), spare });

test("a fight that can be lost is taken one exchange at a time, while winning it is at most 35 points less likely than escaping", () => {
  const twoBlows = { beast: beast(100), hits: hits(50, 10, 200), health: 100 };
  assert.deepEqual(plan(state({ ...twoBlows, level: 20 })).actions, [{ type: "attack", tillHealth: 99 }]);
  assert.deepEqual(plan(state({ ...twoBlows, level: 40, stats: { ...stats, dexterity: 40 } })).actions, [{ type: "flee" }]);
  assert.deepEqual(plan(state({ ...twoBlows, level: 40, stats: { ...stats, dexterity: 20 } })).actions, [{ type: "attack", tillHealth: 99 }]);
  assert.deepEqual(plan(state({ beast: beast(50), hits: hits(50, 200, 400), health: 1 })).actions, [{ type: "attack" }]);
  assert.deepEqual(plan(state({ beast: beast(1000), hits: hits(4, 200, 400), health: 100, stats: { ...stats, dexterity: 0 } })).actions, [{ type: "attack", tillHealth: 99 }]);
});

test("a move never holds more than 15 actions: a purchase that does not fit waits", () => {
  const better = [17, 22, 27, 32, 37];
  const busy = state({
    level: 60,
    gold: 500,
    maxHealth: 550,
    health: 500,
    statUpgradesAvailable: 6,
    stats: { strength: 0, dexterity: 30, vitality: 30, intelligence: 0, wisdom: 0, charisma: 29 },
    equipment: [gear(SHORT_SWORD, 20), ...JUNK.slice(0, 5).map((id) => gear(id, 20)), gear(TITANIUM_RING, 20), gear(3, 20)],
    bag: [KATANA, ...better, ...JUNK.slice(5, 14)].map((id) => gear(id, 1)),
    market: [offer(GOLD_RING, 1), offer(1, 1)],
  });
  const actions = plan(busy).actions;
  assert.equal(actions.length, 15);
  assert.deepEqual(actions.at(-1), { type: "explore" });
  assert.equal(actions.filter((a) => a.type === "upgrade").length, 4);
  assert.equal(actions.filter((a) => a.type === "equip").length, 6);
  assert.equal(actions.filter((a) => a.type === "buy").length, 1);
});

test("armor that takes less from this beast is put on in the fight when that beats staying, the free strike counted", () => {
  const other = JUNK.slice(0, 5);
  const spare = (normal: number, crit: number) => other.map((id) => ({ id, hit: { normal, crit } }));
  const stuck = { stats: { ...stats, dexterity: 0 }, bag: other.map((id) => gear(id, 20)) };
  const long = state({ ...stuck, beast: beast(500), health: 300, hits: hits(50, 40, 80, spare(4, 8)) });
  assert.deepEqual(plan(long).actions, other.map((item) => ({ type: "equip", item })));
  const short = state({ ...stuck, beast: beast(100), health: 100, level: 30, hits: hits(50, 60, 120, spare(55, 110)) });
  assert.deepEqual(plan(short).actions, [{ type: "attack", tillHealth: 99 }]);
});

test("after the fight the real armor goes back on", () => {
  assert.deepEqual(plan(state({ equipment: [gear(SHIRT, 20)], bag: [gear(HOLY_CHESTPLATE, 20)] })).actions, [{ type: "equip", item: HOLY_CHESTPLATE }, { type: "explore" }]);
});
