import { DUNGEON, GAME_CORE } from "./config.ts";
import type { MarketConfig } from "./market.ts";
import { provider } from "./wallet.ts";

async function marketConfig(settingsId: number): Promise<MarketConfig> {
  const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "get_settings", calldata: [String(settingsId)] });
  const [pair01, pair23, pair4_enabled] = out.slice(-6, -3).map(BigInt);
  return { pair01, pair23, pair4_enabled };
}

export const MARKET = await marketConfig(DUNGEON.settingsId);
