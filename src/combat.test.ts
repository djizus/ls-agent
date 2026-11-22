import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { settingsOf } from "./settings.ts";
import { hash } from "starknet";
import { beastOf } from "./beast.ts";
import { decodeAdventurer, decodeBag, encodePacket, type Action, type Adventurer, type Item, type Stats } from "./codec.ts";
import { beastHit, yourHit, type Hit } from "./combat.ts";
import { reduced } from "./engine/damage.ts";
import { GAME_CORE } from "./config.ts";
import type { Slot } from "./items.ts";
import { replay } from "./practice.ts";
import { effectiveStats } from "./specials.ts";
import { provider } from "./wallet.ts";

type Move = [Action[], string];
type Stat = keyof Stats;
type State = { adventurer: Adventurer; bag: Item[] };
type Round = { before: State; after: State; id: string };
type Case = { label: string; round: () => Promise<Round>; slot: Slot; youCrit?: boolean; beastCrit?: boolean };

const GAME = "0x000000000000000000000100000000020708000001c84936010da5ec00048001";
const REAL_GAME = "0x000000000000000000000100000000020000000001c857c7010fb07100109821";
const REAL_BLOCKS = { from: 17_805_430, to: 17_805_800 };
const KATANA = 42;
const HOOD = 26, HELM = 86, LEATHER_CAP = 55;
const BEASTS = {
  jiangshi: "0xb222c2efb284ad42fb6ad3e74691753d0f97d9612e885eb448c6548273e839",
  bear: "0x893a630937ca9d8caf77938324f236777d0a399c5db2cc516398a6e6dc23da",
  jotunn: "0x989d74c212219ca284f20c71e0270f5a7df485f700fcd668ac173aed80e673",
  wyvern: "0xe4f2d659e3ea5eec77c916dac3b8f2c690dbed61f8128d9a1c7971273b0fc8",
};

const luck = (seed: string) => "0x" + createHash("sha256").update(seed).digest("hex").slice(0, 62);
const attack = (a: Adventurer): Action[] => [{ type: "attack", tillHealth: a.health - 1 }];

const LEVEL_UP: Move = [[{ type: "buy", item: KATANA, equip: true }, { type: "explore" }], luck("lv-0")];
const levelTwo = (buys: number[], beast: keyof typeof BEASTS, stat: Stat = "charisma"): Move[] => [
  LEVEL_UP,
  [[{ type: "upgrade", stat, amount: 1 }, ...buys.map((item): Action => ({ type: "buy", item, equip: true })), { type: "explore" }], BEASTS[beast]],
];

const play = (moves: Move[]) => replay({ id: GAME, packets: [] }, moves.map(([a]) => encodePacket(a)), moves.map(([, l]) => l));

async function practiceRound(moves: Move[], strike: string): Promise<Round> {
  const before = await play(moves);
  return { before, after: await play([...moves, [attack(before.adventurer), strike]]), id: GAME };
}

let transcript: Promise<{ packets: string[]; blocks: string[] }> | undefined;
const realTranscript = () =>
  (transcript ??= provider
    .getEvents({ address: GAME_CORE, from_block: { block_number: REAL_BLOCKS.from }, to_block: { block_number: REAL_BLOCKS.to }, keys: [[hash.getSelectorFromName("ActionCommitted")], [REAL_GAME]], chunk_size: 100 })
    .then(({ events }) => ({
      packets: events.flatMap((e) => e.data.slice(1, 1 + Number(e.data[0]))),
      blocks: events.flatMap((e) => Array(Number(e.data[0])).fill(String(e.block_number))),
    })));

async function fromRealGame(committed: number, extra: Move[] = []): Promise<State> {
  const t = await realTranscript();
  const packets = [...t.packets.slice(0, committed), ...extra.map(([a]) => String(encodePacket(a)))];
  const blocks = [...t.blocks.slice(0, committed), ...extra.map((_, i) => String(4_000_000_000 + i))];
  const hashes = [...blocks.slice(0, committed).map(() => "0x0"), ...extra.map(([, l]) => l)];
  const calldata = [REAL_GAME, String(packets.length), ...packets, String(blocks.length), ...blocks, String(hashes.length), ...hashes, String(committed)];
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  return { adventurer: decodeAdventurer(BigInt(out[3])), bag: decodeBag(BigInt(out[4])) };
}

