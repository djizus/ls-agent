import { DatabaseSync } from "node:sqlite";
import type { Action } from "../src/codec.ts";
import { describe, render } from "../src/play.ts";
import { act, newPracticeGame, replay } from "../src/practice.ts";

const [file, ...ids] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: true });
const games = (ids.length ? ids.map((id) => db.prepare("SELECT * FROM games WHERE id = ?").get(Number(id))) : db.prepare("SELECT * FROM games WHERE ended_at IS NOT NULL").all()) as { id: number; game_id: string; level: number }[];

for (const g of games) {
  const events = (db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(g.id) as { body: string }[]).map((r) => JSON.parse(r.body));
  const game = newPracticeGame(g.game_id);
  let snap = await replay(game);
  const history: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const actions = e.kind === "decision" ? e.actions : e.kind === "tool" && e.name === "act" ? e.input : undefined;
    if (!actions) continue;
    if (events[i + 1]?.kind === "rejected" || (events[i + 1]?.kind === "result" && events[i + 1]?.name === "act")) continue;
    const before = describe(snap, g.game_id);
    history.push(`${render(before)}\n=> ${JSON.stringify(actions)}${e.thought ? `\n   thought: ${e.thought}` : ""}`);
    snap = await act(game, actions as Action[]);
  }
  console.log(`\n##### game ${g.id} level ${g.level}\n${history.slice(-3).join("\n---\n")}\n---\n${render(describe(snap, g.game_id))}`);
}
