import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
