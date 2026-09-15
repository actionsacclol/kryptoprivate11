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

## Layout: a Hub, workspaces, and multi-panelling (2026-09-09)

The app had grown to twenty-five routes in one flat sidebar, so "Funder" sat
four rows from "Orders" and a page that trades on its own initiative sat beside
one that only moves when you click. It now opens on a **Hub** and the sidebar
lists only the workspace you picked.

- `src/workspaces.ts` is the map. Each workspace owns routes, may borrow one
  (`extraRoutes` — Wallet is listed under Terminal for arming but lives in
  Wallet Utilities), and names its own sidebar sections. **One home per route**,
  derived from declaration order.
- **Workspaces:** Terminal (find and trade by hand), Copy Trading, Main Engine
  (the scanner, scripts, everything autonomous), Wallet Utilities (your keys and
  the Wallet Lab), Settings & Legal.
- **Hub buttons** in the sidebar and the top bar. Cards show what is true now —
  the engine says "Scanning, N launches seen" or "Stopped"; unknown is an em
  dash, never 0.
- `src/components/PanelGrid.tsx` is the multi-panel container:
  `react-grid-layout`, drag by the panel header so content stays clickable,
  resize from the corner, arrangement saved per grid id in localStorage with
  every read and write wrapped. A saved layout that predates a new panel
  re-seeds that panel rather than leaving it invisible.
- **Wallets are three separate pages**, not one page with a chain switch:
  **Sol Wallet**, **Robinhood Wallet**, **BNB Wallet**, each its own sidebar
  entry under "Your wallets". Someone looking for their BNB balance finds "BNB
  Wallet" in the menu instead of discovering that "Wallet" means something
  different depending on a control in the top bar. A first attempt put all
  three on ONE page as a panel grid — it was cluttered, and separate pages are
  what "clean and simple" actually meant.
- `PanelGrid` is built and tested but currently has **no caller**. It is the
  seam for a surface that genuinely wants several live things at once (a
  trading screen, an engine dashboard) — not for a page that just has three
  subjects.

**The EVM subtlety, because it will bite anyone who touches this.** The EVM
wallet is ONE key with the same address on both chains — only balances,
Paper/Live, holdings and fills are per chain. `EvmWalletPanel` gained `only`
(narrow every per-chain surface to one chain) and `showWallet` (render the
shared key block). On separate PAGES the key block shows on both, because the
controls are identical and idempotent and making someone leave the BNB page to
find their address would be the opposite of simple; the panel header says the
key is shared. `showWallet` remains for a future surface that shows two chains
side by side, where duplicate "Remove wallet" buttons WOULD be dangerous.

A chain disabled in Settings gets no menu entry at all (`hiddenRoutes` on the
sidebar). That was deliberate in the original panel — its strip could arm a
chain with no other surface, and its balance poll kept hitting an RPC the user
turned off. A menu entry opening an armable page is the same hazard one click
further away.

**Reachability is the thing that can silently break here.** The sidebar now
filters, so a route no workspace lists becomes unreachable while still
compiling and rendering no error. `test/workspaces.test.mjs` pins it: every
route has a home (`paper` excepted, delisted on purpose in 09-06), no route is
owned twice, sections cover every listed route exactly once, and every
workspace opens on a page it actually lists.

## API, rate-limit and capacity swarm — and every fix from it (2026-09-09)

Six researchers over Solana RPC, EVM RPC on both chains, market providers,
request efficiency, failover and live feeds, under one rule: never invent a
number, cite a source you fetched or a header you observed. Write-up in
`docs/api-swarm-2026-09-09.md`. Everything found was then fixed and is green:
**90 suites, both typechecks clean, build and the live sandbox test pass.**

**The pattern worth remembering: a refusal that does not look like a refusal
defeats everything built to handle refusals.** Five P1s from four independent
researchers were the same bug — GeckoTerminal refusing with HTTP 200 and a JSON
body, the Solana RPC refusing with a JSON-RPC error, a Cloudflare challenge read
as a bad key, an Ankr 200 auth error. The fetch layer branched on status alone,
and its success path ran `blockedUntil.delete(id)`, so a polite refusal actively
UN-parked a provider an honest 429 had parked. Fixed with a body validator that
runs before the status branch.

**The public Solana RPC meters PER METHOD and publishes it on every reply.** The
app's limiter assumed a flat 40 for everything: 30× too slow on cheap methods,
4× too fast on the three the trade path hammers, and `getTokenLargestAccounts`
has a budget of **0** — closed, not throttled, refused on the first call. Worse,
the park was keyed by host, so that one guaranteed refusal blinded every other
RPC read for ten seconds. Now server-driven, seeded with measured floors, and
parked per `host#method`.

