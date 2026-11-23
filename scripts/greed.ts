import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { encodePacket, type Action } from "../src/codec.ts";
import { GREED } from "../src/config.ts";
import { step, toSnapshot, type Local } from "../src/engine/engine.ts";
import { useFastLuck } from "../src/hash.ts";
import { describe, type State } from "../src/play.ts";
import { RULES, plan } from "../src/policy.ts";
import { act, syntheticGame } from "../src/practice.ts";
import { provider } from "../src/wallet.ts";
import { PROCS, serve, spread } from "./workers.ts";

const { values } = parseArgs({
  options: {
    starts: { type: "string", default: "10000" },
    from: { type: "string", default: "0" },
    procs: { type: "string", default: PROCS },
    exit: { type: "string", multiple: true, default: ['{"rollouts":64,"horizon":6}'] },
    baseline: { type: "string", default: "10" },
    wager: { type: "string" },
    bankroll: { type: "string", default: "335" },
    games: { type: "string", default: "200" },
  },
});

const TOP_LEVEL = 40;
const MOVE_STRK = 0.02;
const ENTRY_STRK = 0.45;
const CASH_STRK = 0.3;
const LEVEL_MOVES = 40;
const MIN_ROLLOUTS = 8;
const ONE = 10n ** 18n;
const BANKROLL_RUNS = 20_000;
const DEFAULT_RULES = { ...RULES };

type Exit = { rollouts: number; horizon: number; margin: number; floor: number; clear: number; rules: Partial<typeof RULES> };
type Outcome = { back: number; moves: number; cashed: boolean };
type Played = { baseline: Outcome; foresight: Outcome; exits: Outcome[]; rollouts: number; decisions: number };
type Setup = { pay: number[]; wager: number };

const exits: Exit[] = values.exit.map((e) => ({ rollouts: 64, horizon: 6, margin: 0, floor: 6, clear: 3, rules: {}, ...JSON.parse(e) }));

async function setup(): Promise<Setup> {
  const call = async (entrypoint: string, calldata: string[] = []) => BigInt((await provider.callContract({ contractAddress: GREED.address, entrypoint, calldata }))[0]);
  const value = await call("txsh_value", [String(ONE), "0"]);
  const quotes = await Promise.all(Array.from({ length: TOP_LEVEL + 1 }, (_, l) => (l ? call("quote_reward_txsh", [String(ONE), String(l)]) : 0n)));
  const [least, most] = (await Promise.all([call("cost_to_play"), call("max_wager")])).map((x) => Number(x / 10n ** 15n) / 1000);
  const wager = values.wager === undefined ? most : Number(values.wager);
  if (!(wager >= least && wager <= most)) throw new Error(`--wager ${values.wager}: the contract takes ${least} to ${most} STRK`);
  return { pay: quotes.map((q) => Number((q * value) / ONE) / 1e18), wager };
}

const luck = (id: string, seed: number, move: number, rollout: number) => "0x" + createHash("sha256").update(`${id}:${seed}:${move}:${rollout}`).digest("hex").slice(0, 62);
const explores = (actions: Action[]) => actions.some((a) => a.type === "explore");
const back = ({ pay, wager }: Setup, level: number) => pay[Math.min(level, TOP_LEVEL)] * wager;

function cashNow(local: Local, s: State, id: string, seed: number, move: number, setup: Setup, exit: Exit, count: { rollouts: number }): boolean {
  if (s.level >= TOP_LEVEL) return true;
  const cash = (l: number) => back(setup, l) - CASH_STRK;
  const now = cash(s.level) + exit.margin * setup.wager;
  const sum = Array.from({ length: exit.horizon }, () => 0);
  const squares = Array.from({ length: exit.horizon }, () => 0);
  for (let r = 0; r < exit.rollouts; r++) {
    const later = Array.from({ length: exit.horizon }, () => 0);
    let l = local;
    let moves = 0;
    let reached = 0;
    while (reached < exit.horizon && moves < LEVEL_MOVES * exit.horizon) {
      const t = describe(toSnapshot(l), id);
      if (t.over) break;
      for (; reached < exit.horizon && t.level >= s.level + reached + 1; reached++) later[reached] = cash(t.level) - MOVE_STRK * moves;
      if (reached === exit.horizon) break;
      l = step(l, id, encodePacket(plan(t).actions), luck(id, seed, move + moves, r + 1));
      moves++;
    }
    for (let h = reached; h < exit.horizon; h++) later[h] = -MOVE_STRK * moves;
    for (let h = 0; h < exit.horizon; h++) {
      sum[h] += later[h];
      squares[h] += later[h] ** 2;
    }
    count.rollouts++;
    const n = r + 1;
    if (n < MIN_ROLLOUTS || n === exit.rollouts) continue;
    const bounds = sum.map((x, h) => {
      const mean = x / n;
      const se = Math.sqrt(Math.max(0, squares[h] / n - mean ** 2) / (n - 1));
      return [mean - exit.clear * se, mean + exit.clear * se];
    });
    if (bounds.some(([low]) => low > now)) return false;
    if (bounds.every(([, high]) => high < now)) return true;
  }
  return now >= Math.max(...sum) / exit.rollouts;
}

async function play(index: number, stop: (game: Awaited<ReturnType<typeof syntheticGame>>, s: State) => boolean, setup: Setup): Promise<Outcome> {
  const game = await syntheticGame(index, 1, GREED.settingsId);
  for (let s = describe(game.start, game.id); !s.over; ) {
    const { actions } = plan(s);
    if (explores(actions) && stop(game, s)) return { back: back(setup, s.level), moves: game.packets.length, cashed: true };
    s = describe(act(game, actions), game.id);
  }
  return { back: 0, moves: game.packets.length, cashed: false };
}

