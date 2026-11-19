import { cancel } from "./decide.ts";
import { playBenchmark } from "./runner.ts";
import { serve } from "./server.ts";
import { emit, subscribe } from "./events.ts";

subscribe((e) => console.log(JSON.stringify(e)));
serve();
emit({ kind: "status", text: "service up" });
if (process.env.LS_AUTOPLAY) playBenchmark(undefined, true);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
process.on("exit", cancel);
