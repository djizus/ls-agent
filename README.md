# ls-agent

A bot that plays Loot Survivor 2, a dungeon game on the Starknet blockchain. It picks every move with fixed rules, pays for each move from its own wallet, and keeps the beasts it kills. Given more than one seat, it runs several games side by side and sends their moves together, so they share the network fee.

You watch it on a page served from your own machine, at http://127.0.0.1:4100 once `ls-agent start` runs. Whoever holds the key can also start and stop runs there, from the Play panel at `/#play`.

![The page with six live games](docs/page.webp)

## Setup

You need Node 22.18 or newer and openssl. The proof script, `scripts/prove.sh`, also needs bash and curl.

```
npm install
npm link                 # puts ls-agent on your PATH
mkdir -p ~/.config/ls-agent && echo "LS_TOKEN=$(openssl rand -hex 32)" >> ~/.config/ls-agent/env   # the key for actions
ls-agent start           # the page and the API on :4100; keep it running
ls-agent wallet          # in another terminal: the address of the wallet the service made in var/wallet.json
ls-agent deploy          # after sending STRK to that address: deploys the account
```

`var/wallet.json` holds the private key in plain text. Whoever reads it owns the funds, so back it up. Practice games (`ls-agent play --practice`) and `ls-agent bench` cost nothing.

Before the first real game, the wallet needs STRK: send some to the address `ls-agent wallet` prints, run `ls-agent deploy`, then `ls-agent play beast 5`. Loot Dungeon games also need SURVIVOR for the bag: each beast a Beast Mode claim brings pays 10 to 14 SURVIVOR to the wallet, while Loot Dungeon claims pay none, so Beast Mode games fund the bags, or you send SURVIVOR to the same address.

One seat plays the games of a run one after another. Set `LS_SEATS=8` to play eight at once, sharing each round's transaction; the default stays 1 so a new wallet spends on one game at a time.

To keep the service running after you log out, edit `WorkingDirectory` and the node path in `deploy/ls-agent.service` to match this checkout, then:

```
ln -s "$PWD/deploy/ls-agent.service" ~/.config/systemd/user/
systemctl --user enable --now ls-agent
loginctl enable-linger $USER
```

Every command, `ls-agent start` included, reads these settings from the environment and from `~/.config/ls-agent/env` when that file exists, one `NAME=value` a line; a variable set in the shell wins over the file. Put them in the file so the service and the commands agree on where the service listens.

| Variable | Default | Meaning |
|---|---|---|
| `LS_SEATS` | 1 | Real games played at once, sharing one transaction per round |
| `LS_BEASTS_TO` | unset | Account that receives every beast once claimed; the page lists its beasts, else the wallet's |
| `LS_HOST`, `LS_PORT` | 127.0.0.1, 4100 | Where the service listens |
| `LS_TOKEN` | unset | The key every action needs: `ls-agent` sends it, the page's Play panel asks for it once, and any other caller sends `Authorization: Bearer <LS_TOKEN>`. Unset, the service refuses every action |
| `LS_VAR_DIR` | `var/` | Where the wallet, database and caches live. End it with a slash. |
| `LS_RPC_URL` | public node | Starknet RPC |
| `LS_PACE_MS` | 0 | Pause between a decision and its move |

Beasts stay in the wallet unless `LS_BEASTS_TO` names an account: then every claim is followed by a transfer of all of them to it.

## What it spends

Every move is a small payment in STRK, the network's token, so a long game costs more than a short one. The page shows what the games have cost so far. Most games end early, so expect many short games for each deep one.

The bot never spends its last 20 STRK: below that it sends nothing, and the games of the run stop. Each Beast Mode game takes a ticket; with less than one left, the bot buys 10 and refuses if they cost more than 2 STRK. A Loot Dungeon game first buys a loot bag with SURVIVOR tokens, at most the `--max` you give; the cycle pays at most 100 for it.

One cycle plays 40 Beast Mode games, then the best bag:

```
  ls-agent cycle
      │
      ▼
  40 Beast Mode games
      │
      ▼
  the best loot bag costs ≤ 100 SURVIVOR
  and the wallet has enough?
      ├──yes──► buy it, play one Loot Dungeon game ──► done
      └──no───► skip it and say why ─────────────────► done
```

