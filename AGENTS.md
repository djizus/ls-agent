# ls-agent for people changing it

The bot plays Loot Survivor 2 on Starknet mainnet with the rule policy in `src/policy.ts`. It carries a local port of the game (`src/engine/`), so practice games, tests and benchmarks need no chain. `README.md` is the page for viewers; this file is for changing the code.

## Run it

You need Node 22.18 or newer, bash and curl. This spends nothing:

```
npm install
npm start                                                 # the page and the API on :4100
curl -X POST 127.0.0.1:4100/api/play -d '{"games":20}'    # 20 practice games, in the service log only
```

Playing for real spends STRK from the bot's own wallet:

```
node src/cli.ts wallet                                    # prints the address, creates var/wallet.json
node src/cli.ts deploy                                    # after sending STRK to it: deploys the account
curl -X POST 127.0.0.1:4100/api/play -d '{"cycle":true}'  # one cycle, drawn in README.md, then it stops
curl -X POST 127.0.0.1:4100/api/stop                      # ends play after the current move, and the cycle
```

With `LS_SEATS` above 1, a round decides one move per game and sends them in one transaction:

```
  game 1 ── decide ─┐
  game 2 ── decide ─┼──► one transaction ──► wait for its block ──► read every game's new state
  game N ── decide ─┘
```

When a game ends, its seat takes the next game. A minute later the bot settles the ended game on chain, which claims the beasts it killed. A cycle does not survive a restart: after one, unfinished games in `var/live.json` resume with the next batch or cycle, and ended games whose claim was cut off are settled when the next live batch starts. A bag purchase is tried once per cycle; when sending it fails, the bot asks who owns the game it bought and plays it only if the wallet does.

| Risk | What to know |
|---|---|
| Wallet key | `var/wallet.json` holds the private key in plain text. Whoever reads it owns the funds. Back it up. |
| Spend floor | Under 20 STRK (`STRK_FLOOR` in `src/config.ts`) the bot sends nothing. Above it, nothing else limits spending. |
| Tickets | One per game. With less than one left, the bot buys 10 on Ekubo and refuses if they cost more than 2 STRK. |
| Loot bag purchase | Refused above `maxSurvivor`, when the pool no longer holds the bag, or when the wallet is short. When sending fails, the bot asks the game token whether the wallet owns the game anyway and does not send the purchase again. |
| Stopping | `POST /api/stop` ends play after the current move. The bot also stops if its local state differs from the contract. |
| Other machines | Only your machine can reach the server unless you set `LS_HOST`. Others may then send GET requests and `POST /api/bags` (the loot bag Refresh: one ranking at a time, spends nothing); the server refuses everything else. A reverse proxy on the same machine makes every visitor look local, so give it its own access control. |

## Prove a change

| Command | What it does |
|---|---|
| `npm test` | Every test, without the network: contract answers come from `src/tape.json`, and a test that reaches the network fails. |
| `npm run contract` | The same tests against the live contract, one file at a time. `scripts/check.sh` runs it daily and writes `var/contract-check.json` for the page. |
| `npm run record` | Records the contract answers again into `src/tape.json` (about 40 seconds). Two runs give the same file. |
| `npm run prove -- 2` | Starts the real service on port 4199, plays 2 practice games through the API, and leaves the database, log, event stream and game list in `var/evidence/<time>/`. `-- 2 lootBag` plays Loot Dungeon starts; `-- cycle` runs one cycle on the empty wallet of a fresh `var/`, where nothing can be spent, and keeps its status lines. |
| `npm run stats` | Rewrites the Results section of `README.md` from `scripts/baseline.json` and `var/ls.sqlite` (opened read-only), and nothing else in the file. Run it with `LS_VAR_DIR` on a copy of the production database. |
| `npm run bench` | Plays the policy on 10,000 fixed Beast Mode starts: mean level and spread, share reaching levels 26 to 40, named kills, causes of death. A difference under two standard errors is noise. |

For a page change, run the server on a free port with its own `LS_VAR_DIR` holding a copy of a real `ls.sqlite`, and look at it at 1920x1080 and 390x844.

## The flow

Changes land through `land.sh` from `~/dotfiles/agents/flow/`. It rebases on `main`, refuses added comments, new markdown files and commit lines matching `[land] forbid`, runs the kinds in `flow.toml`'s `[land] kinds` (`test`) with an audit of the change against the design rules, then moves `main`. `build.sh <kind>` runs a kind of `flow.toml` (`build`, `test`, `contract`) on a commit through the worker; heavy commands are refused outside it. Each lane works in its own worktree, made by `lane.sh <lane> <role>`.

## Settings

Environment variables. `scripts/prove.sh` also reads `~/.config/ls-agent/env`.

| Variable | Default | Meaning |
|---|---|---|
| `LS_SEATS` | 1 | Real games played at once, sharing one transaction per round |
| `LS_BEASTS_TO` | unset | Account that receives every beast once claimed; the page lists its beasts, else the wallet's |
| `LS_HOST`, `LS_PORT` | 127.0.0.1, 4100 | Where the page is served |
| `LS_VAR_DIR` | `var/` | Where the wallet, database and caches live. End it with a slash. |
| `LS_RPC_URL` | public node | Starknet RPC |
| `LS_PACE_MS` | 0 | Pause between a decision and its move |

## Feature map

