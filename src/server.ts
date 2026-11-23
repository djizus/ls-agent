import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { BAG_RANKING, BEASTS_TO, DUNGEONS, HOST, PORT, STRK, STRK_FLOOR, SURVIVOR, TICKET, TOKEN, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { z } from "zod";
import { RUN, play, running, slain } from "./runner.ts";
import { CYCLE, cycleStatus, startCycle, stopCycle } from "./cycle.ts";
import { enrich, namedKills, seated, snapshot } from "./play.ts";
import { balanceOf, deploy, isDeployed, keys, strkBalance } from "./wallet.ts";
import { affixes, claimableKill, inventory, pendingClaims, sellPrices, worth } from "./beasts.ts";
import { emit, liveRows, subscribe } from "./events.ts";
import { SHIPPED, choose, chosen, version } from "./rules.ts";
import { bagMarket, bagOf, bagReport, collect, forSale, poolIds, quote, sendBeasts, usdPrice } from "./live.ts";
import { ENDED, dungeonFigures, type Ended } from "./summary.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
const art = readFileSync(new URL("../web/art.js", import.meta.url));
const CHECK = `${VAR_DIR}contract-check.json`;
const games = () => `SELECT *, CASE mode ${Object.entries(DUNGEONS).map(([k, d]) => `WHEN '${k}' THEN '${d.name}'`).join(" ")} END AS dungeon, mode IN (${Object.keys(DUNGEONS).map((k) => `'${k}'`)}) AS onchain, id IN (${liveRows().join(",") || "NULL"}) AS live FROM games`;

async function json(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function reply(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const PRICE_MS = 600_000;
const price = background(PRICE_MS, () => Promise.all([usdPrice(STRK), usdPrice(SURVIVOR)]));

function figures() {
  return dungeonFigures(db.prepare(ENDED).all() as Ended[], DUNGEONS, price() ?? null);
}

const tokens = (n: bigint) => Number(n) / 1e18;

function cached(ttlMs: number, load: () => Promise<object>): () => Promise<object> {
  let held: { at: number; body: Promise<object> } | undefined;
  return () => {
    if (!held || Date.now() - held.at > ttlMs) held = { at: Date.now(), body: load() };
    return held.body;
  };
}

const wallet = cached(30_000, () => {
  const address = keys().address;
  return Promise.all([strkBalance(), balanceOf(TICKET), balanceOf(SURVIVOR), isDeployed()]).then(
    ([strk, tickets, survivor, deployed]) => ({ address, floor: STRK_FLOOR, deployed, strk: tokens(strk), tickets: tokens(tickets), survivor: tokens(survivor) }),
    () => ({ address, floor: STRK_FLOOR }),
  );
});

function background<T>(ttlMs: number, load: () => Promise<T>, idle: () => boolean = () => true): () => T | undefined | null {
  let held: T | undefined | null;
  let at = 0;
  let busy = false;
  return () => {
    if (!busy && Date.now() - at > ttlMs && idle()) {
      busy = true;
      at = Date.now();
      Promise.resolve()
        .then(load)
        .then((value) => (held = value), () => ((held ??= null), (at += RETRY_MS - ttlMs)))
        .finally(() => (busy = false));
    }
    return held;
  };
}

const BEASTS_MS = 600_000;
const RETRY_MS = 60_000;
const quiet = () => !liveRows().length;
const prices = background(BEASTS_MS, sellPrices, quiet);
const claimable = background(BEASTS_MS, () => pendingClaims(keys().address), quiet);
const collection = background(BEASTS_MS, () => inventory(BEASTS_TO ?? keys().address));

const verdicts = new Map<number, Map<string, boolean | null>>();

function openClaims(g: { id: number; mode: string }): number | null {
  const known = verdicts.get(g.id) ?? verdicts.set(g.id, new Map()).get(g.id)!;
  const blocks = seated(g.id)?.game.chain?.blocks ?? [];
  const events = (db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(g.id) as { body: string }[]).map((r) => JSON.parse(r.body));
  const kills = namedKills(events).map((b) => ({ ...affixes(g.mode, b), block: blocks[b.move] }));
  for (const k of kills) {
    const key = `${k.species}:${k.prefix}:${k.suffix}`;
    if (known.has(key) || k.block === undefined) continue;
    known.set(key, null);
    claimableKill(g.mode, keys().address, k, k.block).then((open) => known.set(key, open), () => setTimeout(() => known.delete(key), RETRY_MS));
  }
  const answers = [...new Set(kills.map((k) => `${k.species}:${k.prefix}:${k.suffix}`))].map((key) => known.get(key));
  return answers.every((open) => open != null) ? answers.filter(Boolean).length : null;
}

const POOL_MS = 60_000;
const pool = background(POOL_MS, () => poolIds(DUNGEONS.lootBag.pool!));
const bagPrice = background(POOL_MS, async () => {
  const ids = pool();
  if (!ids?.length) throw new Error("the pool is not read yet");
  return tokens((await bagMarket(DUNGEONS.lootBag.pool!, bagOf(ids[0]), ids)).quote.price);
});

let ranking: ChildProcess | undefined;

function rankBags(): void {
  const done = () => (ranking = undefined);
  ranking ??= spawn(process.execPath, [new URL("../scripts/bench.ts", import.meta.url).pathname, "--rank", "--dungeon", "lootBag"], { stdio: "ignore" }).once("exit", done).once("error", done);
}

function bags() {
  const [ranked, ids] = [existsSync(BAG_RANKING) ? JSON.parse(readFileSync(BAG_RANKING, "utf8")) : [], pool()];
  return { rows: ids ? forSale(ranked, ids) : ranked, price: bagPrice() ?? null, at: existsSync(BAG_RANKING) ? statSync(BAG_RANKING).mtimeMs : null, running: !!ranking };
}

function beasts() {
  const [held, claims, sell] = [collection(), claimable() ?? [], prices() ?? {}];
  const address = BEASTS_TO ?? keys().address;
  if (!held) return { address, failed: held === null };
  return {
    address,
    groups: Object.entries(DUNGEONS).map(([key, d]) => {
      const open = claims.filter((c) => c.collection === key).map((c) => ({ ...c, minted: 0, state: "claim" }));
      const all = [...open, ...(held[key] ?? []).sort((a, b) => b.minted - a.minted || a.tier - b.tier || b.level - a.level)].map((b) => ({ kind: b.kind, name: b.name, tier: b.tier, type: b.type, level: b.level, state: b.state, strk: worth(sell, b) }));
      const own = all.slice(open.length);
      const count = (state: string) => own.filter((b) => b.state === state).length;
      return {
        key,
        name: d.name,
        held: own.length,
        claims: open.length,
        tiers: [1, 2, 3, 4, 5].map((tier) => own.filter((b) => b.tier === tier).length),
        mega: count("mega"),
        staked: count("staked"),
        usd: price() && all.some((b) => b.strk !== null) ? price()![0] * all.reduce((n, b) => n + (b.strk ?? 0), 0) : null,
        beasts: all,
      };
    }),
  };
}

const TOOLS: Record<string, (body: Record<string, string>) => Promise<unknown>> = {
  "/api/deploy": () => deploy(),
  "/api/collect": async ({ game }) => (await collect(game)).transaction ?? "nothing to claim",
  "/api/quote": ({ game }) => quote(game),
  "/api/send-beasts": ({ to }) => sendBeasts(to),
  "/api/bag": ({ bag, address }) => bagReport(Number(bag), address ?? keys().address),
  async "/api/holdings"({ address = keys().address }) {
    const [beasts, claims] = await Promise.all([inventory(address), pendingClaims(address)]);
    return { address, inventory: beasts, pendingClaims: claims };
  },
};

const digest = (text: string) => createHash("sha256").update(text).digest();

function refusal(req: IncomingMessage): [number, string] | null {
  if (!TOKEN) return [403, "set LS_TOKEN to allow actions"];
  const given = req.headers.authorization;
  if (!given) return [401, "send the header Authorization: Bearer <LS_TOKEN>"];
  return timingSafeEqual(digest(given), digest(`Bearer ${TOKEN}`)) ? null : [401, "wrong token"];
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const refused = url.pathname === "/api/auth" || req.method !== "GET" ? refusal(req) : null;
  if (refused) return res.writeHead(refused[0]).end(refused[1]);
  if (url.pathname === "/api/auth") return res.writeHead(204).end();
  if (url.pathname === "/api/bags") {
    if (req.method === "POST") rankBags();
    return reply(res, bags());
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(":\n\n");
    const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on("close", off);
    return;
  }
  if (url.pathname === "/api/play" && req.method === "POST") {
    const run = RUN.safeParse(await json(req).catch(() => undefined));
    if (!run.success) return res.writeHead(400).end(z.prettifyError(run.error));
    if (cycleStatus().on) return res.writeHead(409).end("a cycle is running: wait for it to end, or stop it");
    const started = await play(run.data);
    return "refused" in started ? res.writeHead(409).end(started.refused) : res.end("ok");
  }
  if (url.pathname === "/api/cycle" && req.method === "POST") return startCycle() ? res.end("ok") : res.writeHead(409).end("a run or a cycle is going");
  if (url.pathname === "/api/stop" && req.method === "POST") {
    stopCycle();
    return res.end("ok");
  }
  if (url.pathname === "/api/rules" && req.method === "POST") {
    const body = (await json(req).catch(() => undefined)) as { set?: string[] } | undefined;
    try {
      choose(body?.set ?? []);
    } catch (err) {
      return res.writeHead(400).end((err as Error).message);
    }
  }
  if (url.pathname === "/api/rules") return reply(res, { rules: chosen(), shipped: SHIPPED, strategy: version(chosen()) });
  const tool = TOOLS[url.pathname];
  if (tool && req.method === "POST") {
    const body = ((await json(req).catch(() => undefined)) ?? {}) as Record<string, string>;
    return tool(body).then((out) => reply(res, out), (err: Error) => res.writeHead(500).end(err.message.slice(0, 500)));
  }
  if (url.pathname === "/api/status") {
    const rows = db.prepare(`SELECT id, dungeon, game_id FROM (${games()}) WHERE live ORDER BY id`).all() as { id: number }[];
    return reply(res, { running: running(), cycle: cycleStatus(), live: rows.map((g) => ({ ...g, level: snapshot(seated(g.id))?.level ?? null, beasts: slain(g.id) })) });
  }
  if (url.pathname === "/api/state") return reply(res, snapshot() ?? null);
  if (url.pathname === "/api/games") {
    const rows = db.prepare(`SELECT * FROM (${games()}) WHERE onchain ORDER BY id DESC`).all() as { id: number; live: number; mode: string; claimed: number | null }[];
    for (const g of rows) if (!g.live && g.claimed !== null) verdicts.delete(g.id);
    return reply(res, rows.map((g) => (g.live ? { ...g, beasts: slain(g.id), claimable: openClaims(g), level: snapshot(seated(g.id))?.level ?? null } : verdicts.has(g.id) ? { ...g, claimable: openClaims(g) } : g)));
  }
  const id = Number(url.pathname.match(/^\/api\/games\/(\d+)$/)?.[1]);
  if (id) {
    const game = db.prepare(`${games()} WHERE id = ?`).get(id);
    if (!game) return res.writeHead(404).end();
    const events = (db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(id) as { body: string }[]).map((r) => JSON.parse(r.body));
    return reply(res, { game, events: events.map((e) => (e.kind === "state" ? { ...e, state: enrich(e.state) } : e)) });
  }
  if (url.pathname === "/api/summary") return reply(res, figures());
  if (url.pathname === "/api/cycle") return reply(res, { ...cycleStatus(), ...CYCLE });
  if (url.pathname === "/api/wallet") return reply(res, { ...(await wallet()), usd: price() ?? null });
  if (url.pathname === "/api/beasts") return reply(res, await beasts());
  if (url.pathname === "/api/items") return reply(res, ITEMS);
  if (url.pathname === "/api/check") return reply(res, existsSync(CHECK) ? JSON.parse(readFileSync(CHECK, "utf8")) : null);
  if (url.pathname === "/art.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(art);
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  res.writeHead(404).end();
}

export function serve(): void {
  subscribe((e) => console.log(JSON.stringify(e)));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
  createServer((req, res) => void route(req, res).catch(() => res.writeHead(500).end())).listen(PORT, HOST, () => console.log(`ls-agent on http://${HOST}:${PORT}`));
  beasts();
  pool();
  emit({ kind: "status", text: "service up" });
}
