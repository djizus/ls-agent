import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Action } from "./codec.ts";
import { BEASTS_TO, DUNGEON, DUNGEON_KEY, SEATS, SURVIVOR } from "./config.ts";
import { db } from "./db.ts";
import { collect, liveIds, sendBeasts, type Entry } from "./live.ts";
import { balanceOf, strkBalance } from "./wallet.ts";
import { EFFORT, MODEL, PREAMBLE, cancel, decide, type Decision } from "./decide.ts";
import { JEV_MODEL, jevDecide } from "./jev.ts";
import { plan } from "./policy.ts";
import { emit, subscribe } from "./events.ts";
import { type Option, type State, type Table, auditGame, begin, namedSlain, commit, current, describeOptions, leave, options, phase, render, shape, type Phase } from "./play.ts";

export const DECIDER = process.env.LS_DECIDER ?? "rules";
const DECIDER_SOURCE = ["policy.ts", "jev.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("");
const promptFile = process.env.LS_STRATEGY ?? new URL("../strategy/prompt.md", import.meta.url).pathname;
const MAX_REJECTIONS = 3;
const LIVE_CHECK_MOVES = 100;
const CLAIM_DELAY_MS = 60_000;
const PACE_MS = Number(process.env.LS_PACE_MS ?? 0);

type Seat = { table: Table; row: number; rules: (p: Phase) => string; state: State; note: string; rejected: string; rejections: number; cost: number; ending?: string };

let stopping = false;
let busy = false;

subscribe((e) => {
  if (e.row !== undefined) db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(e.row, e.at, JSON.stringify(e));
});

export const slain = (game: number): number =>
  namedSlain((db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(game) as { body: string }[]).map((e) => JSON.parse(e.body)));

const RECORDED = `EXISTS (SELECT 1 FROM events WHERE game = games.id AND body LIKE '{"kind":"state"%')`;
db.exec(`UPDATE games SET beasts = NULL WHERE beasts = 0 AND NOT ${RECORDED}`);
for (const { id } of db.prepare(`SELECT id FROM games WHERE ended_at IS NOT NULL AND beasts IS NULL AND ${RECORDED}`).all() as { id: number }[])
  db.prepare("UPDATE games SET beasts = ? WHERE id = ?").run(slain(id), id);

export function loadStrategy(text = readFileSync(promptFile, "utf8")) {
  const full = `${DECIDER === "rules" ? "rules" : DECIDER === "jev" ? JEV_MODEL : `${MODEL} effort ${EFFORT}`}\n\n${PREAMBLE}\n\n${text}`;
  const hash = createHash("sha256").update(full).update(DECIDER === "model" ? "" : DECIDER_SOURCE).digest("hex").slice(0, 8);
  const [common, ...rest] = text.split(/^<!-- phase:(\w+) -->$/m);
  const sections: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) sections[rest[i]] = rest[i + 1].trim();
  return { hash, text: full, rules: (p: Phase) => [common.trim(), sections[p] ?? ""].filter(Boolean).join("\n\n") };
}

async function open(practiceId: string | undefined, seed: number, entry?: Entry, resumed?: string): Promise<Seat> {
  const strategy = loadStrategy();
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(strategy.hash, strategy.text, Date.now());
  const funds = () => (practiceId || resumed ? null : Promise.all([strkBalance(), balanceOf(SURVIVOR)]).then((held) => held.map(Number), () => null));
  const before = await funds();
  const table = await begin(practiceId, seed, entry, resumed);
  const after = await funds();
  const id = table.game.id;
  const mode = practiceId ? "practice" : DUNGEON_KEY;
  const known = practiceId ? undefined : (db.prepare("SELECT id FROM games WHERE game_id = ? AND mode = ?").get(id, mode) as { id: number } | undefined);
  const row = known?.id ?? Number(db.prepare("INSERT INTO games (mode, game_id, seed, strategy, started_at) VALUES (?, ?, ?, ?, ?)").run(mode, id, seed, strategy.hash, Date.now()).lastInsertRowid);
  if (known) db.prepare("UPDATE games SET ended_at = NULL WHERE id = ?").run(row);
  if (before !== null && after !== null) db.prepare("UPDATE games SET gas_strk = coalesce(gas_strk, 0) + ?, survivor = coalesce(survivor, 0) + ? WHERE id = ?").run((before[0] - after[0]) / 1e18, (before[1] - after[1]) / 1e18, row);
  table.row = row;
  emit({ kind: "status", text: `game ${row} on ${id.slice(-8)}`, row });
  return { table, row, rules: strategy.rules, state: current(table), note: "", rejected: "", rejections: 0, cost: 0 };
}

async function close(seat: Seat): Promise<void> {
  const { table, row, state } = seat;
  const drift = await auditGame(table).catch((err) => `audit failed: ${(err as Error).message.slice(0, 120)}`);
  if (drift) emit({ kind: "status", text: `CONTRACT MISMATCH: ${drift.slice(0, 300)}`, row });
  const ending = seat.ending ?? "stopped";
  db.prepare("UPDATE games SET ended_at = ?, level = ?, xp = ?, moves = ?, cost_usd = ?, ending = ?, mismatches = ?, beasts = ? WHERE id = ?").run(Date.now(), state.level, state.xp, table.game.packets.length, seat.cost, ending, Number(!!drift), slain(row), row);
  emit({ kind: "status", text: `game ${row} ${ending}`, row, ending });
  leave(table);
}

