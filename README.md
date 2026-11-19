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
node scripts/bench.ts 10
```

Plays the rule policy on every benchmark adventurer with 10 luck seeds each (200 games, about
80 seconds) and prints mean, spread and percentiles. Compare changes on the same seeds; a
difference under 1 level on 200 games is noise.

## Feature map

| Feature | How to reach it |
|---|---|
| Watch the live game on the stage: adventurer and beast sprites, health bars, damage numbers, the odds the agent saw, the last two events, its decision | `/` follows whatever is live; with nothing live it shows the top run of the list at its end |
| Stats with the part granted by items and what each buys (flee, dodge, potion price, critical chance) | the seven tiles above the stage |
| Gear: every slot with tier, greatness, progress, what it grants; empty and weak slots in red; bag items that still grant something | "Gear" and "Bag" under the stage |
| Money: gold, potion price, cost of a full heal, cheapest upgrade on the market | "Purse" under the stage |
| Every event and decision of the game in order | "Full log" beside the ticker |
| Pick a run to watch | click a row in "Runs" (on-chain first, practice below), or open `/?game=<row id>` |
| Replay a finished game | pick it, then Play/Pause, Back/Next (left/right arrows), the slider, and the speed button; space toggles play |
| Return to the live game from a replay | "Watch live" beside the game title |
| Wallet: STRK, margin above the spend floor, tickets, SURVIVOR, STRK spent on on-chain games | "Wallet" in the left column; `GET /api/wallet` (cached 30 seconds) |
| Start an on-chain game (spends STRK) | "Play on-chain" in the left column, then "Spend STRK and play"; `POST /api/play` with `{"live": true}` |
| Start a practice pass | "Run practice"; `POST /api/play` with `{"games": n}` |
| Stop after the current move | "Stop"; `POST /api/stop` |
| Share of practice games reaching level 26, 30 and 35, and the best level, per policy version | "Policy results" in the right column; `GET /api/strategies` |
| Loot bags ranked by simulated level | "Loot bags for sale" in the right column; `GET /api/bags` reads `var/bag-ranking.json` |
| Current game state | `GET /api/state` |
| 200 games, on-chain first, each with `onchain`, `live`, `dungeon` and `gas_strk` (STRK balance spent during the game, null when not recorded) | `GET /api/games` |
| One game with its stored events, states included | `GET /api/games/<row id>` |
| Live event stream | `GET /events` |
| Item table | `GET /api/items` |
| Daily contract check result | foot of the left column; `GET /api/check`, written by `scripts/check.sh` |
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
