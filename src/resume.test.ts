import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

const dir = `${mkdtempSync(`${tmpdir()}/ls-resume-`)}/`;
process.env.LS_VAR_DIR = dir;
const PLAYED = "0x0100000000001efb00000400000000060000000001c878ba01144c53000b1e41";

test("a Loot Bag game recorded in live.json resumes from the chain without buying a bag or making a wallet", async () => {
  writeFileSync(`${dir}live.json`, JSON.stringify({ ids: [PLAYED] }));
  const { liveGame, liveIds } = await import("./live.ts");
  const { toSnapshot } = await import("./engine/engine.ts");
  const { DUNGEONS } = await import("./config.ts");
  const game = await liveGame(DUNGEONS.lootBag, { bag: 7931, maxSurvivor: 0 }, liveIds()[0]);
  assert.equal(game.id, PLAYED);
  assert.equal(game.packets.length, 75);
  assert.equal(game.chain!.blocks.length, 75);
  assert.equal(toSnapshot(game.local).over, true);
  assert.deepEqual(JSON.parse(readFileSync(`${dir}live.json`, "utf8")), { ids: [PLAYED] });
  assert.equal(existsSync(`${dir}wallet.json`), false);
});
