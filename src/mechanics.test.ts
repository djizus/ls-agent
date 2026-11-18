import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodePacket, type Action, type Stats } from "./codec.ts";
import { levelOf } from "./items.ts";
import { newPracticeGame, replay, revertReason, type Snapshot } from "./practice.ts";

type Move = [Action[], string];

const GAME = "0x000000000000000000000100000000020708000001c84936010da5ec00048001";
const DEX_ZERO_GAME = "0x000000000000000000000100000000020000000001c87a76011489e0001f7381";
const KATANA = 42, WARHAMMER = 72, GRAVE_WAND = 10, CLUB = 76;
const HOOD = 26, HELM = 86, LEATHER_CAP = 55;
const FULL = "health full";

const luck = (seed: string) => "0x" + createHash("sha256").update(seed).digest("hex").slice(0, 62);

const LEVEL_ONE = {
  leprechaun: "0xb14c19d4c427ce619f4ed32745249603bfc65e7e250799118a78a102233dcc",
  bear: "0x1810bd6e1df3e67eab986443011c2379f6035acbacca9f364f7393f9d43577",
  orc: "0x9d6ee2b2f9c49ee0f559bca7b24b26754db6df1e0a08ab93129c042a468123",
};
const LEVEL_TWO = {
  jiangshi: "0xb222c2efb284ad42fb6ad3e74691753d0f97d9612e885eb448c6548273e839",
  bear: "0x893a630937ca9d8caf77938324f236777d0a399c5db2cc516398a6e6dc23da",
  jotunn: "0x989d74c212219ca284f20c71e0270f5a7df485f700fcd668ac173aed80e673",
  wyvern: "0xe4f2d659e3ea5eec77c916dac3b8f2c690dbed61f8128d9a1c7971273b0fc8",
};

const LEVEL_UP: Move = [[{ type: "buy", item: KATANA, equip: true }, { type: "explore" }], luck("lv-0")];
const levelTwoFight = (setup: Action[], beast: string): Move[] => [LEVEL_UP, [[...setup, { type: "explore" }], beast]];
const WOUNDED: Move[] = [...levelTwoFight([{ type: "upgrade", stat: "charisma", amount: 1 }], LEVEL_TWO.jotunn), [[{ type: "flee" }], luck("flee")]];

const play = (id: string, moves: Move[]) => replay(newPracticeGame(id), moves.map(([a]) => encodePacket(a)), moves.map(([, l]) => l));

async function outcome(id: string, moves: Move[]): Promise<Snapshot | string> {
  try {
    return await play(id, moves);
  } catch (err) {
    return revertReason(err);
  }
}

async function exchange(id: string, setup: Move[], strike = luck("atk")) {
  const before = (await play(id, setup)).adventurer;
  const after = (await play(id, [...setup, [[{ type: "attack", tillHealth: before.health - 1 }], strike]])).adventurer;
  return { dealt: before.beast_health - after.beast_health, taken: before.health - after.health };
}

const firstHit = async (weapon: number, beast: string) => (await exchange(GAME, [[[{ type: "buy", item: weapon, equip: true }, { type: "explore" }], beast]])).dealt;
const health = (o: Snapshot | string) => (typeof o === "string" ? o : o.adventurer.health);

test("a potion heals exactly 10 HP and is rejected at full health", { timeout: 120_000 }, async () => {
  const wounded = await play(GAME, WOUNDED);
  assert.equal(wounded.adventurer.beast_health, 0);
  assert.equal(health(await outcome(GAME, [...WOUNDED, [[{ type: "potions", qty: 1 }], luck("p")]])), wounded.adventurer.health + 10);
  assert.equal(health(await outcome(GAME, [LEVEL_UP, [[{ type: "upgrade", stat: "charisma", amount: 1 }, { type: "potions", qty: 1 }], luck("p")]])), FULL);
});

test("max health is 100 + 15 x VIT: potions heal up to it and no further", { timeout: 120_000 }, async () => {
  const wounded = await play(GAME, WOUNDED);
  const max = 100 + 15 * wounded.adventurer.stats.vitality;
  assert.ok(wounded.adventurer.health > max - 20 && wounded.adventurer.health < max - 10);
  assert.equal(health(await outcome(GAME, [...WOUNDED, [[{ type: "potions", qty: 2 }], luck("p")]])), max);
  assert.equal(health(await outcome(GAME, [...WOUNDED, [[{ type: "potions", qty: 3 }], luck("p")]])), FULL);
});

test("each VIT point raises max health by 15 and heals 15 at once", { timeout: 120_000 }, async () => {
  const before = (await play(GAME, [LEVEL_UP])).adventurer;
  const vit: Move = [[{ type: "upgrade", stat: "vitality", amount: 1 }], luck("p")];
  const after = (await play(GAME, [LEVEL_UP, vit])).adventurer;
  assert.equal(before.health, 100 + 15 * before.stats.vitality);
  assert.deepEqual([after.stats.vitality, after.health], [before.stats.vitality + 1, before.health + 15]);
  assert.equal(health(await outcome(GAME, [LEVEL_UP, [[vit[0][0], { type: "potions", qty: 1 }], luck("p")]])), FULL);
});

