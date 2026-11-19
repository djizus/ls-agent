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
| Watch the live game: adventurer, beast, odds, decision log, gear, bag | `/` follows whatever is live; with nothing live it shows the top game of the list at its end |
| Pick a game to watch | click a row in the Games list, or open `/?game=<row id>`; "On-chain" filters the list, on-chain games rank first |
| Replay a finished game | pick it, then Play/Pause, Back/Next (left/right arrows), the slider, and the speed button; space toggles play |
| Return to the live game from a replay | "Watch live" in the top bar |
| Start an on-chain game (spends STRK) | "Play on-chain" in the top bar, then confirm; `POST /api/play` with `{"live": true}` |
| Start a benchmark pass | `POST /api/play` with `{"games": n}` |
| Stop after the current move | `POST /api/stop` |
| Current game state | `GET /api/state` |
| 200 games, on-chain first, each with `onchain` and `live` flags | `GET /api/games` |
| One game with its stored events, states included | `GET /api/games/<row id>` |
| Results per strategy version | `GET /api/strategies` |
| Live event stream | `GET /events` |
| Item table | `GET /api/items` |
| Daily contract check result | `GET /api/check`, written by `scripts/check.sh` |
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
| `LS_PACE_MS` | 0 | pause between moves, for watching |
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
| Which kills are collectable, and the beast inventory | `src/beasts.ts` |