**Idle Discover made 230 requests a minute, 89 of them to pump.fun against a
published 60.** Rows were bought back individually after a list route had
already returned them, and a per-row creator history duplicated a number
Jupiter already puts on every row for free. Now 26/min to pump.fun, and the New
column got back its configured refresh, which the per-row traffic had been
halving.

**An unreadable mint scored SAFE.** "Account not found" was marked `checked`,
and downstream a null authority on a checked mint reads as positively-observed
absent — the safe state in SPL. So a lagging node on a seconds-old mint rendered
"Mint authority: Disabled" on the two heaviest security gates. One word.

**`x-ratelimit-pubsub-limit: 10` counts CONNECTIONS per IP, not subscriptions
per socket** (16 acked on one socket, connections 11–13 refused at handshake).
Both feed modules encoded the wrong reading, silently unwatching copy leaders
past ten and telling the user to buy a key for a limit that does not exist.

**BNB has no single free endpoint that does everything**, and the config modelled
it as if one nearly did. `receiptRpc` is replaced by a six-capability endpoint
map — receipts, state, logs, simulate, broadcast, ws. That lifted the launch
index off a ~67-minute ceiling that was the endpoint's archive wall, not the
chain's, and stopped fills being priced from a 50-second state window against a
60-second receipt timeout.

Also: `powerMonitor` suspend/resume with staggered redial (a lid opening used to
stampede ten sockets into a ten-connection budget); both key-redaction gaps
closed; Jupiter moved off a retiring host (**note: a key makes it slower, 1 rps
vs 8 — the reason is retirement, not throughput**); "Powered by Jupiter"
attribution added, which their terms require; and the privacy policy's host list
corrected — it was three hosts short, so `TERMS_VERSION` is now `2026-09-09.2`
and users will be re-prompted to accept.

**One decision left for you:** the `blockFeed` standby defaults ON, measured at
5.51 GB/h, with no UI to disable it, and produces nothing while pump still emits
logs. Three options are written up in §8b of the doc. It is a bandwidth-versus-
insurance tradeoff, not a defect, so I did not pick one.

**Recurring wrong claim, now warned about in the doc:** three separate agents
reported GeckoTerminal as "documented 10/min" and recommended lowering the app's
28/min. It is 30/min for the public API; the 10 is a marketing page for a paid
CoinGecko product on another host. Do not act on it.

## Scripting and automation audit — the widest one yet (2026-09-09)

Six dimensions, an auditor and an adversarial skeptic each, over everything
that can spend money with no human at the button: user scripts, the sandbox,
advanced orders, copy trading, the Wallet Lab, and the renderer that arms them.
Full write-up in `docs/automation-audit-2026-09-09.md`. Everything below is
fixed and pinned; `npm test` is 86 suites, `npm run test:sandbox` is 17 checks.

The ones that would have cost real money:

- **A script could sell bags it never opened.** `sell_all` meant "every
  position in the wallet". The shipped "Daily housekeeping" example, which the
  Scripts page offers by default the moment you pick the schedule trigger,
  would at 23:55 market-sell every hand-bought hold and report success. A
  script now sells only what it opened; `held` and `bot.positions()` mean this
  script's positions; a position rule never fires on a foreign bag.
- **The budget walls had no lock.** `act()` was fire-and-forget from a
  synchronous engine event, so eight swaps in one slot each read the same
  pre-buy counters and eight buys landed against a limit of three. Actions now
  run one at a time per script, and the kill switch is re-read after every
  await.
- **A leader trimming 40% of their bag sold 40% of ours** — hand-bought size
  and ladder-held size included. The mirror is now scaled by the copy's share
  of our on-chain basis. It was also DEAD on the pump rail: the curve log feed
  delivered the sell first with no fraction and the signature dedupe threw away
  the watcher's later, fraction-bearing copy.
- **The Warmer's realised-loss cap could read a losing run as 0.000 SOL**,
  because it counted only reconciled fills and *pending* is the normal state of
  a fresh one. Unknown is now a stop, and an em dash.
- **WebRTC was reachable from inside the script sandbox.** A control probe
  reached Google's STUN server and got back this machine's public IP. CSP3's
  `webrtc 'block'` is not implemented in Electron 43 and deleting the
  constructor is defeated by `window[0]`; the fix is
  `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` plus a direct proxy on
  the partition.
