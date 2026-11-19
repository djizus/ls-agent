import assert from "node:assert/strict";
import { test } from "node:test";
import type { Beast } from "../beast.ts";
import { STATS, decodeAdventurer, encodePacket, type Action } from "../codec.ts";
import * as combat from "../combat.ts";
import { DUNGEON, GAME_CORE } from "../config.ts";
import { ITEMS, itemOf, levelOf, potionPrice, priceOf } from "../items.ts";
import { marketOf } from "../market.ts";
import { hashes, replay, startOf, revertReason, type Snapshot } from "../practice.ts";
import { MARKET } from "../settings.ts";
import { effectiveStats } from "../specials.ts";
import { provider } from "../wallet.ts";
import { beastHit, yourHit } from "./damage.ts";
import { Rejected, fromSnapshot, step, toSnapshot, type Local } from "./engine.ts";

const PACKETS = 60;

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(l: Local, id: string, rnd: () => number): Action[] {
  const a = l.adventurer;
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const stats = effectiveStats(a, l.slots, id);
  const bag = l.slots.filter((i) => i.id);
  if (a.beast_health > 0) {
    const swap = bag.find((i) => itemOf(i.id)!.slot !== "weapon");
    if (swap && rnd() < 0.05) return [{ type: "equip", item: swap.id }];
    const half = Math.floor((100 + 15 * stats.vitality) / 2);
    if (stats.dexterity > 0 && (a.health <= half || rnd() < 0.3)) return [{ type: "flee", tillHealth: rnd() < 0.5 ? a.health - 1 : undefined }];
    return [{ type: "attack", tillHealth: rnd() < 0.5 ? a.health - 1 : stats.dexterity > 0 ? half : undefined, spareBeast: rnd() < 0.1 ? pick([1, 2] as const) : 0 }];
  }
  const out: Action[] = [];
  let points = a.stat_upgrades_available;
  const added: Record<string, number> = {};
  while (points > 0) {
    const stat = a.stats.dexterity + (added.dexterity ?? 0) < 3 ? "dexterity" : pick([...STATS, "vitality", "vitality", "dexterity", "wisdom"] as const);
    if (a.stats[stat] + (added[stat] ?? 0) >= 31) continue;
    added[stat] = (added[stat] ?? 0) + 1;
    points--;
  }
  for (const [stat, amount] of Object.entries(added)) out.push({ type: "upgrade", stat: stat as (typeof STATS)[number], amount });
  const charisma = stats.charisma + (added.charisma ?? 0);
  let gold = a.gold;
  if (rnd() < 0.4) {
    const owned = new Set([...Object.values(a.equipment), ...bag].map((i) => i.id));
    const free = l.slots.filter((i) => !i.id).length;
    const empty = (o: { id: number }) => (a.equipment[itemOf(o.id)!.slot].id === 0 ? 0 : 1);
    for (const offer of marketOf(a, id, MARKET).sort((x, y) => empty(x) - empty(y) || rnd() - 0.5).slice(0, 3)) {
      const price = priceOf(offer.id, charisma);
      if (price > gold || owned.has(offer.id) || free < 2) continue;
      gold -= price;
      out.push({ type: "buy", item: offer.id, equip: rnd() < (empty(offer) ? 0.3 : 0.9) });
    }
  }
  const missing = 100 + 15 * stats.vitality - a.health;
  const price = potionPrice(levelOf(a.xp), charisma);
  const qty = Math.min(Math.floor(missing / 10), Math.floor(gold / price));
  if (qty > 0 && rnd() < 0.9) out.push({ type: "potions", qty });
  if (out.length === 0 && bag.length && rnd() < 0.15) return [{ type: rnd() < 0.5 ? "equip" : "drop", item: pick(bag).id }];
  if (out.length === 0 || rnd() < 0.5) out.push({ type: "explore" });
  return out;
}

const core = (s: Snapshot) => JSON.stringify([s.adventurer, s.bag, s.over]);
const same = (local: Snapshot, chain: Snapshot) => core(local) === core(chain);

type Played = { game: { id: string; packets: bigint[] }; states: Local[] };

