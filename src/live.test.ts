import assert from "node:assert/strict";
import { test } from "node:test";
import { DUNGEONS, SURVIVOR } from "./config.ts";
import { bagPurchase, forSale, heldGames, readQuote, units, unranked } from "./live.ts";

const POOL = DUNGEONS.lootBag.pool!;
const ME = "0x123";
const HELD = ["0x3", "0x1c878b901144c4a000161c1", "0x100000000001e7e0000040000000006", "0x1c878ba01144c53000b1e41", "0x100000000001f050000040000000006", "0x1c878ba01144c5600057861", "0x100000000001e7e0000040000000006"];
const QUOTE = ["0x0", "0x7068197160bf10d8937", "0x1ed", "0x48d063656d4f33555", "0x0", "0x2e99d936ac5ba5fa", "0x0", "0xba6764dab16e97e4", "0x0"];
const RICH = 200n * 10n ** 18n;

test("the ranked bags are listed with the copies the pool holds now, and a bag it no longer holds is left out", () => {
  assert.deepEqual(forSale([{ bag: 7962, mean: 26 }, { bag: 7806, mean: 24.5 }, { bag: 7941, mean: 24 }], HELD), [{ bag: 7806, mean: 24.5, n: 2 }, { bag: 7941, mean: 24, n: 1 }]);
});

test("a bag the pool holds and the ranking lacks is found with one of its games", () => {
  assert.deepEqual(unranked(HELD, [7806]), [{ bag: 7941, game: "0x0100000000001f0500000400000000060000000001c878ba01144c53000b1e41" }]);
  assert.deepEqual(unranked(HELD, [7806, 7941]), []);
});

test("the pool's games of one bag are found by the bag number inside the game id", () => {
  assert.deepEqual(heldGames(HELD, 7806), ["0x0100000000001e7e00000400000000060000000001c878b901144c4a000161c1", "0x0100000000001e7e00000400000000060000000001c878ba01144c5600057861"]);
  assert.deepEqual(heldGames(HELD, 7962), []);
});

test("a recorded pool quote reads as the full price with its fee and royalty", () => {
  const quote = readQuote(QUOTE);
  assert.deepEqual(quote, { price: 83948845650614105429n, protocolFee: 3357953826024564218n, royalty: 13431815304098256868n });
  assert.equal(units(quote.price), "83.948845650614105429");
  assert.throws(() => readQuote(["0x1", ...QUOTE.slice(1)]), /curve error 1/);
});

test("buying a bag approves the cap, swaps for that one game to the wallet, and clears the allowance", () => {
  const { id, calls } = bagPurchase(POOL, heldGames(HELD, 7806), readQuote(QUOTE), { bag: 7806, maxSurvivor: 90 }, ME, RICH);
  assert.equal(id, "0x0100000000001e7e00000400000000060000000001c878b901144c4a000161c1");
  assert.deepEqual(calls, [
    { contractAddress: SURVIVOR, entrypoint: "approve", calldata: [POOL, "0x4e1003b28d9280000", "0x0"] },
    { contractAddress: POOL, entrypoint: "swap_token_for_specific_nfts", calldata: ["0x1", "0x1c878b901144c4a000161c1", "0x100000000001e7e0000040000000006", "0x4e1003b28d9280000", "0x0", ME, "0x0", "0x0"] },
    { contractAddress: SURVIVOR, entrypoint: "approve", calldata: [POOL, "0x0", "0x0"] },
  ]);
});

test("a bag is not bought above the cap, without a cap, when the pool lacks it, or when the wallet is short", () => {
  const buy = (bag: number, maxSurvivor: number, survivor = RICH) => () => bagPurchase(POOL, heldGames(HELD, bag), readQuote(QUOTE), { bag, maxSurvivor }, ME, survivor);
  assert.throws(buy(7806, 83.9), /costs 83.948845650614105429 SURVIVOR, over the 83.9 limit/);
  assert.throws(buy(7806, NaN), /maxSurvivor/);
  assert.throws(buy(7962, 90), /holds no game of bag 7962/);
  assert.throws(buy(7806, 90, 50n * 10n ** 18n), /the wallet holds 50/);
});
