# Krypt Sniper — Two-Front Implementation Plan (Edge + Speed)

## 1. Summary

Krypt Sniper loses on two fronts at once, and this plan attacks both. On the **edge** front, the 133-trade paper record proves our opportunity score barely separates winners from losers (avg 60.5 vs 59.2) and, worse, that the 20/100 momentum "flow" component actively rewards the losing direction — more buyers, more inflow, more acceleration are all *marks of the local top we keep buying*. The fix is not a tweak but an inversion: replace monotonic momentum with band-shaped "crowd" scores plus hard upper caps, add a dedicated sell-pressure component (the single strongest clean separator in the data), reward the 10–20% curve-entry band, and add a genuinely new token-supply-concentration axis using event data we already decode but throw away. On the **speed** front, the hot path (`detect→decode→score→decide`) runs synchronously on the Electron main loop with an O(trades²)-per-token `refreshFlow`, an unconditional score compute on every trade, full flow/recording work for already-decided tokens, and a blocking `appendFileSync` on disk — all fixable with small, low-risk reorders and incrementalization, no native deps. Latency infrastructure (racing free WS providers, a Yellowstone gRPC adapter) comes *after* the edge fix, because the data is explicit that winning the race harder just buys tops faster: latency budget must buy **earlier curve entry** (17.7% vs 20.4%), not faster hype-chasing.

## 2. The Data Verdict

Our 133 trades (57 wins / 76 losses) say the current strategy is systematically backwards on every feature that actually separates:

