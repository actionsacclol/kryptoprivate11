# Krypt Terminal — Manual-path speed plan (2026-09-01)

Scope: everything a MANUAL trader touches — order latency, chart open/tick latency,
renderer responsiveness, and the network layer under all three. The auto-sniper
feed plan (`docs/edge-speed-plan-2026-07.md`) is separate.

Four code traces (order path, chart path, renderer/IPC, network) were run and every
top-ranked item below was re-verified by hand against the file:line cited. Line numbers
are as of commit 1efebff (beta.6).

## 0. Measured baseline (real trades, `logs/app.log`, 2026-08-29)

| Order | build | tips | sim | send+confirm | total |
|---|---|---|---|---|---|
| manual buy, local builder (cold) | 478 | 595 | 257 | 953 | 2336 ms |
| manual buy, relayer | 399 | 182 | 88 | 707 | 1395 ms |
| manual sell, relayer | 434 | 219 | 87 | 711 | 1502 ms |
| manual sell, relayer | 459 | 167 | 130 | 683 | 1456 ms |

`send` is the whole `broadcastAndConfirm` wait (`liveSigner.ts:706-708`), i.e. broadcast
PLUS the confirmation poll — not the send itself. The chain's own ~400 ms slot to land is
the floor; everything above it is ours.

Realistic warm target after Tiers 1–2: **build ≤150 · tips 0 · sim ~90 · send+confirm
400–550 → ~0.65–0.85 s**, and the fill visible in the UI the moment it lands.

Chart: no first-paint measurement exists at all (no `performance.mark` anywhere in
`src/`). Instrument first (§1).

---

## 1. Instrument first (S, do before anything else)

- `TradeTiming` (`liveSigner.ts:189-203`) already measures build/tips/sim/send. Add a
  `confirm` split (send RTT vs time-to-land), print `sign`, attach `timing` to failure
  results and to `recorder.record('live_trade'|'manual_sell')` (`engine.ts:1002,1742`).
- Renderer: `performance.mark` at `Token.tsx:229` (candles fetch start), `:232`
  (`setSeries`), `KryptChart.tsx:302` (first `setData`); a `PerformanceObserver`
  (`longtask`) logging to the Console page.
- Main: `Date.now()` deltas in `market.candles` (`market.ts:1172`) and `candlesTail`
  (`:1364`); log them at DEBUG.

---

## 2. Tier 1 — order path (ranked by ms saved ÷ effort)

### 2.1 Tuned undici dispatcher + lane prewarm/heartbeat on arm — S, ~100–250 ms per cold hop
Every network call is bare global `fetch` (`rpcClient.ts:25`, `relayer.ts:57`,
`broadcast.ts:327`, `jitoTips.ts:23`, `feeEstimator.ts:35`, `http.ts:251`). Node/undici
defaults: `keepAliveTimeout` **4 s** (`node_modules/undici/lib/dispatcher/client.js:230`),
HTTP/1.1, `pipelining 1`. `sender.helius-rpc.com`, `mainnet.block-engine.jito.wtf` and
`pumpportal.fun` are touched ONLY at trade time → cold DNS+TCP+TLS on every order.
`arm()` (`engine.ts:2021-2050`) does zero network work.

Change: in `main.ts` bootstrap, `setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000,
keepAliveMaxTimeout: 600_000, connections: 16, allowH2: true, connect: { timeout: 3000 } }))`.
On arm (and every ~30 s while armed) fire a trivial request at the RPC host and each
enabled lane host. `undici@6.28.0` is already in `node_modules`.

### 2.2 Nothing on the trade path awaits a fetch it could have cached — S/M, 100–600 ms
Each of these is a serial round trip today; all are prewarmable on arm and refreshable
in the background:

| What | Where | Today | Fix |
|---|---|---|---|
| Jito tip floor | `liveSigner.ts:421` | `await jitoTips.refresh()` if >60 s stale (cold HTTPS, 5 s timeout) — the "tips 595" | use cached floor; refresh without await; run the 8 s refresher (`engine.ts:880`) whenever any lane is on, not only while the engine runs |
| Own ALT of the relayer build | `broadcast.ts:287-291` → `fetchAlt` (`:147`, no cache) | 1 RPC per relayer trade, every trade | cache by key, 10 min, same shape as `publicAltCache` (`:144,160`) |
| Rent-safety of fee recipients | `liveSigner.ts:70-87` | sequential `getBalance` per recipient; positive-only cache | negative cache + prewarm treasury/referrer on arm |
| Blockhash (local path) | `txBuilder.ts:1398-1402`, 20 s TTL, refreshed inline | 1 in N trades pays the RPC inline | 5 s background refresher; export `primeBlockhash()`; hand the cached value to the relayer path too (`liveSigner.ts:322`) |
| Pump Global | `txBuilder.ts:482-493`, 60 s cache | cold on first trade | prewarm on arm |
| Mint owner program | `txBuilder.ts:1257-1261` | uncached `getAccountInfo` + blind 400 ms retry sleep, every build | immutable → module Map, no sleep |
| Mint + curve reads | `txBuilder.ts:1257`, `:1274` | two sequential RPCs | one `getMultipleAccounts` (`rpcClient.ts:543` exists) |

