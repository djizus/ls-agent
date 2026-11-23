import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePacket, type Action } from "./codec.ts";
import { DUNGEONS } from "./config.ts";
import { begin, commit, current, enrich, namedKills, namedSlain, render, shape, type State, type Table } from "./play.ts";
import { step, toSnapshot } from "./engine/engine.ts";
import { act, newPracticeGame, randomHash, replay, type Snapshot } from "./practice.ts";

const move = async (table: Table, actions: Action[]): Promise<State> => {
  const [moved] = (await commit([{ table, actions }])).committed;
  if ("error" in moved) throw moved.error;
  return moved.state;
};

test("market and potions are open between fights, not only at level-up", { timeout: 120_000 }, async () => {
  const table = await begin(DUNGEONS.beast.benchmark[0]);
  let state = current(table);
  while (state.beast || state.statUpgradesAvailable > 0 || state.health === state.maxHealth) {
    const points = state.statUpgradesAvailable;
    const upgrade = points > 0 ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : [];
    state = await move(table, [...upgrade, { type: state.beast ? "attack" : "explore" }]);
  }
  assert.ok(state.market.length > 0);
  assert.match(render(state), /Potions: \d+ gold each/);
  const healed = await move(table, [{ type: "potions", qty: 1 }, { type: "buy", item: state.market[0].id, equip: false }, { type: "explore" }]);
  assert.ok(healed.bag.some((b) => b.id === state.market[0].id));
});

test("attack and flee without a threshold run until the fight ends; tillHealth stops early", { timeout: 120_000 }, async () => {
  const game = await newPracticeGame(DUNGEONS.beast.benchmark[4]);
  let snap = await replay(game);
  while (snap.adventurer.beast_health === 0) {
    const points = snap.adventurer.stat_upgrades_available;
    snap = act(game, [...(points ? [{ type: "upgrade" as const, stat: "dexterity" as const, amount: points }] : []), { type: "explore" }]);
  }
  const ended = (o: Snapshot) => o.adventurer.health === 0 || o.adventurer.beast_health === 0;
  const outcomes = (actions: Action[]) => Array.from({ length: 8 }, () => toSnapshot(step(game.local, game.id, encodePacket(actions), randomHash())));
  assert.ok(outcomes([{ type: "attack" }]).every(ended));
  assert.ok(outcomes([{ type: "flee" }]).every(ended));
  const floor = snap.adventurer.health - 1;
  assert.ok(outcomes([{ type: "attack", tillHealth: floor }]).every((o) => o.adventurer.health > 0 && (o.adventurer.beast_health === 0 || o.adventurer.health <= floor)));
});

test("potion price formula matches the contract; explores are healed first", { timeout: 300_000 }, async () => {
  let table: Table;
  const hurtWithGold = async (id: string): Promise<State | undefined> => {
    table = await begin(id);
    let state = current(table);
    while (state.beast || state.statUpgradesAvailable > 0 || state.health > state.maxHealth - 20 || state.gold < 2) {
      if (state.statUpgradesAvailable > 0) {
        state = await move(table, shape(state, [{ type: "upgrade", stat: "charisma", amount: state.statUpgradesAvailable }, { type: "explore" }]));
        continue;
      }
      state = await move(table, state.beast ? [{ type: "attack" }] : [{ type: "explore" }]);
      if (state.over) return undefined;
    }
    return state;
  };
  let state: State | undefined;
  for (const id of DUNGEONS.beast.benchmark) if ((state = await hurtWithGold(id))) break;
  assert.ok(state, "no benchmark adventurer reached a hurt state with gold");
  const goldBefore = state.gold;
  const healthBefore = state.health;
  const healed = shape(state, [{ type: "explore" }]);
  const potions = healed.find((a) => a.type === "potions");
  assert.ok(potions && potions.type === "potions");
  assert.equal(potions.qty, Math.min(Math.ceil((state.maxHealth - state.health) / 10), Math.floor(state.gold / state.potionPrice)));
  const one = await move(table!, [{ type: "potions", qty: 1 }]);
  assert.equal(goldBefore - one.gold, state.potionPrice);
  assert.equal(one.health, Math.min(healthBefore + 10, state.maxHealth));
});

