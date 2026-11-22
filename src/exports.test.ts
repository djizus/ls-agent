import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
const sources = ["src", "scripts"].flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)));
const text = Object.fromEntries(sources.map((f) => [f, readFileSync(join(root, f), "utf8")]));

function imported(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of sources)
    for (const m of text[f].matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]+)"|const\s*\{([^}]*)\}\s*=\s*await import\("(\.[^"]+)"\)/g)) {
      const target = join(dirname(f), m[2] ?? m[4]);
      const names = (m[1] ?? m[3]).split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/)[0]).filter(Boolean);
      names.forEach((n) => (out.get(target) ?? out.set(target, new Set()).get(target)!).add(n));
    }
  return out;
}

test("every export is imported by another file", () => {
  const used = imported();
  const unread = sources.filter((f) => !f.endsWith(".test.ts")).flatMap((f) =>
    [...text[f].matchAll(/^export (?:async )?(?:function|const|let|class|type|interface) (\w+)/gm)].map((m) => m[1]).filter((name) => !used.get(f)?.has(name)).map((name) => `${f} ${name}`),
  );
  assert.deepEqual(unread, []);
});
