import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { HOST, PORT, VAR_DIR } from "./config.ts";
import { db } from "./db.ts";
import { ITEMS } from "./items.ts";
import { halt, playBenchmark, running } from "./runner.ts";
import { snapshot } from "./play.ts";
import { subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";

const page = readFileSync(new URL("../web/index.html", import.meta.url));
const CHECK = `${VAR_DIR}contract-check.json`;

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
      res.write(`data: ${JSON.stringify({ kind: "status", text: running() ? "agent running" : "agent idle", at: Date.now() })}\n\n`);
      const off = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      req.on("close", off);
      return;
    }
    if (url.pathname === "/api/play" && req.method === "POST") {
      const games = Number(((await json(req)) as { games?: number })?.games) || undefined;
      playBenchmark(games);
      return res.end("ok");
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      halt();
      return res.end("ok");
    }
    if (url.pathname === "/api/state") return reply(res, snapshot() ?? null);
    if (url.pathname === "/api/games") return reply(res, db.prepare("SELECT * FROM games ORDER BY id DESC LIMIT 200").all());
    if (url.pathname === "/api/strategies") return reply(res, strategies());
    if (url.pathname === "/api/items") return reply(res, ITEMS);
    if (url.pathname === "/api/recent")
      return reply(res, (db.prepare("SELECT body FROM events WHERE game = (SELECT max(id) FROM games) ORDER BY rowid DESC LIMIT 40").all() as { body: string }[]).map((r) => JSON.parse(r.body)).reverse());
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
