# Wallet identity — 2026-07-25

Feasibility test for the last unbuilt item on the 07-24 list (persistent
cross-day wallet ids). Run *within* one day, where ids are trivially
persistent — the cheapest possible version of the asset. Strict train/test
split at the day's median buy time; selection uses only the first half.

Data: 2,184,025 `tape_trade` records, 26,953 mints, 112,021 distinct buyers,
1,150,277 buys with a +60 s mark. Script: `…scratchpad\wallets4.mjs`,
`copytrade.mjs`.

## Wallet skill is real

Selecting wallets on the first half and evaluating on the second:

| min train trades | keep | wallets | test buys | mean +60 s | win | vs baseline |
|---|---|---|---|---|---|---|
| — | baseline | — | 575,139 | −2.41% | 39.4% | — |
| 3 | top 10% | 2,541 | 15,789 | +24.41% | 36.7% | **+26.8pp** |
| 5 | top 10% | 1,578 | 16,192 | +11.28% | 34.7% | +13.7pp |
| 10 | top 10% | 798 | 15,170 | +11.41% | 33.3% | +13.8pp |
| 20 | top 10% | 392 | 12,922 | +12.50% | 32.6% | **+14.9pp** |

**Spearman(train mean, test mean) = 0.2503** over the 5,597 wallets with ≥5
buys in both halves. That is not noise. Wallet identity carries persistent,
out-of-sample predictive signal — the first thing in this project to survive a
clean holdout.

Note the shape: selected wallets have a **lower** win rate than baseline
(32.6% vs 39.4%) with a much higher mean. The entire effect is right tail.

## And it is not harvestable

Copying those wallets — see their buy, enter at the first print at/after a
follow latency, hold, book net of the 4.5% floor, one entry per mint:

| follow | hold | selection | n | mean | median | win | SOL @0.1 |
|---|---|---|---|---|---|---|---|
| 500 ms | 60 s | ≥20 tr, top 10% | 2,268 | −4.87% | −30.98% | 22.1% | −11.04 |
| 1000 ms | 60 s | ≥20 tr, top 10% | 2,265 | −4.56% | −29.14% | 22.1% | −10.34 |
| 2000 ms | 60 s | ≥20 tr, top 25% | 3,665 | −2.47% | −14.53% | 22.1% | −9.07 |
| 500 ms | 180 s | ≥20 tr, top 10% | 2,268 | −11.66% | −40.26% | 16.9% | −26.44 |

**All 24 configurations lose**, from −2.47% to −18.98% per trade. Follower win
rates are 15–22% against the selected wallets' own 33%, and the median
follower trade is **−15% to −41%**.

## Why the two results are consistent

The wallets' returns are measured from *their* fill. A follower gets the next
print, and that print is already gone — the same ~26% instantaneous gap
measured in `tape-audit-2026-07-25.md`, where the first print after any signal
sits 26% above the price the signal evaluated at.

So the effect is **price impact, not information**. Good wallets look good
because their own buying, and the wave it triggers, moves the price they are
measured against. There is nothing left for someone arriving 500 ms later.

This also explains the prior swarm's 0.448x "specialist" effect that A4 called
*"id-level selection on realized outcomes"* — A4 was right, and this is the
mechanism. It is not that persistent ids were missing; it is that the quantity
persistent ids measure is unharvestable by construction.

**Verdict: building the cross-day wallet asset for entry signals is not
justified.** The within-day test is the best case (ids perfect, no decay), and
the best case is decisively negative. Retire copy-trading and specialist
overlays as an edge hypothesis.

The asset may still be worth building for other reasons — attribution,
detecting who is on the other side of our fills, rug forensics. Just not for
entries.

## Standing back: the pattern across all four levers

| lever | signal real? | harvestable? | where the value sits |
|---|---|---|---|
| entry gates / flow features | weak (Spearman 0.245) | no | consumed by the 15 s confirmation window |
| graduation / post-migration | **yes, large** | no | taken in the migration block (one observed 1,935 SOL buy, ~700×) |
| proven-creator tag | **yes, 8.5× lift** | no | value is post-migration, i.e. the block above |
| wallet identity | **yes, ρ=0.25** | no | it *is* the price impact |

Four independent edges, all real, none reachable. They are not reachable for
the same reason each time: the value is realised in the interval between a
signal being observable and an order being fillable — ~26% of price, against a
4.5% cost floor and a best-ever measured gross drift of +3%.

That is a structural position, not a search problem. Nothing in the strategy
space fixes it, which is consistent with 7,500 configs and one independent
re-derivation all landing in the same place.

What would change it is infrastructure that moves us to the other side of that
interval — block-level priority (staked connection, top-of-block bundle
landing) and size enough to be the participant creating the gap rather than
the one paying it. That is a different project with a real capital
requirement, and it should be costed honestly before anything else is built.

## Registry additions (do not re-spend)

Copy-trading and wallet-selection overlays · cross-day wallet ids **for
entries** · post-migration entry at any achievable delay · proven-creator
entries on or off curve.
