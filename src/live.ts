import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hash, type Call } from "starknet";
import { claims as pending } from "./beasts.ts";
import { DUNGEON, DUNGEONS, EKUBO_QUOTER, EKUBO_ROUTER, GAME_CORE, RPC_URL, SETTLE_CHUNK, SETTLE_MAX_PACKETS, STRK, STRK_FLOOR, TICKET, TICKET_BATCH, TICKET_BATCH_MAX_STRK, VAR_DIR, type Dungeon } from "./config.ts";
import { encodePacket, type Action } from "./codec.ts";
import { fromSnapshot, replayLocal, step, toSnapshot } from "./engine/engine.ts";
import { randomHash, startOf, type Chain, type Game, type Snapshot } from "./practice.ts";
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
      return await startOf(id);
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

const dungeonOf = async (id: string): Promise<[string, Dungeon]> => {
  const minter = Number((await view("minted_by", id))[0]);
  const found = Object.entries(DUNGEONS).find(([, d]) => d.minterId === minter);
  if (!found) throw new Error(`game ${id} belongs to no known dungeon (minter ${minter})`);
  return found;
};

const ownerOf = async (id: string) => (await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "owner_of", calldata: u256(BigInt(id)) }))[0];

export function settleCalls(dungeon: Dungeon, id: string, packets: bigint[], blocks: bigint[], claims: number[], done: number, nonce: bigint, single = SETTLE_MAX_PACKETS, chunk = SETTLE_CHUNK): Call[][] {
  const claimCalls = claims.map((xp) => ({ contractAddress: dungeon.address, entrypoint: dungeon.claim, calldata: [id, hex(BigInt(xp))] }));
  const span = (from: number, to: number) => [packets, blocks].flatMap((list) => [hex(BigInt(to - from)), ...list.slice(from, to).map(hex)]);
  const game = (entrypoint: string, calldata: string[]) => ({ contractAddress: GAME_CORE, entrypoint, calldata: [id, ...calldata] });
  if (done >= packets.length) return claimCalls.length ? [claimCalls] : [];
  if (done === 0 && packets.length <= single) return [[game("verify_game", span(0, packets.length)), ...claimCalls]];
  const chunks: string[][] = [];
  for (let from = done; from < packets.length; from += chunk) chunks.push([hex(nonce), ...span(from, Math.min(from + chunk, packets.length))]);
  const txs = [...chunks.map((c) => [game("verify_actions", c)]), ...chunks.map((c) => [game("apply_actions", c)])];
  txs[txs.length - 1].push(...claimCalls);
  return txs;
}

export async function settlement(id: string, claims: number[]): Promise<Call[][]> {
  const [{ packets, chain }, verified, checkpoint, [, dungeon]] = await Promise.all([transcript(id), view("is_verified", id), view("get_replay_checkpoint", id), dungeonOf(id)]);
  const done = BigInt(verified[0]) === 1n ? packets.length : Number(checkpoint[3]);
  return settleCalls(dungeon, id, packets, chain.blocks, claims, done, BigInt("0x" + randomBytes(8).toString("hex")));
}

export async function settle(id: string, claims: number[]): Promise<string | undefined> {
  let last: string | undefined;
  for (const calls of await settlement(id, claims)) last = (await send(calls)).transaction_hash;
  return last;
}

export async function claimable(id: string): Promise<number[]> {
  const [owner, [key]] = await Promise.all([ownerOf(id), dungeonOf(id)]);
  return (await pending(owner, key, id)).map((c) => c.encounterXp);
}

export async function collect(id: string): Promise<string | undefined> {
  const claims = await claimable(id);
  return claims.length ? settle(id, claims) : undefined;
}

type Simulated = { calls: string[]; strk: number; revert: string | null };

export async function simulate(sender: string, txs: Call[][]): Promise<Simulated[]> {
  const nonce = BigInt(await provider.getNonceForAddress(sender));
  const none = { max_amount: "0x0", max_price_per_unit: "0x0" };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_simulateTransactions",
      params: {
        block_id: "latest",
        simulation_flags: ["SKIP_VALIDATE", "SKIP_FEE_CHARGE"],
        transactions: txs.map((calls, i) => ({
          type: "INVOKE",
          version: "0x3",
          sender_address: sender,
          calldata: [hex(BigInt(calls.length)), ...calls.flatMap((c) => [c.contractAddress, hash.getSelectorFromName(c.entrypoint), hex(BigInt((c.calldata as string[]).length)), ...(c.calldata as string[])])],
          signature: [],
          nonce: hex(nonce + BigInt(i)),
          resource_bounds: { l1_gas: none, l2_gas: none, l1_data_gas: none },
          tip: "0x0",
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: "L1",
          fee_data_availability_mode: "L1",
        })),
      },
    }),
  });
  const body = (await res.json()) as { error?: unknown; result?: { fee_estimation: { overall_fee: string }; transaction_trace: { execute_invocation: { revert_reason?: string } } }[] };
  if (!body.result) throw new Error(`simulation failed: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result.map((r, i) => ({
    calls: txs[i].map((c) => c.entrypoint),
    strk: Number(BigInt(r.fee_estimation.overall_fee)) / 1e18,
    revert: r.transaction_trace.execute_invocation.revert_reason?.replace(/\s+/g, " ").slice(-200) ?? null,
  }));
}

export async function quote(id: string): Promise<{ owner: string; claims: number[]; strk: number; transactions: Simulated[] }> {
  const [owner, claims] = await Promise.all([ownerOf(id), claimable(id)]);
  const transactions = await simulate(owner, await settlement(id, claims));
  return { owner, claims, strk: transactions.reduce((sum, t) => sum + t.strk, 0), transactions };
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
