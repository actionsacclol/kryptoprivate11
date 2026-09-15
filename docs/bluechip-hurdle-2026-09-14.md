# Blue-chip round trips do not clear the cost floor — 2026-09-14

`docs/bluechip-data-plan-2026-09-14.md` proposed a two-month forward recording
project to answer whether a buy-then-sell rule on liquid Solana tokens can net
1.5 %. This memo answers it instead in one afternoon, from free backfilled
history and 42 Jupiter quotes, and the answer is **no** — by a wider margin
than the pump study in `docs/volume-edge-swarm-2026-09-14.md`.

Nothing was recorded, no provider key was added, no `TERMS_VERSION` moved, and
the recorder was never touched.

## The answer in one line

**The median best exit available anywhere in the next 30 minutes — known in
advance, with perfect foresight — pays for 43–74 % of the round trip.** Not the
profit. The cost.

## How the plan collapsed from 60 days to an afternoon

The plan's own §5 ordered the work cheapest-first. Both of the expensive halves
turned out to be answerable without recording:

| Plan item | Budgeted | Actual |
|---|---|---|
| (b) cost side — round-trip friction per coin per size | 3 days of `rt_probe`, dedicated Jupiter key, positions-open interlock | 42 quote calls, no key, one script |
| (a) move side — unconditional hurdle rate | ~260 GeckoTerminal calls | 195 calls, 28 days of 1-minute history, 7 coins |
| (c) is free OHLCV a valid proxy for executable price | 3 days of paired recording | moot — (b) measures the executable price directly; the pools were validated against live Jupiter quotes instead (±0.75 %) |

The plan's §4 collision analysis — the recorder prune deleting whole day files
oldest-first, `launchRecorder`'s `ALWAYS_KEEP` silently dropping new kinds — is
all still true and all now irrelevant, because nothing needs recording.

## The cost side, measured

Round-trip friction from two Jupiter quotes per cell (`1 - back/S`, the same
method as `electron/engine/farmProbe.ts`): spread, both impacts and both LP
fees in one unbiased number.

| size | JUP | FARTCOIN | BONK | PYTH | WIF | JTO | POPCAT |
|---|---|---|---|---|---|---|---|
| 0.5 SOL | 0.011 % | 0.063 % | 0.076 % | 0.108 % | 0.150 % | 0.368 % | 0.399 % |
| 2 SOL | 0.033 % | 0.088 % | 0.101 % | 0.133 % | 0.358 % | 0.396 % | 0.435 % |
| 10 SOL | 0.062 % | 0.110 % | 0.118 % | 0.208 % | 0.518 % | 0.553 % | 0.565 % |

Blue-chip friction is **0.01–0.57 %**, nothing like pump's 0.30 %/side (1.20 %
on a fresh pool). The venue is not the problem here.

### The hurdle, at 2 SOL

| coin | Krypt fee | route | priority | **user** | **owner** |
|---|---|---|---|---|---|
| JUP | 1.00 % | 0.033 % | 0.150 % | **1.18 %** | 0.38 % |
| FARTCOIN | 1.00 % | 0.088 % | 0.150 % | **1.24 %** | 0.44 % |
| BONK | 1.00 % | 0.101 % | 0.150 % | **1.25 %** | 0.45 % |
| PYTH | 1.00 % | 0.133 % | 0.150 % | **1.28 %** | 0.48 % |
| WIF | 1.00 % | 0.358 % | 0.150 % | **1.51 %** | 0.71 % |
| JTO | 1.00 % | 0.396 % | 0.150 % | **1.55 %** | 0.75 % |
| POPCAT | 1.00 % | 0.435 % | 0.150 % | **1.59 %** | 0.79 % |

Owner = the 0.20 % referral cut only; the other 0.80 % returns to the treasury
(`fee-and-referrals`). Priority is the engine's 0.00301 SOL floor over both
legs, so it falls to 0.03 % at 10 SOL.

