import { LOOT_NAMES, NAMES, PREFIXES, SUFFIXES } from "./beast.ts";
import { BEAST_NFT, COLLECTION_API, DUNGEONS, EKUBO_QUOTER, ETH, GAME_API, STRK } from "./config.ts";
import { readQuote } from "./live.ts";
import { request } from "./net.ts";
import { transcript } from "./transcript.ts";
import { provider } from "./wallet.ts";

const TYPES = ["Magic", "Blade", "Bludgeon"];
const KINDS: Record<string, string[]> = { beast: NAMES, lootBag: LOOT_NAMES };
const PROBE = 10n ** 15n;
const BATCH = 8;
const PAGE = 100;
const hex = (n: bigint) => "0x" + n.toString(16);
const u256 = (n: bigint) => [hex(n & ((1n << 128n) - 1n)), hex(n >> 128n)];

export type Species = { collection: string; species: number; kind: string | null; name: string; prefix: number; suffix: number; tier: number; type: string };
export type Beast = Species & { tokenId: string; level: number; health: number; minted: number; state: "held" | "staked" | "mega"; transformsAt: number | null; queued: boolean };
export type Claim = Species & { adventurerId: string; encounterXp: number; level: number; health: number; settled: boolean; takenFrom: string | null };
type Kill = { adventurerId: string; encounterXp: number; actionIndex: number; beastId: number; prefix: number; suffix: number; level: number; health: number; gameOver: boolean; settled: boolean; claimed: boolean };
type Listed = { tokenId: string; beastId: number; prefix: number; suffix: number; level: number; health: number; mega: boolean; mintedAtBlock: number };
type Staked = { tokenId: string; speciesId: number; prefix: number; suffix: number; level: number; health: number; mega: boolean; staked: boolean; transformsAt: number | null; unsafeStake: boolean };

export function describe(species: number, prefix: number, suffix: number): Species {
  const [collection, d] = Object.entries(DUNGEONS).find(([, d]) => species >= d.firstSpecies && species < d.firstSpecies + d.speciesCount) ?? ["other", undefined];
  const index = d ? species - d.firstSpecies : 0;
  const perType = d ? d.speciesCount / TYPES.length : 1;
  const kind = KINDS[collection]?.[index] ?? null;
  const base = kind ?? `Beast #${species}`;
  return {
    collection,
    species,
    kind,
    name: prefix && suffix ? `"${PREFIXES[prefix - 1]} ${SUFFIXES[suffix - 1]}" ${base}` : base,
    prefix,
    suffix,
    tier: d ? Math.floor((index % perType) / (perType / 5)) + 1 : 0,
    type: d ? TYPES[Math.floor(index / perType)] : "",
  };
}

export function decodeBeast(b: Listed, stake?: Pick<Staked, "mega" | "staked" | "transformsAt" | "unsafeStake">): Beast {
  return {
    ...describe(b.beastId, b.prefix, b.suffix),
    tokenId: hex(BigInt(b.tokenId)),
    level: b.level,
    health: b.health,
    minted: b.mintedAtBlock,
    state: b.mega || stake?.mega ? "mega" : stake?.staked ? "staked" : "held",
    transformsAt: stake?.staked ? stake.transformsAt : null,
    queued: stake?.unsafeStake ?? false,
  };
}

export function unclaimed(kills: Kill[], firstSpecies: number): (Kill & { species: number })[] {
  const seen = new Set<string>();
  return kills
    .filter((k) => k.gameOver && !k.claimed)
    .map((k) => ({ ...k, species: firstSpecies + k.beastId - 1 }))
    .filter((k) => {
      const key = `${k.species}:${k.prefix}:${k.suffix}`;
      return !seen.has(key) && !!seen.add(key);
    });
}

