import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Action } from "./codec.ts";
import { DUNGEON, DUNGEON_KEY } from "./config.ts";
import { db } from "./db.ts";
import { collect } from "./live.ts";
import { EFFORT, MODEL, PREAMBLE, cancel, decide, type Decision } from "./decide.ts";
import { JEV_MODEL, jevDecide } from "./jev.ts";
import { plan } from "./policy.ts";
import { emit, subscribe } from "./events.ts";
import { type Option, type State, auditGame, begin, commit, current, currentGame, describeOptions, movesMade, options, phase, render, shape, snapshot, type Phase } from "./play.ts";

export const DECIDER = process.env.LS_DECIDER ?? "rules";
const DECIDER_SOURCE = ["policy.ts", "jev.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("");
const promptFile = process.env.LS_STRATEGY ?? new URL("../strategy/prompt.md", import.meta.url).pathname;
const MAX_REJECTIONS = 3;
const LIVE_CHECK_MOVES = 100;
const CLAIM_DELAY_MS = 60_000;
const PACE_MS = Number(process.env.LS_PACE_MS ?? 0);

let row: number | undefined;
let stopping = false;
let busy = false;
let cost = 0;
let mismatches = 0;

subscribe((e) => {
  if (row !== undefined) db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(row, e.at, JSON.stringify(e));
});

export function loadStrategy(text = readFileSync(promptFile, "utf8")) {
  const full = `${DECIDER === "rules" ? "rules" : DECIDER === "jev" ? JEV_MODEL : `${MODEL} effort ${EFFORT}`}\n\n${PREAMBLE}\n\n${text}`;
  const hash = createHash("sha256").update(full).update(DECIDER === "model" ? "" : DECIDER_SOURCE).digest("hex").slice(0, 8);
  const [common, ...rest] = text.split(/^<!-- phase:(\w+) -->$/m);
  const sections: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) sections[rest[i]] = rest[i + 1].trim();
  return { hash, text: full, rules: (p: Phase) => [common.trim(), sections[p] ?? ""].filter(Boolean).join("\n\n") };
}

async function playGame(practiceId: string | undefined, seed: number): Promise<void> {
  let ending = "stopped";
  const strategy = loadStrategy();
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(strategy.hash, strategy.text, Date.now());
  const id = await begin(practiceId, seed);
  const mode = practiceId ? "practice" : DUNGEON_KEY;
  const resumed = practiceId ? undefined : (db.prepare("SELECT id FROM games WHERE game_id = ? AND mode = ?").get(id, mode) as { id: number } | undefined);
  row = resumed?.id ?? Number(db.prepare("INSERT INTO games (mode, game_id, seed, strategy, started_at) VALUES (?, ?, ?, ?, ?)").run(mode, id, seed, strategy.hash, Date.now()).lastInsertRowid);
  emit({ kind: "status", text: `game ${row} on ${id.slice(-8)}`, row });
  try {
    ending = await playMoves(strategy.rules);
  } catch (err) {
    ending = `failed: ${(err as Error).message.slice(0, 200)}`;
  } finally {
    const end = snapshot();
    db.prepare("UPDATE games SET ended_at = ?, level = ?, xp = ?, moves = ?, cost_usd = ?, ending = ?, mismatches = ? WHERE id = ?").run(Date.now(), end?.level ?? 0, end?.xp ?? 0, movesMade(), cost, ending, mismatches, row);
    emit({ kind: "status", text: `game ${row} ${ending}`, row, ending });
    row = undefined;
  }
  if (practiceId || !snapshot()?.over) return;
  await new Promise((r) => setTimeout(r, CLAIM_DELAY_MS));
  const claimed = await collect(id);
  emit({ kind: "status", text: claimed ? `claimed beasts from ${id.slice(-8)} in ${claimed}` : `no beast to claim from ${id.slice(-8)}` });
}