When a game ends, its seat takes the next game, and a minute later the bot settles the ended game on chain, which claims the beasts it killed. After a restart, an unfinished game resumes with the next run that asks for its dungeon, and for a Loot Dungeon game, its bag. A run stops by itself if its local state differs from the contract.

## Commands

`ls-agent --help` lists them. Every command but `start` and `bench` talks to the running service, which owns the wallet and plays one run at a time.

| Command | Example | What it does |
|---|---|---|
| `start` | `ls-agent start` | Runs the service: the page, the API and every run |
| `play` | `ls-agent play lootBag 7273 3378 7843 7808 --max 100` | Buys four bags, each for at most 100 SURVIVOR, and plays one Loot Dungeon game on each, side by side when `LS_SEATS` is 4 or more. Refused before anything is bought when a run is going, when the pool lacks a bag, or when a bag costs more than `--max` or the bags more than the wallet holds |
| | `ls-agent play beast 40` | Plays 40 Beast Mode games |
| | `ls-agent play beast 10 lootBag 7273 --max 90` | Both at once |
| | `ls-agent play --practice beast 20 lootBag 5` | Practice games on the benchmark starts, for nothing |
| `cycle` | `ls-agent cycle` | Runs one cycle, drawn above |
| `stop` | `ls-agent stop` | Ends the run and the cycle after the current move; unfinished games resume with the next run |
| `status` | `ls-agent status` | Whether a run is going, whether the service accepts this machine's `LS_TOKEN`, the live games with level and named kills, and the cycle's last step |
| `rank` | `ls-agent rank` | Ranks the bags new in the pool, in the background; the page shows the ranking |
| `logs` | `ls-agent logs` | Follows the run going now until it is done, then prints each game and the wallet. `play` and `cycle` do this by themselves |
| `wallet` | `ls-agent wallet` | Address, whether it is deployed, STRK, tickets and SURVIVOR |
| `rules` | `ls-agent rules` | Every rule the service plays with and the strategy id; a rule changed from the shipped `src/rules.json` shows the shipped value beside it |
| `bench` | `ls-agent bench fightRisk=0.25 jewelryLevel=9 --games 20000` | Plays the service's rules, or this checkout's when no service runs, and the candidate on the same 20k practice starts and prints both with the difference and its standard error. `--dungeon lootBag` plays Loot Dungeon starts |
| `rules set` | `ls-agent rules set fightRisk=0.25` | Changes a rule for every game started after, kept in `var/rules.json`; games in progress keep theirs, and setting the shipped value back drops the change. Refused for an unknown rule or a value that is not a number. The strategy id changes with the rules, so results stay per strategy |
| `deploy` | `ls-agent deploy` | Deploys the wallet's account |
| `bag` | `ls-agent bag 7273` | A bag's price, whether the pool holds it, and a simulated purchase |
| `beasts` | `ls-agent beasts` | The beasts the wallet, or a given address, holds, staked and to claim |
| `collect` | `ls-agent collect <game id>` | Settles a game and claims its beasts, which runs do by themselves |
| `quote` | `ls-agent quote <game id>` | What settling a game would cost, simulated |
| `send-beasts` | `ls-agent send-beasts <address>` | Sends every beast the wallet holds to the address |

## Results

As of 2026-11-22. `npm run stats` writes this section.

How the rules play on the local copy of the game, where games cost nothing:

| Dungeon | Games | Average level | Reach level 30 | Named beasts a game |
|---|---|---|---|---|
| Beast Mode | 10,000 | 16.2 | 8.7% | 2 |
| Loot Bag | 10,000 | 18.1 | 9.7% | 2.6 |

How the real games went:

| Dungeon | Games | Average level | Best level | Named beasts a game | Beasts claimed | Record game |
|---|---|---|---|---|---|---|
| Beast Mode | 477 | 15.8 | 42 | 1.8 | 25 | level 42, 25 named beasts |
| Loot Bag | 4 | 28.3 | 32 | 6 | 24 | level 32, 11 named beasts |

What the real games cost for their moves and loot bags, in dollars at today's prices:

