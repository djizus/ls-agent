import { NAMES, PREFIXES, SUFFIXES } from "./beast.ts";
import { BEAST_NFT, DUNGEONS, GAME_API } from "./config.ts";
import { transcript } from "./transcript.ts";
import { provider } from "./wallet.ts";

const TYPES = ["Magic", "Blade", "Bludgeon"];
const BATCH = 8;
const hex = (n: bigint) => "0x" + n.toString(16);
const u256 = (n: bigint) => [hex(n & ((1n << 128n) - 1n)), hex(n >> 128n)];

export type Species = { collection: string; species: number; name: string; prefix: number; suffix: number; tier: number; type: string };
export type Beast = Species & { tokenId: string; level: number; health: number; state: "held" | "staked" | "mega"; transformsAt: number | null; queued: boolean };
export type Claim = Species & { adventurerId: string; encounterXp: number; level: number; health: number; settled: boolean; takenFrom: string | null };
type Kill = { adventurerId: string; encounterXp: number; actionIndex: number; beastId: number; prefix: number; suffix: number; level: number; health: number; gameOver: boolean; settled: boolean; claimed: boolean };
type Staked = { tokenId: string; mega: boolean; staked: boolean; transformsAt: number | null; unsafeStake: boolean };

export function describe(species: number, prefix: number, suffix: number): Species {
  const [collection, d] = Object.entries(DUNGEONS).find(([, d]) => species >= d.firstSpecies && species < d.firstSpecies + d.speciesCount) ?? ["other", undefined];
  const index = d ? species - d.firstSpecies : 0;
  const perType = d ? d.speciesCount / TYPES.length : 1;
  const base = collection === "beast" ? NAMES[index] : `${d?.name ?? "Beast"} #${d ? index + 1 : species}`;
  return {
    collection,
    species,
    name: prefix && suffix ? `"${PREFIXES[prefix - 1]} ${SUFFIXES[suffix - 1]}" ${base}` : base,
    prefix,
    suffix,
    tier: d ? Math.floor((index % perType) / (perType / 5)) + 1 : 0,
    type: d ? TYPES[Math.floor(index / perType)] : "",
  };
}

export function decodeBeast(tokenId: string, felts: string[], stake?: Staked): Beast {
  const [species, prefix, suffix, level, health] = felts.map(Number);
  return {
    ...describe(species, prefix, suffix),
    tokenId: hex(BigInt(tokenId)),
    level,
    health,
    state: stake?.mega ? "mega" : stake?.staked ? "staked" : "held",
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
  const res = await fetch(`${GAME_API}${path}`);
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

async function staker(dungeon: string, owner: string, k: Kill & { species: number }): Promise<string | null> {
  const token = BigInt((await nft("get_token_id_by_affixes", [String(k.species), String(k.prefix), String(k.suffix)]))[0]);
  if (BigInt((await nft("owner_of", u256(token)))[0]) !== BigInt(dungeon)) return null;
  const [by, , , , block] = await provider.callContract({ contractAddress: dungeon, entrypoint: "beast_stake", calldata: u256(token) });
  const killBlock = (await transcript(k.adventurerId)).chain.blocks[k.actionIndex];
  return takeable(owner, killBlock, { staker: by, block: BigInt(block) }) ? by : null;
}

export async function claims(owner: string, key: string, adventurer?: string): Promise<Claim[]> {
  const d = DUNGEONS[key];
  const { kills } = await api<{ kills: Kill[] }>(`/kills?owner=${owner}&dungeon=${d.address}&unclaimed=true${adventurer ? `&adventurer=${adventurer}` : ""}`);
  const open = unclaimed(kills, d.firstSpecies);
  const from = await batched(open, async (k) => (BigInt((await nft("is_minted", [String(k.species), String(k.prefix), String(k.suffix)]))[0]) === 1n ? ((await staker(d.address, owner, k)) ?? undefined) : null));
  return open.flatMap((k, i) => {
    const takenFrom = from[i];
    return takenFrom === undefined ? [] : [{ ...describe(k.species, k.prefix, k.suffix), adventurerId: k.adventurerId, encounterXp: k.encounterXp, level: k.level, health: k.health, settled: k.settled, takenFrom }];
  });
}

export async function pendingClaims(owner: string): Promise<Claim[]> {
  return (await Promise.all(Object.keys(DUNGEONS).map((key) => claims(owner, key)))).flat();
}

export async function inventory(owner: string): Promise<Record<string, Beast[]>> {
  const balance = Number((await nft("balance_of", [owner]))[0]);
  const held = await batched([...Array(balance).keys()], async (i) => (await nft("token_of_owner_by_index", [owner, hex(BigInt(i)), "0x0"]))[0]);
  const listed = (await Promise.all(Object.values(DUNGEONS).map((d) => api<{ beasts: Staked[] }>(`/loot/beasts?owner=${owner}&dungeon=${d.address}`)))).flatMap((r) => r.beasts);
  const stakes = new Map(listed.map((s) => [BigInt(s.tokenId), s]));
  const ids = [...new Set([...held.map(BigInt), ...listed.filter((s) => s.staked).map((s) => BigInt(s.tokenId))])];
  const beasts = await batched(ids, async (id) => decodeBeast(hex(id), await nft("get_beast", [hex(id)]), stakes.get(id)));
  const out: Record<string, Beast[]> = Object.fromEntries(Object.keys(DUNGEONS).map((key) => [key, []]));
  for (const b of beasts) (out[b.collection] ??= []).push(b);
  return out;
}
