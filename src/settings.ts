import { DUNGEONS, GAME_CORE, GREED, settingsIdOf } from "./config.ts";
import type { MarketConfig } from "./market.ts";
import { provider } from "./wallet.ts";

type Settings = { market: MarketConfig; ambush: number };

const read = async (settingsId: number): Promise<Settings> => {
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "get_settings", calldata: [String(settingsId)] });
  const [pair01, pair23, pair4_enabled] = out.slice(-6, -3).map(BigInt);
  return { market: { pair01, pair23, pair4_enabled }, ambush: Number(out.at(-7)) };
};

const IDS = [...Object.values(DUNGEONS).map((d) => d.settingsId), GREED.settingsId];
const SETTINGS = new Map(await Promise.all(IDS.map(async (id) => [id, await read(id)] as const)));

export function settingsOf(gameId: string | bigint): Settings {
  const settings = SETTINGS.get(settingsIdOf(gameId));
  if (!settings) throw new Error(`game ${BigInt(gameId).toString(16)} has settings ${settingsIdOf(gameId)}, which no dungeon here uses`);
  return settings;
}
