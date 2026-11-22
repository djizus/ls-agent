import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { OFFLINE } from "./tape.ts";

test("a test cannot reach the network: requests answer only from the tape, sockets refuse", { skip: !!process.env.LS_TAPE }, async () => {
  await assert.rejects(fetch("https://example.invalid/"), new RegExp(OFFLINE));
  assert.throws(() => new WebSocket("wss://example.invalid/"), new RegExp(OFFLINE));
  assert.throws(() => net.connect(443, "example.invalid"), new RegExp(OFFLINE));
});
