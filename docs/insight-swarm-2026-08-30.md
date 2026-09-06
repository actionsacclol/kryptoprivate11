# Insight swarm — 2026-08-30

Seven agents, one question: what should Krypt Terminal show to help a manual trader find launches with a real chance and avoid rugs, and what does the evidence actually support?

Inputs: 73,890 pump.fun launches from three full tape days (E:\data\work\launchset-2026-08-30, built by `scripts/analysis/build_launchset_2026_08_30.py`), live measurements of every feed option and every external rug source, a survey of ten competitor terminals against the 2025–26 literature, and an inventory of what the app computes today. Detailed reports: `docs/runner-odds-2026-08-30.md`, `docs/rug-filter-2026-08-30.md`, the competitor page (claude.ai/code/artifact/0d3eb531-7d07-4a43-9129-a693baf0ed68), and the memory notes `pumpportal-router`, `pump-event-format-drift`.

## The five findings that decide the design

1. **Our current security thresholds are anti-predictive.** On the held-out day, every supply-share check — dev % (≤2/≥10), top-10 (≤25/≥50), bundled % (≤5/≥20), sniper % (≤8/≥25) — has lift < 1 for "dead or dumped". `ANY FAIL` removes 16 % of bad launches while hiding **57 % of graduations** (339/591). Launches with bundles, snipers and concentrated buyers are the ones somebody paid attention to. Re-tuning cannot rescue them: no threshold on these features beats the base rate at a 10 % false-positive budget.

2. **What separates dead from alive costs SOL.** Five inspectable rules chosen on two days and scored once on the third: R1 one buy ≥ 50 % of all SOL bought · R2 sells/buys ≥ 1.5 · R3 creator sold and curve < 2 % · R4 ≤ 2 buyers with ≥ 3 SOL · R5 creator ≥ 30 launches, 0 graduations. At a 10 % budget (R1–R4) they remove **70 % of dead launches while hiding 9.6 % of graduations**; P(graduate | flagged) = 0.3 %. The residual is still 77 % bad — the filter removes launches nobody bought, it does not make the feed safe. Concentration (top-3 ≥ 25 %, bundle ≥ 40 %) predicts *volatility*: 63–75 % dumped **and** 20–22 % graduated (3× the population rate). Show it, never hide on it.

3. **Graduation is rankable and day-robust; "runner" odds must be split by curve regime.** A 4–6-feature logistic model (trades/s in the last 10 s, buys, creator share, net SOL, unique sellers, creator sold) fit on 07-25/26 scores AUC 0.915 at +60 s and 0.940 at +120 s on 07-27, within ±0.01 of train. Top 5 % at +60 s: **17 % graduate vs 2.1 % base (8×, n = 1,397)**, 40 % recall; bottom half: < 0.3 % on every label. Multiples-of-entry are dominated by the `mixed` curve regime (10.6 % reach 3× vs 1.5 % on classic curves); the global top-5 % for ≥ 3× is 96 % mixed-curve, so a classic-curve buyer shown "24 %" would be misled by 2–3×. "2× in 5 minutes" at +30/60 s is a null result (best bucket 6–8 %, over-predicted). Calibration is good to ~20 % predicted and over-confident above — so ship bucketed *observed* rates with n and base, never the model probability.

4. **The live pump feed is alive, not dead.** Pump emits both `emit!` and `emit_cpi!` today: 47/47 sampled trades carry the TradeEvent in both places and the `logsSubscribe` pool decodes 99.9 % at −24 ms vs the processed head. The "0 trades" was the tx-template learner. The risk is the day `emit!` goes; the only free CPI-capable path is publicnode `blockSubscribe` (+196 ms p50, 99.5 % coverage, single provider). Helius `transactionSubscribe` is refused on the free plan; gRPC has no Windows client binary; PumpPortal trades need a funded key.

5. **External sources that earn their place (tested live, keyless):** RugCheck (covers 1-minute-old curves; transfer-cluster insider networks and a "creator history of rugged tokens" flag we cannot compute; keyless top-20 holders), Jupiter Shield + `audit.devMints/devMigrations` (cross-launchpad creator record; `NOT_SELLABLE`), DexScreener `orders/v1` (dex-paid with timestamp, CTO history). Skip GoPlus (down; logo + no-commercial clause), Bubblemaps/Solscan/SolanaFM (paid or down), ScamSniffer/SolRPDS/"RED-COHORT" (0 Solana addresses / no deployer column / does not exist).

What the competition shows (dev %, snipers %, bundlers %, top-10, holders, socials, dex-paid) is exactly the set the tape says is decoration or worse. Nobody publishes a lift. The evidence-backed set is small: capital efficiency (SOL actually left in the curve), who the block-0 buyers were funded by, bundle-adjusted concentration as volatility, dev buy *size*, prior creator *completions*. Holder counts are gameable (+16 % buyers at zero SOL inflow); KOL/"smart" wallets are anti-predictive in our tape (0.737× at 60 s); socials are conflicting-to-anti.

## Design

**Principle:** every number a user sees is an observed rate on a named reference set, with n and the base rate beside it, dated, and it goes to an em dash when its inputs are unknown. No per-token probability. No "this will run". The negative call (bottom half, the R1–R4 flags) is the most reliable thing we have and is what saves people money; the positive call is a ranking, shown as odds buckets.

