import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a live run seats one game for each entry: each Loot Dungeon bag with its cap, each Beast Mode game, and an unfinished game in the seat that asks for its dungeon and bag", async () => {
  const { seating } = await import("./runner.ts");
  const unfinished = "0x0100000000001e7e00000400000000060000000001c878b901144c4a000161c1";
  const run = { seats: [{ dungeon: "lootBag", bag: 7273, maxSurvivor: 100 }, { dungeon: "beast" }, { dungeon: "lootBag", bag: 7806, maxSurvivor: 90 }, { dungeon: "lootBag", bag: 3378, maxSurvivor: 100 }, { dungeon: "beast" }] };
  assert.deepEqual(seating(run, [unfinished]), [
    { dungeon: "lootBag", resumed: unfinished },
    { dungeon: "lootBag", entry: { bag: 7273, maxSurvivor: 100 } },
    { dungeon: "lootBag", entry: { bag: 3378, maxSurvivor: 100 } },
    { dungeon: "beast", entry: undefined },
    { dungeon: "beast", entry: undefined },
  ]);
  assert.equal(seating({ seats: [{ dungeon: "lootBag", bag: 7273 }, { dungeon: "lootBag", bag: 7273 }] }, []), "bag 7273 is asked twice: one seat a bag");
  assert.equal(seating({ seats: [{ dungeon: "lootBag" }] }, []), "a Loot Bag seat needs its bag");
  assert.equal(seating({ seats: [{ dungeon: "beast", bag: 7273 }] }, []), "a Beast Mode seat takes no bag");
});

test("a run with a bag the pool does not hold is refused before anything is bought, and starts no game", async () => {
  const { play, running } = await import("./runner.ts");
  const { db } = await import("./db.ts");
  rmSync(`${process.env.LS_VAR_DIR}live.json`, { force: true });
  const before = db.prepare("SELECT count(*) AS n FROM games").get();
  const run = await play({ seats: [{ dungeon: "beast" }, { dungeon: "lootBag", bag: 99999, maxSurvivor: 100 }] });
  assert.deepEqual(run, { refused: "the pool holds no game of bag 99999" });
  assert.equal(running(), false);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM games").get(), before);
});
