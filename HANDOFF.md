# Krypto Bot — Handoff / Current State

_Snapshot for context reset. Written 2026-08-26._

Krypto Bot is an Electron + React + TypeScript, local-first Solana memecoin
trading terminal (manual execution; the automation engine is paper-only by
design). This file is the "where are we right now" summary. Deeper history lives
in `STATUS.md` and the auto-memory notes under
`~/.claude/projects/.../memory/` (indexed in `MEMORY.md`).

---

## TL;DR

- **Builds green, boots clean, hardened.** 39 test suites pass, `npm run dist`
  produces `release/Krypt Terminal-Setup-1.0.0.exe` (~86 MB), and the packaged
  app boots at ~200–240 FPS with 0 console errors.
- **Live execution is 95% verified.** A **dry run passed** end-to-end
  (build → sign with the real key → simulate → loss guard). A **real on-chain
  buy/sell round-trip has NOT been completed yet** — that's the last gate.
- **The big fix this session:** pump changed their on-chain event format, which
  had silently broken the local tx builder. Root-caused and fixed (see below).
- **Two things you must do before fees work in production:** fund the treasury,
  and finish the live buy/sell round-trip.

---

## Key facts / addresses

| Thing | Value |
|---|---|
| Funded test wallet (in the packaged app) | `2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce` (~0.05 SOL) |
| Treasury / fee address | `J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n` — **funded** (0.0729 SOL on 2026-08-28, above rent-exempt; fees collect) |
| Platform fee | 0.5% per side, 20% of that to a referrer (0.1% of trade) |
| Legal entity | "Krypt" (Delaware) — `shared/legal/entity.ts` |
| App version | `1.0.0` (not yet bumped to a beta tag) |
| Packaged userData | `%AppData%/Roaming/Krypt Terminal/` (the funded wallet is here) |
| `npm run dev` userData | `%AppData%/Roaming/Electron/` — **separate, empty, NO wallet** |

> **IMPORTANT env gotcha:** `npm run dev` runs in a DIFFERENT data folder than
> the packaged app. The funded wallet + real settings only exist in the packaged
> app (`release/win-unpacked/Krypt Terminal.exe`). Do live-trade testing there,
> not in dev.

---

## Wallet Lab — fund, follow, random trading on own wallets (2026-09-03)

Four pages under **Automation** (after Copy Trading): **Group Wallets** (`creator` — make a
group, then create N wallets INTO it: `lab:generateMany(count, prefix, groupId)`), **Funder**
(`funder` — fund/collect by group or individual wallets), **Warmer** (`warmer` — random
autotrading on a whole group or one wallet: `lab:randomStart(groupId, walletIds?)`,
`RandomRunStatus.walletIds`), **Copier** (`copier` — follow the main wallet at a % scale or
exact amount with delays, plus manual group orders: `live:fanoutBuy` and the new
`live:fanoutSell` → `engine.fanoutSell`, 100 % per wallet, staggered). Pages live in
`src/pages/lab/*.tsx` with a shared `useLabData()`; the earlier single "Utility → Wallet Lab"
page was split the same day. Contract in
`shared/lab.ts` (types, defaults, validators, `planFund`, `pickTradeSol`, `lossCapHit`;
pinned by `test/lab.test.mjs`); IPC `lab:*` in `electron/ipc.ts`; per-group settings live
on the wallet group (`WalletGroup.lab`, `wallet.setGroupLab`).
- **Fund / collect** (`engine/fund.ts`): one tx from the ACTIVE wallet with ≤12 transfers per
  tx; collect = each wallet sends spare SOL (above rent + fee) back to the active one. Signer
  intent **`fund`** (`signPolicy.ts`): transfers only, 1–16 of them, destinations restricted
  to `policy.fundTargets` = this install's own public keys, resolved from the store — never
  from the caller. Needs live execution armed (real SOL).
- **Follow** (`engine.followManualTrade`): after a MANUAL live buy/sell by the active wallet,
  every member of a group with `lab.follow.enabled` (except the active wallet) repeats it
  after a random delay: buys at ratio × size or a fixed size, capped by `maxTradeSol`; sells
  at 100 %. Each leg is `labBuy`/`labSell` → `executeTrade({ walletId })` with the fee, and
  `ledger.recordFill` per wallet.
- **Random trading** (`engine/randomLab.ts`): per group, a timer loop — pick an eligible
  wallet (open < `maxOpenPerWallet`, balance covers the minimum), a random token from the
  chosen Discover column with liquidity ≥ `minLiquidityUsd` and no hide-severity rug rule,
  random size/hold/gap, hourly cap; sells fire on their own timers even after Stop (a bag is
  never abandoned; a failed sell retries in 2 min). **Loss cap is realised cash**:
  `ledger.cashDeltaFor(run signatures)` — reconciled fills' SOL deltas, fees and tips
  included. Disarm stops every run. Status pushed as EngineEvent `lab`.
