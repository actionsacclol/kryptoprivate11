# STATUS — 2026-08-24

Handoff snapshot. For the *why*, see `terminalguide.md`; for brand/stack, `kryptguidelines.md`.

## Where it stands

**Krypt Sniper became Krypto Bot.** A local-first Solana memecoin trading terminal, with
the original sniping engine kept underneath and now feeding it.

- ~29.1k lines · **382 tests passing, 0 failing** · typecheck clean · `npm run build` clean
- All 16 routes render with zero console errors
- Live checks pass: `npm run test:market`, `npm run test:dbc`, `npm run test:launch`,
  `npm run test:birdeye`

## Built

**Automation controls moved out of the top bar (2026-08-24)** — Start scanning / Stop / Kill
switch / Shadow badge / Ev-s / Latency now live in `AutomationBar`, rendered only on
AUTOMATION_ROUTES. This is a terminal first, and a permanent "Start scanning" button above a
chart invited starting the bot by accident. The top bar keeps search, balance and wallet, plus
a chip that appears whenever the engine is running, positions are open or live trading is
armed — a bot spending money must never be invisible; it navigates to the Observatory.

**New column now carries LaunchLab and Boop (2026-08-24)** — it was pump-only in practice, and
three things had to be right before the other rails actually appeared:

1. **A reserved share.** Merging everything and sorting by age deletes them every time: pump
   mints dozens a minute, so any LaunchLab pool older than about a minute sorts below the cut.
   The two groups are now cut SEPARATELY, with up to a quarter of the column reserved. (The
   Migrated column already guarded against the same starvation.)
2. **`poolsForDex`, not `new_pools`.** `new_pools` is ordered by creation across all dexes and
   pump floods it — measured, 0 of 20 were LaunchLab or Boop. The per-dex listing is
   volume-ranked, which for a slow rail surfaces the launches people are actually trading.
3. **A window matched to the rail.** "New" is relative: pump's newest are seconds old,
   LaunchLab launches rarely enough that hours-old is still among its newest, so the cutoff is
   24h. Every card shows its own age, so this informs rather than misleads.

Verified in a clean process: 31 pump + 9 LaunchLab rows, each carrying `raydium-launchlab` and
real on-chain curve progress. Costs no extra GeckoTerminal spend — the per-dex listings are
memoised for 60s and shared with Graduating. Boop contributes nothing today because the rail is
dormant, which is correct rather than broken.

**Discover selector + expandable columns (2026-08-24)** — the launchpad filter moved out of
the collapsed panel into an always-visible chip row (All · Pump.fun · LetsBonk · Meteora DBC ·
Boop · …), each chip carrying a LIVE COUNT of matching loaded rows and a hover hint stating
what coverage that rail actually has. A chip reading 0 is usually a coverage fact rather than a
mistake — the New column is built from pump.fun's own feed, so other rails are not in it.
Clicking a column header (New / Graduating / Migrated / Trending) expands it to fill the page
in a multi-column grid; clicking again returns to the four-up view.

**Chat bots (new, 2026-08-24)** — Telegram and Discord, bring-your-own-bot, in
`shared/bots.ts` (pure rules) + `electron/system/{bots,telegramBot,discordBot}.ts`
(transports) + a Settings panel.

**READ-ONLY BY CONSTRUCTION.** No command can trade, arm or withdraw — the command table IS
the surface, and a test asserts no trading verb ever appears in it. A chat message must never
be a step in the chain that ends at a signature; that chain requires a human decision in the
app, which is the whole arming model.

Pairing, because the app cannot know who you are on a platform whose bot you own: it shows a
six-digit code, you send `/pair <code>` from the account that should control it, and THAT
sender becomes the only owner. Then:
- unpaired, `/pair` is the only message that does anything;
- paired, everyone else is ignored **in silence** — a refusal still tells a stranger the bot
  is real and worth attacking;
- codes expire in 10 minutes and burn after 5 wrong attempts, so six digits cannot be guessed;
- a leaked code cannot take over an already-paired bot.

Transports are outbound-only: Telegram long-polls `getUpdates` (no webhook, no inbound port),
Discord holds the gateway socket and refuses anything that is not a DM. Tokens are stored in
settings, redacted everywhere (`redactToken`), and never cross back to the renderer in full.
Discord needs the privileged MESSAGE CONTENT intent — without it every message arrives empty,
so close code 4014 is surfaced as a plain-language error rather than a silent dud.

Alerts push to paired chats via the existing notifier, best-effort and never awaited.

**PnL share-card previews** — `demoPosition()` in `shared/portfolio.ts` plus a Preview control
in Portfolio. The card is the artefact that gets screenshotted, so it has to survive a
four-digit gain, a minus sign, a missing icon and an overlong symbol; holding such a position
first is a bad way to find out.

**Priority feed — the fast socket, spent only where it pays (2026-08-25)** —
`electron/engine/priorityFeed.ts`. The firehose stays on the FREE sockets; Helius is pointed at
the mints actually HELD, one `logsSubscribe` per mint over a single connection, added and
dropped as positions open and close.

Measured on a busy held mint, 60s, against the public socket:

| | events | delivered first | median lag when not first |
|---|---|---|---|
| helius (mint-only) | 231 | **222 (96%)** | 18ms |
| api.mainnet-beta | 232 | 10 | **169ms** |