test("weapons deal +50% to the beast type they beat and -50% to the one they lose to", { timeout: 300_000 }, async () => {
  const weapons = [KATANA, WARHAMMER, GRAVE_WAND];
  const hits = await Promise.all(Object.values(LEVEL_ONE).map((beast) => Promise.all(weapons.map((w) => firstHit(w, beast)))));
  assert.deepEqual(hits, [
    [7, 4, 4],
    [5, 7, 4],
    [4, 5, 6],
  ]);
});

test("T1 weapons hit 5x harder than T5 before armor, and a fresh T5 weapon deals the minimum 4", { timeout: 300_000 }, async () => {
  const clubs = await Promise.all(Object.values(LEVEL_ONE).map((beast) => firstHit(CLUB, beast)));
  assert.deepEqual(clubs, [4, 4, 4]);
  assert.equal(await firstHit(WARHAMMER, LEVEL_ONE.bear), 7);
});

test("an empty armor slot takes 1.5x the beast's attack; armor type shifts it by the same +-50%", { timeout: 300_000 }, async () => {
  const helmets = [null, HOOD, HELM, LEATHER_CAP];
  const taken = (beast: string) =>
    Promise.all(helmets.map(async (helm) => {
      const buy: Action[] = helm ? [{ type: "buy", item: helm, equip: true }] : [];
      return (await exchange(GAME, levelTwoFight([{ type: "upgrade", stat: "charisma", amount: 1 }, ...buy], beast), luck("def-0"))).taken;
    }));
  assert.deepEqual(await taken(LEVEL_TWO.jotunn), [27, 8, 17, 25]);
  assert.deepEqual(await taken(LEVEL_TWO.wyvern), [27, 26, 8, 16]);
});

test("each STR point adds 10% of the weapon's attack, rounded down", { timeout: 300_000 }, async () => {
  const dealt = (stat: keyof Stats, beast: string) => exchange(GAME, levelTwoFight([{ type: "upgrade", stat, amount: 1 }], beast)).then((r) => r.dealt);
  const pairs = await Promise.all([LEVEL_TWO.jiangshi, LEVEL_TWO.bear].map((b) => Promise.all([dealt("strength", b), dealt("charisma", b)])));
  assert.deepEqual(pairs, [
    [9, 8],
    [10, 9],
  ]);
});

test("flee needs DEX: rejected at 0, about DEX / level per try below level, always at or above", { timeout: 600_000 }, async () => {
  const moves: Move[] = [];
  let s = await play(DEX_ZERO_GAME, moves);
  while (!(levelOf(s.adventurer.xp) >= 5 && s.adventurer.beast_health > 0)) {
    const a = s.adventurer;
    assert.ok(a.health > 0 && moves.length < 20);
    const points: Action[] = a.stat_upgrades_available ? [{ type: "upgrade", stat: "charisma", amount: a.stat_upgrades_available }] : [];
    moves.push([[...points, { type: a.beast_health > 0 ? "attack" : "explore" }], luck(`fl-${moves.length}`)]);
    s = await play(DEX_ZERO_GAME, moves);
  }
  assert.equal(s.adventurer.stats.dexterity, 0);
  const tries = Array.from({ length: 16 }, (_, i) => luck(`flee-${i}`));
  const flee = async (setup: Move[], id = DEX_ZERO_GAME) => {
    const hp = (await play(id, setup)).adventurer.health;
    return Promise.all(tries.map(async (l) => {
      const o = await outcome(id, [...setup, [[{ type: "flee", tillHealth: hp - 1 }], l]]);
      return typeof o === "string" ? o : o.adventurer.beast_health === 0 && o.adventurer.health > 0;
    }));
  };
  assert.deepEqual(new Set(await flee(moves)), new Set(["dexterity is zero"]));
  const upgrades = moves.flatMap(([a], i) => (a[0].type === "upgrade" ? [i] : []));
  assert.equal(upgrades.length, 4);
  const rates: boolean[][] = [];
  for (let dex = 1; dex <= 4; dex++) {
    const swapped = moves.map(([a, l], i): Move => (upgrades.slice(0, dex).includes(i) ? [[{ type: "upgrade", stat: "dexterity", amount: 1 }, ...a.slice(1)], l] : [a, l]));
    rates.push((await flee(swapped)) as boolean[]);
  }
  const counts = rates.map((r) => r.filter(Boolean).length);
  rates.slice(1).forEach((r, i) => assert.ok(rates[i].every((ok, j) => !ok || r[j]), `DEX ${i + 2} keeps every escape of DEX ${i + 1}`));
  assert.ok(counts[0] <= 7 && counts[3] >= 9 && counts[0] < counts[3], `escapes out of 16 at DEX 1..4, level 5: ${counts}`);
  const atLevel = await flee(levelTwoFight([{ type: "upgrade", stat: "charisma", amount: 1 }], LEVEL_TWO.jotunn), GAME);
  assert.ok(atLevel.every((ok) => ok === true));
});