| Feature | How to reach it |
|---|---|
| Live games as cards | `/` with live games: one card each, two columns up to four games, four beyond, stacked on a phone. Cards follow `GET /events`. |
| Watch one game in the official spectator | "Details" on a card, or a finished game in the list: `/?game=<row id>` embeds `lootsurvivor.io/watch`. "Back to live" returns to the cards; "Reload" loads the spectator again when it opened before its indexer had the game. With no live game, `/` shows the latest one. |
| What the bot decided | The last chips of a card: Fight and Flee with their odds, or Explore. For a game open in the spectator, the bar under it, which for a finished game shows its level, killer, named kills, beasts claimed and STRK cost. |
| Games of a dungeon | "Games" on the left, "Beast" or "Loot": a podium of the three best, the 20 newest, "More" for all, live games on top. Each row shows its own dungeon: a bag for a Loot Dungeon game, a skull for Beast Mode, and the Live row shows the bag when any live game is a Loot Dungeon game. A gold skull marks a game that claimed or can claim a beast. |
| Figures of a dungeon | The six tiles under "Games": games ended, average level, named kills a game, dollars spent (STRK and SURVIVOR at Ekubo prices), best level, beasts claimed. `GET /api/summary`. |
| Engine no longer matches the contract | One red line above the middle panel when the last daily check failed or is older than 2 days, and nothing otherwise. `GET /api/check` serves `var/contract-check.json`. |
| Wallet and the cycle's last step | "Wallet" on the right: STRK (red under the floor), tickets, SURVIVOR, and the cycle's step now or how the last one ended. `GET /api/wallet`, `GET /api/cycle`. |
| Beasts held and to claim | "Beasts" on the right, one group per dungeon: count, tiers, Megas, staked, and what the Loot Dungeon pools pay for them. Hover a portrait for its name and price; "More" shows all. `GET /api/beasts`. |
| Loot bag ranking | "Loot bags" on the right: the best 25 bags the pool holds, by mean level or named kills, with copies left. "Refresh" (any viewer) ranks the bags new in the pool. `GET`/`POST /api/bags`. |
| Rank every bag again after a policy change | `npm run bench -- --dungeon lootBag --rank --all` |
| Run one cycle / stop | `POST /api/play {"cycle":true}` (409 while a batch or a cycle runs) / `POST /api/stop`, from the machine itself |
| Play real games by hand | `POST /api/play {"live":true,"games":3}`; add `"dungeon":"lootBag","bag":7806,"maxSurvivor":90` for a Loot Dungeon game |
| Practice games | `POST /api/play {"games":20}`, with `"dungeon":"lootBag"` for Loot Dungeon starts. Not on the page. |
| Game data | `GET /api/state`, `/api/games`, `/api/games/<row id>`, `/api/items`, `/events` |
| Wallet address and balance / deploy the account | `node src/cli.ts wallet` / `node src/cli.ts deploy` |
| Settle a game and claim its beasts (runs by itself) / its simulated cost | `node src/cli.ts collect <game id>` / `node src/cli.ts quote <game id>` |
| A bag's price, whether the pool holds it, a simulated purchase | `node src/cli.ts bag <bag number> [address]`, from the wallet unless an address is given; the simulation needs a deployed account |
| Beasts an address holds, staked and to claim | `node src/cli.ts beasts [address]` |
| Send every beast to another account | `node src/cli.ts send-beasts <address>` |
| Compare policy variants on the same games | `npm run bench -- --rules '{}' --rules '{"jewelryLevel":99}'` |
| Confirm a result on more or other starts | `npm run bench -- --starts 50000 --from 1000000` |
| Save every game when it reaches level 30, or when its weapon reaches greatness 20 | `npm run bench -- --starts 40000 --reach 30 --keep var/level30.json`, `--reach weapon` |
| Play saved games forward on several luck seeds, to measure late-game rules | `npm run bench -- --late var/level30.json --seeds 0-10` |
| Use the contract's luck hash in place of the fast one (same distribution, 30 times slower) | `npm run bench -- --exact` |
| Play given Loot Dungeon games on 500 luck seeds each, one line per game | `npm run bench -- --dungeon lootBag --ids games.json --by-id` (a JSON list of game ids) |
| What a Greed Run game returns in STRK, cashing out at a fixed level or when rollouts of the policy say the next levels are worth less than cashing now, with exits and policy variants compared on the same starts and luck | `node scripts/greed.ts --starts 10000 --exit '{"rollouts":64,"horizon":6}' --exit '{"rollouts":128,"horizon":3,"rules":{"fightRisk":0.25}}'`: reads the payout curve from the Greed Run contract and prints the gas it assumes with the returns; `--wager 10` plays another stake the contract takes, and each row says how often a 335 STRK bankroll goes broke within 200 games (`--bankroll`, `--games`), resampling that row.s games |
| Fail when the policy gets worse than `scripts/baseline.json` | `npm run bench -- --gate` (`--save` rewrites it, with the number of games) |
| Search one policy field at a time | `node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35]}' --level 35` |
| Explain how a game died, move by move | `node scripts/autopsy.ts var/ls.sqlite <row id>...` |
| Import human games for study | `node scripts/import.ts <dir>...` |

## Where facts live

| Fact | Source |
|---|---|
| Game rules | The contract. `src/engine/` is the local port, checked by the tests. |
| Rule policy | `src/policy.ts` |
| The cycle's numbers | `CYCLE` in `src/cycle.ts` |
| Contracts, dungeons, the Greed Run contract and its settings, spend floor, benchmark starts | `src/config.ts` |
| Action shapes and packet encoding | `src/codec.ts` |
| Collectable kills and the beast inventory | `src/beasts.ts` |

`deploy/` runs it as systemd user services with a daily `scripts/check.sh` and a Traefik route. `deploy/install.sh` reads `LS_DOMAIN` and `LS_HOST` from `~/.config/ls-agent/env`.