async function api<T>(path: string): Promise<T> {
  const res = await request(`${GAME_API}${path}`);
  if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status}`);
  return (await res.json()) as T;
}

async function batched<A, B>(items: A[], run: (item: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(...(await Promise.all(items.slice(i, i + BATCH).map(run))));
  return out;
}

const nft = (entrypoint: string, calldata: string[]) => provider.callContract({ contractAddress: BEAST_NFT, entrypoint, calldata });

export function takeable(owner: string, killBlock: bigint, stake: { staker: string; block: bigint }): boolean {
  return BigInt(stake.staker) !== BigInt(owner) && killBlock > stake.block;
}

type Affixes = { species: number; prefix: number; suffix: number };
const minted = async (k: Affixes) => BigInt((await nft("is_minted", [String(k.species), String(k.prefix), String(k.suffix)]))[0]) === 1n;

async function staker(dungeon: string, owner: string, k: Affixes, killBlock: () => Promise<bigint>): Promise<string | null> {
  const token = BigInt((await nft("get_token_id_by_affixes", [String(k.species), String(k.prefix), String(k.suffix)]))[0]);
  if (BigInt((await nft("owner_of", u256(token)))[0]) !== BigInt(dungeon)) return null;
  const [by, , , , block] = await provider.callContract({ contractAddress: dungeon, entrypoint: "beast_stake", calldata: u256(token) });
  return takeable(owner, await killBlock(), { staker: by, block: BigInt(block) }) ? by : null;
}

export const affixes = (key: string, beast: { id: number; specialPrefix: string | null; specialSuffix: string | null }): Affixes => ({
  species: DUNGEONS[key].firstSpecies + beast.id - 1,
  prefix: PREFIXES.indexOf(beast.specialPrefix!) + 1,
  suffix: SUFFIXES.indexOf(beast.specialSuffix!) + 1,
});

export async function claimableKill(key: string, owner: string, k: Affixes, killBlock: bigint): Promise<boolean> {
  return !(await minted(k)) || (await staker(DUNGEONS[key].address, owner, k, async () => killBlock)) !== null;
}

export async function claims(owner: string, key: string, adventurer?: string): Promise<Claim[]> {
  const d = DUNGEONS[key];
  const { kills } = await api<{ kills: Kill[] }>(`/kills?owner=${owner}&dungeon=${d.address}&unclaimed=true${adventurer ? `&adventurer=${adventurer}` : ""}`);
  const open = unclaimed(kills, d.firstSpecies);
  const from = await batched(open, async (k) => ((await minted(k)) ? ((await staker(d.address, owner, k, async () => (await transcript(k.adventurerId)).chain.blocks[k.actionIndex])) ?? undefined) : null));
  return open.flatMap((k, i) => {
    const takenFrom = from[i];
    return takenFrom === undefined ? [] : [{ ...describe(k.species, k.prefix, k.suffix), adventurerId: k.adventurerId, encounterXp: k.encounterXp, level: k.level, health: k.health, settled: k.settled, takenFrom }];
  });
}

export async function pendingClaims(owner: string): Promise<Claim[]> {
  return (await Promise.all(Object.keys(DUNGEONS).map((key) => claims(owner, key)))).flat();
}

export async function inventory(owner: string): Promise<Record<string, Beast[]>> {
  const held: Listed[] = [];
  for (let cursor: string | null = ""; cursor !== null; ) {
    const res = await request(`${COLLECTION_API}/collections/beasts/owners/${owner}?limit=${PAGE}${cursor && `&cursor=${cursor}`}`);
    if (!res.ok) throw new Error(`beasts of ${owner.slice(0, 8)} ${res.status}`);
    const page = (await res.json()) as { items: Listed[]; nextCursor: string | null };
    held.push(...page.items);
    cursor = page.nextCursor ?? null;
  }
  const listed = (await Promise.all(Object.values(DUNGEONS).map((d) => api<{ beasts: Staked[] }>(`/loot/beasts?owner=${owner}&dungeon=${d.address}`)))).flatMap((r) => r.beasts);
  const stakes = new Map(listed.map((s) => [BigInt(s.tokenId), s]));
  const mine = new Set(held.map((b) => BigInt(b.tokenId)));
  const away = listed.filter((s) => s.staked && !mine.has(BigInt(s.tokenId))).map((s) => decodeBeast({ ...s, beastId: s.speciesId, mintedAtBlock: 0 }, s));
  const out: Record<string, Beast[]> = Object.fromEntries(Object.keys(DUNGEONS).map((key) => [key, []]));
  for (const b of [...held.map((h) => decodeBeast(h, stakes.get(BigInt(h.tokenId)))), ...away]) (out[b.collection] ??= []).push(b);
  return out;
}

export type Prices = Record<string, { normal: number[]; mega: number[] }>;

export async function sellPrices(): Promise<Prices> {
  const res = await request(`${EKUBO_QUOTER}/${PROBE}/${ETH}/${STRK}`);
  if (!res.ok) throw new Error(`ETH quote ${res.status}`);
  const rate = Number(BigInt(((await res.json()) as { total_calculated: string }).total_calculated)) / Number(PROBE);
  const quote = async (pool: string) => (Number(readQuote(await provider.callContract({ contractAddress: pool, entrypoint: "get_sell_nft_quote", calldata: ["0x0", "0x0", "0x1", "0x0"] })).price) / 1e18) * rate;
  const out: Prices = {};
  for (const [key, d] of Object.entries(DUNGEONS)) if (d.sell) out[key] = { normal: await batched(d.sell.normal, quote), mega: await batched(d.sell.mega, quote) };
  return out;
}

export const worth = (prices: Prices, b: { collection: string; tier: number; state?: string }): number | null => prices[b.collection]?.[b.state === "mega" ? "mega" : "normal"][b.tier - 1] ?? null;
