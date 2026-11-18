import { deploy, isDeployed, keys, strkBalance } from "./wallet.ts";

const commands: Record<string, () => Promise<unknown>> = {
  async wallet() {
    const { address } = keys();
    return { address, deployed: await isDeployed(), strk: Number(await strkBalance()) / 1e18 };
  },
  deploy,
};

const run = commands[process.argv[2] ?? ""];
if (!run) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
console.log(JSON.stringify(await run(), null, 2));
