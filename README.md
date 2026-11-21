# ls-agent

A bot that plays Loot Survivor 2 (Death Mountain) on Starknet mainnet with a fixed rule policy.
It includes a local port of the game for free practice games and benchmarks, and a one-screen page for watching real games.

## Quick start

You need Node 22.18 or newer, bash, curl and an internet connection. Nothing in this section spends money.

```
npm install
npm test
npm start
```

`npm test` compares the local port of the game with the contract, through a public Starknet node. `npm start` serves the page on http://127.0.0.1:4100.

In a second terminal, play 20 practice games (about three minutes):

```
curl -X POST 127.0.0.1:4100/api/play -d '{"games":20}'
```

The service log prints each decision. "Practice" in the Games panel on the page lists them with their main figures, the share that reached level 30 among them. The middle of the page stays on "No real game yet", because it only shows games played on chain. A pass plays up to 20 fixed starts, and each complete pass of 20 uses new luck.

Measure the policy on 10,000 generated starts (under a minute on 14 cores):

```
npm run bench
```

The first page load writes a new wallet key to `var/wallet.json`. The wallet is empty and the bot cannot spend until you fund it. Everything the bot stores is in `var/`, which git ignores.

## Prove it

```
npm run prove -- 2
```

Starts the real service on port 4199, plays 2 practice games through the HTTP API and leaves the database, service log, event stream and game list in `var/evidence/<timestamp>/`.

## Playing for real

Real games send transactions on Starknet mainnet and spend STRK from the bot's own wallet. Read this section before you fund it.

1. `node src/cli.ts wallet` prints the wallet address, creating the key if needed.
2. Send STRK to that address. The bot refuses to send a transaction while the balance is under 50 STRK, so fund more than that.
3. `node src/cli.ts deploy` deploys the account (one small fee).
4. On the same machine, `curl -X POST 127.0.0.1:4100/api/play -d '{"live":true}'` plays one game; `'{"live":true,"games":3}'` plays three.