So it keeps the full ~169ms advantage exactly where an exit fills or misses — at **1.78% of the
firehose's cost**: 13,860 pushes/hour against 780,000. A 1M allowance covers **~72 hours** of
holding such a token, versus 1.3 hours of firehose. The socket closes itself when the last
position closes, so an idle app spends nothing.

**This required cross-feed dedupe.** Each `FeedManager` dedupes within its own pool, which
sufficed while there was one pool. A second source carrying the same trades ~169ms earlier
would otherwise have counted every held-token trade TWICE — doubled volume, doubled buyer
counts, and an exit rule evaluated twice on one event. The engine now dedupes by signature
across every feed before decoding.

**Helius credit guard (2026-08-25)** — the firehose socket is OFF again (the free sockets carry
discovery); the guard below stays armed for the priority feed and execution traffic.

The comment justifying its default-off state said "~33k credits/hour". Measured: **780,000
websocket pushes per hour** from the pump firehose alone (13,000 in a 60s sample at commitment
`processed`) — **off by twenty times**, and ~18.7M/day. A 1M-credit allowance lasts about
**1.3 hours**. An estimate that wrong is worse than none: it makes an expensive switch look
affordable.

So the app counts instead of estimating. `shared/credits.ts` (pure, 10 tests) does the
arithmetic; `heliusBudget.ts` persists it; the engine bills the DELTA of the Helius socket's own
event counter on its existing 1s tick and **turns the socket off by itself** at the ceiling,
persisting that so a restart does not silently resume spending. Settings shows credits used, a
projection of hours remaining at the observed rate, and an editable ceiling (0 = no guard).

**More API keys do NOT solve this** and the option was deliberately not built: at 18.7M
pushes/day each additional free key buys another ~1.3 hours, and stacking free accounts is a
terms question the user would own. Subscribing to LESS is what worked — see the priority feed
above, which buys the same latency for 1.78% of the credits.

**Data speed, measured (2026-08-24)** — raced the three websocket endpoints head to head for
45s on the pump firehose, same subscription, same commitment:

| endpoint | events | delivered FIRST | median lag when not first |
|---|---|---|---|
| helius | 6143 | **5793 (92%)** | 36ms |
| api.mainnet-beta | 6120 | 380 | **150ms** |
| solana-rpc.publicnode | 6123 | 102 | **578ms** |

So the Helius socket is worth 150-578ms on the great majority of events — decisive for sniping,
and it stays OFF by default only because it costs ~800k credits/day at firehose rates. The
Settings toggle now carries both halves of that trade instead of just the cost.

Also measured: no single socket saw all 6,275 distinct signatures (helius 97.9%, the others
~97.5%), so the racing pool earns its keep on COVERAGE as well as latency — keep the free
sockets alongside a paid one.

HTTP is NOT a bottleneck at the volumes the engine uses, which contradicted the hypothesis
worth testing: a burst of 20 `getAccountInfo` calls ran **190ms median on the public RPC vs
170ms on Helius, both 100% success**. The existing split (Helius for execution-critical paths,
public for bulk) is therefore left alone. Public endpoints only fall over on the heavy, rare
methods — `getTransaction` bursts and `getTokenLargestAccounts`, both already documented.

Commitment is already `processed`, the fastest setting.

**Discover polls PER COLUMN** rather than on one clock: New at half the base interval (it is the
sniping column), Migrated at double (a migration does not become newer by asking again). This
adds no provider traffic — the GeckoTerminal listings are memoised 60s and shared, pump.fun's
feeds carry their own 4-6s TTLs — it just shortens the path from launch to screen.

**Renderer performance (2026-08-24)** — measured first: one TokenCard is **63 DOM elements**,
so four columns of forty is about **10,000**, and the app was reconciling and repainting them
far more than it needed to. Four fixes, biggest first:

1. **The root no longer re-renders every second.** `App` consumed `useAppState()`, and the
   engine pushes a status event at 1Hz — so every route, Discover included, reconciled on that
   heartbeat because `eventsPerSec` ticked. Sidebar and Ticker now subscribe themselves
   (`LiveChrome.tsx`).
2. **List items got a cheap surface.** Every card used `.plate`, which carries a 34px-blur
   box-shadow AND a pseudo-element of eight gradient layers. Fine for a few panels; 160 of them
   is a paint budget. `.card` keeps the border and background, drops both.
3. **`content-visibility: auto` on cards** — the browser skips layout and paint for the
   off-screen four-fifths, which is virtualisation without scroll maths of our own.
4. **Memoised cards + preserved row identity** (`sameRow`/`reuseRows` in shared, tested). A
   refresh returns brand-new objects even when nothing moved, which defeats reference
   memoisation; unchanged rows now keep their identity, and an entirely unchanged page returns
   the previous ARRAY so React skips it wholesale.

Honest limit on (4): measured against live data, only **49 of 160** cards skip a refresh —
Trending 100%, New 23%, Graduating and Migrated 0%. Those zeros are correct: their price,
market cap, curve % and holder counts genuinely changed in nine seconds, so those cards must
re-render. The paint fixes and the 1Hz fix are the larger levers.