| Signal | Winners | Losers | What the code does today | Plan response |
|---|---|---|---|---|
| Sells in window | 0.75 avg; `sells==0` wins 48.5% | 1.65 avg; any-sell wins 27.8% | Only a weak penalty at `sells>3` (scoring.ts L66) | Dedicated **sellPressure** component (0..18) + `maxSells`/`maxSellVol` gates (#3) |
| Sell volume (SOL) | 0.63 avg | 2.0 avg; `>1 SOL` wins 25.9% | Not scored directly | Folded into sellPressure slope (#3) |
| Curve entry % | 17.7% avg; 15–20% wins 58.3% | 20.4% avg; `>20%` wins 34% | `liquidity = curve/20*10` — rewards LATER entry, backwards past 20% | **entryTiming** band 10–20%, reject outside `[min,max]` (#4) |
| Unique buyers | 10.4 avg | 12.1 avg; `13+` wins 31% | `buyerScore = buyers/25*8`, monotonic reward | **crowd** band + `maxUniqueBuyers` reject (#2) |
| Net inflow (SOL) | 15.0 avg | 17.3 avg; `18+` wins 26.7% | `inflowScore`, monotonic reward | **crowd** band + `maxNetInflowSol` reject (#2) |
| Buyer acceleration | — | `1.01–1.6` wins only 20% | `accel>=1` is a **hard gate** (engine.ts L622) — filters toward hype | Drop the gate; delete accelScore (#2) |
| SOL-weighted top-buyer share | 0.232 | 0.234 — **does not separate** | `distribution` 0..15 (scoring.ts L41-42) | Replace with **token-weighted** concentration (#5) |

The plan's north star, in-sample: a contrarian gate (`sells==0 & curve<20 & sellVol<0.5`) keeps 66/133 trades at 50% win with *higher* total PnL (0.60 vs 0.54 baseline at 42.9%). Every new threshold ships as a tunable `StrategySettings` knob, and the recorder keeps writing raw flow so v2 can be honestly re-fit — the 133 samples are too few to hardcode against.

## 3. Strategy Changes

Each item below survived adversarial verification. Overfit guard is stated per item; the global guard is *every threshold is a knob, defaults conservative, raw flow keeps recording for re-fit*.

### 3a. Data plumbing: capture per-trade token amounts (kept as-is)
- **Change**: Extend `TrackedTrade` to `{at,user,isBuy,sol,tokens}` where `tokens = Number(ev.tokenAmount)/1e6`. Add to `TrackedToken`: `tokensByUser: Map<string,number>` (buys add, sells subtract), `firstTradeAt`, `firstSeenByUser: Map<string,number>`. Update in `onTrade`.
- **File/function**: `engine.ts` — `TrackedToken` (L36-57), `onTrade` (L511-548, currently drops `tokens` at L517), `onCreate` init.
- **Why**: `pumpDecoder.decodeTrade` already parses `tokenAmount` and both virtual reserves; `onTrade` L517 keeps only `sol`. This is the missing axis — SOL-weighted top-buyer share fails to separate (0.232 vs 0.234) because early snipers buy SOL-light but token-heavy. Confirmed: L517 pushes `{at,user,isBuy,sol}` only.
- **Effort**: S. **Overfit guard**: pure additive state, no new event fields, bounded by `uniqueBuyers` (~10-12); enables honest re-fit of #5.

### 3b. Sell-pressure component (kept — top-ranked edge fix)
- **Change**: New `ScoreBreakdown.sellPressure` (0..18). In `refreshFlow` compute `sellRatio = sellVolumeSol/(buyVolumeSol+ε)` and `distinctSellers`. Score: start 18; if `sells==0` keep 18; else `clamp(18 - sellVolumeSol*9 - sells*1.5 - distinctSellers*1.0, 0, 14)` — any sell caps at 14 so a clean book strictly dominates. Add gates `maxSellsInWindow` (default 1) and `maxSellVolumeSol` (default 0.6). Retire the L66 penalty. Keep `creatorSold` hard-reject.
- **File/function**: `scoring.ts` (new component, retire L66), `engine.ts` `refreshFlow` (L562-595), `shared/types.ts` (LiveFlow + ScoreBreakdown + StrategySettings).
- **Why**: Largest raw separation measured — `sells==0` 48.5% vs any-sell 27.8%; winners 0.75 sells / 0.63 SOL vs losers 1.65 / 2.0.
- **Effort**: S. **Overfit guard**: graded slope, not a cliff; thresholds are knobs so borderline books aren't all rejected.

### 3c. Entry-timing curve band (modified — widen the band)
- **Change**: Rename `ScoreBreakdown.liquidity → entryTiming` (0..12) `= 12 * tri(curveProgressPct, lo, peak, hi)`. Add `entryCurveMinPct` (default 4) and `entryCurveMaxPct` (default 22); reject outside `[min,max]`. Replaces `curve/20*10`.
- **File/function**: `scoring.ts` (liquidity block L50-52), `engine.ts` `qualifies()`/`explainPass()`, `shared/types.ts`.
- **Why**: `curve 15-20%` wins 58.3% vs `>20%` 34%; winners enter at 17.7% vs losers 20.4%. Current formula gives *more* points the later you enter — verified backwards past 20%.
- **Effort**: S. **Overfit guard (modification)**: verification flagged `peak=15/max=22` as in-sample; keep the *inversion* certain but ship band edges wide and tunable, not fit-to-133.

### 3d. Invert momentum → crowd band + hard upper caps (modified — flatten bands)
- **Change**: Delete monotonic `buyerScore`/`accelScore`/`inflowScore`. New `crowd` (0..8) = `8*0.5*(buyersBand + inflowBand)` with wide-plateau `tri()` bands. **Drop `buyerAcceleration>=1` from `qualifies()` entirely** (engine.ts L622). Add caps `maxUniqueBuyers` (14) and `maxNetInflowSol` (22) as `qualifies()` rejects.
- **File/function**: `scoring.ts` (flow block L44-48), `engine.ts` `qualifies()` (L619-624) + `explainPass()`, `shared/types.ts`.
- **Why**: `uniqueBuyers 13+` wins 31%; `netInflow 18+` wins 26.7%; `accel 1.01-1.6` wins 20%. The 20/100 flow score rewards exactly the losing direction; the `accel>=1` gate (confirmed at L622) filters *toward* hype.
- **Effort**: M. **Overfit guard (modification)**: verification says peaks (8 buyers / 12 SOL) are fit to 133 — flatten to wide plateaus, ship every edge as a knob, regression-test that legit steady launches near peak still qualify.

### 3e. Token-supply concentration + early-buyer/bundle detection (kept — weight conservatively)
- **Change**: New `LiveFlow` fields `topHolderTokenShare`, `top5HolderTokenShare`, `earlyBuyerShare` from `tokensByUser` (#3a). New `concentration` (0..15). Knobs `maxTopHolderShare` (0.25), `earlyBuyerWindowMs` (2000), `maxEarlyBuyerShare` (0.45) as rejects. Compute `earlyBuyerShare` from `firstSeenByUser` timestamps (survives the 400-trade trim).
- **File/function**: `scoring.ts` (distribution block L39-42 → concentration), `engine.ts` `refreshFlow` (token-share loop), `shared/types.ts`.
- **Why**: SOL-weighted top-buyer share verified useless (0.232 vs 0.234); research says bundle/early-buyer concentration predicts dumps. New axis a token-weighted share catches (cheap early snipers).
- **Effort**: M. **Overfit guard**: untested on *our* win/loss — weight conservatively; persist first-buy time per user so trimming `trades[]` doesn't lose early buys.

### 3f. Bonding-curve velocity — instrument now, gate later (modified — log only)
- **Change**: Compute `curveVelocitySolPerSec` in `refreshFlow` (O(1) using `firstTradeAt` + reserves) and **log it to the recorder decision payload**. Do **not** ship it as a scoring gate yet.
- **File/function**: `engine.ts` `refreshFlow`, recorder `decision` payload.
- **Why**: Verification: peak/hi are admittedly guessed from an inflow proxy and largely redundant with #3d's inflow cap and #3c's timing band. `netInflow>18 SOL` (~>1.2 SOL/s) already wins only 26.7%.
- **Effort**: S. **Overfit guard (modification)**: defer as a gate until measured from logged velocity; guard the denominator with `max(elapsed, 1s)`.

### 3g. Async social-link metadata fetch — advisory only (modified — low weight, off by default)
- **Change**: New `electron/engine/metadata.ts`: `fetchSocials(uri)` with LRU cache, concurrency ~4, `AbortController` timeout `socialFetchTimeoutMs` (1200ms), 64KB cap, guarded `JSON.parse`. Fire-and-forget from `onCreate` (the `checkMint` L495 pattern), **never awaited in `maybeDecide`**. `computeScore` reads `token.socials`; unresolved → award URI-presence only (fail-neutral). Knob `requireSocials` default **false**.
- **File/function**: `metadata.ts` (new), `engine.ts` `onCreate` + `TrackedToken.socials`, `scoring.ts` metadata block (L54-57), `shared/types.ts`.
- **Why**: External research cites 8.9–17.4x graduation lift from social links; current metadata score only checks `hasUri`/`nameOk` (L54-57, presence-only).
- **Effort**: M. **Overfit guard (modification)**: lift is external, not validated on our win/loss — ship advisory-only at low weight, `requireSocials=false`, unresolved never blocks; re-fit weight once logged.

### 3h. v2 weight table + ScoreBreakdown/qualifies rewrite (modified — no minScore bump)
- **Change**: `ScoreBreakdown` v2 = `{safety 0..18, creator 0..15, concentration 0..15, sellPressure 0..18, entryTiming 0..12, crowd 0..8, metadata 0..8, smartWallet 0 stub, penalties, total}` summing to 100. Reduce safety 20→18, creator 20→15 to fund sellPressure/entryTiming. `qualifies()` v2 = conjunction of all gates (score, sells, sellVol, buyers-band, inflow-band, curve-band, topHolderShare, earlyBuyerShare, optional socials). Update `emptyFlow()`, `explainPass()`, recorder `decision` payload, `DEFAULT_SETTINGS`. **Grep `src/**` for `.distribution`/`.flow`/`.liquidity`** and update `Launches.tsx`/`Ticker.tsx`/`types.ts` in the same change (renderer contract break — confirmed by verification).
- **File/function**: `scoring.ts` (whole `computeScore` + `ScoreInputs`), `shared/types.ts`, `engine.ts` (`maybeDecide`, `qualifies`, `explainPass`, `emptyFlow`, recorder payload).
- **Why**: Umbrella that wires 3a–3e into a coherent 100-point table and rewrites the conjunction gate.
- **Effort**: L. **Overfit guard (modification)**: verification says **drop the in-sample `minScore 55→58` bump** — keep 55; keep recording raw flow; validate `total` clamps 0..100.

## 4. Speed Changes

All CPU-only, no native deps, main-loop relief. Two proposals were **cut**: worker-thread offload (#13 — speculative ~30ms/sec burst cost, structured-clone of bigints adds its own cost, large reconnect/marshalling surface; revisit only if profiling proves parse is the bottleneck) and the `decideDue` min-heap (#15 — the twice-a-second scan of ≤300 entries is admittedly negligible once #4c lands). `accountSubscribe`-for-exits (#19) also cut: `marketFor` already reacts to reserves on every decoded trade, no latency win.

### 4a. Compute score only after cheap flow gates pass (kept)
- **Change**: In `maybeDecide`, run the hard-reject/creatorSold checks and the cheap boolean flow gates **first**; call `computeScore()` only when those pass and score is the last remaining gate. Refresh `t.row.score` for the UI on the throttled push path, not every trade.
- **File/function**: `engine.ts` `maybeDecide` (L597-624), `scoring.ts` `computeScore`.
- **Latency win**: Removes `computeScore` + its `i.flags.filter(...)` allocation (confirmed L26) from the majority of trades that fail the gates. Verified: `computeScore` runs on every trade at L599 *before* the `qualifies` conjunction at L619.
- **Effort**: S. Pure short-circuit reorder — the `qualifies` conjunction is semantically identical.

### 4b. Skip flow/score/recording for terminal non-open tokens (kept)
- **Change**: In `onTrade`, gate `refreshFlow`/score/priceHistory/UI-push/`recorder.record('trade')` behind `!t.decided OR token backs an open position`. Keep the reserve update, `creatorSold` detection, and `positions.onTradeFor` **unconditional**.
- **File/function**: `engine.ts` `onTrade` (L511-548), `marketFor` (L769-789).
- **Latency win**: Biggest per-trade CPU reclaim — rejected tokens keep trading their full window but their row is terminal. Verified: `refreshFlow`/priceHistory/`record` all run before the `t.decided` branch (L530-542 precede L545); `marketFor` reads reserves/trades directly, not `t.row.flow`, so flow recompute is pure waste for held tokens too.
- **Effort**: S. Correctness bound: keep reserve-update + `creatorSold` + `positions.onTradeFor` unconditional.

### 4c. Async recorder disk writes (kept)
- **Change**: Replace `fs.appendFileSync` in `flush()` with an async append serialized through a single in-flight promise chain (or a lazily-opened per-day `WriteStream`), keeping 200-record / 1s batching. Keep a **final synchronous flush on `engine.stop()`** (L218) so no buffered records are lost.
- **File/function**: `recorder.ts` `record` (L34-44), `flush` (L46-60).
- **Latency win**: Removes a synchronous disk write from the hot thread — a disk stall (AV scan, slow SSD) directly stalls feed ingestion and entry latency. Verified: `appendFileSync` at L56.
- **Effort**: S. Correctness bound: serialize the in-flight chain so lines stay ordered.

### 4d. Optimize base58Encode (modified — encoder now, cache deferred)
- **Change**: Rewrite `base58Encode`: preallocated fixed-size `Uint8Array` scratch (44 for a 32-byte key) instead of a `push`-grown `number[]`, and build output from a fixed char array + `join` instead of `+=` concatenation. **Ship the encoder speedup alone**; keep the repeat-wallet LRU cache optional/measured.
- **File/function**: `base58.ts` `base58Encode` (L8-30), `pumpDecoder.ts` `Reader.pubkey` (L83-87).
- **Latency win**: `Reader.pubkey` runs per pubkey per event (2/trade, 4/create); current routine is O(bytes×digits) with one allocation set per pubkey.
- **Effort**: M. **Guard (modification)**: verification says LRU hit-rate is unproven — ship encoder now (pinned against existing PDA/fixture tests for exact leading-`1` handling), keep cache behind a measured flag.

### 4e. Incremental refreshFlow — O(buyers) not O(trades) (kept)
- **Change**: Maintain running windowed aggregates on `TrackedToken` (buys/sells/buyVol/sellVol decremented in the exact `t.trades.shift()` branch at L520; `topBuyerSol`/`totalBuySol` on `buyersBySol` writes; `firstSeenByUser`). `refreshFlow` copies scalars in O(1) and computes acceleration by iterating `firstSeenByUser` (~10-12) not the full `trades[]` (up to 400). Mutate a reused flow object; copy only at the UI push boundary.
- **File/function**: `engine.ts` `TrackedToken` (L36-57), `onTrade` (L511-548), `refreshFlow` (L562-595), `decideDue` (L717-725).
- **Latency win**: `refreshFlow` is called on every trade (L530) and loops all of `trades[]` + `buyersBySol` — ~T²/2 iterations per token (≈80k at T=400). Iterating ~10-12 buyers is 15-30x fewer. Deletes the per-call `emptyFlow()` + two `new Set()`.
- **Effort**: M. Sequenced **after** the scoring changes settle (they redefine which aggregates flow needs). Correctness bound: decrement windowed counters in the exact `shift()` branch; pin flow values against recorded JSONL fixtures.

### 4f. Keep 'processed' + detection-latency instrumentation (kept)
- **Change**: **Do not** move to 'confirmed'. Add a measured latency field to each flow snapshot the recorder writes: per-provider arrival delta (from the racing pool, #4h) + transport tag (`ws`/`grpc`).
- **File/function**: `feed.ts` (expose provider/transport tag on `receivedAt`), `engine.ts` `maybeDecide` (add latency + transport to the recorder decision payload).
- **Latency win**: Measurement, not a direct win — turns latency from a guess into a column correlatable with win/loss. 'processed' (~400ms) vs 'confirmed' (~2-3s) would be fatal for launch sniping.
- **Effort**: S. Report the *relative inter-provider delta* (clock-independent) as primary; absolute latency advisory only.

### 4g. Endpoint/region config surface (kept)
- **Change**: Replace the single hard-coded url/commitment with a config-driven ordered endpoint list `{url, transport, region}`; startup RTT probe (1-2s timeout, first-endpoint fallback) picks lowest-RTT; ship free defaults (US-East + EU) and let paid users drop in a gRPC URL.
- **File/function**: `feed.ts` constructor, shared config/types, `engine.ts` startup.
- **Latency win**: Prerequisite config surface for the racing pool; removes tens of ms of avoidable RTT.
- **Effort**: S.

### 4h. Race 2-3 free WS providers, dedupe by signature, keep first (kept)
- **Change**: Promote `FeedManager` to a multi-socket pool: N (2-3) simultaneous `logsSubscribe` connections to different free providers, all routed through **one shared** `seen`/`seenOrder` deduper, forward earliest arrival per signature. Record `(provider, receivedAt)` per signature. Keep `onLogs`/`onState` callback shape unchanged so `engine.ts` is untouched. Cap at 2-3, config-driven, degrade to single socket on 429.
- **File/function**: `feed.ts` (pool + hoisted `Deduper`).
- **Latency win**: min(provider latency) per event — attacks per-provider jitter (50-150ms) at $0. Verified: dedupe already exists.
- **Effort**: M. Correctness risk nil (only ever forward the earliest); main cost is free-tier credit burn (mitigated by the cap).

### 4i. Yellowstone gRPC adapter behind FeedCallbacks (kept — paid-optional ceiling)
- **Change**: New `grpcFeed.ts` implementing the same `{onLogs,onState}` contract, using a Yellowstone/Dragon's-Mouth subscription with a server-side filter on `PUMP_PROGRAM_ID` at commitment 'processed'. Select transport at startup from config (WS default). Map protobuf tx-update → `LogNotification`.
- **File/function**: `grpcFeed.ts` (new), `feed.ts` (export shared types + WS/gRPC factory), `engine.ts` startup.
- **Latency win**: gRPC p90 ~5ms slots / ~215ms accounts vs WS ~10ms / ~374ms; ~50-150ms and fewer missed updates. `feed.ts` header already declares this adapter shape.
- **Effort**: L. Not an immediate win — keep WS default/fallback; protobuf→log-line mapping is a real correctness risk (decode the Anchor event from the instruction data path).

### 4j. Document: do NOT pursue shred-level detection (kept — doc only)
- **Change**: Record the decision in `feed.ts` research notes. Jito ShredStream sunsets 2026-09-05 and needs keypair approval + UDP:20000 proxy — too heavy for a free desktop app. If ultra-low latency is ever needed post-paper-trading, target DoubleZero Edge, not ShredStream.
- **Why**: The data shows we buy tops, so winning the race harder buys tops faster. Latency must buy earlier curve entry (17.7% vs 20.4%), not faster hype-chasing — fix scoring/entry first.
- **Effort**: S. Zero code.

## 5. Implementation Order

Ordered so each item builds + verifies independently, highest-value and lowest-risk first, dependencies respected (plumbing before concentration; scoring settled before incremental flow; config before racing pool; umbrella after its components).

1. **Sell-pressure component** (#3b, strategy, S) — the single largest clean separator; ship as a knob-tunable slope.
2. **Score only after cheap flow gates** (#4a, speed, S) — pure short-circuit reorder, near-zero risk.
3. **Skip flow/score/recording for terminal non-open tokens** (#4b, speed, S) — biggest per-trade CPU reclaim.
4. **Entry-timing curve band** (#3c, strategy, S) — invert a formula verified backwards; widen the band into knobs.
5. **Token-amount plumbing** (#3a, strategy, S) — cheap additive state; unblocks #10 and re-fit recording.
6. **Async recorder disk writes** (#4c, speed, S) — remove `appendFileSync` from the hot thread; keep final sync flush on stop.
7. **Keep 'processed' + latency instrumentation** (#4f, speed, S) — log inter-provider delta + transport tag.
8. **Invert momentum → crowd band + hard caps** (#3d, strategy, M) — remove the 20pt flow reward and `accel>=1` gate; flatten bands to plateaus.
9. **Optimize base58Encode** (#4d, speed, M) — encoder rewrite pinned against PDA fixtures; cache deferred.
10. **Bonding-curve velocity — instrument/log only** (#3f, strategy, S) — O(1) compute, defer as a gate until measured.
11. **Token-supply concentration + early-buyer detection** (#3e, strategy, M) — new axis from #5; weight conservatively.
12. **Async social-link metadata fetch — advisory only** (#3g, strategy, M) — off hot path, fail-neutral, `requireSocials=false`.
13. **v2 weight table + ScoreBreakdown/qualifies rewrite + renderer update** (#3h, strategy, L) — integrate 1-12; keep `minScore=55`; update `Launches.tsx`/`Ticker.tsx`/`types.ts`.
14. **Incremental refreshFlow O(buyers)** (#4e, speed, M) — after scoring is stable; pin against JSONL fixtures.
15. **Endpoint/region config surface** (#4g, speed, S) — prerequisite for the racing pool.
16. **Race 2-3 free WS providers, dedupe, keep first** (#4h, speed, M) — min(provider latency) at $0.
17. **Yellowstone gRPC adapter behind FeedCallbacks** (#4i, speed, L) — paid-optional ceiling; WS stays default/fallback.
18. **Document: deprioritize shred-level detection** (#4j, speed, S) — research note, zero code.