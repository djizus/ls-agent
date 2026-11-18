import { randomBytes } from "node:crypto";
import { BEAST_MODE, GAME_API, GAME_CORE } from "./config.ts";
import { decodeAdventurer, decodeBag, encodePacket, type Action, type Adventurer, type Item } from "./codec.ts";
import { provider } from "./wallet.ts";

export type Snapshot = { adventurer: Adventurer; bag: Item[]; over: boolean };
export type Game = { id: string; packets: bigint[]; hashes: string[] };

const FAR_BLOCK = 10n ** 12n;

const randomHash = () => "0x" + randomBytes(31).toString("hex");

export async function replay(game: Game, packets = game.packets, hashes = game.hashes): Promise<Snapshot> {
  const blocks = packets.map((_, i) => (FAR_BLOCK + BigInt(i)).toString());
  const calldata = [game.id, String(packets.length), ...packets.map(String), String(blocks.length), ...blocks, String(hashes.length), ...hashes, "0"];
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "replay_transcript", calldata });
  const adventurer = decodeAdventurer(BigInt(out[3]));
  return { adventurer, bag: decodeBag(BigInt(out[4])), over: adventurer.health === 0 && packets.length > 0 };
}

export async function newPracticeGame(): Promise<Game> {
  const res = await fetch(`${GAME_API}/games/leaderboard?game_core=${GAME_CORE}&minter_id=${BEAST_MODE.minterId}`);
  const { data } = (await res.json()) as { data: { tokenId: string }[] };
  return { id: data[Math.floor(Math.random() * data.length)].tokenId, packets: [], hashes: [] };
}

export async function act(game: Game, actions: Action[]): Promise<Snapshot> {
  const packet = encodePacket(actions);
  const hash = randomHash();
  const snapshot = await replay(game, [...game.packets, packet], [...game.hashes, hash]);
  game.packets.push(packet);
  game.hashes.push(hash);
  return snapshot;
}

export async function preview(game: Game, actions: Action[], samples: number): Promise<Snapshot[]> {
  const packet = encodePacket(actions);
  return Promise.all(
    Array.from({ length: samples }, () => replay(game, [...game.packets, packet], [...game.hashes, randomHash()])),
  );
}