### 2.3 Sell: stop waiting on providers to bill a fee — S, 200 ms → seconds per exit
`manualSell` (`engine.ts:1722-1725`) awaits `estSellProceedsLamports` (`:1696-1712`),
which awaits `market.summary(mint)` — 5 s memo, on a miss 5 provider calls + an RPC
(`market.ts:982-1021`), **non-priority**, so it queues behind Discover's GeckoTerminal
2100 ms gap (`http.ts:127,171-181`). The engine already holds the price:
`this.tokens.get(mint)?.row.priceSol ?? this.lastKnownPriceSol.get(mint)` (`engine.ts:1054`),
and the tape has the last tick for any subscribed mint.
Change: estimate from the in-memory price; only if absent, `Promise.race` a
`priority: true` summary against ~150 ms; else unbilled (never misbilled — existing rule).
Also collapse the duplicate balance read (`getTokenBalanceForMint` at `:1702` and
`getTokenBalanceRaw` at `txBuilder.ts:1300`) into one, and cut `sellWithRetry`'s hard
1000 ms sleep (`engine.ts:1332`) to ~250 ms.

### 2.4 Confirmation by `signatureSubscribe`, UI fill on `processed` — M, ~200–400 ms perceived
`broadcast.ts:419-445` polls `getSignatureStatuses` at 400 ms for 4 s then 1000 ms. No
`signatureSubscribe` exists anywhere in `electron/`. A WS pool is already open
(`feed.ts:611`, `priorityFeed.ts:150`).
Change: subscribe the signature the moment it is signed; surface "landed" to the renderer
at `processed` (what every competitor terminal shows), keep the ledger/fee logic on
`confirmed`; keep the poll as a 1 s backstop; tighten the fast-phase poll to 200 ms.

### 2.5 Relayer tail: retries 6→2, and exempt priority calls from the 429 park — S, removes a 20–70 s tail
`relayer.ts:38` `MAX_ATTEMPTS = 6`, 10 s timeout each, `600×attempt` backoff (`:86`) ≈ 70 s
worst case before the user sees anything. Cap at 2 attempts, 3 s timeout, fixed 250 ms gap.
`http.ts:234-242` applies the 20 s 429 park BEFORE `gate()`, so a Discover-caused pump.fun
429 disables `localBuildParamsAsync` (`engine.ts:1294`, `priority: true`) for 20 s and every
pasted-mint buy falls to the relayer for that window.

### 2.6 Local builder ON by default for curve tokens — S code, product call
`localTxBuild` defaults false (`shared/types.ts:790`; revision-2 migration also cleared it,
`settings-store.ts:33`). The default buy is therefore one uncached third-party HTTP hop to
PumpPortal (~400–480 ms measured) before anything else. The seeds-derived layout
(`derivedTemplate`, 2026-08-29) plus §2.2 makes a local curve build ≈ one warm RPC.
Keep the relayer for graduated/AMM tokens and as fallback.

### 2.7 Post-fill: push a `fill` event and make the position refresh cheap — M
No `fill` event exists (`ledger.onSettled` at `engine.ts:341` feeds only the breaker).
`PositionPanel` re-pulls `portfolio.summary` (`PositionPanel.tsx:58,84`, then every 20 s),
which does two `getTokenAccountsByOwner` and a **sequential** `market.summary` over up to 60
mints (`engine.ts:1498-1513`). Emit `{kind:'fill'}` on settle; scope the post-trade refresh
to the traded mint; parallelise `holdings()` with a concurrency cap.

### 2.8 Priority fee from the live estimate — S, inclusion latency + cost
`priorityFeeSol` is hardcoded 0.001 (buys: `engine.ts:993,1122,1224`) / 0.002 (sells:
`:1350,1732,1825`) while `this.feeEstimate` is refreshed every 8 s (`:878-882`) and consumed
only by the shadow planner. At the 120k CU default that is ~8.3 M µlamports/CU — an order
of magnitude over the estimator's own p95 in calm markets, and unable to escalate in a
spike. Wire `priceFor(feeEstimate, feeUrgency) × computeUnitLimit` with a floor.

Keep as-is (safety rules): simulate-before-send on buys (`liveSigner.ts:598`, already
parallel with the pre-balance read; cannot overlap the send without defeating the loss
guard); no second simulation on exits.