| What | Cost or risk |
|---|---|
| Wallet key | `var/wallet.json` holds the private key in plain text, readable only by your user. Whoever reads the file owns the funds. If you delete `var/`, the funds are lost. Back the file up. |
| Spend floor | 50 STRK, `STRK_FLOOR` in `src/config.ts`. Under it the bot sends nothing. It is the only spending limit: above the floor the bot keeps paying for as many games as you start. |
| Tickets | A game uses one dungeon ticket. With less than one ticket left, the bot buys 10 on Ekubo and refuses if they cost more than 2 STRK. |
| Loot Bag games | With `LS_DUNGEON=lootBag` a game starts by buying one bag from the game's pool with SURVIVOR, so the wallet needs SURVIVOR as well as STRK. Name the bag and the most you will pay: `curl -X POST 127.0.0.1:4100/api/play -d '{"live":true,"bag":7806,"maxSurvivor":90}'`. The bot refuses when the price is above `maxSurvivor`, when the pool no longer holds that bag, or when the wallet is short. The price rises a little with each bag sold: 84 SURVIVOR at the time of writing, fee and royalty included. `node src/cli.ts bag <bag number>` prints the price now, whether the pool holds the bag, and a simulated purchase, without sending anything. If a purchase fails with an unclear error, check the wallet before you retry: a retry buys another copy. |
| A game | Each move is one transaction. 8 recorded Beast Mode games cost 0.8 to 3.9 STRK each, 2.5 at the median, about 0.04 STRK per move. Fees change with the network. |
| Settlement | When a finished game killed a beast that can be collected, the bot settles the game on chain a minute later and claims the beast. Simulated cost: 0.5 STRK for a 13-move game, 3.1 STRK for a 115-move game. `node src/cli.ts quote <game id>` simulates it for one game without sending anything. |
| Stopping | `curl -X POST 127.0.0.1:4100/api/stop` ends play after the current move. Unfinished games are kept in `var/live.json` and resume on the next start, before any new game. The bot stops by itself if its local state differs from the contract. |
| Other machines | By default only your machine can reach the page. If you set `LS_HOST` to serve other machines, they can read everything and change nothing: the server refuses any request that is not a GET. A reverse proxy running on the same machine makes every visitor look local, so do not put one in front without its own access control. |
| Outside services | A public Starknet node (HTTP, and its websocket for new block heads: a move's receipt is read when a head arrives, or after 2 seconds of silence), the game's API (beasts), Ekubo (ticket price, STRK and SURVIVOR prices in dollars) and `lootsurvivor.io` (the embedded spectator). |

The policy loses most games early. In the benchmark, 13% of games reach level 26. Expect to pay for many short games.

## Settings

Settings are environment variables. `scripts/prove.sh` also reads `~/.config/ls-agent/env` when the file exists.

| Variable | Default | Meaning |
|---|---|---|
| `LS_DECIDER` | `rules` | Who decides each move. `rules` is the policy in `src/policy.ts`: it runs locally, calls no model and costs nothing. `jev` and `model` ask an outside model and need your own access (below). |
| `LS_DUNGEON` | `beast` | `beast` or `lootBag`, the keys of `DUNGEONS` in `src/config.ts` |
| `LS_PACE_MS` | 0 | Pause between a decision and its move, for watching |
| `LS_SEATS` | 1 | Real games played at once with the `rules` decider. Each round decides one move per game and sends them in one transaction, so its fixed fee is shared; a game that ends is settled a minute later and its seat takes the next game of the batch. A move the contract refuses goes back to that game alone as a rejected decision. A game whose round fails on an error (the node, the socket) is read again from the chain and goes on in the same batch; at the third failure in a row it is stopped. Once a real game is stopped unfinished, the batch starts no new game. |
| `LS_RPC_URL` | public node | Starknet RPC |
| `LS_HOST`, `LS_PORT` | 127.0.0.1, 4100 | Where the page is served |
| `LS_VAR_DIR` | `var/` | Where the wallet, database and caches are stored. End it with a slash. |
| `LS_BEASTS_TO` | unset | Account that receives every beast right after it is claimed. The page lists this account's beasts; unset, it lists the wallet's. |
| `TYPESAFE_API_KEY`, `LS_JEV_MODEL` | none, `jev-latest` | For `LS_DECIDER=jev`: your key for `api.typesafe.ai` and the model name |
| `LS_MODEL`, `LS_EFFORT`, `LS_STRATEGY` | `a model`, `medium`, `strategy/prompt.md` | For `LS_DECIDER=model`: it runs the `model` command, which must be installed and logged in on your account |

## Measure a policy

`npm run bench` plays the rule policy from 10,000 generated starts, the same on every run, and prints the mean level, its spread, the share of games reaching level 26, 30, 35 and 40, beasts killed, and where games died. A difference under two standard errors is noise.

| Command | What it does |
|---|---|
| `npm run bench -- --rules '{}' --rules '{"jewelryLevel":99}'` | Overrides fields of `RULES` in `src/policy.ts` and compares each variant with the first on the same games |
| `npm run bench -- --gate` | Fails when the mean drops 0.25 levels, the 30+ share drops 1 point or named kills per game drop 0.1 below `scripts/baseline.json`. `--save` rewrites the baseline. |
| `npm run bench -- --starts 50000 --from 1000000` | More starts, or other starts, to confirm a result on games it was not chosen on |
| `npm run bench -- --starts 40000 --reach 30 --keep var/level30.json` | Saves every game at the moment it reaches level 30 |
| `npm run bench -- --starts 30000 --reach weapon --keep var/weapon20.json` | Saves every game at the moment its worn weapon reaches greatness 20 |
| `npm run bench -- --late var/level30.json --seeds 0-10` | Plays those saved games forward on 10 luck seeds each, to measure late-game rules |
| `npm run bench -- --exact` | Uses the contract's hash for luck in place of the fast one: same distribution, 30 times slower |
| `LS_DUNGEON=lootBag npm run bench -- --ids bags.json --by-id` | Loot bag starts are fixed, so each game id in the file is played on 500 luck seeds, with one line per id |
| `LS_DUNGEON=lootBag npm run bench -- --rank scripts/bag-ranking.json` | First adds every bag the pool holds that the list lacks, with its starting gear read from the contract, then replays every bag in the list and rewrites its figures (about 8 minutes on 14 cores). A second run adds nothing. |
| `node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35]}' --level 35` | Moves one `RULES` field at a time to the value that raises the share reaching that level, then confirms on other starts |

## Feature map

| Feature | How to reach it |
|---|---|
| One screen: live games as cards in the middle, panels around them | `/` shows one card per live real game (two columns up to four games, four columns beyond; eight fit a 1080p screen, on a phone they stack). A card shows the game number, the level and the experience to the next one, health, gold, named beasts slain and how many can be claimed, the beast being fought (portrait, name, tier, level, its health) or the last thing that happened, the eight worn items with their greatness, and the last decision (Fight and Flee with their odds, or Explore). Cards follow the event stream (`GET /events`, every event carries its game row) and the games list is read again at most once per round. "Details" on a card opens that game in the official spectator (`/?game=<row id>`) and "Back to live" returns to the cards. With no live game `/` shows the latest real game in the spectator. A game that just started shows "Game N starts" for its first 10 seconds, then the spectator, which cannot load a game its indexer has not seen yet. "Reload" beside the game number in the bar under the spectator loads the spectator again, for when it opened before its indexer had the game. |
| Watch a real game | "Details" on a live card or a click on a finished game in the list embeds `https://www.lootsurvivor.io/watch?id=<game id in decimal>` in the middle panel. Only one spectator is loaded at a time. |
| What the bot just decided in a live game | The last chip of its card; with the game open in the spectator, the bar under it, after the named beasts slain so far and how many of them can still be claimed: nobody minted them yet, or they can be taken from a stake as of the block of the kill (`GET /api/games` counts them for a live game with the rule used when a game ends; the games list shows live games as one "Live" row with their number and the best level among them, and a click on it shows the cards). For a finished game it shows the level reached, the beast that killed it, the named beasts slain, how many beasts its settlement claimed (games settled since that count is recorded) and the STRK it cost. Between its end and its settlement a game keeps the count it can claim. In the games list and on the podium the skull and count of a game are gold when it claimed a beast or can claim one. |
| Pick a real game | "Games" on the left, with "Beast" or "Loot" in its header choosing the dungeon ("Practice" lists the practice games of the newest policy version, which cannot be opened): the three best by level as a podium, the latest 20 newest first, with "More" showing them all. The live games are on top in every state. A Loot Dungeon game carries a bag where a Beast Mode game carries a skull, unless a beast that killed it is shown. The list holds every game of the dungeon, podium games included. Each finished game shows the named beasts it killed beside a skull, counted when the game ends and stored in `games.beasts`. "Live" in the bar returns to the live game. |
| Main figures of the selected games | Six tiles under the Games header: games ended, median level, average level, named beasts slain per game, best level, and the dollars spent on all of them (the STRK of each game and the SURVIVOR paid for its bag, claims left out), at the prices Ekubo quotes, read every 10 minutes (on "Practice", the share that reached level 30). `GET /api/summary` computes them for each dungeon and for practice with the benchmark's own `summary` in `src/summary.ts`. On "Practice", "Checked" appears after `scripts/check.sh` has run the tests and written `var/contract-check.json` (`GET /api/check`). |
| Wallet: STRK (red under the spend floor), tickets, SURVIVOR | "Wallet" on the right. `GET /api/wallet` (cached 30 seconds). |
| Beasts held or won and not yet claimed | "Beasts" on the right, for the account in `LS_BEASTS_TO` (else the wallet), one group per dungeon: the count, how many per tier, Megas and staked, and the dollars the Loot Dungeon sell pools pay for them now, one at a time, at the STRK price Ekubo quotes. Under it the 5 newest portraits with tier and level, beasts to claim first, greyed with a dashed edge; "More" shows them all; hover for name, type and price. Beast Mode beasts have no pool and show no value. `GET /api/beasts` answers from memory: the list is read from the game's collection API every 10 minutes (one call per 100 beasts and one per dungeon, no RPC), claims and pool prices every 10 minutes while no game is being played. |
| Loot bags, best 25, with the copies the pool holds | "Loot bags" on the right, ranked by mean level or by named beasts killed: only bags the pool holds now, with their copies, read from the pool every minute. `GET /api/bags` takes the figures from `scripts/bag-ranking.json`. |
| Start a real game (spends STRK) | `curl -X POST 127.0.0.1:4100/api/play -d '{"live":true}'` on the machine itself. |
| Start a practice pass | `POST /api/play` with `{"games": n}`. Not on the page. |
| Stop after the current move | `curl -X POST 127.0.0.1:4100/api/stop` on the machine itself. |
| The page is read-only | The page sends only GET requests and has no control. From another machine the server answers 403 to any request that is not a GET, and to `/mcp`. |
| Game data | `GET /api/state` (current game), `GET /api/games` (200 games, real ones first), `GET /api/games/<row id>` (one game with its events), `GET /events` (live stream), `GET /api/items` (item table) |
| Wallet address, deployment and balance | `node src/cli.ts wallet` |
| Deploy the wallet account (spends STRK) | `node src/cli.ts deploy` |
| Settle a finished real game and claim its beasts (spends STRK, runs by itself after each real game) | `node src/cli.ts collect <game id>` |
| What settling a finished game would cost (read-only) | `node src/cli.ts quote <game id>` |
| A loot bag's price now, whether the pool holds it, and a simulated purchase (read-only) | `node src/cli.ts bag <bag number> [address]` |
| Beasts an address holds or has staked, and its unclaimed kills (read-only) | `node src/cli.ts beasts [address]` |
| Send every beast the wallet holds to another account (spends STRK; refuses an address with no account, and a transfer that would fail) | `node src/cli.ts send-beasts <address>` |
| Import human games for study | `node scripts/import.ts <dir>...` |
| Explain how a game died | `node scripts/autopsy.ts <file> <game>...` |

## Where facts live

| Fact | Source |
|---|---|
| Action shapes and packet encoding | `src/codec.ts` |
| Game rules | The contract. `src/engine/` is the local port, and `src/mechanics.test.ts` and `src/engine/engine.test.ts` compare it with the contract. |
| Rule policy | `src/policy.ts` |
| Rules told to a model decider | `src/mechanics.ts` |
| Strategy text for model deciders | `strategy/prompt.md` |
| Contracts, dungeons, the spend floor and benchmark starts | `src/config.ts` |
| What the page shows about a state (luck, chances, what gear grants, purse) | `enrich` in `src/play.ts` |
| Which kills are collectable, and the beast inventory | `src/beasts.ts` |

## The author's deployment

`deploy/` is an example of running the bot as a service: systemd user units, a daily run of `scripts/check.sh` and a Traefik route. `deploy/install.sh` reads `LS_DOMAIN` and `LS_HOST` from `~/.config/ls-agent/env`. The paths in the units are one machine's; adjust them. You do not need it to run locally.

## Licence

MIT, see `LICENSE`.
