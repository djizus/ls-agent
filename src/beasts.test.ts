import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBeast, describe, takeable, unclaimed } from "./beasts.ts";
import { DUNGEONS, GAME_CORE } from "./config.ts";
import { settleCalls } from "./live.ts";

const held = { tokenId: "0x01a9", beastId: 53, prefix: 24, suffix: 10, level: 32, health: 438, mega: false, mintedAtBlock: 18151753 };
const kill = { adventurerId: "0x1", encounterXp: 77, actionIndex: 3, beastId: 19, prefix: 38, suffix: 5, level: 41, health: 442, gameOver: true, settled: false, claimed: false };

test("decodes a beast token read from the collection", () => {
  assert.deepEqual(decodeBeast(held), {
    collection: "beast",
    species: 53,
    kind: "Balrog",
    name: '"Eagle Shadow" Balrog',
    prefix: 24,
    suffix: 10,
    tier: 1,
    type: "Bludgeon",
    tokenId: "0x1a9",
    level: 32,
    health: 438,
    minted: 18151753,
    state: "held",
    transformsAt: null,
    queued: false,
  });
});

test("a staked beast carries its transformation time, a mega does not", () => {
  const stake = { mega: false, staked: true, transformsAt: 1795210473, unsafeStake: true };
  assert.deepEqual([decodeBeast(held, stake)].map((b) => [b.state, b.transformsAt, b.queued]), [["staked", 1795210473, true]]);
  assert.deepEqual([decodeBeast(held, { ...stake, mega: true, staked: false })].map((b) => [b.state, b.transformsAt]), [["mega", null]]);
});

test("names the collection, tier and type of a species", () => {
  assert.deepEqual(describe(74, 9, 2), { collection: "beast", species: 74, kind: "Orc", name: '"Brimstone Root" Orc', prefix: 9, suffix: 2, tier: 5, type: "Bludgeon" });
  assert.deepEqual(describe(30, 0, 0), { collection: "beast", species: 30, kind: "Minotaur", name: "Minotaur", prefix: 0, suffix: 0, tier: 1, type: "Blade" });
  assert.deepEqual(describe(96, 38, 5), { collection: "lootBag", species: 96, kind: "Enfield", name: '"Hypnotic Roar" Enfield', prefix: 38, suffix: 5, tier: 5, type: "Blade" });
  assert.deepEqual([78, 79, 88, 99, 100, 107].map((s) => describe(s, 0, 0).tier), [1, 1, 1, 1, 2, 5]);
  assert.deepEqual(describe(76, 0, 0), { collection: "other", species: 76, kind: null, name: "Beast #76", prefix: 0, suffix: 0, tier: 0, type: "" });
});

test("keeps finished unclaimed kills, one per beast, with the collection's species", () => {
  const kills = [kill, { ...kill, encounterXp: 90 }, { ...kill, encounterXp: 91, prefix: 1, claimed: true }, { ...kill, encounterXp: 92, suffix: 6, gameOver: false }, { ...kill, encounterXp: 93, beastId: 1 }];
  assert.deepEqual(unclaimed(kills, DUNGEONS.lootBag.firstSpecies).map((k) => [k.encounterXp, k.species]), [[77, 96], [93, 78]]);
  assert.deepEqual(unclaimed(kills, DUNGEONS.beast.firstSpecies).map((k) => [k.encounterXp, k.species]), [[77, 19], [93, 1]]);
});

test("settles a short game in one transaction with its claims", () => {
  const txs = settleCalls(DUNGEONS.lootBag, "0x9", [5n, 6n], [100n, 101n], [77], 0, 1n);
  assert.deepEqual(txs, [[
    { contractAddress: GAME_CORE, entrypoint: "verify_game", calldata: ["0x9", "0x2", "0x5", "0x6", "0x2", "0x64", "0x65"] },
    { contractAddress: DUNGEONS.lootBag.address, entrypoint: "claim_collectable", calldata: ["0x9", "0x4d"] },
  ]]);
});

test("a settled game only claims, and does nothing without claims", () => {
  assert.deepEqual(settleCalls(DUNGEONS.beast, "0x9", [5n, 6n], [100n, 101n], [77], 2, 1n), [[{ contractAddress: DUNGEONS.beast.address, entrypoint: "claim_beast", calldata: ["0x9", "0x4d"] }]]);
  assert.deepEqual(settleCalls(DUNGEONS.beast, "0x9", [5n, 6n], [100n, 101n], [], 2, 1n), []);
});

test("a long game folds every chunk, then replays every chunk, and claims with the last", () => {
  const txs = settleCalls(DUNGEONS.beast, "0x9", [5n, 6n, 7n], [100n, 101n, 102n], [77], 0, 255n, 2, 2);
  assert.deepEqual(txs.map((tx) => tx.map((c) => [c.entrypoint, c.calldata])), [
    [["verify_actions", ["0x9", "0xff", "0x2", "0x5", "0x6", "0x2", "0x64", "0x65"]]],
    [["verify_actions", ["0x9", "0xff", "0x1", "0x7", "0x1", "0x66"]]],
    [["apply_actions", ["0x9", "0xff", "0x2", "0x5", "0x6", "0x2", "0x64", "0x65"]]],
    [["apply_actions", ["0x9", "0xff", "0x1", "0x7", "0x1", "0x66"]], ["claim_beast", ["0x9", "0x4d"]]],
  ]);
});

test("a partly replayed game resumes in chunks from its checkpoint", () => {
  const txs = settleCalls(DUNGEONS.beast, "0x9", [5n, 6n, 7n], [100n, 101n, 102n], [], 2, 255n);
  assert.deepEqual(txs.map((tx) => tx.map((c) => [c.entrypoint, c.calldata])), [[["verify_actions", ["0x9", "0xff", "0x1", "0x7", "0x1", "0x66"]]], [["apply_actions", ["0x9", "0xff", "0x1", "0x7", "0x1", "0x66"]]]]);
});

test("a staked beast is taken only by another player's kill made after the stake", () => {
  const stake = { staker: "0x0abc", block: 100n };
  assert.deepEqual([takeable("0x1", 101n, stake), takeable("0x1", 100n, stake), takeable("0x1", 99n, stake), takeable("0xABC", 101n, stake)], [true, false, false, false]);
  assert.equal(takeable("0x1", 18153371n, { staker: "0x2", block: 0n }), true);
});
