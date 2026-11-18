import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { running, send, start, stop } from "./agent.ts";
import { db } from "./db.ts";
import { emit, subscribe } from "./events.ts";
import { levelOf } from "./items.ts";
import { currentGame, gameOver, reset, snapshot } from "./play.ts";

const promptFile = new URL("../strategy/prompt.md", import.meta.url).pathname;
const MAX_NUDGES = 5;

let row: number | undefined;
let remaining = 0;
let nudges = 0;
let cost = 0;
let done: (() => void) | undefined;

subscribe((e) => {
  if (row !== undefined) db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(row, e.at, JSON.stringify(e));
  if (e.kind !== "turn" || row === undefined) return;
  cost += e.costUsd;
  if (gameOver()) return finish();
  if (++nudges > MAX_NUDGES) return finish();
  send(currentGame() ? "Continue playing until the adventurer dies." : "Call new_game and play it until the adventurer dies.");
});

function strategyHash(): string {
  return createHash("sha256").update(readFileSync(promptFile)).digest("hex").slice(0, 8);
}

function begin(): void {
  reset();
  nudges = 0;
  cost = 0;
  row = Number(
    db.prepare("INSERT INTO games (mode, game_id, strategy, started_at) VALUES ('practice', '', ?, ?)").run(strategyHash(), Date.now()).lastInsertRowid,
  );
  start();
  send("Call new_game and play it until the adventurer dies.");
}

function finish(): void {
  const s = snapshot();
  db.prepare("UPDATE games SET game_id = ?, ended_at = ?, level = ?, xp = ?, moves = ?, cost_usd = ? WHERE id = ?").run(
    currentGame()?.id ?? "", Date.now(), s ? levelOf(s.adventurer.xp) : 0, s?.adventurer.xp ?? 0, currentGame()?.packets.length ?? 0, cost, row!,
  );
  emit({ kind: "status", text: `game ${row} finished at xp ${s?.adventurer.xp ?? 0}` });
  row = undefined;
  stop();
  if (--remaining > 0) setTimeout(begin, 1000);
  else done?.();
}

export function playGames(count: number): Promise<void> {
  if (running() || row !== undefined) return Promise.resolve();
  remaining = count;
  return new Promise((resolve) => {
    done = resolve;
    begin();
  });
}

export function halt(): void {
  remaining = 0;
  if (row !== undefined) finish();
}
