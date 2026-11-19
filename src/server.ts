import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { DUNGEON, DUNGEONS, HOST, PORT, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { halt, play } from "./runner.ts";
import { snapshot } from "./play.ts";
import { liveRow, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
const CHECK = `${VAR_DIR}contract-check.json`;
const GAMES = `SELECT *, mode IN (${Object.keys(DUNGEONS).map((k) => `'${k}'`)}) AS onchain, id IS ? AS live FROM games`;

async function json(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

function reply(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function strategies() {
  const rows = db.prepare("SELECT strategy, level FROM games WHERE ended_at IS NOT NULL AND mode = 'practice'").all() as { strategy: string; level: number }[];
  const texts = db.prepare("SELECT hash, text, created_at FROM strategies").all() as { hash: string; text: string; created_at: number }[];
  return texts
    .map((t) => {
      const levels = rows.filter((r) => r.strategy === t.hash).map((r) => r.level).sort((a, b) => a - b);
      return { ...t, games: levels.length, median: levels[Math.floor(levels.length / 2)] ?? null, best: levels.at(-1) ?? null };
    })
    .filter((s) => s.games > 0)
    .sort((a, b) => b.created_at - a.created_at);
}

export function serve(): void {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
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
      const events = (db.prepare("SELECT body FROM events WHERE game = ? ORDER BY rowid").all(id) as { body: string }[]).map((r) => r.body);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(`{"game":${JSON.stringify(game)},"events":[${events.join(",")}]}`);
    }
    if (url.pathname === "/api/strategies") return reply(res, strategies());
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
  }).listen(PORT, HOST, () => console.log(`ls-agent on http://${HOST}:${PORT}`));
}
