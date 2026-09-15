# Recording plan: do blue-chip round trips clear 1.5%?

> **RESOLVED 2026-09-14 — do not build this. See `docs/bluechip-hurdle-2026-09-14.md`.**
>
> The answer is no, and it was reached the same day from free backfilled
> history plus 42 Jupiter quotes: no recording, no dedicated key, no
> `TERMS_VERSION` change, nothing written to disk. The median best exit
> available anywhere in the next 30 minutes — with perfect foresight — covers
> 43–74 % of the round-trip cost, and every first-touch rule tested is
> net-negative by 1.35–1.88 % per trip.
>
> §5(a) and §5(b) below were both executed. §5(c) is moot. **§5(d) — store the
> quote next to the fill — is the one item still worth doing.** The §4
> recorder-collision analysis remains correct and remains unneeded.

## 0. The question, restated so it is measurable

"Clear 1.5%" has to mean **net of everything**, or the study answers nothing. The stack this app imposes:

| Component | Size | Source |
|---|---|---|
| Krypt fee, both sides | **100 bps** | `shared/fees.ts:27` `FEE_BPS = 50`, charged per side |
| LP/route fee + spread + price impact, both sides | measure it — this is the unknown | Jupiter route |
| Priority fee + optional Jito tip | 1–10 bps at 2 SOL notional | `feeEstimator.ts`, `jitoTips.ts` |
| Quote-to-fill slippage | **one observation exists** | `jupiterRoute.ts:231` |

So the hurdle is `100 + rtCost + fees`, and a 1.5% *net* round trip needs roughly a **2.6–3.0% gross move** inside the holding window. That is the number the plan has to be built around, and it is worth saying before anything is built: 100 of those basis points are self-inflicted.

---

## 1. What to record, and from which venue

### Venue: Jupiter's route, not a pool

For a deep coin the app's execution path *is* `electron/engine/jupiterRoute.ts` (`/swap/v1/quote` → `/swap/v1/swap`). Recording a Raydium or Orca pool directly would measure a venue the app never trades alone. Record the pool identity as a *field* (`routePlan[].swapInfo.label`), not as the source.

### Primary instrument: the round-trip probe (`rt_probe`)

Every cycle, for each (mint, size), two quote calls and one record:

```
leg A: inputMint=WSOL outputMint=M amount=S_lamports  → T tokens, impactA, routeA
leg B: inputMint=M outputMint=WSOL amount=T           → L' lamports, impactB, routeB
rtCostBps = (1 - L'/S) * 10_000
```

`rtCostBps` is the **entire immediate friction of a round trip at that size on the route that would actually execute** — spread, both impacts, both LP fees — in one unbiased number, with no modelling. It needs no wallet, signs nothing and spends nothing.

The forward return is the same arithmetic across time: hold `T` from leg A at time `t`, re-quote leg B at `t+h`, and `netBps = 10_000 × (L'_{t+h}/S − 1) − 100 − priorityBps`. That is literally the round trip the question asks about. **No candle-to-fill inference anywhere.**

Fields per record: `mint`, `sizeLamports`, `outAmount`, `backLamports`, `impactA/B`, `otherAmountThresholdA/B`, `routeA/B` labels, `contextSlot` (if present), `ms` per call, local `at`.

### Control coin: USDC

Include a WSOL→USDC→WSOL probe at every size. USDC has essentially no directional move over a 5-minute horizon, so its `rtCostBps` distribution **is the measurement noise floor and the pure-cost floor**. If the study later reports a 40 bps edge and the USDC control also drifts 40 bps, the study is measuring its own instrument. This single line costs 2 calls a cycle and is the difference between a result and a story.

### Coin set (6 + control)

JUP, WIF, BONK, JTO, RAY, PYTH + USDC. SOL itself cannot be in the set — it is the quote asset. Sizes: **0.5 SOL and 5 SOL**, chosen to bracket where impact starts to bite; the difference between them *is* the depth measurement.

### Secondary instrument: setup features (`bc_pair`)

