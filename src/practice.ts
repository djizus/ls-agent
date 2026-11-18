import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GAME_CORE, VAR_DIR } from "./config.ts";
import { decodeAdventurer, decodeBag, encodePacket, type Action, type Adventurer, type Item } from "./codec.ts";
import { fromSnapshot, step, toSnapshot, type Local } from "./engine/engine.ts";
import { provider } from "./wallet.ts";

export type Snapshot = { adventurer: Adventurer; bag: Item[]; over: boolean };
export type Game = { id: string; seed: number; packets: bigint[]; start: Snapshot; local: Local };

const FAR_BLOCK = 4_000_000_000n;

const randomHash = () => "0x" + randomBytes(31).toString("hex");
const luck = (game: { id: string; seed?: number }, move: number) =>
  "0x" + createHash("sha256").update(game.seed ? `${game.id}:${game.seed}:${move}` : `${game.id}:${move}`).digest("hex").slice(0, 62);
export const hashes = (game: { id: string; seed?: number; packets: bigint[] }) => game.packets.map((_, i) => luck(game, i));

const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise<void>((r) => waiting.push(r));
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

async function call(request: Parameters<typeof provider.callContract>[0], attempt = 0): Promise<string[]> {
  try {
    return await limited(() => provider.callContract(request));
  } catch (err) {
    if (attempt >= 5 || !/rate limit|429|-32005/i.test(String((err as Error).message))) throw err;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return call(request, attempt + 1);
  }
}

export async function replay(game: { id: string; seed?: number; packets: bigint[] }, packets = game.packets, luckHashes = hashes(game)): Promise<Snapshot> {
  const blocks = packets.map((_, i) => (FAR_BLOCK + BigInt(i)).toString());
  const calldata = [game.id, String(packets.length), ...packets.map(String), String(blocks.length), ...blocks, String(luckHashes.length), ...luckHashes, "0"];
  const out = await call({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  const adventurer = decodeAdventurer(BigInt(out[3]));
  return { adventurer, bag: decodeBag(BigInt(out[4])), over: adventurer.health === 0 && packets.length > 0 };
}

const startsFile = `${VAR_DIR}starts.json`;
const starts = new Map<string, Snapshot>(existsSync(startsFile) ? Object.entries(JSON.parse(readFileSync(startsFile, "utf8"))) : []);

export async function newPracticeGame(id: string, seed = 0): Promise<Game> {
  if (!starts.has(id)) {
    starts.set(id, await replay({ id, packets: [] }));
    mkdirSync(VAR_DIR, { recursive: true });
    writeFileSync(startsFile, JSON.stringify(Object.fromEntries(starts)));
  }
  const start = starts.get(id)!;
  return { id, seed, packets: [], start, local: fromSnapshot(start) };
}

export function act(game: Game, actions: Action[]): Snapshot {
  const packet = encodePacket(actions);
  game.local = step(game.local, game.id, packet, luck(game, game.packets.length));
  game.packets.push(packet);
  return toSnapshot(game.local);
}

export function preview(game: Game, actions: Action[], samples: number): Snapshot[] {
  const packet = encodePacket(actions);
  return Array.from({ length: samples }, () => toSnapshot(step(game.local, game.id, packet, randomHash())));
}

export async function audit(game: Game): Promise<string | undefined> {
  const [local, contract] = [toSnapshot(game.local), await replay(game)];
  const same = JSON.stringify([local.adventurer, local.bag]) === JSON.stringify([contract.adventurer, contract.bag]);
  if (!same) return `after ${game.packets.length} moves the contract has ${JSON.stringify(contract.adventurer)}, local ${JSON.stringify(local.adventurer)}`;
}

export function revertReason(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  const hexes = [...text.matchAll(/revert_error":"([^"]+)"/g)].flatMap((m) => m[1].split(/,\s*/));
  const words = hexes
    .map((h) => (/^0x[0-9a-f]+$/i.test(h) ? Buffer.from(h.slice(2).padStart(h.length % 2 ? h.length - 1 : h.length - 2, "0"), "hex").toString("latin1").replace(/[^\x20-\x7e]/g, "") : h))
    .filter((w) => w && w !== "ENTRYPOINT_FAILED");
  return words.length ? words.join("; ") : text.slice(0, 300);
}
