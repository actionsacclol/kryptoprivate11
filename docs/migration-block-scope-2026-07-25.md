# Migration-block edge — scoping, 2026-07-25

Costing the one place in this market where measured value is *not* already
consumed before we can transact. Data: 877 migrations on the 2026-07-25 tape,
decoded via `ammDecoder`. Method: constant-product replay — insert our buy at
the pool state we would actually arrive at, replay every observed trade
against the shifted pool (buys fixed quote-in, sells fixed base-in), then sell
our bag with our own exit impact priced in. Scripts: `frontrun.mjs`,
`position.mjs`, `cap.mjs`.

## The finding: block position is the whole game

Per-trade SOL P&L, 5 SOL size, 5 s hold, by how many trades beat us into the
pool. Medians (raw means are sandwich tails that assume foresight we lack):

| position | median | median % | win rate |
|---|---|---|---|
| 1st | +0.2170 | **+4.34%** | 57.1% |
| 2nd | +0.0727 | +1.45% | 53.7% |
| 3rd | **−0.0950** | −1.90% | 37.5% |
| 4th | −0.0967 | −1.93% | 36.6% |
| 6th | −0.0998 | −2.00% | 33.8% |

The cliff is between 2nd and 3rd, and it is the same cliff everywhere else in
this project: by the third trade the price has moved and the edge is gone.
Price has already moved a median **2.89%** by position 2 and **3.59%** by
position 3.

## A slippage cap converts lost races into free aborts

This is what makes it implementable. Capping max slippage means a lost race
fails the fill instead of buying the top — so losing costs fees, not P&L.

5 SOL, 5 s hold, by cap and arrival position (median P&L / fill rate):

| cap | pos 1 | pos 2 | pos 3 | pos 4 | pos 6 |
|---|---|---|---|---|---|
| 2% | +0.217 / 100% | −1.109 / 26% | −2.086 / 25% | −2.956 / 25% | −3.770 / 28% |
| **5%** | **+0.217 / 100%** | **+0.150 / 77%** | **+0.071 / 58%** | **+0.043 / 56%** | −0.050 / 52% |
| 10% | +0.217 / 100% | +0.141 / 79% | +0.057 / 63% | +0.026 / 63% | −0.011 / 64% |
| 25% | +0.217 / 100% | +0.124 / 83% | +0.018 / 68% | +0.015 / 68% | −0.044 / 69% |

At a 5% cap, positions 1–4 are all positive — the cap rescues the positions
that were negative without it.

**A 2% cap is actively harmful**, and the reason matters: it only fills when
price *didn't* move, which means nobody else wanted the token. Too tight a cap
buys exactly the migrations with no demand. That is adverse selection, not
safety.

## Rough size of the prize

Median-based (excludes the foresight-dependent tails), 877 migrations/day,
5 SOL, 5% cap, 5 s hold:

| typical position | fill rate | median/fill | **SOL/day** |
|---|---|---|---|
| 1st | 100% | 0.217 | ~190 |
| 2nd | 77% | 0.150 | ~101 |
| 3rd | 58% | 0.071 | ~36 |
| 4th | 56% | 0.043 | ~21 |

Working capital: ~37 migrations/hour, 5 s holds → 5–10 concurrent positions,
so **~50–100 SOL** including buffer. Capacity is capped: at 10 SOL size the
position-1 median return drops to 3.25% and at 25 SOL it goes negative. **This
does not scale past ~10 SOL per event.**

## What it requires

To be position 1–2 you must be in the *same block* as the migration. You
cannot react to it — reacting is a block late (~400 ms), which is position
3+. So it needs:

1. **Prediction**, not reaction: watch curves approaching completion and
   pre-stage the AMM buy. The engine already tracks curve progress.
2. **Bundle landing** (Jito, top-of-block) with the buy immediately behind the
   migration.
3. **A 5% max-quote-in cap** so lost races revert instead of filling.
4. ~50–100 SOL working capital.

## The one number that decides it, and we cannot measure it here

**Priority tip cost.** The tape has no tip data. And this is an auction: the
edge at position 1 is 0.217 SOL on a 5 SOL trade, so if landing top-2 in a
contested migration block costs more than ~0.15 SOL in tips, it is gone.

**67.7% of migration blocks already have more than one distinct actor in the
first slot** (median 3 trades, max 29). First-buy sizes run to 20 SOL at p95
and 120 SOL max. This is an occupied trade, run by people with better
infrastructure than ours, and an efficient priority auction competes exactly
this edge away toward the tip.

My honest prior: the tip is likely to eat most of it. But "likely" is not
"measured", and this is the only lever of four where the value is not
provably out of reach.

