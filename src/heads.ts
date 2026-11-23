import { WS_URL } from "./config.ts";

const SILENCE_MS = 2000;

let socket: WebSocket | undefined;
let waiting: (() => void)[] = [];

function wake(): void {
  for (const resolve of waiting.splice(0)) resolve();
}

function listen(): void {
  if (socket) return;
  const ws = (socket = new WebSocket(WS_URL));
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_subscribeNewHeads", params: {} }));
  ws.onmessage = (m) => {
    if (JSON.parse(String(m.data)).method) wake();
  };
  ws.onclose = ws.onerror = () => {
    if (socket === ws) socket = undefined;
    wake();
  };
}

export function nextHead(): Promise<void> {
  listen();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SILENCE_MS);
    waiting.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