async function settle(seat: Seat): Promise<void> {
  const id = seat.table.game.id;
  const claimed = await collect(id);
  db.prepare("UPDATE games SET claimed = ? WHERE id = ?").run(claimed.beasts, seat.row);
  emit({ kind: "status", text: claimed.beasts ? `claimed ${claimed.beasts} beasts from ${id.slice(-8)} in ${claimed.transaction}` : `no beast to claim from ${id.slice(-8)}` });
  if (!claimed.beasts || !BEASTS_TO) return;
  const sent = await sendBeasts(BEASTS_TO);
  emit({ kind: "status", text: `sent ${sent.beasts} beasts to ${BEASTS_TO.slice(0, 8)} in ${sent.transaction}` });
}

async function decideWithRetry(row: number, state: State, rules: string, prompt: string, choices: Option[], attempts = 3): Promise<Decision> {
  for (let i = 1; ; i++) {
    try {
      if (DECIDER === "rules") {
        const { actions, why } = plan(state);
        return { thought: why, actions, note: "", reserve: 0, costUsd: 0 };
      }
      return DECIDER === "jev" ? await jevDecide(state, rules, prompt, choices) : await decide(rules, prompt);
    } catch (err) {
      if (i >= attempts || stopping) throw err;
      emit({ kind: "status", text: `decision retry ${i}: ${(err as Error).message.slice(0, 120)}`, row });
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

async function round(seats: Seat[]): Promise<void> {
  const moves: { seat: Seat; decision: Decision; actions: Action[] }[] = [];
  for (const seat of seats) {
    const { table, row, state } = seat;
    try {
      const choices = await options(table, state);
      const prompt = [render(state), describeOptions(state, choices), seat.note && `Your note from the previous decision: ${seat.note}`, seat.rejected].filter(Boolean).join("\n\n");
      const decision = await decideWithRetry(row, state, seat.rules(phase(state)), prompt, choices);
      seat.cost += decision.costUsd;
      const actions = shape(state, decision.actions as Action[], decision.reserve);
      emit({ kind: "decision", phase: phase(state), options: choices, thought: decision.thought, actions, note: decision.note, reserve: decision.reserve, costUsd: decision.costUsd, row });
      moves.push({ seat, decision, actions });
    } catch (err) {
      seat.ending = `failed: ${(err as Error).message.slice(0, 200)}`;
    }
  }
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
  const sent = moves.filter((m) => m.actions.length);
  const results = await commit(sent.map((m) => ({ table: m.seat.table, actions: m.actions })));
  for (const move of moves) {
    const { seat, decision, actions } = move;
    const result = sent.includes(move) ? results[sent.indexOf(move)] : { error: new Error("spend your stat points before anything else") };
    if ("error" in result) {
      seat.rejected = `Your last decision ${JSON.stringify(decision.actions)} was rejected by the game: ${result.error.message}. Choose again.`;
      emit({ kind: "rejected", actions, reason: result.error.message, row: seat.row });
      if (++seat.rejections === MAX_REJECTIONS) seat.ending = `stopped after ${MAX_REJECTIONS} rejected decisions`;
      continue;
    }
    const before = seat.state;
    const last = actions.at(-1)!.type;
    seat.state = result.state;
    if (result.strk) db.prepare("UPDATE games SET gas_strk = coalesce(gas_strk, 0) + ? WHERE id = ?").run(result.strk, seat.row);
    if (seat.state.over) seat.ending = `died at level ${seat.state.level} while ${DOING[last] ?? last} from ${before.health}/${before.maxHealth} HP${before.beast ? ` against ${before.beast.name} level ${before.beast.level}` : ""}`;
    Object.assign(seat, { note: decision.note, rejected: "", rejections: 0 });
  }
  const checked = seats.filter((seat) => seat.table.game.chain && !seat.ending && seat.table.game.packets.length <= LIVE_CHECK_MOVES);
  const drifts = await Promise.all(checked.map((seat) => auditGame(seat.table)));
  checked.forEach((seat, i) => drifts[i] && (seat.ending = "stopped: local state differs from the contract"));
}

export async function play(count: number, live: boolean, entry?: Entry): Promise<void> {
  if (busy) return;
  busy = true;
  stopping = false;
  const failed = (err: unknown) => emit({ kind: "status", text: `game failed: ${(err as Error).message}` });
  try {
    const seed = nextSeed();
    const resumed = live ? liveIds().slice(0, count) : [];
    const queue: (() => Promise<Seat>)[] = live
      ? [...resumed.map((id) => () => open(undefined, seed, entry, id)), ...Array.from({ length: count - resumed.length }, () => () => open(undefined, seed, entry))]
      : DUNGEON.benchmark.slice(0, count).map((id) => () => open(id, seed));
    const seats: Seat[] = [];
    const ended: { seat: Seat; due: number }[] = [];
    for (;;) {
      for (const done of ended.filter((e) => e.due <= Date.now() || !seats.length)) {
        await new Promise((r) => setTimeout(r, Math.max(0, done.due - Date.now())));
        ended.splice(ended.indexOf(done), 1);
        await settle(done.seat).catch(failed);
      }
      while (!stopping && queue.length && seats.length < (DECIDER === "rules" ? SEATS : 1)) await queue.shift()!().then((seat) => seats.push(seat), failed);
      if (!seats.length) break;
      await round(seats).catch((err) => seats.forEach((seat) => (seat.ending ??= `failed: ${(err as Error).message.slice(0, 200)}`)));
      for (const seat of seats.filter((s) => stopping || s.ending)) {
        await close(seat);
        seats.splice(seats.indexOf(seat), 1);
        if (seat.table.game.chain && seat.state.over) ended.push({ seat, due: Date.now() + CLAIM_DELAY_MS });
      }
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
