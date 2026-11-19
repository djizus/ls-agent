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
| Live show: adventurer, beast, odds, decision log, gear, recent games | `/` (ls.example.com) |
| Start a benchmark pass | `POST /api/play` with `{"games": n}` |
| Stop after the current move | `POST /api/stop` |
| Current game state | `GET /api/state` |
| Last 200 games | `GET /api/games` |
| Results per strategy version | `GET /api/strategies` |
| Recent events for a late page load | `GET /api/recent` |
| Live event stream | `GET /events` |
| Item table | `GET /api/items` |
| Daily contract check result | `GET /api/check`, written by `scripts/check.sh` |
| Wallet address, deployment and balance | `node src/cli.ts wallet` |
| Deploy the wallet account (spends STRK) | `node src/cli.ts deploy` |
| Import human games for study | `node scripts/import.ts <dir>...` |
| Explain how a game died | `node scripts/autopsy.ts <file> <game>...` |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `LS_DECIDER` | `rules` | `rules`, `jev` or `model` |
| `LS_DUNGEON` | `beast` | key in `DUNGEONS` in `src/config.ts` |
| `LS_AUTOPLAY` | unset | play the benchmark forever with fresh luck seeds |
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
| Dungeons and benchmark adventurers | `src/config.ts` |