async function play(id: string, seed: number): Promise<Played> {
  const game = { id, packets: [] as bigint[] };
  const rnd = random(seed);
  const states = [fromSnapshot(await startOf(id))];
  let local = states[0];
  while (game.packets.length < PACKETS && !local.over) {
    const hash = hashes({ id, packets: [...game.packets, 0n] }).at(-1)!;
    let next: Local | undefined;
    let packet = 0n;
    for (let tries = 0; tries < 24 && (!next || next.over); tries++) {
      packet = encodePacket(choose(local, id, rnd));
      next = step(local, id, packet, hash);
    }
    local = next!;
    game.packets.push(packet);
    states.push(local);
  }
  return { game, states };
}

const prefix = (game: Played["game"], n: number, extra: bigint[] = []): [Played["game"], bigint[], string[]] => {
  const packets = [...game.packets.slice(0, n), ...extra];
  return [game, packets, hashes({ id: game.id, packets })];
};

async function differential({ game, states }: Played): Promise<{ steps: number; mismatch?: string }> {
  const chain = await Promise.all(states.slice(1).map((_, i) => replay(...prefix(game, i + 1))));
  const bad = chain.findIndex((c, i) => !same(toSnapshot(states[i + 1]), c));
  if (bad < 0) return { steps: chain.length };
  return { steps: bad, mismatch: `packet ${bad}: local ${JSON.stringify(toSnapshot(states[bad + 1]))} chain ${JSON.stringify(chain[bad])}` };
}

function invalid(l: Local, id: string): [string, Action[]][] {
  const a = l.adventurer;
  const stats = effectiveStats(a, l.slots, id);
  const owned = [...Object.values(a.equipment), ...l.slots].filter((i) => i.id).map((i) => i.id);
  const missing = Array.from({ length: 101 }, (_, i) => i + 1).find((i) => !owned.includes(i))!;
  const bag = l.slots.find((i) => i.id);
  const out: [string, Action[]][] = [
    ["equip missing", [{ type: "equip", item: missing }]],
    ["duplicate equip", [{ type: "equip", item: missing }, { type: "equip", item: missing }]],
  ];
  if (a.beast_health > 0) {
    out.push(["explore in battle", [{ type: "explore" }]], ["potions in battle", [{ type: "potions", qty: 1 }]], ["buy in battle", [{ type: "buy", item: missing, equip: false }]]);
    out.push(["drop in battle", [{ type: "drop", item: a.equipment.weapon.id }]], ["upgrade in battle", [{ type: "upgrade", stat: "strength", amount: 1 }]]);
    if (stats.dexterity === 0) out.push(["flee without dexterity", [{ type: "flee" }]]);
    return out;
  }
  out.push(["attack outside battle", [{ type: "attack" }]], ["flee outside battle", [{ type: "flee" }]], ["drop missing", [{ type: "drop", item: missing }]]);
  if (bag) out.push(["duplicate drop", [{ type: "drop", item: bag.id }, { type: "drop", item: bag.id }]]);
  const points = a.stat_upgrades_available;
  if (points > 0) {
    out.push(["explore pending", [{ type: "explore" }]], ["potions pending", [{ type: "potions", qty: 1 }]], ["buy pending", [{ type: "buy", item: missing, equip: false }]]);
    if (points > 1) out.push(["upgrade short", [{ type: "upgrade", stat: "vitality", amount: points - 1 }]]);
    if (points < 15) out.push(["upgrade over", [{ type: "upgrade", stat: "vitality", amount: points + 1 }]]);
    const full = STATS.find((s) => a.stats[s] + points > 31);
    if (full) out.push(["stat overflow", [{ type: "upgrade", stat: full, amount: points }]]);
    out.push(["duplicate upgrade", [{ type: "upgrade", stat: "wisdom", amount: 1 }, { type: "upgrade", stat: "wisdom", amount: 1 }]]);
    return out;
  }
  out.push(["no upgrades", [{ type: "upgrade", stat: "strength", amount: 1 }]]);
  const market = marketOf(a, id, MARKET);
  const offers = market.map((o) => o.id);
  const outside = Array.from({ length: 101 }, (_, i) => i + 1).find((i) => !offers.includes(i))!;
  out.push(["not in market", [{ type: "buy", item: outside, equip: false }]]);
  const pricey = market.find((o) => priceOf(o.id, stats.charisma) > a.gold && !owned.includes(o.id));
  if (pricey) out.push(["too expensive", [{ type: "buy", item: pricey.id, equip: true }]]);
  const mine = market.find((o) => owned.includes(o.id) && priceOf(o.id, stats.charisma) <= a.gold);
  if (mine) out.push(["buy owned", [{ type: "buy", item: mine.id, equip: false }]], ["buy owned equip", [{ type: "buy", item: mine.id, equip: true }]]);
  const max = 100 + 15 * stats.vitality;
  if (a.health === max) out.push(["potions at full health", [{ type: "potions", qty: 1 }]]);
  else out.push(["potions broke", [{ type: "potions", qty: 255 }]]);
  const overheal = Math.floor((max - a.health) / 10) + 2;
  if (a.health < max && overheal * potionPrice(levelOf(a.xp), stats.charisma) <= a.gold) out.push(["potions overheal", [{ type: "potions", qty: overheal }]]);
  if (l.slots.every((i) => i.id)) {
    const extra = market.find((o) => !owned.includes(o.id) && priceOf(o.id, stats.charisma) <= a.gold);
    if (extra) out.push(["bag full", [{ type: "buy", item: extra.id, equip: false }]]);
  }
  return out;
}

