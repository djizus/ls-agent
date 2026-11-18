import { serve } from "./server.ts";
import { emit, subscribe } from "./events.ts";

subscribe((e) => console.log(JSON.stringify(e)));
serve();
emit({ kind: "status", text: "service up" });
