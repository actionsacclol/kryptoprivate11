# pump-amm decoder — 2026-07-25

Build item #5 of the 07-24 swarm, first half. `electron/engine/ammDecoder.ts`
+ `test/ammdecoder.test.mjs` (wired into `npm test`). Layout learned offline
against the 2026-07-25 tape (9.9M `tape_amm` records) exactly as
`engine.ts:975` intends.

## What decodes

Discriminators are `sha256("event:<Name>")[0..8]`, computed at runtime:

| event | discriminator | count | share of payloads |
|---|---|---|---|
| `SellEvent` | `3e2f370aa503dc2a` | 5,797,107 | 42.1% |
| `BuyEvent` | `67f4521f2cf57777` | 6,082,438 | 35.5% |
| `CompletePumpAmmMigrationEvent` | `bde95db95c94ea94` | 874 | — |
| `CreatePoolEvent` | `b1310cd2a076a774` | 1,798 | known, not decoded |

Buy and Sell are one shape: 14 u64 fields, then 7 pubkeys, then version-varying
trailing fields. The 465 B and 480 B Buy variants differ only by a trailing
string (`"buy"` vs `"buy_exact_quote_in"`), which is past the parsed prefix —
so both decode without special-casing.

## How the layout was proven

Four independent checks, none of which can pass on a wrong layout:

1. **Reserve accounting.** For consecutive trades on one pool, the change in
   `poolBaseReserves` equals the *previous* event's `baseAmount` as an exact
   64-bit quantity — **55,790/55,827 = 99.93%** (misses are capture gaps, not
   mismatches). This also establishes that reserves are **pre-trade**.
2. **Fee arithmetic.** `lpFee == quoteAmount × lpFeeBps / 10⁴` and
   `protocolFee == quoteAmount × protocolFeeBps / 10⁴`, to the rounding unit,
   on every sampled event. Pins six offsets at once.
3. **Cross-event join.** All **874/874** migration events name a `pool` that
   also appears as the `pool` field of a Buy/Sell event; and the first trade on
   a freshly migrated pool reports `poolBaseReserves` exactly equal to that
   migration's `mintAmount` (206,900,000,000,000).
4. **Constant product.** `k = base × quote` across adjacent trades:
   median ratio **1.0000** (p10 0.9986, p90 1.0016).

## Known bias — do not mark positions with `poolPriceSol`

Realized execution runs a median **1.22×** the mid implied by the reported
reserves, in the *same* direction for buys and sells, at trade sizes far too
small for impact (median 0.05% of pool on buys). The migration record shows
the shape of it: it seeds `solAmount` = 85.0 SOL where that pool's first trade
reports `poolQuoteReserves` = 67.4 SOL. The field tracks trade deltas exactly
(0.9998) but sits below the true quote balance by a per-pool constant that is
not yet identified.

Scale is right, though: the migration mid reads 3.26e-7 SOL/token ≈ 326 SOL
fully diluted — the well-known ~$69k pump graduation cap.

`executedPriceSol()` (net lamports ÷ tokens moved) needs no reserve
interpretation and is exact. **Use it for anything that books money.** The
1.22× bias is pinned by a test so a future fix fails loudly instead of
silently changing what positions mark at.

## First honest read on graduations

The 25 `strat_exit` records carrying `unresolved: true` were resolved against
the decoded tape — **25/25 matched to a pool**.

**Every one of the 25 is profitable at the first post-migration trade.**
22/25 are still positive at +60 s. Graduations are systematically the winners,
and they were being dropped from every P&L total.

| strat | booked (finite only) | unresolved @+60s | corrected |
|---|---|---|---|
| `secondleg_grad_probe` | −1.6003 | **+0.8542** | **−0.7461** |
| `grad_scalp_70_gated` | −0.9305 | +0.0225 | −0.9079 |
| **all strats** | **−2.9346** | **+0.8767** | **−2.0579** |

So the shadow lab has been scoring itself ~30% too harshly overall, and
`secondleg_grad_probe` **53%** too harshly. That is a large correction.

**It does not flip the sign.** Fully credited, both strategies still lose.
This confirms the 07-24 bottom line rather than overturning it — but it does
so on honest numbers for the first time.

Exit-timing detail worth keeping: summed across the 25, +60 s (+0.877) beats
the first trade (+0.79) and both beat +300 s, where 8 of 25 have gone negative.
Value decays fast after migration.