**Our own fee is 63–85 % of the entire hurdle.** On pump it was 62.5 % of the
fixed floor. Here it is worse, because every other cost got cheaper and the fee
did not. This is the plan's §6.1 objection, now measured rather than asserted.

## The move side

Universe: WIF, BONK, JUP, PYTH, JTO, POPCAT, FARTCOIN — deepest pool each,
1-minute OHLCV, 27.8 days of overlap (2026-08-17 → 09-14), 124,148 entry bars.
Prices converted to **SOL terms** (`tokenUSD / solUSD`, SOL/USDC minute-matched)
because the round trip is bought and sold in SOL and the fee is charged there.
Minutes with no trade are forward-filled flat and excluded as entries — you
cannot sell at a price that never printed.

Each pool was checked against a live Jupiter quote at 2 SOL before being used;
all seven tracked the executable price within ±0.75 %, including the thin
BONK ($285 k) and PYTH ($403 k) pools.

### Perfect foresight: buy at a bar close, sell at the best price in the window

This is an **upper bound and not a strategy**. It assumes the exit minute is
known in advance and the entry needed no signal.

P(best exit in the next 30 min ≥ G):

| coin | ≥0.5 % | ≥1 % | ≥1.5 % | ≥2 % | ≥2.6 % | ≥3 % | median | p90 |
|---|---|---|---|---|---|---|---|---|
| WIF | 68.6 % | 33.1 % | 13.7 % | 6.3 % | 2.8 % | 1.8 % | 0.73 % | 1.68 % |
| BONK | 73.6 % | 28.7 % | 10.7 % | 4.8 % | 2.3 % | 1.5 % | 0.72 % | 1.53 % |
| JUP | 69.9 % | 43.6 % | 20.2 % | 8.4 % | 3.3 % | 1.9 % | 0.88 % | 1.89 % |
| PYTH | 67.4 % | 35.3 % | 15.8 % | 7.3 % | 3.0 % | 1.7 % | 0.75 % | 1.78 % |
| JTO | 63.5 % | 29.5 % | 11.6 % | 4.5 % | 1.6 % | 0.7 % | 0.67 % | 1.59 % |
| POPCAT | 65.2 % | 30.9 % | 12.7 % | 5.7 % | 2.6 % | 1.8 % | 0.69 % | 1.65 % |
| FARTCOIN | 74.1 % | 40.9 % | 18.5 % | 9.2 % | 4.6 % | 3.0 % | 0.85 % | 1.93 % |

Against each coin's own measured hurdle:

| coin | hurdle | median perfect exit, 30 m | covers | P(perfect exit ≥ hurdle) |
|---|---|---|---|---|
| JUP | 1.18 % | 0.88 % | 74 % | 35.0 % |
| FARTCOIN | 1.24 % | 0.85 % | 69 % | 30.2 % |
| BONK | 1.25 % | 0.72 % | 58 % | 19.6 % |
| PYTH | 1.28 % | 0.75 % | 58 % | 24.2 % |
| WIF | 1.51 % | 0.73 % | 48 % | 13.6 % |
| JTO | 1.55 % | 0.67 % | 43 % | 10.9 % |
| POPCAT | 1.59 % | 0.69 % | 44 % | 11.5 % |

Stretching to 60 minutes moves the median to 0.87–1.11 % — still short of the
hurdle on six of seven coins, while doubling the directional risk carried.

### No skill: fixed-horizon drift

Mean close-to-close return at every horizon is **−0.06 % to +0.01 %** gross,
i.e. zero. There is no drift to harvest; every basis point of expectancy has to
come from timing. That is the efficient-market result and it is the expected
one — it is stated here because it rules out the "just hold a blue chip for
fifteen minutes" family without further argument.

### A real rule: first touch of +G before −0.75 %, within 30 minutes

