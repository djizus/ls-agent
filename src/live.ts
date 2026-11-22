import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hash, type Call } from "starknet";
import { claims as pending } from "./beasts.ts";
import { BEAST_NFT, DUNGEONS, EKUBO_QUOTER, EKUBO_ROUTER, GAME_CORE, RPC_URL, SETTLE_CHUNK, SETTLE_MAX_PACKETS, STRK, STRK_FLOOR, SURVIVOR, TICKET, TICKET_BATCH, TICKET_BATCH_MAX_STRK, USDC, VAR_DIR, type Dungeon, dungeonOf } from "./config.ts";
import { encodePacket, type Action } from "./codec.ts";
import { fromSnapshot, replayLocal, step, toSnapshot } from "./engine/engine.ts";
import { randomHash, startOf, type Chain, type Game, type Snapshot } from "./practice.ts";
import { transcript } from "./transcript.ts";
import { request } from "./net.ts";
import { account, balanceOf, included, keys, provider, strkBalance } from "./wallet.ts";

const ONE = 10n ** 18n;
const TRANSFER = BigInt(hash.getSelectorFromName("Transfer"));
const file = `${VAR_DIR}live.json`;
const hex = (n: bigint) => "0x" + n.toString(16);
const u256 = (n: bigint) => [hex(n & ((1n << 128n) - 1n)), hex(n >> 128n)];

async function submit(calls: Call[]) {
  const [balance, nonce] = await Promise.all([strkBalance(), provider.getNonceForAddress(keys().address)]);
  if (balance < BigInt(STRK_FLOOR) * ONE) throw new Error(`spend cap reached: balance is under ${STRK_FLOOR} STRK`);
  const { transaction_hash } = await account().execute(calls, { tip: 0n, nonce });
  return included(transaction_hash);
}

let turn: Promise<unknown> = Promise.resolve();

function send(calls: Call[]) {
  const mine = turn.then(() => submit(calls));
  turn = mine.catch(() => undefined);
  return mine;
}

type Quote = { total_calculated: string; splits: { amount_specified: string; route: { pool_key: { token0: string; token1: string; fee: string; tick_spacing: number | string; extension: string }; sqrt_ratio_limit: string; skip_ahead: number | string }[] }[] };

export async function usdPrice(token: string): Promise<number> {
  const res = await request(`${EKUBO_QUOTER}/${1000n * ONE}/${token}/${USDC}`);
  if (!res.ok) throw new Error(`dollar quote ${res.status}`);
  return Number(((await res.json()) as Quote).total_calculated) / 1e9;
}