### A. Rug filter (Discover + token page)

Replace the supply-share FAIL/WARN checks as hide criteria with R1–R5 (R5 needs creator history — pump.fun `?creator=` + Jupiter `devMints`). Each flag renders with its measured line, e.g.:
- "One wallet's buy is ≥ 50 % of all SOL bought — 90 % dead or dumped, 0.2 % graduated (n = 12,844)"
- "Only one buyer in the first 60 s — 93 % dead in 10 min, 0 of 591 graduations (n = 7,524)"
- "Creator has sold and the curve is < 2 % filled — 93 % dead or dumped, 0.3 % graduated (n = 9,163)"
- "Creator: ≥ 30 launches, none graduated — 93 % dead or dumped, 0.5 % graduated (n = 6,117)"

Discover "hide flagged" is on by default with the 10 % budget (R1–R4) and the trade-off stated in the filter bar ("hides ~70 % of dead launches and ~1 in 10 future graduations"). Concentration rows (top-3, bundle, sniper) move to a **volatility** row with both numbers ("top-3 hold ≥ 25 %: 75 % dumped · 22 % graduated") and are never hide criteria. Socials, dex-paid, KOL buys go to a "descriptive — no measured edge" row and out of every score. RugCheck creator-rugs, insider-network size, Jupiter `NOT_SELLABLE`, `devMints` join the Security panel as new checks with honest silence.

### B. Graduation odds (New column badge + token page line)

At +60 s and +120 s after create, the bucket of the launch under the shipped model, shown as the observed line for that bucket ("Top 1–5 % · about 17 in 100 like this graduated · base 2 in 100 · n = 1,117"), with the curve-regime line ("classic curve" / "mixed curve") and the window. Two data paths, same features:
- **Cold** (Discover rows, any user, no scanner): the swap-api trades seek from create (first ~100 trades) + the curve account + creator wallet — every +60 s feature is computable without the live tape (rug report §live computability).
- **Live** (scanner running): the engine's per-token flow already accumulates the same inputs; add the missing ones (trades/s last 10 s, unique sellers, largest-buy fraction, creator share, k-consistency).
- The model ships as a dated static artefact: per-feature train percentiles + coefficients + bucket table + footer text, signed like the fee-integrity blob. No 2×-in-5-min line. Score null → no badge.

### C. Feed insurance (engine)

Keep the racing `logsSubscribe` pool as primary. Add a `BlockFeedSocket` on publicnode `blockSubscribe` (confirmed, base64, pump + pAMM) that decodes emit_cpi inner instructions and enters the same signature dedupe — it loses every race today and takes over the day the logs go quiet. Per-mint priority feed: on a pump Buy/Sell log with no decodable trade, `getTransaction(confirmed)` on Helius (p50 +101 ms), batched, never for the firehose. Prefer CPI, never combine (the transition double-emits). Fix `heliusBudget.billFeed` to bytes (2 credits / 0.1 MB). A watchdog logs once when the block path becomes the only source.

### D. Housekeeping the audits found

Honest-null violations: holder `pct` 0 when supply unknown; `?? 0` wallet counts in check text; `emptyFlow()` rendering "0 buyers / 0.00 SOL" for unobserved tokens; socials scored `fail` when no provider answered; Trader Scan `holdingSol = 0` on null price. `computeScore` weights are hand-picked and the 07-19 refit does not replicate — retire it in favour of B, or keep it labelled "heuristic, no measured hit rate". Stale filter-bar footnote about bundle/sniper being live-only.

## Plan

| phase | scope | days | needs |
|---|---|---|---|
| 1 | Rug filter A: R1–R5 with measured wording, concentration → volatility row, demote socials/KOL/dex-paid, RugCheck + Jupiter Shield/devMints + DexScreener orders as security checks, honest-null fixes (D) | 2 | swap-api seek + creator endpoints (exist) |
| 2 | Graduation-odds badge B: cold path first (Discover New column, token page), then live path; shipped model artefact + footer; regime line | 3 | phase 1 feature code; nothing new externally |
| 3 | Feed insurance C: block socket, per-mint fill, byte billing, watchdog | 2 | publicnode WSS (free) |
| 4 | Re-measure on the current regime: record one week with the recorder (2 GB cap → raise for the week), rebuild the launchset, re-fit, re-check calibration and the mixed-curve question (mechanism vs feed artefact); then dev-sell watch, fresh-wallet share and funding clusters on block-0 buyers (RugCheck insider graph + our funding graph) | 3 + a week of tape | recorder on |

Order matters: phase 1 is pure downside protection and every number in it is already measured; phase 2 is the upside and reuses phase 1's feature code; phase 3 is insurance that costs nothing while logs carry events; phase 4 is what keeps the numbers honest after the July regime drifts.

## What not to build

- Anything that sells a trade signal. The strategy swarms (07-21, 07-24, 08-15) killed every automated entry on a returns ceiling; nothing here changes that. These are odds for a human, not an entry rule.
- A holder-count or buyer-count headline (gameable at zero cost).
- KOL / smart-money copy signals (anti-predictive), socials as a positive, a composite "rug score" with unexplained weights.
- gRPC or paid feeds as a requirement; the free path covers 99.9 % today.
