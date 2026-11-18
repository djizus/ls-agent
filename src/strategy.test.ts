import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../strategy/", import.meta.url);

test("strategy files hold choices only; game mechanics live in src/mechanics.ts", () => {
  for (const file of readdirSync(dir)) {
    const text = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(text, /^##\s*(How the game works|Mechanics|Decision format)/im, `${file} states mechanics or the decision format`);
  }
});
