# ls-agent for people changing it

The bot plays Loot Survivor 2 on Starknet mainnet with the rule policy in `src/policy.ts`. It carries a local port of the game (`src/engine/`), so practice games, tests and benchmarks need no chain. `README.md` is the page for viewers; this file is for changing the code.

## Run it

`README.md` covers setup, the environment variables, every `ls-agent` command and the feature map. `src/cli.ts` is that command: `start` runs `src/server.ts`, and every other command but `bench` calls the service's API, so the wallet nonce and the one-run-at-a-time rule stay in one process. `deploy/ls-agent.service` runs `src/cli.ts start`.

A run is a list of seats, `POST /api/play {"seats":[{"dungeon":"lootBag","bag":7273,"maxSurvivor":100},{"dungeon":"beast"}]}`, with `"practice":true` for benchmark starts; `POST /api/cycle` starts a cycle. `runner.ts` checks every bag against the pool, its cap and the wallet before anything is bought.

With `LS_SEATS` above 1, a round decides one move per game and sends them in one transaction:

```
  game 1 ── decide ─┐
  game 2 ── decide ─┼──► one transaction ──► wait for its block ──► read every game's new state
  game N ── decide ─┘
```

When a game ends, its seat takes the next game. A minute later the bot settles the ended game on chain, which claims the beasts it killed. A cycle does not survive a restart: after one, unfinished games in `var/live.json` resume with the next run that asks for their dungeon, and for a Loot Dungeon game its bag, and ended games whose claim was cut off are settled when the next live batch starts. A bag purchase is tried once per seat; when sending it fails, the bot asks who owns the game it bought and plays it only if the wallet does.

| Risk | What to know |
|---|---|
| Wallet key | `var/wallet.json` holds the private key in plain text. Whoever reads it owns the funds. Back it up. |
| Spend floor | Under 20 STRK (`STRK_FLOOR` in `src/config.ts`) the bot sends nothing. Above it, nothing else limits spending. |
| Tickets | One per game. With less than one left, the bot buys 10 on Ekubo and refuses if they cost more than 2 STRK. |
| Loot bag purchase | Refused above the seat's `maxSurvivor` (`--max`), when the pool no longer holds the bag, or when the wallet is short. When sending fails, the bot asks the game token whether the wallet owns the game anyway and does not send the purchase again. |
| Moves | Most moves go through `commit_actions_unchecked`, which skips the contract's read of whether the game is settled and costs 40,000 L2 gas less. A game's first move in a process, and every 16th (`SETTLED_CHECK_EVERY` in `src/config.ts`), goes through `commit_actions`, which refuses a settled game; that refusal ends the seat at once. Nothing is sent for a game the local engine says is over. The owner check and the `expected_chain` check stay in both. An explore runs until 5 damage lands at full health, or until gold is found when the game is short of health and cannot buy a potion (`exploreDamage`, `exploreGold` in `src/rules.json`), so one move covers several encounters. Once GameCore has `commit_actions_batch` and `commit_actions_batch_unchecked`, which the bot checks once per process in the deployed class, a round sends its checked commits in one batch call and its unchecked ones in another, 38.8% less L2 gas a move at 400 games; a lone commit stays a single call. |
| Stopping | `ls-agent stop` ends play after the current move. The bot also stops if its local state differs from the contract. |

## Prove a change

| Command | What it does |
|---|---|
| `npm test` | Every test, without the network: contract answers come from `src/tape.json`, and a test that reaches the network fails. |
| `npm run contract` | The same tests against the live contract, one file at a time. `scripts/check.sh` runs it daily and writes `var/contract-check.json` for the page. |
| `npm run record` | Records the contract answers again into `src/tape.json` (about 40 seconds). Two runs give the same file. |
| `npm run prove -- 2` | Starts the real service on port 4199, plays 2 practice games with `ls-agent play --practice`, and leaves the database, log, event stream and game list in `var/evidence/<time>/`. `-- 2 lootBag` plays Loot Dungeon starts; `-- cycle` runs `ls-agent cycle` on the empty wallet of a fresh `var/`, where nothing can be spent, and keeps its status lines. |
| `npm run stats` | Rewrites the Results section of `README.md` from `scripts/baseline.json` and `var/ls.sqlite` (opened read-only), and nothing else in the file. Run it with `LS_VAR_DIR` on a copy of the production database. |
| `npm run bench` | Plays the policy on 10,000 fixed Beast Mode starts: mean level and spread, share reaching levels 26 to 40, named kills, causes of death. A difference under two standard errors is noise. |

