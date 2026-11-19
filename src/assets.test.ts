import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { ITEMS } from "./items.ts";

const art = (name: string) => new URL(`../web/assets/loot/${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`, import.meta.url);

test("every item has art on the page", () => {
  assert.deepEqual(ITEMS.filter((i) => !existsSync(art(i.name))).map((i) => i.name), []);
});