| coin | target | p(win) | p(stop) | p(neither) | p* needed | net |
|---|---|---|---|---|---|---|
| JUP | 1.5 % | 15.7 % | 53.7 % | 30.7 % | 85.9 % | **−1.35 %** |
| FARTCOIN | 1.5 % | 14.6 % | 55.1 % | 30.4 % | 88.4 % | **−1.43 %** |
| PYTH | 1.5 % | 12.6 % | 48.9 % | 38.6 % | 90.4 % | **−1.46 %** |
| BONK | 1.5 % | 8.7 % | 48.5 % | 42.8 % | 89.0 % | **−1.48 %** |
| WIF | 1.5 % | 11.5 % | 45.7 % | 42.8 % | **100.4 %** | **−1.68 %** |
| JTO | 1.5 % | 10.0 % | 45.9 % | 44.1 % | **102.1 %** | **−1.74 %** |
| POPCAT | 1.5 % | 10.2 % | 44.3 % | 45.5 % | **103.8 %** | **−1.76 %** |

Every coin, every target from 1.5 % to 3 %, is net-negative by 1.35–1.88 % per
round trip. The stop is hit four to five times more often than the target.

**On WIF, JTO and POPCAT the 1.5 % target is arithmetically impossible**: the
required win rate exceeds 100 %, because a 1.5 % gross gain is smaller than the
1.51–1.59 % it costs to collect it. No signal, threshold or horizon fixes that.

## Why this is a harder no than the pump study

The pump swarm found real signals that were too small. Here the signals were
never reached, because the *unconditional* material is too small: the best
possible exit for a median entry does not cover the toll. A selection rule
would have to find entries in the top decile of the perfect-foresight
distribution **and** exit near the exact high, and the pump study already
measured what real signals are worth (0.3–3 % per trip, and −0.27 % net even
with our fee deleted).

One asymmetry is worth stating plainly, because it is the same one the farming
page now states: **for the owner the hurdle is 0.38–0.79 %, and the median
perfect-foresight 30-minute exit clears it.** That does not make it a strategy —
perfect foresight is not available and the no-skill drift is zero — but it is
the second measurement in two days showing that this app's economics work for
whoever collects the fee and not for whoever pays it.

## The one thing worth building from this

Plan item (d) survives, and it is the cheapest item in the whole document:
**store the quote next to the fill.** The ledger already derives cost basis from
on-chain lamport deltas (`pnl-from-chain`), so every real trade already contains
a quote-vs-fill residual that is simply not written down. The entire fill model
in this project rests on **one observation** (`jupiterRoute.ts:231`, a fill 11 %
under quote on 2026-09-11). Recording the pair costs nothing, spends no rate
budget, and turns every trade a user makes into calibration data.

## Incidental finding: the GeckoTerminal budget looks stale

`electron/data/http.ts:243,294` sets a 2,100 ms gap and a 28-per-minute window
for `geckoterminal`, commented "30/min with headroom". The public tier refused
that rate today: 429s appeared within five calls at a 2.2 s gap, and this study
settled at a self-tuned **~10.5 s gap (≈ 5.7 calls/min)** — 13 × 429 across 195
calls. Whether this is a per-IP tightening, a shared-pool effect or specific to
the 1000-row `ohlcv` call is not established here, but the chart's keyless
candle path depends on that budget, so it is worth a look independently of this
study.

## Reproducing

Scripts are throwaway and live in the session scratchpad, not the repo:
`cost.mjs` (Jupiter friction), `fetch.mjs` (GeckoTerminal paging, resumable,
self-tuning limiter), `pricecheck.mjs` (pool vs executable price),
`metrics.mjs` + `metrics.test.mjs` (window and first-touch math, 14 assertions),
`analyze.mjs`. The `before_timestamp` query parameter pages `ohlcv` cleanly and
minute history reaches at least 45 days back; `ohlcvOn` in
`electron/data/providers/geckoterminal.ts` still does not plumb it, and does not
need to unless something in the app wants history.