- **Every code script was dead in a packaged build.** The bytecode step
  compiled the sandbox preload, which has no Node `require`, so the stub threw
  on line 1 and scripts failed with nothing but a start timeout. The harden
  step now fails the build if any preload contains `bytenode`.
- **A take-profit ladder over-sold.** Two rungs sized off the same build-time
  balance and both landed: 40/50 sold 90% where it meant 70%. Orders also
  carried no wallet, so a stop written on wallet A could fire against wallet B
  or be destroyed permanently.
- **Five modules treated an unreadable state file as an empty one** and the
  next save overwrote it: orders, copy configs, scripts, lab runs and the copy
  store. All now follow `ledger.ts` — ENOENT is a fresh start, anything else
  refuses to persist and is named in the startup dialog.
- **The app never quit while a code script was running.** Sandboxes are hidden
  windows, so `window-all-closed` never fired: on Windows, closing the terminal
  left it running headless with no `before-quit`, no drain, and a LIVE-armed
  script still spending.

**The `no ready within 8000 ms` stall users reported is fixed and pinned.** It
had one message and two unrelated causes, which is why it was undiagnosable.
The sandbox now signals `alive` (the harness's first statement, before the
user's code compiles) separately from `ready` (after the user's top-level code
finishes), and `preload-error` is subscribed — nothing listened to it before,
so every preload failure was silent and looked like a plain timeout. A missing
preload is now named as a broken install in about 4 s. A slow top-level
`await`, which is documented and promised by the AI prompt pack, is no longer
mistaken for a dead sandbox: on the 8 s deadline the renderer is probed for
liveness and a live one is given up to 30 s, while one that has stopped
answering is killed at once. A stalled start is retried three times with
backoff instead of disarming the script, and a script whose body throws still
disarms immediately. `npm run test:sandbox` is 20 checks now: an 11 s top-level
await starts, and a deliberately missing preload reports as an install fault.

Also: `before-quit` now stops the Wallet Lab first and flushes advanced orders;
a copy follower can no longer be created or flipped to live while armed; a
`pct` trigger basis on a limit order is refused instead of arming at $20 market
cap; per-mint cooldowns survive a restart; and `tokenFacts` fills liquidity and
market cap for feed tokens, without which the now-fail-closed copy filters
would have refused every copy on the pump rail.

## BNB rail audit — five P1s fixed (2026-09-09, after the Robinhood one)

Five-lens swarm over BNB (four.meme execution, PancakeSwap routing, data/PnL,
renderer+settings+parity, a live read-only probe), each finding refuted by a
skeptic and every P1 re-proved on chain. Everything: `docs/bnb-audit-2026-09-09.md`.

- **P1 — a dust v2 pair beat the real pool and the trade FILLED.** `resolveBnb`
  accepted any non-zero `getPair` without reading reserves or comparing v3; the
  quote came from the same dead pair, so nothing reverted. A 0.1 BNB buy
  returned 0.025 tokens where v3 returned 172.73 (6,792×; others 945×, 1,252×,
  25,689×). Venues are now chosen by what they actually QUOTE.
- **P1 — USD1/USDT-quoted four.meme tokens were tradeable once graduated:** the
  quote guard sat after the `liquidityAdded` branch. Hoisted, as Robinhood's is.
- **P1 — no BNB fill could ever reconcile.** publicnode refuses
  `eth_getTransactionReceipt` at every depth and historical balances past ~50
  blocks, so every trade timed out unconfirmed and every position had no basis.
  `CHAINS.bnb.receiptRpc` + `client.receiptClient()` now serve receipts and the
  balances that price a fill; a refusal is recognised, not retried for a minute.
- **P1 — the rail simulated `minAmount: 0` and signed a real minimum**, while
  four.meme's `tryBuy` ignores a per-token CREATOR BUY TAX (1/2/3/10 % tiers, up
  to 9.8 %): 18 of 38 fresh-curve buys reverted at the shipped 5 % slippage. The
  quote now comes from the simulated fill and names the tax.
- **P1 — partial sells were broken on every four.meme token:** the contract only
  accepts amounts that are whole multiples of 1e9 (`GW` otherwise), so 25 % and
  75 % failed in every case (24 of 28 measured) after the user paid for an
  approval. Amounts are floored to the quantum and the sell is simulated first.
