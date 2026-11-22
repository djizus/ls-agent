import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DUNGEONS, GAME_CORE, SYNTHETIC, VAR_DIR } from "./config.ts";
import { STATS, decodeAdventurer, decodeBag, encodePacket, type Action, type Adventurer, type Item } from "./codec.ts";
import { fromSnapshot, replayLocal, step, toSnapshot, type Local } from "./engine/engine.ts";
import { pinSpecials } from "./specials.ts";
import { provider } from "./wallet.ts";

export type Snapshot = { adventurer: Adventurer; bag: Item[]; over: boolean; specials?: string; log?: string[] };
export type Chain = { blocks: bigint[]; hashes: string[]; rolling: bigint };
export type Game = { id: string; seed: number; packets: bigint[]; start: Snapshot; local: Local; chain?: Chain };

const FAR_BLOCK = 4_000_000_000n;

export const randomHash = () => "0x" + randomBytes(31).toString("hex");
const luck = (game: { id: string; seed?: number }, move: number) =>
  "0x" + createHash("sha256").update(game.seed ? `${game.id}:${game.seed}:${move}` : `${game.id}:${move}`).digest("hex").slice(0, 62);
export const hashes = (game: { id: string; seed?: number; packets: bigint[]; chain?: Chain }) => game.chain?.hashes ?? game.packets.map((_, i) => luck(game, i));

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

const call = (request: Parameters<typeof provider.callContract>[0]): Promise<string[]> => limited(() => provider.callContract(request));

export async function replay(game: { id: string; seed?: number; packets: bigint[]; chain?: Chain }, packets = game.packets, luckHashes = hashes(game)): Promise<Snapshot> {
  const blocks = packets.map((_, i) => (game.chain?.blocks[i] ?? FAR_BLOCK + BigInt(i)).toString());
  const calldata = [game.id, String(packets.length), ...packets.map(String), String(blocks.length), ...blocks, String(luckHashes.length), ...luckHashes, "0"];
  const out = await call({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  const adventurer = decodeAdventurer(BigInt(out[3]));
  return { adventurer, bag: decodeBag(BigInt(out[4])), over: adventurer.health === 0 && packets.length > 0 };
}

const startsFile = `${VAR_DIR}starts.json`;
const starts = new Map<string, Snapshot>(existsSync(startsFile) ? Object.entries(JSON.parse(readFileSync(startsFile, "utf8"))) : []);

export async function startOf(id: string): Promise<Snapshot> {
  if (!starts.has(id)) {
    const [, , specials] = await call({ contractAddress: GAME_CORE, entrypoint: "get_start_override", calldata: [id] });
    starts.set(id, { ...(await replay({ id, packets: [] })), specials });
    mkdirSync(VAR_DIR, { recursive: true });
    writeFileSync(startsFile, JSON.stringify(Object.fromEntries(starts)));
  }
  const start = starts.get(id)!;
  pinSpecials(id, start.specials ?? 0n);
  return start;
}

export async function newPracticeGame(id: string, seed = 0): Promise<Game> {
  const start = await startOf(id);
  return { id, seed, packets: [], start, local: fromSnapshot(start) };
}

export async function syntheticGame(index: number, seed = 0): Promise<Game> {
  const template = await startOf(DUNGEONS.beast.benchmark[0]);
  const roll = createHash("sha256").update(`start:${index}`).digest();
  const stats = Object.fromEntries(STATS.map((s) => [s, 0])) as Adventurer["stats"];
  const points = STATS.reduce((n, s) => n + template.adventurer.stats[s], 0);
  for (let p = 0; p < points; p++) stats[STATS[roll.readUInt16BE(2 * p) % STATS.length]]++;
  const health = template.adventurer.health + 15 * (stats.vitality - template.adventurer.stats.vitality);
  const start = { ...template, adventurer: { ...template.adventurer, stats, health, level_salt: 1 + (roll.readUInt16BE(30) % 16383) } };
  return { id: "0x" + (SYNTHETIC + BigInt(index)).toString(16), seed, packets: [], start, local: fromSnapshot(start) };
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
  for (let moves = game.packets.length; moves > 0; moves = Math.floor(moves * 0.8)) {
    const [packets, luckHashes] = [game.packets.slice(0, moves), hashes(game).slice(0, moves)];
    let contract: Snapshot;
    try {
      contract = await replay(game, packets, luckHashes);
    } catch (err) {
      if (/out of gas/i.test(revertReason(err))) continue;
      throw err;
    }
    const local = replayLocal(game.start, game.id, packets, luckHashes);
    const same = JSON.stringify([local.adventurer, local.bag]) === JSON.stringify([contract.adventurer, contract.bag]);
    return same ? undefined : `after ${moves} moves the contract has ${JSON.stringify(contract.adventurer)}, local ${JSON.stringify(local.adventurer)}`;
  }
}

export function revertReason(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  const hexes = [...text.matchAll(/revert_error":"([^"]+)"/g)].flatMap((m) => m[1].split(/,\s*/));
  const words = hexes
    .map((h) => (/^0x[0-9a-f]+$/i.test(h) ? Buffer.from(h.slice(2).padStart(h.length % 2 ? h.length - 1 : h.length - 2, "0"), "hex").toString("latin1").replace(/[^\x20-\x7e]/g, "") : h))
    .filter((w) => w && w !== "ENTRYPOINT_FAILED");
  return words.length ? words.join("; ") : text.slice(0, 300);
}
