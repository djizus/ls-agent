import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { BAG_RANKING, BEASTS_TO, DUNGEONS, HOST, PORT, STRK, STRK_FLOOR, SURVIVOR, TICKET, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { halt, play, slain } from "./runner.ts";
import { enrich, namedKills, seated, snapshot } from "./play.ts";
import { balanceOf, keys, strkBalance } from "./wallet.ts";
import { affixes, claimableKill, inventory, pendingClaims, sellPrices, worth } from "./beasts.ts";
import { liveRows, subscribe } from "./events.ts";
import { forSale, poolIds, usdPrice } from "./live.ts";
import { handleMcp } from "./mcp.ts";
import { summary } from "./summary.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
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
  const ended = db.prepare("SELECT mode, level, beasts, claimed, gas_strk, survivor FROM games WHERE ended_at IS NOT NULL ORDER BY id DESC").all() as { mode: string; level: number; beasts: number | null; claimed: number | null; gas_strk: number | null; survivor: number | null }[];
  const mean = (values: number[]) => (values.length ? summary(values).mean : null);
  return Object.entries(DUNGEONS).map(([mode, d]) => {
    const games = ended.filter((g) => g.mode === mode);
    if (!games.length) return { mode, name: d.name, games: 0 };
    return {
      mode,
      name: d.name,
      games: games.length,
      mean: mean(games.map((g) => g.level)),
      best: summary(games.map((g) => g.level)).best,
      slain: mean(games.flatMap((g) => (g.beasts === null ? [] : [g.beasts]))),
      claimed: games.reduce((sum, g) => sum + (g.claimed ?? 0), 0),
      usd: price() ? games.reduce((sum, g) => sum + price()![0] * (g.gas_strk ?? 0) + price()![1] * (g.survivor ?? 0), 0) : null,
    };
  });
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
  return Promise.all([strkBalance(), balanceOf(TICKET), balanceOf(SURVIVOR)]).then(
    ([strk, tickets, survivor]) => ({ address, floor: STRK_FLOOR, strk: tokens(strk), tickets: tokens(tickets), survivor: tokens(survivor) }),
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

let ranking: ChildProcess | undefined;

function rankBags(): void {
  const done = () => (ranking = undefined);
  ranking ??= spawn(process.execPath, [new URL("../scripts/bench.ts", import.meta.url).pathname, "--rank", "--dungeon", "lootBag"], { stdio: "ignore" }).once("exit", done).once("error", done);
}

function bags() {
  const [ranked, ids] = [existsSync(BAG_RANKING) ? JSON.parse(readFileSync(BAG_RANKING, "utf8")) : [], pool()];
  return { rows: ids ? forSale(ranked, ids) : ranked, at: existsSync(BAG_RANKING) ? statSync(BAG_RANKING).mtimeMs : null, running: !!ranking };
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

const OWN = new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)));

async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const own = OWN.has((req.socket.remoteAddress ?? "").replace("::ffff:", ""));
  if (url.pathname === "/api/bags") {
    if (req.method === "POST") rankBags();
    return reply(res, bags());
  }
  if (!own && (req.method !== "GET" || url.pathname === "/mcp")) return res.writeHead(403).end();
  if (url.pathname === "/mcp") return handleMcp(req, res, req.method === "POST" ? await json(req) : undefined);
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(":\n\n");
    const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on("close", off);
    return;
  }
  if (url.pathname === "/api/play" && req.method === "POST") {
    const body = (await json(req)) as { games?: number; live?: boolean; dungeon?: string; bag?: number; maxSurvivor?: number } | undefined;
    const dungeon = body?.dungeon ?? "beast";
    if (!DUNGEONS[dungeon]) return res.writeHead(400).end(`dungeon is one of ${Object.keys(DUNGEONS).join(", ")}`);
    play(Number(body?.games) || (body?.live ? 1 : DUNGEONS[dungeon].benchmark.length), body?.live === true, dungeon, body?.bag ? { bag: Number(body.bag), maxSurvivor: Number(body.maxSurvivor) } : undefined);
    return res.end("ok");
  }
  if (url.pathname === "/api/stop" && req.method === "POST") {
    halt();
    return res.end("ok");
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
  if (url.pathname === "/api/wallet") return reply(res, await wallet());
  if (url.pathname === "/api/beasts") return reply(res, await beasts());
  if (url.pathname === "/api/items") return reply(res, ITEMS);
  if (url.pathname === "/api/check") return reply(res, existsSync(CHECK) ? JSON.parse(readFileSync(CHECK, "utf8")) : null);
  if (url.pathname.startsWith("/assets/") && /^\/assets\/[a-z]+\/?[A-Za-z0-9_]*\.(png|svg)$/.test(url.pathname)) {
    const file = new URL(`../web${url.pathname}`, import.meta.url).pathname;
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": file.endsWith(".svg") ? "image/svg+xml" : "image/png", "cache-control": "public, max-age=86400" });
    return res.end(readFileSync(file));
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  res.writeHead(404).end();
}

export function serve(): void {
  createServer((req, res) => void route(req, res).catch(() => res.writeHead(500).end())).listen(PORT, HOST, () => console.log(`ls-agent on http://${HOST}:${PORT}`));
  beasts();
  pool();
}