The probe series gives returns, realised vol and cost-widening, but not flow. The cheapest flow source the app already owns is **DexScreener's batch route** (`dexscreener.ts:204 tokenInfoMany`, ≤30 mints per call, documented 300/min): one call returns, for all seven coins at once, price, liquidity USD, and `txns.m5.buys/sells` + `volume.m5` — i.e. an aggressor-imbalance and volume-surge series for **one HTTP call per poll**. This is the best cost-per-feature ratio available and is already batched and shipped.

### Tertiary: independent mid (`bc_bar`)

`geckoterminal.ohlcvOn(pool, '1m', …)` per pool, low rate, as a cross-check that the probe's executable price tracks a published mid. Also the only volume series with real history.

### Deliberately NOT recorded in Phase 1–2: the pool trade tape

There is no Raydium/Orca/Meteora decoder in this repo (`ammDecoder.ts` is pump-amm only). Getting per-trade flow on a blue-chip pool means `logsSubscribe(mentions=[poolAddress])` plus one `getTransaction` per signature, decoded by generalising the balance-delta logic in `electron/engine/walletSwap.ts` from "the wallet" to "the pool's vaults" — which does work and is the right eventual design. Cost: ~40 tx/min/pool × 4 pools ≈ **2.7 rps of `getTransaction`**, plus 4 more pubsub connections against a cap that §2 of `docs/api-swarm-2026-09-09.md` measured at **exactly 10 of 10 already used** on `api.mainnet-beta`. Not worth it until the cheap phases say there is something to explain.

---

## 2. Feed and cost per day

### The binding constraint is Jupiter, and it is tighter than it looks

`electron/data/http.ts:348` derives Jupiter's window from its own gap:

- **keyless `lite-api.jup.ag`**: 120 ms gap → **500 calls/min** — but Jupiter's own migration doc says this host is being retired.
- **keyed `api.jup.ag`**: 1000 ms gap → **60 calls/min, total, shared with everything.**

"Everything" on a keyed install includes the portfolio price build, Discover, the watchlist, the orders/alerts poll (B7/E2 — *the stop-loss price source*) and the sell path itself. A research probe at 36 calls/min would take 60% of that. `docs/ratelimit-swarm-2026-09-06.md` E3 records that a Jupiter 429 gets exactly **one** retry at 1.2 s before an order dies.

**Therefore, two non-negotiable conditions before this runs on anyone's machine:**

1. The probe uses its **own provider id and its own free Jupiter key**, so it gets its own 60/min bucket rather than eating the trade path's.
2. A hard interlock: **the probe suspends whenever any position is open or any advanced order is armed.** A research feature must never be upstream of an exit.

### Three configurations

| | Coins×Sizes | Cadence | Jupiter calls/min | % of a dedicated 60/min key | Calls/day |
|---|---|---|---|---|---|
| **Pilot** | 3 × 1 (2 SOL) | 60 s | 6 | 10% | 8,640 |
| **Study** | 7 × 1 (2 SOL) | 30 s | 28 | 47% | 40,320 |
| **Fast** | 7 × 2 | 15 s | 112 | 187% — **keyless host only** | 161,280 |

Recommendation: **Study**. "Fast" only survives on `lite-api`, which is on a retirement path, so building the study on it is building on sand.

Companion feeds at Study config:

| Feed | Rate | Documented limit | Share of budget | Calls/day |
|---|---|---|---|---|
| DexScreener batch (all 7 mints, 1 call) | 1 / 30 s | 300/min | **0.7%** | 2,880 |
| GeckoTerminal 1m OHLCV, 7 pools, staggered | 1 / 30 min / pool → 0.23/min | 28/min window (`http.ts:294`) | **0.8%** | 336 |

Total new external traffic: **~43,500 calls/day**, of which 93% is on a key dedicated to the probe. Nothing else moves by more than 1% of its budget. No new websocket, no new pubsub connection, no RPC load at all.

---

## 3. How long it must run

Two independent calculations, both landing in the same place.

