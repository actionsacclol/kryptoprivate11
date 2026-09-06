# Pivot research swarm — LP fee farming & directional swing — 2026-08-15

11 agents (5 finders + 5 dedicated adversarial verifiers + 1 completeness critic) over
the question: can this rig pivot from the closed Pump.fun launch-sniping programme to
(a) LP fee farming on established Solana memecoin pairs, or (b) directional swing
trading on established memecoins? **PAPER ONLY — no capital was deployed and no
backtest of either family exists yet.** Areas: F1 lp-economics, F2 lp-adverse-selection,
F3 swing-edges, F4 data-acquisition, F5 infra-reuse. Every finder was independently
re-run by a refuter with authority to invert it; three of five headline claims did
invert. The synthesis stage crashed; this document is assembled from the saved agent
output. Raw per-agent JSON and the five drafted sections live in the session scratchpad
(`…\scratchpad\swarm\`). Numeraire throughout: SOL $75.5, bankroll 50–100 SOL =
**$3,776–$7,552**.

## Bottom line

**Both families are dead, and they die on a ceiling, not on a sign.** The
best-signed construction produced anywhere in five areas — F2's C1, delta-hedged
full-range CPMM LP, ex-FARTCOIN/ex-PUMP, n=525 — is **+3.0%/yr gross = $138–$276/yr,
~1%/yr net = $38–$76/yr** on the whole bankroll; Kamino USDC supply pays **3.5–9%/yr**
and Solana native staking **5.7–7%/yr**, passively, today. That comparison is the single
number that decides the question, it costs one web search, and **not one of the ten
agents computed it**. The sign arguments the five areas actually fought over are
fragile — F2's fee APR moved 2.65% → 7.01% under verification, F1's "proven −3.01%/yr"
became a −0.8 to −8.6%/yr band, F3's 12.9bp/day became +1.66bp/day — but the ceiling
argument holds at *every point* in *every* disputed range: at Q=0.49 the LP business
loses outright, at Q=1.03 it nets ~1%/yr, which loses to a stablecoin deposit. The
pivot's one genuine achievement is that the 07-24 cost floor collapsed 28–560x, and it
buys nothing: LP's loss term is 100–1000x transaction cost, and the swing numerator
collapsed alongside the denominator (+1.66bp/day gross against a 3.0bp maker fee). One
carve-out prevents this from being "stop": **nobody in ten agents measured a single
memecoin perp funding rate**, and Hyperliquid's documented structural funding is
**11.6% APR to shorts** — 10x the business it was supposed to hedge. That is the one
unmeasured number whose plausible upside clears a real hurdle, it costs $0 and one day,
and it is the only thing that should be built next.

## Per-agent findings

### F1 lp-economics — no standalone yield, small negative expectation, wide error bars

Fee income does not cover divergence loss on any of the 15 measured established-memecoin
pools on any defensible sigma. The verifier attacked that direction four ways (fee-band
correction, sampling frequency, benchmark choice, replay on the finder's own data) and
could not flip it. **The magnitude did not survive.** Finder headlined TVL-weighted net
−3.01%/yr across $29.42M of Raydium AMM TVL (weighted fee APR 2.85%, LVR 5.86%, Q=0.49);
the recheck shows that is one point on a curve set by an unjustified sampling choice:
**−8.64%/yr on the hourly sigma the finder itself declared correct, −3.01%/yr on 181d
daily sigma, −0.77%/yr (Q=0.79) on horizon-matched 14d sigma → a corrected range of
−0.8% to −8.6%/yr, best point estimate −1 to −3%/yr.** Delete "proven" and "dead"; the
defensible claim is *no standalone yield here*.

Corrections, by consequence:

- **Q is not venue-invariant.** Invariance to *your* range width inside one pool at one
  fee tier is algebra, not a finding. Across pools of the same asset Q moves ~3x:
  WIF/SOL Raydium (k=1) Q=0.24 vs WIF/SOL Orca 0.04% tier (k=2.29) Q=0.74 — still short
  of 1.0 everywhere. Narrowing is worse than neutral: 526–876 exits/yr at ±2% means
  out-of-range time earning zero fees on already-realised divergence.
- **"LVR=σ²/8 confirmed to 3 s.f." has no empirical content.** Σ[(1+r)/2 − √r] *is* the
  exact per-step divergence loss and σ²/8 is its Taylor expansion; they agree on any
  series, including noise. Reproduced exactly (WIF 3.70/3.70, POPCAT 3.91/3.90,
  FARTCOIN 5.50/5.50, PENGU 4.87/4.86). Downgraded to an identity check.
- **Variance does not scale linearly in time.** The finder compared a 42d hourly file to
  a 181d daily file. On the identical 42d window σ falls monotonically: WIF
  54.4%(1h)→41.1%(24h), POPCAT 55.9→37.6, FARTCOIN 66.3→54.1, PENGU 62.3→40.9. VR(24h/1h)
  median **0.51**; VR(14d/1d) median 0.62 — roughly 2x microstructure inflation. And CPMM
  IL is **path-independent** (endpoint ratio only), so a passive multi-week LP wants
  horizon-matched σ, not hourly. The finder picked the estimator most favourable to its
  own conclusion.
- **Swap costs are ~2x the finder's figure.** FARTCOIN 0.007% round trip is 0.0035%/leg,
  **below Solana's cheapest fee tier (0.01%)** — arithmetically not a fill. Re-running
  jup.py 3x: FARTCOIN 0.0827/0.0902/0.0924%, PENGU 0.0116/0.0168/0.0312%, WIF
  0.3316/0.3316/0.3316% (stable, Raydium→Whirlpool). The cheap unstable names route
  through HumidiFi/Scorch/AlphaQ/Aquifer/BisonFi/Manifest — RFQ principal MMs quoting
  indicatively, and a range-exit rebalance always sells what fell and buys what rose, the
  most toxic flow they see. Use **WIF 0.33% round trip at 2.5 SOL, POPCAT ~0.53%**. Same
  error class as the 07-24 shadow lab booking −0.005 where honest replay booked −0.332.
- **Wrong invisible line.** binArray rent (0.075 SOL/virgin binArray, non-refundable —
  confirmed as a fact) rests on an assumed 15% hit rate; bins near market on years-old
  pools are already initialized, so it is almost certainly far too high *here*. The real
  ATA-rent analogue on established pairs is **0.0616 SOL/position locked rent** (1.23% of
  5 SOL, 0.062% of 100 SOL) which this rig historically never reclaims — cf. 0.203 SOL
  stranded across 100 buys (07-24 A3).

Survived intact: 181d daily sigmas (WIF 53.1%, POPCAT 63.2%, FARTCOIN 79.1%, PENGU 50.8%,
BONK 55.4%, USELESS 120.4%, recomputed to the decimal); the Orca decode (tickSpacing
u16@41, feeRate u16@45, liquidity u128@49, sqrtPrice u128@65) and k = 2L·√p/TVL, k = 1.35
(PENGU) to 7.43 (SOL/FARTCOIN) — caveat, a single instantaneous snapshot of a per-block
quantity; **zero LP emissions** (15 of 2,665 Solana pools carry apyReward>0, none on
established memecoin pairs); DefiLlama carries **zero Meteora pools**; and the most
transferable insight — **gas is immaterial here** (0.00058 SOL = $0.04 per 4-tx
rebalance, 0.012% of a 5 SOL position, against LVR 3.5–18.3%/yr at k=1). *The
sniping-era cost-floor law does not transfer.* Depth capacity is not a constraint either
(100 SOL = 7.2% of the thinnest pool cited) — the verifier checked expecting a kill. The
problem is absolute dollar EV.

Also measured and load-bearing later: log(weekly volume) on log(weekly variance) gives
median **β = 0.45**, so volume scales as **σ^0.90** against LVR's **σ²**, and **Q scales
as σ^−1.10**.

### F2 lp-adverse-selection — family dead at this bankroll, headline arithmetic inverted

LP fee farming on established Solana memecoin pairs is not reachable at 50–100 SOL. That
conclusion survived adversarial verification. **Almost none of the arithmetic the finder
used to reach it did.**

The finder's headline was "capital-weighted fee APR across $1.227B of Raydium+Orca
liquidity is 2.65%/yr, at or below the 3–10%/yr LVR band". The filter replicates exactly
(n=307, TVL $1,226.3M, TVL-weighted apyBase 2.599%) but **63.1% of that TVL — $773.3M
across 83 pools — is parked inert liquidity earning ~0%**: five CC-USDC pools at $486M /
0.01% APR, SLX-USDC $77.5M, MARSCOIN-USDC $58.9M, SSRUB-USDT $20M. Excluding parked pools
(n=224, TVL $452.9M) the capital-weighted apyBase is **7.01%**, apyBase7d 8.87%,
apyMean30d 31.33%. Against the finder's own LVR band that is at or *above* LVR. **The
headline inverts.** The finder also used apyBase — 24h fees × 365 — for the headline
while condemning that exact statistic elsewhere in the same report as "the single-day
mirage this repo already killed twice."

"Fee APR is at or below LVR on **every** pair I measured" is false in the finder's own
table (FARTCOIN 1.38, MEW 1.30, BOME 1.22). Verifier at n=46 pools, trailing 365d:
fee/LVR **median 1.03, mean 2.30, p25 0.51, p75 1.52**. The six named pools verify to the
decimal (MEW 0.71/1.03/2.76, $WIF 1.03/1.54/2.84, POPCAT 2.05/2.20/4.04, WSOL-FARTCOIN
5.35/3.52/5.02, TRUMP-USDC 1.55/1.78/3.79, OLDSLERF 0.01/0.03/0.03) but are a
bottom-quartile selection sold as the universe: full memecoin/SOL universe >$500k TVL,
n=60, apyMean30d **median 6.83%**, p25 3.24%, p75 12.63%, TVL-weighted 10.53%.
*(Adjudicated below: F1's Q wins on provenance; this correction stands as data hygiene
only.)*

Volatilities partly wrong: POPCAT σ²/8 3.1% → **5.67%**; FARTCOIN 6.4% → 7.83%; BONK
3.6% → 4.04%; PUMP 7.18%; MEW 1.87%; WIF 4.0% → 3.94% (holds).

The stated cause of death — "daily sampling is a LOWER bound, true LVR is 1.5–3x" — is
**refuted with a sign error**. Fees scale arbitrage profit *down* from frictionless LVR
(arXiv:2305.14604, the paper the finder cited as corroboration). Under the constant-block-
time closed form (arXiv:2505.05113) with 400ms blocks, 3%/day vol, 25bp pool: γ/σ_b =
39.5, reduction to **~2.9% of frictionless LVR**. True adverse selection sits in **[0.03x,
3x] of σ²/8** — two orders of magnitude of error bar on the single term that decides the
LP question, and it is still unmeasured.

The realized ledger strengthens while its method fails: n=6, median −10% (finder) →
**n=46, median LP net −18.9%, 63% of pools negative, top5 = 142% of aggregate P&L, top2 =
74%**. Decomposition: corr(LP net, direction) **0.936** vs corr(LP net, fees) **0.414** —
direction explains 88% of variance. **Unhedged memecoin LPing is a coin bet with a
coupon.**

Survived intact: LVR = (σ²/8)·V; **κ = 41.49/21.48/14.82 at ±5/10/15% with fee/LVR
unchanged** — concentration is a pure leverage knob on the ratio; first-passage E[τ]=(w/σ)²
→ ~33 re-centers/yr; the rebalance-turnover cost line (4–16%/yr, 8.5%/yr at Meteora's
blended 31.6bp) as the ATA-rent analogue, with the caveat that it is policy-dependent;
the JIT paper (36,671 attacks, 269x notional, 0.007% ROI, top bot **92% share**);
sandwiches *pay* LPs; the WSOL-PUMP anomaly to the digit (345 days, median apyBase 135.1%,
min 20.0%, TVL $92k→$668k, n=1); and the most valuable object in the corpus — the
model-free identity

> **LP net = −(arb profit + tips + gas)**

Open question closed: DefiLlama uses per-pool fee rates, not per-adapter — Raydium n=102
shows 17 distinct implied rates clustering on 25.0/1.0/10.0/5.0/40/80/100 bps, Orca on
1.0/4.0/5.0/16.0/30.0 bps, matching shipped tiers. WSOL-PUMP's 10.0 bps is a real tier;
the anomaly is genuine and unexplained at n=1.

Risks the verifier added: **short gamma / negative skew** (n=188: median fee/LVR 1.30
while mean P&L −1.47%/30d, win 18% — every point-estimate ratio in the report is
uninformative); **jump risk** (a single 20% candle blows through the no-arb band, no fee
tier protects; absent from every model); **selection-for-APR is selection-for-volatility**
(C2-selected pools carry LVR 40%/yr against fees 34%/yr); **hedge maintenance** ~548%/yr
of notional turnover = 0.55–1.09%/yr, a third of C1's entire core, uncosted; **perp
funding has the opposite sign** — a short hedger *receives* it, and if funding is
20–100%/yr it dominates the LP core, i.e. C1 is a funding-carry trade to be tested
directly; **hedgeable universe = 28% of pools** (13/46); **DefiLlama TVL is partly
circular** for thin tokens; **survivorship direction unstated** — both ledgers sample
pools alive today, so −18.9% and OOS −1.4% are *upper bounds*; **the SOL numeraire is
itself a position**; and **a zero-cost null was never run**.

### F3 swing-edges — cost floor collapses, prohibition survives, all three candidates dead

**The cost-floor half of the thesis is TRUE and verified twice.** Round-trip execution
falls from the measured 1,690bp launch-snipe floor (0.03 SOL, relayer, no ATA close —
`docs/strat-swarm-2026-07-24.md` L160-168) to **~17bp taker on a Hyperliquid meme perp at
a 20 SOL clip, or 3bp maker**. That is a 99x–560x absolute reduction and every line of it
confirms. **The alpha half is refuted.** The finder's "the cost:opportunity ratio improves
by ~130x; launch sniping was forbidden by arithmetic, swing trading is not" does not
survive: the finder divided cost by *volatility* (300–545bp daily hedged residual sigma)
where the launch figure divided cost by a measured *edge* (300bp drift). Like-for-like,
cost/edge is **1690/300 = 563%** for launch snipe, **17/8.94 = 190%** for all-24 swing,
and **17/1.66 = 1,024%** for the liquid-12 book actually proposed. F3 is still
arithmetically prohibited, by 1.9x instead of 5.6x.

The decisive kill is a **rebalance-clock artifact**. The finder's `daily()` helper filtered
on UTC open hour 0, a silent 1-of-24 choice. The verifier reproduced the finder's numbers
exactly at that hour (all-24 K=5: 16.9 vs 17.0; liquid-12 K=3: 12.9 vs 12.9; top-6 K=3:
4.1 vs 4.1), then swept all 24 phases. Liquid-12 K=3 mean across phases is **+1.66bp/day,
sd 6.3bp, 9 of 24 phases negative, the finder's hour 2nd-best of 24 (+1.8σ)**.
Phase-pooled: IS +10.79bp (t=3.60), OOS **−7.46bp (t=−2.23)** — significantly
gross-negative out of sample, before the 3.0bp maker fee. This is the project's own
phase-mirage law, which the finder applied to hold=2 and then failed to apply to
hour-of-day.

The liquidity decay is a **sign inversion, not a decay**: phase-pooled **8.94 (all-24) →
1.66 (liquid-12) → −2.45 (top-6) bp/day**, top-6 OOS −6.44bp (t=−2.31), negative in 17 of
24 phases. The finder's own cited authority (Zaremba et al., IRFA 2021) says "the handful
of largest and most tradeable coins exhibit daily momentum" — the clause it omitted. And
"17bp gross vs 17bp cost, breakeven to four significant figures" is numerology:
phase-honest all-24 gross is 8.94bp against 17bp taker, roughly 2x underwater. Even
8.94bp has naive t=3.85 on 4,234 pooled observations, which is **t=0.79** after the √24
overlap correction the finder demanded for C3 and skipped for its own headline.

Risks added: **same-print signal/entry overlap** — a 1-hour execution lag drops all-24
16.9 → 12.0bp/day (−29%) and liquid-12 12.9 → 7.4bp/day (−43%), no recovery at longer
gaps. **Clip vs touch** — one-way taker slippage on a $2,500 buy is PURR 22.6bp, NOT
25.8bp, APE 13.7bp, GOAT 9.4bp; tail spreads 51.7bp (NOT), 20.8bp (PURR). **Open-interest
capacity, never screened**: GOAT $160k, kNEIRO $135k, MOODENG $223k, kLUNC $255k, NOT
$255k, BRETT $261k total OI — a $2,500 position is 1–2% of the market; PURR, kLUNC, GOAT,
MOODENG, POPCAT, BOME are capped at 3x max leverage. **The universe is not Solana
memecoins**: kLUNC is Terra Luna Classic, PURR is Hyperliquid's house token, and
DOGE/kSHIB/kPEPE/kFLOKI/APE/BRETT/TURBO/NOT/kNEIRO/GOAT are not Solana assets — kLUNC
(36.4%) + PURR (34.7%) = **71% of all-24 gross from two non-Solana instruments**.
Effective breadth ~8–10, not 24. **Cross-margin liquidation**: a dollar-neutral 10-leg
book in 3x-max instruments is one cross-margin account; the JELLY incident on this venue
is the precedent. **No pre-registered holdout was ever held out.** **Meme-perp mortality
is ~40%** (~17–18 of ~43 ever listed; 55 of 232 venue-wide perps carry isDelisted =
23.7%), not 21%, and one-directional downward since the reversal P&L sits in the tail
that gets delisted.

**Funding sign is backwards on both surviving constructions.** The finder's nominated
"ATA-rent equivalent" invisible cost line is a *credit*: measured on the actual
dollar-neutral book (n=2,479 rebalance-days, all phases) the long leg pays 0.82bp/day, the
short leg **receives 1.86bp/day**, net **+0.52bp/day tailwind**. *(Adjudicated below:
1.86bp/day = 6.8%/yr is BELOW Hyperliquid's published 11.6%/yr structural component, which
means the memecoin funding premium is negative in this regime. That is the pre-visible kill
for E1.)*

Genuinely new and worth keeping: Hyperliquid `fundingHistory` timestamps carry ms jitter
and must be rounded `Math.round(t/3600000)*3600000` before joining to candles — **without
it 99.2% of rows silently drop**, and it cost the finder one wrong pass. And the sizing
reframe: 50–100 SOL is $3,776–$7,553 and the whole programme's best case was **~$14/day
expected against ~$237/day one-sigma**, which the verifier judges still ~9x too
optimistic.

Unverified: sector decline downgraded to **−75% to −83% from a ~$150.6B Dec-2024 peak
(CoinGecko)**; the finder's "−81.9%" is spurious precision from an SEO aggregator.
Solana network-fee (−84%), DEX-volume (−62%) and Pump.fun (−80%) figures remain
**unverified**. Social/attention vendor claims (LunarCrush, Santiment, TIE) remain
**unverified** and are correctly killed as unfalsifiable. Jupiter round-trip costs (PUMP
1/1/3/3bp, PENGU 4/4/6/9, FARTCOIN 5/7/10/16, BONK 12/13/35/53, WIF 43/58/82/116, POPCAT
55/64/76/116 at 5/20/50/100 SOL) are **quoted routing estimates, not fills**, carry no MEV
term, and *(adjudicated below)* the sub-10bp entries are the same arithmetically-impossible
class F1 rejected. **Drift could not be checked at all** — `data.api.drift.trade` returned
HTTP 403; the finder's "$700M OI" is a marketing total across BTC/ETH/SOL and 40+ markets
and must not be used as meme-depth evidence. One published precedent for this exact
failure mode confirmed and *stronger* than claimed: Azka Fayez Junior, SSRN 6701738, 10
Binance perps Jul 2022–Apr 2026 — naive IC −0.0097 (t=−1.54), net Sharpe −3.22; an XGBoost
ranker with genuinely positive rank IC **+0.0243 (t=3.55)** still produced net Sharpe
**−2.91 at −95.6% max drawdown**.

### F4 data-acquisition — data is free and sufficient; both families still die

**The data problem is solved; the strategies are not.** 6 months of 5-minute Solana pool
OHLCV (GeckoTerminal, verified back to 2026-02-12 = **185 days**), **571–1,231 days** of
daily pool `apyBase`+TVL (DefiLlama `/chart/{uuid}`), and hourly perp funding back to
listing (Hyperliquid) are all free, unauthenticated and US-reachable. Total to first honest
result: **$0 for swing, $49/mo (Helius Developer) for the per-swap LP work, +$300 optional
one-month DefiLlama Pro**. Binance (HTTP 451) and Bybit (CloudFront) are geo-blocked from
this machine.

**Cost floor — survives, use the median not the best case.** Jupiter quote-to-quote round
trip at 100 SOL: BONK 0.58% (live recheck 0.561%), POPCAT 1.16% (1.137%), MEW 0.95%, BOME
0.51%. Median **0.58%** vs the 07-24 registry's 16.9% at 0.03 SOL — a ~28x reduction, the
strongest genuine result in the area. The finder's flagship **0.19% (FARTCOIN at 100 SOL)
failed to quote at all on retest** (`"Pool has not been updated in a while"`) on a calm
day — do not cite it. ATA rent is 0.00203 SOL = **0.002% at 100 SOL** versus 6.77% at
0.03; the old killer is dead at this size. TVL-based impact models remain wrong by 10–50x
(naive CP predicts 4–22% where reality is 0.2–0.4%) because depth sits in
HumidiFi/SolFi V2/ZeroFi/Scorch/AlphaQ/Quantum — routePlan labels reproduced live.

**Statistics — reproduced exactly, then spent.** 1d ρ̄ = 0.756, N_eff = 1.29; 1h ρ̄ =
0.628, N_eff = 1.52; residual ρ̄ = −0.069, **N_eff_resid = 11.09**; 13→100 tokens moves
N_eff 1.29→1.32. Every figure matched to 3 decimals, plus the eigendecomposition the
finder skipped: residual eigenvalues 2.04/1.73/1.68/1.17 of 13, top residual factor 15.7%
of variance, participation ratio 10.08 — **no hidden second factor, the 8x power
multiplier is real**.

**Directional swing is NOT dead for a power reason — corrected.** The finder's 258 days
(H=24h) / 513 (H=48h) for n_eff=100 came from applying φ=0.3 to directional and φ=1.0 to
cross-sectional. Under matched φ=1, H=24h needs **78 days for n_eff=100 and 155 for
n_eff=200**, against 403–1,200 days of free HL daily bars per coin. It dies for a better
reason the finder never stated: **one regime.** Equal-weight 13-coin basket **x0.2682
(−73.2%)** over the common window, SOL **x0.5247 (−47.5%)**, all 13 down from listing
(median x0.13 = −87%; GOAT x0.020, TRUMP x0.049). Correct dead-end wording is *insufficient
regime diversity*, not *insufficient n*.

**LP hurdle — corrected, and the correction does not save it.** LVR (σ²/8) is the
*delta-hedged* LP's loss rate; no candidate hedges. Realized unhedged full-range
loss-vs-hold over the 208-day hourly window is **median 0.7% against σ²/8 predicting
3.7%**. *(Adjudicated below: this 0.2x is a category error — it compares unhedged endpoint
IL to hedged path LVR, and F5 measured the same ratio the right way up at 3.2x. The
magnitude claim is STRUCK; the framing survives.)* Two further corrections push back the
other way: Raydium AMM v4 pays LPs **0.22%** while DefiLlama's `apyBase` uses the gross
**0.25%**, so every fee APR here is **13.6% too high** (BOME, the only marginal survivor,
becomes 12.85% vs a 13.6% hurdle — fails); and live `apyBase` vs the `apyMean30d` used
swings **2.0–3.9x per pool** (MEW 0.71 vs 2.76; BOME 32.39 vs 14.69), far exceeding the
1.5–2.0pp margins used to reject. **The binding arithmetic is neither:** in SOL terms a
full-range TOKEN/SOL LP returns **√r × fees**, and over each token's full life median LP
terminal value is **x0.644 per 1.00 SOL deposited (−36%)**, with only **3 of 13** beating
holding SOL. LP dies through **directional exposure**.

Risks added: **THE REGIME** (every number from one monotone −73.2% window; nothing marked
regime-conditional — the mirror of bull-market beta dressed as alpha). **Silent 429
truncation** — this family's ATA-rent analogue: GeckoTerminal returns rate limits as a
normal JSON body with no `data` key; a collector treating that as end-of-history stops at a
random depth per pool with no error. The verifier's own first script did this and reported
a false "22-day retention wall"; at 4.2s spacing, **429s on 4 of 9 requests**, so the
100-pool/5-hour estimate is ≥2x optimistic. **You cannot short on-chain** — "excess vs the
equal-weight basket" is a valid statistic and an unharvestable P&L. **HL delisting already
live inside the panel** — MEW's gap silently set the 2026-05-05 end boundary of every
correlation stat. **Bid-ask bounce inflating σ** and hence σ² in the hurdle. **Alternative
sources never probed** — Drift and other Solana-native perps, and `data.binance.vision`
(a different host from the blocked `fapi`). **Quote availability, not just width** —
Jupiter refused 100 SOL of the most liquid name on a calm day. **Concentration framing
inverted** — "top 10% of days carry 25–81% of fee yield, median 37%" is ~3.7x uniform and
is evidence *for* fee-income stability; the real concentration problem was in the reversal
grid, top5 shares of 100–4,500%.

**Survivorship measurements stand and they are the class-level fact.** Of 874 pump.fun
tokens that migrated on 2026-07-25, 22 days later: **0 with TVL >$50k, 0 with 24h volume
>$100k, 9 (1.03%) with volume >$1,000, 267 (30.5%) under $100 TVL.** GeckoTerminal resolves
**874/874** dead pools by address and HL serves delisted coins' candles (MEW returned 688
bars) and exposes `isDelisted`, so **point-in-time universe construction is genuinely free
on both sources** — it is the collector's silent-truncation bug, not data availability,
that would break it. Unverified and load-bearing: the Helius **0.1 credit/tx gTFA rate and
"unlimited mainnet retention" are undocumented**, so the entire 21.6M-tx backfill cost
model is unverified at its load-bearing point. The finder's "high fee APR persists"
(top-APR pick delivers median 129.1% forward-7d vs a 40.4% cross-sectional median, n=562)
**remains unverified** and is measured on 19 pools that all still exist.

### F5 infra-reuse — LP dead on means and rent, swing dead on drift, and the recorder lies

The code half of this finding is exact and the data half was substantially wrong **in both
directions**. About 60% of the engine transfers unchanged, and the tape does contain a
complete per-swap PumpSwap LP-fee-accrual record — **13,447,656 decodable swaps across
13,846 pools on 07-26**, confirmed to the record. But three of the finder's four
load-bearing figures are artifacts.

- **Swing taker fee: 48 bps median — REFUTED.** That was a small-pool filter, not a
  SOL-quote filter. Unfiltered 08-08 (n=423,278): p25/p50/p75 all **30.0 bps**, p95 120,
  mean 33.2. Unfiltered 07-26 (n=727,863): p50 30.0. The `poolQuoteReserves < 5e13` cut
  deletes the 25/5 config — 67.7% of 08-08 swaps, 55.0% of 07-26. Round-trip fee is
  **0.60%, not 0.96%**; the whole 1.67–7.16% floor table and the "50x better cost ratio"
  fall with it. Corrected floor ~1.5% at 2 SOL, which does not help.
- **08-08's 504 bps required LP tier and the "it's regime, not capture" law — REFUTED, and
  this is the most important finding in the area.** 08-08 holds 492,056 records in **2 of
  24 UTC hours** (367k in hour 0, 126k in hour 11); **22 hours are empty** — ~1.6h of real
  capture sold as an 11.6h window. That is why all 152 pools reported an identical 11.6h
  span and identical 11.0h dead gap. **ReserveContinuity is structurally blind to this**:
  one outage yields one mismatch per pool, 152/447,733 = **0.03%**, which is why 0.14%
  "clean" was believed. Turnover is understated ~7x, so reqBps inflated ~7x: 504 bps is
  roughly **70 bps** coverage-corrected. The finder wrote a registry law on a 5x
  day-to-day gap; **the gap is capture**.
- **07-26's 109 bps median required tier — REFUTED in the finder's favour.** Restricting to
  the canonical 20/5 pump-graduate config, true time-weighted, n=486 pools: **median
  required tier 56 bps**, p75 171, p90 484; 33.7% beat HODL at 20 bps, 37.9% at 25 bps,
  63.8% at 100 bps.
- **The median was the wrong statistic. A portfolio earns the mean.** 07-26 all pools: net
  vs HODL median −0.85% but **mean −20.61%**; clean 20/5: median −0.07% but **mean
  −7.56%**. Mean endpoint IL 23.50% (all) / 8.29% (20/5) against medians 1.03% / 0.17%.
  **The mean is 26–71x worse than the median.**
- **Endpoint IL understates the loss ~3–4x.** Path LVR at swap granularity (⅛·Σ squared log
  mid-returns): 07-26 all pools p50 **3.27% vs endpoint 1.03%**; 20/5 clean 0.77% vs 0.17%.
  Delta-hedged (fees minus LVR — LP as a yield business, not a disguised long) is median
  −0.68% / **mean −8.26%**, positive in **3.5%** of pools at 20 bps, 28.8% at 100 bps. Fee
  income is ~2% of the loss magnitude, not 7%.
- **The DLMM invisible line was measurable in one search.** ~0.059 SOL refundable position
  rent plus **~0.075 SOL per binArray, non-refundable**, when you are first into a price
  range — which on a *fresh* memecoin pool you always are, and again on every re-centre.
  That is **37x the 0.00203 SOL ATA rent** the 07-24 registry named the single largest
  fixed cost, i.e. 1.5–3.0% of a 5 SOL position burned per position and per rebalance,
  against median clean-population fee yield of 0.0724%/21h = 0.0036 SOL/day. One binArray
  needs ~21 days of median fees to amortize. *(Adjudicated below: real for this population,
  does not transfer to established pairs.)*
- **Data reality is worse than stated.** Not 3.5 usable days: measured UTC-hour coverage is
  07-25 19/24, 07-26 21/24, **07-27 24/24 (the only complete day)**, 07-28 7h covering only
  00:00–06:53 UTC, 07-31 12 minutes, 08-08 1.6h — **≈2.6 complete-day-equivalents**. The
  proposed 07-28 holdout is one time-of-day window, so both candidates' stated protocols
  *violate* the in-sample-pick/holdout-confirm law rather than satisfy it.
- **Decimals contamination is a majority, not a minority.** The 25/5 population is 55–68% of
  swap volume, has zero overlap with the 874-entry migration poolmap, carries base reserves
  ~1000x smaller than pump mints, and its top pool reads as 13,134,062 SOL of reserves.
  Continuity is 99.99%, so it is a different token population, not a misparse. Ratio
  statistics survive; **every absolute SOL figure does not** — including "median 144–652
  SOL pools", the 2S/depth impact term, and the 50–100 SOL sizing discussion.

Risks added: capture coverage is uninstrumented and is the dominant error source in the
whole report; **LP capacity is broken at stated capital** — 50–100 SOL against clean-
population median pool TVL makes you 10–20% of the pool *(adjudicated: true for fresh
graduates, not for the established pairs actually asked about)*; gross fee income per
position is smaller than the two transactions that open and close it; top5 ≤60% never
applied to either candidate; **MEV/sandwich cost absent entirely** from the swing model;
rug/drain risk nowhere in LP accounting, no mint/freeze-authority filter proposed; both
probes condition on future activity (≥50 swaps, ≥1h life = 20.4% of 07-26 pools) —
look-ahead selection, the exact bias the finder flagged in GeckoTerminal while committing
it in its own scripts.

Survived unchallenged: the entire code audit — `maxSellVolumeSol` **still dead code, in the
07-24 registry and unfixed since**, StratLab's clockless hold machine, silent eviction in
StratLab/DipShadow vs MigShadow's correct finalize, no accountSubscribe/getProgramAccounts
anywhere, AMM feed pinned to `[feedUrls[0]]`. The reuse inventory (recorder.ts, curve.ts
bigint discipline, migShadow.ts template, esbuild+node:assert fixtures, fail-closed guards,
daily-report.mjs) is sound and is the report's most valuable half. poolmap.json = 874
verified entries. "Read `lpFee`, never derive it" confirmed (18.91% mismatch). **Pump.fun
is NOT shut down** — >$10.03M protocol fees in the week of Aug 11, platform upgrade
2026-08-07; "CLOSED" refers to the sniping programme only. Two open items closed: the 2/93
fee config is **not** decoder drift (continuity 99.29%, fee identity holds within 1 lamport
for 98.2% of its swaps, realized 125.0 bps matches the documented 1.25% bottom tier); and
the 1.22x reserve-mid-vs-execution warning in `docs/amm-decoder-2026-07-25.md` was specific
to 30 fresh pools on 07-25 — measured p50 is 1.008 on 07-26 (n=300k) and 1.006 on 08-08
(n=400k), so reserve-derived k and TVL are defensible today. Still **UNVERIFIED**: whether
Meteora DLMM emits via `emit!` (visible to logsSubscribe) or `emit_cpi!` (invisible) —
sources conflict, neither agent checked a mainnet transaction.

## Contradictions adjudicated

Twelve cross-area contradictions were adjudicated by the completeness critic. Where a
section above disagrees with another, the ruling here binds.

| # | Dispute | Ruling | Why |
|---|---|---|---|
| X1 | Fee income above or below LVR? F1 Q=0.47–0.54 vs F2 fee/LVR median 1.03 | **F1 on the ratio; F2's arithmetic correction stands as data hygiene only** | F2's ratio is built from the DefiLlama `apy*` field F2 itself proved contaminated four ways (63.1% parked TVL, circular price marks, $137.3M/day at $0 TVL, F4's 13.6% overstatement); F1's Q is on-chain pool state decoded to the byte. Mean 2.30 vs median 1.03 is a small-denominator artifact and LVR is the denominator. Four independent realized ledgers agree against the ratio: F1 **−13.69%** (0/7 positive), F2 **−18.9%** (63% negative), F4 **x0.644** (3/13 beat SOL), F5 **−20.61%** mean. |
| X2 | Is σ²/8 too harsh (F4, 5x) or too lenient (F5, 3.2x)? | **F5, decisively. F4's magnitude claim is STRUCK** | F1 supplies the fact neither used: CPMM **IL is path-independent**, **LVR is path-dependent**. F4 compared unhedged endpoint IL to hedged path LVR; F5 measured the same ratio the right way up. F4's 0.2x is F5's 3.2x upside down. The 8-of-11 LVR rejections stand. What survives of F4 is the framing (unhedged LPs should be benchmarked on hold-the-basket) and its own √r term, median x0.644. |
| X3 | Are quoted DEX prices fillable? F1 vs F3 and F4 | **F1, and it is a cross-area kill nobody applied** | FARTCOIN 0.007% round trip = 0.0035%/leg, **below Solana's cheapest fee tier (0.01%)** — not a fill. F3's PUMP 1/1/3/3bp and FARTCOIN 5/7/10/16bp are the identical class of object. F4 corroborates without connecting it: its 0.19% flagship **failed to quote on retest**. Both tagged their quotes "routing estimates, not fills" and headlined them anyway. **Binding:** use F4's median **0.58% at 100 SOL** and F1's **WIF 0.33% at 2.5 SOL / POPCAT ~0.53%**; treat any sub-10bp Solana spot quote as unfillable until a fill proves otherwise. |
| X4 | Did the cost-floor collapse matter? F3/F4/F5 vs F1 | **F1 — the pivot's one genuine win is a non-event** | The 07-24 floor bound because edge (+3%) and cost (16.9%) were the same order. Neither is true now. LP: loss term is **100–1000x** transaction cost, so cost is noise. Swing: the *numerator* collapsed too — phase-honest liquid-12 is **+1.66bp/day against a 3.0bp maker fee**. F3's own like-for-like ratio says it: **563% → 190% → 1,024%**. Both families stopped being prohibited by arithmetic and started being prohibited by absence of alpha. |
| X5 | Is capacity a constraint? F1 "no" vs F5 "broken" vs F2 breadth | **No depth contradiction — different populations. But the binding constraint is BREADTH, not depth** | F1 measures established pairs (100 SOL = 7.2% of the thinnest pool), F5 measures fresh graduates (10–20% of the pool); only F1's population is the question asked. F1's general claim is still wrong for F2's reason: the rig's own law is ≥30 distinct assets and top5 ≤60%, and F1 never applied it to its own 15-pool universe, which fails on n alone. |
| X6 | Is the hedgeable universe really 28% of pools? | **F2's breadth kill of C1 is UNPROVEN, not proven** | F2 enumerated Hyperliquid's 12 meme perps. **Drift lists ~35 perp markets including WIF, BONK and POPCAT** — the three largest established Solana memecoins — and F3 could not reach Drift (HTTP 403) while F2 never checked it. This does **not** resurrect C1: its ceiling is $138–$276/yr gross, $38–$76/yr net, below a USDC deposit on the same capital. C1 was killed for a defeasible reason while the indefeasible reason was never stated. Stated here so it is not re-litigated. |
| X7 | Does fee APR persist? F4's 129.1% vs F1 and F2 | **F1 and F2. F4's claim is probably TRUE and definitely IRRELEVANT** | Fee APR persists because volatility persists. F1's elasticity: **β=0.45**, volume ~ σ^0.90 against LVR's σ², so **Q ~ σ^−1.10**. Selecting on fee APR selects LVR in lockstep — F2's C2-selected pools carry LVR 40%/yr against fees 34%/yr; κ-invariance is the same fact again. Both areas tested the monetizable version and killed it (F1 top-k forward Q **never above 1.00**; F2 C2 IS +24.37% → **OOS −1.39%**, win 33%). Keep 129.1% only as a descriptive fact about volatility clustering. |
| X8 | DLMM: closed by rent (F5), or the only live thread (F1)? | **F1 on the rent; F5 correct only for its own population; the family dies anyway, for neither stated reason** | F5's tape is exclusively fresh graduates where you are always first into the range; the 0.075 SOL binArray line is real there and does not transfer to WIF/SOL. What transfers is **κ-invariance**: concentration is a leverage knob on a ratio that is ≤1, so it multiplies a losing number. Add F1's out-of-range penalty (526–876 exits/yr at ±2%) and F5's median p5–p95 range of **1.36x** — out-of-range is the normal state. **The one genuinely open crack in the corpus:** DLMM is the sole venue with **volatility-responsive fees**, the only mechanism that could break κ-invariance by making the fee *rate* a function of σ. F1 named it; nobody tested it. Compounding: **DefiLlama carries zero Meteora pools**, so a $59.3M/day venue is absent from every dataset in F1, F2 and F4, and every DLMM figure in the corpus assumes k=1 — including the apparent TRUMP/USDC Q=2.99, an artifact. |
| X9 | Regime: reason for doubt (F4) or reason for hope? | **F1 resolves it — the regime argument cuts ONE way only** | "This was a bear window, wait for the bull" is refuted for LP by F1's own elasticity: LVR ~ σ² and income ~ σ^0.90, so the awaited regime raises the loss term twice as fast as the income term. **LP fee farming's best regime is the one being measured.** Refuted for swing by F2's C2: the only regime that ever paid was the Oct–Nov 2025 rally (directional +7.55% vs fee +2.89%), unforecastable by construction. Correct statement, in no bottom line anywhere: regime diversity would make the LP numbers *worse* and would *test* the swing numbers, not rescue either. |
| X10 | Is CAPTURE-1 urgent (F5) or already solved (F4)? | **F4** | CAPTURE-1 improves capture of a tape whose population is fresh pump.fun graduates — the dead sniping cohort — and F5 says so itself. F4 already found the established-pair asset, free. **Demote CAPTURE-1 from "the swarm's only surviving build" to hygiene on a deprecated asset. Keep exactly one thing from it, unconditionally:** the wall-clock **hours-covered/24 heartbeat**. F5 proved the rig recorded **1.6 hours of 08-08 and reported 11.6**, and that ReserveContinuity is structurally blind to it (0.03% detection). Every measurement this rig makes about anything is worthless until that heartbeat exists. Data integrity, not a strategy build. |
| X11 | Power: 15 years (F3) or 155 days (F4)? | **Both right on different objects; the joint implication is what matters and neither stated it** | Only signals whose events arrive at **diffuse daily frequency** are testable inside this rig's lifetime — and every such signal in the corpus has been directly tested and killed (F4 XS-MOM **0 of 120 configs**; F4 reversal **+0.643% t=2.72 at lag 0 → −0.152% t=−0.63 at lag 1**; F3 liquid-12 **−7.46bp/day OOS, t=−2.23**). The only signals with a surviving sign are rare-event ones (F3's C3: slope +0.00862, t=+3.98, n=990) and they are permanently untestable (~4 independent events / 7 months → ~15 years for n≥100). **What can be tested is dead; what is alive cannot be tested.** Any future proposal must declare which side of that line it is on before it starts. |
| X12 | MEV: credit (F2) or debit (F5)? | **Not a contradiction — opposite sides of the same trade, and the asymmetry is load-bearing** | In the LP book MEV is a small credit (sandwiches pay LPs). In the swing book it is an uncosted debit — and the debit is larger, because the swing book is the one being sandwiched. Consequence: F3's and F4's quoted spot cost floors are understated by an unmeasured MEV term, **on top of X3**. |

## Verification outcomes

Fifteen candidates were proposed across five areas. **Fifteen were killed. Two
infrastructure items were marked worth-testing (one since demoted). Two were left
unproven and untested.** Every row is here so the user does not respend on it.

| Candidate | Area | Evidence | Verdict | Cause of death |
|---|---|---|---|---|
| Q-screen (LP only where feeAPR/LVR durably >1.3) | F1 LP | Q Spearman t→t+1 mean **+0.002**, median −0.041, 5/10 transitions positive; forward realised Q of selected pools top-1 IS 0.93/OOS 0.80, top-2 0.85/0.97, top-3 0.90/0.99, top-5 0.97/0.99 — **not one cell above 1.00** | **KILL** | "Durably" has no referent — Q does not persist. Multiple-comparison surface 4 orders worse than the 06-12h UTC window (2,667 pools daily). Ceiling anyway: **$113–181/yr on 100 SOL, $6–9/yr at 5 SOL** |
| Volatility-conditional LP | F1 LP | Tercile by trailing-7d vol, forward 7d realised Q, 11 pools: median IS low/high **0.94** (5/11), median holdout **0.81** (3/11); sign holds both halves in **2 of 11** vs 2.75 by coin flip, against a stated bar of 5-of-6 | **KILL** | Killed by its own proposed test on its own data at its own bar. The contemporaneous mechanism is real (Q ~ σ^−1.10) but conditioning on trailing vol destroys it — volume mean-reverts faster than variance. Registry: "time-of-day and regime gates" under a new name |
| Passive index-style LP as SOL-denominated yield sleeve | F1 LP | LP-vs-50/50 over 181d: +0.05% mean / +0.66% median, 4/7 positive, **n=7 overlapping ex-post-survivor pairs in one window, effective n≈1** on the market factor; LP-vs-SOL **−13.69% mean, 0/7 positive** | **KILL** | A wash is what competitive equilibrium predicts, so there is no product. Priced frictions (0.0616 SOL locked rent; tax ~1.5%/yr = half the entire measured net) and unpriced ones (contract, terminal memecoin risk) each turn zero negative. It is a wrapper for a directional bet |
| **C1 — delta-hedged full-range CPMM LP** | F2 LP | Hedgeable subset n=658 windows: **+1.94%/30d, win 88%, OOS +1.04%/30d, 12/12 months positive**; ex-FARTCOIN/ex-PUMP n=525 **+3.0%/yr median** | **KILL** | Best-signed construction in the swarm. Killed by the finder on breadth (13 distinct tokens vs ≥30; pool top5 **91%**, SOL-FARTCOIN alone 61.2%) — **that kill is UNPROVEN (X6: Drift lists WIF/BONK/POPCAT, never checked)**. The indefeasible kill is the **ceiling: $138–$276/yr gross, $38–$76/yr net on $3,776–$7,552**, below a USDC deposit — plus §"delta-hedged LP = cash-and-carry + (fees−LVR)", which strictly dominates it |
| C2 — fee-APR/TVL-lag harvesting | F2 LP | K=3 **IS +24.37% (n=53) → OOS −1.39% (n=63), win 33%**; K=5 +15.42% → −0.03%; K=10 +10.68% → +0.20%; median trade negative in every cell of every sample; hedged version −1.47%/30d at 18% win | **KILL** | Textbook in-sample/out-of-sample collapse — same shape as tick-burst C5 (07-24). Mean fee/30d +2.89% vs mean directional +7.55%: the IS profit *is* the Oct–Nov 2025 rally. Self-defeating by X7 (LVR 40%/yr vs fees 34%/yr on C2-selected pools) |
| C3 — DLMM falsification harness | F2 LP | κ = 41.49/21.48/14.82 at ±5/10/15% with fee/LVR unchanged; worked WIF/SOL ±10% case **−28%/yr** (corrected from −63%/yr) | **KILL as a build** | κ-invariance already closes it. Acceptance test ("if the harness disagrees by >2x the harness is wrong") is circular and the opposite of the migShadow.ts precedent |
| C1 — liquid-12 daily cross-sectional reversal | F3 swing | Phase-swept: **+1.66bp/day, sd 6.3bp, 9/24 phases negative, finder's hour 2nd-best of 24 (+1.8σ)**; phase-pooled IS +10.79bp (t=3.60) → **OOS −7.46bp (t=−2.23)** | **KILL** | Rebalance-clock artifact (`daily()` silently picked UTC hour 0 of 24). Gross-negative OOS **before** the 3.0bp maker fee. Fails concentration on its own universe (top-5 coin share **212%**; top-5 days = 100% of 177-day gross). Fill premise false: top-of-book PURR $13/$876, POPCAT $19/$400, WIF $32/$31 against a $1,250–2,500 clip |
| C2 — SOL-beta hedge overlay | F3 swing | Beta 1.0–1.3, R² 0.29–0.68; hedged 12-coin basket **−6.6% ann at 39% vol, Sharpe −0.17**, max \|t\| 1.87 and negative | **KILL as candidate, RETAIN as reporting law** | Zero-EV by construction, so it can never clear a bar. Keep the three-line rule: raw / beta×SOL / residual, and residual must be independently positive |
| C3 — funding-extreme continuation | F3 swing | Sign independently replicated: verifier slope **+0.00862, t=+3.98, R²=0.0158, n=990**; finder +0.00888, t=+2.93, n=1175 | **UNPROVEN — do not buy the data** | 25 episodes on 3 coins in 7 months collapse to **~4 independent market events**; top-5 episodes = **79% of P&L**; n≥100 independent events needs **~15 years** and meme perps have not existed 15 years. Permanently untestable (X11) |
| XS-MOM — cross-sectional memecoin momentum | F4 swing | 2.5y HL daily closes, perfect fills, zero impact, zero funding, shorts allowed: **0 of 120 configs** meet the bar; 9/120 positive in both periods vs ~30 by chance; best IS **+2.221% (t=1.14, n=73) → holdout −0.118% (t=−0.08)**; highest-power cells (n≥250) significantly negative at t=−2 to −3 | **KILL** | Direct test, generous assumptions, nothing survives. Highest-power cells point the wrong way |
| Short-horizon cross-sectional REVERSAL (verifier-discovered) | F4 swing | lag 0: **IS +0.751% t=2.29 n=530; OOS +0.643% t=2.72 n=258; win 55%, top5 30%** — passes the full bar. One-bar implementable lag: **−0.152% (t=−0.63)**; every t>2 cell decays or flips | **KILL** | Bid-ask bounce. A direct rediscovery of the registry's honest-fills law. The most dangerous row in this table: it cleared every statistical gate and died only to execution realism |
| LVR-SCREEN — full-range LP where fee APR > 3× LVR | F4 LP | Raydium pays 0.22% while `apyBase` uses 0.25% → every fee APR **13.6% too high**; `apyBase` vs `apyMean30d` swings **2.0–3.9x per pool** against 1.5–2.0pp decision margins; median LP terminal **x0.644 per SOL**, 3/13 beat holding SOL | **KILL** | Wrong inequality (hedged hurdle applied to unhedged positions), inputs swing 2–4x inside the decision margin, and blind to the √r term that actually decides the outcome |
| LP-0 — answer LP from the tape on disk | F5 LP | reqBps ∝ σ²/turnover | **KILL** | reqBps is an *asset* property; venue-neutrality was silently used as asset-neutrality, so nothing transfers to WIF/SOL or BONK/SOL — which is what was asked |
| SWING-0 — migration birth cohort + GeckoTerminal hourly | F5 swing | Honest forward returns, 641 clean pools: mean **+5.20% at 1h, +0.70% at 4h, −4.88% at 12h** (median −1.03%, 43.9% up) | **KILL** | Negative at its own stated horizon. Thesis compared an *oracle* p5–p95 range to a realized cost. Un-fillable: **17% of clock hours contain any trade**. Rediscovery of the 07-25 entry-delay sweep already in the registry |
| LP-1 — Meteora DLMM tape + bin simulator | F5 LP | 0.075 SOL/binArray non-refundable = **37x the ATA rent**, ~21 days of median fees to amortize; median p5–p95 range **1.36x** (p75 1.90x) | **KILL** | Conditional on LP-0, which died. Rent line is real for fresh graduates but **does not transfer to established pairs (X8)**; κ-invariance closes it regardless, and out-of-range is the normal state |
| FUND-CARRY — HL perp funding extremes | F4 swing | **Not tested by anyone.** Cost floor ~4.5bp/side. 12 tradeable memecoin perps, not 14 (MEW and AI16Z return `isDelisted:true`) | **UNPROVEN — and it is the one thing to build** | Its stated blocker is false: HL exposes `isDelisted` and still serves delisted candles (MEW: 688 bars), so a point-in-time perp universe is buildable in an afternoon. See §How to test it, E1 |
| DLMM-NARROW — quote-only-fee concentrated positions | F4 LP | Rests entirely on WSOL-PUMP: TVL confirmed $667,615, 30-day mean fee APR **276% → 194.4% live (−30% while the report was being written)**; Orca sibling 114.4% → 95.5% | **UNPROVEN, correctly deferred, and decaying** | n=1 and visibly mean-reverting. Do not build a bin simulator for it (X8). The *mechanism* question — DLMM's volatility-responsive fee rate — is the one open crack and is a different, cheaper question |
| QUOTE-LADDER — forward Jupiter quote recorder | F4 infra | $0; records the one dataset buyable at no price | **worth-testing → deferred** | Infrastructure, not alpha. Given the ceiling verdict, do not build it until E1 clears. Build notes if it ever ships: log HTTP status and error body per quote (a failed quote is a datum), log routePlan venue labels, 3 sizes not 5 (~60 req/min lite-api ceiling) |
| CAPTURE-1 — make the AMM tape a real asset | F5 infra | 08-08: **1.6 hours captured, 11.6 reported**; ReserveContinuity detection 152/447,733 = **0.03%** | **DEMOTED (X10) — extract the heartbeat, drop the rest** | Improves capture of a deprecated fresh-graduate tape. **The hours-covered/24 wall-clock heartbeat ships regardless** — it is data integrity, not strategy, and every measurement this rig makes is worthless without it |

## Cost model

Both families, in the 07-24 format. **These are costs only — the LP loss term (LVR/IL) and
the swing edge are stated separately below, because in both families the cost floor is no
longer the binding constraint (X4).**

### Family A — LP fee farming, established Solana memecoin pair, full-range CPMM

Annualized, as % of position, at ~33 re-centers/yr (F2 first-passage E[τ]=(w/σ)²).

| Line | 5 SOL | 25 SOL | 50 SOL | 100 SOL | Source / status |
|---|---|---|---|---|---|
| Locked position rent 0.0616 SOL — **the invisible line, this rig never reclaims it** | **1.23%** | 0.246% | 0.123% | 0.062% | F1, measured; ATA-rent analogue (cf. 0.203 SOL stranded, 07-24 A3) |
| Gas, 33 re-centers × 0.00058 SOL (4 tx) | 0.38% | 0.077% | 0.038% | 0.019% | F1, measured. **$0.04/rebalance — immaterial** |
| Rebalance swap turnover | 4–16% | 4–16% | 4–16% | 4–16% | F2, 8.5%/yr at Meteora's blended 31.6bp. **Policy-dependent, a tradeoff frontier not a fixed levy** |
| Per-swap execution embedded in the above | 0.33% RT | ~0.45% RT | ~0.53% RT | 0.58% RT | F1 (WIF 0.33% @2.5 SOL, POPCAT ~0.53%); F4 median 0.58% @100 SOL (BONK 0.58/0.561, POPCAT 1.16/1.137, MEW 0.95, BOME 0.51). **Sub-10bp quotes are unfillable (X3)** |
| Tax drag (30% ordinary on 5% gross fee APR) | 1.5% | 1.5% | 1.5% | 1.5% | F1, priced once in the whole corpus and **equal to half the entire measured net** |
| Hedge maintenance — **delta-hedged constructions only** | 0.55–1.09% | 0.55–1.09% | 0.55–1.09% | 0.55–1.09% | F2, 548%/yr notional turnover. **A third of C1's entire core, uncosted by the finder** |
| DLMM binArray rent 0.075 SOL/virgin array, non-refundable | **NOT PINNED** | NOT PINNED | NOT PINNED | NOT PINNED | Fact confirmed. **Real on fresh graduates (F5: 37x ATA rent, ~21 days of fees to amortize); F1 says "almost certainly far too high" on years-old pools where near-market bins are already initialized. Nobody measured the hit rate on established pairs. Do not use a number here.** |
| MEV / own-rebalance sandwiching of a predictable re-centerer | **UNMEASURED** | — | — | — | Small *credit* in the LP book (sandwiches pay LPs, F2), but the LP's own rebalance is toxic flow (F1). Sign known, magnitude not |
| **Total known cost floor, unhedged** | **7.1–19.1%/yr** | **5.8–17.8%/yr** | **5.7–17.7%/yr** | **5.6–17.6%/yr** | Sum of the pinned lines. Range is entirely the turnover policy |
| **Total known cost floor, delta-hedged** | **7.7–20.2%/yr** | **6.4–18.9%/yr** | **6.2–18.8%/yr** | **6.1–18.7%/yr** | |

**What it has to beat, and why cost is not the binding line:**

| Term | Value | Source |
|---|---|---|
| LVR / divergence loss, k=1 | **3.5–18.3%/yr** | F1, on-chain decode |
| Fee income, capital-weighted ex-parked | 2.6% (contaminated) → **7.01%** | F2, corrected; F4 says shave 13.6% for the Raydium 0.22/0.25 split |
| Q = feeAPR / LVR | **median 0.47–0.54**, TVL-weighted best 0.79, **0 of 15 pools clear 1.0 on both 1d and 7d volume** | F1 (adjudicated winner, X1) |
| Realized net, four independent ledgers | **−13.69% / −18.9% / x0.644 / −20.61%** | F1 / F2 / F4 / F5 |
| Net expectation, corrected band | **−0.8% to −8.6%/yr** | F1 verifier |

The loss term is **100–1000x** the transaction cost. **Cost is noise in this family; the
cost model above is bookkeeping, not the decision.**

### Family B — Directional swing, per round trip as % of position

| Line | 5 SOL ($378) | 20 SOL ($1,510) | 50 SOL ($3,776) | 100 SOL ($7,552) | Source / status |
|---|---|---|---|---|---|
| HL perp, taker both sides (4.5bp/side) | 0.090% | 0.090% | 0.090% | 0.090% | **Verified against HL's published schedule — the only cost figure in the corpus that is not a quote** |
| HL perp, maker both sides (1.5bp/side) | 0.030% | 0.030% | 0.030% | 0.030% | Verified. 1.8bp with 40% HYPE staking |
| HL slippage beyond touch, $2,500 clip, one way | 9.4–25.8bp | 9.4–25.8bp | — | — | F3 measured: GOAT 9.4, APE 13.7, PURR 22.6, NOT 25.8. **Round trip 19–52bp = 6–17x the headline fee.** The headline fee is the small half |
| Solana spot round trip via Jupiter | 0.11–0.33% | ~0.33–0.53% | ~0.5% | **0.58%** median | F4 median at 100 SOL; F1 WIF 0.33% @2.5 SOL. **Sub-10bp quotes struck as unfillable (X3)** |
| ATA rent 0.00203 SOL (spot leg) | 0.041% | 0.010% | 0.004% | **0.002%** | F4. **The 07-24 killer (6.77% at 0.03 SOL) is dead at this size** |
| Funding on a dollar-neutral perp book | **+1.9%/yr credit** | +1.9%/yr | +1.9%/yr | +1.9%/yr | F3 measured n=2,479 rebalance-days: long leg pays 0.82bp/day, short receives 1.86bp/day, net **+0.52bp/day**. A credit, not a debit |
| MEV / sandwich on the Solana spot leg | **UNMEASURED** | — | — | — | Absent from every model in F3, F4 and F5. Sign is a debit; it sits **on top of** the quote-vs-fill error in X3 |
| Cross-margin liquidation risk, 3x-max instruments | **UNPRICED** | — | — | — | A dollar-neutral 10-leg book is one cross-margin account. JELLY precedent on this venue |
| Capacity ceiling | — | — | **binding** | **binding** | OI is $135k–$261k/name (GOAT $160k, kNEIRO $135k, MOODENG $223k); a $2,500 clip is **1–2% of the entire market**; top-of-book notional PURR $13/$876, WIF $32/$31 — you become the book, not a queue joiner |
| Tax | **UNPRICED** | — | — | — | Daily rebalancing and hourly funding are high-frequency ordinary-income events |

**What it has to beat:**

| Universe | Phase-honest gross | Against | Verdict |
|---|---|---|---|
| all-24 | **+8.94bp/day** (t=0.79 after √24 overlap correction) | 17bp taker | ~2x underwater |
| liquid-12 (the book actually proposed) | **+1.66bp/day**, OOS **−7.46bp (t=−2.23)** | 3.0bp maker | gross-negative OOS **before fees** |
| top-6 | **−2.45bp/day**, OOS −6.44bp (t=−2.31) | anything | wrong sign |

**Cost/edge like-for-like: 563% (07-24 launch snipe) → 190% (all-24) → 1,024% (liquid-12).
The cost floor fell 99–560x and the ratio got worse, because the numerator collapsed with
it.**

## The data question

**The data is free, sufficient, and already sitting on public endpoints. It is not the
constraint and never was.**

| Asset | Coverage | Cost | Status |
|---|---|---|---|
| GeckoTerminal 5-min Solana pool OHLCV | **185 verified days** back to 2026-02-12; 6-month lookback, 30 calls/min | **$0**, unauthenticated, US-reachable | Verified live. **Silent 429 truncation is the trap**: rate limits return a normal JSON body with no `data` key; 429s on **4 of 9 requests** at 4.2s spacing, so any throughput estimate is ≥2x optimistic |
| DefiLlama `/chart/{uuid}` daily pool apyBase + TVL | **571–1,231 days** per pool | **$0** | Verified. **Contaminated four ways** (X1) — usable for shape, not for ground truth. **Carries zero Meteora pools** |
| Hyperliquid hourly `fundingHistory` + daily candles | **403–1,200 days per coin, back to listing** | **$0** | Verified. Exposes `isDelisted` and **still serves delisted coins' candles** (MEW: 688 bars) — point-in-time universe is free. Timestamps carry ms jitter: round `Math.round(t/3600000)*3600000` or **99.2% of rows silently drop** |
| Drift on-chain perp funding (WIF, BONK, POPCAT) | unknown | $0 (on-chain read) | **`data.api.drift.trade` returns HTTP 403 from this machine.** Never checked by anyone. Load-bearing on X6 |
| Helius per-swap (LP arb-pot measurement) | — | **$49/mo** | Pricing page confirmed. **The 0.1 credit/tx gTFA rate and "unlimited retention" are undocumented and unverifiable — the 21.6M-tx backfill cost model is unverified at its load-bearing point** |
| DefiLlama Pro | — | $300 one month, optional | Not needed for E1 |
| Binance / Bybit | — | — | **Geo-blocked** (HTTP 451 / CloudFront). `data.binance.vision` is a different host and was never probed |
| This rig's own AMM tape | **≈2.6 complete-day-equivalents**, one complete day (07-27) | already paid | Population is fresh pump.fun graduates — the dead cohort. Does not answer the established-pair question |

**n-observations arithmetic for the swing horizon.** Cross-sectional correlation across 13
memecoins is ρ̄ = 0.756 at 1d → **N_eff = 1.29**; residual ρ̄ = −0.069 → **N_eff_resid =
11.09**, and the eigendecomposition confirms no hidden second factor (top residual factor
15.7% of variance, participation ratio 10.08), so the **8x power multiplier from trading
residuals is real**. Under matched φ=1 at H=24h: **78 days for n_eff=100, 155 days for
n_eff=200** (i.e. an in-sample half plus a genuine holdout). Against **403–1,200 free HL
daily bars per coin, n is not the binding constraint** — the finder's "258/513 days, you
cannot reach the holdout inside two years" was an artifact of applying φ=0.3 to directional
and φ=1.0 to cross-sectional.

**Time to first honest answer, wall-clock, plainly:**

- **The hurdle (E0): 2 hours, today.** No data required. It excludes four of six families
  before a line of code.
- **The funding panel (E1): one working day, $0.** All endpoints verified live and already
  known to work. This is the whole answer for the one unmeasured family.
- **Swing cross-section: zero waiting days.** 403–1,200 days of history already exist and
  78–155 are needed. It was tested twice, from two directions, and killed twice.
- **LP arb pot (E2): ~1 day + $49**, and only if E1 clears.
- **Anything requiring new forward capture: 78–155 days minimum**, and this rig has never
  demonstrated 24 consecutive hours of correct recording — it recorded 1.6 hours of 08-08
  and reported 11.6, undetected. **Treat every forward-capture proposal as 155 days plus an
  unknown reliability discount until the heartbeat exists.**

**The honest summary of the data question: nothing here is gated on data. Both families
were measured on free data and both lost.**

## How to test it

There is **no backtest of either family yet**. What follows is a research programme, not a
result. Paper only.

### The bar a candidate must clear — write this down first (E0, 2 hours, no data)

The single highest information-per-dollar action available, and the swarm's largest process
failure: **no minimum-acceptable-return was ever written down, so no candidate was ever
compared to an alternative use of the money.**

- Passive floor: **Kamino USDC supply 3.5–9%/yr** (typical 4–5%), **Solana native staking
  5.7–7%/yr** — call it **5%/yr at ~zero operational burden**.
- Risk premium for: contract risk, rug risk, delisting risk (**~40% meme-perp mortality**),
  short gamma, jump risk, tax drag (**~1.5%/yr**), and this operator's demonstrated
  inability to record 24 consecutive hours.
- **Bar: 15%/yr net = $566–$1,133/yr on this bankroll.**

Apply it retroactively and the swarm closes itself: **C1 fails by 10x** ($38–$76/yr net);
F1's whole LP band fails on sign (−0.8 to −8.6%/yr); F3's swing programme fails at $14/day
expected against $237/day one-sigma; F1's Q-screen fails at $6–9/yr on 5 SOL. **Nothing in
this project should ever again be measured to three decimals without this number at the
top of the page.**

### E1 — the memecoin perp funding panel. $0, one day. This is the experiment.

**Why this and nothing else:** it is the only unmeasured parameter that **three separate
areas independently named as decisive** (F2: "if funding is 20–100%/yr it dominates the LP
core"; F3's C3 and its funding-sign correction; F4's FUND-CARRY, listed as the cheapest
remaining test and never run). It costs $0 on endpoints already proven working. It
simultaneously prices the hedge leg of the only positively-signed candidate in the swarm
(C1), the standalone basis family nobody examined, and F3's C3. **And it is the only test
whose plausible upside clears E0's bar** — Hyperliquid's documented structural funding is
**11.6% APR to shorts**, against a C1 core of ~1%/yr net. *The hedge leg is 10x the
business it was hedging, and nobody priced it.*

**Minimum viable harness.**

1. Pull hourly `fundingHistory` from Hyperliquid for all **12 tradeable meme perps plus
   every delisted one** — `isDelisted` is exposed and delisted candles still serve, which
   is what makes the universe point-in-time and is exactly what the rest of the corpus
   lacks (every dataset in all five areas is survivor-selected: F1 15 live pools, F2 46
   live, F3 24 survivors, F4 19 pools).
2. Join to hourly candles with `Math.round(t/3600000)*3600000`. **Without this 99.2% of
   rows silently drop** and the run looks fine.
3. Add **Drift** on-chain funding for **WIF, BONK, POPCAT** — the only venue where the
   actual established Solana memecoins are hedgeable, unreachable to F3 (HTTP 403) and
   unchecked by F2. This is also the load-bearing check on X6.

**What gets computed, in this order.**

- **(a)** Realized 365d mean funding received by a short in each name, net of **4.5bp/side**
  entry and exit, **decomposed into HL's structural +11.6%/yr interest component versus the
  premium component.** Only the premium is information; the interest component is the
  venue's published schedule, available to any account, and competed toward the spot
  financing rate. **F3 already reported the structural component as a discovery — its
  "sign error correction" (short receives ~2.8bp/day ≈ 10.3%/yr) is 94% of the published
  schedule. Do not repeat that error.**
- **(b)** top5 **name** share and top5 **month** share of aggregate carry, against the ≤60%
  law.
- **(c)** The same series inside the −73.2% window versus any earlier window, because the
  sign of the premium is regime-conditional and the measured regime is the one where the
  crowd is net short.

**In-sample / holdout.** Universe and split date **pre-registered before looking**. One-bar
implementable lag from the first line. **No area in this swarm ever held out a genuine
holdout — F3 chose universe, liquidity cut, rebalance clock, K and hold all on the full
sample; F4's reversal cleared every gate and died to a one-bar lag. This one must hold
out.**

**What gets recorded, per row:** timestamp (rounded), coin, `isDelisted` at that timestamp,
funding rate, decomposed interest vs premium component, mark and index price, OI, the HTTP
status and error body of every request (a failed request is a datum — this is F4's silent-
429 lesson), and hours-covered/24 for the pull.

**Kill condition, stated in advance.** *The pivot is dead outright if the **premium
component** of funding received by a short has a 365-day mean **below the financing rate on
the same collateral (≈5%/yr)**, point-in-time including delisted names, at **n≥100
independent coin-months** with **top5 ≤60%**.* That result means: (i) there is no standalone
carry business — the only available "yield" is HL's published interest component, free to
everyone and arbitraged by cash-and-carry; (ii) C1 is permanently a ~1%/yr business, one
fifth of a USDC deposit, and the domination identity below closes the LP family for good;
(iii) F3's C3 has no economic mechanism behind its replicated sign; (iv) with fee/LVR ≤1 on
four independent ledgers, directional swing gross-negative OOS in two independent tests, and
no carry, **there is no construction left in either family. Stop building.**

**Pre-visible outcome, flagged so the result is not oversold either way.** The corpus
already contains weak evidence pointing at the kill: F3 measured the short leg of its
dollar-neutral meme book receiving **1.86bp/day = 6.8%/yr, below HL's 11.6%/yr structural**,
across n=2,479 rebalance-days — which implies a **negative average premium** on memecoin
perps in this regime. If E1 confirms that, it is confirmation, not surprise.

**Converse.** If the premium clears ~15%/yr net with breadth, the correct trade is **neither
LP fee farming nor directional swing** — it is the standalone basis book, which needs no
tape, no recorder, no decoder and no CAPTURE-1, and the pivot should be redefined around
it. Three caveats that make this a real test rather than free money, all of which the
harness must handle: it is a **gross** carry against a spot financing leg (Solana memecoin
spot cannot be borrowed, so you only earn the full carry on capital you already hold); the
premium can swamp the interest component in either direction (HL's own guidance is
±0.001%/hr quiet vs 0.05%+/hr in rallies = 438%/yr); and HL caps funding at **4%/hour**
with the JELLY precedent on a 3x-max cross-margin book.

### E2 — fallback, only if E1 clears. ~1 day, $49.

Measure the **daily arb pot per established pool** from Helius per-swap data using F2's
identity **LP net = −(arb profit + tips + gas)**. It converts the **[0.03x, 3x]
two-order-of-magnitude** adverse-selection band into a measured number and is the only
direct empirical answer to the LP question. **Do not run it first:** its best-case outcome
(Q slightly above 1) is worth $138–$276/yr, and its cost model is unverified at its
load-bearing point.

## Build order (max 5)

1. **Write down the hurdle (E0). ~2 hours, no data, no code.** Fix the minimum acceptable
   net return at **15%/yr = $566–$1,133/yr** and put it at the top of every future brief.
   It retroactively excludes four of six families in this corpus, including the swarm's own
   best candidate, and it would have closed the pivot on day one for the price of one web
   search. Highest information-per-dollar action available anywhere in this document.
2. **Build the HL + Drift memecoin perp funding panel (E1). ~1 day, $0.** The single
   largest omission in the swarm and the cheapest thing in it to measure. Prices the only
   number in the corpus that is plausibly large (11.6%/yr structural + an unmeasured
   premium), simultaneously settles C1's hedge leg, F3's C3, and F4's FUND-CARRY, and
   carries a pre-registered kill condition that closes the pivot if it fails. Must include
   delisted names and Drift, or it repeats the survivor bias that flatters every other
   dataset here.
3. **Ship the wall-clock hours-covered/24 heartbeat on the recorder. ~half a day.** Not a
   strategy build — **data integrity, and it ships regardless of every verdict in this
   document.** The rig recorded 1.6 hours of 08-08 and reported 11.6, and
   ReserveContinuity detects that at 0.03%. Headline hours-covered/24 on every report, fail
   the day on any minute-level gap. **Every measurement this rig makes about anything is
   worthless until this exists.** This is the only piece of CAPTURE-1 that survives.
4. **Point-in-time universe construction, as a reusable utility. ~one afternoon, $0.**
   Every dataset in all five areas is survivor-selected and each area calls its own result
   "an upper bound of unknown size"; none quantified it. The fix is proven free:
   GeckoTerminal resolves **874/874** dead pools by address, HL exposes `isDelisted` and
   still serves delisted candles. This converts every "upper bound" in the corpus into a
   number and is a prerequisite for E1 being honest.
5. **Only if E1 clears: E2 arb-pot measurement ($49, ~1 day), and QUOTE-LADDER ($0).** Both
   are conditional. If E1 kills, neither is worth the day.

**Explicitly NOT on the list:** the 60-day 1s L2 recorder (would measure adverse selection
on an edge already gross-negative OOS); CAPTURE-1 beyond the heartbeat (hygiene on a
deprecated fresh-graduate tape); any Tier-3 social/attention vendor feed (unfalsifiable);
the 21.6M-tx Helius backfill (cost model unverified at its load-bearing point); any DLMM bin
simulator (κ-invariance closes it and the rent correction does not resurrect it); and **any
further re-measurement of Q, fee APR or LVR — their dispersion already exceeds the business
they describe.**

## Updated LAWS (bind all future work in this family)

- **THE HURDLE LAW (new, and it supersedes precision).** Every strategy brief opens with the
  minimum acceptable net return and the passive alternative: **Kamino USDC 3.5–9%/yr, SOL
  staking 5.7–7%/yr, bar 15%/yr net = $566–$1,133/yr on this bankroll.** A candidate whose
  *ceiling* is below the bar is dead before its sign is measured. **The 07-24 cost-floor law
  is replaced by this in both new families** — cost was binding when edge and cost were the
  same order of magnitude; here the loss term is 100–1000x transaction cost.
- **CEILING BEFORE SIGN (new).** Compute the dollar ceiling of the *best case* before
  arguing about the sign. Five areas spent a day on Q = 0.49 vs 1.03, LVR ±3x and an
  adverse-selection multiplier spanning 100x, on a business whose best case was $276/yr
  gross. **A business whose measurement error exceeds its signal by an order of magnitude is
  not a business regardless of the sign.**
- **DELTA-HEDGED LP IS STRICTLY DOMINATED (new).** **delta-hedged LP = cash-and-carry basis
  trade + (fees − LVR).** You are long the token through the pool and short it through a
  perp; the LP wrapper contributes exactly (fees − LVR), and every measurement of that term
  in this corpus is ≤0 or ~0. Therefore whenever **Q ≤ 1**, the wrapper is a *cost paid to
  obtain exposure available more cheaply* — no locked rent, no 548%/yr hedge-maintenance
  turnover, no 4–16%/yr rebalance turnover, no range management, no contract risk, no short
  gamma. **This closes the LP family without needing any of the disputed Q arithmetic.**
- **QUOTES ARE NOT FILLS (07-24 law, re-violated in three of five areas).** **No agent
  produced a single fill or fill-replay anywhere in this swarm.** Any Solana spot quote
  below 10bp is unfillable until a fill proves otherwise — sub-1bp round trips are
  arithmetically below the cheapest fee tier (0.01%) and are RFQ principal MMs quoting
  indicatively. Binding figures: **0.58% round trip at 100 SOL, WIF 0.33% at 2.5 SOL,
  POPCAT ~0.53%.** A failed quote is a datum and must be logged.
- **IL ≠ LVR (new).** IL is path-independent (endpoint price ratio only); LVR is
  path-dependent (an integral of squared returns). Their ratio is realized-variance-over-
  the-path divided by squared-net-move, measured at **~3.2x** on this rig's own tape.
  Quoting LVR at an *unhedged* candidate is a category error; so is quoting endpoint IL at a
  *hedged* one. For unhedged LP the benchmark is hold-the-basket and the binding term is the
  **√r directional exposure, median x0.644 per SOL deposited**.
- **CONCENTRATION IS LEVERAGE ON A RATIO, NOT AN EDGE (new).** κ = 41.49/21.48/14.82 at
  ±5/10/15% with fee/LVR **unchanged**. Narrowing multiplies whatever Q is; at Q ≤ 1 it
  multiplies a loss, and it adds 526–876 out-of-range exits/yr earning zero fees on
  already-realised divergence (median p5–p95 range 1.36x — out-of-range is the normal
  state). **The only mechanism that can break κ-invariance is a fee rate that responds to σ
  — which exists only on Meteora DLMM, and is untested.**
- **SELECTING ON FEE APR IS SELECTING ON VOLATILITY (new).** β=0.45 → volume ~ σ^0.90
  against LVR's σ², so **Q ~ σ^−1.10**. Fee APR persists because volatility persists; both
  legs move together and the ratio moves *against* you. Every "high-yield pool screen" is
  this, and it was killed twice directly.
- **THE REGIME ARGUMENT CUTS ONE WAY (new).** "Wait for the bull" is refuted for LP by the
  elasticity above — the awaited regime raises the loss term twice as fast as the income
  term, so **LP fee farming's best regime is the one we measured**. For swing, the only
  regime that ever paid was a rally, which is unforecastable by construction. Regime
  diversity would make the LP numbers *worse* and would *test* the swing numbers. It rescues
  neither.
- **TESTABILITY DECLARATION (new).** **What can be tested is dead; what is alive cannot be
  tested.** Diffuse daily-frequency signals are testable inside this rig's lifetime (78–155
  days) and every one in this corpus was tested and killed. Rare-event signals with a
  surviving sign need ~15 years at ~4 independent events per 7 months. **Every future
  proposal must declare which side of that line it is on before it starts.**
- **MEAN, NOT MEDIAN (new).** A portfolio earns the mean. On this rig's own tape the mean is
  **26–71x worse than the median** (net vs HODL: median −0.85%, mean −20.61%). A median made
  a catastrophic distribution look marginal — the second family in a row where this
  happened. Report both, allocate on the mean.
- **HOURS-COVERED/24 ON EVERY REPORT (new).** The rig recorded 1.6 of 24 hours and reported
  11.6, undetected; ReserveContinuity detects this at 0.03% by construction. Any analysis
  that does not open with wall-clock coverage is inadmissible. Same class as silent 429
  truncation, which returns a normal JSON body with no `data` key and stops a collector at a
  random depth with no error.
- **POINT-IN-TIME OR IT IS AN UPPER BOUND (new).** Survivor selection is free to fix
  (GeckoTerminal 874/874 dead pools by address; HL `isDelisted` + delisted candles served).
  An un-fixed survivor-selected result must be labelled "upper bound of unknown size" in its
  headline, not in its appendix.
- **PRICE THE HEDGE LEG FIRST (new).** In any construction with a perp leg, measure funding
  before measuring the strategy. Here the hedge leg (11.6%/yr structural) was **10x the
  business it hedged** (~1%/yr net) and went unmeasured by ten agents. And **decompose it**:
  a venue's published interest component is not a discovery.
- **TAX IS A LINE ITEM (new).** ~1.5%/yr at 30% ordinary on 5% gross fee APR — **half the
  entire measured net**. LP rebalancing and hourly perp funding are both high-frequency
  ordinary-income events. On a 1–3%/yr business it is decisive.
- **THE RIG'S COMPARATIVE ADVANTAGE MUST BE NAMED (new).** No area asked what this rig is
  uniquely good at, and neither proposed family uses any of it — LP is passive capital
  allocation with no latency component (gas 0.012% of position, ~33 re-centers/yr) and
  daily-frequency swing uses no execution edge. **The pivot proposed to compete on capital
  and research quality, the two things a $7,552 book with a six-month losing record is worst
  at.** That framing error sits upstream of every result in this document.
- **Still binding, carried forward from 2026-07-24:** honest fills both sides; the measured
  cost floor including invisible lines; **n≥100**; in-sample-pick / holdout-confirm with the
  split pre-registered; **top5 ≤60%**; per-day stability; the phase/clock artifact law (now
  extended to rebalance-hour); and "a candidate that inverts under a one-bar implementable
  lag was never an edge."

## Dead ends registry (do not respend)

**LP fee farming on established Solana memecoin pairs — the family.** Q-screens on fee/LVR
(Q does not persist: Spearman mean +0.002, no top-k cell above 1.00) · volatility-conditional
LP (killed by its own test at its own bar) · passive index-style LP as a yield sleeve (a wash
at best, negative after rent and tax) · fee-APR/TVL-lag harvesting (IS +24.37% → OOS −1.39%)
· LVR-screens applied to unhedged positions (wrong inequality; the √r term decides) ·
delta-hedged full-range CPMM LP (dominated by plain cash-and-carry at Q≤1; ceiling $38–$76/yr
net) · DLMM bin simulators and falsification harnesses (κ-invariance; circular acceptance
test) · concentrated/narrow DLMM ranges as an edge (leverage on a losing ratio; out-of-range
is the normal state) · LP emissions farming on DefiLlama-visible Solana pools (15 of 2,665
pools carry apyReward>0, **none** on established memecoin pairs) · **any further
re-measurement of Q, fee APR or LVR**.

**Directional swing on established memecoins — the family.** Cross-sectional memecoin
momentum (**0 of 120 configs**) · short-horizon cross-sectional reversal (passes every gate at
lag 0, dies at a one-bar implementable lag) · liquid-12 daily reversal with maker execution
(clock artifact; OOS −7.46bp/day gross-negative before fees) · SOL-beta hedge overlays as a
*candidate* (zero-EV by construction — retained only as a three-line reporting rule) ·
funding-extreme continuation (sign replicated, **~15 years to n≥100 independent events**) ·
migration birth-cohort swing on fresh graduates (−4.88% at the stated 12h horizon; 17% of
clock hours contain any trade) · top-6 liquid universe (wrong sign in 17 of 24 phases) ·
answering the established-pair question from the fresh-graduate tape (reqBps is an asset
property, not a venue property).

**Infrastructure and spend.** The 60-day 1s L2 recorder · CAPTURE-1 beyond the
hours-covered/24 heartbeat · the 21.6M-tx Helius backfill (cost model unverified at its
load-bearing point) · any Tier-3 social/attention vendor feed (LunarCrush / Santiment / TIE
claims unverified and unfalsifiable) · Binance and Bybit direct APIs from this machine (451 /
CloudFront) · QUOTE-LADDER until E1 clears · buying data for F3's C3.

**Methodological rediscoveries — the same three pathologies as 07-24, in a new asset class.**
A phase/clock artifact (`daily()` silently selecting UTC hour 0 of 24 and landing 2nd-best at
+1.8σ) · an in-sample pick that inverts out of sample (+24.37% → −1.39%; +2.221% → −0.118%) ·
top5 concentration (212% coin share, 91% pool share, 142% of aggregate P&L). **The swarm did
not discover new physics in a new asset class; it re-derived the same pathologies. That is
evidence the binding constraint is the search process, and changing the asset class does not
touch it.**

**Still open, and deliberately so.** Memecoin perp funding premium, point-in-time, on HL and
Drift (E1 — the one thing to build). Meteora DLMM's volatility-responsive fee rate as the only
structural route to Q>1 (named by F1, tested by nobody; DefiLlama carries zero Meteora pools,
so a $59.3M/day venue is absent from every dataset here). Market making on memecoin perps —
**20–50bp spreads against a 1.5bp maker fee is a 13–33x gross ratio, the only place in this
corpus where the ratio points the right way by an order of magnitude, and it got zero coverage
across five areas.** Its likely killers are all measurable and none was measured: OI of
$135k–$261k/name means the quoted book *is* the market, a $2,500 clip is 1–2% of it, inventory
sits in a 3x-max cross-margin account, and the spread is wide precisely *because* of adverse
selection from informed flow. Whether any of this machinery is worth anything on an asset
class where σ is a third as large — **the binding constraint measured everywhere in this
document is σ² in the loss term plus 97% mortality, and both are asset-class properties, not
strategy properties. The pivot fixed *memecoins* and searched strategies. Nobody questioned
the asset class, and it is the cheapest reframe available.**
