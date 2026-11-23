import assert from "node:assert/strict";
import { test } from "node:test";
import { beastArt, icon, lootArt, statArt } from "../web/art.js";
import { LOOT_NAMES, NAMES } from "./beast.ts";
import { STATS } from "./codec.ts";
import { ITEMS } from "./items.ts";

async function missing(urls: string[]): Promise<string[]> {
  const gone: string[] = [];
  for (let i = 0; i < urls.length; i += 10) {
    await Promise.all(
      urls.slice(i, i + 10).map(async (url) => {
        const res = await fetch(url, { method: "HEAD" });
        if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) gone.push(url);
      }),
    );
  }
  return gone.sort();
}

test("every item has art on the site", async () => {
  assert.deepEqual(await missing(ITEMS.map((i) => lootArt(i.name))), []);
});

test("every beast of each collection has a portrait", async () => {
  assert.deepEqual(await missing([...NAMES.map((n) => beastArt(n, "beast")), ...LOOT_NAMES.map((n) => beastArt(n, "lootBag"))]), []);
});

test("every ability has an icon on the site", async () => {
  assert.deepEqual(await missing(STATS.map(statArt)), []);
});

test("every icon the page shows is on the site", async () => {
  assert.deepEqual(await missing(Object.values(icon)), []);
});
