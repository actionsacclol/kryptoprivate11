# Smart-wallet convergence: the wallets are real, the edge is not copyable — 2026-09-14

Tested the "wallet farmer" idea: rank wallets, and when several top wallets
converge on the same mint, enter with them. Two day-pairs, six weeks apart,
train on one day and test on the next, never re-ranking on the test day:
**2026-09-10 → 09-11** and **2026-07-26 → 07-27**. 9.3M curve trades.

Everything below replicates across both periods.

## The answer

**No — but for a reason worth having.** Convergence makes following *worse*,
and the deeper problem is that the leaders' edge is **latency**: the median
leader holds a position for **six seconds**. That is the one edge a follower
cannot copy, and this product is manual-execution-first.

## What is real, and it is large

Top wallets are genuinely predictive. Following a single one beats a random
buy, measured identically, by **45–49 percentage points** at 60 minutes:

| 60-minute median | Sept | July |
|---|---|---|
| random buy (control) | −59.7% | −59.5% |
| follow one top wallet | **−14.9%** | **−10.3%** |

And they persist: **85.0% / 85.1%** of a training day's profitable wallets
traded again the next day. The ranking is not noise. Nothing in this memo
argues the Leaderboard is measuring nothing — it measures something big.

It is just not, on its own, a profitable thing to follow: −14.9% is better than
−59.7% and still a loss.

## Convergence makes it worse, monotonically

Distinct top wallets buying the same mint within 5 minutes, entered at an
honest fill on the K-th buy (Sept; July has the same shape):

| K | events | 1m | 15m | 60m |
|---|---|---|---|---|
| 1 | 22,987 | −17.1% | −16.1% | **−14.9%** |
| 2 | 14,637 | −15.6% | −20.1% | −23.2% |
| 3 | 10,096 | −15.6% | −23.5% | −28.7% |
| 4 | 8,016 | −15.6% | −25.7% | **−32.1%** |

Frequency was never the problem — 8,016 four-wallet convergences in a day is
ample. The signal is simply inverted: by the time three independent wallets
have landed, you are buying their exit liquidity.

## Mirroring both legs — the shipped copy-trade shape — also loses

`copytrade-paper-first` has mirrored leader sells since 2026-09-08, so the
honest simulation is buy when they buy, sell when they sell, both at an
honest fill:

| | Sept | July |
|---|---|---|
| positions | 122,071 | 198,813 |
| median, net of 0.85% | **−4.06%** | **−6.64%** |
| 1%-trimmed mean, net | −2.89% | −4.39% |
| win rate vs cost | 36.9% | 33.3% |
| **median hold** | **0.1 min** | **0.1 min** |

That last row explains the rest. These wallets are not smart money
accumulating; they are snipers flipping in seconds. An 800 ms lag on a
six-second trade puts a follower late on both legs, which is precisely the
swarm's "leaders' edge +0.34%/trip, follower's tax 1.60%" seen from the other
side.

## Slow leaders do not rescue it

Bucketing leaders by their own median hold on the training day:

| bucket | Sept median net | Sept win% | July median net | July win% |
|---|---|---|---|---|
| <1m | −3.72% | 36.8% | −6.22% | 33.3% |
| 1–10m | −5.72% | 37.6% | −9.10% | 33.4% |
| 10–60m | −10.94% | 29.1% | −15.16% | 28.9% |
| >60m | −17.11% | 19.1% | −2.28% | 44.0% |

Every bucket is negative on the median in both periods. The >60m bucket shows
a positive *trimmed mean* (+9.0% / +7.7%) on 194 and 452 positions with win
rates of 19% and 44% — inconsistent between periods, negative medians. That is
two big winners, not an edge, and it is exactly the shape this project has
twice mistaken for a signal.

## Method notes, because the first cut said the opposite

The first run of this test reported **+12.6% net** and was wrong three ways.
All three are the difference between a strategy and an artefact:

1. **Entry was the leader's own print.** You cannot fill inside someone else's
   transaction. With the swarm's honest-fill rule (first print ≥ 800 ms later)
   the same cell went from +6.7% to −15.6%.
2. **Means, on pump.** The mean was +6.7% while the median was −15.6%; a
   handful of +1000% tokens carried it. Everything above is median and
   1%-trimmed mean.
