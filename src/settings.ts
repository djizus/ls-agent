import { DUNGEON, GAME_CORE } from "./config.ts";
import type { MarketConfig } from "./market.ts";
import { provider } from "./wallet.ts";

const out = await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "get_settings", calldata: [String(DUNGEON.settingsId)] });
const [pair01, pair23, pair4_enabled] = out.slice(-6, -3).map(BigInt);

export const MARKET: MarketConfig = { pair01, pair23, pair4_enabled };
export const AMBUSH_REDUCTION = Number(out.at(-7));
