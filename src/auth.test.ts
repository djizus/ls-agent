import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const started: ReturnType<typeof spawn>[] = [];
after(() => started.forEach((service) => service.kill()));

async function service(token: string): Promise<(path: string, init?: RequestInit) => Promise<[number, string]>> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const env = { ...process.env, LS_HOST: "127.0.0.1", LS_PORT: String(port), LS_TOKEN: token, LS_VAR_DIR: mkdtempSync(join(tmpdir(), "ls-auth-")) + "/" };
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  started.push(spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", new URL("./tape.ts", import.meta.url).pathname, cli, "start"], { env, stdio: "ignore" }));
  const ask = async (path: string, init?: RequestInit): Promise<[number, string]> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return [res.status, await res.text()];
  };
  for (let i = 0; ; i++) {
    if (await ask("/api/cycle").then(() => true, () => false)) return ask;
    if (i === 100) throw new Error("the service did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("an action needs the token: none or a wrong one answers 401 with the reason, the right one passes, and reads stay open", { timeout: 30_000 }, async () => {
  const ask = await service("s3cret");
  assert.deepEqual(await ask("/api/stop", { method: "POST" }), [401, "send the header Authorization: Bearer <LS_TOKEN>"]);
  assert.deepEqual(await ask("/api/stop", { method: "POST", headers: bearer("guess") }), [401, "wrong token"]);
  assert.deepEqual(await ask("/api/bags", { method: "POST", headers: bearer("s3cret!") }), [401, "wrong token"]);
  assert.deepEqual(await ask("/api/play", { method: "POST", body: JSON.stringify({ seats: [{ dungeon: "beast" }] }) }), [401, "send the header Authorization: Bearer <LS_TOKEN>"]);
  assert.deepEqual(await ask("/api/stop", { method: "POST", headers: bearer("s3cret") }), [200, "ok"]);
  assert.deepEqual(await ask("/api/auth", { headers: bearer("s3cret") }), [204, ""]);
  assert.deepEqual(await ask("/api/auth", { headers: bearer("guess") }), [401, "wrong token"]);
  assert.deepEqual(await ask("/api/auth"), [401, "send the header Authorization: Bearer <LS_TOKEN>"]);
  assert.equal((await ask("/api/cycle"))[0], 200);
});

test("with no token configured every action answers 403 and says how to allow them, and reads stay open", { timeout: 30_000 }, async () => {
  const ask = await service("");
  assert.deepEqual(await ask("/api/stop", { method: "POST", headers: bearer("anything") }), [403, "set LS_TOKEN to allow actions"]);
  assert.deepEqual(await ask("/api/rules", { method: "POST", body: JSON.stringify({ set: ["fightRisk=0.25"] }) }), [403, "set LS_TOKEN to allow actions"]);
  assert.deepEqual(await ask("/api/auth"), [403, "set LS_TOKEN to allow actions"]);
  assert.equal((await ask("/api/rules"))[0], 200);
});
