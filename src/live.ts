import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hash, type Call } from "starknet";
import { DUNGEON, EKUBO_QUOTER, EKUBO_ROUTER, GAME_CORE, STRK, STRK_FLOOR, TICKET, TICKET_BATCH, TICKET_BATCH_MAX_STRK, VAR_DIR } from "./config.ts";
import { encodePacket, type Action } from "./codec.ts";
import { fromSnapshot, replayLocal, step, toSnapshot } from "./engine/engine.ts";
import { randomHash, replay, type Game, type Snapshot } from "./practice.ts";
import { account, balanceOf, keys, provider, strkBalance } from "./wallet.ts";

const ONE = 10n ** 18n;
const TRANSFER = BigInt(hash.getSelectorFromName("Transfer"));
const file = `${VAR_DIR}live.json`;
const hex = (n: bigint) => "0x" + n.toString(16);
const u256 = (n: bigint) => [hex(n & ((1n << 128n) - 1n)), hex(n >> 128n)];

async function send(calls: Call[]) {
  if ((await strkBalance()) < BigInt(STRK_FLOOR) * ONE) throw new Error(`spend cap reached: balance is under ${STRK_FLOOR} STRK`);
  const { transaction_hash } = await account().execute(calls);
  const receipt = await provider.waitForTransaction(transaction_hash);
  if (!receipt.isSuccess()) throw new Error(`transaction ${transaction_hash} failed`);
  return receipt.value;
}

type Quote = { total_calculated: string; splits: { amount_specified: string; route: { pool_key: { token0: string; token1: string; fee: string; tick_spacing: number | string; extension: string }; sqrt_ratio_limit: string; skip_ahead: number | string }[] }[] };

export async function ticketCalls(): Promise<{ calls: Call[]; maxStrk: number }> {
  const wanted = BigInt(TICKET_BATCH) * ONE;
  const res = await fetch(`${EKUBO_QUOTER}/-${wanted}/${TICKET}/${STRK}`);
  if (!res.ok) throw new Error(`ticket quote ${res.status}`);
  const quote = (await res.json()) as Quote;
  const total = BigInt(quote.total_calculated);
  const maxIn = ((total < 0n ? -total : total) * 101n) / 100n;
  if (!quote.splits.length || maxIn <= 0n) throw new Error("no route to buy a ticket");
  if (maxIn > BigInt(TICKET_BATCH_MAX_STRK) * ONE) throw new Error(`${TICKET_BATCH} tickets cost ${Number(maxIn) / 1e18} STRK, over the ${TICKET_BATCH_MAX_STRK} STRK limit`);
  const swaps = quote.splits.flatMap((s) => {
    const amount = BigInt(s.amount_specified);
    return [
      hex(BigInt(s.route.length)),
      ...s.route.flatMap((n) => [n.pool_key.token0, n.pool_key.token1, n.pool_key.fee, hex(BigInt(n.pool_key.tick_spacing)), n.pool_key.extension, ...u256(BigInt(n.sqrt_ratio_limit)), hex(BigInt(n.skip_ahead))]),
      TICKET,
      hex(amount < 0n ? -amount : amount),
      "0x1",
    ];
  });
  return {
    maxStrk: Number(maxIn) / 1e18,
    calls: [
      { contractAddress: STRK, entrypoint: "transfer", calldata: [EKUBO_ROUTER, ...u256(maxIn)] },
      { contractAddress: EKUBO_ROUTER, entrypoint: "multi_multihop_swap", calldata: [hex(BigInt(quote.splits.length)), ...swaps] },
      { contractAddress: EKUBO_ROUTER, entrypoint: "clear_minimum", calldata: [TICKET, ...u256(wanted)] },
      { contractAddress: EKUBO_ROUTER, entrypoint: "clear", calldata: [STRK] },
    ],
  };
}

async function enter(): Promise<string> {
  const me = keys().address;
  const buy = (await balanceOf(TICKET)) < ONE ? (await ticketCalls()).calls : [];
  const receipt = await send([
    ...buy,
    { contractAddress: TICKET, entrypoint: "approve", calldata: [DUNGEON.address, ...u256(ONE)] },
    { contractAddress: DUNGEON.address, entrypoint: "new_game", calldata: ["0", me, "0"] },
  ]);
  const mint = receipt.events.find((e) => BigInt(e.from_address) === BigInt(GAME_CORE) && BigInt(e.keys[0]) === TRANSFER && BigInt(e.keys[1]) === 0n);
  if (!mint) throw new Error(`no game token minted in ${receipt.transaction_hash}`);
  return "0x" + (BigInt(mint.keys[3]) + (BigInt(mint.keys[4]) << 128n)).toString(16).padStart(64, "0");
}

type Saved = { id: string; packets: string[]; blocks: string[]; hashes: string[] };

function save(game: Game): void {
  const saved: Saved = { id: game.id, packets: game.packets.map(String), blocks: game.chain!.blocks.map(String), hashes: game.chain!.hashes };
  writeFileSync(file, JSON.stringify(saved));
}

async function start(id: string): Promise<Snapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await replay({ id, packets: [] });
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

export async function liveGame(): Promise<Game> {
  const saved: Saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { id: await enter(), packets: [], blocks: [], hashes: [] };
  const packets = saved.packets.map(BigInt);
  const blocks = saved.blocks.map(BigInt);
  const rolling = packets.reduce((c, p, i) => BigInt(hash.computePoseidonHashOnElements([c, p, blocks[i]])), BigInt(hash.computePoseidonHashOnElements([BigInt(saved.id)])));
  const stored = BigInt((await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "get_commitment", calldata: [saved.id] }))[0]);
  if (packets.length && stored !== rolling) throw new Error(`saved moves for ${saved.id} do not match the chain; ${file} needs repair`);
  const begin = await start(saved.id);
  const game: Game = { id: saved.id, seed: 0, packets, start: begin, local: fromSnapshot(replayLocal(begin, saved.id, packets, saved.hashes)), chain: { blocks, hashes: saved.hashes, rolling } };
  save(game);
  return game;
}

export async function actLive(game: Game, actions: Action[]): Promise<Snapshot> {
  const packet = encodePacket(actions);
  step(game.local, game.id, packet, randomHash());
  const chain = game.chain!;
  const receipt = await send([{ contractAddress: GAME_CORE, entrypoint: "commit_actions", calldata: [game.id, hex(game.packets.length ? chain.rolling : 0n), "0x1", hex(packet)] }]);
  const block = BigInt(receipt.block_number);
  game.packets.push(packet);
  chain.blocks.push(block);
  chain.hashes.push(receipt.block_hash);
  chain.rolling = BigInt(hash.computePoseidonHashOnElements([chain.rolling, packet, block]));
  save(game);
  game.local = step(game.local, game.id, packet, receipt.block_hash);
  const snap = toSnapshot(game.local);
  if (snap.over) rmSync(file);
  return snap;
}
