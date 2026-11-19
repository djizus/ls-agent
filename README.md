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
| Watch a game: live, replay or ended, the adventurer's level and what it is doing, its health and the beast's, its gold and the price of healing, what the agent decided with its reason and the odds it simulated, what followed, and the eight worn items on a body | `/` follows whatever is live; with nothing live it shows the latest game at its end; `/?game=<row id>` replays that game from its start |
| Every move of the game in order | "Read the whole game" under the latest moves |
| Abilities with what each buys, the bonus of every worn and carried item, the bag, the cheapest upgrade on the market | "Abilities, bonuses and bag" under the body |
| Replay a finished game | Play/Pause, Back/Next (left/right arrows), the slider and the speed button at the bottom; space toggles play |
| Return to the live game from a replay | "Watch the live game" beside the status |
| Pick a game to watch | "Games" in the top bar (`/?view=games`): real games first, practice below; click a row |
| Wallet: STRK, margin above the spend floor, tickets, SURVIVOR, STRK spent on real games and the average per game | "Wallet" (`/?view=wallet`); `GET /api/wallet` (cached 30 seconds) |
| Beasts held, staked and Mega per collection, and kills still to claim | "Beasts" (`/?view=beasts`); `GET /api/beasts` (cached 60 seconds) |
| Share of practice games reaching level 26, 30 and 35, and the best level, per policy version; the daily contract check result | "Results" (`/?view=results`); `GET /api/strategies`, `GET /api/check` (written by `scripts/check.sh`) |
| Loot bags ranked by simulated level | "Loot bags" (`/?view=bags`); `GET /api/bags` reads `var/bag-ranking.json` |
| Start a practice pass | "Start a game" in the top bar, then "Start practice games"; `POST /api/play` with `{"games": n}` |
| Start an on-chain game (spends STRK) | "Start a game", "Start a real game", then "Spend STRK and start"; `POST /api/play` with `{"live": true}` |
| Stop after the current move | "Stop the game" in the top bar while a game is live; `POST /api/stop` |
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
| Where each worn item sits on the body, and the words that replace game shorthand | `PLACE` and `WORDS` in `web/index.html` |
| Which kills are collectable, and the beast inventory | `src/beasts.ts` |
