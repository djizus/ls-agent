import { hash } from "starknet";
import { GAME_CORE } from "./config.ts";
import type { Chain } from "./practice.ts";
import { provider } from "./wallet.ts";

const COMMITTED = hash.getSelectorFromName("ActionCommitted");

export async function transcript(id: string): Promise<{ packets: bigint[]; chain: Chain }> {
  const from = Number((await provider.callContract({ contractAddress: GAME_CORE, entrypoint: "minted_at_block_number", calldata: [id] }))[0]);
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
