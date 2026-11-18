import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Action } from "./codec.ts";
import { BENCHMARK } from "./config.ts";
import { db } from "./db.ts";
import { cancel, decide } from "./decide.ts";
import { emit, subscribe } from "./events.ts";
import { begin, commit, movesMade, options, phase, render, snapshot, type Phase } from "./play.ts";

const promptFile = process.env.LS_STRATEGY ?? new URL("../strategy/prompt.md", import.meta.url).pathname;
const MAX_REJECTIONS = 3;

let row: number | undefined;
let stopping = false;
let busy = false;
let cost = 0;

subscribe((e) => {
  if (row !== undefined && e.kind !== "state") db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(row, e.at, JSON.stringify(e));
});

export function loadStrategy(text = readFileSync(promptFile, "utf8")) {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const [common, ...rest] = text.split(/^<!-- phase:(\w+) -->$/m);
  const sections: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) sections[rest[i]] = rest[i + 1].trim();
  return { hash, text, rules: (p: Phase) => [common.trim(), sections[p] ?? ""].filter(Boolean).join("\n\n") };
}

async function playGame(id: string): Promise<void> {
  const strategy = loadStrategy();
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(strategy.hash, strategy.text, Date.now());
  row = Number(db.prepare("INSERT INTO games (mode, game_id, strategy, started_at) VALUES ('practice', ?, ?, ?)").run(id, strategy.hash, Date.now()).lastInsertRowid);
  emit({ kind: "status", text: `game ${row} on ${id.slice(-8)}` });
  try {
    await playMoves(id, strategy.rules);
  } finally {
    const end = snapshot();
    db.prepare("UPDATE games SET ended_at = ?, level = ?, xp = ?, moves = ?, cost_usd = ? WHERE id = ?").run(Date.now(), end?.level ?? 0, end?.xp ?? 0, movesMade(), cost, row);
    emit({ kind: "status", text: `game ${row} finished at level ${end?.level ?? 0}` });
    row = undefined;
  }
}

async function playMoves(id: string, rules: (p: Phase) => string): Promise<void> {
  let state = await begin(id);
  let note = "";
  let rejected = "";
  let rejections = 0;
  cost = 0;
  while (!state.over && !stopping && rejections < MAX_REJECTIONS) {
    const prompt = [render(state), await options(state), note && `Your note from the previous decision: ${note}`, rejected].filter(Boolean).join("\n\n");
    const decision = await decide(rules(phase(state)), prompt);
    cost += decision.costUsd;
    emit({ kind: "say", text: decision.note });
    emit({ kind: "tool", name: "act", input: decision.actions });
    try {
      state = await commit(decision.actions as Action[]);
      note = decision.note;
      rejected = "";
      rejections = 0;
    } catch (err) {
      rejected = `Your last decision ${JSON.stringify(decision.actions)} was rejected by the game: ${(err as Error).message}. Choose again.`;
      emit({ kind: "result", name: "act", output: rejected });
      rejections++;
    }
  }
}

export async function playBenchmark(count = BENCHMARK.length): Promise<void> {
  if (busy) return;
  busy = true;
  stopping = false;
  try {
    for (const id of BENCHMARK.slice(0, count)) {
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