async function decideWithRetry(state: State, rules: string, prompt: string, choices: Option[], attempts = 3): Promise<Decision> {
  for (let i = 1; ; i++) {
    try {
      if (DECIDER === "rules") {
        const { actions, why } = plan(state);
        return { thought: why, actions, note: "", reserve: 0, costUsd: 0 };
      }
      return DECIDER === "jev" ? await jevDecide(state, rules, prompt, choices) : await decide(rules, prompt);
    } catch (err) {
      if (i >= attempts || stopping) throw err;
      emit({ kind: "status", text: `decision retry ${i}: ${(err as Error).message.slice(0, 120)}` });
    }
  }
}

function nextSeed(): number {
  const { hash } = loadStrategy();
  const played = db.prepare("SELECT seed, count(*) AS n FROM games WHERE strategy = ? AND ended_at IS NOT NULL GROUP BY seed ORDER BY seed").all(hash) as { seed: number; n: number }[];
  const complete = played.filter((p) => p.n >= DUNGEON.benchmark.length).map((p) => p.seed);
  let seed = 0;
  while (complete.includes(seed)) seed++;
  return seed;
}

const DOING: Record<string, string> = { explore: "exploring", attack: "fighting", flee: "fleeing" };

async function playMoves(rules: (p: Phase) => string): Promise<string> {
  let state = current();
  let ending = "stopped";
  mismatches = 0;
  let note = "";
  let rejected = "";
  let rejections = 0;
  cost = 0;
  while (!state.over && !stopping && rejections < MAX_REJECTIONS) {
    const choices = await options(state);
    const prompt = [render(state), describeOptions(state, choices), note && `Your note from the previous decision: ${note}`, rejected].filter(Boolean).join("\n\n");
    const decision = await decideWithRetry(state, rules(phase(state)), prompt, choices);
    if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
    cost += decision.costUsd;
    const actions = shape(state, decision.actions as Action[], decision.reserve);
    emit({ kind: "decision", phase: phase(state), options: choices, thought: decision.thought, actions, note: decision.note, reserve: decision.reserve, costUsd: decision.costUsd });
    try {
      if (!actions.length) throw new Error("spend your stat points before anything else");
      const before = state;
      state = await commit(actions);
      const last = actions.at(-1)!.type;
      if (state.over) ending = `died at level ${state.level} while ${DOING[last] ?? last} from ${before.health}/${before.maxHealth} HP${before.beast ? ` against ${before.beast.name} level ${before.beast.level}` : ""}`;
      note = decision.note;
      rejected = "";
      rejections = 0;
      if (currentGame().chain && !state.over && movesMade() <= LIVE_CHECK_MOVES && (await auditGame())) {
        ending = "stopped: local state differs from the contract";
        break;
      }
    } catch (err) {
      rejected = `Your last decision ${JSON.stringify(decision.actions)} was rejected by the game: ${(err as Error).message}. Choose again.`;
      emit({ kind: "rejected", actions, reason: (err as Error).message });
      rejections++;
      if (rejections === MAX_REJECTIONS) ending = `stopped after ${MAX_REJECTIONS} rejected decisions`;
    }
  }
  const drift = await auditGame().catch((err) => `audit failed: ${(err as Error).message.slice(0, 120)}`);
  if (drift) {
    mismatches++;
    emit({ kind: "status", text: `CONTRACT MISMATCH: ${drift.slice(0, 300)}` });
  }
  return ending;
}

export async function play(count: number, live: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  stopping = false;
  try {
    const seed = nextSeed();
    for (const id of live ? Array<undefined>(count).fill(undefined) : DUNGEON.benchmark.slice(0, count)) {
      if (stopping) break;
      await playGame(id, seed).catch((err) => emit({ kind: "status", text: `game failed: ${(err as Error).message}` }));
    }
  } finally {
    busy = false;
    emit({ kind: "status", text: "batch done" });
  }
}

export function halt(): void {
  stopping = true;
  cancel();
}

export function running(): boolean {
  return busy;
}