test("a stored state gains luck, chances, grants, purse and the experience to the next level, whatever its age", () => {
  const worn = (id: number, name: string, slot: string, type: string, tier: number, extra: object) => ({ id, name, slot, type, tier, ...extra });
  const state = enrich({
    over: false, level: 20, health: 100, maxHealth: 250, xp: 400, gold: 30, beast: null, statUpgradesAvailable: 0,
    stats: { strength: 4, dexterity: 10, vitality: 10, intelligence: 2, wisdom: 5, charisma: 9 },
    equipment: {
      chest: worn(50, "Hard Leather Armor", "chest", "Hide", 4, { level: 16, bonus: { wisdom: 3 } }),
      neck: worn(1, "Pendant", "neck", "Necklace", 1, { greatness: 10, xp: 100 }),
      ring: worn(4, "Silver Ring", "ring", "Ring", 2, { greatness: 6, xp: 40 }),
    },
    bag: [worn(8, "Gold Ring", "ring", "Ring", 1, { greatness: 3, xp: 9 }), worn(61, "Leather Belt", "waist", "Hide", 5, { greatness: 15, xp: 225, bonus: { vitality: 2, dexterity: 1 } })],
    market: [worn(49, "Studded Leather Armor", "chest", "Hide", 3, { price: 3 }), worn(56, "Cap", "head", "Hide", 5, { price: 1 }), worn(7, "Titanium Ring", "ring", "Ring", 1, { price: 11 })],
  } as unknown as Parameters<typeof enrich>[0]);
  assert.equal(state.luck, 10 + 2 * 6 + 3);
  assert.equal(state.toLevel, 41);
  assert.deepEqual(state.buys, { attack: 40, flee: 50, trap: 10, ambush: 25, crit: 25 });
  assert.deepEqual(state.baseStats, { strength: 4, dexterity: 10, vitality: 8, intelligence: 2, wisdom: 2, charisma: 9 });
  assert.deepEqual(state.equipment.map((g) => [g.greatness, g.toNext, g.grants]), [
    [16, 33, ["+3 wisdom"]],
    [10, 21, ["+10 luck", "Hide armor blocks 30% more (1 of 5 worn)"]],
    [6, 9, ["+12 luck (doubled while worn)"]],
  ]);
  assert.deepEqual(state.bag.map((g) => g.grants), [["+3 luck"], ["+2 vitality"]]);
  assert.deepEqual(state.purse, { potions: 15, toFull: 15, deal: { ...state.market[1], why: "empty head" } });
  assert.deepEqual(enrich(state), state);
});

test("a recorded game counts the named beasts it killed by attacking, not plain beasts, escapes or the one that killed it", () => {
  const beast = (specialPrefix: string | null) => ({ beast: { specialPrefix } as State["beast"], over: false });
  const clear = { beast: null, over: false };
  const decision = (type: string) => ({ kind: "decision", actions: [{ type }] });
  const state = (s: { beast: State["beast"]; over: boolean }) => ({ kind: "state", state: s });
  const recorded = [
    { kind: "status" },
    state(clear),
    decision("explore"), state(beast("Horror")),
    decision("attack"), state(beast("Horror")),
    decision("attack"), state(clear),
    decision("explore"), state(beast(null)),
    decision("attack"), state(clear),
    decision("explore"), state(beast("Brood")),
    decision("flee"), state(clear),
    decision("explore"), state(beast("Golem")),
    decision("equip"), state(beast("Golem")),
    decision("attack"), { kind: "rejected" }, decision("attack"), state(clear),
    decision("explore"), state(beast("Victory")),
    decision("attack"), state({ beast: null, over: true }),
  ];
  assert.equal(namedSlain(recorded), 2);
  assert.deepEqual(namedKills(recorded).map((b) => [b.specialPrefix, b.move]), [["Horror", 2], ["Golem", 9]]);
  assert.equal(namedSlain([]), 0);
});

test("games moved in one round each advance as they would alone", { timeout: 120_000 }, async () => {
  const [a, b, alone] = [await begin(DUNGEONS.beast.benchmark[0]), await begin(DUNGEONS.beast.benchmark[1]), await begin(DUNGEONS.beast.benchmark[1])];
  const explore = (t: Table): Action[] => shape(current(t), [{ type: "upgrade", stat: "dexterity", amount: current(t).statUpgradesAvailable }, { type: "explore" }]).filter((x) => x.type !== "upgrade" || x.amount > 0);
  const together = (await commit([{ table: a, actions: explore(a) }, { table: b, actions: [{ type: "flee" }] }])).committed;
  assert.ok("state" in together[0] && together[0].state.xp > 0);
  assert.ok("error" in together[1] && /battle/.test(together[1].error.message));
  const [second] = (await commit([{ table: b, actions: explore(b) }])).committed;
  assert.deepEqual("state" in second && second.state, await move(alone, explore(alone)));
});