## CORRECTION (same day): the edge is not reachable, and the numbers above are not the addressable ones

The section above prices being first in the block **without asking whether you
can get there**. Building the predictor required answering that first, and the
answer kills it.

### Lead time is one block

Time from the bonding curve crossing 95% to migration:

| threshold | median lead | share <400 ms | precision | recall |
|---|---|---|---|---|
| 95% | **395 ms** | 50.9% | 50.4% | 75.0% |
| 98% | 385 ms | 53.1% | 51.6% | 74.7% |
| 99% | 379 ms | 54.3% | 51.8% | 74.6% |

Median lead is **one Solana block**, and half of all migrations complete
within 400 ms of the crossing. You cannot react to the crossing and land in
the migration block. Precision is also only ~50% — half the tokens that cross
95% never migrate — so pre-staging on the signal wastes half its fires.

### And the edge lives precisely in the part you cannot reach

First-in-block P&L, 5 SOL, 5 s hold, split by that lead time:

| bucket | n | median | median % | win | SOL/day |
|---|---|---|---|---|---|
| **lead <400 ms (unreactable)** | 370 | +1.4951 | **+29.90%** | **95.9%** | 553 |
| lead 400 ms–2 s | 89 | +0.2386 | +4.77% | 77.5% | 21 |
| lead 2 s–30 s | 81 | +0.0175 | +0.35% | 50.6% | 1.4 |
| lead >30 s | 118 | −1.0875 | −21.75% | 27.1% | −128 |
| no crossing observed | 219 | −4.7682 | −95.36% | 1.8% | −1044 |

A token that goes 95%→100% inside one block is being bought aggressively and
migrates into that demand: 95.9% win rate. A token that limps across in >30 s
dumps. **The lead time that makes a migration profitable is the same lead time
that makes it unreachable.**

### The reachable version of the signal is negative at every entry

Using lead time only as a *filter*, then entering after the migration — no
block priority needed. Net of the 4.5% floor:

| bucket | entry | hold | n | median | win |
|---|---|---|---|---|---|
| fast (<400 ms) | +1 s | 5 s | 370 | **−3.93%** | 6.5% |
| fast (<400 ms) | +1 s | 60 s | 370 | −4.04% | 15.9% |
| fast (<400 ms) | +5 s | 30 s | 370 | −4.87% | 7.3% |
| mid (400 ms–2 s) | +1 s | 5 s | 89 | −3.43% | 13.5% |
| mid (400 ms–2 s) | +15 s | 60 s | 89 | −9.31% | 27.0% |

**All 24 configurations negative.** The same tokens that win 95.9% of the time
at position 1 win **6.5%** of the time one second later. The entire value has a
half-life of well under a block.

### What is actually addressable

Only the 400 ms–2 s bucket: **89 events/day, +0.2386 SOL each at 5 SOL and
position 1 — ~21 SOL/day gross, before tips**, and it needs sub-second bundle
landing against blocks that are 67.7% contested. That is ~0.24 SOL of edge per
attempt to be auctioned against people already there. The 2 s–30 s bucket,
which is comfortably reachable, is worth 1.4 SOL/day — noise.

The ~190 SOL/day headline earlier in this document is **not addressable** and
should not be quoted.

## Superseded: the bounded live experiment

The experiment proposed here assumed the addressable prize was ~100–190
SOL/day. It is ~21 SOL/day gross before tips, on 89 events, in contested
blocks. At 0.24 SOL of edge per attempt, a priority auction against
incumbents does not plausibly clear — and unlike the earlier framing, the
downside is no longer bounded by "capped buys just revert", because the
addressable bucket is the one where we are slowest.

**Recommendation: do not run it, and do not build the predictor.** The
predictor's own precondition — usable lead time — measured at 395 ms median
with 50% precision. Building it would produce a component with no strategy to
serve.

## Registry additions (do not re-spend)

Migration-block front-running at reachable latency · curve-threshold
migration prediction (95/98/99%) · lead-time-filtered post-migration entry at
any delay.

## Caveats

- **One day, 877 migrations.** Medians are robust at that n; the day is not.
- **The replay assumes others trade the same notional despite our presence.**
  At 5 SOL into a ~67 SOL pool we are ~7.5% of the book — real fills for
  everyone behind us would be worse, and some would resize. This makes the
  numbers an **upper bound**.
- Migration cadence (877/day) is regime-dependent and will not hold.
- The 5 s hold is not optimised; 60 s is materially worse (position-1 median
  drops from +0.217 to +0.016 at 5 SOL), which is consistent with everything
  else here — post-migration value decays within seconds.
