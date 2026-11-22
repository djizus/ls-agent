import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DUNGEONS } from "./config.ts";
import { benchTable, resultsSection, withResults } from "./results.ts";
import { dungeonFigures } from "./summary.ts";

const names = { beast: { name: "Beast Mode" }, lootBag: { name: "Loot Bag" } };
const game = (id: number, mode: string, level: number, beasts: number, claimed: number | null) => ({ id, mode, level, beasts, claimed, gas_strk: 1, survivor: null });
const section = resultsSection(
  "2026-11-22",
  { beast: { games: 10000, mean: 16.16, "30+": 8.7, named: 1.98 }, lootBag: { games: 10000, mean: 18.05, "30+": 9.7, named: 2.61 } },
  dungeonFigures([game(1, "beast", 12, 1, 0), game(2, "beast", 30, 4, 2), game(3, "beast", 30, 6, null), game(4, "practice", 50, 9, null)], names),
  names,
);

test("the Results section shows the benchmark and the real games per dungeon, with the record game", () => {
  assert.equal(section, [
    "## Results",
    "",
    "As of 2026-11-22. `npm run stats` writes this section.",
    "",
    "How the rules play on the local copy of the game, where games cost nothing:",
    "",
    "| Dungeon | Games | Average level | Reach level 30 | Named beasts a game |",
    "|---|---|---|---|---|",
    "| Beast Mode | 10,000 | 16.2 | 8.7% | 2 |",
    "| Loot Bag | 10,000 | 18.1 | 9.7% | 2.6 |",
    "",
    "How the real games went:",
    "",
    "| Dungeon | Games | Average level | Best level | Named beasts a game | Beasts claimed | Record game |",
    "|---|---|---|---|---|---|---|",
    "| Beast Mode | 3 | 24 | 30 | 3.7 | 2 | level 30, 6 named beasts |",
    "| Loot Bag | 0 | - | - | - | - | - |",
    "",
  ].join("\n"));
});

test("writing the section replaces only it, puts it before Run it yourself the first time, and a second run changes nothing", () => {
  const readme = "# ls-agent\n\nIntro.\n\n## What it costs\n\nSome.\n\n## Run it yourself\n\nSteps.\n";
  const once = withResults(readme, section);
  assert.equal(once, `# ls-agent\n\nIntro.\n\n## What it costs\n\nSome.\n\n${section}\n## Run it yourself\n\nSteps.\n`);
  assert.equal(withResults(once, section), once);
  assert.equal(withResults(once, section.replace("2026-11-22", "2026-12-01")), once.replace("2026-11-22", "2026-12-01"));
});

test("the README's benchmark table is the one scripts/baseline.json gives, so a new baseline needs npm run stats", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const baselines = JSON.parse(readFileSync(new URL("../scripts/baseline.json", import.meta.url), "utf8"));
  assert.ok(readme.includes(benchTable(baselines, DUNGEONS).join("\n")));
});