5. **The two WebGL scenes are capped at 30fps** (Dashboard's Radar3D, Wallet's Tome3D). They
   are decoration — nobody reads a value off them — and at 144Hz they asked the GPU for four
   times the work to look identical. The cap SKIPS renders rather than slowing the clock, so
   `requestAnimationFrame` still drives the loop and motion stays in step with real time.
   Tome3D had two frame-COUNTED increments (`+= speed * 16`, assuming every frame is 1/60s)
   which the cap would silently have halved; both are now scaled by real elapsed time, clamped
   to 100ms so a stalled or backgrounded window does not teleport everything on the first frame
   back. Radar3D was already delta-driven and gained the same clamp.

Also: `backdrop-blur` removed from the always-visible chrome (top bar, sidebar), where the
compositor was re-blurring a scrolling page every frame for an effect nothing shows through.
Kept on transient surfaces — modals, drawers, the search palette.

**Terminal** — Discover (New / Graduating / Migrated / Trending, all multi-platform, ~20
min/max filters, 6 presets) · token page (1s–4h charts w/ market-cap toggle, security report,
**retroactive launch analysis**, holder list + bubble map with funding-cluster analysis, live
trades, trader scan) · Ctrl+K
search-any-CA · watchlist · portfolio (chain-reconciled cost basis, PnL, CSV/JSON export,
PnL share cards) · orders (stop loss / take profit / trailing / limit / conditional) · alerts
· hotkeys · paper-first copy trading · market-data privacy panel.

**Automation (intact)** — racing WSS feed pool, pump.fun + PumpSwap decoders, **Meteora DBC
decoder**, **Raydium LaunchLab decoder** (new), risk checks, creator DB, scoring, paper exit
machine, 3 shadow strategy labs, JSONL recorder.

**Raydium LaunchLab / letsbonk.fun (new, 2026-08-24)** — `launchLabDecoder.ts` (trade events)
and `launchLabAccounts.ts` (pool state + exact curve progress). LaunchLab tokens now appear in
**Graduating** alongside pump and DBC, with progress read from the chain.

Nothing here came from documentation. The event layout was derived by decoding a live trade
and cross-checking `amountIn` against the instruction's own argument (6/6 matched); the
direction byte was confirmed 0 on three buys and 1 on three sells. The pool layout was found
by reading a pool account and searching it for the u64 values its own event had just
reported, then confirmed across 10 pools. Fixtures in `test/fixtures/launchlab.json` are real
mainnet payloads.

Three facts worth keeping:
- **LaunchLab emits BOTH** an emit_cpi event and a `Program data:` LOG line, and they are the
  same bytes. So it can be taped from ONE logsSubscribe like pump.fun — unlike DBC, which
  needs a getTransaction per trade. That is why the decoder is log-shaped.
- Its firehose is **95% successful** (57/60), against pump's 4%.
- **Not every LaunchLab pool is SOL-quoted** — 3 of 10 sampled quoted in USDC/USDT. Their
  reserves are not lamports; `isSolQuoted` says which, and Graduating excludes the rest rather
  than printing a SOL number that is wrong by orders of magnitude.
- Migration is read from the pool's **status byte** (0 funding / 2 migrated), which correlated
  perfectly with progress across 10 pools — not inferred from "100%".

**Launch intel (new, 2026-08-24)** — bundle / sniper / dev cohorts for ANY pump.fun mint,
however old, plus what each cohort still holds and the creator's full pump.fun track record.
Was previously live-tape-only, so a pasted CA showed em dashes. Three keyless discoveries made
it possible — all measured, all in `shared/launchintel.ts`'s header:
`swap-api.pump.fun/v2/coins/{mint}/trades` serves full history and its cursor is a plain
**seek key** (`0…0-<timestampMs>` jumps to the launch, so a months-old launch costs ONE call);
`slotIndexId.slice(0,12)` is the slot; and `getMultipleAccounts` over derived ATAs prices 100
wallets' current balances on the free RPC that refuses `getTokenLargestAccounts`.

**Multi-wallet (new, 2026-08-24)** — hold up to 20 trading wallets, ONE active at a time.
Generate / import / rename / switch / back up / remove, each with its own balance cap and
withdrawal address. Migrates the old single `wallet.json` on first read and KEEPS it (it holds
a key copy). Rules live in `walletStore.ts` with no key material, so they are unit-tested;
`wallet.test.mjs` drives the real module against real files with a stubbed keystore.

Safety, unchanged where it matters and tightened where it needed to be:
- Only the ACTIVE wallet can sign; everything downstream still calls the same
  `publicKey()` / `signVersionedTransaction()` and is unaware there is a list.
- **Switching is refused while live execution is armed** — the engine caches the owner and an
  order may be mid-flight. Removing any wallet disarms first, unconditionally.
- `activeId` can never dangle: removing the active wallet promotes the oldest survivor.
- The same key cannot be held twice; removing the last wallet writes an EMPTY file rather than
  deleting it, so the kept legacy file cannot resurrect a wallet you removed.
- Fills now record the wallet that made them, so switching never mixes up history.

**LaunchLab live tape (2026-08-24)** — `launchLabWatcher.ts`. ONE program-wide
`logsSubscribe` serves every open LaunchLab token, because its events are log lines; DBC needs
a socket per pool. The pool is a PDA of the mint (`["pool", baseMint, quoteMint]`, verified),
so opening a token costs no lookup — though a provider-supplied pool wins when there is one,
since the derivation assumes a SOL quote. Verified live: 9 ticks over the websocket in 60s
with prices and curve progress.

