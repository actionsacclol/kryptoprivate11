# Strategy research swarm — 2026-07-24

9 agents (8 finders + synthesis) over FWD (2026-07-22..24, out-of-sample;
07-23 partial tape, 07-24 partial day) with mandatory LONG (07-19..21)
replay for every candidate. ~7,500 distinct configs swept across the live
v1 family, the grad_scalp runner family, exits, time-of-day/regime gates,
specialist-wallet overlays, creator-identity graphs, cost models, and five
brand-new microstructure families. Scripts in
`…scratchpad/` (prefixes a1–a8); data `D:\memedata\derived\{fwd,long}\`.

## Bottom line

**Still no deployable edge — and it is now proven that the live bot loses
by strategy design, not by execution.** Zero of ~7,500 configs met the
promising bar (n≥100, ≥50 mints, FWD net>0 local-build, LONG net≥0, top5
≤60%). Nothing reached adversarial verification because nothing claimed
survival. The three headline facts:

1. **The live v1 config is negative-EV with PERFECT landing.** A replay
   validated against the engine's own decisions (67/68 = 99% overlap)
   nets **−0.252 SOL over 3 FWD days at the real 0.03 size** (−0.491 on
   LONG), win rate 12.9%, negative on all 6 days of both datasets.
   Expected live bleed: **~−0.08 SOL/day** even now that the multi-lane
   sender lands everything. The recent losses are the strategy's EV.
2. **The gross drift is negative at the entry.** At 0.25 size (overhead
   amortized to 0.8%) v1 still loses 7.1% of stake per trade — the gated
   entries carry ~−4% adverse price drift before any cost. 87% of
   positions die by flow_reversal/creator_sell exits that sell the bottom.
   No one-knob change (28 OAT variants) flips the sign.
3. **The runner family (grad_scalp) is closed.** All 2,430 FWD grid cells
   with n≥100 are net-negative (best −0.985/278 trades); the +3% gross
   drift lives only in a 41-trade creator-clean sliver, and the size-
   crossover math has **no real root** — no position size ever monetizes
   it (see cost model below).

## Per-agent findings

### A1 live-gates-replay — the v1 config kills itself
- Faithful engine.ts replay, 99% overlap with recorded `enter` events;
  score residual mode exactly 39.0 as modeled.
- FWD n=70 @0.03: **−0.2518 local / −0.2724 relayer**, win 12.9%,
  −12% of stake per trade. LONG n=109: −0.4909/−0.5224. All 6 days red.
- Exit decomposition: flow_reversal 36 trades −0.150, creator_sell 25
  −0.120, only 3 TP1 wins (+0.057). The TP1/TP2/trail ladder touches ~4%
  of trades — exit tuning is irrelevant.
- 28 one-at-a-time variants: ALL negative on FWD and LONG. Best
  (entryCurveMinPct 4→0) −0.00292/trade vs base −0.0036.
- **Code bugs found:** `maxSellVolumeSol` is dead code while
  `maxSellsInWindow=0` (the 0.4 "refit" is bit-identical no-op), and
  `maxTopBuyerShare` is in settings but absent from `passesGates` —
  a phantom knob.

### A2 grad-scalp-rescue — 4,860-cell grid, family closed
- curvePct and vSolMin are the SAME variable (curvePct=(vSol−30)/85);
  the nominal 12,150 grid collapses to 4,860 distinct configs.
- Every n≥100 config negative (best −0.985, median −2.054). Best config
  replays −0.990 on LONG; 0.25 SOL sizing → −3.035.
- The +3% gross drift claim traces to the creator-clean cell: n=41, mean
  gross 1.0151, top5 41.6% — by the 70% cross ~89% of tokens already had
  a creator sell, so the clean subset can never scale. Allowing creator
  sells (n=365) flips gross NEGATIVE (0.991).
- The only positive cells anywhere: n≤38 single-mint mirages (top5 97%)
  that lose −0.27 on LONG.

### A3 cost-floor — the real cost model (see table below)
- Verified: **the engine never closes ATAs** (zero closeAccount
  instructions in `electron\engine`). Leak = 0.00203 SOL/mint;
  **0.203 SOL already stranded** across 100 live buys 07-19..24. At 0.03
  size that is 6.77% of position per trade — bigger than pump fees.
- v1-family gross drift confirmed negative (−1.5% strict n=12, −7.6%
  relaxed n=50 FWD; −5% LONG): zero-cost execution still loses.
- grad_scalp size-crossover: net%(S) = 3.0 − 2.105(S−0.05) − 2.5 − 0.2/S;
  breakeven quadratic 2.105S² − 0.605S + 0.2 = 0 has **negative
  discriminant — never positive at any size**, peaking ~−0.5%/trade near
  S=0.25. (Impact model 2S/vSol empirically validated at 5.5%/SOL.)

### A4 specialist-inversion — behavioral profile carries no signal
- Aged-specialist buys: +60s median 1.0155 vs matched baseline 1.0169 —
  the prior swarm's 0.448x effect was id-level selection on realized
  outcomes, unreproducible across datasets without persistent wallet ids.
- Exit overlay improves FWD (−0.145→−0.112) but worsens LONG
  (−0.194→−0.207); mechanically it just cuts median hold 17s→3s.
- Entry veto deletes 60–88% of entries, stays negative.
- is_smart watchlist still strongly anti-predictive: n=84, median 0.737x
  @+60s, 0.635x @+300s, 83% underwater at 5min. Never copy-trade it.
- Flag: 90% of grad_scalp triggers are inside the age<2m@vSol80+ avoid
  zone (independently confirmed by A5).

### A5 tod-regime — time-of-day folklore retired
- grad_scalp full set: FWD −0.586/436, LONG −0.250/105. Every n≥60
  window negative. **The 23:00–01:00 UTC "best" hint is refuted** —
  21-24h (−0.118) and 00-03h (−0.245) are the two worst FWD windows.
- Only positive pocket (06-12h, +0.147) is 100% one day's profit and
  −0.017 on LONG. Expected count of such spurious cells at ~40
  comparisons: 1–2. This is that cell.
- Both regime signals (trailing-2h grad count, trailing-2h median 5-min
  return) are negative or sign-flip between datasets. v1 fires ~9x/day —
  time-bucketing it is statistically impossible.

### A6 fresh-hunt-micro — five new families, all dead
- Dead GROSS of costs: buyer-count acceleration (−0.005 to −0.009/trade,
  n≤2,081), sell-absorption (n=5,871, −0.0049), inflow-per-buyer regime
  (n=3,035, −0.0048).
- Creator-recommit: ~breakeven in-sample, −0.351 on held-out 07-24,
  −1.236 LONG. Tick-burst C5: the lone FWD-positive (+0.041/130) was
  negative on its own proposal days and −1.403 on LONG — textbook noise.
- Honest discipline note: configs picked on 07-22/23 only, day 24 + LONG
  untouched until one final run. That protocol is what killed them.

### A7 creator-graph — identity describes, never pays
- 77.5% of FWD tokens have prior-launch creator history; joins are exact.
- **The prior swarm's dumper/serial exclusion (t≈3.7) is INVERTED with
  6-day history**: dumpers lose LESS per trade than the rest (Welch
  t=+1.61 FWD, +1.75 LONG). Retire the exclusion as an edge hypothesis.
- One durable descriptive fact: creators with ≥1 prior clean graduation
  and 0 prior early dumps graduate the next launch at **34.3% FWD /
  29.1% LONG vs 2.66% baseline**. Not monetizable on-curve (~47
  launches/day, value lives post-migration, whitelist configs lose
  −0.37/−0.73) — but it is the strongest identity effect ever measured
  here and a ready-made WATCH tag once PumpSwap tape exists. Beware:
  "has graduated before" alone selects farms (85% early-dumped).
- The one FWD-positive config anywhere in the swarm (grad_scalp ×
  serial≥3 @0.25: +1.079) replayed at **−8.550 on LONG**. Dead.

### A8 exit-engineering — exits are not the lever
- 2,304-config exit grid: best in-sample cell still negative on FWD at
  0.05 (grad_scalp −0.494/419; v1 −0.103/49 and that improvement is an
  unresolved-bag artifact worth −0.272 mark-to-last).
- **Creator-sell exit, flow-reversal exit, and partial exits all reduce
  EV** (partials strictly dominated: −2.062 vs −0.494). The live exit
  stack is measurably the worst part of the v1 policy (−0.332 vs −0.103).
  Reactive protection at 800ms latency systematically sells the bottom.
- Stop-gap recalibration (grad zone): a −35% stop fills at mean **0.525x
  entry** (intended 0.65x; p10 0.30x) — budget ~1.24x the intended stop.
  15s-age entries gap less (~0.92–0.94 fill ratio). Prior 0.44x figure
  was dip-context.
- **Shadow-lab accounting is broken-optimistic**: engine position_close
  sums to −0.005 over 68 positions where honest 800ms replay says −0.332
  (66x rosier). This is why live keeps underperforming the lab.

## Verification outcomes

The verification queue was empty by construction: **zero of the 8 finders
marked any config promising**, so nothing advanced to adversarial kill.
Each finder ran its own FWD-pick/LONG-confirm protocol and every candidate
died there — the four near-misses and their causes of death:

| Candidate | FWD | LONG | Cause of death |
|---|---|---|---|
| grad_scalp × serial≥3 @0.25 (A7) | +1.079 (n=286) | **−8.550** (n=446) | class effect sign-flips (t +1.28 vs −2.22) |
| tick-burst C5 (A6) | +0.041 (n=130) | **−1.403** (n=148) | negative on own proposal days; holdout-day mirage |
| 06-12h UTC window (A5) | +0.147 (n=69) | **−0.017** (n=8) | 1 of ~40 comparisons; 100% one-day profit |
| grad_scalp best-exit @0.25 (A8) | +0.411 | **−7.944** | carried entirely by partial day 07-24 |

Also killed with prejudice: the n=20 curve-80% cell (+0.114 FWD, top5
97.3%, −0.269 LONG) — reported by A2 specifically so nobody resurrects it.

## Updated cost model (supersedes the "4% floor")

Round-trip floor as % of position size:

| Size | (a) today: relayer + no ATA close | (b) local-build + ATA close | (b′) local-build, typ fixed 0.00137 |
|---|---|---|---|
| 0.03 | **16.9%** | 9.2% | 7.1% |
| 0.05 | 11.6% | 6.5% | 5.2% |
| 0.10 | 7.5% | 4.5% | 3.9% |
| 0.25 | 5.1% | 3.3% | 3.1% |
| 0.50 | 4.3% | 2.9% | 2.8% |

What it changes:
- The old "4% cost floor" law understated reality ~3x at live size. At
  0.03 today the bot needs **+16.9% gross per trade to break even**; the
  best gross drift ever measured is +3%.
- Percentage fees alone: 3.5% relayer / 2.5% local — **a +3% drift can
  NEVER be monetized through the relayer at any size**.
- Sizing up is no longer a promising lever in isolation: with curve
  self-impact (~2S/vSol) included, the grad_scalp breakeven has no real
  root. Size amortizes overhead but amplifies whatever the day gives
  (A8: +1.033 on 07-24, −0.622 on 07-22/23 at 0.25).
- The ATA rent line (0.00203/mint, 6.8% of a 0.03 stake) was invisible in
  all prior accounting and exceeds pump fees at live size.

## Build order (max 5)

1. **Turn localTxBuild ON.** Worth 1.0% of size per round trip (0.5%/side
   relayer fee); prerequisite for any strategy since relayer percentage
   fees alone (3.5%) exceed the best gross drift ever measured (+3%).
2. **Append closeAccount to every sell tx + one-off sweep the ~100 open
   ATAs.** Recovers 0.203 SOL immediately; saves 0.00203/mint forever
   (6.8% of stake at 0.03 — the single largest fixed-cost line). Marginal
   cost ~zero (same tx as the sell).
3. **Take v1 out of live trading (shadow-only) and fix its dead knobs.**
   Replay-proven −0.08 SOL/day at 0.03 with perfect landing, 99%
   decision-overlap validation; `maxSellVolumeSol` is dead code and
   `maxTopBuyerShare` is a phantom gate — the config UI is lying about
   what runs.
4. **Fix shadow-lab fill semantics to honest 800ms-next-tick.** The
   shadow books −0.005 where honest replay books −0.332 on identical
   positions (66x optimistic). Until this is fixed, every forward test
   the lab produces is untrustworthy, and it is the cheapest of all
   fixes.
5. **Build the two data assets that could change the answer: PumpSwap
   post-migration tape + persistent cross-day wallet identity in the
   recorder.** The only durable signals found live beyond this tape's
   edge: proven&notdumper creators graduate at 34.3%/29.1% vs 2.7%
   baseline (value accrues post-migration), and specialist-wallet
   information is id-level (dies without cross-day wallet ids, which
   per-dataset int ids cannot provide).

Explicitly NOT on the list: any entry/exit retuning of v1 (28/28 OAT
variants negative), any grad_scalp variant (4,860 cells closed, no-real-
root size math), time-of-day gates, creator-class gates, specialist
overlays, or new microstructure families at this latency (best in-sample
gross +6% inverted out-of-sample; the floor at 0.05 is 6.5%).

## Updated LAWS (bind all future work)

- **Cost floor law REPLACED**: use the table above. Today's live config
  pays 16.9% at 0.03. Local-build + ATA close is the achievable floor.
  A candidate needs gross drift > ~3.4% at 0.25 / ~4.5% at 0.10 (config
  b) before it is worth a shadow slot.
- **Sizing never rescues on its own** (new): curve self-impact ≈ 2S/vSol
  per round trip must be in every size extrapolation; the grad_scalp
  crossover claim is dead by negative discriminant.
- **Reactive protective exits are value-destroying at 800ms** (new):
  creator-sell exits, flow-reversal exits, and partial TPs all reduced EV
  on both datasets. They sell the post-dump low.
- **Stop-gap recalibrated**: grad zone −35% stop realizes mean 0.525x
  (p10 0.30x), i.e. budget 1.24x the intended stop; 15s-age gaps less
  (0.92–0.94 fill ratio). The old 0.44x figure was dip-specific.
- **Creator-identity exclusions RETIRED as edge**: serial≥3/prior-dumper
  effects inverted with 6-day history (t=+1.61/+1.75 wrong direction).
  Keep at most as neutral risk trim. The proven&notdumper graduation
  fact (34%/29% vs 2.7%) is a WATCH tag, not an entry.
- **Time-of-day folklore retired**: 23–01 UTC landed in the two worst
  FWD windows; ±0.3%/trade modulation around a −1.3%/trade mean.
- **Specialist/smart-wallet overlays DEAD without persistent ids**:
  behavioral profiles carry none of the id-level signal; is_smart
  watchlist remains anti-predictive (0.737x @60s) — negative flag only.
- **Avoid-zone contradiction to adjudicate**: 90% of grad_scalp triggers
  sit inside age<2m@vSol80+. Either the zone or the spec is wrong; the
  age≥2m subset is still negative (−0.138 FWD / −0.092 LONG), so the
  zone stands until post-migration data says otherwise.
- Still binding, revalidated this swarm: honest 800ms fills both sides;
  graduation = UNRESOLVED, never an exit; per-day stability + LONG
  replay + top5Share ≤60%; avoid zones; cosmetics are noise.

## Dead ends registry (do not respend)

v1 one-knob retunes (28/28 negative) · grad_scalp entire grid (4,860) ·
exit grids on both families (2,304) · buyer-acceleration · sell-absorption
· inflow-per-buyer · tick-bursts · creator-recommit · specialist exit/veto
overlays · proven-creator whitelist on-curve · dumper/serial exclusions ·
time-of-day and regime gates · TP1/TP2 ladder tweaks · maxSellVolumeSol
refit (bit-identical no-op).