async function playOne(index: number, setup: Setup, baseline: number): Promise<Played> {
  Object.assign(RULES, DEFAULT_RULES);
  const worth = (o: Outcome) => o.back - MOVE_STRK * o.moves - (o.cashed ? CASH_STRK : 0);
  let foresight: Outcome = { back: 0, moves: 0, cashed: false };
  const end = await play(index, (game, s) => {
    const now = { back: back(setup, s.level), moves: game.packets.length, cashed: true };
    if (worth(now) > worth(foresight)) foresight = now;
    return false;
  }, setup);
  if (!foresight.cashed) foresight = end;
  const played: Played = { foresight, baseline: await play(index, (_, s) => s.level >= baseline, setup), exits: [], rollouts: 0, decisions: 0 };
  for (const exit of exits) {
    Object.assign(RULES, DEFAULT_RULES, exit.rules);
    played.exits.push(await play(index, (game, s) => s.level >= exit.floor && (played.decisions++, cashNow(game.local, s, game.id, game.seed, game.packets.length, setup, exit, played)), setup));
  }
  Object.assign(RULES, DEFAULT_RULES);
  return played;
}

if (process.send) {
  serve(async ({ starts, setup }: { starts: number[]; setup: Setup }) => {
    useFastLuck();
    const out: Played[] = [];
    for (const i of starts) out.push(await playOne(i, setup, Number(values.baseline)));
    return out;
  });
} else {
  const started = Date.now();
  const s = await setup();
  const procs = Number(values.procs);
  const starts = Array.from({ length: Number(values.starts) }, (_, i) => Number(values.from) + i);
  const played = (await spread<number, Played[]>(starts, procs, (share) => ({ starts: share, setup: s }))).flat();
  const n = played.length;
  const round = (x: number) => x.toFixed(1);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const se = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
  };
  const net = (o: Outcome) => o.back - s.wager - ENTRY_STRK - MOVE_STRK * o.moves - (o.cashed ? CASH_STRK : 0);
  console.log(`wager ${s.wager} STRK; gas ${ENTRY_STRK} to enter, ${MOVE_STRK} a move, ${CASH_STRK} to cash out; all figures in STRK per game; differences are paired on the same starts and luck`);
  console.log(`exit | move gas | cash gas | back | net mean ± se | vs fixed ± se | vs first ± se | median | died | cashed at a loss | cashed at a profit | p10 | p90 | best | broke within ${values.games} games from ${values.bankroll} | bankroll after them: p10, median, p90`);
  const fixed = played.map((p) => p.baseline);
  const bankroll = (nets: number[]) => {
    let seed = 1;
    const draw = () => nets[Math.floor(((seed = (seed * 48271) % 2147483647) / 2147483647) * nets.length)];
    const ends = Array.from({ length: BANKROLL_RUNS }, () => {
      let bank = Number(values.bankroll);
      for (let g = 0; g < Number(values.games); g++) {
        if (bank < s.wager + ENTRY_STRK) return { bank, broke: true };
        bank += draw();
      }
      return { bank, broke: false };
    });
    const banks = ends.map((e) => e.bank).sort((a, b) => a - b);
    return [`${((100 * ends.filter((e) => e.broke).length) / BANKROLL_RUNS).toFixed(1)}%`, [0.1, 0.5, 0.9].map((q) => Math.round(banks[Math.floor(q * BANKROLL_RUNS)])).join(", ")];
  };
  const report = (name: string, outcomes: Outcome[], first?: Outcome[]) => {
    const nets = outcomes.map(net);
    const sorted = [...nets].sort((a, b) => a - b);
    const paired = (other?: Outcome[]) => {
      if (!other || other === outcomes) return "-";
      const d = nets.map((x, i) => x - net(other[i]));
      return `${round(mean(d))} ± ${round(se(d))}`;
    };
    const share = (keep: (o: Outcome, i: number) => boolean) => `${((100 * outcomes.filter(keep).length) / n).toFixed(1)}%`;
    console.log(
      [name, mean(outcomes.map((o) => MOVE_STRK * o.moves)).toFixed(2), mean(outcomes.map((o) => (o.cashed ? CASH_STRK : 0))).toFixed(2), round(mean(outcomes.map((o) => o.back))),
        `${round(mean(nets))} ± ${round(se(nets))}`, paired(fixed), paired(first), round(sorted[n >> 1]), share((o) => !o.cashed),
        share((o, i) => o.cashed && nets[i] < 0), share((o, i) => o.cashed && nets[i] >= 0), round(sorted[Math.floor(n * 0.1)]), round(sorted[Math.floor(n * 0.9)]), round(sorted[n - 1]),
        ...bankroll(nets)].join(" | "),
    );
  };
  report(`fixed L${values.baseline}`, fixed);
  const first = played.map((p) => p.exits[0]);
  exits.forEach((e, i) => report(`state ${JSON.stringify(e)}`, played.map((p) => p.exits[i]), first));
  report("foresight", played.map((p) => p.foresight));
  const seconds = (Date.now() - started) / 1000;
  console.log(`${n} starts in ${seconds.toFixed(0)} s on ${procs} processes (${((1000 * seconds) / n).toFixed(0)} s per 1k starts), ${round(mean(played.map((p) => p.decisions)))} decisions and ${Math.round(mean(played.map((p) => p.rollouts)))} rollouts a game, fast luck`);
}