- **P2s:** Migrated was structurally empty (built from a 1-hour launch index
  while graduation takes far longer) — now seeded from PancakeSwap's pool
  listings and priced from the pool; New served ~12 rows whatever was asked
  (filter ran after the slice); the graduating scan collapsed silently on one
  oversized log query; the sold-out curve window was offered as tradeable; a
  fabricated all-zero deployer; the shared platform contract listed as each
  token's pool; curve fees billed on the requested not the filled amount; the
  sell floor ~1.5 % looser than displayed; a disabled chain still polled; wallet
  IPC answered for Robinhood whatever chain asked.
- After: `npm test` 86 suites, typecheck 0, live smoke both chains, build 0.

## EVM rail audit — two P1s and a dozen P2s fixed (2026-09-09)

Eight-lens audit swarm over the Robinhood rail (execution, keys/signer, fees and
anti-tamper, data/PnL, renderer parity, lifecycle, a live read-only probe, and a
Solana parity matrix), each finding then handed to a skeptic told to refute it.
51 findings survived. Everything: `docs/evm-audit-2026-09-09.md`.

- **P1 — a Pons curve position could not be sold.** The curve pulls tokens with
  `transferFrom`; the sell plan sent no approval, so every curve exit reverted
  `ERC20InsufficientAllowance` in both modes and the quote silently fell back to
  the formula. `plan()` now queues a `token→curve` approval (policy pinned to
  that curve, like the four.meme branch) and `simulateSell` takes an allowance
  state override so the quote stays real. Pinned live in `npm run test:evm`.
- **P1 — a wallet could exist only in memory.** `evmWallet.persist` set the
  cache before writing; a failed write left an auto-active wallet whose key was
  never on disk. Cache is assigned after `renameSync`, `persist` throws while a
  load failure is set, and the wallet IPC handlers catch.
- **P2s:** stock/USDG-paired Pons launches were routed as tradeable and priced
  as ETH (a 20× market cap); Robinhood's Universal Router needs an extra per-hop
  field so every v3 trade reverted `SliceOutOfBounds`; a referrer that cannot
  receive native reverted every pool trade (a fee must never block an exit); the
  Alchemy key reached `app.log`, the Console page and toasts; the EVM ledger
  (and Solana's) overwrote itself when unreadable; a landed fill could vanish
  between send and receipt (now recorded pending from the locally derived hash,
  with a bounded drain at quit); `/status` said "disarmed" while a chain was
  live; the legal documents omitted every EVM host and misstated the curve fee
  (TERMS_VERSION bumped); `rail.state()` blocked on the RPC so the UI said "no
  wallet"; a bad RPC key looked like an outage (now a 15-minute fallback with
  `rpcStatus`, and a Cloudflare 403 challenge is parked, not mistaken for a bad
  key); BNB's index could die for the session; BNB's Graduating column was
  structurally empty (700-block lookback → 0 rows while 9 tokens were above 3 %).
- **Still open by decision:** position value is spot × amount, not a sell quote
  (labelled); the renderer bundle carries the treasury constants (cosmetic, same
  as Solana); a curve fee is still dropped on a receipt timeout or a quit; EVM
  has no loss breakers, caps, withdraw, Trades rows or hotkeys — all now
  labelled Solana-only rather than silently missing.
- After: `npm test` 86 suites, typecheck 0, live smoke on both chains, build 0.

## Three chains: the EVM rail generalised, BNB added, chain switch in the top bar (2026-09-09)

User's ask (with a screenshot of the Discover toggle): move the Solana | Robinhood switch
to the top bar, make balance and wallet follow it, isolate each chain, and add BNB
memecoins. Research + probes: `docs/bnb-chain-2026-09-09.md`.

- **One EVM rail, per-chain config.** `electron/evm/chains.ts` (`CHAINS[chain]`: viem
  chain, shared addresses, `feeRule 'base2x' | 'gasPrice'`, public rate gate), `client.ts`
  (per-chain batched + unbatched clients, per-host 429 gate), `evmWallet.ts` (ONE wallet
  list for both chains — same key ⇒ same address; balances keyed `chain:address`;
  `signTransaction(chain, …)` refuses a policy for another chain id), `ledger.ts` v2
  (`chain` on fills, `nativeDeltaWei`), `venue.ts` dispatch, `trade.ts` / `market.ts` /
  `discover.ts` / `rail.ts` take `chain`; IPC `evm:*` take `chain` FIRST. Arm state is per
  chain; switching the shared wallet is refused while ANY EVM chain is armed. Contract:
  `shared/evm.ts` (`ChainKind` + 'bnb', `EVM_CHAIN_META`, `*Native` field names,
  `VENUE_LABEL`); settings `evm = { slippagePct, referrer, robinhood:{enabled,rpcUrl,
  apiKey}, bnb:{…} }` (deep-merged in settings-store).