| Dungeon | Spent | Per game | Per named beast killed |
|---|---|---|---|
| Beast Mode | 639 STRK ($20.2) | 1.3 STRK ($0.04) | $0.02 |
| Loot Bag | 16 STRK + 234 SURVIVOR ($10.9) | 4 STRK + 58.6 SURVIVOR ($2.72) | $0.45 |

## Feature map

| Feature | How to reach it |
|---|---|
| Live games as cards | `/` with live games: one card each, two columns up to four games, four beyond, stacked on a phone. Cards follow `GET /events`. |
| Watch one game in the official spectator | "Details" on a card, or a finished game in the list: `/?game=<row id>` embeds the game's own spectator. "Back to live" returns to the cards; "Reload" loads the spectator again when it opened before its indexer had the game. With no live game, `/` shows the latest one. |
| What the bot decided | The last chips of a card: Fight and Flee with their odds, or Explore. For a game open in the spectator, the bar under it, which for a finished game shows its level, killer, named kills, beasts claimed and STRK cost. |
| Games of a dungeon | "Games" on the left, "Beast" or "Loot": a podium of the three best, the 20 newest, "More" for all, live games on top. Each row shows its own dungeon: a bag for a Loot Dungeon game, a skull for Beast Mode, and the Live row shows the bag when any live game is a Loot Dungeon game. A gold skull marks a game that claimed or can claim a beast. |
| Figures of a dungeon | The six tiles under "Games": games ended, average level, named kills a game, dollars spent (STRK and SURVIVOR at market prices), best level, beasts claimed. `GET /api/summary`. |
| Engine no longer matches the contract | One red line above the middle panel when the last daily check failed or is older than 2 days, and nothing otherwise. `GET /api/check`. |
| Wallet and the cycle's last step | "Wallet" on the right: STRK (red under the floor), tickets, SURVIVOR, and the cycle's step now or how the last one ended. `ls-agent wallet`, `ls-agent status`. |
| Beasts held and to claim | "Beasts" on the right, one group per dungeon: count, tiers, Megas, staked, and what the Loot Dungeon pools pay for them. Five portraits at a time, newest first, with ‹ › to page through every one; hover one for its name and price. `ls-agent beasts`. |
| Loot bag ranking | "Loot bags" on the right: the best 25 bags the pool holds, by mean level or named kills, with copies left, as many as fit on a page and ‹ › for the next. `ls-agent rank`, or Refresh in the page's Play panel, ranks the bags new in the pool. |
| Play real games, practice games, a cycle, stop | `ls-agent play`, `ls-agent play --practice`, `ls-agent cycle`, `ls-agent stop`, with `LS_TOKEN` |
| Start or stop a run from the page | Open `/#play` once: Play in the Wallet head asks for the `LS_TOKEN` key, checks it with `GET /api/auth` and keeps it in that browser, which then shows "Play" on every visit until "Forget key". The Holdings and Play switch in the Wallet head shows either Beasts and Loot bags or the panel. The panel takes a number of Beast games and Loot bags from those for sale, ranked by named kills and paged like the ranking, checked bags kept across pages and named in the confirmation, at the pool's price, each with its SURVIVOR cap (the cycle's by default), and says what they cost at today's prices against the wallet. Play and Cycle ask for an in-page confirmation stating the amount and send the same `POST /api/play` and `POST /api/cycle` as `ls-agent`; while a run or a cycle goes they are disabled and Stop shows. The service's refusal shows as it is. Viewers without the key see no change. |
| Follow a run, see what runs | `ls-agent logs`, `ls-agent status` |
| See, try and change the rules | `ls-agent rules`, `ls-agent bench <rule>=<value>`, `ls-agent rules set <rule>=<value>` |
| Settle a game, its simulated cost, a bag's price, send the beasts | `ls-agent collect`, `ls-agent quote`, `ls-agent bag`, `ls-agent send-beasts` |
| Who may do what | Anyone who reaches the service reads the page and its `GET` routes. Every action, from starting or stopping a run to setting a rule, claiming beasts or ranking bags again, needs `Authorization: Bearer <LS_TOKEN>`: 401 without it or with a wrong key, 403 when `LS_TOKEN` is unset. `GET /api/auth` answers 204 for a good key. Pick a long random key, for example `openssl rand -hex 32`, since the code is public. |

MIT licence.
