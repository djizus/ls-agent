import type { Action } from "./codec.ts";
import { BEASTS_TO, DUNGEONS, SEATS, SURVIVOR, dungeonOf } from "./config.ts";
import { db } from "./db.ts";
import { adopt, collect, head, liveIds, mintedSince, sendBeasts, tickets, type Entry, type Starts } from "./live.ts";
import { balanceOf, strkBalance } from "./wallet.ts";
import { VERSION, plan } from "./policy.ts";
import { emit, subscribe } from "./events.ts";
import { type State, type Table, auditGame, begin, namedSlain, commit, current, leave, phase, shape } from "./play.ts";

const MAX_REJECTIONS = 3;
const LIVE_CHECK_MOVES = 100;
const CLAIM_DELAY_MS = 60_000;
const PACE_MS = Number(process.env.LS_PACE_MS ?? 0);

type Seat = { table: Table; row: number; state: State; rejections: number; ending?: string; failed?: string };

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

async function open(practiceId: string | undefined, seed: number, dungeon: string, entry?: Entry, resumed?: string, strk = 0): Promise<Seat> {
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(VERSION, `rules policy ${VERSION}`, Date.now());
  const funds = () => (practiceId || resumed ? null : Promise.all([strkBalance(), balanceOf(SURVIVOR)]).then((held) => held.map(Number), () => null));
  const before = await funds();
  const table = await begin(practiceId, seed, DUNGEONS[dungeon], entry, resumed);
  const after = await funds();
  const id = table.game.id;
  const mode = practiceId ? "practice" : dungeon;
  const known = practiceId ? undefined : (db.prepare("SELECT id FROM games WHERE game_id = ? AND mode = ?").get(id, mode) as { id: number } | undefined);
  const row = known?.id ?? Number(db.prepare("INSERT INTO games (mode, game_id, seed, strategy, started_at) VALUES (?, ?, ?, ?, ?)").run(mode, id, seed, VERSION, Date.now()).lastInsertRowid);
  if (known) db.prepare("UPDATE games SET ended_at = NULL WHERE id = ?").run(row);
  if (before !== null && after !== null) db.prepare("UPDATE games SET gas_strk = coalesce(gas_strk, 0) + ?, survivor = coalesce(survivor, 0) + ? WHERE id = ?").run((before[0] - after[0]) / 1e18, (before[1] - after[1]) / 1e18, row);
  if (strk) db.prepare("UPDATE games SET gas_strk = coalesce(gas_strk, 0) + ? WHERE id = ?").run(strk, row);
  table.row = row;
  emit({ kind: "status", text: `game ${row} on ${id.slice(-8)}`, row });
  return { table, row, state: current(table), rejections: 0 };
}

async function close(seat: Seat): Promise<void> {
  const { table, row, state } = seat;
  const drift = await auditGame(table).catch((err) => `audit failed: ${(err as Error).message.slice(0, 120)}`);
  if (drift) emit({ kind: "status", text: `CONTRACT MISMATCH: ${drift.slice(0, 300)}`, row });
  const ending = seat.ending ?? "stopped";
  db.prepare("UPDATE games SET ended_at = ?, level = ?, xp = ?, moves = ?, ending = ?, mismatches = ?, beasts = ? WHERE id = ?").run(Date.now(), state.level, state.xp, table.game.packets.length, ending, Number(!!drift), slain(row), row);
  emit({ kind: "status", text: `game ${row} ${ending}`, row, ending });
  leave(table);
}

export function unsettled(): { id: string; row: number; due: number }[] {
  const live = new Set(liveIds());
  const modes = Object.keys(DUNGEONS);
  return (db.prepare(`SELECT id AS row, game_id AS id, ended_at + ${CLAIM_DELAY_MS} AS due FROM games WHERE ended_at IS NOT NULL AND claimed IS NULL AND mode IN (${modes.map(() => "?").join(", ")}) ORDER BY id`).all(...modes) as { id: string; row: number; due: number }[]).filter((g) => !live.has(g.id));
}

