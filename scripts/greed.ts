import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { encodePacket } from "../src/codec.ts";
import { GREED } from "../src/config.ts";
import { step, toSnapshot, type Local } from "../src/engine/engine.ts";
import { useFastLuck } from "../src/hash.ts";
import { describe } from "../src/play.ts";
import { RULES, plan } from "../src/policy.ts";
import { act, syntheticGame } from "../src/practice.ts";
import { provider } from "../src/wallet.ts";
import { PROCS, serve, spread } from "./workers.ts";

const { values } = parseArgs({
  options: {
    starts: { type: "string", default: "10000" },
    from: { type: "string", default: "0" },
    procs: { type: "string", default: PROCS },
    rules: { type: "string", default: "{}" },
    rollouts: { type: "string", default: "0" },
    wagers: { type: "string", default: "10,25,50,87" },
  },
});

const EXITS = [8, 9, 10, 11, 12, 13, 14];
const TOP_LEVEL = 40;
const MOVE_STRK = 0.02;
const ENTRY_STRK = 0.45;
const CLAIM_STRK = 0.3;
const FIRST_CHECK = 6;
const ROLLOUT_MOVES = 80;
const ONE = 10n ** 18n;

type Outcome = { pay: number; moves: number };
type Played = { fixed: Outcome[]; state?: Outcome };

async function payTable(): Promise<number[]> {
  const call = (entrypoint: string, calldata: string[]) => provider.callContract({ contractAddress: GREED.address, entrypoint, calldata });
  const [value] = await call("txsh_value", [String(ONE), "0"]);
  const levels = Array.from({ length: TOP_LEVEL + 1 }, (_, l) => l);
  const quotes = await Promise.all(levels.map(async (l) => (l ? BigInt((await call("quote_reward_txsh", [String(ONE), String(l)]))[0]) : 0n)));
  return quotes.map((q) => Number((q * BigInt(value)) / ONE) / 1e18);
}

function luck(id: string, seed: number, move: number, rollout: number): string {
  return "0x" + createHash("sha256").update(`${id}:${seed}:${move}:${rollout}`).digest("hex").slice(0, 62);
}

function cashNow(local: Local, id: string, seed: number, move: number, pay: number[], wager: number, rollouts: number): boolean {
  const level = describe(toSnapshot(local), id).level;
  if (level >= TOP_LEVEL) return true;
  let gained = 0;
  let spent = 0;
  for (let r = 0; r < rollouts; r++) {
    let l = local;
    for (let m = 0; m < ROLLOUT_MOVES; m++) {
      const s = describe(toSnapshot(l), id);
      if (s.over) break;
      if (s.level > level) {
        gained += pay[Math.min(s.level, TOP_LEVEL)];
        break;
      }
      l = step(l, id, encodePacket(plan(s).actions), luck(id, seed, move + m, r + 1));
      spent++;
    }
  }
  return pay[level] >= (gained - (MOVE_STRK * spent) / wager) / rollouts;
}

async function playOne(index: number, pay: number[], wager: number, rollouts: number): Promise<Played> {
  const game = await syntheticGame(index, 1, GREED.settingsId);
  let s = describe(game.start, game.id);
  const fixed: (Outcome | undefined)[] = EXITS.map(() => undefined);
  while (!s.over && fixed.some((f) => !f)) {
    EXITS.forEach((e, k) => (fixed[k] ??= s.level >= e ? { pay: pay[Math.min(s.level, TOP_LEVEL)], moves: game.packets.length } : undefined));
    if (fixed.every((f) => f)) break;
    s = describe(act(game, plan(s).actions), game.id);
  }
  const played: Played = { fixed: fixed.map((f) => f ?? { pay: 0, moves: game.packets.length }) };
  if (!rollouts) return played;
  const again = await syntheticGame(index, 1, GREED.settingsId);
  let t = describe(again.start, again.id);
  while (!t.over) {
    if (t.level >= FIRST_CHECK && cashNow(again.local, again.id, again.seed, again.packets.length, pay, wager, rollouts)) return { ...played, state: { pay: pay[Math.min(t.level, TOP_LEVEL)], moves: again.packets.length } };
    t = describe(act(again, plan(t).actions), again.id);
  }
  return { ...played, state: { pay: 0, moves: again.packets.length } };
}

const wagers = values.wagers.split(",").map(Number);
const rollouts = Number(values.rollouts);

if (process.send) {
  serve(async ({ starts, pay }: { starts: number[]; pay: number[] }) => {
    useFastLuck();
    Object.assign(RULES, JSON.parse(values.rules));
    const out: Played[] = [];
    for (const i of starts) out.push(await playOne(i, pay, Math.max(...wagers), rollouts));
    return out;
  });
} else {
  const started = Date.now();
  const pay = await payTable();
  const procs = Number(values.procs);
  const starts = Array.from({ length: Number(values.starts) }, (_, i) => Number(values.from) + i);
  const shares = await spread<number, Played[]>(starts, procs, (share) => ({ starts: share, pay }));
  const played = shares.flat();
  console.log(`rules ${values.rules}; pays per STRK wagered: ${EXITS.map((e) => `L${e} ${pay[e].toFixed(2)}`).join(", ")}; gas ${MOVE_STRK} a move, ${ENTRY_STRK} to enter, ${CLAIM_STRK} to cash out`);
  const report = (name: string, outcomes: Outcome[]) => {
    const cashed = outcomes.filter((o) => o.pay > 0);
    const columns = wagers.map((w) => {
      const r = outcomes.map((o) => o.pay - (MOVE_STRK * o.moves + ENTRY_STRK + (o.pay > 0 ? CLAIM_STRK : 0)) / w);
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
      return `${w} STRK: ${mean.toFixed(3)} ± ${(sd / Math.sqrt(r.length)).toFixed(3)} (sd ${sd.toFixed(2)})`;
    });
    console.log(`${name.padEnd(10)} cashed ${((100 * cashed.length) / outcomes.length).toFixed(1)}%, moves ${(outcomes.reduce((a, o) => a + o.moves, 0) / outcomes.length).toFixed(0)}; return per STRK wagered at ${columns.join(", ")}`);
  };
  EXITS.forEach((e, k) => report(`exit L${e}`, played.map((p) => p.fixed[k])));
  if (rollouts) report(`state ${rollouts}`, played.map((p) => p.state!));
  console.log(`${played.length} starts in ${((Date.now() - started) / 1000).toFixed(1)} s on ${procs} processes, fast luck`);
}
