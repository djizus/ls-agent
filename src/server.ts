import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { DUNGEON, DUNGEONS, HOST, PORT, STRK_FLOOR, SURVIVOR, TICKET, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { halt, play } from "./runner.ts";
import { enrich, snapshot } from "./play.ts";
import { balanceOf, keys, strkBalance } from "./wallet.ts";
import { inventory, pendingClaims, sellPrices, worth, type Prices } from "./beasts.ts";
import { liveRow, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";
import { summary } from "./summary.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
const CHECK = `${VAR_DIR}contract-check.json`;
const BAGS = new URL("../scripts/bag-ranking.json", import.meta.url);
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

const PRACTICE = "practice";

function figures() {
  const ended = db.prepare("SELECT mode, strategy, level, beasts, gas_strk FROM games WHERE ended_at IS NOT NULL ORDER BY id DESC").all() as { mode: string; strategy: string; level: number; beasts: number | null; gas_strk: number | null }[];
  const strategy = ended.find((g) => g.mode === PRACTICE)?.strategy ?? null;
  const groups = [...Object.entries(DUNGEONS).map(([mode, d]) => ({ mode, name: d.name, strategy: null as string | null })), { mode: PRACTICE, name: "Practice", strategy }];
  const mean = (values: number[]) => (values.length ? summary(values).mean : null);
  return groups.map((group) => {
    const games = ended.filter((g) => g.mode === group.mode && (!group.strategy || g.strategy === group.strategy));
    if (!games.length) return { ...group, games: 0 };
    const { median, best, "30+": reach30 } = summary(games.map((g) => g.level));
    return {
      ...group,
      games: games.length,
      median,
      mean: mean(games.map((g) => g.level)),
      best,
      reach30,
      slain: mean(games.flatMap((g) => (g.beasts === null ? [] : [g.beasts]))),
      strk: mean(games.flatMap((g) => (g.gas_strk === null ? [] : [g.gas_strk]))),
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

const prices = cached(600_000, () => sellPrices().catch((): Prices => ({})));

const beasts = cached(60_000, () => {
  const address = process.env.LS_BEASTS_ADDRESS ?? keys().address;
  const collections = Object.fromEntries(Object.entries(DUNGEONS).map(([key, d]) => [key, d.name]));
  return Promise.all([inventory(address), pendingClaims(address), prices() as Promise<Prices>]).then(
    ([held, claims, sell]) => ({
      address,
      groups: Object.entries(collections).map(([key, name]) => {
        const own = (held[key] ?? []).map((b) => ({ ...b, strk: worth(sell, b) }));
        const open = claims.filter((c) => c.collection === key).map((c) => ({ ...c, state: "claim", strk: worth(sell, c) }));
        const all = [...own, ...open].sort((a, b) => Number(a.state === "claim") - Number(b.state === "claim") || a.tier - b.tier || b.level - a.level);
        return { key, name, held: own.length, claims: open.length, strk: all.some((b) => b.strk !== null) ? all.reduce((n, b) => n + (b.strk ?? 0), 0) : null, beasts: all };
      }),
    }),
    () => ({ address }),
  );
});

const OWN = new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)));

async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const own = OWN.has((req.socket.remoteAddress ?? "").replace("::ffff:", ""));
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
    const body = (await json(req)) as { games?: number; live?: boolean; bag?: number; maxSurvivor?: number } | undefined;
    play(Number(body?.games) || (body?.live ? 1 : DUNGEON.benchmark.length), body?.live === true, body?.bag ? { bag: Number(body.bag), maxSurvivor: Number(body.maxSurvivor) } : undefined);
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
  if (url.pathname === "/api/summary") return reply(res, figures());
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
