import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

type Rpc = { jsonrpc: string; id: number | string; method: string; params?: unknown };
type RpcAnswer = { result?: unknown; error?: { code: number; message: string } };
type Plain = { status: number; body: string; type?: string };
type Answer = RpcAnswer | Plain;

const TAPE = new URL("./tape.json", import.meta.url);
export const OFFLINE = "tests do not reach the network";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const mode = process.env.LS_TAPE;
const tape: Record<string, Answer> = existsSync(TAPE) ? JSON.parse(readFileSync(TAPE, "utf8")) : {};
const fresh: Record<string, Answer> = {};
const live = globalThis.fetch;
const connect = net.Socket.prototype.connect;

const urlOf = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input));
const plainKey = (url: URL, init?: RequestInit) => `${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`;
const rpcKey = (r: Rpc) => `${r.method} ${JSON.stringify(r.params ?? [])}`;
const limited = (a: RpcAnswer) => a.error?.code === -32005;

function parse(body: unknown): Rpc | Rpc[] | null {
  try {
    const value = JSON.parse(String(body));
    return [value].flat().every((r) => r?.jsonrpc && r.method) ? value : null;
  } catch {
    return null;
  }
}

function recorded(key: string): Answer {
  const answer = tape[key];
  if (!answer) throw new Error(`${OFFLINE}: no recorded answer for ${key.slice(0, 200)}; run npm run record`);
  return answer;
}

async function replay(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  if (LOOPBACK.has(url.hostname)) return live(input, init);
  const rpc = parse(init?.body);
  if (!rpc) {
    const answer = recorded(plainKey(url, init)) as Plain;
    return new Response(answer.body, { status: answer.status, headers: answer.type ? { "content-type": answer.type } : {} });
  }
  const one = (r: Rpc) => ({ jsonrpc: "2.0", id: r.id, ...recorded(rpcKey(r)) });
  return Response.json(Array.isArray(rpc) ? rpc.map(one) : one(rpc));
}

async function record(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  const res = await live(input, init);
  if (LOOPBACK.has(url.hostname)) return res;
  const body = await res.text();
  const rpc = parse(init?.body);
  if (!rpc && res.status !== 429) fresh[plainKey(url, init)] = { status: res.status, body, type: res.headers.get("content-type") ?? "" };
  if (rpc && res.status !== 429) {
    const answers = [JSON.parse(body)].flat() as (Rpc & RpcAnswer)[];
    for (const r of [rpc].flat()) {
      const found = answers.find((a) => a.id === r.id);
      if (found && !limited(found)) fresh[rpcKey(r)] = "error" in found ? { error: found.error } : { result: found.result };
    }
  }
  return new Response(body, { status: res.status, headers: res.headers });
}

function save(): void {
  if (!Object.keys(fresh).length) return;
  const all = { ...(existsSync(TAPE) ? JSON.parse(readFileSync(TAPE, "utf8")) : {}), ...fresh };
  const lines = Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  writeFileSync(TAPE, `{\n${lines.join(",\n")}\n}\n`);
}

function local(args: unknown[]): boolean {
  const [first, second] = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: string; path?: string };
    return !!o.path || LOOPBACK.has(o.host ?? "localhost");
  }
  return typeof first === "string" || LOOPBACK.has(typeof second === "string" ? second : "localhost");
}

if (mode === "record" || mode === "live") {
  globalThis.fetch = record;
  if (mode === "record") process.on("exit", save);
} else {
  globalThis.fetch = replay;
  globalThis.WebSocket = class {
    constructor() {
      throw new Error(OFFLINE);
    }
  } as unknown as typeof WebSocket;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    if (!local(args)) throw new Error(OFFLINE);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as never;
}