- The Observatory orb reads Runners (flagged) instead of Candidates; the sidebar brand
  reads KRYPTO.

## Scanner → potential-runner alerts; paper auto-entry opt-in (2026-09-02)

User's call after a session of 4,180 detected / 7 paper entries / net loss, matching the
record (strat swarm 07-24: negative EV with perfect landing, 12.9 % win rate, all variants
negative; runner-odds 08-30: ranking works, AUC 0.87–0.93, base rates 1.5–3 %). The scanner
no longer opens paper positions by default — `strategy.paperEntries` (default false,
Strategy → "Paper entries (research)"). Instead `engine.judgeRunners` (500 ms timer) scores
every launch at +60 s and +120 s with the measured graduation-odds model
(`shared/odds.ts`, features from a bounded first-130 s `oddsTrades` tape kept regardless of
the flow window) and FLAGS the top buckets (`shared/runners.ts`: verdict = bucket ≥ floor,
no hard reject, creator not sold, once per mint; rolling-hour cap). A flag → phase
`flagged`, EngineEvent `runner`, snapshot `runners[]`, desktop notification + paired bots +
toast, recorder `runner`. Text always states the bucket's observed graduation rate, the base
rate, the share that did NOT, and "nothing is bought for you". Surfaces: Launches page
"Potential runners" section with Open → token page; top-bar gold "N runners" pill (last
hour) → Launches; Strategy → "Runner alerts" (switch, bucket floor top1/top5/top10, max per
hour). Settings revision 5 fills the new fields; `test/runners.test.mjs` pins verdict, cap
and wording. Both "Live trading" pills that flipped red when manual mode was armed now say
"Scanner · paper only" / "Scanning · paper" — the scanner cannot spend SOL
(`autoLiveActive()` is permanently false).

## Position value is a sell quote, not spot × amount (2026-09-02)

A real position showed "Value 0.0053 SOL · −89.8 %" one second after a 0.05 SOL buy; an
immediate sell returned 0.0496 SOL. The token (Meteora DBC) had a live curve pool and a
dead Meteora pool holding $1.34; DexScreener's pair ranking (liquidity desc, null → 0)
picked the dead pool, and `portfolio.build` valued the bag at its spot price × amount.
Fixes: (1) `portfolioSummary` quotes a Jupiter SELL of each held balance
(`jupiterRoute.quoteSellLamports`, signer-allowed routes only, six wide, 2.5 s bound) and
`build()` uses it as `valueSol` with `Position.valueSource = 'quote'`; spot × amount is the
labelled fallback (`'spot'`) — the panel shows a "sell quote" / "spot × amount" tag;
(2) DexScreener pairs now rank by recent volume (h1, then h6) with liquidity as tiebreak.
Rule: a holding's value is what selling it would fetch now; spot is a fallback and says so.

## Jupiter build route; PumpPortal outage; RPC failover (2026-09-02)

- **PumpPortal `trade-local` is answering `400 Bad Request` to everyone** since at least
  2026-09-02 (verified from a clean residential IPv4 with browser headers, request
  matching their published spec, for a token trading that minute; last successful build
  2026-08-30). Graduated pump tokens therefore had NO route. It stays as the last-resort
  source; the failure message now says what a relayer 400 means.
- **Jupiter is the second build source** (`engine/jupiterRoute.ts`, between local and
  relayer): keyless `lite-api.jup.ag/swap/v1` quote + swap → versioned tx bytes → the
  same pipeline as a relayer build (allowlist, tip/fee injection, simulation, loss guard,
  signing, confirm socket). Routes are restricted to DEX programs the signer allowlists via
  Jupiter's program-id→label map (memo 1 h); `restrictIntermediateTokens`. Buys are SOL in;
  sells are `NN%` of the RAW balance (`getTokenBalanceRawForMint`); the quoted SOL side is
  the fee basis. Orca Whirlpool added to BOTH program allowlists (signPolicy + liveSigner).
  Verified live (`npm run test:jupiter`, public key only): graduated-token buy 622 B, 1 ALT,
  policy ACCEPT (the WSOL wrap to our own ATA was already exempt), simulate OK 139k CU;
  sell-shaped tx policy ACCEPT. Build ~430 ms buy / ~260 ms sell.
- **RPC transport failover** (`rpcClient.call`): one retry after 200 ms on 5xx/connection
  errors, then the public endpoint once when the keyed one is primary; one warn line per
  minute. Cause: Helius (Cloudflare) 500/520 on a VPN exit killed an order.
- **Local builder is fine.** Surveyed 8 open curves: all parse open with real reserves; the
  two "graduated" refusals that day were real (49/115-byte curves, byte 48 = 1). The
  pump.fun API's `complete=false` lags the chain — the most recently traded coin is often
  the one that just graduated.

## Terminal tape without the scanner; manual buys uncapped (2026-09-02)

