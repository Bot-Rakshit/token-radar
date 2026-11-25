# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Bot-Rakshit/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Bot-Rakshit/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's token-radar-01: every protocol in a sealed DefiLlama snapshot that
records no token, ranked by what its token would be worth if its record stayed as it is, each with a
farm plan whose steps carry a cost and a time. Node 22, standard library only, no network.

## The value model (`dashboard/1-model.js`)

```
implied = TVL × peer multiple(category) × size × growth × no-token age
```

- **Peer multiple**: market cap ÷ TVL of the snapshot's own traded tokens whose cap belongs to their own
  TVL (`selectLivePeers`), restated at the $50M floor, clipped at the peer set's 5th and 95th
  percentiles, then shrunk category → family → all peers with credibility n / (n + 5) (`calibrate`,
  `peerMultiple`).
- **Size**: (TVL ÷ $50M) to the power −γ, where γ is half the size slope fitted on the peers (`fitScaleSlope`).
- **Growth**: (1 + 7-day change)^0.25, with the change clamped to −50…+100% (`growthTerm`).
- **No-token age**: ×0.85 for a new listing up to ×1.15 after three years tracked with no token
  (`noTokenAgeTerm`); an undated record stays neutral.
- **Low / high**: the peer pool's quartile multiples.
- **Backtest**: leave-one-out on the peers, against a flat 0.25× TVL and a raw category median (`runBacktest`).

Every one of the snapshot's protocols lands in one ledger group (`separateTokenStatus`): watchlist,
early (ranked below the floor), token trades, token recorded, or set aside with a reason. No protocol
name appears in the model: the lists name categories and chains.

## Farm plans (`dashboard/2-farm.js`)

The category picks the mechanism, the chains pick the venue and fee per transaction, TVL sizes the
position, days with no token set the hold, and the 7-day change adds a caution step. Each step states
its cost and time; the plan totals fees and gives the position's pro-rata share at an assumed 5% of the
implied value going to depositors.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
open out/dashboard/index.html
```

`main.ts` loads the same `dashboard/1-model.js` the page runs, checks the board against the gate's rules,
and writes `board.json`, `data.js`, the dashboard, the screenshots and `dossier.json`. The page recomputes
every value from the snapshot and shows how many match `board.json`. `tools/shoot.sh` takes the three
screenshots in headless Chrome at 1440×900.

Implied value is this model's claim, not a price and not a prediction that any token will launch.