---

## 3. Tier 2 — chart

### 3.1 BUG: a pump token not launched this session never ticks — S
`market.watch` returns early for pump.fun ("already on the shared feed",
`market.ts:1613`), and the feed's `onTrade` drops any mint absent from the session launch
map (`engine.ts:2602-2604`; eviction at `LAUNCH_LIST_CAP = 300`, `:103`). So a token opened
from Discover that launched before the app started — the common case — gets no `tape.record`
(`:2659-2660`) and no `tick`. This is "the chart doesn't update" for most tokens.
Fix: before `if (!t) return`, branch on `tape.isSubscribed(ev.mint)` → record + `emitChartTick`.

### 3.2 First paint from cache/tape, provider merge as a second push — M, reopen 2–18 s → instant
`market.candles` (`market.ts:1172-1253`) returns once, after `summary()` (`:1174`) →
`onchain.mintFacts` (unconditional RPC, 8 s timeout, `:1021`) → `solUsd` → the strictly
sequential provider chain (`poolsFor` → `gt.ohlcv`, `:1219-1222`, 2100 ms host gap, 9 s
timeout). `recallChart`/`fromTape` (`:1280,1196`) are reachable only on failure.
Split into `candlesFast()` (sync: LRU + tape) returned immediately, then push the merged
series as `engine:event {kind:'candles'}`.

### 3.3 Chart requests get `priority: true`; Discover polls pause off-route — S
No chart call passes priority (`market.ts:1212,1222,1263`); only the trade path does.
`TerminalProvider.tsx:317-349` polls four Discover columns on every route (pause is a
manual button, `Discover.tsx:123`), holding the GeckoTerminal queue the chart needs.
Pause when `openMint !== null` / route ≠ Discover.

### 3.4 `memo()` in-flight dedupe — S
`http.ts:335-341` caches the value, not the promise; a cold token open runs `buildSummary`
three times concurrently (`Token.tsx:146,154,229`).

### 3.5 Incremental tape — M, main-loop CPU
`candlesTail` at 1 Hz (`Token.tsx:275`) re-buckets up to 20 000 ticks (`tape.ts:119-152`)
and re-merges ~1100 candles (`tape.ts:255-261`, `market.ts:1385`) every second on the main
process that also decodes the feed. Cache built candles per `mint:interval` with a tick
cursor; merge only past `sinceTime`.

### 3.6 Back off the empty-series retry — S
`Token.tsx:258-265` calls full `market.candles` at 1 Hz while the series is empty, and each
success triggers a whole `setData` (`KryptChart.tsx:263,302`). Exponential to ~10 s; use
`candlesTail(since: 0)`.

### 3.7 Header price and PositionPanel from the tick stream — S
`Token.tsx:518-523` shows a price frozen at load; `PositionPanel.tsx:74` polls 20 s. The
`tick` event already carries `priceSol` (`shared/types.ts:721`) and `Token.tsx:298` is its
only consumer. Drive both from it (ref-based, as `KryptChart` does).

### 3.8 Degraded-series bucket mismatch — S, correctness
`degraded` never crosses IPC (`CandleSeries`, `shared/market.ts:391-402`), so the renderer
appends 5 s ticks onto a 1 m series (`KryptChart.tsx:212-227`). Send `effectiveInterval`;
add Birdeye `5s` (`birdeye.ts:30-38` has none).

### 3.9 Priority feed for the OPEN mint, not only held mints — S
`engine.ts:3103-3107` points the Helius per-mint socket (~150 ms earlier, STATUS.md) only at
positions. Include `tape` subscriptions.

### 3.10 DBC: batch the per-tick `getTransaction` — M
`dbcWatcher.ts:227` adds a full RPC RTT per LetsBonk/Believe tick. Batch over a short
window or prefer the block-feed `innerEvents` path (`feed.ts:501-566`).

---

## 4. Tier 3 — renderer and main-loop responsiveness

### 4.1 `positionUpdate` storm — S
`positions.ts:302` calls `onUpdate(p)` unconditionally at the end of `evaluate()`, which
runs on the 500 ms timer (`:173-178`) AND on every decoded trade of a held mint (`:180-185`,
`engine.ts:2777`), with the full `events[]` array each time. Dirty-check the rendered fields,
throttle ≤4/s per position (the `pushLaunchThrottled` pattern), send `events[]` on open/close.

