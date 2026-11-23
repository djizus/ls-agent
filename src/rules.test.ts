import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

process.env.LS_VAR_DIR = `${mkdtempSync(`${tmpdir()}/ls-rules-`)}/`;
const { SHIPPED, changes, choose, chosen, version } = await import("./rules.ts");
const FILE = `${process.env.LS_VAR_DIR}rules.json`;

test("a rule change is refused for an unknown rule or a value that is not a number", () => {
  assert.throws(() => changes(["nope=1"]), /^Error: no rule nope: the rules are potionPrice, /);
  assert.throws(() => changes(["fightRisk=high"]), /^Error: fightRisk takes a number, not high$/);
  assert.throws(() => changes(["fightRisk"]), /^Error: fightRisk takes a number, not nothing$/);
  assert.throws(() => choose(["fightRisk=0.25", "nope=1"]), /no rule nope/);
  assert.equal(existsSync(FILE), false);
});

test("a rule set is kept in var/ apart from the shipped rules, gives another strategy id, and setting it back to the shipped value drops the file", () => {
  assert.deepEqual(chosen(), SHIPPED);
  const set = choose(["fightRisk=0.25", "jewelryLevel=9"]);
  assert.deepEqual(set, { ...SHIPPED, fightRisk: 0.25, jewelryLevel: 9 });
  assert.deepEqual(chosen(), set);
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")), { fightRisk: 0.25, jewelryLevel: 9 });
  assert.notEqual(version(set), version(SHIPPED));
  choose([`fightRisk=${SHIPPED.fightRisk}`, `jewelryLevel=${SHIPPED.jewelryLevel}`]);
  assert.equal(existsSync(FILE), false);
  assert.equal(version(chosen()), version(SHIPPED));
});
