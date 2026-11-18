import { MARKET } from "./settings.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hash } from "starknet";
import { decodeAdventurer, decodeBag, encodePacket, type Action, type Stats } from "./codec.ts";
import { GAME_CORE } from "./config.ts";
import { levelOf, potionPrice, priceOf } from "./items.ts";
import { marketOf } from "./market.ts";
import { newPracticeGame, replay, revertReason, type Snapshot } from "./practice.ts";
import { effectiveStats, suffixOf } from "./specials.ts";
import { provider } from "./wallet.ts";

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

const SUFFIX_GAME = "0x000000000000000000000100000000020000000001c857c7010fb07100109821";
const SUFFIX_GAME_BLOCKS = { from: 17_805_430, to: 17_805_800 };
const AFTER_UNLOCK = 32;

let transcript: Promise<{ packets: string[]; blocks: string[] }> | undefined;
const realTranscript = () =>
  (transcript ??= provider
    .getEvents({ address: GAME_CORE, from_block: { block_number: SUFFIX_GAME_BLOCKS.from }, to_block: { block_number: SUFFIX_GAME_BLOCKS.to }, keys: [[hash.getSelectorFromName("ActionCommitted")], [SUFFIX_GAME]], chunk_size: 100 })
    .then(({ events }) => ({
      packets: events.flatMap((e) => e.data.slice(1, 1 + Number(e.data[0]))),
      blocks: events.flatMap((e) => Array(Number(e.data[0])).fill(String(e.block_number))),
    })));

async function fromRealGame(committed: number, extra: Action[][] = [], seed = "real") {
  const t = await realTranscript();
  const packets = [...t.packets.slice(0, committed), ...extra.map((a) => String(encodePacket(a)))];
  const blocks = [...t.blocks.slice(0, committed), ...extra.map((_, i) => String(4_000_000_000 + i))];
  const hashes = [...blocks.slice(0, committed).map(() => "0x0"), ...extra.map((_, i) => luck(`${seed}-${i}`))];
  const calldata = [SUFFIX_GAME, String(packets.length), ...packets, String(blocks.length), ...blocks, String(hashes.length), ...hashes, String(committed)];
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  const adventurer = decodeAdventurer(BigInt(out[3])), bag = decodeBag(BigInt(out[4]));
  return { adventurer, bag, stats: effectiveStats(adventurer, bag, SUFFIX_GAME) };
}

test("items grow by greatness: 2x beast xp, 1x obstacle xp, equipped only, capped at G20 with a stat point each", { timeout: 120_000 }, async () => {
  assert.equal((await realTranscript()).packets.length, 37);
  const [start, kill, obstacle, after] = await Promise.all([1, 2, 13, 14].map((n) => fromRealGame(n)));
  assert.deepEqual([kill.adventurer.xp - start.adventurer.xp, kill.adventurer.equipment.weapon.xp - start.adventurer.equipment.weapon.xp], [4, 8]);
  assert.deepEqual([after.adventurer.xp - obstacle.adventurer.xp, after.adventurer.equipment.weapon.xp - obstacle.adventurer.equipment.weapon.xp], [23, 23]);
  assert.deepEqual(after.bag, [{ id: 12, xp: 0 }]);
  const [before, maxed, swapped] = await Promise.all([33, 34, 35].map((n) => fromRealGame(n)));
  const capped = Object.values(maxed.adventurer.equipment).filter((i) => i.xp === 400).length;
  assert.deepEqual([levelOf(before.adventurer.xp), levelOf(maxed.adventurer.xp), capped], [16, 17, 5]);
  assert.equal(maxed.adventurer.stat_upgrades_available, 1 + capped);
  assert.deepEqual(swapped.bag.filter((i) => i.xp > 0).map((i) => i.xp), [400, 400, 400, 400, 400]);
});

test("a G15 item's suffix adds its stats: equipped gives all of them, the bag keeps only VIT and CHA", { timeout: 300_000 }, async () => {
  const locked = await fromRealGame(23);
  assert.equal(locked.adventurer.item_specials_salt, 0);
  assert.deepEqual(locked.stats, locked.adventurer.stats);

  const real = await fromRealGame(AFTER_UNLOCK);
  const { adventurer: a } = real;
  assert.deepEqual(
    Object.values(a.equipment).filter((i) => i.id).map((i) => suffixOf(i.id, a.item_specials_salt, SUFFIX_GAME)),
    ["of Titans", "of Anger", "of Skill", "of Reflection", "of Rage", "of Perfection", "of the Twins"],
  );
  assert.deepEqual([a.stats.vitality, real.stats.vitality, a.stats.charisma, real.stats.charisma, a.stats.strength, real.stats.strength], [5, 6, 6, 11, 3, 9]);

  const healed = (await fromRealGame(AFTER_UNLOCK, [[{ type: "potions", qty: 8 }]])).adventurer.health;
  const noGloves = (await fromRealGame(AFTER_UNLOCK, [[{ type: "drop", item: 70 }, { type: "potions", qty: 7 }]])).adventurer.health;
  assert.deepEqual([healed, noGloves], [100 + 15 * 6, 100 + 15 * 5]);

  const potionSetups: Action[][] = [[], [{ type: "drop", item: 2 }, { type: "drop", item: 65 }], [{ type: "drop", item: 2 }, { type: "drop", item: 65 }, { type: "drop", item: 9 }], [{ type: "equip", item: 1 }, { type: "drop", item: 65 }, { type: "drop", item: 9 }]];
  const spent = await Promise.all(potionSetups.map(async (setup) => {
    const r = await fromRealGame(AFTER_UNLOCK, [[...setup, { type: "potions", qty: 1 }]]);
    return { paid: a.gold - r.adventurer.gold, price: potionPrice(levelOf(r.adventurer.xp), r.stats.charisma), charisma: r.stats.charisma };
  }));
  assert.deepEqual(spent.map((s) => s.charisma), [11, 7, 6, 9]);
  spent.forEach((s) => assert.equal(s.paid, s.price));

  const owned = new Set([...Object.values(a.equipment), ...real.bag].map((i) => i.id));
  const offer = marketOf(a, SUFFIX_GAME, MARKET).find((o) => !owned.has(o.id))!;
  const bought = await fromRealGame(AFTER_UNLOCK, [[{ type: "buy", item: offer.id, equip: false }]]);
  assert.equal(a.gold - bought.adventurer.gold, priceOf(offer.id, real.stats.charisma));
  assert.notEqual(priceOf(offer.id, real.stats.charisma), priceOf(offer.id, a.stats.charisma));

  const dealt = async (setup: Action[]) => {
    const found = await fromRealGame(AFTER_UNLOCK, [[...setup, { type: "explore" }]], "str-7");
    const hit = await fromRealGame(AFTER_UNLOCK, [[...setup, { type: "explore" }], [{ type: "attack", tillHealth: found.adventurer.health - 1 }]], "str-7");
    return { dealt: found.adventurer.beast_health - hit.adventurer.beast_health, strength: found.stats.strength };
  };
  const hits = await Promise.all([[], [{ type: "drop", item: 51 }], [{ type: "equip", item: 18 }]].map((s) => dealt(s as Action[])));
  assert.deepEqual(hits.map((h) => h.strength), [9, 7, 7]);
  assert.ok(hits[0].dealt > hits[1].dealt);
  assert.equal(hits[1].dealt, hits[2].dealt);
});
