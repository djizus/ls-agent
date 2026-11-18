import { createHash } from "node:crypto";
import type { Action } from "./codec.ts";
import { beastHit, yourHit } from "./combat.ts";
import { encodePacket } from "./codec.ts";
import { step, toSnapshot, type Local } from "./engine/engine.ts";
import { currentGame, describe, shape, type State } from "./play.ts";
import type { Game } from "./practice.ts";

export type Future = { survival: number; xp: number; gold: number };

const ARMOR_SLOTS = ["chest", "head", "waist", "foot", "hand"];

export function autopilot(s: State): Action[] {
  if (s.beast) {
    const worn = (slot: string) => s.equipment.find((g) => g.slot === slot);
    const toKill = Math.ceil(s.beast.health / yourHit(worn("weapon"), s.stats, s.beast).normal);
    const taken = ARMOR_SLOTS.reduce((sum, slot) => sum + beastHit(s.beast!, worn(slot)).normal, 0) / ARMOR_SLOTS.length;
    const toDie = Math.ceil(s.health / taken);
    return [{ type: toKill < toDie || s.stats.dexterity === 0 ? "attack" : "flee" }];
  }
  const points: Action[] = s.statUpgradesAvailable > 0 ? [{ type: "upgrade", stat: "vitality", amount: s.statUpgradesAvailable }] : [];
  return shape({ ...s, statUpgradesAvailable: 0 }, [...points, { type: "explore" }]);
}

const luck = (run: number, move: number) => "0x" + createHash("sha256").update(`rollout:${run}:${move}`).digest("hex").slice(0, 62);

export function future(game: Game, first: Action[], runs: number, horizon: number): Future {
  const start = toSnapshot(game.local).adventurer;
  let alive = 0;
  const xp: number[] = [];
  const gold: number[] = [];
  for (let run = 0; run < runs; run++) {
    let local: Local = game.local;
    try {
      if (first.length) local = step(local, game.id, encodePacket(first), luck(run, 0));
      for (let move = 1; move <= horizon && !local.over; move++) {
        local = step(local, game.id, encodePacket(autopilot(describe(toSnapshot(local), game.id))), luck(run, move));
      }
    } catch {
      continue;
    }
    if (!local.over) alive++;
    xp.push(local.adventurer.xp - start.xp);
    gold.push(local.adventurer.gold - start.gold);
  }
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  return { survival: alive / runs, xp: median(xp), gold: median(gold) };
}

const RUNS = 24;
const HORIZON = 25;

export const foresee = (first: Action[]): Future => future(currentGame(), first, RUNS, HORIZON);
export const describeFuture = (f: Future): string => `simulated next ${HORIZON} moves: +${f.xp} xp, ${Math.round(100 * f.survival)}% still alive`;
