import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { LOOT_NAMES, NAMES } from "./beast.ts";
import { STATS } from "./codec.ts";
import { ITEMS } from "./items.ts";

const missing = (files: string[]) => files.filter((f) => !existsSync(new URL(`../web/assets/${f}`, import.meta.url)));

test("every item has art on the page", () => {
  assert.deepEqual(missing(ITEMS.map((i) => `loot/${i.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`)), []);
});

test("every beast has a portrait on the page", () => {
  assert.deepEqual(missing([...NAMES, ...LOOT_NAMES].map((n) => `beasts/${n.toLowerCase()}.png`)), []);
});

test("every ability has an icon on the page", () => {
  assert.deepEqual(missing(STATS.map((s) => `icons/${s[0].toUpperCase()}${s.slice(1)}.svg`)), []);
});
