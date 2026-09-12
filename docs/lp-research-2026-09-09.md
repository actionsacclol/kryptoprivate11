# Liquidity pools: researched, killed, and what it found on the way

Seven researchers on: find pools across all three chains, notify on volume,
auto-farm, rebalance, take fees, and copy LP wallets.

**Verdict: build none of it.** The finder, the volume alerts, the auto-farm,
the rebalancer and the LP-wallet copier are all dead. What survives is one
column added to the Rewards page that already exists.

This was not a fresh question. `docs/farming-swarm-2026-08-15.md` killed LP fee
farming across eleven agents and left binding LAWS and a dead-ends registry.
The swarm was scoped to what those left open, and everything it opened, it
closed.

---

## 1. Why each piece died

**Volume notifications — the request inverts itself.** Prior work measured
`volume ~ σ^0.90` against LVR's `σ²`, so `Q ~ σ^−1.10`. **Selecting on fee APR
or volume is selecting on volatility.** A finder that alerts on volume surfaces
the worst pools risk-adjusted and calls them opportunities. Confirmed live:
sorted by 24 h volume, **31 of GeckoTerminal's top 40 Solana pools have TVL
under $1** — one shows $100.9M volume against $0.00000045 of liquidity.

**The headline rate is an artefact of the window.** SOL/USDC fee APR reads
**279.38% / 73.11% / 84.07%** at 24 h / 7 d / 30 d, independently reproduced
against Raydium's own API (278.15 / 73.57 / 62.27).

**Incentivised LP does not escape it — the sponsors re-impose it by hand.** The
$41,519/day headline campaign is not a pot to take a share of: its distribution
method is `MAX_APR` with a hard-coded 4.75%, and its neighbours run
`SOFR_SPREAD_RATCHET` and `DUTCH_AUCTION`. Those set a *rate*; the daily spend
floats to whatever holding it costs. **91% of chain 4663's entire subsidy is
contractually capped at 3.30–4.75%** — at or below the Kamino passive rate the
HURDLE LAW measures against. Ceiling by risk class is monotone: ~5% stables,
85% equity-vs-equity, 273% crypto-stable, 454% memecoin. The subsidy is priced
by risk like everything else. BNB is dead outright at $208/day chain-wide.

One pool advertising 842% APR has attracted **$2,322 in 43 days**, sitting one
contract away from $757M earning 4.75%. That standoff is the cleanest proof
available that the headline is not what a depositor receives.

**Concentrated ranges cannot pay.** On a ±10% range the maximum the price
movement can EVER contribute is **+2.70%**; on ±2% it is **+0.51%**. Everything
else must come from fees, which stop the moment you leave the range — and a ±2%
range on SOL/USDC was **outside on 90 of 90 days**. Out of range you hold 100%
of one asset: a token −50% leaves you **−31.5% against holding**; a +900% move
leaves you **−81.3%**. An honest description of a concentrated position is a
standing order to buy the token all the way down and sell all of it before the
rally.

**Impermanent loss has no favourable direction.** LP ÷ hold = `2√r/(1+r)`,
symmetric: −5.72% at both a 2× up and a 50% down, **−25.5% at 5×, −42.5% at
10×**. The only zero-loss case is the price returning exactly to entry.

**Copying LP wallets is incoherent, not merely unprofitable.** A pool's
aggregate LP return over a window is a fixed number set by the price path. A
copier does not earn a second copy of the leader's return — it subdivides the
same number and reduces the leader's share by what it takes:
`Q_f = Q_leader · (L_l+L_o)/(L_l+L_o+L_f)`, both terms falling. **Two people
can both be right about a swap; two people cannot both collect the same fee.**
And the leaderboard needed to pick leaders is uninformative by construction:
corr(LP net, price direction) **0.936** vs corr(LP net, fees) **0.414**.
Ranking liquidity providers ranks token-picking. The top row is a JIT bot with
92% share whose positions live one block.

**Auto-farm breaks four safety properties at once.** Every breaker in the app —
the daily-loss stop, `lossCapHit`, `ScriptBudget.maxLossSolPerDay` — is
denominated in **realised** SOL from reconciled fills. Impermanent loss is
unrealised by definition, so an auto-rebalancer can bleed the book without
moving any number a breaker reads. That is the Warmer's "0.000 SOL realised"
bug in a new costume. The fee interlock is buy-shaped and has no LP basis, so
LP would be the only unbilled, uninterlocked signing path in the app. The EVM
chains have **no breakers at all**. And Uniswap v4 and Raydium CLMM have no
collect instruction — you harvest by resizing with zero delta, so **you cannot
rebalance without realising fees**, which under the tax-is-a-line-item law is
decisive on its own.

**Paper mode would be impossible to do honestly.** Paper is truthful today
because a real simulation feeds it. For LP, only the *open* has that property;
fees, IL and range state need a per-pool tape that is already in the dead-ends
registry. Tiers 2 and 3 would ship live-only — a first for this app.

## 2. Data notes worth keeping

- **DefiLlama is legally closed to us.** §7 personal, non-commercial; §8.10
  forbids commercial use without written consent; §14 liquidated damages up to
  **$100,000 per violation**. Per-user IPs do not help — the licence runs to
  the end user.
- Its coverage is also holed: **zero Meteora pools across all 17,187 rows**
  (the yields adapter is broken, while TVL carries $312.5M), **no PumpSwap**
  ($332M), and `orca-dex`'s 708 pools carry no fee tier at all.