async function realRound(committed: number, strike: string): Promise<Round> {
  const before = await fromRealGame(committed);
  return { before, after: await fromRealGame(committed, [[attack(before.adventurer), luck(strike)]]), id: REAL_GAME };
}

async function inBatches<T, R>(items: T[], f: (t: T) => Promise<R>, size = 4): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}

const pick = (hit: Hit, crit?: boolean) => (crit ? hit.crit : hit.normal);

async function check(c: Case) {
  const { before, after, id } = await c.round();
  const a = before.adventurer, beast = beastOf(a, BigInt(id))!;
  assert.ok(after.adventurer.beast_health > 0 && after.adventurer.health > 0, `${c.label}: both survive the exchange`);
  const measured = { dealt: a.beast_health - after.adventurer.beast_health, taken: a.health - after.adventurer.health };
  const predicted = {
    dealt: pick(yourHit(a.equipment.weapon, effectiveStats(a, before.bag, id), beast), c.youCrit),
    taken: pick(beastHit(beast, a.equipment[c.slot]), c.beastCrit),
  };
  return { label: c.label, measured, predicted };
}

const practice = (beast: keyof typeof BEASTS, { buys = [] as number[], stat = "charisma" as Stat, slot = "chest" as Slot, strike = "atk" } = {}): Case => ({
  label: `level 2 katana, +1 ${stat}, bought [${buys}], vs ${beast}, ${slot} hit`,
  round: () => practiceRound(levelTwo(buys, beast, stat), luck(strike)),
  slot,
});

const CASES: Case[] = [
  ...(["jiangshi", "bear", "jotunn", "wyvern"] as const).map((b) => practice(b)),
  ...(["jiangshi", "bear"] as const).map((b) => practice(b, { stat: "strength" })),
  ...[HOOD, HELM, LEATHER_CAP].map((helm) => practice("jotunn", { buys: [helm], slot: "head", strike: "def-0" })),
  { label: "real L12: magic wand vs Bludgeon Kraken, chest hit", round: () => realRound(22, "at-22-4-0"), slot: "chest" },
  { label: "real L14: magic wand vs Blade Weretiger, minimum hit", round: () => realRound(27, "at-27-0-0"), slot: "head" },
  { label: "real L15: STR 9 vs Lich, your crit", round: () => realRound(29, "at-29-16-0"), slot: "head", youCrit: true },
  { label: "real L15: Lich crits through Leather Armor", round: () => realRound(29, "at-29-13-0"), slot: "chest", beastCrit: true },
  { label: "real L16: Draugr crits the chest", round: () => realRound(33, "at-33-1-0"), slot: "chest", beastCrit: true },
  { label: "real L6: Fairy hits the belt", round: () => realRound(8, "at-8-4-0"), slot: "waist" },
];

test("your hit and the beast's counter match the contract exactly in every combination", { timeout: 600_000 }, async () => {
  const results = await inBatches(CASES, check);
  for (const r of results) assert.deepEqual(r.measured, r.predicted, r.label);
  assert.ok(new Set(results.flatMap((r) => [r.predicted.dealt, r.predicted.taken])).size >= 12, "the cases span many distinct damages");
});

test("an ambush on arrival takes the Beast Mode base reduction off the beast's hit", { timeout: 300_000 }, async () => {
  const reduction = settingsOf(GAME).ambush;
  assert.equal(reduction, 35);
  const start = (await play([LEVEL_UP])).adventurer.health;
  const arrivals = await inBatches(Object.keys(BEASTS) as (keyof typeof BEASTS)[], async (b) => (await play(levelTwo([], b))).adventurer);
  const ambushed = arrivals.filter((a) => a.health < start);
  assert.ok(ambushed.length >= 2);
  for (const a of ambushed) assert.equal(start - a.health, reduced(beastHit(beastOf(a, BigInt(GAME))!, undefined).normal, reduction));
});
