import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { VAR_DIR } from "./config.ts";

mkdirSync(VAR_DIR, { recursive: true });
export const db = new DatabaseSync(`${VAR_DIR}ls.sqlite`);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
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

const columns = (db.prepare("PRAGMA table_info(games)").all() as { name: string }[]).map((c) => c.name);
if (!columns.includes("seed")) db.exec("ALTER TABLE games ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
if (!columns.includes("ending")) db.exec("ALTER TABLE games ADD COLUMN ending TEXT");
if (!columns.includes("mismatches")) db.exec("ALTER TABLE games ADD COLUMN mismatches INTEGER NOT NULL DEFAULT 0");
