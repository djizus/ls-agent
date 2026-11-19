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

In a second terminal, play 20 practice games (about a minute):

```
curl -X POST 127.0.0.1:4100/api/play -d '{"games":20}'
```

The service log prints each decision. The "Practice" panel on the page lists the games and the share that reached level 26, 30 and 35. The middle of the page stays on "No real game yet", because it only shows games played on chain. A pass plays up to 20 fixed starts, and each complete pass of 20 uses new luck.

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
2. Send STRK to that address. The bot refuses to send a transaction while the balance is under 80 STRK, so fund more than that.
3. `node src/cli.ts deploy` deploys the account (one small fee).
4. Open the page on the same machine and press "Play", then "Spend STRK". This plays one game. `curl -X POST 127.0.0.1:4100/api/play -d '{"live":true,"games":3}'` plays three.

| What | Cost or risk |
|---|---|
| Wallet key | `var/wallet.json` holds the private key in plain text, readable only by your user. Whoever reads the file owns the funds. If you delete `var/`, the funds are lost. Back the file up. |
| Spend floor | 80 STRK, `STRK_FLOOR` in `src/config.ts`. Under it the bot sends nothing. It is the only spending limit: above the floor the bot keeps paying for as many games as you start. |
| Tickets | A game uses one dungeon ticket. With less than one ticket left, the bot buys 10 on Ekubo and refuses if they cost more than 2 STRK. |
| A game | Each move is one transaction. 8 recorded Beast Mode games cost 0.8 to 3.9 STRK each, 2.5 at the median, about 0.04 STRK per move. Fees change with the network. |
| Settlement | When a finished game killed a beast that can be collected, the bot settles the game on chain a minute later and claims the beast. Simulated cost: 0.5 STRK for a 13-move game, 3.1 STRK for a 115-move game. `node src/cli.ts quote <game id>` simulates it for one game without sending anything. |
| Stopping | "Stop" ends play after the current move. An unfinished game is kept in `var/live.json` and resumes on the next "Play". The bot stops by itself if its local state differs from the contract. |
| Other machines | By default only your machine can reach the page. If you set `LS_HOST` to serve other machines, they can read everything and change nothing: the server refuses any request that is not a GET, and `GET /api/me` answers `{"control": false}`. A reverse proxy running on the same machine makes every visitor look local, so do not put one in front without its own access control. |
| Outside services | A public Starknet node, the game's API (beasts), Ekubo (ticket price) and `lootsurvivor.io` (the embedded spectator). |

The policy loses most games early. In the benchmark, 13% of games reach level 26. Expect to pay for many short games.

## Settings

Settings are environment variables. `scripts/prove.sh` also reads `~/.config/ls-agent/env` when the file exists.

| Variable | Default | Meaning |
|---|---|---|
| `LS_DECIDER` | `rules` | Who decides each move. `rules` is the policy in `src/policy.ts`: it runs locally, calls no model and costs nothing. `jev` and `model` ask an outside model and need your own access (below). |
| `LS_DUNGEON` | `beast` | `beast` or `lootBag`, the keys of `DUNGEONS` in `src/config.ts` |
| `LS_PACE_MS` | 0 | Pause between a decision and its move, for watching |
| `LS_RPC_URL` | public node | Starknet RPC |
| `LS_HOST`, `LS_PORT` | 127.0.0.1, 4100 | Where the page is served |
| `LS_VAR_DIR` | `var/` | Where the wallet, database and caches are stored. End it with a slash. |
| `LS_BEASTS_ADDRESS` | the wallet | Address whose beasts the page lists |
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
| `npm run bench -- --late var/level30.json --seeds 0-10` | Plays those saved games forward on 10 luck seeds each, to measure late-game rules |
| `npm run bench -- --exact` | Uses the contract's hash for luck in place of the fast one: same distribution, 30 times slower |
| `LS_DUNGEON=lootBag npm run bench -- --ids bags.json --by-id` | Loot bag starts are fixed, so each game id in the file is played on 500 luck seeds, with one line per id |
| `LS_DUNGEON=lootBag npm run bench -- --rank var/bag-ranking.json` | Replays every bag in the list the page shows and rewrites its figures. The list itself is not in the repository, so "Loot bags" is empty on a fresh clone. |
| `node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35]}' --level 35` | Moves one `RULES` field at a time to the value that raises the share reaching that level, then confirms on other starts |

## Feature map

| Feature | How to reach it |
|---|---|
| One screen: the official Loot Survivor spectator in the middle, panels around it | `/` shows the live real game, or the latest real game when none is live. `/?game=<row id>` shows that real game. |
| Watch a real game | The middle panel embeds `https://www.lootsurvivor.io/watch?id=<game id in decimal>`. A finished game opens at its first move: click inside it, then the right arrow steps the replay. |
| What the bot just decided in the live game | The bar under the spectator. For a finished game it shows the level reached, the beast that killed it and the STRK it cost. |
| Pick a real game | "Games" on the left: the three best by level as a podium, the rest newest first, the live game on top. "Live" in the bar returns to the live game. |
| Practice results and the contract check | "Practice" on the left. `GET /api/strategies`, `GET /api/check`. "Checked" appears after `scripts/check.sh` has run the tests and written `var/contract-check.json`. |
| Wallet: STRK (red under the spend floor), tickets, SURVIVOR, average STRK per real game | "Wallet" on the right. `GET /api/wallet` (cached 30 seconds). |
| Beasts held or won and not yet claimed | "Beasts" on the right. `GET /api/beasts` (cached 60 seconds). |
| Loot bags, best 25, with the copies the pool holds | "Loot bags" on the right, ranked by mean level or by named beasts killed. `GET /api/bags` reads `var/bag-ranking.json`. |
| Start a real game (spends STRK) | On the machine itself: "Play", then "Spend STRK". `POST /api/play` with `{"live": true}`. |
| Start a practice pass | `POST /api/play` with `{"games": n}`. Not on the page. |
| Stop after the current move | On the machine itself: "Stop" replaces "Play" while a game is live. `POST /api/stop`. |
| Read-only for visitors | From another machine the page has no Play or Stop. `GET /api/me` returns `{"control": false}` and the server answers 403 to any request that is not a GET. |
| Game data | `GET /api/state` (current game), `GET /api/games` (200 games, real ones first), `GET /api/games/<row id>` (one game with its events), `GET /events` (live stream), `GET /api/items` (item table) |
| Wallet address, deployment and balance | `node src/cli.ts wallet` |
| Deploy the wallet account (spends STRK) | `node src/cli.ts deploy` |
| Settle a finished real game and claim its beasts (spends STRK, runs by itself after each real game) | `node src/cli.ts collect <game id>` |
| What settling a finished game would cost (read-only) | `node src/cli.ts quote <game id>` |
| Beasts an address holds or has staked, and its unclaimed kills (read-only) | `node src/cli.ts beasts [address]` |
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

`deploy/` is how the author runs the bot on one server: systemd user units, a daily run of `scripts/check.sh` and a Traefik route for the author's own domain. The paths and the host name are theirs. You do not need it to run locally. Use it as an example if you want a service of your own.
