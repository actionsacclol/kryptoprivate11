# Strategy research swarm — 2026-07-21

13 agents over the full 3-day tape (68,649 tokens, 6.23M ticks, 1h window,
42,578 clean mints): 1 prep, 8 strategy families, 3 adversarial verifiers,
1 synthesis. ~905k tokens, 25 minutes. Full structured output:
`…scratchpad/swarm/` (per-family scripts) and the workflow task output.
Derived long-window tables: `D:\memedata\derived\long\`.

## Bottom line

**No deployable edge found.** All three strategies that reached adversarial
verification were refuted with high confidence — not for coding errors (all
three verifiers reproduced the researchers' numbers exactly), but because
their profit lived in **unrealizable graduation-tick sells**: positions held
when the curve completes were credited the completion price, when in reality
they migrate to the AMM still holding.

## The big correction: dip-buy survivors are DEAD

The family we've been nursing since the first tape analysis — including
yesterday's "stable gross-positive slices" — is confirmed dead with root
cause:

- The post-confirm price path itself decays (median multiple 0.969 @60s,
  0.906 @120s, 0.594 @30min). The 15% bounce-confirm **buys the top of a
  dead-cat bounce**, with mean +1.87% trigger-to-fill entry slip on top.
- All 85 configs negative in both halves and all 3 days. Pre-registered
  slice: −0.00291/trade. Broad baseline: −0.00314. Best pocket
  (no-creator-sell): −0.00167 — still loses 1.3% gross. All 27 exit matrices
  negative.
- Yesterday's +2–5% gross slices were **v1 fill-at-trigger optimism +
  in-sample slice selection**; honestly re-simulated they are gross 0.94–0.97.
- Cross-check PASSED: live v1 records (−0.00224) reconcile with replay under
  v1 fill semantics — the simulator is calibrated to reality.

Do not retest without a fundamentally different confirm mechanism.

## What survived (nothing verified — shadow-lab hypotheses only)

1. **grad_scalp_70_gated** (+0.00123/trade, n=105, best-of-484, in-sample):
   70% curve cross + no creator sell + ≥20 buys/30s, TP 1.2×/SL −20%.
   Suspect for the graduation-tick pathology — the forward test must show
   TP exits (not graduations) carrying the PnL.
2. **postpeak_30_60m** (+0.00059/trade, n=150): age 30–60min, vSol 55–80,
   drawdown 25–50%, TP 1.6×/SL −35%/60s. The ONLY cell of 95 in the
   age×curve×drawdown map whose raw drift (+3.6%/60s) beats the ~4% cost
   floor; eod contamination 0.7% (clean). **The most interesting lever in
   the swarm: at 0.25–0.5 SOL size the fixed overhead amortizes and analytic
   scaling flips this clearly positive — unverified, needs protocol-grade
   confirmation.**
3. **creator_recovery** (−0.00099/trade, gross 1.0003, n=231): bid-confirmed
   absorption after a creator dump on mature liquid tokens. Signal exactly
   pays the fees. Runs as a regime-persistence test; kill if a week is net<0.

Plus two instrumentation probes: **secondleg_grad_probe** (41% of entries
graduate — records what graduation rides actually do) and the dormant
**grad60+socials=0 retest** (blocked until metadata spans ≥2 weeks, ~08-04).

## Cross-cutting laws (bind all future work)

- **The 4% cost floor is the boss**: 2×1% pump fee + 2% fixed overhead at
  0.05 size + slippage. Sizing to 0.25–0.5 SOL halves the hurdle — the
  single most promising untested lever.
- **Graduation-tick / tape-end closes are the #1 backtest poison.** A
  position held at graduation is UNRESOLVED, not a win. Highest-value infra:
  capture post-migration PumpSwap tape (converts two refuted strategies into
  testable ones).
- **Honest 800ms fills both sides, always**: entry-at-trigger optimism
  inflates results +1.9% (dips) to +3.5% (breakout chases).
- **Hard avoid zones** (n=2,466, most solid result of the swarm): age 45s–2m
  at vSol 40–55 (−0.0055 to −0.0071/trade); vSol 30–34 anywhere (cost bleed);
  fresh near-graduation (age<2m, vSol 80+ — 64% win, negative expectancy).
- **Risk filters that are real but never flip sign alone**: creator-hasn't-
  sold gate (cuts loss 25–40%); exclude serial creators ≥3 launches and
  prior-dumpers (most robust identity effect, t≈3.7). Cosmetic name/symbol
  features are noise — never retest.
- **Stops gap at 800ms**: a −35% stop fills at mean 0.44× (p10 0.12×). Model
  loss on fill price, not stop price.
- **Time-of-day modulates, never rescues** (23–01 UTC ~4–5pp better than
  16–19 UTC; 0/2,887 overlay configs passed).
- **Concentration check mandatory**: every refuted strategy had median<0
  with top-5 mints carrying 80%+ of profit.
- **Smart-wallet copying is dead at all ages** (fresh −0.00457, aged
  −0.00312): wallet skill is real and persistent (69% repeat profitable,
  +8,354 SOL) but post-buy drift is negative before costs — no exit policy
  can rescue it. "Aged-specialist" wallets are p&d insiders (following them:
  gross 0.448) — candidate INVERTED avoid/exit signal.
- ~4,000 configs swept; ZERO passed the full claim bar (n≥150, ≥60 mints,
  net>0 both halves AND all days). Everything deploys through shadow
  forward-testing first.

## Shipped (same day)

- **stratLab.ts v2**: full swarm-spec language — zone/runner/creatorRecovery/
  breakout/dip families, TP + conditional time-stop + creator-sell exits +
  trail arming, oncePerMint/cooldowns, and graduation-as-unresolved
  instrumentation (`graduated` exits tagged `unresolved:true`, excluded from
  realized PnL). The four active specs above run in tandem; records tagged
  `strat_signal`/`strat_exit` per strategy.
- dipShadow v2 stays ON as the calibration anchor (its honest forward
  records are what validated the whole simulator against reality).

## Next build order

1. Forward-run the lab ≥1 week; evaluate with the concentration + stability
   protocol. For grad_scalp_70: check whether TP exits or graduations carry
   the PnL.
2. **PumpSwap post-migration capture** — the highest-value infra item.
3. Size-scaling experiment on postpeak_30_60m (0.25 SOL arm) once its 0.05
   forward baseline exists.
4. ~2026-08-04: activate the socials=0 graduation retest (needs a sync
   socials cache in metadata.ts).