async function rejections(played: Played[]): Promise<string[]> {
  const cases = new Map<string, [Played, number, Action[]]>();
  for (const p of played) p.states.forEach((l, n) => !l.over && invalid(l, p.game.id).forEach(([name, actions]) => cases.has(name) || cases.set(name, [p, n, actions])));
  const reason = async (run: () => unknown) => {
    try {
      await run();
      return "accepted";
    } catch (err) {
      return err instanceof Rejected ? err.message : revertReason(err);
    }
  };
  return Promise.all(
    [...cases].map(async ([name, [{ game, states }, n, actions]]) => {
      const packet = encodePacket(actions);
      const [, packets, luck] = prefix(game, n, [packet]);
      const local = await reason(() => step(states[n], game.id, packet, luck.at(-1)!));
      const chain = await reason(() => replay(game, packets, luck));
      return `${name}: ${local === chain ? local : `local "${local}" chain "${chain}"`}`;
    }),
  );
}

const ids = DUNGEON.benchmark.slice(0, 8);
let games: Promise<Played[]> | undefined;
const played = () => (games ??= Promise.all(ids.map((id, i) => play(id, i + 1))));

test("local engine matches the contract after every packet", { timeout: 600_000 }, async () => {
  const results = await Promise.all((await played()).map(differential));
  results.forEach((r, i) => console.log(ids[i].slice(-8), r.steps, r.mismatch ?? "match"));
  assert.deepEqual(results.map((r) => r.mismatch), ids.map(() => undefined));
});

test("local engine rejects invalid packets with the contract's reasons", { timeout: 600_000 }, async () => {
  const lines = await rejections(await played());
  assert.ok(lines.length >= 20);
  lines.forEach((l) => console.log(l));
  assert.deepEqual(lines.filter((l) => l.includes('chain "')), []);
});

test("engine damage equals combat.ts when no jewelry or name match applies", () => {
  const adventurer = decodeAdventurer(0n);
  for (const item of ITEMS.filter((i) => i.slot !== "neck" && i.slot !== "ring"))
    for (const xp of [0, 4, 100, 400])
      for (const [level, tier, type] of [[1, 5, "Magic"], [7, 3, "Blade"], [18, 1, "Bludgeon"]] as const) {
        const beast = { level, tier, type, health: 1 } as Beast;
        const foe = { level, tier, type, prefix: null, suffix: null };
        const gear = { id: item.id, xp };
        if (item.slot === "weapon") {
          adventurer.equipment.weapon = gear;
          const stats = { ...adventurer.stats, strength: xp % 7 };
          assert.deepEqual(yourHit(adventurer, stats.strength, foe, 1n), combat.yourHit(gear, stats, beast));
        } else assert.deepEqual(beastHit(adventurer, foe, gear, 1n), combat.beastHit(beast, gear));
      }
});
