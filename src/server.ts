import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { HOST, PORT } from "./config.ts";
import { running, send } from "./agent.ts";
import { db } from "./db.ts";
import { halt, playGames } from "./runner.ts";
import { describe, snapshot } from "./play.ts";
import { emit, subscribe } from "./events.ts";
import { handleMcp } from "./mcp.ts";

const page = new URL("../web/index.html", import.meta.url).pathname;

async function json(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
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
      const games = Number(((await json(req)) as { games?: number })?.games ?? 1);
      playGames(games).then(() => emit({ kind: "status", text: "batch done" }));
      return res.end("ok");
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      halt();
      return res.end("ok");
    }
    if (url.pathname === "/api/state") {
      const s = snapshot();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(s ? describe(s) : null));
    }
    if (url.pathname === "/api/games") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(db.prepare("SELECT * FROM games ORDER BY id DESC LIMIT 200").all()));
    }
    if (url.pathname === "/api/say" && req.method === "POST") {
      send(String(((await json(req)) as { text?: string })?.text ?? ""));
      return res.end("ok");
    }
    if (url.pathname.startsWith("/assets/") && /^\/assets\/[a-z]+\/?[A-Za-z0-9_]*\.(png|svg)$/.test(url.pathname)) {
      const file = new URL(`../web${url.pathname}`, import.meta.url).pathname;
      if (!existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": file.endsWith(".svg") ? "image/svg+xml" : "image/png", "cache-control": "public, max-age=86400" });
      return res.end(readFileSync(file));
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(readFileSync(page));
    }
    res.writeHead(404).end();
  }).listen(PORT, HOST, () => console.log(`ls-agent on http://${HOST}:${PORT}`));
}