- **Tape for any open token, scanner running or not.** The pump feed sockets belong to the
  launch scanner's start button, so with it stopped a token page had provider candles and
  no live tape ("when I go to any coin it's not taped"). `market.watch` now calls
  `engine.watchPumpMint` FIRST (before the summary round trip), which points the per-mint
  `logsSubscribe` socket (`priorityFeed`) at the mint. That socket is attached in the
  engine constructor (was in `start()`), falls back to the primary public WSS when there is
  no Helius key (unbilled — `creditTick` bills it only when keyed), and routes a mint's
  PumpSwap trades to `onAmmLogs` while the scanner is stopped. `engine.stop()` releases
  only held-position mints from it, never the terminal's. A page close unwatches unless
  the mint is a held position.
- **Manual buys are exempt from `maxLiveSol`.** `testTrade(…, { manual: true })` from the
  `live:testTrade` IPC (trade panel, Discover quick-buy, hotkeys) is not clamped; advanced
  orders, copy trade, fan-out and the automation path keep the cap. The panel shows a note
  instead of blocking; Discover no longer clamps the quick-buy amount; hotkey and Wallet
  copy updated. The simulation loss guard and the wallet balance still bound every trade.

## Renamed: Krypt Terminal → Krypto Bot (2026-09-01)

The product is **Krypto Bot** ("Krypto"); the company and brand stay **Krypt**
(krypt.cc, legal entity, the other tools in About). Touched: package name/productName/NSIS
names, window and dialog titles, log header, bot pairing text, Discord activity, About,
index.html, `shared/legal/entity.ts` PRODUCT_NAME — which is interpolated into every legal
document, so `TERMS_VERSION` is now `2026-09-01.1` and every user re-accepts once. Kept on
purpose: `appId cc.krypt.terminal` (the installer upgrades a beta install in place rather
than installing beside it), `window.krypt`, `krypt-img://`, the `krypt-*` theme tokens, the
krypt.cc/tools/terminal homepage. **Profile continuity (INCIDENT 2026-09-02):** Electron derives userData from
`productName` in packaged AND dev runs. The first shim looked for a `krypt-terminal` dev
folder, so an unpackaged launch created an empty "Krypto Bot" profile and the wallet
"disappeared" (it never moved: `Roaming\Krypt Terminal\wallets.json`). The rule is now in
`system/profileContinuity.ts` (unit-tested, `test/profile.test.mjs`): if the new folder has
no `wallets.json` and a legacy folder (`Krypt Terminal`, `krypt-terminal`, `Krypt Sniper`)
does, use the legacy folder in place — even if the new folder already has a settings.json.
The boot log says `profile: using legacy folder …`. Fresh installs get "Krypto Bot".
Dated reports under docs/ keep the old name.

## Speed pass — manual order, chart, renderer (2026-09-01)

Implemented from `docs/speed-plan-2026-09-01.md` (the plan keeps the file:line evidence
and the measured baseline: real orders 1.4–2.3 s, most of the "send" hop being the
confirmation poll). Uncommitted at time of writing; typecheck + 46 test suites pass.

**Order path**
- `system/netAgent.ts`: one undici `Agent` (60 s keep-alive, 16 conns) as the global fetch
  dispatcher — the default was a 4 s keep-alive, so every lane host was cold per trade.
  `undici` is now a direct dep and a vite external (like `ws`). Verified: warm call 45 ms
  vs 184 ms cold on the public RPC.
- `engine/prewarm.ts`: `arm()` starts a 30 s heartbeat that warms the RPC + enabled lane
  sockets, primes the blockhash (`txBuilder.primeBlockhash`), pump Global, the public ALTs,
  the fee recipients' rent status, the Jito tip floor, and opens the confirmation socket.
  `disarm()` stops it.
- `engine/confirmSocket.ts`: persistent `signatureSubscribe` socket (Helius when keyed,
  else the primary WSS). `broadcastAndConfirm` races it against the status poll (fast poll
  now 300 ms); the poll remains the authority when the socket cannot say. New
  `BroadcastResult.sendMs/confirmMs/processedMs`; the timing note reads
  `send X · seen Y · land Z` instead of one blurred "send".
- `onProcessed` hook → EngineEvent `fill` (`landed` at processed, `reconciled`/`failed`
  from the ledger). `PositionPanel` refreshes on it instead of waiting for its 20 s poll.
- `liveSigner`: the Jito tip floor is never awaited inside a trade (background refresh);
  rent-safety reads run in parallel with a 30 s negative cache; the reverted-on-chain
  message now carries timings; `recorder` rows for `live_trade`/`manual_sell` include
  `timing`.
- `broadcast`: every lookup table is cached 10 min by key (the relayer build's own table
  was re-read every trade).
- `txBuilder.buildLocalTrade`: mint owner + curve + (cold) Global in ONE
  `getMultipleAccounts`; owner cached per process; the blind 400 ms retry sleep is gone.
