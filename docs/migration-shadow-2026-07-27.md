# Migration-block re-validation + forward shadow — 2026-07-27

The 07-25 scoping (docs/migration-block-scope-2026-07-25.md) killed the
migration-block strategy on ONE day of tape. Three days now exist
(E:\data\2026-07-25/26/27.jsonl, ~30 GB; 07-27 partial). This work re-ran the
four decisive tables on all three days
(`scripts/analysis/migration_revalidate.mjs`, reproduces the 07-25 doc
numbers exactly — pos-1 +0.2177 vs +0.2170, fast bucket n=370 / +29.90% /
95.9% win) and built the strategy as a live shadow instrument
(`electron/engine/migShadow.ts`).

## The kill's core logic survives all three days

**Reactive entry after the migration is negative in every cell on every
day.** 5 SOL, entries +1/+5/+15 s, holds 5/30/60 s, net of the 4.5% floor:
54 configuration-days, zero positive with any consistency (best isolated
cell −0.08%, most −2% to −10%). Anyone who can only react loses. Also stable:
positions ≥3 into the pool are negative on all days, capped or not.

## But the prize at position 1 exploded — the regime moved

Position-1, 5 SOL, 5 s hold, by 95%-crossing lead time (medians):

| day | fast <400ms n | fast median | fast win | mid 400ms–2s n | mid median | mid win |
|---|---|---|---|---|---|---|
| 07-25 | 370 | **+29.9%** | 95.9% | 89 | +4.77% | 77.5% |
| 07-26 | 252 | **+9,047%** | 94.4% | 46 | +4.55% | 60.9% |
| 07-27* | 213 | **+1,307%** | 95.8% | 57 | +6.47% | 57.9% |

The fast-bucket medians are replay arithmetic and at that scale the
"others trade the same notional around us" assumption is fiction — read them
as direction, not size. The direction is confirmed by the raw tape
(no simulated insertion): the median fast-crossing pool moved **1.39×** in
its first 5 s on 07-25 but **194×** on 07-26, and the median largest single
buy in the first 5 s went **12 SOL → 871 SOL**. The 1,935-SOL block-0 nuke
that was the right tail on 07-25 became the *typical* fast migration by
07-26. Fewer distinct actors (contention 67.8% → 58.7%), far bigger size:
the incumbents consolidated and scaled ~70×.

Uncapped position-1 economics across *all* migrations meanwhile degraded
+4.35% → +1.74% → −0.20%: everything outside the fast bucket got worse,
consistent with snipers extracting more of the value.

## What is day-robust and addressable, and what it costs

The two rows that stayed positive on all three days:

- **Mid bucket (400 ms–2 s lead), position 1**: +4.6% / +4.6% / +6.5%,
  ~10–22 SOL/day gross at 5 SOL size. Exactly the 07-25 "~21 SOL/day"
  estimate — it replicates.
- **Position 2 with the 5% slippage cap**: +0.150 / +0.341 / +0.112 median
  per fill, 63–77% fill rate.

Requirements unchanged: same-block or next-block bundle landing (Jito
top-of-block) against blocks that are ~60–68% contested, plus ~50–100 SOL
working capital, before tips. The tip auction remains unmeasured and is
still the number that decides it — now against incumbents throwing 870 SOL
per event, who can afford tips we cannot.

## The forward instrument (built, on by default)

`electron/engine/migShadow.ts` — shadow-only, never signs or sends. Every
decoded PumpSwap migration opens a paper 5 SOL position in three independent
arrival lanes:

- `block0` — lands with the migration, before any observed trade: the
  unreachable position-1 reference (what the incumbents get).
- `react400` — lands 400 ms after we *observe* the migration: the best a
  reactive sender with top-of-block priority could do.
- `react800` — conservative reactive landing.

Honest semantics throughout: fills at the pool state after every observed
trade that arrived before the lane's landing time (arrival position is
recorded), 5% slippage cap converts lost races into recorded free aborts,
1.1%/side fees, 5 s hold, sells booked at the hold-deadline state, quiet
pools swept — never booked on hope. Records `mig_signal` (with 95%-crossing
`leadMs`) and per-lane `mig_exit`; gated by settings `shadowMigration`;
summarized per-lane in `scripts/daily-report.mjs` (MIGRATION SHADOW section)
and the 5-minute console rollup.

What it will answer with a week of forward data, per lane and lead bucket:
how often the reactive lanes land ≤ position 2, what the cap's abort rate
costs, and whether the mid-bucket edge survives measured from OUR feed
timestamps rather than replay assumptions.

## Verdict

Unchanged from 07-25 in substance, now three-day-validated instead of
one-day: **do not build the live executor or the predictor.** The reachable
version loses every day; the profitable version needs block-0 landing
against incumbents who scaled 70× while we watched. Decision now rests on
the forward shadow numbers — if `react400` fills at position ≤2 with
positive P&L for a sustained stretch, the tip-auction experiment becomes
worth costing; nothing before that.

## Notes for future runs

- `migration_revalidate.mjs` fast bucket includes negative leads (migration
  event received before the ≥95% curve tick — same-instant crossings,
  out-of-order delivery). Excluding them silently moves the most explosive
  ~70 migrations/day into "no crossing" and understates the fast bucket 3×.
- Streaming a day file: never store a `line.slice()` — a stored slice is a
  V8 SlicedString pinning its 4 MB parent chunk (OOM at any heap size).
  Store `Buffer.from(s).toString()` copies, or hash like the originals.
- Constant-product replay drifts off reported reserves (median gap by +5 s:
  ~5% on 07-25, ~19% on 07-26) — capture gaps plus the unexplained per-pool
  quote-reserve constant (amm-decoder doc). Fine for sign, shaky for size.
