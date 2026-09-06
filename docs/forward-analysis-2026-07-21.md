# Forward-data analysis — 2026-07-21 tape (first day with clean-feed stack)

First day of data recorded with the racing feed pool, dip-buy shadow detector,
and social-metadata capture all live (~10.5h, 2.67M trade lines, 34,645 mints,
3,841 dip signals / 3,774 completed shadow exits, 13,360 metadata rows,
611 feed-health minutes). Scripts: `scripts/analysis/analyze_forward_0721.py`,
`dip_slices_0721.py`, `dip_gross_grid_0721.py`. Derived rows in
`D:\memedata\derived\{dip_records,feed_health,metadata}.jsonl`.

## 1. Dip-buy shadow forward test: NEGATIVE as configured

- 3,774 exits, **−8.46 SOL total, −0.00224 SOL/trade** on 0.05 size, 30.4% win.
- Mean gross multiple 0.9752 (−2.5%/trade after pump fees + own impact).
- Stop-losses do all the damage: 1,015 stops at −0.0193 avg (−33% realized vs
  the −25% configured — cascade slippage) vs trailing +10.7 SOL over 2,146.
- Negative in EVERY hour of the day — regime-independent, not a bad-day fluke.
- Per-trade drag decomposition at 0.05 size: fixed 0.001 overhead = 2.0%,
  so gross-positive slices were being reported as net losers.

**BUT the fill model was optimistic**: v1 filled entries and exits at the
trigger tick's reserves (the exact fill-at-trigger mirage the tape analysis
warned about). True stop-loss costs are WORSE than measured. Fixed in
dipShadow v2 (see §4).

## 2. Profitable sub-regions exist (in-sample, gross)

Grid over entry features (n≥150, ≥60 unique mints, half-day stability split):

| config | n | mints | grossMult | h1 | h2 |
|---|---|---|---|---|---|
| bounce<25, age≥15min, vSol 32-40 | 153 | 99 | **1.0505** | 1.100 | 1.007 |
| offPeak≥70, bounce<25, age≥15min | 180 | 79 | 1.0389 | 1.079 | 1.010 |
| offPeak 50-70, age≥15min, socials | 198 | 72 | 1.0284 | 1.032 | 1.026 |
| bounce<25, age≥15min, socials | 421 | 118 | 1.0188 | 1.030 | 1.011 |

Consistent structure (not noise — monotone across the grid):
- **age ≥ 15min** beats fresh dips everywhere (the 45s-15min zone is the loser).
- **bounce < 25%** (enter early off the low; chasing an extended bounce ≥25%
  fills the bottom of the table, worst 0.877 gross).
- **has-socials** helps dip PnL (−0.15%/trade vs −0.35% without).
- vSol 32-40 (small curve remaining) beats bigger curves.

Caveats: one day, in-sample slice selection, 3.5 signals/mint (correlated
re-entries; 652 of 1,098 mints re-signaled). Gross 1.02-1.05 minus realistic
fixed costs at 0.2-0.3 SOL size (~0.3-0.7%) and extra self-impact could be
positive — but must survive (a) the honest v2 fill model and (b) an
out-of-sample forward day before believing it.

## 3. Social metadata: research claim INVERTED on our tape

Published research said social links = 8.9-17.4x graduation lift. Our own
10,641 resolved mints say the opposite for *reaching* the curve top:

| group | n | grad% (maxCurve≥99) | ≥50% curve |
|---|---|---|---|
| socials=0 | 3,478 | **10.1%** | 17.9% |
| socials=1 | 3,625 | 4.2% | 8.2% |
| socials=2 | 3,341 | 2.8% | 6.6% |
| twitter yes/no | 6,677/3,964 | 3.3% / 9.9% (0.3x) | 7.2% / 17.4% |

Interpretation: in the current meta, scam factories auto-fill socials while
fast organic runners launch bare; socials are anti-signal for graduation odds
but mildly pro-signal for dip-bounce quality (established community buys the
dip). Trust our own tape over blog posts. (Selection caveat: only mints that
traded while capture was on; graduation proxy = maxCurve≥99 seen in tape.)

## 4. Shipped: dipShadow v2 (honest fills + exit matrix)

- Entry AND every exit now fill at the first tick ≥800ms after their trigger,
  at THAT tick's reserves. Entry slip (`entrySlipPct`), exit slip
  (`exitSlipPct`), and `fillDelayMs` are recorded; silent-tape entries abandon
  after 30s and are recorded with `abandoned: true`.
- Each entry runs 4 exit variants in parallel, every `dip_exit` tagged with
  `variant`: `trail15_sl25_t180` (baseline, feeds stats/log), `trail10_sl15_t180`,
  `trail25_sl35_t600`, `trail15_sl25_t600`.
- Entry gates deliberately stay broad: tighter gates (the §2 slices) are
  evaluated offline by filtering signal records — equivalent for a shadow
  strategy and keeps the sample wide.
- Tests rewritten (test/dipshadow.test.mjs, 7 cases); typecheck + full suite green.

## 5. Feed still lossy: ~14% mean despite racing pool + Helius

611 minutes: loss p50 13.7%, mean 14.1%, worsening through the day
(12.9% → 15.2%). Helius won 94% of races (406M wins) — so the pool works,
but even Helius WS misses events at firehose rates. Options, in order:
(a) Helius gRPC/LaserStream (paid) or Yellowstone from another provider;
(b) check whether the loss estimator overcounts (it counts reserve-gap ticks,
which also fire on any missed *upstream* event, not just socket drops);
(c) more WS endpoints in the pool. Flow-count features (inflow, buyers)
remain undercounted ~14% until fixed — dip features (price levels) are
less affected, which is another reason the dip family is the right home base.

## Next steps (in order)

1. Let v2 run a full day → re-run the grid on honest fills, filtered to the
   §2 candidate gates (bounce<25, age≥15min, socials, vSol band) as the
   PRE-REGISTERED hypothesis — no new slice-mining on the same data.
2. Measure realized exit slip on stop_losses (v2 `exitSlipPct`) to price the
   cascade cost directly.
3. If the refined gate survives honest fills out-of-sample at ≥ +1%/trade
   gross: size math at 0.2-0.3 SOL, then a tiny-size live pilot behind the
   existing live-buy breaker (validated-relayer path, local tx build as
   cost-down later).
4. Feed: decide on paid gRPC vs more WS endpoints after checking estimator
   semantics.
