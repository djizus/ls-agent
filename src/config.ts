export const RPC_URL = process.env.LS_RPC_URL ?? "https://api.zan.top/public/starknet-mainnet";
export const VAR_DIR = process.env.LS_VAR_DIR ?? new URL("../var/", import.meta.url).pathname;
export const PORT = Number(process.env.LS_PORT ?? 4100);

export const OZ_ACCOUNT_CLASS = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";
export const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
