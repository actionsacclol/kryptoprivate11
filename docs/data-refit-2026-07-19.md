# Strategy re-fit on 150 real round-trips (2026-07-19)

Analyzed all recorded paper trades (150 closed round-trips, up from the 133 the
first re-fit used) plus the first live session. The findings sharpened the same
contrarian thesis and pointed at one dominant lever.

## What the data said

**Exits are where the money is decided:**

| Exit reason | n | win% | total PnL | avg |
|---|---|---|---|---|
| flow_reversal | 84 | 50% | +0.7284 | +0.00867 |
| creator_sell | 59 | 32% | **−0.2572** | −0.00436 |
| trailing_stop | 4 | 100% | +0.1241 | +0.03101 |
| stop_loss | 2 | 0% | −0.0529 | −0.02644 |

`creator_sell` exits are the entire loss center — we bleed specifically when a
creator dumps on us. Flow-reversal and trailing exits are net positive.

**Every top winner entered with a perfectly clean book** — `sells==0` and
`sellVol==0`, 8 of the top 8, buyers 8–10, curve 10–20%.

**The gate backtest (monotonic, mechanism-backed, low overfit risk):**

| Gate | n | win% | total PnL | avg | creator-dumps |
|---|---|---|---|---|---|
| current (maxSells=1) | 150 | 43.3% | +0.5414 | +0.00361 | 59 |
| maxSells=0 | 112 | 47.3% | +0.7439 | +0.00664 | 32 |
| + buyers≤11 | 104 | 48.1% | +0.8146 | +0.00783 | 26 |
| + inflow≤18 | 86 | 51.2% | **+0.8318** | +0.00967 | **18** |

Requiring a completely clean book at entry removed 27 creator-dump losers worth
−0.16 SOL. The crowd/inflow caps compounded it.

## Changes applied (defaults)

- `maxSellsInWindow`: 1 → **0** (the dominant lever — any early sell = skip)
- `maxSellVolumeSol`: 0.6 → 0.4
- `maxUniqueBuyers`: 14 → **11**
- `maxNetInflowSol`: 22 → **18**

In-sample this lifts win rate 43%→51%, total PnL +0.54→+0.83 SOL, and cuts
creator-dump losers from 59 to 18. **Caveat:** in-sample on 150 trades — strong
evidence, not proof. Each gate is mechanistically justified and independently
improves, so it is unlikely to be curve-fit, but forward validation on the
recorder is the real test. Every threshold stays a tunable knob.

## Not changed (and why)

- **Scorer weights** — the composite score still barely separates winners from
  losers (60.8 vs 59.8); the *gates* do the real work. Adding scorer complexity
  would risk overfit for little gain.
- **Exit logic** — flow-reversal exits net positive and mostly bail near
  breakeven (median +0.0002); working as intended. The creator-sell loss is an
  *entry* problem (avoid dumpy creators), now addressed by the clean-book gate.