**As a hit-rate test.** The decision is whether the win probability under the setup beats the break-even implied by the payoff. For a target of +1.5% against a stop of roughly −0.75%, break-even is p ≈ 0.35. Distinguishing p = 0.35 from p = 0.45 at α = 0.05 one-sided with 80% power needs

```
n = (1.645·√(.35·.65) + 0.84·√(.45·.55))² / 0.10²  ≈  144
```

**As a mean-return test.** 5-minute log-return σ on WIF/BONK is roughly daily σ (~9%) / √288 ≈ **0.55%**. To detect a post-cost mean of +0.15% at t = 2: `n = (2·0.55/0.15)² ≈ 54`. To detect +0.05% — which is what a marginal edge looks like — `n ≈ 480`.

Take **300 setup instances** as the working floor: enough for the hit-rate test with margin, enough for a ±0.06% standard error on the mean.

**Converting to calendar time.** A setup restrictive enough to be interesting (a real 2.5%+ candidate move) fires maybe 3–6 times a day per coin on WIF/BONK, far less on JUP/PYTH. Seven coins ≈ 20–25 instances/day. But they are **not independent** — all seven co-move with SOL, so effective sample is roughly half. That is ~12 effective instances/day → **300 / 12 ≈ 25 days**.

Then the regime argument, which dominates the arithmetic: a momentum setup's entire result is a function of whether the month trended or chopped. Twenty-five days is one regime. So:

- **30 days** = the arithmetic floor. Produces a number.
- **60 days** = the minimum at which the number means something, because it spans at least one regime turn.
- **< 150 instances** = a story, not a result. Report it as such.

And pre-register the setup before looking at the forward returns. With 300 trips and 30 candidate setups you will find a winner by construction.

---

## 4. Disk, against the 2 GB cap — and the collision

Per-day volume at Study config:

| Stream | Rows/day | Bytes/row | MB/day |
|---|---|---|---|
| `rt_probe` | 20,160 | ~380 | **7.7** |
| `bc_pair` (7 mints × 2,880 polls) | 20,160 | ~240 | **4.8** |
| `bc_bar` (closed 1m bars, deduped) | 10,080 | ~110 | **1.1** |
| **Total** | | | **~13.6 MB/day** |

Sixty days ≈ **820 MB**. Fine in isolation. It is not in isolation:

**Collision 1 — the prune deletes whole days, and it cannot tell the streams apart.** `recorder.ts prune()` globs `*.jsonl`, sorts by filename and deletes **whole day files** oldest-first under `recorderMaxGb` (default 2, `shared/types.ts:999`). Everything lands in one `${day}.jsonl` (`recorder.ts flush()`). So if the pump launch tape is also on at its measured **1.2 GB/day** (`LAUNCH_MODE_MEASURED_GB_PER_DAY`), the 2 GB cap holds **~1.6 days**, and it will delete a day file containing 13.6 MB of irreplaceable blue-chip rows in order to reclaim 1.2 GB of pump rows. A 60-day study is structurally impossible in that file.

**Fix:** give the probe its own directory with its own cap. `recorder.init()` already takes a `customDir`; a second recorder instance pointed elsewhere with a 1 GB ceiling gives 70+ days and prunes independently. A prefix-aware prune inside the shared directory is *not* sufficient — oldest-first across mixed prefixes still evicts the wrong file.

**Collision 2 — new kinds silently vanish.** In launch mode (the default when recording is on), `launchRecorder.ts` drops any kind that is neither in `ALWAYS_KEEP` (line 41) nor a trade inside a tracked mint's 30-minute window. `rt_probe`, `bc_pair` and `bc_bar` are none of those. They will be counted in `droppedByKind` and written nowhere. Either add them to `ALWAYS_KEEP` or, better, keep them out of that filter entirely by using the separate stream above.

---

## 5. What is answerable cheaply, first — in this order

