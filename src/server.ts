import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { DUNGEON, DUNGEONS, HOST, PORT, STRK_FLOOR, SURVIVOR, TICKET, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { halt, play } from "./runner.ts";
import { enrich, snapshot } from "./play.ts";
import { balanceOf, keys, strkBalance } from "./wallet.ts";
import { inventory, pendingClaims } from "./beasts.ts";
import { liveRow, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
const CHECK = `${VAR_DIR}contract-check.json`;
const BAGS = `${VAR_DIR}bag-ranking.json`;
const GAMES = `SELECT *, CASE mode ${Object.entries(DUNGEONS).map(([k, d]) => `WHEN '${k}' THEN '${d.name}'`).join(" ")} END AS dungeon, mode IN (${Object.keys(DUNGEONS).map((k) => `'${k}'`)}) AS onchain, id IS ? AS live FROM games`;

async function json(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function reply(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const REACH = [26, 30, 35];

function strategies() {
  const rows = db.prepare("SELECT strategy, level FROM games WHERE ended_at IS NOT NULL AND mode = 'practice'").all() as { strategy: string; level: number }[];
  const versions = db.prepare("SELECT hash, created_at FROM strategies ORDER BY created_at DESC").all() as { hash: string; created_at: number }[];
  return versions
    .map((v) => {
      const levels = rows.filter((r) => r.strategy === v.hash).map((r) => r.level);
      return { ...v, games: levels.length, best: Math.max(0, ...levels), reach: REACH.map((level) => ({ level, share: levels.filter((l) => l >= level).length / levels.length })) };
    })
    .filter((s) => s.games > 0);
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

const beasts = cached(60_000, () => {
  const address = process.env.LS_BEASTS_ADDRESS ?? keys().address;
  const collections = Object.fromEntries(Object.entries(DUNGEONS).map(([key, d]) => [key, d.name]));
  return Promise.all([inventory(address), pendingClaims(address)]).then(
    ([held, claims]) => ({ address, collections, inventory: held, pendingClaims: claims }),
    () => ({ address, collections }),
  );
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const own = [HOST, "127.0.0.1", "::1"].includes((req.socket.remoteAddress ?? "").replace("::ffff:", ""));
  if (!own && (req.method !== "GET" || url.pathname === "/mcp")) return res.writeHead(403).end();
  if (url.pathname === "/api/me") return reply(res, { control: own });
  if (url.pathname === "/mcp") return handleMcp(req, res, req.method === "POST" ? await json(req) : undefined);
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(":\n\n");
    const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on("close", off);
    return;
  }
  if (url.pathname === "/api/play" && req.method === "POST") {
    const body = (await json(req)) as { games?: number; live?: boolean } | undefined;
    play(Number(body?.games) || (body?.live ? 1 : DUNGEON.benchmark.length), body?.live === true);
    return res.end("ok");
  }
  if (url.pathname === "/api/stop" && req.method === "POST") {
    halt();
    return res.end("ok");
  }
  if (url.pathname === "/api/state") return reply(res, snapshot() ?? null);
  if (url.pathname === "/api/games") return reply(res, db.prepare(`${GAMES} ORDER BY onchain DESC, id DESC LIMIT 200`).all(liveRow()));
  const id = Number(url.pathname.match(/^\/api\/games\/(\d+)$/)?.[1]);
  if (id) {
    const game = db.prepare(`${GAMES} WHERE id = ?`).get(liveRow(), id);
    if (!game) return res.writeHead(404).end();
    const events = (db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(id) as { body: string }[]).map((r) => JSON.parse(r.body));
    return reply(res, { game, events: events.map((e) => (e.kind === "state" ? { ...e, state: enrich(e.state) } : e)) });
  }
  if (url.pathname === "/api/strategies") return reply(res, strategies());
  if (url.pathname === "/api/wallet") return reply(res, await wallet());
  if (url.pathname === "/api/beasts") return reply(res, await beasts());
  if (url.pathname === "/api/bags") return reply(res, existsSync(BAGS) ? JSON.parse(readFileSync(BAGS, "utf8")) : []);
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
}