export async function ticketCalls(): Promise<{ calls: Call[]; maxStrk: number }> {
  const wanted = BigInt(TICKET_BATCH) * ONE;
  const res = await request(`${EKUBO_QUOTER}/-${wanted}/${TICKET}/${STRK}`);
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

export type Entry = { bag: number; maxSurvivor: number };
export type BagQuote = { price: bigint; protocolFee: bigint; royalty: bigint };

const gameId = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const bagOf = (id: bigint) => Number((id >> 192n) & ((1n << 56n) - 1n));
const pair = (list: string[], at: number) => BigInt(list[at]) + (BigInt(list[at + 1]) << 128n);
export const units = (n: bigint) => `${n / ONE}.${(n % ONE).toString().padStart(18, "0")}`.replace(/\.?0+$/, "");

const pooled = (ids: string[]) => Array.from({ length: Number(ids[0]) }, (_, i) => pair(ids, 1 + 2 * i));

export function heldGames(ids: string[], bag: number): string[] {
  return pooled(ids).filter((id) => bagOf(id) === bag).map(gameId);
}

export function unranked(ids: string[], ranked: number[]): { bag: number; game: string }[] {
  const first = new Map(pooled(ids).reverse().map((id) => [bagOf(id), gameId(id)]));
  return [...first].filter(([bag]) => !ranked.includes(bag)).map(([bag, game]) => ({ bag, game }));
}

export function unplayed<Row extends { bag: number; policy?: string }>(rows: Row[], ids: string[], policy?: string): Row[] {
  const bags = new Set(pooled(ids).map(bagOf));
  return rows.filter((row) => bags.has(row.bag) && (policy ? row.policy !== policy : !row.policy));
}

export function shortlist<Row extends { bag: number; mean?: number; kills?: number; games?: number }>(rows: Row[], ids: string[], best: number, games: number): Row[] {
  const bags = new Set(pooled(ids).map(bagOf));
  const held = rows.filter((row) => bags.has(row.bag) && row.games);
  const top = (by: "mean" | "kills") => [...held].sort((a, b) => b[by]! - a[by]!).slice(0, best);
  return [...new Set([...top("mean"), ...top("kills")])].filter((row) => row.games! < games);
}

export function forSale<Row extends { bag: number }>(rows: Row[], ids: string[]): (Row & { n: number })[] {
  const bags = pooled(ids).map(bagOf);
  return rows.map((row) => ({ ...row, n: bags.filter((bag) => bag === row.bag).length })).filter((row) => row.n);
}

export const poolIds = (pool: string): Promise<string[]> => provider.callContract({ contractAddress: pool, entrypoint: "get_all_ids", calldata: [] });

export function readQuote(out: string[]): BagQuote {
  if (BigInt(out[0]) !== 0n) throw new Error(`the pool cannot price a bag (curve error ${Number(out[0])})`);
  return { price: pair(out, 3), protocolFee: pair(out, 5), royalty: pair(out, 7) };
}

export function bagCalls(pool: string, id: string, max: bigint, recipient: string): Call[] {
  return [
    { contractAddress: SURVIVOR, entrypoint: "approve", calldata: [pool, ...u256(max)] },
    { contractAddress: pool, entrypoint: "swap_token_for_specific_nfts", calldata: ["0x1", ...u256(BigInt(id)), ...u256(max), recipient, "0x0", "0x0"] },
    { contractAddress: SURVIVOR, entrypoint: "approve", calldata: [pool, "0x0", "0x0"] },
  ];
}

const capOf = (entry: Entry): bigint => (entry.maxSurvivor > 0 ? BigInt(Math.round(entry.maxSurvivor * 1e6)) * (ONE / 1_000_000n) : 0n);

export function bagRefusal(held: string[], quote: BagQuote, entry: Entry, survivor: bigint): string | null {
  if (!held.length) return `the pool holds no game of bag ${entry.bag}`;
  if (capOf(entry) === 0n) return "give the most SURVIVOR to pay for the bag as maxSurvivor";
  if (quote.price > capOf(entry)) return `bag ${entry.bag} costs ${units(quote.price)} SURVIVOR, over the ${entry.maxSurvivor} limit`;
  if (survivor < quote.price) return `bag ${entry.bag} costs ${units(quote.price)} SURVIVOR and the wallet holds ${units(survivor)}`;
  return null;
}

export function bagPurchase(pool: string, held: string[], quote: BagQuote, entry: Entry, recipient: string, survivor: bigint): { id: string; calls: Call[] } {
  const refused = bagRefusal(held, quote, entry, survivor);
  if (refused) throw new Error(refused);
  return { id: held[0], calls: bagCalls(pool, held[0], capOf(entry), recipient) };
}

export async function bagMarket(pool: string, bag: number): Promise<{ held: string[]; quote: BagQuote }> {
  const held = heldGames(await poolIds(pool), bag);
  const quote = readQuote(await provider.callContract({ contractAddress: pool, entrypoint: "get_buy_nft_quote", calldata: [...u256(BigInt(held[0] ?? 0)), "0x1", "0x0"] }));
  return { held, quote };
}

async function buyBag(d: Dungeon, entry: Entry | undefined, me: string): Promise<string> {
  if (!entry) throw new Error(`${d.name} starts from a bought bag: give bag and maxSurvivor`);
  const [{ held, quote }, survivor] = await Promise.all([bagMarket(d.pool!, entry.bag), balanceOf(SURVIVOR)]);
  const { id, calls } = bagPurchase(d.pool!, held, quote, entry, me, survivor);
  try {
    await send(calls);
  } catch (err) {
    if (BigInt(await ownerOf(id)) !== BigInt(me)) throw err;
  }
  return id;
}

const minted = (receipt: { events: { from_address: string; keys: string[] }[] }): string[] =>
  receipt.events
    .filter((e) => BigInt(e.from_address) === BigInt(GAME_CORE) && BigInt(e.keys[0]) === TRANSFER && BigInt(e.keys[1]) === 0n)
    .map((e) => "0x" + (BigInt(e.keys[3]) + (BigInt(e.keys[4]) << 128n)).toString(16).padStart(64, "0"));

export async function mintedSince(block: number, owner = keys().address, to: number | "latest" = "latest"): Promise<string[]> {
  const events: { from_address: string; keys: string[] }[] = [];
  for (let token: string | undefined, first = true; first || token; first = false) {
    const page = await provider.getEvents({ address: GAME_CORE, keys: [[hex(TRANSFER)], ["0x0"], [owner]], from_block: { block_number: block }, to_block: to === "latest" ? to : { block_number: to }, chunk_size: 500, continuation_token: token });
    events.push(...page.events);
    token = page.continuation_token;
  }
  return minted({ events });
}

export const head = (): Promise<number> => provider.getBlockNumber();

export const adopt = (id: string): void => keep([...new Set([...liveIds(), id])]);

const entryCalls = (d: Dungeon, games: number): Call[] => !games ? [] : [
  { contractAddress: TICKET, entrypoint: "approve", calldata: [d.address, ...u256(ONE * BigInt(games))] },
  { contractAddress: d.address, entrypoint: "new_game_batch", calldata: [hex(BigInt(games)), ...Array<string>(games).fill(keys().address), "0x0"] },
];

export async function tickets(wanted: number): Promise<number> {
  const held = async () => Number((await balanceOf(TICKET)) / ONE);
  if ((await held()) < wanted) await send((await ticketCalls()).calls);
  return Math.min(wanted, await held());
}

async function enter(d: Dungeon, entry?: Entry): Promise<string> {
  if (d.pool) return buyBag(d, entry, keys().address);
  if (!(await tickets(1))) throw new Error("no ticket to enter with");
  const [id] = minted(await send(entryCalls(d, 1)));
  if (!id) throw new Error("no game token minted");
  return id;
}

const view = (entrypoint: string, id: string) => provider.callContract({ contractAddress: GAME_CORE, entrypoint, calldata: [id] });

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

export const liveIds = (): string[] => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).ids : []);

