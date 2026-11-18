import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { VAR_DIR } from "./config.ts";

mkdirSync(VAR_DIR, { recursive: true });
export const db = new DatabaseSync(`${VAR_DIR}ls.sqlite`);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,
    game_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    level INTEGER,
    xp INTEGER,
    moves INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS strategies (
    hash TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    game INTEGER NOT NULL,
    at INTEGER NOT NULL,
    body TEXT NOT NULL
  );
`);
