import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

process.env.LS_VAR_DIR = `${mkdtempSync(`${tmpdir()}/ls-runner-`)}/`;

test("an unfinished game is resumed after a failure, and given up only at the third failure in a row", async () => {
  const { cleared, retry } = await import("./runner.ts");
  assert.deepEqual([retry("0xa"), retry("0xa"), retry("0xa")], [true, true, false]);
  assert.deepEqual([retry("0xb"), retry("0xb")], [true, true]);
  cleared("0xb");
  assert.deepEqual([retry("0xb"), retry("0xb"), retry("0xb")], [true, true, false]);
});

test("a batch settles every real game that ended unsettled and is not waiting to resume, each once its claim delay is over, and nothing else", async () => {
  const { unsettled } = await import("./runner.ts");
  const { db } = await import("./db.ts");
  const add = (mode: string, game: string, ended: number | null, claimed: number | null) =>
    Number(db.prepare("INSERT INTO games (mode, game_id, strategy, started_at, ended_at, claimed) VALUES (?, ?, 's', 1, ?, ?)").run(mode, game, ended, claimed).lastInsertRowid);
  const died = add("beast", "0x1", 2, null);
  const bag = add("lootBag", "0x2", 2, null);
  add("beast", "0x3", 2, 0);
  add("beast", "0x4", 2, 4);
  add("beast", "0x5", null, null);
  add("practice", "0x6", 2, null);
  add("legacy", "0x7", 2, null);
  add("beast", "0x8", 2, null);
  writeFileSync(`${process.env.LS_VAR_DIR}live.json`, JSON.stringify({ ids: ["0x8"] }));
  assert.deepEqual(unsettled().map((g) => ({ ...g })), [{ id: "0x1", row: died, due: 60_002 }, { id: "0x2", row: bag, due: 60_002 }]);
});
