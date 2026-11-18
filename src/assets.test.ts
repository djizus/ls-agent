import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { NAMES } from "./beast.ts";
import { ITEMS } from "./items.ts";

const art = (dir: string, name: string) => new URL(`../web/assets/${dir}/${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`, import.meta.url);

test("every beast and item has art on the dashboard", () => {
  assert.deepEqual(NAMES.filter((n) => !existsSync(art("beasts", n))), []);
  assert.deepEqual(ITEMS.filter((i) => !existsSync(art("loot", i.name))).map((i) => i.name), []);
});