async function settle(id: string, row: number): Promise<void> {
  const claimed = await collect(id);
  db.prepare("UPDATE games SET claimed = ? WHERE id = ? AND ended_at IS NOT NULL").run(claimed.beasts, row);
  emit({ kind: "status", text: claimed.beasts ? `claimed ${claimed.beasts} beasts from ${id.slice(-8)} in ${claimed.transaction}` : `no beast to claim from ${id.slice(-8)}` });
  if (!claimed.beasts || !BEASTS_TO) return;
  const sent = await sendBeasts(BEASTS_TO);
  emit({ kind: "status", text: `sent ${sent.beasts} beasts to ${BEASTS_TO.slice(0, 8)} in ${sent.transaction}` });
}

function nextSeed(benchmark: string[]): number {
  const played = db.prepare("SELECT seed, count(*) AS n FROM games WHERE strategy = ? AND ended_at IS NOT NULL GROUP BY seed ORDER BY seed").all(VERSION) as { seed: number; n: number }[];
  const complete = played.filter((p) => p.n >= benchmark.length).map((p) => p.seed);
  let seed = 0;
  while (complete.includes(seed)) seed++;
  return seed;
}

const DOING: Record<string, string> = { explore: "exploring", attack: "fighting", flee: "fleeing" };

async function round(seats: Seat[], starts: Starts | undefined): Promise<{ started: string[] | { error: Error }; strk: number }> {
  const moves: { seat: Seat; actions: Action[] }[] = [];
  for (const seat of seats) {
    const { row, state } = seat;
    try {
      const decision = plan(state);
      const actions = shape(state, decision.actions);
      emit({ kind: "decision", phase: phase(state), thought: decision.why, actions, row });
      moves.push({ seat, actions });
    } catch (err) {
      seat.failed = (err as Error).message.slice(0, 200);
    }
  }
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
  const sent = moves.filter((m) => m.actions.length);
  const { committed: results, started, strk } = await commit(sent.map((m) => ({ table: m.seat.table, actions: m.actions })), starts);
  for (const move of moves) {
    const { seat, actions } = move;
    const result = sent.includes(move) ? results[sent.indexOf(move)] : { error: new Error("spend your stat points before anything else") };
    if ("error" in result) {
      emit({ kind: "rejected", actions, reason: result.error.message, row: seat.row });
      if (++seat.rejections === MAX_REJECTIONS) seat.ending = `stopped after ${MAX_REJECTIONS} rejected decisions`;
      continue;
    }
    const before = seat.state;
    const last = actions.at(-1)!.type;
    seat.state = result.state;
    if (result.strk) db.prepare("UPDATE games SET gas_strk = coalesce(gas_strk, 0) + ? WHERE id = ?").run(result.strk, seat.row);
    if (seat.state.over) seat.ending = `died at level ${seat.state.level} while ${DOING[last] ?? last} from ${before.health}/${before.maxHealth} HP${before.beast ? ` against ${before.beast.name} level ${before.beast.level}` : ""}`;
    seat.rejections = 0;
  }
  const checked = seats.filter((seat) => seat.table.game.chain && !seat.ending && seat.table.game.packets.length <= LIVE_CHECK_MOVES);
  const drifts = await Promise.all(checked.map((seat) => auditGame(seat.table).catch(() => undefined)));
  checked.forEach((seat, i) => drifts[i] && (seat.ending = "stopped: local state differs from the contract"));
  return { started, strk };
}

const failures = new Map<string, number>();

export function retry(id: string): boolean {
  failures.set(id, (failures.get(id) ?? 0) + 1);
  return failures.get(id)! < MAX_REJECTIONS;
}

export const cleared = (id: string): void => void failures.delete(id);

