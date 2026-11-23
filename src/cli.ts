#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawnSync } from "node:child_process";
import { DUNGEONS, HOST, PORT } from "./config.ts";
import { changes, chosen } from "./rules.ts";

const SERVICE = `http://${HOST}:${PORT}`;
type Event = { kind: string; text?: string; on?: boolean; row?: number; reason?: string };
type Command = { args: string; help: string; run: (args: string[]) => Promise<unknown> };

async function call(path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${SERVICE}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }).catch(() => {
    throw new Error(`no service answers on ${SERVICE}: start it with ls-agent start`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${path} answered ${res.status}`);
  return text;
}

const show = (text: string) => console.log(JSON.stringify(JSON.parse(text), null, 2));

async function follow(send: () => Promise<unknown>, end: (e: Event) => boolean): Promise<void> {
  const stream = await fetch(`${SERVICE}/events`).catch(() => {
    throw new Error(`no service answers on ${SERVICE}: start it with ls-agent start`);
  });
  const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
  const rows = new Set<number>();
  await send();
  let rest = "";
  for (let done = false; !done; ) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("the service closed the event stream");
    const lines = (rest + chunk.value).split("\n");
    rest = lines.pop()!;
    for (const line of lines.filter((l) => l.startsWith("data: "))) {
      const e = JSON.parse(line.slice(6)) as Event;
      if (e.row !== undefined) rows.add(e.row);
      if (e.kind === "status") console.log(e.text);
      if (e.kind === "cycle") console.log(`cycle: ${e.text}`);
      if (e.kind === "rejected") console.log(`game ${e.row} rejected: ${e.reason}`);
      done ||= end(e);
    }
  }
  await reader.cancel();
  for (const row of rows) {
    const { game } = JSON.parse(await call(`/api/games/${row}`));
    console.log(`game ${row}, ${game.dungeon ?? game.mode}: level ${game.level ?? "-"}, ${game.beasts ?? 0} named kills, ${game.claimed ?? 0} claimed, ${(game.gas_strk ?? 0).toFixed(2)} STRK gas, ${game.ending ?? "unfinished"}`);
  }
  await wallet();
}

async function wallet(): Promise<void> {
  const w = JSON.parse(await call("/api/wallet"));
  console.log(`wallet ${w.address}${w.deployed === false ? " (not deployed)" : ""}: ${w.strk ?? "?"} STRK, ${w.tickets ?? "?"} tickets, ${w.survivor ?? "?"} SURVIVOR`);
}

const batchDone = (e: Event) => e.kind === "status" && e.text === "batch done";
const cycleDone = (e: Event) => e.kind === "cycle" && e.on === false;

function seats(args: string[]): { practice?: boolean; seats: { dungeon: string; bag?: number; maxSurvivor?: number }[] } {
  const practice = args.includes("--practice");
  const cap = args.indexOf("--max");
  const maxSurvivor = cap >= 0 ? Number(args[cap + 1]) : undefined;
  const words = args.filter((a, i) => a !== "--practice" && (cap < 0 || (i !== cap && i !== cap + 1)));
  const out: { dungeon: string; bag?: number; maxSurvivor?: number }[] = [];
  let dungeon: string | undefined;
  for (const word of words) {
    if (DUNGEONS[word]) dungeon = word;
    else if (dungeon && /^\d+$/.test(word)) {
      if (DUNGEONS[dungeon].pool && !practice) out.push({ dungeon, bag: Number(word), maxSurvivor });
      else out.push(...Array.from({ length: Number(word) }, () => ({ dungeon: dungeon! })));
    } else throw new Error(`${word}? ${usage("play")}`);
  }
  return { practice: practice || undefined, seats: out };
}

const dungeons = Object.entries(DUNGEONS).map(([key, d]) => `${key} ${d.pool ? "<bag>..." : "<games>"}`).join(" | ");

function listRules(text: string): void {
  const { rules, shipped, strategy } = JSON.parse(text);
  for (const [name, value] of Object.entries(rules)) console.log(`${name} ${value}${value === shipped[name] ? "" : ` (shipped ${shipped[name]})`}`);
  console.log(`strategy ${strategy}`);
}

async function bench(args: string[]): Promise<void> {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dungeon = flag("--dungeon") ?? "beast";
  const d = DUNGEONS[dungeon];
  if (!d) throw new Error(`--dungeon is one of ${Object.keys(DUNGEONS).join(", ")}`);
  const games = Number(flag("--games") ?? 10_000);
  const candidate = changes(args.filter((a) => a.includes("=")));
  const base = await call("/api/rules").then((text) => JSON.parse(text).rules, () => chosen());
  const size = d.rolledStart ? ["--starts", String(games)] : ["--seeds", `0-${Math.ceil(games / d.benchmark.length)}`];
  const variants = [base, ...(Object.keys(candidate).length ? [{ ...base, ...candidate }] : [])].map((v) => JSON.stringify(v));
  const script = new URL("../scripts/bench.ts", import.meta.url).pathname;
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "--dungeon", dungeon, ...size, ...variants.flatMap((v) => ["--rules", v])], { stdio: "inherit" });
  if (run.status) throw new Error(`the bench stopped with ${run.status}`);
}

const commands: Record<string, Command> = {
  start: { args: "", help: "runs the service: the page, the API and every run, on the address of LS_HOST and LS_PORT", async run() {
    const { serve } = await import("./server.ts");
    serve();
  } },
  play: {
    args: `(${dungeons})... [--max <SURVIVOR a bag>] [--practice]`,
    help: "plays real games side by side, one seat each, and follows them until the batch is done; --practice plays benchmark starts for nothing, and lootBag then takes a count",
    run: (args) => follow(() => call("/api/play", seats(args)), batchDone),
  },
  cycle: { args: "", help: "runs one cycle, the Beast Mode games then the best bag, and follows it to its end", run: () => follow(() => call("/api/cycle", {}), cycleDone) },
  stop: { args: "", help: "stops the run and the cycle after the current move; unfinished games resume with the next run", run: () => call("/api/stop", {}).then(() => console.log("stopping after the current move")) },
  status: {
    args: "",
    help: "whether a run is going, its live games, and the cycle's last step",
    async run() {
      const s = JSON.parse(await call("/api/status"));
      console.log(s.running ? "a run is going" : "no run is going");
      for (const g of s.live) console.log(`game ${g.id}, ${g.dungeon}: level ${g.level ?? "-"}, ${g.beasts} named kills`);
      if (s.cycle.text) console.log(`cycle${s.cycle.on ? "" : ", last"}: ${s.cycle.text}`);
    },
  },
  logs: {
    args: "",
    help: "follows the run going now until its batch is done, or the cycle until its end",
    async run() {
      const s = JSON.parse(await call("/api/status"));
      if (!s.running && !s.cycle.on) return console.log("no run is going");
      await follow(async () => {}, s.cycle.on ? cycleDone : batchDone);
    },
  },
  rules: {
    args: "[set <rule>=<value>...]",
    help: "prints every rule the service plays with, marking those changed from src/rules.json, and the strategy id; set changes them in var/rules.json for every game started after, while games in progress keep theirs",
    async run([set, ...args]) {
      if (set !== undefined && (set !== "set" || !args.length)) throw new Error(usage("rules"));
      listRules(await (set ? call("/api/rules", { set: args }) : call("/api/rules")));
    },
  },
  bench: {
    args: "[<rule>=<value>...] [--dungeon <dungeon>] [--games <n>]",
    help: "plays the service's rules (else this checkout's) and the candidate on the same practice starts, 10k by default, nothing on chain, and prints each with the difference and its standard error",
    run: bench,
  },
  wallet: { args: "", help: "the wallet's address, whether it is deployed, and its STRK, tickets and SURVIVOR", run: wallet },
  deploy: { args: "", help: "deploys the wallet's account, after STRK was sent to its address", run: () => call("/api/deploy", {}).then(show) },
  bag: { args: "<bag> [address]", help: "a bag's price, whether the pool holds it, and a simulated purchase from the wallet or the address", run: ([bag, address]) => call("/api/bag", { bag, address }).then(show) },
  beasts: { args: "[address]", help: "the beasts the wallet or the address holds, staked and to claim", run: ([address]) => call("/api/holdings", { address }).then(show) },
  collect: { args: "<game id>", help: "settles a game and claims its beasts, which runs do by themselves a minute after a game ends", run: ([game]) => call("/api/collect", { game }).then(show) },
  quote: { args: "<game id>", help: "what settling a game would cost, simulated", run: ([game]) => call("/api/quote", { game }).then(show) },
  "send-beasts": { args: "<address>", help: "sends every beast the wallet holds to the address", run: ([to]) => call("/api/send-beasts", { to }).then(show) },
};

function usage(name?: string): string {
  const list = Object.entries(commands).filter(([n]) => !name || n === name);
  const width = Math.max(...list.map(([n, c]) => `${n} ${c.args}`.length));
  return [`usage: ls-agent <command>, talking to the service on ${SERVICE}`, ...list.map(([n, c]) => `  ${`${n} ${c.args}`.padEnd(width)}  ${c.help}`)].join("\n");
}

const [name, ...args] = process.argv.slice(2);
const command = commands[name ?? ""];
if (!command) {
  console.log(usage());
  process.exit(name === undefined || name === "--help" || name === "-h" ? 0 : 1);
}
try {
  await command.run(args);
  if (name !== "start") process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