**Its ticks have NO wallet, by construction.** A log subscription carries no account list, and
the TradeEvent holds the pool rather than the trader. Recovering it would cost a
`getTransaction` per trade — the exact cost this rail lets us avoid. The trades panel renders
that as an em dash with no link. Consequence: no trader scan or copy trading for LaunchLab.

**Boop (new, 2026-08-24)** — `boopDecoder.ts`, `boopAccounts.ts`, `boopWatcher.ts`. Boop runs
its OWN curve program (`boop8hVGQGqe…`), not Meteora DBC — check that assumption first with any
new launchpad. Events are LOG lines (14/14 sampled, zero emit_cpi), so one program-wide
subscription tapes it.

**It is the richest of the three log rails**: its event names the MINT *and* the TRADER, so it
needs no pool→mint map and its ticks carry real wallets — trader scan and copy trading work
here, which they cannot on LaunchLab. Direction comes from separate event discriminators, not
a flag byte. The curve account is `["bonding_curve", mint]`, so nothing is ever looked up.

Verified by arithmetic on live data, not documentation: on a buy, `amountIn + fee` reproduced
the instruction's own requested amount to the lamport (619144 + 6253 == 625397), and pricing
the curve from the account matched GeckoTerminal within 5-8% across six pools.

**BUT THE RAIL IS DORMANT.** Measured 2026-08-24: Boop's last 100 signatures spanned TWENTY
DAYS, newest 10 hours old — about five transactions a day, against LaunchLab's ten a minute.
The code is correct and verified; it simply has almost nothing to carry today. `npm run
test:boop` detects this and verifies against history instead of failing.

**Not built (deliberate)** — simultaneous multi-wallet execution (fan-out: needs positions and
the fill ledger re-keyed to (wallet, mint), per-wallet orders, and caps applied per wallet AND
in aggregate), social/Twitter intel (no honest free data source), draggable layouts, execution
diagnostics, Raydium LaunchLab / LetsBonk decoder.

## Curve trading — broken by pump, fixed locally (2026-08-24)

**pump.fun shipped a breaking curve change.** `PumpPortal /api/trade-local`
returns `400` for EVERY bonding-curve build — buys and sells, all pools (a
migrated token with identical params returns 200 in the same run). The relayer
therefore cannot trade curve tokens at all right now.

**The local builder now can.** It required five fixes, each measured:

1. `["bonding-curve-v2", mint]` — pump added this required account. Being
   underivable, the classifier fell through to "rotating fee account" and
   copied ANOTHER MINT's value → `InvalidBondingCurveV2 (6074)`. Now derived
   (`addresses.ts`), with a golden fixture pinning it to an observed address.
2. **Curve generations are separated** like discriminator variants — samples
   with and without a v2 account cannot be classified together.
3. **Variants are tried largest-first, not bet on.** A legacy variant with two
   samples used to out-count the live one, fail, and block it.
4. **Volatile slots are read from a recent real trade** (creator vault, fee
   recipients): pump's API `creator` is not always the account the program
   expects (`ConstraintSeeds`), and recipients rotate within ~90s
   (`NotAFeeRecipient`). Observation TTL is 8s.
5. **The token program is per-mint**, not per-template — baking in the sampled
   mints' program broke mints of the other kind
   (`ConstraintAssociatedTokenTokenProgram`).

Two more fixes for **sells**, which use different layouts (16/17-account
legacy, 26-account quote-aware):

6. **Quote-side accounts are derived** — `ATA(curve, WSOL)` and
   `ATA(user, WSOL)`. Unmodelled, they were copied from another mint and the
   program rejected them (`ConstraintSeeds` on
   `associated_quote_bonding_curve`).
7. **The current curve generation is preferred before variants are formed** —
   legacy layouts carry accounts we do not model
   (`associated_user_volume_accumulator`), and learning one produced a
   template that classified cleanly and then failed in simulation.

Verified by building and simulating real curve trades against live mints:
**buys CLEAN** (~76-104k CU, warm build ~500-900ms) and **sells CLEAN**
(~60k CU, warm build 744ms), with correct rejections for graduated curves,
zero balances and moved prices. Templates persist across restarts — a second
process loaded `sell: 17 slots` from disk and built without re-learning.

**Live curve trading needs the local builder enabled** (Settings → Execution)
since the relayer cannot serve it.

## Known limits — these are data facts, not bugs

- **Holder features need a Helius OR Birdeye key.** Both free public RPCs refuse
  `getTokenLargestAccounts` (429 from api.mainnet-beta, 403 from publicnode, measured).
  Birdeye's holder route is verified working with a key (`npm run test:birdeye`).
- **Local building needs a keyed RPC in practice.** Learning the account layout
  costs ~200 `getTransaction` reads; a free endpoint rate-limits the burst and
  the attempt starves. The template is persisted for 6h, so the cost is paid
  rarely — but the first learn wants a real RPC.
- **A token younger than the selected window shows the same number in every window** — it has
  had one set of trades. Correct, and the reason the New column looks unaffected by the window
  buttons. Cards mark it with `*` rather than leaving the control looking broken.
- **GeckoTerminal 429s after ~4 calls.** There is a backoff + budget discipline; don't add
  calls to Discover without checking the chart still works after a burst.