- **BNB Smart Chain (56)** via **four.meme**: `bsc.ts` + `fourmeme.ts`. Quotes come from
  the platform's Helper3 (`tryBuy`/`trySell`/`getTokenInfo`), buys are `buyTokenAMAP`
  (403k gas simulated), sells use the platform's native third-party fee (whole 0.5 % to the
  treasury; no referrer split), graduation at 18 BNB into a PancakeSwap v2 pair (Universal
  Router 2 + Pancake's OWN Permit2 `0x31c2…`); only BNB-quoted launches (~10 %) trade,
  USDT/stock-quoted ones are shown. Fee rule: priority = gasPrice (0.05 gwei floor, base
  fee 0). **publicnode's free `eth_getLogs` reaches only ~10,000 blocks back** (5,000-block
  range cap; bnbchain dataseed says "limit exceeded"), so the BNB index covers the last hour.
- **Renderer** (fork): `ChainSwitch` in the TopBar, readouts + Paper/Live per chain,
  Discover follows `term.chain`, `EvmTokenPage({ chain, address })` (was RobinhoodToken),
  EVM watchlist pins stored as `chain:address`, wallet panel shows both chains' balances,
  settings card per chain, portfolio card per chain.
- Live check: `npm run test:evm` (both chains; `-- bnb` for one). Verified 2026-09-09:
  every column on both chains, four.meme curve quote, CAKE on pancake-v2, per-chain arming.

## Robinhood Chain — a second chain as a parallel rail (2026-09-08)

Robinhood Chain (Arbitrum Orbit L2, chain id **4663**, ETH gas, mainnet since
2026-07-01) is in the terminal beside Solana. Its pump.fun is **Pons V2**: 1 B tokens
on a constant-product curve, 1 % fee + creator tax, graduates at **4.2 ETH** into a
locked Uniswap v4 pool with the Pons hook (~400 launches per half hour measured).
Research, every verified address and the probe answers: `docs/robinhood-chain-2026-09-08.md`.

