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
LS_DUNGEON=lootBag node scripts/bench.ts --ids bags.json --by-id
node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35],"jewelryLevel":[6,8,10]}' --level 35
```

Beast Mode: plays the rule policy from 10,000 generated starts (the same every run: each has its own rolled stats, market and
luck) in about 15 seconds, and prints mean, spread and the share of games reaching level 26, 30, 35 and 40. `--starts` sets how many
and `--from` where they begin, so a result can be confirmed on starts it was not chosen on. Loot Dungeon starts are
fixed by the bag, so there it plays each game id for 500 luck seeds (`--seeds 0-500`); `--ids file.json` takes a list of game
ids and `--by-id` adds a line per id. Each extra `--rules` overrides fields of `RULES` in `src/policy.ts` and is compared with
the first on the same games: the difference in mean level and in the 30+, 35+ and 40+ shares, each with its standard error.
`scripts/search.ts` takes a grid of values per `RULES` field, moves one field at a time to the value that raises the chosen
share most on one set of starts, and confirms the result on another. `--gate` fails when the mean drops 0.25 levels or the 30+ share drops 1 point below
`scripts/baseline.json`; `--save` writes the baseline after a change that is meant to move it. Luck uses a fast hash; `--exact`
uses the contract's hash (same distribution, 30 times slower). A difference under two standard errors is noise.

## Feature map

| Feature | How to reach it |
|---|---|
| One screen, no tabs: the official Loot Survivor spectator in the middle, our panels around it | `/` shows the live real game, or the latest real game when none is live; `/?game=<row id>` shows that real game |
| Watch a real game | The middle panel embeds `https://www.lootsurvivor.io/watch?id=<game id in decimal>`. A finished game opens at its first move: click inside it, then the right arrow steps the replay |
| What the agent just decided in the live game: fight or flee with the chance to win and to escape, ability points spent, items bought with their price and reason, potions, drops | The bar under the spectator; for a finished game it shows the level reached, the beast that killed it and the STRK it cost |
| Pick a real game | "Games" on the left: the three best as a podium, the rest as cards with the level reached; click one. "Live" in the bar returns to the live game |
| Practice results: share of practice games of the newest policy version reaching level 26, 30 and 35, the best practice games by level, the daily contract check | "Practice" on the left; `GET /api/strategies`, `GET /api/check` (written by `scripts/check.sh`). Practice games cannot be watched on the page |
| Wallet: STRK (red under the spend floor), tickets, SURVIVOR, average STRK per real game | "Wallet" on the right; `GET /api/wallet` (cached 30 seconds) |
| Beasts held or won and not yet claimed, each with its level | "Beasts" on the right; `GET /api/beasts` (cached 60 seconds) |
| Loot bags ranked by simulated level, best 25 | "Loot bags" on the right; `GET /api/bags` reads `var/bag-ranking.json` |
| Start an on-chain game (spends STRK) | "Play", then "Spend STRK" under "This spends real money"; `POST /api/play` with `{"live": true}` |
| Start a practice pass | `POST /api/play` with `{"games": n}` (not on the page) |
| Stop after the current move | "Stop" replaces "Play" while a game is live; `POST /api/stop` |
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