- `relayer`: 3 attempts × 4 s, 250 ms gap (was 6 × 10 s with growing backoff ≈ 70 s).
- `http.getJson`: `priority: true` calls are exempt from the 20 s 429 park; `memo()` dedupes
  in-flight loads (a cold token page ran `buildSummary` three times at once).
- Sells: the fee estimate uses the engine's own price (feed row / last-known / tape) and
  only races a provider summary for 250 ms when nothing local knows — it used to await a
  non-priority five-provider fetch queued behind Discover on every exit. Duplicate token
  balance read dropped; `sellWithRetry` gap 1000 → 250 ms.
- Priority fee: `priorityFeeSolFor()` — the old constants (0.001 / 0.002) are floors; the
  live estimate escalates them at the user's urgency (sells one notch higher), capped at
  0.01 SOL.
- `holdings()`: price lookups 6-wide instead of sequential.

**Chart**
- BUG FIXED: a pump token not launched this session never ticked (`market.watch` trusts the
  shared feed for pumpfun; `engine.onTrade` returned when the mint was absent from the
  launch map). `recordTapeTrade` now runs for any tape-subscribed mint.
- `market.candlesFast` (what `market:candles` now calls): instant answer from the last-good
  cache + live tape, or the tape alone, marked `pending: true`; the provider-merged series
  follows as EngineEvent `candles`. One in-flight full load per mint+interval, shared with
  `candlesTail`'s slow path. Chart provider calls pass `priority: true`.
- `CandleSeries.effectiveInterval` (set on the 1m degrade) drives the renderer's tick
  bucketing — 5 s ticks are no longer appended to 1 m bars.
- The Helius per-mint priority socket now also covers tape-subscribed (open) mints, not
  only held ones. `perMessageDeflate: false` on every feed socket; the priority socket got
  ping/pong + handshake timeout.

**Renderer / main loop**
- `App` no longer subscribes to the Terminal (Discover columns) context or polls settings at
  the root — `HotkeyHost` leaf + `SidebarLive` derives the open symbol itself. Discover
  polls stop when the page is unmounted; unchanged results keep column identity.
- `positionUpdate` is dirty-checked and throttled to ≤4/s per position (engine side).
- Token page: `candles` event consumer; empty-series retry backs off 1→10 s; header
  price/MC follow the tick stream; `performance.mark` open→paint (`[chart] open→paint`).
- Polls that duplicated a push removed/lengthened (Orders, Wallets, TopBar, Execution).
- `Launches`/`Positions` rows memoised by value, framer-motion mount tweens removed;
  `KryptChart` memoised. Routes other than Discover/Token are `React.lazy`; `three`,
  `framer-motion`, `lightweight-charts` are their own chunks; one unused font weight
  dropped.
- `creators.json` writes are async, compact, 10 s debounced (were sync + pretty every 2 s);
  `heliusBudget` persists at most every 30 s (was every 1 s). `recorder.prune()` deferred 3 s
  past window show. `backgroundThrottling: false`; `CalculateNativeWinOcclusion` disabled on
  Windows.

