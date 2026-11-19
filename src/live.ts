import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hash, type Call } from "starknet";
import { DUNGEON, EKUBO_QUOTER, GAME_API, EKUBO_ROUTER, GAME_CORE, STRK, STRK_FLOOR, TICKET, TICKET_BATCH, TICKET_BATCH_MAX_STRK, VAR_DIR } from "./config.ts";
import { encodePacket, type Action } from "./codec.ts";
import { fromSnapshot, replayLocal, step, toSnapshot } from "./engine/engine.ts";
import { randomHash, replay, type Chain, type Game, type Snapshot } from "./practice.ts";
import { account, balanceOf, keys, provider, strkBalance } from "./wallet.ts";

const ONE = 10n ** 18n;
const TRANSFER = BigInt(hash.getSelectorFromName("Transfer"));
const COMMITTED = hash.getSelectorFromName("ActionCommitted");
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

const view = (entrypoint: string, id: string) => provider.callContract({ contractAddress: GAME_CORE, entrypoint, calldata: [id] });

export async function transcript(id: string): Promise<{ packets: bigint[]; chain: Chain }> {
  const from = Number((await view("minted_at_block_number", id))[0]);
  const packets: bigint[] = [];
  const chain: Chain = { blocks: [], hashes: [], rolling: 0n };
  for (let token: string | undefined, first = true; first || token; first = false) {
    const page = await provider.getEvents({ address: GAME_CORE, keys: [[COMMITTED], [id]], from_block: { block_number: from }, to_block: "latest", chunk_size: 500, continuation_token: token });
    for (const e of page.events) {
      for (const packet of e.data.slice(1, 1 + Number(e.data[0]))) {
        packets.push(BigInt(packet));
        chain.blocks.push(BigInt(e.block_number!));
        chain.hashes.push(e.block_hash!);
      }
      chain.rolling = BigInt(e.data.at(-1)!);
    }
    token = page.continuation_token;
  }
  return { packets, chain };
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
  const id: string = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).id : await enter();
  writeFileSync(file, JSON.stringify({ id }));
  const { packets, chain } = await transcript(id);
  const begin = await start(id);
  return { id, seed: 0, packets, start: begin, local: fromSnapshot(replayLocal(begin, id, packets, chain.hashes)), chain };
}

export async function settle(id: string, claims: number[]): Promise<string> {
  const { packets, chain } = await transcript(id);
  const verified = BigInt((await view("is_verified", id))[0]) === 1n;
  const receipt = await send([
    ...(verified ? [] : [{ contractAddress: GAME_CORE, entrypoint: "verify_game", calldata: [id, hex(BigInt(packets.length)), ...packets.map(hex), hex(BigInt(packets.length)), ...chain.blocks.map(hex)] }]),
    ...claims.map((xp) => ({ contractAddress: DUNGEON.address, entrypoint: "claim_beast", calldata: [id, hex(BigInt(xp))] })),
  ]);
  return receipt.transaction_hash;
}

type GameEvent = { event: { type: string; beast?: { isCollectable: boolean }; encounter_xp?: number } };

export async function claimable(id: string): Promise<number[]> {
  const res = await fetch(`${GAME_API}/adventurer/${id}/events?game_core=${GAME_CORE}&minter_id=${DUNGEON.minterId}`);
  if (!res.ok) throw new Error(`game events ${res.status}`);
  const { events } = (await res.json()) as { events: GameEvent[] };
  let collectable = false;
  const claims: number[] = [];
  for (const { event } of events) {
    if (event.type === "beast") collectable = event.beast!.isCollectable;
    if (event.type === "defeated_beast" && collectable) claims.push(event.encounter_xp!);
  }
  return claims;
}

export async function collect(id: string): Promise<string | undefined> {
  const claims = await claimable(id);
  return claims.length ? settle(id, claims) : undefined;
}

export async function actLive(game: Game, actions: Action[]): Promise<Snapshot> {
  const packet = encodePacket(actions);
  step(game.local, game.id, packet, randomHash());
  const chain = game.chain!;
  const receipt = await send([{ contractAddress: GAME_CORE, entrypoint: "commit_actions", calldata: [game.id, hex(game.packets.length ? chain.rolling : 0n), "0x1", hex(packet)] }]);
  const block = BigInt(receipt.block_number);
  chain.rolling = BigInt(hash.computePoseidonHashOnElements([game.packets.length ? chain.rolling : BigInt(hash.computePoseidonHashOnElements([BigInt(game.id)])), packet, block]));
  game.packets.push(packet);
  chain.blocks.push(block);
  chain.hashes.push(receipt.block_hash);
  game.local = step(game.local, game.id, packet, receipt.block_hash);
  const snap = toSnapshot(game.local);
  if (snap.over) rmSync(file);
  return snap;
}
