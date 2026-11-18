import { createHash, randomBytes } from "node:crypto";
import { GAME_CORE } from "./config.ts";
import { decodeAdventurer, decodeBag, encodePacket, type Action, type Adventurer, type Item } from "./codec.ts";
import { provider } from "./wallet.ts";

export type Snapshot = { adventurer: Adventurer; bag: Item[]; over: boolean };
export type Game = { id: string; packets: bigint[] };

const FAR_BLOCK = 4_000_000_000n;

const randomHash = () => "0x" + randomBytes(31).toString("hex");
const luck = (game: Game, move: number) => "0x" + createHash("sha256").update(`${game.id}:${move}`).digest("hex").slice(0, 62);
export const hashes = (game: Game) => game.packets.map((_, i) => luck(game, i));

export async function replay(game: Game, packets = game.packets, luckHashes = hashes(game)): Promise<Snapshot> {
  const blocks = packets.map((_, i) => (FAR_BLOCK + BigInt(i)).toString());
  const calldata = [game.id, String(packets.length), ...packets.map(String), String(blocks.length), ...blocks, String(luckHashes.length), ...luckHashes, "0"];
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  const adventurer = decodeAdventurer(BigInt(out[3]));
  return { adventurer, bag: decodeBag(BigInt(out[4])), over: adventurer.health === 0 && packets.length > 0 };
}

export function newPracticeGame(id: string): Game {
  return { id, packets: [] };
}

export async function act(game: Game, actions: Action[]): Promise<Snapshot> {
  const packet = encodePacket(actions);
  const snapshot = await replay(game, [...game.packets, packet], [...hashes(game), luck(game, game.packets.length)]);
  game.packets.push(packet);
  return snapshot;
}

export async function preview(game: Game, actions: Action[], samples: number): Promise<Snapshot[]> {
  const packet = encodePacket(actions);
  return Promise.all(
    Array.from({ length: samples }, () => replay(game, [...game.packets, packet], [...hashes(game), randomHash()])),
  );
}

export function revertReason(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  const hexes = [...text.matchAll(/revert_error":"([^"]+)"/g)].flatMap((m) => m[1].split(/,\s*/));
  const words = hexes
    .map((h) => (/^0x[0-9a-f]+$/i.test(h) ? Buffer.from(h.slice(2).padStart(h.length % 2 ? h.length - 1 : h.length - 2, "0"), "hex").toString("latin1").replace(/[^\x20-\x7e]/g, "") : h))
    .filter((w) => w && w !== "ENTRYPOINT_FAILED");
  return words.length ? words.join("; ") : text.slice(0, 300);
}
