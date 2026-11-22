import { DUNGEONS, GAME_CORE, dungeonOf } from "./config.ts";
import type { MarketConfig } from "./market.ts";
import { provider } from "./wallet.ts";

type Settings = { market: MarketConfig; ambush: number };

const read = async (settingsId: number): Promise<Settings> => {
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "get_settings", calldata: [String(settingsId)] });
  const [pair01, pair23, pair4_enabled] = out.slice(-6, -3).map(BigInt);
  return { market: { pair01, pair23, pair4_enabled }, ambush: Number(out.at(-7)) };
};

const SETTINGS: Record<string, Settings> = Object.fromEntries(await Promise.all(Object.entries(DUNGEONS).map(async ([key, d]) => [key, await read(d.settingsId)])));

export const settingsOf = (gameId: string | bigint): Settings => SETTINGS[dungeonOf(gameId)];