**Local builder ON by default (2026-09-01, user's call)** — `localTxBuild` defaults true
and settings revision 4 flips existing installs. `localBuildParamsAsync` no longer calls
pump.fun `/coins` before a build (a ~300 ms HTTP hop on every untracked-mint buy):
`buildLocalTrade` already reads reserves, creator and completion from the curve in its one
batched account read, so a non-curve mint fails in one RPC and falls to the relayer as
before; a cached summary naming another launchpad skips local outright. Coverage that
kept it off now exists: `test/fixtures/pump-derived-layout.json` holds a real LANDED buy
and sell (accounts + raw curve, mint and Global bytes) and `txbuilder.test.mjs` re-derives
every slot offline. Refresh with `npm run fixture:pump-layout` when pump changes a layout.
Learned while capturing: pump's Global lists eight fee recipients and several fee vaults
(all `pfee…`-owned, e.g. offsets 933 and 965) and the program accepts ANY of them — other
clients rotate to spread write-locks; we keep the primary pair (41 / 965) our own landed
trades used, the test tolerates siblings in those two slots only. Landed buys often carry a
25th `track_volume` byte; our 24-byte form landed on 2026-08-29 and stays. Bots also sell
from non-associated token accounts — pump allows it; the capture filters for the ATA.

**Not done (deliberately)** — see plan §4.9/§5: feed decode in a `utilityProcess`;
multi-endpoint RPC with a latency probe; DBC per-tick `getTransaction` batching; Watchlist
batched summaries (needs a new IPC channel); AppStateProvider slice contexts; scoping
obfuscation off the hot path.

## beta.6 — chart speed and completeness (2026-08-31)

User report: "doesn't show full chart and doesn't update on the ms". Three causes, fixed:
- **Merge, not either/or** (`tape.mergeCandles`): provider history + our tape in one series
  (tape wins overlapping buckets, provider fills gaps; unit-guarded; `source:'merged'`).
  Before, whichever source "won" erased the other — a 1-candle tape replaced full history.
- **Stale over blank**: 200-entry LRU of last-good series; a GeckoTerminal 429 park now
  shows the last chart with an aged note instead of nothing. `market.candlesTail` fetches
  only new buckets (renderer polls 1 s sub-minute / 5 s at 1m+, paused when hidden).
- **Millisecond edge**: EngineEvent `tick` (≤8/s per open mint, gated on `tape.isSubscribed`)
  → `KryptChart.applyTick` via `series.update()` — no more full `setData` repaint every 2 s;
  zoom preserved; priceLines rebuilt only on value change; MC/price toggle redrawn from a
  raw-bar mirror. Ticks only while scanning; the poll alone otherwise.

## beta.5 — relayer sells are billed (2026-08-30)

Fees VERIFIED on chain: treasury at 0.0761 SOL with the logged buys each +0.00025. The
remaining leak — every relayer-built sell unbilled (audit P2-7) — is closed: the engine
estimates proceeds (held balance × current price, `getTokenBalanceForMint` in ONE RPC call,
fetched in parallel with the pre-sell lookups) and the signer bills 0.5 % of the estimate
(`estProceedsLamports`); unbilled only when no price is known, never misbilled at 0. Worst
case staleness ≈ fee doubling as a share of proceeds on a halving price. No second
simulation on exits — the exit-speed rule holds.

## beta.4 — Withdraw SOL from the wallet page (2026-08-30)

`WithdrawPanel` (Wallet page, under the withdrawal-address card): amount + "Max" (balance
− 890,880 lamports rent − 10,000 fee headroom), destination = the CONFIRMED withdrawal
address only (signer `sweep` intent — no other destination can be signed), destructive
confirm showing the full address, Solscan link on success. IPC `wallet:withdraw({ walletId?,
lamports | 'max' })` → `engine.withdraw` queued on the live `runLive` chain so it cannot race
a buy; baseline adjusted so a withdrawal is not a "loss". SOL only — SPL sends need a policy
extension. Tests: `test/withdraw.test.mjs`.

## beta.3 hotfix — "loss limit (−0 SOL)" disarm (2026-08-30)

`engine.updateLiveBreakers()` compared `loss >= limit` directly, so the 0 default
(breakers opt-in since 08-29) was true on every balance poll and disarmed a beta user in
Live within seconds. It now delegates to `shared/liveBreakers.liveBreakerReason()` (0 =
off), pinned by a test that also forbids the raw comparisons. beta.2 is withdrawn.

## Paper positions + first-scan fixes (2026-08-30, late)

- **Paper trading is real now**: a Paper buy still runs the full build/sign/simulate/guard
  pipeline (nothing broadcast) and then opens a PAPER position from the simulated fill
  (`electron/engine/paperBook.ts`, `shared/paper.ts`, `paper-positions.json`); Paper sell
  fills at the last price with a stated 1 % round-trip model. Amber PAPER tag on the token
  page and a separate "Paper positions" section on Portfolio; nothing paper enters the
  ledger, real totals, breakers or fees. Live mode unchanged.
- **Trade path jumps the provider queue** (`http.ts` FetchOptions.priority): a paper buy sat
  ~60 s behind Discover's pump.fun lookups. Discover's rug/odds age gate now uses the row's
  own createdAt (no request), intel coin lookups memo 60 s.
- **Chart**: our own tape leads only with ≥ 30 candles; otherwise providers lead and a thin
  tape is the last resort (a 1-candle tape had replaced a full history on a graduated
  token the moment the scanner tracked it).

## Feed insurance + launch tape shipped (phases 3–4 prep, 2026-08-30)

- **Feed insurance** (`feed.ts` `BlockFeedSocket`, `engine.ts`, `priorityFeed.ts`): a
  publicnode `blockSubscribe` standby decodes pump/pAMM trades from emit_cpi inner
  instructions ~200 ms behind the log sockets and enters the same signature dedupe, so it
  wins only when the logs miss or cannot decode. Measured live: 187 blocks/min, 1,636 CPI
  trades vs 1,637 log trades, 0 races won while pump still emits logs. Per-mint
  `getTransaction` fill on Helius for held tokens; `seenSignatures` lets a CPI copy through
  after an undecodable log copy; watchdog logs once when the block path becomes the only
  source (`status().feedInsurance`). Helius feed billing is now bytes (2 credits / 0.1 MB).
  `rpc.blockFeed` default on, host pinned to `BLOCK_FEED_WSS_URLS`; `blockFeedAmm` default
  off (pAMM standby costs ~11 GB/h). Memory: `block-feed-insurance`.
- **Launch tape** (`launchRecorder.ts`): with the recorder on and firehose off, only each
  launch's create + first 30 min of trades (cap 3,000) + complete/migrated + health rows are
  written — measured **1.2 GB/day vs 12.9 GB/day** on a real day-file; the launchset builder
  reads it unchanged (60-min peak labels censored to null). Settings shows both modes with
  costs and live stats. `engine.recordTape` is gated on `recorder.wantsTape()`.
- **Phase 4 = run it:** Settings → Recorder ON, firehose OFF, cap ≥ 10 GB, scanner running
  for ~7 days; then `python scripts/analysis/build_launchset_2026_08_30.py --src E:\data
  --out E:\data\work\launchset-<date>`, re-run the rug/runner analyses, re-export
  `shared/odds-model.json` with `export_odds_model_2026_08_30.py`, update the constants in
  `shared/rugrules.ts`. Also decide the mixed-curve question (mechanism vs feed artefact).

## Graduation odds shipped (phase 2 of docs/insight-swarm-2026-08-30.md, 2026-08-30)

- `shared/odds-model.json` (95 KB, dated 2026-07-27, fitted on 07-25/26): four logistic
  models on rank-transformed features (`60|grad`, `120|grad`, `60|peak3`, `60|peak5`) with
  201-point train quantile grids, coefficients incl. null terms, bucket cutoffs + observed
  rates + n, per-regime splits, and the verbatim footer. Re-export with
  `scripts/analysis/export_odds_model_2026_08_30.py` after phase 4 re-measures.
- `shared/odds.ts` — pure scorer; `test/odds.test.mjs` round-trips 25 golden rows per model
  against the Python predictions (25/25 buckets, max |Δp| 0.004). `OddsReport` never
  carries a probability: bucket + observed rate + n + base + regime, wording per
  docs/runner-odds-2026-08-30.md §7. "2× in 5 min" is deliberately not shipped.
- `launchIntel.oddsFor / oddsForMany` — same trade seek as the rug rules; judged at +60 s,
  re-judged at +120 s (`odds:60:`/`odds:120:` memo keys), never for graduated tokens.
  `curveRegime()` from the pump curve's raw virtual reserves (classic within 0.5 % of k).
- UI: `OddsPanel` above the trade panel on the token page; "Grad · Top 1–5 % · 17 in 100"
  chip on Discover cards; Discover sort "Graduation odds" and "Odds ≥ bucket" filter;
  Launches score column retitled "Heuristic score" (no measured hit rate).
- Verified live: +60 s reports on 65–80 s-old launches in ~300 ms, honest buckets.

## Measured rug filter shipped (phase 1 of docs/insight-swarm-2026-08-30.md, 2026-08-30)

- `shared/rugrules.ts` — five rules measured on the held-out tape day (R1 one buy ≥ 50 %
  of SOL bought · R2 sells ≥ 1.5× buys · R3 creator sold & curve < 2 % · R4 ≤ 2 buyers with
  ≥ 3 SOL · R5 creator ≥ 30 launches, 0 grads). R1–R4 are the default Discover hide
  (removes ~70 % of dead launches, hides ~1 in 10 future graduations). Every flag renders
  its measured line with n and the date. Concentration (top-3 / bundle / sniper / creator
  holds) is a VOLATILITY row with both numbers, never a hide. Socials / dex-paid / KOL are
  "descriptive — no measured edge" and out of every score.
- Judged only once the launch is ≥ 60 s old (rules were measured at +60 s; earlier every
  launch is just the dev buy) and never for a graduated token. `rug === null` ⇒ no badge.
- Data path: `electron/data/launchIntel.ts rugReportFor / rugReportsFor` (swap-api trade
  seek shared with the Launch panel, 90 s memo, 3 workers for Discover rows ≥ 20 s old).
- Security report: supply-share checks are `kind:'fact'` (weight 0, never red); new gates
  `sellable` (Jupiter Shield), `creator-rugs` + `insider-network` (RugCheck, keyless),
  `factory-creator` (pump.fun + Jupiter devMints), `is-banned`. `quickScore` dropped
  holders + socials. Honest-null: holder pct null without supply, Trader Scan holdingSol
  null without price, "first launch — no record" is unknown not pass.
- Verified live on fresh launches (RugCheck creator-rug flags, NOT_SELLABLE, factory
  creator with 2,237 dev mints, unknowns rendered as unknown).
- Next: phase 2 graduation-odds badge (docs/runner-odds-2026-08-30.md), phase 3 feed
  insurance, phase 4 re-measure on a current-regime week.

## Live round-trip: DONE (2026-08-29)

A real buy (`vKb1EdYc…`, local builder, 0.0487 SOL) and a 100% sell (relayer
router, token had graduated in between) both landed from the packaged app.
Four relayer/signer quirks surfaced under live fire and were fixed the same
day — see the `pumpportal-router` memory note: router program allowlisted,
relayer fee wallet bounded, local builder re-derived from seeds, tx-size
fitting with lookup-table masking.

**Token page now shows YOUR POSITION** (`PositionPanel.tsx`, above Orders):
holding, value, cost, entry vs now MC, unrealized PnL, Sell 25/50/100%.
Renders nothing when the wallet holds none of the token; em dashes while the
fill is still reconciling or when the basis is unknown.

## The blockers (do these to finish beta)

1. ~~Complete one real buy + sell round-trip.~~ Done 2026-08-29 (see above). The dry run passes; the real
   path has never broadcast. Needs the packaged app, a **Helius key set**
   (already set in the real profile), Live mode on, and a genuinely **on-curve**
   token (fresh from Discover "New" — tokens graduate fast, and graduated tokens
   fall to the relayer which is flaky).
2. ~~Fund the treasury.~~ Done — verified on chain 2026-08-28 (0.0729 SOL). The
   rent-safe guard only skips the fee while a recipient is below 890,880 lamports.
3. **Publish the installer SHA-256 + VirusTotal scan.** The Software Terms tell
   users to verify a checksum; publish one or that sentence is unkept. Unsigned
   binary → SmartScreen warns (code signing still deferred).

---

## What was built / fixed this session (newest first)

### Trading mode: LIVE by default, Paper is the toggle (2026-08-29)
- `execution.liveEnabled` now defaults to **true**. `syncLiveMode()` (ipc.ts)
  arms the engine at boot and the moment a wallet is generated/imported/
  selected, so a user never has to "go live" to trade. The top-bar switch is
  still the only way to change mode: `settingsValidation` refuses a raw
  `execution.liveEnabled` patch (pinned by test).
- **The bit is truthful now.** `engine.onDisarm` (main.ts) persists
  `liveEnabled=false` on ANY disarm — user, loss breaker, decoder drift,
  program upgrade — so the top bar reads Paper exactly when the app is in
  Paper. The one exception is `no_wallet` (removing a wallet keeps the Live
  preference; the next wallet arms straight away).
- The TradePanel "Krypt fee $0.00" row was removed; the fee is disclosed at
  onboarding/legal.

### Trading mode: ONE Paper/Live switch (2026-08-26)
- Replaced the confusing `arm` + `enable real broadcast` + `simulate` triad with
  a single **Paper / Live** toggle in the **top bar** (`src/components/TopBar.tsx`
  `ModeToggle`). Paper = simulated, Live = real SOL. Going Live asks one confirm.
- New IPC `live:setLive(on)` (`electron/ipc.ts`) arms the engine AND sets
  `execution.liveEnabled` together.
- Token-page `TradePanel` buy button follows the mode: `Buy X SOL` (live) /
  `Paper buy X SOL` (paper), no per-buy confirm, no simulate toggle.
- Wallet page: removed the standalone Arm switch and Enable-broadcast toggle;
  "Manual test trade" is now "Quick buy by mint" (one mode-aware button). Max
  SOL/trade + Slippage settings kept. Auto-revert to Paper on a safety trip still
  shows a note.
- Internal safety unchanged: every buy still simulates + loss-guards before it
  signs; engine still auto-disarms on loss limit / decoder drift / restart.

### THE pump decoder fix (the important one) — see `pump-event-format-drift.md`
- **Root cause:** pump moved `TradeEvent` out of `Program data:` logs into an
  **emit_cpi inner instruction** (`[e445a52e51cb9a1d wrapper][bddb7f… TradeEvent
  disc][body]`), body layout unchanged. Our log-only decoder saw 0 trades →
  template learning failed → local builder dead → relayer fallback → the
  `Bad Request` you kept hitting.
- **Fix (3 small, chain-verified changes):**
  1. `pumpDecoder.decodeCpiEventData()` strips the CPI wrapper, reuses the
     existing decoder.
  2. `txBuilder.extractSample` now reads trade events from inner instructions,
     preferring the cpi source (a tx carries the same trade in both places
     during the transition — combining double-counts it as "ambiguous").
  3. Decoded the `creator` field (body offset 169) into the TradeEvent + Sample
     so the classifier finds the creator-vault slot self-contained.
- **Result:** local build went **0/5 → 4/4 built, 2/4 simulate clean** (the 2
  reverts were slippage, not build). Needs a Helius key for enough getTransaction
  samples (public RPC rate-limits it); the app has one.
- Pump also runs a NEW buy instruction variant `c2ab1c46…` (27–28 accounts)
  alongside the old `66063d12` (18); the learner handles both.
- NOTE: this same event move affects the on-chain trade FEED too — a good
  follow-up is to have the engine's `onLogs`/feed read the cpi events as well
  (not blocking manual trades).

### Manual-trade local builder — `manual-trade-local-builder.md`
- `execution.localTxBuild` defaults false → must be ON for curve buys (it is, in
  the real profile). Added `engine.localBuildParamsAsync(mint)` to fetch curve
  reserves + creator on-demand from `pumpfun.coin()` for pasted mints the feed
  never saw. Relayer bumped to 6 retries (PumpPortal 400/429s in bursts).

### Rent-safe fee guard — appended to `fee-and-referrals.md`
- A fee transfer to an EMPTY recipient reverts the whole trade
  (`InsufficientFundsForRent`, treasury below rent-exempt 890,880 lamports).
  `liveSigner.rentSafeTransfers()` now drops any fee transfer that would strand
  a recipient below rent (cached), so the fee is **skipped, never reverting the
  trade**. Also protects any user with an empty referrer wallet.

### Number-input UX
- `common.tsx` `NumberInput` rewritten: `type="text"` (no spinner), free typing,
  commit on blur, **no min/max clamping — warnings only**. Fixed the "can't type,
  have to paste" bug.

### vite dev crash
- `vite.config.ts` now ignores `release/`, `dist/`, `dist-electron/`,
  `node_modules/` in the dev watcher — a concurrent build no longer crashes
  `npm run dev` with `EBUSY`.

### Earlier this session (all shipped, tested)
- **Fees + referrals** (`shared/fees.ts`) — 0.5%/side, injected pre-signing,
  redirect-proof treasury (`shared/feeIntegrity.ts`, blob + checksum).
- **6-layer hardening** — `hardening.md`: fee-integrity interlock, main-process
  obfuscation, Electron fuses, V8 bytecode (bytenode), buy-side fee interlock
  (signer refuses a stripped-fee buy), and delayed "corrosion" tripwires
  (`shared/canary.ts` + `electron/system/integrityGuard.ts`). Obfuscation +
  bytecode + fuses are ALWAYS ON for `npm run dist` (`KRYPT_OBFUSCATE=0` to opt
  out for debugging). Renderer speed untouched; anti-tamper never blocks a sell.
- **Legal + onboarding** — `legal-baseline.md`: ToS / Privacy / Software Terms
  (`shared/legal/`), clickwrap gate, local acceptance log with doc hashes,
  retention purge. Onboarding simplified: legal → referral ("a friend referred
  you?") → API keys → wallet → ready. Fee disclosed at the accept summary + in
  the guide, NOT in the referral step. "Replay onboarding" button in About.
- **Multi-wallet + fan-out** — `multi-wallet-fanout.md`: up to 20 wallets, named
  groups, and fan-out buys (N wallets buy one token). Sizing is user-choice:
  "same each" or "split a total" (optionally randomized). `shared/fanout.ts`,
  `FanoutPanel.tsx` on the Wallet page. Each buy runs the full per-wallet
  pipeline; only buys fan out, never sells.
- **Wallet export** — "Export all (Phantom)" writes a plain-text file of base58
  private keys (verified Phantom-importable). Confirm dialog + warning header.
- **DexScreener rows** — expanded Discover columns render one-per-line rows
  (`TokenCard` `layout="row"`).
- **Crash guard** (`crash-guard-policy.md`), **recorder off by default**
  (`recorder-off-by-default.md`), **packaging bloat fix** (`packaging-bloat.md`).
- **Two wallet tabs renamed** — "Copy Trading" (others' wallets, under
  Automation) vs "Wallet" (yours).

---

## How to build / run / test

```
npm run dev          # dev server (SEPARATE empty profile — no wallet)
npm run typecheck    # tsc, both projects
npm test             # 39 offline suites
npm run dist         # hardened installer (obfuscate + bytecode + fuses) -> release/
# packaged app with the real wallet:
release\win-unpacked\Krypt Terminal.exe
```

Live-trade debugging note: my CDP automation (`KRYPT_DEBUG_PORT`) will NOT
attach to the real userData profile (it exits) — it only works on a throwaway
`--user-data-dir`. So live-trade verification has to be driven by hand in the
packaged app, or via a copied profile (copying the wallet file is blocked by the
tooling and shouldn't be worked around).

---

## Open / deferred (not blocking, by decision)

- **Code signing** — unsigned; SmartScreen warns. Cert ~$200–400/yr. A launcher
  is planned to handle auto-updates across Krypt programs, so `electron-updater`
  is intentionally NOT added here.
- **On-chain trade FEED** should also read the moved emit_cpi events (the
  decoder fix covered the tx-template learner, not the live `logsSubscribe`
  feed's trade tracking).
- **Relayer-built sells are unbilled** (proceeds unknown without a 2nd sim).
- **Sells on the Wallet page** still need Live on (not folded into Paper/Live
  the way buys are) — minor.
- Entity suffix ("Krypt LLC"?) unconfirmed in the documents; the caveat was
  removed per the user, but the exact registered string still isn't set.
- EU PLD/CRA (Dec 2026 / Sep 2026) — strict liability can't be disclaimed; decide
  comply / non-commercial / geo-restrict.
- Old recorder data: ~38 GB in `E:/data` — the user's to delete.

---

## Memory notes (persist across context resets)

Indexed in `MEMORY.md`. Most relevant to current work:
`pump-event-format-drift`, `manual-trade-local-builder`, `fee-and-referrals`,
`hardening`, `multi-wallet-fanout`, `legal-baseline`, `crash-guard-policy`,
`order-safety-rules`, `pump-v2-execution-break`, `product-direction`.
