import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { request } from "./net.ts";

test("a rate-limited request is sent again until the node answers", async () => {
  let hits = 0;
  const server = createServer((_, res) => {
    hits++;
    res.end(hits < 3 ? JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Rate limit exceeded" } }) : JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7" }));
  }).listen(0);
  try {
    const res = await request(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { method: "POST", body: "{}" });
    assert.deepEqual([hits, await res.json()], [3, { jsonrpc: "2.0", id: 1, result: "0x7" }]);
  } finally {
    server.close();
  }
});