## What this retires and what it doesn't

- **Retire** the law *"graduation = UNRESOLVED, never an exit"*. It was a
  data-availability constraint, not a fact about the strategy. Graduation can
  now be marked. The successor rule: mark at `executedPriceSol` of the first
  AMM trade at/after the mark time; never mark from `poolPriceSol`.
- **Still binding**: everything else in the 07-24 registry. Resolving
  graduations improves the level, not the sign, so no dead end reopens on
  this evidence alone.

## Live wiring (done)

`engine.ts:onAmmLogs` still records the raw tape verbatim — it remains the
asset and the wallet-id work needs it — and now also decodes. Migrations
populate a bounded pool→mint map; swaps on a known pool call
`StratLab.onAmmTrade`.

`StratLab` gained a `'migrated'` phase. The completion tick is still never
booked. A graduated position waits, takes its mark from the last trade inside
the +60 s window, and closes on the first trade after it. Pools that never
trade fall back to the old `unresolved: true` record via `sweepMigrated`
(10 min timeout), so nothing is ever booked on hope. Five tests cover it,
including that a stray post-completion curve tick cannot settle a migrated
position.

## A7 re-run: the proven-creator tag

### The descriptive claim replicates

Point-in-time creator history rebuilt from the tape (a launch is classified
using only events strictly before it — no look-ahead from `creators.json`,
whose counts are cumulative):

| class | graduation rate |
|---|---|
| proven (≥1 prior completion, 0 prior dumps) | **93/407 = 22.85%** |
| everyone else | **515/19,166 = 2.69%** |
| *A7 reported* | *34.3% FWD / 29.1% LONG vs 2.66%* |

An **8.5× lift**, independently reproduced on a different day with a stricter
protocol. The effect is real.

### And it is still not monetizable — now we know why

Not "we cannot measure post-migration value" but "the value is real and is
taken inside the migration block."

Sweeping the entry delay over all 863 usable graduations, return measured from
an actually-fillable price:

| entry delay | median +60 s | trimmed mean +60 s |
|---|---|---|
| 0 s (migration block) | +0.9% | **+886.3%** |
| 1 s | −3.2% | −15.4% |
| 5 s | −5.1% | −13.9% |
| 15 s | −4.5% | −9.9% |
| 30 s | −4.0% | −5.7% |
| 60 s | 0.0% | −2.0% |

The entire edge sits at delay 0 and vanishes at 1 s. What lives there is not
retail-reachable: one observed pool took a **single 1,935 SOL buy at +0 ms
that lifted price ~700×** by taking 95% of the base reserves. That trade
chains exactly against the reserves, so it is real, not a decode artifact —
and it is the shape of the whole distribution's right tail.

At a 15 s entry, net of the 4.5% floor (local-build + ATA close @0.10 SOL):

| creator class | n | median +60 s | trimmed | **net** | win |
|---|---|---|---|---|---|
| proven & no dumps | 91 | +1.5% | −5.0% | **−9.5%** | 62% |
| first-ever launch | 308 | +1.6% | −0.9% | **−5.4%** | 63% |
| prior dumper | 169 | −19.9% | −28.5% | **−33.0%** | 32% |
| repeat, no grad/dump | 60 | −38.7% | −38.9% | **−43.4%** | 20% |

Creator history *does* discriminate post-migration performance — the spread
from `first-ever` to `repeat, no grad/dump` is 38 points. **Every class is
still negative net of costs.** The proven tag is not even the best cell.

**Verdict: A7's shelving stands, and the hypothesis is now closed rather than
open.** It was parked pending this tape; the tape says the post-migration
value is consumed by capital we cannot match in the block where it exists.
Keep the tag as a WATCH label, exactly as A7 said. Do not build an entry on it.

Caveat, stated plainly: one 18 h day, 863 graduations, 407 proven-class
launches. The graduation-rate replication is solid at that n; the per-class
return table is directional, and `proven` at n=91 is the thinnest row.

## Next

1. **Persistent cross-day wallet ids** — the other half of build item #5,
   untouched by this work and now the only unbuilt item on the 07-24 list.
2. Re-run the graduation resolution across several days once the live wiring
   has accumulated them, to replace the single-day n=25 in the table above.
3. Nothing else here argues for reopening a dead end.
