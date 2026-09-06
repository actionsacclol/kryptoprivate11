# Full-tape strategy analysis — 2026-07-21

**Data:** 3 days of firehose recording (D:\memedata, 2.7 GB, 6.42M events):
53,937 token launches, 4.47M trades, 137k unique wallets, 2026-07-19 → 07-21
(day 3 is partial, ~1.6 h). Derived tables in `D:\memedata\derived\`
(built by `scripts/analysis/extract_tape.py`).

**Method:** every simulation uses curve-exact fills from the recorded virtual
reserves (constant-product), pump.fun 1% fee each way, 0.001 SOL fixed
overhead, 400 ms entry latency, and — critically — **exit latency** (sell
lands at the first tick ≥ trigger + N ms). Position size 0.05 SOL.

## Headline: no tested configuration is profitable under honest assumptions

~200 strategy configurations tested across six families. Everything converges
to ≈ −(fees + latency tax) or worse:

| Strategy family | Best result (avg/trade at 0.05 SOL) |
|---|---|
| Buy everything, current exits | −0.0034 (−7%) |
| Any single-feature gate, current exits | ≈ −0.0014 at best |
| Momentum entry + trailing exits, **0 ms exit** | **+0.0027 (+5%)** ← mirage |
| Same, 400 ms exit latency | −0.0014 |
| Same, 800 ms exit latency | −0.0020 |
| Sell-into-strength (hard TP), 800 ms | −0.0006 … −0.0016 |
| Flow-stall predictive exits, 800 ms | −0.0014 … −0.0024 |
| Hold to 15 min (graduation hunting) | −0.0072 … −0.0115 |
| Copy-trade mined winner wallets, 800 ms | −0.0022 … −0.0039 |
| Dip-buy survivors (post-dump bounce), 800 ms | **−0.0001 … −0.0006 (breakeven)** |

The one real edge found (net-inflow ≥ 6–8 SOL by t+5 s, creator hasn't sold,
dev buy ≤ 2 SOL, fresh creator, trailing exits: +0.87 SOL/day at 0.05 size)
exists **only with exits filled at the trigger tick**. Breakeven exit latency
is ~150–250 ms — *inside one Solana slot*. That tier belongs to same-slot
MEV/bundle operators. At our achievable ~800 ms it inverts to a loss.

Structural reason: 76% of creators dump (median first creator sell at 14.5 s,
p25 3.7 s). Most exits therefore happen *during cascades*, where every ms of
latency costs price. Latency-immune exits (fixed TP into strength, stalls,
horizon holds) avoid the tax but their gross edge is smaller than fees.

## Who actually makes money (wallet mining)

Per-wallet round-trip PnL over the tape found ~200 wallets earning
30–500 SOL/day with 60–100% win rates, 4–12 SOL positions, 20–160 s holds.
Day-1 selection persisted on day 2 (+1,131 SOL aggregate; top wallet 44849:
+358 → +550 SOL, 96% win). Table: `derived/wallet_candidates_d1.csv`.

Copy-trading them at +800 ms **loses** (−4%/trade): their entries push the
curve before we fill and their exits crash it before we're out — their margin
is precisely the spread between their timing and everyone else's.

## Data-quality findings (affect the LIVE engine, not just analysis)

1. **~20% of trade events are missing/inconsistent.** 21.75% of ticks have
   reserve deltas that don't match the reported trade (k jumps), 31.6% of
   tokens affected. Cause: silent event loss on the free public
   `api.mainnet-beta.solana.com` websocket under firehose load (bad-tick rate
   doubles at same-ms bursts). Live impact: the engine's flow features
   (buys/sells/inflow/curve%) are systematically undercounted at decision
   time. Analysis used only the 32,920 clean tokens.
2. **The 2026-07-19 gate refit (+0.83 SOL in-sample) does not replicate** on
   the full tape: the same gates give n=194, −0.65 SOL with real fills. The
   paper win was optimistic fills + corrupted feed + survivorship on 150
   engine-selected trades. The "clean book" (sells==0) gate is actually
   *inverted* on clean data — zero-sell books at t+5s are mostly dead tokens.
3. **Live execution has been silently dead since 07-19**: all 69 live buys
   after the first 8 failed at `stage=simulate` — the wallet (0.044 SOL)
   can't cover 0.03 buys + fees + rent buffer. No breaker or alert fires on
   simulate-stage failures.
4. Prices/curve% must be derived from each event's own reserves (they are),
   but sequence gaps mean any *delta-based* live feature (buyer acceleration,
   net inflow) is unreliable until the feed is fixed.

## Recommendations, in order

1. **Do not enable autoLive with the current strategy.** Expected loss is
   0.5–4% per trade. The two live sessions' losses were the strategy working
   as simulated, not bad luck.
2. **Fix the feed** (prerequisite for everything): move launch/trade
   ingestion to Helius WS or Yellowstone gRPC (research memo already scoped
   the adapter), add slot-sequence gap detection, and log dropped-event
   counters. Re-run this analysis on a clean week of data.
3. **Add a simulate-failure breaker + wallet-balance preflight** so the live
   path can never silently no-op again (also: alert when balance < position
   size + 0.02 buffer).
4. **Kill the PumpPortal 0.5%/side fee** when live returns: build the pump
   buy/sell instructions locally (curve math is already in the codebase);
   that's ~1%/round-trip back, the single cheapest edge improvement
   available.
5. **Re-aim the product at the trade the data supports:** dip-buying
   survivors is the only breakeven-at-our-latency family — it has slower
   dynamics, no sniper competition, and its losses aren't latency-driven.
   With feed fixed + PumpPortal fee removed (+1%/trip) it plausibly goes
   positive. Prototype: `scripts/analysis/` dip_walk config
   `trail15_sl25` (n=537/day, −0.03%/trade before those two fixes).
6. **Keep the recorder always-on.** This analysis cost nothing but disk and
   found every problem the last month of live/paper iteration missed. Weekly
   re-runs of `extract_tape.py` + `sweep_exits.py` are the new validation
   loop; the in-app backtester should adopt curve-exact fills + exit latency
   (its current trigger-tick fills reproduce the same +0.83 mirage).
7. If the goal remains the sub-minute momentum trade, the entry ticket is
   infra: gRPC feed + pre-signed sell templates + Jito bundle exits targeting
   same/next-slot inclusion. Decide deliberately — it's a different project
   tier, competing directly with the wallets in
   `wallet_candidates_d1.csv`.

## Reproducing

```
python scripts/analysis/extract_tape.py      # tape → derived tables (~70 s)
python scripts/analysis/analyze_tape.py      # population + entry-horizon baseline
python scripts/analysis/build_dataset.py     # per-token features+outcomes (clean only)
python scripts/analysis/sweep_exits.py       # exit grid × entry subsets
python scripts/analysis/robustness.py        # per-day, latency, refinement grids
```
Ad-hoc tests (latency battery, wallet mining, copy-sim, stall/dip exits) are
in this session's transcript; the dip-buy prototype is worth promoting to a
script when picked up.