- **Not a chain abstraction.** The Solana engine is untouched. `electron/evm/` is
  the rail: `chain.ts` (addresses/ABIs/topics/selectors, pinned by tests),
  `client.ts` (viem; batched reads, an unbatched log client, a gated fetch — the
  public RPC 429s bursts with a single JSON object that viem cannot map onto a
  batch), `evmWalletStore.ts` + `evmWallet.ts` (`evm-wallets.json`, safeStorage,
  ONE active signer, switch refused while armed), `policy.ts` (pure last gate before
  a signature), `pons.ts` / `uniswap.ts` / `venue.ts` / `trade.ts` (route → quote →
  build → estimateGas → policy → sign → send → receipt → ledger, one trade at a
  time), `ledger.ts` (`evm-fills.json`; basis from the receipt block's balance diff),
  `discover.ts` (rolling TokenLaunched index + multicall curve states), `market.ts`,
  `rail.ts`. Contract `shared/evm.ts`; IPC `evm:*`; preload `krypt.evm.*`.
- **Same panels, tagged rows.** `TokenSummary.chain = 'robinhood'` (`mint` = 0x
  address, `priceSol` = ETH); the renderer routes a token page by address shape
  (`isEvmAddress`). Discover has a Solana | Robinhood toggle; new pages/components:
  `RobinhoodToken.tsx`, `EvmTradePanel`, `EvmPositionPanel`, `EvmWalletPanel`,
  `EvmSettingsCard`, `EvmPortfolioCard`, `useEvmState`.
- **Execution is our own builder.** Curve trades call `buy`/`sell` directly; pool
  trades go through the Universal Router (v4 with the Pons pool key from the factory
  record; v3 by probing the four fee tiers). Quotes are eth_call simulations of the
  exact calldata — the documented Pons formula over-estimates by ~3.7 %. Paper =
  simulation with a pretend balance, nothing broadcast, no paper positions.
- **Fees:** inside the router call on pool trades; a follow-up transfer after a
  curve fill that never blocks it. Treasury `0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a`
  (`EVM_TREASURY_ADDRESS`, set 2026-09-08, a plain account; pinned exactly by
  `test/evmshared.test.mjs`). Not yet verified collecting on chain — the first
  live buy is the check. Referrer = `settings.evm.referrer` (an EVM address).
- **Anti-tamper, same layers as Solana (2026-09-08):** `shared/evmFeeIntegrity.ts`
  carries the treasury as an obfuscated blob + SHA-256 with its own keystream seed;
  `activeEvmTreasury()` always resolves the canonical address (editing the readable
  constant redirects nothing; a corrupt blob turns fees off). `shared/canary.ts`
  grew six EVM canaries (18 total) feeding the SAME `integrityGuard` level; `trade.ts`
  applies the corrosion (size, slippage, delay, seize) to EVM BUYS only. The
  buy-side interlock is `EvmPolicy.requireFeeLeg`: a router buy planned with a fee
  must carry a `TRANSFER(ETH, treasury, ≥ planned)` command or the signer refuses;
  set only for pool buys with a fee, never on sells, never on curve buys (no in-tx
  fee there — the corrosion covers them). `node scripts/gen-fee-integrity.mjs`
  regenerates BOTH blobs (in `npm run build`). Tests: `evmfeeintegrity`,
  `evmfeeleg`, `canary` (18 flags, plus a source-proof that the EVM seize gate sits
  inside the buy branch).
- **Krypt curve router (2026-09-08, built + verified, NOT DEPLOYED):**
  `contracts/KryptCurveRouter.sol` — 1,168 bytes of runtime, unowned, no storage
  of funds, treasury a compile-time constant, 2 % fee ceiling, reentrancy lock.
  `buy(curve, quoteIn, minOut, feeWei, referrer, referrerWei)` forwards the buy
  (tokens to the buyer, snipe tax computed on the buyer), pays treasury +
  referrer in the SAME transaction, and forwards a partial-fill refund to the
  buyer. Verified on the live chain WITHOUT deploying, by injecting the runtime
  bytecode with an eth_call state override and `eth_simulateV1` transfer traces
  (`npm run test:router`): fills, exact fee legs, 18.4 ETH refund on an
  over-sized buy, router ends at 0, custom-error reverts. Deploy with
  `KRYPT_DEPLOYER_KEY=0x… npm run deploy:router -- --write` (needs a funded
  account; cost is cents) — that fills `ADDR.kryptRouter` and the test pin, and
  the rail then routes curve buys with a fee through it with
  `requireFeeLeg.via = 'curve-router'` (the interlock now covers curve buys;
  a direct curve buy under the interlock is refused). Until deployed, curve
  buys go direct and bill with the follow-up transfer. Sells stay direct.
- Settings: `settings.evm` (enabled, Alchemy key, own RPC URL, slippage, referrer);
  the Alchemy key is the steady-feed upgrade over the rate-limited public endpoint.
- Tests: `npm test -- evm` (10 suites, 184 cases since the BNB rail on 2026-09-09; full suite 84); live: `npm run test:evm`.
- Not built: own tape from the sequencer feed (1 s candles), sell-quote position
  values, other v4 hook pools (Pools.trade/Bags/Clanker), USDG-quoted execution,
  1inch BYO route, 0x pins on the Solana watchlist. Gas subsidy ends 2026-09-29.

## Wallet Lab — fund groups of your own wallets (2026-09-03, trimmed 2026-09-14)

Two pages under **Automation** (after Copy Trading): **Group Wallets** (`creator` — make a
group, then create N wallets INTO it: `lab:generateMany(count, prefix, groupId)`) and
**Funder** (`funder` — fund/collect by group or individual wallets). Pages live in
`src/pages/lab/*.tsx` with a shared `useLabData()`. Contract in `shared/lab.ts`
(`planFund` and the funding constants, pinned by `test/lab.test.mjs`); IPC `lab:*` in
`electron/ipc.ts`.
- **Fund / collect** (`engine/fund.ts`): one tx from the ACTIVE wallet with ≤12 transfers per
  tx; collect = each wallet sends spare SOL (above rent + fee) back to the active one. Signer
  intent **`fund`** (`signPolicy.ts`): transfers only, 1–16 of them, destinations restricted
  to `policy.fundTargets` = this install's own public keys, resolved from the store — never
  from the caller. Needs live execution armed (real SOL).
- **Removed 2026-09-14 (legal exposure).** The **Warmer** (`engine/randomLab.ts`: random
  autotrading on a group under a realised-loss cap), the **Copier** page's follow-my-manual-
  trades mode (`engine.followManualTrade`), and the multi-wallet simultaneous buy
  (`live:fanoutBuy`'s panel + `live:fanoutSell`) are gone. Both manufactured trading activity
  across wallets one person controls, which reads as wash trading / market manipulation
  whatever the intent. What went with them: `shared/lab.ts`'s `FollowSettings`,
  `RandomSettings`, `LabGroupConfig`, `RandomOpen`, `RandomRunStatus`, `pickTradeSol`,
  `lossCapHit`; `WalletGroup.lab` and `wallet.setGroupLab`; the `lab` EngineEvent; IPC
  `lab:setFollow`, `lab:setRandom`, `lab:randomStart`, `lab:randomStop`, `lab:status`.
  `parseGroup` DROPS a `lab` block from an older file rather than carrying it forward
  (pinned in `test/labguards.test.mjs`). `shared/fanout.ts` and `engine.fanoutBuy` stay —
  the launcher calls them with exactly ONE wallet for the dev buy.
- Copy trading's per-wallet legs (`engine.labBuy` / `labSell`, `executeTrade({ walletId })`)
  stay: a copy config may name the wallet it trades from, and that is one wallet following
  one stranger, not a fleet trading itself.

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

## 1.1.0 — sells on every pump coin class, real copy sells, GPU safety (2026-09-08)

Three user reports in one day, all fixed on `release/beta.7` (see
`docs/pump-coin-classes-2026-09-07.md` for the first):
- **"Simulation reverted: Overflow (6024)" on a sell** — a pump **mayhem-mode** coin (curve
  byte 81; the coins that run to six-figure caps on the curve). Its trades need a RESERVED
  fee recipient (Global @483); the local builder used the normal one (`NotAuthorized`),
  Jupiter has no route, and PumpPortal's router build reverts with that Overflow. Now
  `parseCurve` reads `mayhem` / `cashback` / `quoteMint`, the builder picks the reserved
  recipient, inserts the user volume accumulator on **cashback** sells (byte 82; was
  `InvalidCashbackAccumulator`), refuses non-SOL-quoted curves up front, and sizes
  **partial sells** itself (`sellPct`, ATA closed only at 100 %) so ladders use it too.
  Verified by unsigned simulation on real holders for all three classes.
- **A "pump" token no route would sell** was a Token-2022 spam airdrop (PermanentDelegate,
  an advertisement for a name). `mintExtensions.ts` reads the extensions; holdings carry a
  `warning`, Positions labels them "airdrop?", sell-all sends them last, the failure
  message names the cause.
- **Copy trading "sold" in history while the coins stayed** — the copier had never placed
  a sell (`CopyHost` had only `buy`); the one 40 % that left was the default take-profit
  ladder. Now a leader's sell is mirrored as their fraction of OUR holding (from the
  transaction's pre-balances), through `manualSell`, recorded as an `exit` slice only on a
  confirmed fill; failed / blocked / unreadable-fraction sells are recorded as skipped with
  the reason and leave the copy open.
- **A user's BSOD**: the app cannot cause one, but its WebGL scenes can provoke a bad GPU
  driver. Settings → Display: **Reduce effects** (scenes replaced by a still, no WebGL
  context created) and **Hardware acceleration** (read before app-ready; turns itself off
  after the GPU process dies twice in a run).
- PumpPortal `trade-local` builds again since ~09-07; the "400 to everyone" hint is gone.
- **User scripting** (Automation → Scripts): no-code rules and sandboxed JavaScript, each
  under its own budget (max SOL per trade refused over cap, buys/day, open positions,
  actions/min, daily loss stop that disables), paper first, live disarmed on restart, a
  kill switch, and every buy/sell through the engine's own pipeline. Code runs in a
  hidden sandboxed renderer with no Node and no network; `npm run test:sandbox` proves it
  in a real Electron. Triggers: launch, launch update, runner, position, price tick,
  followed-wallet trade, order change, alert, daily time, timer. Actions: buy, sell, sell
  all, stop/take-profit/trailing/limit orders, cancel orders, apply template, alert,
  watch/unwatch, notify, log, disable. "Copy AI prompt" gives a generated, self-contained
  prompt for any assistant; the Variables panel is the field guide. See
  `docs/user-scripting.md`.

- **Copy trading: the leader's own record + Leaderboard** (2026-09-08). Every swap seen on a
  followed wallet is scored as THEIR trade — whether or not a copy happened (the filters skip
  most of what a leader does, so the copy scorecard could never say "are they any good").
  `copyTrade.trackLeader`: average cost per (wallet, mint), a position opens on the first buy
  seen and closes when a sell leaves nothing (their `soldFraction` ≥ 99.5 % or the tracked
  tokens are spent); `LeaderStats` per wallet in `CopySnapshot.leaders` (round trips, W/L,
  realised, return %, open + mark-to-market unrealised, avg hold, trades/day, best/worst,
  recent trips). A sell of tokens bought BEFORE we watched has no known cost: counted in
  `unscoredSells`, never scored. Persisted as `leaders` in copytrade.json; goes with the last
  config that followed the wallet; `copy:resetStats(wallet)` starts it over. Wallets page →
  "Leaderboard": rank by realised / return % / win rate / trades per day / unrealised, with
  fewer than `MIN_TRIPS_FOR_RANK` (5) closed trips ranking last, next to what copying them did
  for us. `test/copytrade.test.mjs` pins the accounting (partial sells, oversize sells, unscored
  sells, reload, reset, removal) and `rankLeaders`.
- **User-breaking audit (2026-09-08, three read-only sweeps after the breaker bug)** — all fixed,
  each pinned by a test where the code is pure:
  - *Paired bot blocked every bots save*: pairing writes `ownerId` as a string over a `null`
    default and the third-level type check refused the spread. A null default now means
    "text or null" (`checkLeaf`), and that nested loop runs the same leaf rules as the level
    above — the runner-alert and chat-trading bounds/enums had been dead rules (0 alerts an
    hour, a bogus bucket, a NaN chat buy cap all saved).
  - *Helius feed socket round-tripped into settings.json*: `engine:snapshot` handed the
    renderer the RESOLVED rpc block and every RPC save spread it back — one more copy of the
    key-bearing socket URL per save, the socket outliving its switch, and after 31 saves every
    RPC save refused by the 32-entry cap. The snapshot now carries the raw store; `mergeState`
    strips and dedupes any Helius/api-key entry on load.
  - *Keystroke saves*: Discover refresh / rows per column (typing "15" gave "105") and the
    hotkey amount (an armed key saved every intermediate digit) commit on blur/Enter, clamped.
  - *Defaults above the live cap*: the order panel defaults under `maxLiveSol` and shows the cap
    problem before the click; fan-out and group buys check the total against the cap before the
    REAL-SOL confirm; a rule buying above the cap is refused at save with the reason.
  - Low: cashout threshold 0 explained instead of refused, Balanced preset no longer resets
    runner alerts / paper entries, `planFund` mirrors the 50-per-wallet / 100-per-batch bounds,
    name inputs carry the store's `maxLength`, the holdings fast path answers only a FRESH copy
    so an RPC failure surfaces.
  - From the same review, three regressions in the day's speed work: a build/holdings read that
    straddled a wallet switch was kept as the new wallet's; the 3 s shared build swallowed the
    fill-driven rebuild; the Wallet page's holdings list kept the old wallet's tokens (with Sell
    buttons) after "Use". Trade replay now asks `market:candlesFull` (the fast path's 1.2 s
    placeholder read as "no candles").
- **Execution settings rejected on defaults (second cause)**: `maxLiveConsecutiveLosses`
  ships as 0 (= off, what the revision-3 migration writes) but the validator bound started
  at 1, so the spread every execution panel sends was refused with "must be between 1 and
  50" — auto cash-out, MEV mode, slippage, max live SOL all unsaveable, and no field to
  change it. Bound is now 0–50; the Wallet page has fields for both live breakers
  (0 = off); a test pins that every shipped default passes its own bound.
- **Navigation speed** (`docs/nav-speed-2026-09-08.md`, measured with `npm run test:nav:e2e`):
  Portfolio 6.9 s → ~50 ms, Trades 4.3 s → ~90 ms, Token page 1.0 s → 10 ms, Discover return
  150 → 10 ms. The engine keeps its last portfolio build and holdings and pushes rebuilds as
  `portfolio` / `holdings` events; `portfolio:summary { stale: true }` answers from the kept
  copy (marked stale past 3 s or after a fill); pages seed from `src/state/routeCache.ts`
  and show an age stamp; the build prices only open positions; "nothing" answers from
  GeckoTerminal are cached; navigation is a `useTransition` with hover/idle chunk prefetch
  (`src/routeLoaders.ts`); Discover stays mounted (`content-visibility: hidden`, polls off);
  three.js scenes are their own chunk and create their context two frames after mount. The
  chart fast path skips GeckoTerminal for pump curve tokens (its `poolAddress` is the curve —
  the old check never fired) and answers a pending placeholder after 1.2 s instead of
  blocking on the provider walk. **No trade path reads a kept copy** — sells, recovery,
  scripts and the build itself read the chain fresh; a wallet switch clears everything.

Not exercised in the live app: the Display switches, the Scripts page (type-checked, same `updateSettings`
path as the other switches) and a real end-to-end copy sell (unit-tested through the host
stub). Run one paper-mode copy session against an active wallet before relying on it live.

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