const keep = (ids: string[]) => (ids.length ? writeFileSync(file, JSON.stringify({ ids })) : rmSync(file, { force: true }));

export async function liveGame(d: Dungeon, entry?: Entry, resumed?: string): Promise<Game> {
  const id = resumed ?? (await enter(d, entry));
  keep([...new Set([...liveIds(), id])]);
  const { packets, chain } = await transcript(id);
  const begin = await start(id);
  return { id, seed: 0, packets, start: begin, local: fromSnapshot(replayLocal(begin, id, packets, chain.hashes)), chain };
}

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
  const [{ packets, chain }, verified, checkpoint] = await Promise.all([transcript(id), view("is_verified", id), view("get_replay_checkpoint", id)]);
  const dungeon = DUNGEONS[dungeonOf(id)];
  const done = BigInt(verified[0]) === 1n ? packets.length : Number(checkpoint[3]);
  return settleCalls(dungeon, id, packets, chain.blocks, claims, done, BigInt("0x" + randomBytes(8).toString("hex")));
}

export async function settle(id: string, claims: number[]): Promise<string | undefined> {
  let last: string | undefined;
  for (const calls of await settlement(id, claims)) last = (await send(calls)).transaction_hash;
  return last;
}

export async function claimable(id: string): Promise<number[]> {
  return (await pending(await ownerOf(id), dungeonOf(id), id)).map((c) => c.encounterXp);
}

export async function collect(id: string): Promise<{ beasts: number; transaction?: string }> {
  const claims = await claimable(id);
  return { beasts: claims.length, transaction: claims.length ? await settle(id, claims) : undefined };
}

type Simulated = { calls: string[]; strk: number; revert: string | null };

export async function sendBeasts(to: string): Promise<{ beasts: number; transaction: string | null }> {
  const owner = keys().address;
  await provider.getClassHashAt(to);
  const nft = (entrypoint: string, calldata: string[]) => provider.callContract({ contractAddress: BEAST_NFT, entrypoint, calldata });
  const count = Number((await nft("balance_of", [owner]))[0]);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await nft("token_of_owner_by_index", [owner, hex(BigInt(i)), "0x0"]))[0]);
  const calls = ids.map((id) => ({ contractAddress: BEAST_NFT, entrypoint: "transfer_from", calldata: [owner, to, ...u256(BigInt(id))] }));
  if (!calls.length) return { beasts: 0, transaction: null };
  const [checked] = await simulate(owner, [calls]);
  if (checked.revert) throw new Error(`transfer would revert: ${checked.revert}`);
  return { beasts: calls.length, transaction: (await send(calls)).transaction_hash };
}

