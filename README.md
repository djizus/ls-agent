# ls-agent

Plays Loot Survivor (Death Mountain, Starknet mainnet) and shows every decision on a live page.
Practice games run on a local port of the game and are checked against the contract when they end.

## Prove it

```
scripts/prove.sh 2
```

Starts the real service on port 4199, plays 2 practice games through the HTTP API and leaves
the database, service log, event stream and game list in `var/evidence/<timestamp>/`.

## Measure a policy

```
node scripts/bench.ts
node scripts/bench.ts --rules '{}' --rules '{"jewelryLevel":99}'
node scripts/bench.ts --gate
node scripts/bench.ts --starts 50000 --from 1000000
node scripts/bench.ts --starts 40000 --reach 30 --keep var/level30.json
node scripts/bench.ts --late var/level30.json --seeds 0-10
LS_DUNGEON=lootBag node scripts/bench.ts --ids bags.json --by-id
LS_DUNGEON=lootBag node scripts/bench.ts --rank var/bag-ranking.json
node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35],"jewelryLevel":[6,8,10]}' --level 35
```

Beast Mode: plays the rule policy from 10,000 generated starts (the same every run: each has its own rolled stats, market and
luck) in about 15 seconds, and prints mean, spread and the share of games reaching level 26, 30, 35 and 40. `--starts` sets how many
and `--from` where they begin, so a result can be confirmed on starts it was not chosen on. Under the level figures it prints beasts killed per game, named beasts (level 19+) killed with the standard error,
named kills per 100 moves, and what became of the named beasts met (killed, fled, died to). `--reach 30 --keep file` saves the state
of every game at the moment it reaches level 30 (`--reach weapon`: at the moment the worn weapon reaches greatness 20); `--late file` plays those states forward on `--seeds` luck seeds each, to measure
late-game rules on many more deep games than a run from level 1 gives. Loot Dungeon starts are
fixed by the bag, so there it plays each game id for 500 luck seeds (`--seeds 0-500`); `--ids file.json` takes a list of game
ids and `--by-id` adds a line per id. `--rank file.json` takes the loot bag list the page shows (rows with a `game` id), plays every bag and rewrites
the file with each row's level figures and named kills per game (`kills`, `killsSe`) refreshed, other fields kept. Each extra `--rules` overrides fields of `RULES` in `src/policy.ts` and is compared with
the first on the same games: the difference in named kills, in mean level and in the 30+, 35+ and 40+ shares, each with its standard error.
`scripts/search.ts` takes a grid of values per `RULES` field, moves one field at a time to the value that raises the chosen
share most on one set of starts, and confirms the result on another. `--gate` fails when the mean drops 0.25 levels, the 30+ share drops 1 point or named kills per game drop 0.1 below
`scripts/baseline.json`; `--save` writes the baseline after a change that is meant to move it. Luck uses a fast hash; `--exact`
uses the contract's hash (same distribution, 30 times slower). A difference under two standard errors is noise.

## Feature map

| Feature | How to reach it |
|---|---|
| One screen, no tabs: the official Loot Survivor spectator in the middle, our panels around it | `/` shows the live real game, or the latest real game when none is live; `/?game=<row id>` shows that real game |
| Watch a real game | The middle panel embeds `https://www.lootsurvivor.io/watch?id=<game id in decimal>`. A finished game opens at its first move: click inside it, then the right arrow steps the replay |
| What the agent just decided in the live game: fight or flee with the chance to win and to escape, ability points spent, items bought with their price and reason, potions, drops | The bar under the spectator; for a finished game it shows the level reached, the beast that killed it and the STRK it cost |
| Pick a real game | "Games" on the left, with "Beast" or "Loot" in its header choosing the dungeon (the live game's by default, else the latest game's; the choice is kept in the browser): the three best by level as a podium, the rest as cards newest first with the level reached, the live game on top; click one. "Live" in the bar returns to the live game |
| Practice results: share of practice games of the newest policy version reaching level 26, 30 and 35, the daily contract check | "Practice" on the left; `GET /api/strategies`, `GET /api/check` (written by `scripts/check.sh`). Practice games cannot be watched on the page |
| Wallet: STRK (red under the spend floor), tickets, SURVIVOR, average STRK per real game | "Wallet" on the right; `GET /api/wallet` (cached 30 seconds) |
| Beasts held or won and not yet claimed, each with its level | "Beasts" on the right; `GET /api/beasts` (cached 60 seconds) |
| Loot bags, best 25, with the copies the pool holds (x1, x2, x3) | "Loot bags" on the right; "Level" ranks by simulated mean level, "Beasts" by named beasts killed per game, and the choice is kept in the browser; `GET /api/bags` reads `var/bag-ranking.json` |
| Read-only for visitors | Opened from another machine the page has no Play or Stop and writes nothing; `GET /api/me` returns `{"control": false}` and the server refuses every other method with 403 |
| Start an on-chain game (spends STRK) | On the machine itself: "Play", then "Spend STRK" under "This spends real money"; `POST /api/play` with `{"live": true}` |
| Start a practice pass | `POST /api/play` with `{"games": n}` (not on the page) |
| Stop after the current move | On the machine itself: "Stop" replaces "Play" while a game is live; `POST /api/stop` |
| Current game state | `GET /api/state` |
| 200 games, on-chain first, each with `onchain`, `live`, `dungeon` and `gas_strk` (STRK balance spent during the game, null when not recorded) | `GET /api/games` |
| One game with its stored events, states included | `GET /api/games/<row id>` |
| Live event stream | `GET /events` |
| Item table | `GET /api/items` |
| Wallet address, deployment and balance | `node src/cli.ts wallet` |
| Deploy the wallet account (spends STRK) | `node src/cli.ts deploy` |
| Settle a finished on-chain game of either dungeon and claim its collectable beasts (spends STRK; runs by itself after each on-chain game) | `node src/cli.ts collect <game id>` |
| What settling and claiming a finished game would cost, simulated from its owner (read-only) | `node src/cli.ts quote <game id>` |
| Beasts an address holds or has staked, and its unclaimed collectable kills (read-only) | `node src/cli.ts beasts [address]` |
| Import human games for study | `node scripts/import.ts <dir>...` |
| Explain how a game died | `node scripts/autopsy.ts <file> <game>...` |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `LS_DECIDER` | `rules` | `rules`, `jev` or `model` |
| `LS_DUNGEON` | `beast` | key in `DUNGEONS` in `src/config.ts` |
| `LS_PACE_MS` | 0 | pause between a decision and its move, for watching |
| `LS_RPC_URL` | public node | Starknet RPC |
| `LS_BEASTS_ADDRESS` | the wallet | address whose beasts the page lists |
| `LS_HOST`, `LS_PORT` | 127.0.0.1, 4100 | where the page is served |

Secrets live in `~/.config/ls-agent/env`. `deploy/install.sh` installs the user service, the
daily check timer and the Traefik route.

## Where facts live

| Fact | Source |
|---|---|
| Action shapes and packet encoding | `src/codec.ts` |
| Game rules | the contract; `src/engine/` is the local port, `src/mechanics.test.ts` and `src/engine/engine.test.ts` compare against it |
| Rules told to a model | `src/mechanics.ts` |
| Rule policy | `src/policy.ts` |
| Strategy choices for model deciders | `strategy/candidate.md` |
| Dungeons, their claim call and species range, and benchmark adventurers | `src/config.ts` |
| What the page shows about a state (luck, chances, what gear grants, purse) | `enrich` in `src/play.ts` |
| Which kills are collectable, and the beast inventory | `src/beasts.ts` |
