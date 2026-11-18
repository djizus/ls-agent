export const RPC_URL = process.env.LS_RPC_URL ?? "https://starknet-rpc.publicnode.com";
export const VAR_DIR = process.env.LS_VAR_DIR ?? new URL("../var/", import.meta.url).pathname;
export const PORT = Number(process.env.LS_PORT ?? 4100);

export const OZ_ACCOUNT_CLASS = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";
export const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const GAME_API = "https://api-v2-next.up.railway.app";
export const GAME_CORE = "0x03cafe867e9f5dc7ccf73471b98c1d6d6d54804744cef9626accd217b6ad1dd2";
export const BEAST_MODE = { address: "0x075ca042091b8e1418d0510b8d6519a89222ef5f7bbceb0ff760bb3c62c98174", minterId: 1 };
export const TICKET = "0x0452810188C4Cb3AEbD63711a3b445755BC0D6C4f27B923fDd99B1A118858136";
