import { serve } from "./server.ts";
import { emit, subscribe } from "./events.ts";

subscribe((e) => console.log(JSON.stringify(e)));
serve();
emit({ kind: "status", text: "service up" });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
