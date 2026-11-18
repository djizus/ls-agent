import { DUNGEON } from "../src/config.ts";
import { describe } from "../src/play.ts";
import { plan } from "../src/policy.ts";
import { act, newPracticeGame } from "../src/practice.ts";

const seeds = Number(process.argv[2] ?? 10);
const levels: number[] = [];
for (const id of DUNGEON.benchmark) {
  for (let seed = 0; seed < seeds; seed++) {
    const game = await newPracticeGame(id, seed);
    let state = describe(game.start, id);
    while (!state.over) state = describe(act(game, plan(state).actions), id);
    levels.push(state.level);
  }
}
const sorted = [...levels].sort((a, b) => a - b);
const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
const se = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length - 1) / levels.length);
const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))];
console.log(JSON.stringify({ games: levels.length, mean: +mean.toFixed(2), se: +se.toFixed(2), median: at(0.5), p10: at(0.1), p90: at(0.9), best: at(1) }));