For a page change, run the server on a free port with its own `LS_VAR_DIR` holding a copy of a real `ls.sqlite`, and look at it at 1920x1080 and 390x844.

## The flow

Changes land through `land.sh` from `~/dotfiles/agents/flow/`. It rebases on `main`, refuses added comments, new markdown files and commit lines matching `[land] forbid`, runs the kinds in `flow.toml`'s `[land] kinds` (`test`) with an audit of the change against the design rules, then moves `main`. `build.sh <kind>` runs a kind of `flow.toml` (`build`, `test`, `contract`) on a commit through the worker; heavy commands are refused outside it. Each lane works in its own worktree, made by `lane.sh <lane> <role>`.

## Developer tools

The features a user reaches are in `README.md`; these are for changing the code.

| Task | Command |
|---|---|
| Rank every bag again after a policy change | `npm run bench -- --dungeon lootBag --rank --all` |
| Compare policy variants on the same games, several at once | `npm run bench -- --rules '{}' --rules '{"jewelryLevel":99}'`; `ls-agent bench <rule>=<value>` is the one-candidate form |
| Confirm a result on more or other starts | `npm run bench -- --starts 50000 --from 1000000` |
| Save every game when it reaches level 30, or when its weapon reaches greatness 20 | `npm run bench -- --starts 40000 --reach 30 --keep var/level30.json`, `--reach weapon` |
| Play saved games forward on several luck seeds, to measure late-game rules | `npm run bench -- --late var/level30.json --seeds 0-10` |
| Use the contract's luck hash in place of the fast one (same distribution, 30 times slower) | `npm run bench -- --exact` |
| Play given Loot Dungeon games on 500 luck seeds each, one line per game | `npm run bench -- --dungeon lootBag --ids games.json --by-id` (a JSON list of game ids) |
| What a Greed Run game returns in STRK, cashing out at a fixed level or when rollouts of the policy say the next levels are worth less than cashing now, with exits and policy variants compared on the same starts and luck | `node scripts/greed.ts --starts 10000 --exit '{"rollouts":64,"horizon":6}' --exit '{"rollouts":128,"horizon":3,"rules":{"fightRisk":0.25}}'`: reads the payout curve from the Greed Run contract and prints the gas it assumes with the returns; `--wager 10` plays another stake the contract takes, and each row says how often a 335 STRK bankroll goes broke within 200 games (`--bankroll`, `--games`), resampling that row's games |
| Fail when the policy gets worse than `scripts/baseline.json` | `npm run bench -- --gate` (`--save` rewrites it, with the number of games) |
| Search one policy field at a time | `node scripts/search.ts --grid '{"fightRisk":[0.15,0.25,0.35]}' --level 35` |
| Explain how a game died, move by move | `node scripts/autopsy.ts var/ls.sqlite <row id>...` |
| Import human games for study | `node scripts/import.ts <dir>...` |
| Game data for a script | `GET /api/state`, `/api/games`, `/api/games/<row id>`, `/api/items`, `/api/status`, `/events` |

## Where facts live

| Fact | Source |
|---|---|
| Game rules | The contract. `src/engine/` is the local port, checked by the tests. |
| Rule policy | `src/policy.ts`; its shipped rules in `src/rules.json`, the ones set on a machine in `var/rules.json`, and the strategy id is the hash of the policy and the rules in play (`src/rules.ts`) |
| The cycle's numbers | `CYCLE` in `src/cycle.ts` |
| Contracts, dungeons, the Greed Run contract and its settings, spend floor, benchmark starts | `src/config.ts` |
| Action shapes and packet encoding | `src/codec.ts` |
| Collectable kills and the beast inventory | `src/beasts.ts` |
| Game art: the lootsurvivor.io images and the Loot Dungeon beasts of `@provable-games/collectables`, loaded by the page at runtime | `web/art.js`, checked by `src/assets.test.ts` |

`deploy/` runs it as systemd user services with a daily `scripts/check.sh` and a Traefik route. `deploy/install.sh` reads `LS_DOMAIN` and `LS_HOST` from `~/.config/ls-agent/env`.