- **DBC live tape is per-open-token only.** Its events are `emit_cpi!` and invisible to
  `logsSubscribe`, so a whole-program firehose would need a `getTransaction` per trade.
  Consequence: no bundle analysis or copy trading for DBC tokens.
- **Graduating is pump-heavy** because ~19 of the top 20 DBC pools by volume have already
  migrated. Correct behaviour, sparse result.
- **The pump trade index does not reach 2024 launches.** A 919-day-old token serves this
  month's trades and nothing near its own launch (measured). Launch cohorts are withheld with
  a stated reason for those — never estimated. Tokens ~300 days old analyse fine.
- **Launch analysis is pump.fun only.** pump.fun indexes foreign mints as
  `program: 'non_launchpad'` with a placeholder creation date (USDC claims 2024-07-15), so
  those are refused by name rather than analysed from a fabricated timestamp.
- **"Still holds" reads the associated token account only.** A wallet holding through a
  non-ATA account reads as zero, so the held figure is a floor. Stated in the panel.
- **Local tx builder ships off** — no golden-fixture coverage. Costs 0.5%/side to the relayer.

## Execution path (reworked 2026-08-24)

- **Birdeye is verified** (`npm run test:birdeye`). It shipped UNVERIFIED and
  the first live run found its sub-minute candles — the entire reason it
  exists — completely dead: `/defi/ohlcv` rejects 1s/15s with "type invalid
  format", and after moving to `/defi/v3/ohlcv` every item was still dropped
  because v3 spells the timestamp `unix_time`, not `unixTime`. Both fixed;
  1s/15s/1m, holders and trades all pass.

- **Per-hop timings** are recorded on every attempt (`TradeTiming` in
  `liveSigner.ts`) and appended to the result message —
  `build 213·local · tips 94 · sim 89 · send 640 · total 1036ms`. Before this
  the app could not answer "how fast are our orders?" at all.
- **Simulate and the pre-balance read now run concurrently** — they are
  independent, and sequencing them added a whole RPC round trip (~85ms
  measured) to every order.
- **The account-layout template is persisted** (`pump-templates.json`, 6h TTL)
  and invalidation is persisted too, so a template that failed simulation
  cannot return after a restart.
- Measured pre-broadcast round trips on a free RPC: relayer build 213ms · jito
  tip floor 203ms · ALT read 94ms · simulate ~89ms · balance 85ms.

## Safety model (do not weaken without reading the tests)