export async function play(count: number, live: boolean, dungeon: string, entry?: Entry): Promise<void> {
  if (busy) return;
  busy = true;
  stopping = false;
  failures.clear();
  const failed = (err: unknown) => emit({ kind: "status", text: `game failed: ${(err as Error).message}` });
  const sweep = live ? (async () => { for (const g of unsettled()) await new Promise((r) => setTimeout(r, Math.max(0, g.due - Date.now()))).then(() => settle(g.id, g.row)).catch(failed); })().catch(failed) : undefined;
  try {
    const d = DUNGEONS[dungeon];
    const seed = nextSeed(d.benchmark);
    const resumed = live ? liveIds().filter((id) => dungeonOf(id) === dungeon).slice(0, count) : [];
    const queue: { practice?: string; resumed?: string }[] = live
      ? [...resumed.map((id) => ({ resumed: id })), ...Array.from({ length: count - resumed.length }, () => ({}))]
      : d.benchmark.slice(0, count).map((practice) => ({ practice }));
    const seats: Seat[] = [];
    const arrived: Seat[] = [];
    const opening = new Set<Promise<void>>();
    const ended: { seat: Seat; due: number }[] = [];
    const again = (id: string) => (retry(id) ? queue.unshift({ resumed: id }) : (queue.length = 0));
    const rides = live && !d.pool;
    const join = (id: string, strk = 0) => {
      const done = open(undefined, seed, dungeon, entry, id, strk)
        .then((seat) => void arrived.push(seat), (err) => (failed(err), void again(id)))
        .finally(() => opening.delete(done));
      opening.add(done);
    };
    const from = rides ? await head() : 0;
    const recorded = (id: string) => liveIds().includes(id) || !!db.prepare("SELECT 1 FROM games WHERE game_id = ? AND mode = ?").get(id, dungeon);
    let lost = false;
    for (;;) {
      seats.push(...arrived.splice(0));
      for (const id of lost ? (await mintedSince(from).catch(() => [])).filter((id) => !recorded(id)) : []) {
        adopt(id);
        const next = queue.findIndex((q) => !q.resumed);
        queue.splice(Math.max(0, next), Number(next >= 0), { resumed: id });
        emit({ kind: "status", text: `found game ${id.slice(-8)} started on chain and in no file: it takes the place of a new game` });
      }
      for (const done of ended.filter((e) => e.due <= Date.now() || (!seats.length && !opening.size))) {
        await new Promise((r) => setTimeout(r, Math.max(0, done.due - Date.now())));
        ended.splice(ended.indexOf(done), 1);
        await settle(done.seat.table.game.id, done.seat.row).catch(failed);
      }
      while (!stopping && queue.length && seats.length + opening.size < SEATS && (queue[0].resumed || !rides)) {
        const next = queue.shift()!;
        if (next.resumed) join(next.resumed);
        else await open(next.practice, seed, dungeon, entry).then((seat) => seats.push(seat), failed);
      }
      const free = SEATS - seats.length - opening.size;
      const wanted = rides && !stopping && free > 0 && queue.length && !queue[0].resumed ? Math.min(free, queue.length) : 0;
      const starts = wanted ? await tickets(wanted).catch((err) => (failed(err), 0)) : 0;
      if (!seats.length && !starts) {
        if (!opening.size) break;
        await Promise.race(opening);
        continue;
      }
      const { started } = stopping
        ? { started: [] }
        : await round(seats, starts ? { dungeon: d, games: starts } : undefined).then(
            (sent) => ({ started: "error" in sent.started ? sent.started : sent.started.map((id) => ({ id, strk: sent.strk })) }),
            (err: Error) => (seats.forEach((seat) => (seat.failed ??= err.message.slice(0, 200))), { started: starts ? { error: err } : [] }),
          );
      if ("error" in started) {
        lost = true;
        failed(started.error);
        if (!retry("start")) queue.length = 0;
      } else if (starts) {
        cleared("start");
        lost = false;
        queue.splice(0, started.length);
        for (const { id, strk } of started) join(id, strk);
      }
      for (const seat of [...seats]) {
        const { game } = seat.table;
        const unfinished = !!game.chain && !seat.state.over && !stopping;
        if (!seat.failed) cleared(game.id);
        if (!stopping && !seat.ending && !seat.failed) continue;
        seats.splice(seats.indexOf(seat), 1);
        if (seat.failed && unfinished && retry(game.id)) {
          leave(seat.table);
          queue.unshift({ resumed: game.id });
          emit({ kind: "status", text: `game ${seat.row} resumes from the chain after: ${seat.failed}` });
          continue;
        }
        if (seat.failed) seat.ending = `failed: ${seat.failed}`;
        await close(seat);
        if (unfinished) queue.length = 0;
        if (game.chain && seat.state.over) ended.push({ seat, due: Date.now() + CLAIM_DELAY_MS });
      }
    }
  } finally {
    await sweep;
    busy = false;
    emit({ kind: "status", text: "batch done" });
  }
}

export function halt(): void {
  stopping = true;
}

export function running(): boolean {
  return busy;
}
