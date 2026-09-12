# Runner-outcome swarm — 2026-09-11

Six read-only agents, one question: **when Krypto Bot flags a launch as a potential
runner, what actually happens afterward — and would a model targeted at forward return
beat the graduation model it ships?** Corpus: the three full firehose days 2026-07-25/26/27
(held-out day 07-27) plus the live 09-10/09-11 tape, which turned out to be full firehose
too (block feed on). Everything is under `E:\data\work\runner-outcome-2026-09-11\`
(`BRIEF-COMMON.md`, one directory per agent with `REPORT.md`, every script and its exact
command). No money moved, no network, the repo was only read by the agents; the fixes
below were made by the coordinator after the adversarial review.

Agents: **labeler** (forward-outcome table with the post-graduation PumpSwap leg),
**flag-eval** (the shipped flag reproduced offline + the live `runner` rows),
**execution** (what a buyer of a flag actually gets), **skew-review** (offline ↔ live
feature skew + the target spec), **model** (the retargeted model, one held-out shot),
**reviewer** (re-derived every headline number and reviewed the fixes).

## The answer in five lines

1. **The flag ranks graduation well and is honest about it, but graduation is not what a
   buyer gets.** Of 873 launches the shipped rule flags at +60 s on 07-27, 18.4 % graduated
   (base 2.1 %) — yet 69 % were at half the flag price five minutes later and the median
   price at 30 min was 0.12×. Live on 09-10/11 (2,633 flags) 11.0 % graduated against the
   17.5 % the notification quoted.
2. **Buying every flag loses money under every exit rule.** 0.1 SOL per flag, bought 5 s
   after it fires, 25 % trailing stop, honest fills: −1.24 SOL per 100 flags (bootstrap
   −1.62…−0.84; ≈ −0.7 after the reviewer's own-impact correction). A −25 % hard stop and a
   60-minute hold are worse. The peak comes a median 17 s after the flag and is a spike: the
   next tick is 13 % below it, five seconds later 46 %.
3. **The loss lives in one population: "mixed" curves.** 76 % of 07-27 flags and 91 % of
   live flags are curves whose reserves do not follow the constant product. Their
   graduation is not a graduation: it seeds a median 0.16 SOL into the PumpSwap pool
   against exactly 84.99 SOL for every classic curve, and mixed graduates held a median
   0.008× of the flag price an hour later. Classic-curve flags are indistinguishable from
   break-even (n = 186).
4. **A forward-return target does not beat the graduation target.** At matched volume on
   07-27 the retargeted primary model (+50 % before −25 % within the hour) scores 32.2 % on
   its own label vs 32.6 % for the shipped flag; none of 46 variants clears the lift bar
   (≥ 3 points and ≥ 1.25×). AUC 0.884 vs 0.880. Selection lands on the same three signals
   every time (net SOL, trades in the last 10 s, regime). Both models hold within ±5 points
   on 09-11.
5. **What was wrong in the app was the plumbing, not the model** — and it is fixed: the
   creator-sell gate was blind after the +15 s decision (20 % of live flags had a creator
   sell inside their own scoring window), the odds tape stopped at 600 trades so the
   hottest launches scored a zero trade rate, the Twitter feature was hard-coded null, a
   sold-out curve was only known from an event the feed drops 13–21 % of the time, and 9 %
   of flags were on curves not quoted in SOL that the builder cannot buy.

## What changed in the app (commits 734fa9c, 54d614e, f855e65, + the review fix)

| change | evidence | where |
|---|---|---|
| Creator-sell detection runs before the decided fast-path, so the "creator sold never flags" gate holds after +15 s | 297 of 1,472 live 60 s flags on 09-11 had a creator sell inside the scoring window | `engine.ts` trade path |
| Odds tape cap 600 → 5,000; hitting it marks the tape truncated and the judge refuses to score it (unknown, never zero) | the 600 cap zeroed `tradesPerSecondLast10s` on 16.5 % of would-be 120 s flags on 07-27 (the ones graduating at 27 %); max trades by 120 s in July 1,931 | `shared/runners.ts ODDS_TAPE_CAP`, `runnerVerdict` |
| `metaTwitter` from the create-time socials fetch (null until resolved) | hard-coded null moved 16.7 % of launches across buckets and shrank the 120 s top-1 bucket 279 → 90 | `engine.ts captureSocials` |
| A creator sell **after** the flag marks the flag (`creatorSoldAt`), logs it, records `runner_creator_sold`, and the Runners row shows "creator sold N s after the flag" | decided 60 s after the flag on curves still open: not-sold 21.6 % graduated vs sold 4.7 % (the hindsight pair 45 % vs 6 % is censored by graduation and is NOT quoted) | `markCreatorSold` |
| Token-side curve progress (`curveProgressTokenPct`, the real completion condition) for the odds judge and the flag, labelled "% of supply sold"; the sold-out token floor marks a launch complete for the judge | SOL-side progress read 0 % on 70 % of 07-27 flags and 100 % on 2 %; the complete event and the floor coincided on 100 % of 2,266 July graduations | `curve.ts` |
| A curve with zero SOL reserves is never scored | 91 of 1,014 07-27 flags (9 %) were such curves: one creator behind 54, every SOL feature 0, no rug rule can fire, `txBuilder` refuses them | `runnerVerdict nonSolQuote` |
| The flag carries its regime; a mixed flag says so on the row and in the notification | reviewer I1: the loss-carrying population was untouched by the first three commits | `RunnerFlag.regime`, `regimeLine` |
| The 60 s flag prints the measured forward line (18 in 100 graduated, 11 live · 33 in 100 reached +50 % before −25 % · 25 in 100 beat break-even on a 25 % trail · 39 in 100 had no trade at 10 min) | model agent's recommendation; numbers re-derived by the reviewer (r1) | `FLAG_FORWARD_LINE` |

**Reverted after review (reviewer H1/M1/L2).** The first token-side commit also switched
`flow.curveProgressPct`, which feeds the entry gates (defaults 4–22 % were SOL-side),
the score's timing band, user rules, alerts, the backtest history and the tape's
`curvePct` — a silent strategy rescale. Those read SOL-side again; token-side is confined
to the judge and the flag. The creator "dump" record also went back to its old scope
(inside the evaluation or while held) so repeat creators are not re-scored.

**Left open (documented, not fixed):** the floor path sets `curveComplete` only — phase,
creator completion count and the `complete` record still wait for the event (reviewer L3);
the Token page's curve % stays SOL-side while the flag is token-side, labelled differently
(M2); verdict reasons are not recorded and the `runner` row carries no feature vector
(skew-review C.7); `curveMixed` is computed on the reserves at the judge rather than over
the window's trades — reproduced the recorded bucket on 1,694 of 1,695 live flags, so
accepted.

## Measured facts worth keeping

- **Fill model verified, not assumed** (2.58 M trades): tokens received equal constant
  product on the pre-trade reserves in every regime (p10 = p50 = p90 = 1.000); the tape's
  `sol` is fee-exclusive. What differs on mixed curves is what happens to `vSol` after a
  trade (buys add ≈ 2.7× the SOL in, sells remove ≈ 5.5× the SOL out).
- **Instant graduations are 33.8 % of all graduations** (767 / 2,266 inside the create
  transaction), not the ≈ 5 % the launchset README says. No universe in this swarm is
  touched (all exclude graduated-by-W), but the README is wrong.
- **The feed drop is 21 % on 09-11** (median, n = 1,358 `feed_health` rows) vs 13.5 % in
  July; every count is a floor; the 07-27 quantile thresholds shipped as absolutes make the
  "top 1 %" bucket 0.37 % of 09-11 launches.
- **The notification cap hides most flags:** 43.5 flags/hour median on 07-27, 72/hour
  live, against a default cap of 12/hour.
- **Latency is the first cut:** 5 s after a flag 40 % of flagged launches are already
  ≥ 10 % below the flag price (base 5 %); at 30 s, 59 %.
- **The one positive money line** is classic-regime-only and post-hoc: the shipped 60 s
  flags restricted to classic curves mark +0.7 SOL/100 on the labeler's path (which
  includes the AMM leg) after the execution haircut, n = 129, P(mean > 1) = 0.71, median
  < 1 — and it does **not** reproduce on the 09-11 live flags with curve-only labels
  (classic n = 126: −0.98 SOL/100 after the haircut, reviewer r11). The means live in the
  graduates' AMM leg, which no September decode exists for yet. A hypothesis for a
  pre-registered re-check with a 09-11 AMM decode, not a signal.

## What the next model should do (skew-review Part C, amended by the results)

Do **not** replace the graduation model with a forward-return model — the test says it
buys nothing. Instead:

1. **Split by regime first.** The regime is the strongest single fact about a flag. Show
   classic and mixed as different things (done for the label; the bucket rates themselves
   are still pooled — the model agent's per-regime buckets are in
   `model\forward-model.json`, keys `…|regime`).
2. **Self-audit live.** Record `runner_skip` with the verdict reason, put the feature
   vector and the label horizon on the `runner` row, and write `runner_outcome` rows at
   +10/+30/+60 min from the tape so the app can print its own realised rates instead of
   the 07-27 ones. Schemas are in `skew-review\REPORT.md` C.7.
3. **Re-measure on a day with the fixes in.** The 09-10/11 flags were produced by the
   broken gate and the 600 cap; the honest line on the flag should move to the first full
   day recorded after this commit.
4. **If anything is retargeted, pre-register it:** classic-only, `exit_trail25_60m` as the
   money line, `hit_1p5x_before_0p75_60m` as the label, fit 07-25+26, one shot on the new
   day, lift bar unchanged (≥ 3 points, ≥ 1.25×, CI excluding 0).

## Reproduction

Every table in every report has its script and command beside it. Key artefacts:
`labeler\forward_outcomes.parquet` (147,780 rows × 56 labels incl. `mig_sol`, built in
283 s / 1.06 GB peak; PumpSwap decoder port validated field-for-field against
`test/.ammdecoder.mjs`), `flag-eval\flagged_0727.parquet` (the shipped flag per launch),
`execution\03_sim_2026-07-27_app.parquet` (per-flag simulated round trips),
`model\forward-model.json` (odds-model.json schema, 16 model keys, golden rows),
`reviewer\r1…r10_*.json` (independent re-derivations).
