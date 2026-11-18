import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Action } from "./codec.ts";
import { DUNGEON } from "./config.ts";
import { db } from "./db.ts";
import { EFFORT, MODEL, PREAMBLE, cancel, decide, type Decision } from "./decide.ts";
import { JEV_MODEL, jevDecide } from "./jev.ts";
import { emit, subscribe } from "./events.ts";
import { type Option, type State, auditGame, begin, commit, describeOptions, movesMade, options, phase, render, shape, snapshot, type Phase } from "./play.ts";

const promptFile = process.env.LS_STRATEGY ?? new URL("../strategy/prompt.md", import.meta.url).pathname;
const MAX_REJECTIONS = 3;

let row: number | undefined;
let stopping = false;
let busy = false;
let cost = 0;
let mismatches = 0;

subscribe((e) => {
  if (row !== undefined && e.kind !== "state") db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(row, e.at, JSON.stringify(e));
});

export function loadStrategy(text = readFileSync(promptFile, "utf8")) {
  const full = `${DECIDER === "jev" ? JEV_MODEL : `${MODEL} effort ${EFFORT}`}\n\n${PREAMBLE}\n\n${text}`;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  const [common, ...rest] = text.split(/^<!-- phase:(\w+) -->$/m);
  const sections: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) sections[rest[i]] = rest[i + 1].trim();
  return { hash, text: full, rules: (p: Phase) => [common.trim(), sections[p] ?? ""].filter(Boolean).join("\n\n") };
}

async function playGame(id: string): Promise<void> {
  let ending = "stopped";
  const strategy = loadStrategy();
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(strategy.hash, strategy.text, Date.now());
  row = Number(db.prepare("INSERT INTO games (mode, game_id, strategy, started_at) VALUES ('practice', ?, ?, ?)").run(id, strategy.hash, Date.now()).lastInsertRowid);
  emit({ kind: "status", text: `game ${row} on ${id.slice(-8)}` });
  try {
    ending = await playMoves(id, strategy.rules);
  } catch (err) {
    ending = `failed: ${(err as Error).message.slice(0, 200)}`;
  } finally {
    const end = snapshot();
    db.prepare("UPDATE games SET ended_at = ?, level = ?, xp = ?, moves = ?, cost_usd = ?, ending = ?, mismatches = ? WHERE id = ?").run(Date.now(), end?.level ?? 0, end?.xp ?? 0, movesMade(), cost, ending, mismatches, row);
    emit({ kind: "status", text: `game ${row} ${ending}` });
    row = undefined;
  }
}

export const DECIDER = process.env.LS_DECIDER ?? "jev";

async function decideWithRetry(state: State, rules: string, prompt: string, choices: Option[], attempts = 3): Promise<Decision> {
  for (let i = 1; ; i++) {
    try {
      return DECIDER === "jev" ? await jevDecide(state, rules, prompt, choices) : await decide(rules, prompt);
    } catch (err) {
      if (i >= attempts || stopping) throw err;
      emit({ kind: "status", text: `decision retry ${i}: ${(err as Error).message.slice(0, 120)}` });
    }
  }
}

const DOING: Record<string, string> = { explore: "exploring", attack: "fighting", flee: "fleeing" };

async function playMoves(id: string, rules: (p: Phase) => string): Promise<string> {
  let state = await begin(id);
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

export async function playBenchmark(count = DUNGEON.benchmark.length): Promise<void> {
  if (busy) return;
  busy = true;
  stopping = false;
  try {
    for (const id of DUNGEON.benchmark.slice(0, count)) {
      if (stopping) break;
      await playGame(id).catch((err) => emit({ kind: "status", text: `game failed: ${(err as Error).message}` }));
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
