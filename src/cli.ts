import { inventory, pendingClaims } from "./beasts.ts";
import { collect, quote } from "./live.ts";
import { deploy, isDeployed, keys, strkBalance } from "./wallet.ts";

const commands: Record<string, () => Promise<unknown>> = {
  async wallet() {
    const { address } = keys();
    return { address, deployed: await isDeployed(), strk: Number(await strkBalance()) / 1e18 };
  },
  deploy,
  collect: async () => (await collect(process.argv[3])) ?? "nothing to claim",
  quote: () => quote(process.argv[3]),
  async beasts() {
    const address = process.argv[3] ?? keys().address;
    const [beasts, claims] = await Promise.all([inventory(address), pendingClaims(address)]);
    return { address, inventory: beasts, pendingClaims: claims };
  },
};

const run = commands[process.argv[2] ?? ""];
if (!run) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
console.log(JSON.stringify(await run(), null, 2));