- The venues' own APIs are better than assumed: Meteora's
  `dlmm.datapi.meteora.ag` serves realised 24 h fee income and
  `dynamic_fee_pct`; Raydium v3 and Orca v2 serve fee rate and income directly.
  **"We cannot get the data" was never available as a reason to decline.**

## 3. What it found in shipped code — the real return on this swarm

Three live bugs, all fixed, none of them about liquidity pools:

1. **A liquidity add decoded as a BUY** (`walletSwap.ts`). One-sided add: SOL
   out, position NFT in — indistinguishable from a purchase by balance delta.
   A live copier would have bought an untradeable mint and opened a leader
   round trip that could never close. The withdraw direction had the same flaw
   and was worse, because sells are deliberately ungated. Now guarded both
   ways on "exactly one indivisible unit", so a real 0-decimal trade still
   decodes.
2. **Transfer-fee and default-frozen tokens warned the bot but not the user.**
   `risk.ts` (automation) recognised five dangerous Token-2022 extensions;
   `mintExtensions.ts` (user-facing) recognised three. A token taxing every
   transfer told the person nothing. Now matched, and the fee is quantified.
3. **`Retry-After` could SHORTEN a park.** GeckoTerminal answers
   `Retry-After: 0`, which floors to 2 s and *replaced* the 20/40/80 s
   escalation — so the provider we have the least budget with was the one we
   re-entered fastest. Now extend-only.

And one gap left deliberately open, written up separately: **the Solana signer
allowlists at program granularity**, and already contains Raydium CLMM, Orca
Whirlpool and Meteora DLMM (added for routing). A swap through Orca and a
deposit into Orca are the same program. Nothing downstream distinguishes them.
The fix is an instruction-discriminator rule, and it needs real captured route
transactions to enumerate legitimate discriminators — getting that list wrong
blocks selling, and **a limit never blocks an exit**.

## 4. What shipped instead

**One column on the Rewards page: "with yours".** A published APR is the pot
divided by what is already deposited; the column recomputes it with your
deposit in the denominator. On a large pool it barely moves; on a small one it
halves — which is exactly where the biggest headline numbers come from.

It is labelled a pessimistic bound and the page's guide says why: rate-targeted
campaigns do not dilute at all, we cannot tell which is which from the
opportunities endpoint, so the column shows the worse of the two rather than
guessing the better one.

## 5. Added to the dead-ends registry — do not respend

LP pool finder as a ranked list · volume or fee-APR notifications · any
`fee APR − σ²/8` style ranking (this is the construction that already went
+24.37% in-sample to −1.39% out) · incentivised LP on chain 4663 and BNB ·
auto-farm, auto-rebalance and auto-collect in any tier · copying LP wallets ·
an LP-wallet leaderboard · DefiLlama as a data source (licence).

**The last open thread from 2026-08-15 is now CLOSED.** That swarm named a
σ-responsive fee rate as "the only structural route to Q>1, named by F1, tested
by nobody". It has now been tested, and it does not open.

*The mechanism*, from Meteora's own docs and the `lb_clmm` source, verified to
the digit against decoded on-chain `StaticParameters`:

    variable fee (%) = (variable_fee_control / 10^10) · Δ_bps²

A pure quadratic in realised displacement, with **bin step cancelling out
entirely**. It does not close on arithmetic — the best-case ceiling clears the
bar — so the sign had to be measured.

*The measurement*, 122 pools and 366 observations, within-pool elasticity of the
fee rate to σ, de-meaned per pool across nested windows:

| | measured | required |
| --- | --- | --- |
| Elasticity of fee rate to σ | **0.273** | **1.10** |

So `Q ~ σ^−0.83` against σ^−1.10 static: the dynamic fee softens the decay by
about a quarter and **does not change its sign**. Every bin-step subgroup is
below the threshold. The level shift is a median **1.14×** — *less than simply
switching Orca fee tiers* (25→80 bps is 3.2×, with no σ-coupling at all).

Two results worth keeping. **κ and the dynamic fee are anti-correlated in range
width and do not stack** (κ ∝ 1/w, uplift−1 ∝ w², so the net has an interior
*minimum*) — that is precisely why it cannot rescue κ-invariance. And a clean
**placebo**: DAMM v2 pools with the dynamic fee switched off measure a 1.001×
uplift through the identical pipeline, which validates the estimator.

It also corrects the corpus twice: the mechanism is **not DLMM-only** (DAMM v2
ships the same formula, though 79.6% of its top pools leave it disabled), and
**the "no data" premise was wrong** — Meteora runs a free unauthenticated Data
API at 30 RPS (`dlmm.datapi.meteora.ag`, 125,040 pools; `damm-v2.datapi`,
136,036) with nested fee/volume windows, OHLCV and realised position PnL.
DefiLlama's zero coverage was an artefact, not an absence. Three silent-failure
traps are documented there, including **Cloudflare 403ing Python's default
User-Agent**, which returned zero rows twice before diagnosis.

Caveat carried honestly: **n = 1 day**, 24/24 hours covered, split-half spread
0.358 vs 0.127 — fragile in magnitude, never near the threshold. A
pre-registered 14-day, $0 cron test is specified in the raw report so nobody
can re-derive a pass by choosing an estimator.

## 6. A reusable rule this produced

**Your position must satisfy `b < P × L`** — deposit below the campaign's
remaining pot — or round-trip price impact exceeds everything winnable. Worth
carrying into any future incentive work.

---

Raw reports: `scratchpad/lp/{incentivised,dlmm,finder,copy,build,risk,venues}.md`
plus `coordinator-signer-gap.md`.
