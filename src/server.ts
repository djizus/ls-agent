import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { PORT } from "./config.ts";
import { running, send, start, stop } from "./agent.ts";
import { subscribe } from "./events.ts";
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
    if (url.pathname === "/api/start" && req.method === "POST") {
      start();
      return res.end("ok");
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      stop();
      return res.end("ok");
    }
    if (url.pathname === "/api/say" && req.method === "POST") {
      send(String(((await json(req)) as { text?: string })?.text ?? ""));
      return res.end("ok");
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(readFileSync(page));
    }
    res.writeHead(404).end();
  }).listen(PORT, "127.0.0.1", () => console.log(`ls-agent on http://127.0.0.1:${PORT}`));
}