export async function simulate(sender: string, txs: Call[][]): Promise<Simulated[]> {
  const nonce = BigInt(await provider.getNonceForAddress(sender));
  const none = { max_amount: "0x0", max_price_per_unit: "0x0" };
  const res = await request(RPC_URL, {
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

export async function bagReport(bag: number, address: string) {
  const pool = DUNGEONS.lootBag.pool!;
  const [{ held, quote }, survivor, strk] = await Promise.all([bagMarket(pool, bag), balanceOf(SURVIVOR, address), balanceOf(STRK, address)]);
  const enough = survivor >= quote.price;
  const [purchase] = held.length ? await simulate(address, [bagCalls(pool, held[0], quote.price, address)]) : [null];
  return {
    bag,
    held: held.length,
    games: held,
    survivor: { price: units(quote.price), protocolFee: units(quote.protocolFee), royalty: units(quote.royalty) },
    wallet: { address, survivor: units(survivor), strk: units(strk), enough },
    purchase: purchase && { strk: purchase.strk, revert: purchase.revert },
    note: !held.length ? "the pool does not hold this bag: nothing to simulate" : enough ? "simulated only, nothing was sent" : "the wallet holds too little SURVIVOR, so the simulated purchase reverts and its fee is a lower bound",
  };
}

export async function quote(id: string): Promise<{ owner: string; claims: number[]; strk: number; transactions: Simulated[] }> {
  const [owner, claims] = await Promise.all([ownerOf(id), claimable(id)]);
  const transactions = await simulate(owner, await settlement(id, claims));
  return { owner, claims, strk: transactions.reduce((sum, t) => sum + t.strk, 0), transactions };
}

const START_MOVES = 8;

export type Move = { game: Game; actions: Action[] };
export type Moved = { snapshot: Snapshot; strk: number } | { error: unknown };
export type Round = { moved: Moved[]; started: string[] | { error: unknown }; strk: number };

export type Starts = { dungeon: Dungeon; games: number };

export async function actLive(moves: Move[], starts?: Starts): Promise<Round> {
  const moved: Moved[] = moves.map(() => ({ error: new Error("not sent") }));
  const first = (game: Game) => (game.packets.length ? game.chain!.rolling : 0n);
  let ready = moves.flatMap(({ game, actions }, at) => {
    try {
      const packet = encodePacket(actions);
      step(game.local, game.id, packet, randomHash());
      return [{ at, game, packet, call: { contractAddress: GAME_CORE, entrypoint: "commit_actions", calldata: [game.id, hex(first(game)), "0x1", hex(packet)] } }];
    } catch (error) {
      moved[at] = { error };
      return [];
    }
  });
  let entries = starts ? entryCalls(starts.dungeon, starts.games) : [];
  const calls = () => [...ready.map((r) => r.call), ...entries];
  const refuse = (error: unknown): Round => (ready.forEach((r) => (moved[r.at] = { error })), { moved, started: entries.length ? { error } : [], strk: 0 });
  if (!calls().length) return { moved, started: [], strk: 0 };
  let receipt: Awaited<ReturnType<typeof send>>;
  let refused: unknown;
  try {
    receipt = await send(calls());
  } catch (error) {
    const groups = [...ready.map((r) => [r.call]), ...(entries.length ? [entries] : [])];
    const alone = groups.length > 1 ? await simulate(keys().address, groups).catch(() => undefined) : undefined;
    const bad = groups.map((_, k) => alone?.[k].revert ?? null);
    if (!alone || bad.every((b) => b === null) || bad.every((b) => b !== null)) return refuse(error);
    ready.forEach((r, k) => bad[k] !== null && (moved[r.at] = { error: new Error(bad[k]!) }));
    if (entries.length && bad.at(-1) !== null) [refused, entries] = [new Error(bad.at(-1)!), []];
    ready = ready.filter((_, k) => bad[k] === null);
    try {
      receipt = await send(calls());
    } catch (again) {
      return refuse(again);
    }
  }
  const started = minted(receipt);
  keep([...new Set([...liveIds(), ...started])]);
  const block = BigInt(receipt.block_number);
  const strk = Number(BigInt(receipt.actual_fee.amount)) / 1e18 / (ready.length + START_MOVES * started.length || 1);
  for (const { at, game, packet } of ready) {
    const chain = game.chain!;
    chain.rolling = BigInt(hash.computePoseidonHashOnElements([game.packets.length ? chain.rolling : BigInt(hash.computePoseidonHashOnElements([BigInt(game.id)])), packet, block]));
    game.packets.push(packet);
    chain.blocks.push(block);
    chain.hashes.push(receipt.block_hash);
    game.local = step(game.local, game.id, packet, receipt.block_hash);
    const snapshot = toSnapshot(game.local);
    if (snapshot.over) keep(liveIds().filter((id) => id !== game.id));
    moved[at] = { snapshot, strk };
  }
  return { moved, started: refused ? { error: refused } : started, strk: START_MOVES * strk };
}