**(a) Free, today, zero recording: the unconditional hurdle rate.**
`geckoterminal.ohlcvOn(pool, '1m', limit)` accepts up to 1000 bars per call. One added query parameter — `before_timestamp`, currently not plumbed in `geckoterminal.ts:73` — turns it into a pager. **30 days of 1-minute history for seven coins is ~260 calls**, about 9 minutes at the 2.1 s gap, inside the 28/min window. From it, compute directly: how often does a 2.6–3.0% gross move occur inside a 5 / 15 / 30-minute window, unconditionally? If that rate is near zero, **no setup can rescue it** and the project ends for the price of 260 HTTP calls. (Unverified: how far back the free tier serves minute data. One probe call settles it.)

**(b) Three days of `rt_probe`, ~23 MB: the actual hurdle.**
The cost side converges in days, not weeks — `rtCostBps` at a fixed size is stable intraday. Three days gives the median and the tail of round-trip friction per coin per size, plus the size curve from 0.5 vs 5 SOL. Adding 100 bps of Krypt fee produces the real hurdle number. If WIF at 5 SOL already costs 70 bps round trip, the hurdle is 170+ and requirement (a) becomes 3.2%.

**(c) Three days, free: is the free OHLCV mid a valid proxy for the executable price?**
Run (b) and (c) in the same window and regress `rt_probe` mid against the 1m close. If they agree within a few bps, **the whole 60-day study can be done on backfilled history instead of forward recording**, and the answer arrives in a day instead of two months. This is the highest-leverage item in the plan.

**(d) Free, already flowing: quote-vs-fill residuals.**
The study's entire target is 150 bps and it rests on a fill model with **exactly one observation** (`jupiterRoute.ts:231`, a fill 11% under quote on 2026-09-11). The ledger already derives cost basis from on-chain lamport deltas (`ledger.ts`, per the `pnl-from-chain` rule), so every real trade the user makes already contains a quote-vs-fill residual — it is simply not stored next to the quote. Recording that pair costs nothing and calibrates the haircut the study needs. Without it, phase 2 will report an edge in quote-space that may not exist in fill-space.

---

## 6. What makes this a bad idea — plainly

1. **100 of the ~160 bps you are fighting are our own fee.** The dominant term in the hurdle is a toll this app charges. Renegotiating the fee for a strategy class would move the answer more than any amount of data collection. That should be decided before, not after, two months of recording.

2. **The product is manual execution only.** Per the product-direction and terminal-pivot memos, the user clicks. A quote-to-quote study measures the round trip of something that reacts in milliseconds. On a 5-minute momentum trade on a blue chip, human reaction time is a material fraction of the target move, and the study as designed will overstate the achievable edge by an amount nobody has measured.

3. **Quotes are not fills, and the correction is unknown.** See (d). A 150 bps target with an uncalibrated fill haircut is a study that can produce a confident wrong answer.

4. **Deep coins are efficient and the app has no latency edge.** The 85 GB pump archive exists because the edge there is structural — new tokens, no incumbents, information that is minutes old. On JUP/WIF/BONK you are trading against colocated participants through a public RPC and a retail router. The prior on finding a 150 bps repeatable round trip is low, and it should be stated before the work rather than discovered after it.

5. **Jupiter is the wrong provider to add sustained load to.** It is a retiring host (`lite-api`), its successor is 1 rps total, it had no window entry at all until recently, and it is on the sell path. This plan mitigates that with a dedicated key and a positions-open interlock — but the mitigation is a requirement, not a nicety, and if it is skipped the first symptom will be a stop-loss that could not get a price.

6. **Disclosure.** The probe contacts Jupiter continuously with a fixed coin list. §7 of `docs/api-swarm-2026-09-09.md` already records that the hash-pinned privacy policy undercounts outbound hosts, `lite-api.jup.ag` among them. A new continuous background feed needs the policy updated and a new `TERMS_VERSION` — this cannot ship silently.

7. **Opportunity cost.** The same 30–60 days of attention spent on the pump archive works against 73,890 already-collected launches with a held-out AUC of 0.92 (`docs/insight-swarm-2026-08-30.md`). This plan spends two months to reach n ≈ 300.

**Recommended stop rule:** run (a) and (c) this week. If the unconditional 5/15/30-minute hurdle-clearance rate is under ~2%, or if the OHLCV proxy fails to track the probe, do not build phase 2.