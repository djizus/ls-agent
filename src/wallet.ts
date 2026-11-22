import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, CallData, RpcProvider, ec, hash, stark, type GetTransactionReceiptResponse } from "starknet";
import { OZ_ACCOUNT_CLASS, RPC_URL, STRK, VAR_DIR } from "./config.ts";
import { nextHead } from "./heads.ts";
import { INCLUSION_MS, request } from "./net.ts";

type Keys = { privateKey: string; publicKey: string; address: string };

const file = `${VAR_DIR}wallet.json`;
export const provider = new RpcProvider({ nodeUrl: RPC_URL, batch: 0, baseFetch: request });

export function keys(): Keys {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const privateKey = stark.randomAddress();
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const calldata = CallData.compile({ publicKey });
  const address = hash.calculateContractAddressFromHash(publicKey, OZ_ACCOUNT_CLASS, calldata, 0);
  mkdirSync(VAR_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ privateKey, publicKey, address }, null, 2), { mode: 0o600, flag: "wx" });
  return keys();
}

export function account(): Account {
  const k = keys();
  return new Account({ provider, address: k.address, signer: k.privateKey });
}

export async function balanceOf(token: string, address = keys().address): Promise<bigint> {
  const [low, high] = await provider.callContract({ contractAddress: token, entrypoint: "balance_of", calldata: [address] });
  return BigInt(low) + (BigInt(high) << 128n);
}

export const strkBalance = (): Promise<bigint> => balanceOf(STRK);

export async function isDeployed(address = keys().address): Promise<boolean> {
  try {
    await provider.getClassHashAt(address);
    return true;
  } catch {
    return false;
  }
}

export async function deploy(): Promise<string> {
  const k = keys();
  if (await isDeployed()) return "already deployed";
  const { transaction_hash } = await account().deployAccount({
    classHash: OZ_ACCOUNT_CLASS,
    constructorCalldata: CallData.compile({ publicKey: k.publicKey }),
    addressSalt: k.publicKey,
  });
  await included(transaction_hash);
  return transaction_hash;
}

export async function included(transaction_hash: string, read = () => provider.getTransactionReceipt(transaction_hash), wait = nextHead, ms = INCLUSION_MS) {
  for (const end = Date.now() + ms; Date.now() < end; await wait()) {
    const receipt: GetTransactionReceiptResponse | undefined = await read().catch(() => undefined);
    if (receipt?.isSuccess() && "block_hash" in receipt.value && receipt.value.block_hash) return receipt.value;
    if (receipt && (receipt.isReverted() || receipt.isError())) throw new Error(`transaction ${transaction_hash} failed`);
  }
  throw new Error(`transaction ${transaction_hash} not included within ${ms / 60_000} minutes`);
}