- Nothing signs unless: `liveEnabled` on **and** engine armed **and** funded wallet. The
  per-trade cap bounds execution without a click at that moment (advanced orders, copy
  trade, fan-out, automation); a buy the user places by hand is uncapped (2026-09-02,
  user's call). Enforced main-side; assume the renderer is hostile.
- Orders are exactly-once; a blocked order is **not consumed**; failures are never retried;
  breakers stop buys, never sells; restored orders come back **paused**.
- Partial sells never use the local builder (it sells the whole position).
- No IPC channel accepts a URL or host. Token images go through `krypt-img://`.

## The open decision

`term.txt` specifies a **0.3% fee**; the code ships **$0.00** and the README says so.
Unresolved — and it gates distribution: every competitor grows on 25–35% fee-funded
referrals, which a zero-fee product cannot run. Honest ceiling without one is ~1,500–6,000
installs at 6 months (`docs/product-swarm-2026-08-16.md` §9). That doc's conclusion: a
zero-install **web surface at krypt.cc is the acquisition strategy, not a supplement**.

Next work depends on the answer:
- *Many users* → web surface + fee decision, not more terminal features.
- *Best tool for a few hundred people who care* → mostly done; polish and ship.

## Commands

```bash
npm run dev          # Vite + Electron
npm run typecheck    # both TS projects
npm test             # 382 offline tests
npm run test:market  # LIVE provider check (slow, networked)
npm run test:dbc     # LIVE Meteora DBC check
npm run test:launch  # LIVE launch-intel check (swap-api seek + creator filter)
npm run test:birdeye # LIVE Birdeye check (needs a key; skips without one)
npm run test:launchlab # LIVE Raydium LaunchLab decoder check
npm run test:launchlab:tape # LIVE LaunchLab websocket tape check (waits for trades)
npm run test:boop    # LIVE Boop check (falls back to history when the rail is dormant)
npm run dist         # Windows installer
```

## Gotchas that will bite you again

1. Never put the terminal context object in a `useEffect` dep array — use the stable callback.
2. `programIdIndex` spans ALT-loaded addresses — always `resolveAccountKeys(tx)`.
3. Cost basis comes from the on-chain lamport delta, never the requested amount.
4. Unknown renders as an em dash, never `0`. Scores average only resolved checks.
5. When a test fails, check whether the *test* is wrong — twice it was.
6. CSS `uppercase` changes `innerText`; case-sensitive test selectors will lie to you.
7. Sample pump layouts from a MINT'S CURVE ACCOUNT (85-100% successful), never
   from the program's signature firehose (96% failed transactions). But curve
   windows are ~90% sells, so learning a BUY needs both sources.
8. The stats window (5m/1h/6h/24h) only changes **Trending** — the other columns rank by age,
   curve progress and pool creation, which have no window. It is threaded through
   `market:discover`; don't reintroduce a hardcoded window in the trending case.
9. An empty page from a cursor API means "look further out", not "there is nothing". Reading
   it as a verdict reported "nobody has bought this token" about a migrated token with months
   of history — caught by the live check, invisible to the unit tests.

10. `dist-electron` is never cleaned by vite between rebuilds. Content-hashed chunk
    names therefore ACCUMULATED — measured 2026-08-25 at 857 MB across 2,007 files,
    all of which electron-builder packed, making a 232 MB installer that was ~95%
    dead builds. Fixed by stable (unhashed) main-process filenames plus
    `scripts/clean-dist.mjs` in `npm run build`. If the installer ever balloons
    again, look here first.

## Anti-tamper / hardening (2026-08-25)

Goal: make the app hard to crack and the source hard to extract, WITHOUT
touching renderer speed and WITHOUT ever letting anti-tamper block a trade.
Honest ceiling (also in feeIntegrity.ts): client-side code can always be cracked
by someone determined; this defeats the casual 99% and raises the cost of the
rest. Verified: hardened build boots, Discover holds 225 FPS / 11 MB heap / 0
errors — obfuscation is main-process only, so the UI thread is untouched.

Three layers:

1. **Fee-integrity interlock** (`shared/feeIntegrity.ts`, pure code, 7 tests).
   The treasury is stored as an obfuscated byte blob + SHA-256, NOT just the
   readable `TREASURY_ADDRESS` in fees.ts. Every trade resolves the treasury
   through `resolveTreasury()`, which returns the CANONICAL decoded address
   regardless of what the readable constant says. So the #1 casual attack —
   edit the address string to your own wallet, or blank it to disable fees —
   redirects nothing; the fee still lands at the real treasury and the tamper
   is logged. To actually redirect, a cracker must find the blob, understand
   the LCG keystream, re-encode, and fix the checksum, in an obfuscated bundle.
   `liveSigner` uses `activeTreasury()` / `treasuryIntegrity()`, never the raw
   constant. Regenerate the blob after changing the treasury:
   `node scripts/gen-fee-integrity.mjs` (wired into `npm run build`).

2. **Main-process obfuscation** (`scripts/obfuscate-main.mjs`, opt-in via
   `KRYPT_OBFUSCATE=1`). String-array + base64 + split strings + control-flow
   flattening (0.5) + dead code (0.2), mangled names. Verified on disk: the
   treasury address, `bonding-curve-v2`, and `TREASURY_ADDRESS` are no longer
   greppable in the packed `main.js`. selfDefending/debugProtection are OFF on
   purpose — they wedge processes and spike CPU, and a frozen trading app is
   worse than a readable one. Renderer bundle is NOT obfuscated (speed).
   Confirmed obfuscation preserves the treasury decode exactly.

3. **Electron fuses** (`scripts/apply-fuses.cjs`, afterPack). RunAsNode OFF,
   EnableNodeCliInspectArguments OFF, EnableNodeOptionsEnvironmentVariable OFF,
   OnlyLoadAppFromAsar ON, EnableCookieEncryption ON. Zero runtime cost; closes
   the ELECTRON_RUN_AS_NODE / --inspect / NODE_OPTIONS code-injection vectors
   that no JS obfuscation can.

**The one hard rule kept:** anti-tamper never blocks a trade. A tampered
treasury logs loudly and routes to the canonical address; a corrupt blob
disables billing (fails closed) but trading continues. Stranding a position to
protect 0.5% would be a worse outcome than a cracked build.

**Layer 4 — V8 bytecode (bytenode), added 2026-08-25.** After obfuscation, the
main-process chunks (main2/liveSigner/broadcast/sweep/rentSweep) are compiled to
V8 bytecode (.jsc) and their .js replaced by 72-byte loader stubs. main2 went
from ~820KB of source to a stub + 5.1MB bytecode. Compiled under Electron's V8
(ELECTRON_RUN_AS_NODE via scripts/harden-bytecode.mjs) so the bytecode matches
the shipped runtime. Because the source was obfuscated BEFORE compilation, even
the bytecode constant pool has no readable treasury or `bonding-curve-v2`
strings. Verified: hardened+bytecode build boots, full onboarding flow works
through the bytecode main process, 240 FPS, 0 errors. main.js (3-line bootstrap)
and preload.js (contextBridge shims, loaded by Electron by path) stay as JS —
neither holds secrets. On by default; KRYPT_OBFUSCATE=0 skips obfuscation AND
bytecode for a debuggable build.

**Layer 5 — the buy-side fee interlock (safety-bounded).** `SignPolicy.requireFeeTransfer` makes the signer REFUSE a buy whose platform fee is missing or
shaved — so a cracked build that strips the fee cannot open a position, which
makes it useless as a sniper. It is set ONLY for buys and cleared on a genuine
attach failure (network/lookup-table), so a legit user is NEVER blocked from
exiting a position and never blocked by a real hiccup. This is the reconciliation
of "removing fees breaks the program" with the hard rule that anti-tamper must
never strand a position: it breaks buying, never selling. Pinned by four cases
in test/walletpolicy.test.mjs.

**Still not done:** code signing (SmartScreen). A determined reverse-engineer
with a V8 bytecode disassembler can still recover logic — bytecode raises the
bar past obfuscated JS but is not encryption. Honest ceiling unchanged.
Code signing still open (SmartScreen), and a determined reverse-engineer can
still defeat all of the above.

## Legal + onboarding (2026-08-25) — per legalcheck.md

Operator identity lives in ONE file, `shared/legal/entity.ts`, and every
document interpolates from it. Documents are structured data in
`shared/legal/documents.ts`, not prose files, so the clickwrap summary, the
in-app reader and the acceptance hash all read the same text.

**What ships:** Terms of Service (16 sections), Privacy Policy (14), Software
Terms & Risk Disclosure (21, including the financial-tool clauses), a clickwrap
gate that blocks the app until accepted, a Legal route, a sidebar footer, and
`resources/THIRD-PARTY-LICENSES.txt` (63 components, regenerated by
`npm run build`).

**Two decisions worth keeping:**

- The product has **no server**, so legalcheck.md's "log acceptance server-side"
  has nowhere to go. `electron/system/acceptance.ts` writes an append-only JSONL
  row locally holding a **SHA-256 of the full text of each document as shown** —
  stronger than a version string, because it proves WHICH words were on screen.
  No IP is recorded in any form; the app does not know one, and inventing a
  lookup would create the exact data the spec says not to store. A server-side
  row belongs to the download flow on krypt.cc, a different codebase.
- Arbitration **names AAA under its Consumer Arbitration Rules** rather than
  "a mutually agreed-upon provider" (legalcheck.md Known Gap #2), and the
  class-action waiver **severs alone** instead of taking the whole clause with
  it.

**Claim audit found one false claim and it was removed.** The sidebar said
"Free & open source"; there is no LICENSE file and the source is not published,
which is the bare-claim FTC §5 problem the spec names. It now reads "Free · no
ads, no telemetry". Put it back the day the source goes public. The "no
telemetry" claim in the privacy policy now carries its qualifier **in the same
section**, because a caveat two sections away is not a caveat.

Bumping `TERMS_VERSION` re-prompts everyone automatically — acceptance is stored
against the exact version. There is a test for that.

### Still open (carry forward)

1. **No attorney review.** All template language.
2. **No code signing** — SmartScreen will warn. The terms now disclose this
   rather than let it surprise people.
3. **Entity suffix unconfirmed** (LLC / Inc / Ltd?) and formation/good standing
   unverified. `ENTITY_SUFFIX_CONFIRMED = false` surfaces this in the Legal page;
   flip it once checked.
4. **No server-side acceptance row** — needs the krypt.cc download flow.
5. **EU PLD (EU) 2024/2853 from 9 Dec 2026** and **CRA (EU) 2024/2847** from
   11 Sep 2026 — strict liability toward consumers cannot be disclaimed. Decide
   deliberately: comply, be genuinely non-commercial FOSS, or geo-restrict.
6. **No published checksums / VirusTotal scan** — the terms tell users to verify
   checksums, so publish them or that sentence is unkept.
7. Six bundled packages ship no licence file (borsh, bs58, discord-rpc,
   es6-promisify, fancy-canvas, tr46); the declared licence is recorded instead.

## Platform fee + referrals (2026-08-25)

0.5% of each trade, both sides (1% round trip). 20% of that fee — 0.1% of the
trade — goes to a referrer named at onboarding; the user pays the same either
way, because the referral comes out of our share.

Treasury: `J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n`, in `shared/fees.ts`,
verified to decode to 32 bytes and sit on the ed25519 curve. It is **pinned by a
test** — a single wrong character there does not fail loudly, it silently pays a
stranger on every trade every user makes. An empty value disables fees entirely
(`feesEnabled()` is the single gate), which is how it shipped before the address
existed.

The onboarding copy does NOT state the referrer's percentage — deliberate, per
Krypt 2026-08-25. It says they are rewarded automatically and that it costs the
user nothing extra, both of which are true. The fee the user PAYS is still
stated exactly, because that is what they are being charged.

Where it happens: `liveSigner.runPipeline()`, injected into the unsigned tx
*before* validation and signing, exactly like tips. So the fee is inside the
artifact that gets validated, simulated and loss-guarded — not a second
transaction that can land when the trade did not.

Rules worth keeping:

- **A fee that cannot attach never blocks the trade.** If the message can't be
  rebuilt (unfetchable lookup table), the trade proceeds unbilled. A user who
  cannot exit a position because our fee failed is a user we have harmed.
- **The signer's drain protection was NOT loosened.** `SignPolicy.feeAllowance`
  names each recipient with its own ceiling, summed per address; the tip cap is
  untouched and every other destination is still refused. See the fee cases in
  `test/walletpolicy.test.mjs`.
- **The loss guard expects the exact injected amount**, not a percentage
  allowance — a fee we did not inject still trips it.
- **Sell basis is the curve's PRE-slippage estimate** of proceeds (the same
  number the min-out limit comes from), so an unusual sell is billed slightly
  under the true proceeds. Relayer-built sells are NOT billed at all: the
  relayer does not tell us what a sell will realise, and an exit is not worth a
  second simulation round trip. Buys are always billed.
- **The referrer lives in one place** (`liveSigner.setReferrer`, applied at boot
  and on settings change) because trades are constructed at six call sites and a
  forgotten field would silently stop paying somebody.

`test/feeflow.test.mjs` covers the composition across the three modules — split,
inject, then the allowance handed to the signer — which is where a mismatch
would mean either a refused trade or an unbounded transfer.

Onboarding (`src/components/Onboarding.tsx`) discloses the fee BEFORE asking for
a referral: recruiting someone for a price they have not been shown is not a
thing this app does.

## The two wallet tabs (2026-08-25)

There used to be **Wallets** and **Wallet**, one letter apart, and the cue ran
backwards: the PLURAL page held other people's wallets (tracking + copy trading)
while the SINGULAR one held yours. Multi-wallet made it worse — "Wallet" now
holds several of your own.

- `wallets` route is now labelled **Copy Trading** and moved to the AUTOMATION
  group. It is the only page that trades on someone else's initiative rather
  than your click, so it belongs beside the other automation.
- `wallet` stays **Wallet** under TERMINAL; its inner switcher section is now
  "Your wallets".
- Route IDs are unchanged (`wallets`, `wallet`) — only labels moved, so no
  persisted state or deep link breaks. If you rename the IDs later, check
  `src/App.tsx` and anything that stores the last route.

## Crash guard (2026-08-25)

`electron/system/crashGuard.ts`. Electron 30 runs Node 20, where an unhandled
promise rejection is **fatal by default** — and the main process is nothing but
`fetch` calls (providers, bots, feed pool, credit budget). One unawaited
rejection closed the whole terminal, possibly mid-trade. Verified with a control
run: without the guard the process dies before its next timer fires.

Policy, pinned by `test/crashguard.test.mjs` (19 tests):

- **Survive by default** — log loudly, keep running.
- **Never silently** — every catch goes to the Grimoire at error level with
  "if a trade was in flight, CHECK YOUR POSITION", raises ONE desktop
  notification per run, and is appended to `userData/crashes/crash-YYYY-MM-DD.log`
  (the in-memory logger holds 500 lines and dies with the process).
- **Quit anyway in two cases**: a crash before the window exists (otherwise an
  invisible process holds the single-instance lock and the next double-click
  does nothing), and a crash storm (>25 in 10s — that is a loop, not a blip).
- Crash logs prune after 7 days, each capped at 5 MB. Pruning only ever deletes
  files matching `crash-YYYY-MM-DD.log`, never anything else in the directory.

`test/crashguard.live.mjs` proves the real `process.on` wiring, not just the
policy seam — the unit tests drive a testing seam and would pass even if the
handlers were never registered.

Deliberately NOT done: code signing and auto-update. A launcher is planned to
handle updates across the Krypt programs, so `electron-updater` stays out.

## Beta release check (2026-08-25)

Ran the packaged path end to end, not just the dev server:

| check | result |
|---|---|
| `npm test` | 31 suites, all pass |
| `npm run typecheck` | clean |
| `npm run dist` | `Krypt Terminal-Setup-1.0.0.exe`, **84.5 MB** (was 232 MB) |
| packaged app boots | yes — 4 processes, 458 MB RAM, stopped cleanly |
| asar contents | 8 main-process chunks, 0 source maps, `ws`/`bufferutil`/`utf-8-validate`/`discord-rpc` all present |
| all 16 routes over CDP | 0 console errors, 0 warnings |
| Discover under a live engine | 7,897 elements, 225 fps, 37 MB JS heap |

Two things fixed to get there: a dangling `build/installer.nsh` reference in the
nsis config that failed the build outright, and the `dist-electron` bloat above.

**The recorder no longer runs by default.** `recorderEnabled` was `true`, which
meant every install taped the pump firehose to disk forever — this machine had
38 GB in `E:/data` and 103 MB in the userData `recordings/` folder. It now
defaults OFF, and when switched on it is bounded by `recorderMaxGb` (default 2)
with oldest-first pruning at startup and hourly. The current day's file is never
pruned. Old tape data is left alone — deleting research data is the user's call.

Full detail in `~/.claude/projects/.../memory/` — 15 notes, indexed in `MEMORY.md`.

## Tripwire corrosion (2026-08-25)

A diffuse anti-tamper layer that makes a cracked (fee-stripped) build slowly
rot instead of failing at the crack site. `shared/canary.ts` has SEVEN
independent pure checks of the app's own embedded fee constants — all pass on a
genuine build, and neutralising one does not clear the signal because the
consumer sums them. `electron/system/integrityGuard.ts` turns that count into
`level()` 0..1: **0 on any genuine build, forever** (proven in
test/canary.test.mjs against the real constants — the false-positive guard),
and on a tampered build 0 during a 15-minute GRACE period, then ramping. So a
cracked build works fine, ships, and only then degrades — far from the edit.

Consumed, buys only, all neutral when clean: buy size shrinks toward 40%,
slippage widens, up to 2.5s latency is injected (death for a sniper), and the
fast local builder is denied so the buy falls to the relayer — which charges
its OWN 0.5%, so a fee-stripped build pays a fee anyway. A second detection
site in the engine (`refreshExecution`) staves execution telemetry and logs the
tamper once. **Nothing degrades a SELL or the exit path** — a cracker's stuck
position is acceptable, stranding a real user is not, and the guard exposes no
sell-side knob by design. Verified: genuine hardened+bytecode build boots, full
flow, engine running, 196 FPS, 0 errors, no false tamper warning.

Five hardening layers + this = a cracker must find seven canaries and several
delayed, diffuse consumers inside obfuscated V8 bytecode, all while the bot
appears to work for the first 15 minutes. Honest ceiling unchanged: still
crackable by someone determined, just far more miserable.