3. **No control.** Pump tokens bleed −59.7% in an hour unconditionally. Without
   that row, −14.9% reads as a disaster instead of a 45-point outperformance.

Survivorship remains and flatters every number here: only 18–28% of mints still
print at the 60-minute horizon, and the ones that stop are the ones that died.
Positions a leader never closed in-window are excluded rather than counted as
losses. The true figures are worse than shown.

## The actionable finding

`rankLeaders` ranks wallets by **their own** profitability. On pump that
selects for latency edge — the snipers — which is the subset a follower
structurally cannot copy. The Leaderboard is therefore optimised to surface
exactly the wallets least worth following.

The fix is a different objective: score a leader by the return a **follower**
would have realised mirroring them at an 800 ms lag on both legs, not by what
the leader made. That is computable from the same tape, it is a change to the
ranking rather than to the execution path, and it would make the existing Copy
Trading feature honest about who is worth copying — regardless of whether an
automated version is ever built.

Whether any wallet survives that objective is not established here, and it is
the next thing to measure.

## Reproducing

    node scripts/analysis/extract_trades.mjs E:/data/2026-09-10.jsonl --out tape/trades
    node scripts/analysis/convergence.mjs --train tape/trades/2026-09-10.csv \
                                          --test  tape/trades/2026-09-11.csv

`extract_trades.mjs` rejects on a substring before `JSON.parse` — ~87% of the
firehose is `tape_amm` blobs this study does not use — which turns a 24 GB day
into a 350 MB CSV in about a minute.

---

# Addendum: ranking by follower-realisable return

Ran the objective proposed above — score a wallet by the median return a
**follower** realises mirroring it at an 800 ms lag on both legs, net of cost,
rather than by the wallet's own PnL. Scored on the training day, deciles
carried to the test day untouched. Both day-pairs.

## It persists, strongly

Training-day decile → test-day follower outcome:

| decile | train score | Sept test median | Sept win% | July test median | July win% |
|---|---|---|---|---|---|
| 1 | −65 / −70% | −57.4% | 18.1% | −61.0% | 8.8% |
| 5 | −14 / −18% | −11.4% | 34.5% | −16.5% | 26.6% |
| 8 | −1.5 / −3.3% | −1.7% | 36.7% | −4.5% | 35.7% |
| 9 | +3.0 / +0.9% | **−1.3%** | 45.5% | **−1.2%** | 37.5% |
| 10 | +16 / +14% | −3.5% | 45.2% | −4.2% | 44.3% |

Monotone across ten deciles in both periods, six weeks apart, on 200k+ test
positions. Followability is a **persistent wallet property**, not noise. That
is a real finding and it is the first thing in this project to replicate this
cleanly.

## And it is a large improvement on the current objective

Top-N wallets by each objective, mirrored on the test day:

| objective | Sept median | Sept win% | July median | July win% |
|---|---|---|---|---|
| leader's own PnL (`rankLeaders` today) | −6.52% | 35.9% | −10.99% | 32.9% |
| **follower-realisable (proposed)** | **−3.42%** | **45.3%** | **−4.11%** | **44.4%** |

It roughly **halves the loss** and lifts the win rate by ~10 points, in both
periods. Switching the Leaderboard to this objective is a clear improvement.

## But it does not reach profitability, and the fee is not why

No decile is positive in either period. The best is decile 9 at −1.2%/−1.3%.

And the cost floor is not the binding term. At the 0.85% pump floor the top
decile nets −3.4%/−4.2%, so the **gross** follower return is −2.6%/−3.3%.
Moving to an established-coin floor of 0.19% leaves roughly −2.8%. Deleting our
fee entirely leaves it negative. As with the flow agent's counterfactual in the
volume swarm, our fee is not what kills this — following simply loses.

Decile 9 beating decile 10 in both periods is worth noting: the extreme top of
the ranking is fitted to the training day. If this objective ships, the top
decile is not the right selection — decile 9 is, which is a strange thing to
put in a product and an honest thing to know.

## What this settles

The wallet-farmer idea is closed: convergence inverts the signal, mirroring
loses at every leader speed, and the best available ranking objective still
loses. What survives is a **product improvement, not a strategy** — a
Leaderboard that ranks by followability would stop pointing users at snipers
they cannot copy. It should be framed as "least-bad to follow", never as an
edge, because measured over two periods it is not one.
