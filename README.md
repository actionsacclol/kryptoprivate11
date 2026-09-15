# Krypto Bot

**A local-first Solana memecoin trading terminal.**
Free to download. No ads, no telemetry, no subscription, no Krypt account.
Krypt takes 0.5% of each side of a trade you execute through it — see
[Execution model](#execution-model--read-this-before-you-fund-anything).

Krypto Bot is a desktop trading terminal for Solana memecoins: discover new launches,
graduating and migrated tokens, read the numbers that actually gate a trade, chart them,
and execute manually from a wallet whose key never leaves your machine.

Underneath it is a full on-chain automation engine — the original Krypt Sniper — which
still watches Pump.fun live, scores launches, paper-trades them and records everything for
replay. That engine now also feeds the terminal: when it is running, Krypt charts a token
**from its own live feed**, which is why 1-second candles exist here for coins that no
chart provider has indexed yet.

Part of the [Krypt](https://krypt.cc) free tools suite · [Discord](https://discord.gg/muzFKR657F)

---

## The one thing that makes this different

Every number on screen carries where it came from, and **a number nobody could produce is
shown as an em dash, never as zero.**

That sounds small. It is the whole design:

- The security score is an average over **the checks that actually resolved**, and it says
  so ("averaged over the 6 of 11 checks that resolved"). An unread mint account does not
  quietly become a pass. Under four resolved checks it refuses to print a score at all.
- Mint and freeze authority verdicts come from **our own RPC read**, never from a
  third-party audit flag — a cached index is wrong about exactly the case that matters.
- A filter over a metric that has not arrived yet **skips** that token rather than hiding
  it, so setting a holder floor does not blank the New column.
- The chart never invents a candle for a period with no trades.
- When something cannot be shown, the app says why and what would fix it, rather than
  rendering an empty panel that looks like the token has no holders.

## What's in it

### Terminal

- **Discover** — four live columns (New / Graduating / Migrated / Trending) with the full
  token card: market cap, liquidity, volume, buys/sells, holders, dev %, top 10 %, bundle %,
  bonding-curve progress, socials, DEX-paid, Krypt score, and quick buy.
- **Filtering** — every min/max from the spec (age, MC, liquidity, volume, txns, buys,
  sells, buy/sell ratio, holders, holder growth, top 10 %, dev %, insider %, sniper %,
  bundled %, smart holders, curve %, score) plus launchpad, socials and DEX-paid gates,
  with six built-in presets.
- **Token page** — candles from 1s to 4h with a market-cap/price toggle, a security report,
  a holder list with dev/whale/smart-money tagging, live trades, Trader Scan, and a trade
  panel with the all-in cost broken out before you click.
- **Search** — Ctrl+K anywhere; paste a contract address and it opens, even with every
  third-party provider switched off.
- **Launch analysis** — paste any pump.fun contract address, however old, and the Launch tab
  reconstructs its first block of trades: what the dev bought, what was bundled (bought in the
  same slot as the very first trade, which nobody can react to), what was sniped in the
  ~8 seconds after, and — the number that actually decides anything — **how much of it those
  wallets still hold**, read from the chain. Alongside it, the creator's full pump.fun track
  record: launches, how many graduated, and their busiest 24 hours, which is what exposes a
  launch factory. Free, no API key. When the launch window cannot be isolated, it says so and
  shows no cohorts rather than an estimate.
- **Holder map** — a bubble chart of the holder distribution (area = share of supply,
  colour = dev / whale / smart money / fresh wallet), plus an opt-in funding analysis that
  reads each holder's earliest transactions to find wallets sharing a funder. That cluster
  count is the honest version of "bundled %": it says what was observed, reports how many
  RPC calls it spent, and states plainly that a shared funder is not proof of one owner.
- **Orders** — stop loss, take profit, trailing stop, limit buy/sell (on price or
  market cap), and trigger orders (sell if the creator sells, buy/sell on migration).
  Armed orders draw as lines on the chart. Partial sells work from 1% to 100%.
- **Group Wallets / Funder** (Automation) — make a group and fill it with wallets, then
  fund them from your main wallet in one transaction (by group or one by one) and collect
  SOL back. Groups organise the wallets you hold; nothing trades them on your behalf. The
  signer only ever sends SOL to wallets this install holds.
- **Portfolio** — positions joined from the chain (what you hold) and a local fill ledger
  (what you actually paid, read back from the transaction), with realized/unrealized PnL,
  win rate, profit factor, fees, an equity curve, trade history, CSV/JSON export, and
  shareable PnL cards rendered locally to PNG.
- **Alerts** — market cap, price, volume, liquidity, holders, curve progress, dev sells,
  migration, and tracked-wallet activity, as desktop notifications.
- **Hotkeys** — single-keypress buy/sell on the open token. Off by default, confirmation on
  by default, ignored while typing.
- **Copy Trading** — track and label other traders' wallets, and **paper-copy** them before risking anything. (Your own keys live under **Wallet**.)
- **Watchlist** — pinned tokens, stored locally.

### Automation (the original engine, intact)

Live Pump.fun `logsSubscribe` feed with a racing socket pool, Anchor event decoding,
fail-closed risk checks, creator reputation, a two-stage opportunity score, a full paper
exit state machine, honest paper fills against live virtual reserves, three shadow strategy
labs, and a JSONL recorder for replay. Six months of adversarial research on it is in
`docs/` — including the negative results, which are the reason there is no autonomous mode.

## How orders behave

These are user-directed automation — the app never decides to open a position, it only
carries out an instruction you wrote on a token you were looking at. The rules are
deliberate and each one is pinned by a test:

- **Exactly once.** An order leaves `armed` one time, and that transition is flushed to
  disk *before* anything is signed. A crash mid-execution leaves an order that never
  re-fires. The failure mode is "did not sell", never "sold twice".
- **A blocked order is not spent.** If a stop's condition is met while live execution is
  off or the engine is disarmed, the order stays armed and warns you loudly. Marking it
  failed would be protection you no longer have and don't know you lost.
- **Paused after a restart.** Orders persist but come back `paused`, with a banner. A stop
  loss must not fire into a market the app wasn't watching, and it must not silently
  vanish either — so it survives, visibly, until you resume it. A trailing stop's peak
  resets on resume, because a high from an unobserved window would trigger it instantly.
- **Failures are not retried.** Retrying against an unknown post-broadcast state is how you
  sell twice.
- **Breakers stop buys, never sells.** A loss-limit pause blocks an order-driven buy but
  never blocks an exit — a breaker that traps you in a position is worse than the loss.
- **Partial sells go through the relayer** (0.5%). The local transaction builder can only
  sell a whole position and closes the token account afterwards, so it is withheld from any
  order under 100% — routing a partial through it would dump everything while reporting a
  partial fill.

## Platform coverage

The terminal half is platform-agnostic; the automation half is not, and the line is worth
knowing:

| | pump.fun | Meteora DBC | Everything else |
|---|---|---|---|
| Search, token page, security, holders, 1m+ charts | yes | yes | yes |
| Trending / New discovery | yes | yes | yes |
| Buy and sell | yes | yes | PumpSwap, Raydium, Meteora, Orca via Jupiter; LaunchLab via the relayer |
| Orders and alerts on price / market cap | yes | yes | yes |
| Portfolio, PnL, fill ledger | yes | yes | yes |
| **1s charts, live trades, Trader Scan** | yes, always | yes, for the token you have open | no |
| Graduating column | yes | yes, exact | no |
| Migrated column | yes | yes | yes, any DEX |
| **Launch analysis (bundle / sniper / dev, and what they still hold)** | yes, for any CA | no | no |
| **Creator track record** | yes, for any CA | no | no |
| Copy trading, dev-sell triggers | yes | no | no |

**Why DBC is per-token rather than always-on.** pump.fun emits its events with Anchor's
`emit!`, so they arrive as log lines and one `logsSubscribe` sees every trade for free.
Meteora DBC uses `emit_cpi!` — the events are inner instructions, invisible to a log
subscription. Decoding all of them would mean a `getTransaction` per trade across the whole
program, which rate-limits a free RPC immediately. So Krypt subscribes to the **pool of the
token you have open** (`logsSubscribe` takes an account filter) and fetches only those.
Bounded, free, and it gives you a 1-second chart on a token no provider indexes yet. What it
cannot give is launch-wide analysis, because that genuinely needs to see everything.

**Graduating and Migrated are multi-platform.** Migrated is any brand-new AMM pool
(GeckoTerminal sees every Solana DEX), which is what graduating produces whoever the
launchpad was. Graduating merges pump.fun's own reserves with **exact** Meteora DBC progress,
read from the pool and config accounts — `quoteReserve / migrationQuoteThreshold`. That
threshold is per-config and observed values span from 0.000499 SOL to 66.04 SOL, so it is
read, never assumed. A pool whose threshold cannot be read is left out rather than shown at
a made-up percentage.

The DBC layouts come from the program's own on-chain Anchor IDL and are pinned in
`test/dbcdecoder.test.mjs` (against harvested mainnet events) and `test/dbcaccounts.test.mjs`
(account offsets). They were cross-checked two ways: the progress derived from account reads
(15.50%) matched the figure the event decoder produced for the same pool moments earlier
(15.30%). `npm run test:dbc` re-verifies the live path.

## Copy trading is paper-first, on purpose

Following a wallet is an automated strategy whose edge you have not measured, delegated to
someone who does not know you exist. So a copy config starts in **paper** mode and disabled,
and the paper record is kept honestly enough to actually decide on:

- fills use the price **after your configured delay**, not the price the wallet got — copying
  is a latency game, and filling at their price is the self-flattery that makes copy trading
  look profitable when it isn't;
- a flat round trip **loses money**, because the paper model pays what a real one would on
  both sides: the 1% protocol fee and Krypt's 0.5%;
- trades your filters rejected are **recorded as skips with reasons** — a scorecard that
  hides what it kept you out of is measuring the wrong thing;
- switching a config to live **disarms it**, so arming live is always a separate, confirmed
  act, and a live config never comes back armed after a restart.

## What the portfolio numbers actually mean

Cost basis comes from a local ledger that reconciles every fill **against the chain**: the
net lamport change in your own wallet for that transaction. That figure includes the priority
fee, any Jito tip, the relayer's cut, token-account rent and slippage — none of which appear
in the amount you requested. Building PnL on the requested amount would be wrong in your
favour on every row.

Where the join fails, the number is null and the page says so:

- a position whose tokens didn't come through Krypt has **no cost basis**, so its PnL reads
  as unknown, never as zero;
- holding more of a mint than the ledger recorded invalidates the basis rather than averaging
  over a hole;
- fills that couldn't be read off the chain are counted, excluded from every figure, and
  named in a warning strip at the top of the page.

Realized PnL uses **average cost**, not FIFO — that is what "I'm up 2x on my bag" means — and
the page says which convention is in play.

## Where the data comes from

Krypt has **no backend**. Your machine talks to these hosts directly, so Krypt never learns
what you trade — and neither does anyone else unless you leave their provider switched on.
Settings → Market data names every host, shows a live call/error/latency count for each,
and has one switch that turns all of it off.

| Provider | Key needed | What it is the source for |
|---|---|---|
| `lite-api.jup.ag` | no | Prices, market cap, liquidity, holder counts, buy/sell counts, dev + top-holder audit |
| `frontend-api-v3.pump.fun` | no | New / graduating / migrated feeds, bonding-curve reserves |
| `api.dexscreener.com` | no | Trading pools, socials, DEX-paid status |
| `api.geckoterminal.com` | no | Candles, 1 minute and up |
| `public-api.birdeye.so` | **yes** | Sub-minute candles, full holder lists, historical trades |
| your Solana RPC | optional | Mint/freeze authority, supply, top holders — **authoritative** |
| Krypt's own live feed | — | 1s/5s/15s candles, live trades, Trader Scan |
| Meteora DBC program | — | Live tape for DBC-launched tokens (Believe, Boop and friends), per open token |

With market data off entirely the app still works: on-chain reads, the live feed and the
whole engine are unaffected. What you lose is charts and any token the engine has not
personally watched.

**Token images** are fetched through a hardened main-process handler (`krypt-img://`):
https only, hostname resolved and checked against private ranges before the request, no
redirects, no SVG, size-capped while streaming. The renderer's CSP never allows a remote
image host directly. It is still your IP that reaches the image host, which is why there is
a switch for it.

**The public Solana RPC rate-limits holder lookups specifically.** A free Helius key
(Settings → Solana RPC) fixes the holders panel and is the single highest-value
one-field upgrade.

## Execution model — read this before you fund anything

**This app can hold a key and sign real transactions.**

- **Nothing signs without a wallet you created.** There is no key until you generate or
  import one on the Wallet page. Once one exists, **Live is the default mode** (since
  2026-08-29): a trade you place is signed and broadcast. Paper is the opt-in toggle in
  the top bar, and every disarm — yours, a loss breaker, a decoder drift — flips the
  persisted mode back to Paper until you switch it on again. With no wallet, the terminal,
  the scoring, the paper fills and the recording all work and nothing is submitted.
- **The app never decides to trade.** Autonomous strategy firing was removed on
  2026-08-16 and has not come back: no strategy, score or signal opens a position. The
  scanner's job is to **flag potential runners** — launches whose measured graduation odds
  sit in the top buckets — and tell you, with the bucket's observed rate and the base rate
  beside it; you open the token and decide. Paper auto-entry is an opt-in research toggle
  (off by default) because the measured record for it is negative. Every
  real transaction traces to something you did — a click in the trade panel, a Discover
  quick-buy, or **an advanced order you wrote yourself on a token you were looking at**.
  That last one executes later, without a click at that moment, which is the entire point
  of a stop loss; it is gated on exactly the same switches as a manual trade (engine
  **armed**, `liveEnabled` on, funded wallet, per-trade cap) and follows the rules in
  *How orders behave* above. If you want zero delayed execution, cancel your orders — the
  Orders page lists every one.
- **What Krypt charges.** 0.5% of each side of a trade executed through the app, taken on
  the same transaction, so a round trip pays it twice. It is shown in the trade panel's
  cost breakdown before you commit, and the treasury address is a constant in
  `shared/fees.ts` pinned by a test. Referred users send 20% of that fee (0.1% of the
  trade) to their referrer. Nothing else is charged: no subscription, no ads, no data
  sale. Third-party costs — the 1% pump.fun protocol fee, priority fees, landing tips,
  and the relayer's 0.5% when the local builder cannot be used — are not ours and are
  listed separately in the same breakdown.
- **The key** is generated in-app and encrypted with Electron `safeStorage` (Windows DPAPI
  / OS keystore). It never reaches the renderer or a log. It is still a hot wallet on your
  desktop: fund it with what you can afford to lose, set the max-balance cap, set a
  withdrawal address.
- **Known gaps, stated plainly** (`docs/product-swarm-2026-08-16.md` §8): the signer
  validates the fee payer and enforces a destination rule and lamport cap, but startup
  chain-reconciliation is not implemented. (`buildLocalTrade` is pinned against real
  landed trades — `test/fixtures/pump-derived-layout.json` — and ships **on** since
  2026-09-01; every local build is still simulated before signing, with the relayer as
  fallback.)

**Why this project exists:** six months of adversarial research swarms failed to find a
profitable automated memecoin strategy here, and the write-ups are in `docs/`. That negative
result is why this is now a terminal you drive rather than a bot you trust, and why there is
no win-rate claim anywhere in this README.

## Getting started

```bash
npm install
npm run dev          # development (Vite + Electron)
npm run typecheck    # both TS projects
npm test             # decoder, curve, tape, filter, order-engine and SSRF-guard tests
npm run test:market  # LIVE check against the real provider APIs (slow, networked)
npm run dist         # build the Windows installer
```

Works out of the box with no API keys. For serious use set a dedicated RPC
(Helius / QuickNode / Chainstack free tiers) in **Settings**.

## Architecture

```
                    ┌─ providers/ (jupiter, pump.fun, dexscreener, geckoterminal, birdeye)
market/  ───────────┤   all behind one hardened fetch: fixed host allowlist, no redirects,
  (main process)    │   streaming size cap, per-host rate limiting
                    ├─ onchain.ts  — our own RPC reads, authoritative
                    └─ tape.ts     — our own live feed, sub-second candles
                          ▲
Solana WSS feed ──► decode ──► track ──► risk ──► score ──► strategy ──► paper positions
  (racing pool)                                                              │
                                                                    JSONL recorder
```

`src/**` never imports `electron/**`; everything crosses via `window.krypt.*` using the
types in `shared/`. Every `ipcMain.handle` lives in one file. No market-data channel accepts
a URL or a host — the renderer names a mint, a column or an interval, and main decides which
of its hardcoded hosts to contact.

## Building for Windows, macOS and Linux

`npm run build` compiles the app; `npm run dist` packages it. The packaging targets are
Windows (NSIS installer), macOS (dmg and zip) and Linux (AppImage and deb). Icons come from
`resources/`: `krypt.ico` for Windows, `krypt.icns` for macOS, `resources/icons/*.png` for
Linux, all derived from `resources/krypt.png`.

**Each platform must be built on that platform.** The hardening step compiles the main
process to V8 bytecode, and V8 accepts cached data only from the same version, flags and CPU
features. Bytecode compiled on Windows is rejected on macOS or on arm64, and the app would
die at startup with `cachedDataRejected` and no other clue. `npm run build` stamps what it
targeted and packaging refuses a mismatch with an explicit message, so this fails loudly at
build time rather than silently on a user's machine. A GitHub Actions matrix that runs
`npm run dist` on `windows-latest`, `macos-latest` and `ubuntu-latest` is the intended
release path. For a portable build with no bytecode, set `KRYPT_OBFUSCATE=0`.

Two things are not solved by configuration:

- **macOS signing.** An unsigned build is blocked by Gatekeeper on other people's machines.
  Shipping to macOS users needs an Apple Developer ID, codesigning and notarisation, which
  are credentials, not settings. The fuse step already resets the ad-hoc signature so signing
  runs after it.
- **Linux key storage.** Wallet secrets are encrypted with Electron's `safeStorage`, which on
  Linux needs a desktop keyring (GNOME Keyring or KWallet). Without one, the app reports that
  secure storage is unavailable and refuses to create or import a wallet rather than writing
  a key in the clear.

## Risk disclosure

Memecoin trading is extremely high risk. A large majority of new Pump.fun tokens are dead
the same day they launch, and no filter catches every rug. This software is a research and
evaluation tool; simulated performance does not predict live results. Nothing here is
financial advice.

## License

MIT © [Krypt](https://krypt.cc)
