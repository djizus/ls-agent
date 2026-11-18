import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { db } from "../src/db.ts";

type Game = { id: number; mode: string; game_id: string; strategy: string; started_at: number; ended_at: number | null; level: number; xp: number; moves: number; cost_usd: number };

let added = 0;
for (const dir of process.argv.slice(2)) {
  const source = new DatabaseSync(`${dir.replace(/\/$/, "")}/ls.sqlite`, { readOnly: true });
  for (const g of source.prepare("SELECT * FROM games WHERE ended_at IS NOT NULL").all() as Game[]) {
    if (db.prepare("SELECT 1 FROM games WHERE game_id = ? AND started_at = ?").get(g.game_id, g.started_at)) continue;
    const id = db
      .prepare("INSERT INTO games (mode, game_id, strategy, started_at, ended_at, level, xp, moves, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(g.mode, g.game_id, g.strategy, g.started_at, g.ended_at, g.level, g.xp, g.moves, g.cost_usd).lastInsertRowid;
    for (const e of source.prepare("SELECT at, body FROM events WHERE game = ?").all(g.id) as { at: number; body: string }[])
      db.prepare("INSERT INTO events (game, at, body) VALUES (?, ?, ?)").run(id, e.at, e.body);
    added++;
  }
}
console.log(`imported ${added} games`);

const git = (...args: string[]) => execFileSync("git", args, { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
for (const line of git("log", "--format=%H %ct", "--", "strategy/prompt.md").trim().split("\n")) {
  const [commit, time] = line.split(" ");
  const text = git("show", `${commit}:strategy/prompt.md`);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  db.prepare("INSERT OR IGNORE INTO strategies (hash, text, created_at) VALUES (?, ?, ?)").run(hash, text, Number(time) * 1000);
}