### 4.2 Root re-render every 1–2 s — S
`App.tsx:37` calls `useTerminal()`; `columns` is replaced TWICE per column poll (`loading:
true` pre-write then result, `TerminalProvider.tsx:269-275`) → every route re-renders,
including the Token page, TradePanel and chart wrapper. `App.tsx:98-103` also flatMaps ~160
rows per render for a sidebar label, and `App.tsx:49-58` polls `settings:get` every 4 s into
root state. Same fix already applied for engine state (`App.tsx:110-114`) — finish it: move
`openSymbol` into the memoised sidebar, split the Terminal context, push settings changes.

### 4.3 Batch `engine:event` across the bridge — M
`ipc.ts:104-115` sends one IPC message per event per window; `preload.ts:34-38` one
callback each; six independent listeners each switch on every event. Flush a 50 ms batch,
collapse duplicates by key, keep `toast`/`fill`/`position`-open immediate.

### 4.4 Slice the app-state context; memoise hot rows — M
`AppStateProvider.tsx:202-216` is one memo over five slices; every `launchUpdate` re-renders
every consumer. `Launches.tsx:128-156` renders 300 framer-motion rows + sparklines,
unmemoised, unvirtualised; `Positions.tsx:240` is O(rows × 300) per render. Copy the
`TokenCard` comparator pattern (`TokenCard.tsx:474-500`).

### 4.5 Sync disk writes on the loop that serves trades — S
`creators.ts:44-57` `writeFileSync(JSON.stringify(db, null, 2))` every 2 s while scanning
(42 KB today, unbounded); `heliusBudget.ts:99-111` `writeFileSync` every 1 s. Async writes,
compact JSON, 30 s debounce, prune stale creators on init.

### 4.6 Window flags — S
`main.ts:146-154` sets no `backgroundThrottling` (defaults true → timers throttled when
occluded, stale numbers on restore). Set `backgroundThrottling: false`; on Windows
`app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`.

### 4.7 Startup — M
`main.ts:221-308` runs every store `init`, `creators.init`, `acceptance.purge` and
`recorder.prune()` (readdir+stat over the recordings dir) BEFORE `showMainWindow()`. Show
first, defer prune/purge to the 6 s post-boot timer (`:324`). Renderer: one 1.44 MB bundle
(`dist/assets/index-*.js`), 17 pages statically imported (`App.tsx:14-31`), no
`manualChunks`, `three` only used by Dashboard, 12 `@fontsource` files (`main.tsx:15-26`).
`React.lazy` per route, chunk `three`, trim weights.

### 4.8 Polling that duplicates a push stream — S
`Orders.tsx:30` (10 s, already subscribed at `:27`), `Wallets.tsx:209` (15 s), `PositionPanel.tsx:74`
(20 s), `TopBar.tsx:86` (30 s, `status` already carries the balance), `Token.tsx:353` (3 s
trades tab, tape is the source). `Watchlist.tsx:26-40` fires N parallel `market:summary` per
tick → one batched call. `Execution.tsx:65` polls 3 s against an 8 s refresh.

### 4.9 Feed decode + recorder off the main process — L, measure first
`feed.ts:274` JSON-parses every message per racing socket; `recorder.ts:219` stringifies per
record; both share the loop with every `ipcMain.handle`. A `utilityProcess` for
feed+decode+recorder is the structural fix. Also: the main bundle ships with
`controlFlowFlattening 0.5`, `numbersToExpressions`, `splitStrings(8)`,
`stringArrayCallsTransform` (`scripts/obfuscate-main.mjs:57-71`) — scope those OFF the
decode loop and the trade path (bytecode already hides the source).

---

## 5. Tier 4 — network infrastructure (larger, optional)

- Multi-endpoint HTTP with a latency probe: single `httpUrl` today (`shared/types.ts:169`),
  `getHealth` exported and never called (`rpcClient.ts:86`), flat 8 s timeout, zero
  retry/failover (`rpcClient.ts:29-37`). Rank by p50 every 30 s; race `sendTransaction`
  to the top two.
- `perMessageDeflate: false` on `feed.ts:241` and `priorityFeed.ts:150` (ws defaults it
  on); give `priorityFeed` a ping/pong + handshake timeout (it has none — a half-open
  socket on the held-mint lane stalls until the OS notices).
- Yellowstone gRPC adapter (paid-optional; already scoped in the July plan).

---

## 6. Suggested order

1. §1 instrumentation (half a day) — every later number becomes measured.
2. §3.1 (tick bug) + §2.3 (sell wait) + §2.1 (dispatcher/prewarm) + §2.2 (caches) — one
   day; this is most of the order-path win and fixes the most-reported chart complaint.
3. §4.1 + §4.2 + §4.6 — half a day; the terminal stops re-rendering on a heartbeat.
4. §3.2–3.4, §2.4, §2.5, §2.7 — two days.
5. §2.6 local builder default — product decision, ship with a golden-fixture test.
6. Tier 3 remainder, then Tier 4.
