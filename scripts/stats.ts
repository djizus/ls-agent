import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DUNGEONS, STRK, SURVIVOR, VAR_DIR } from "../src/config.ts";
import { usdPrice } from "../src/live.ts";
import { resultsSection, withResults } from "../src/results.ts";
import { ENDED, dungeonFigures, type Ended } from "../src/summary.ts";

const readme = new URL("../README.md", import.meta.url);
const baselines = JSON.parse(readFileSync(new URL("baseline.json", import.meta.url), "utf8"));
const ended = new DatabaseSync(`${VAR_DIR}ls.sqlite`, { readOnly: true }).prepare(ENDED).all() as Ended[];
const usd = await Promise.all([usdPrice(STRK), usdPrice(SURVIVOR)]);
const section = resultsSection(new Date().toISOString().slice(0, 10), baselines, dungeonFigures(ended, DUNGEONS, usd), DUNGEONS);
writeFileSync(readme, withResults(readFileSync(readme, "utf8"), section));
console.log(section);
