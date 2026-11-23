import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { VAR_DIR } from "./config.ts";
import SHIPPED from "./rules.json" with { type: "json" };

export type Rules = typeof SHIPPED;
export { SHIPPED };
const FILE = `${VAR_DIR}rules.json`;
const POLICY = readFileSync(new URL("./policy.ts", import.meta.url));

const changed = (): Partial<Rules> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const chosen = (): Rules => ({ ...SHIPPED, ...Object.fromEntries(Object.entries(changed()).filter(([name]) => name in SHIPPED)) });
export const RULES: Rules = chosen();
export const version = (rules: Rules): string => createHash("sha256").update(POLICY).update(JSON.stringify(rules)).digest("hex").slice(0, 8);

export function changes(args: string[]): Partial<Rules> {
  return Object.fromEntries(
    args.map((arg) => {
      const [name, value] = arg.split("=");
      if (!(name in SHIPPED)) throw new Error(`no rule ${name}: the rules are ${Object.keys(SHIPPED).join(", ")}`);
      if (value === undefined || value.trim() === "" || !Number.isFinite(Number(value))) throw new Error(`${name} takes a number, not ${value ?? "nothing"}`);
      return [name, Number(value)];
    }),
  );
}

export function choose(args: string[]): Rules {
  const rules = { ...chosen(), ...changes(args) };
  const kept = Object.entries(rules).filter(([name, value]) => SHIPPED[name as keyof Rules] !== value);
  if (kept.length) writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
  else rmSync(FILE, { force: true });
  return rules;
}
