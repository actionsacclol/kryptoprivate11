# Krypto Bot 2.0.0 — release notes (beta)

Windows installer, unsigned (SmartScreen will warn — publish the SHA-256 beside it).
Upgrading from 1.1.0 keeps your wallets, positions, ledger, orders and paper book;
the `appId` is unchanged. The terms gate prompts **once** after this update: the
privacy policy now names every host the app contacts and the terms cover bridging
and launching.

## Three chains

- **Robinhood Chain (4663)** and **BNB Smart Chain (56)** join Solana, each with its
  own wallet page, ledger, Paper/Live arm state, Observatory and Runners. The top-bar
  chain switch drives the whole app: Discover, Trades, Runners, Portfolio, Watchlist
  and the quick buy all follow it.
- One EVM key list, **a separate active signer per EVM chain**, so Robinhood and
  BNB can trade from different wallets.
- Trading venues: pump.fun / Jupiter / PumpPortal on Solana (local builder by
  default), the Pons curve and Uniswap v4/v3 on Robinhood, the four.meme curve and
  PancakeSwap v2/v3 on BNB. **Sell-all** (the panic exit) now exists on every chain.

## New pages

- **Swap** (Wallet Utilities) — any token for any other within a chain: Jupiter on
  Solana with cheap / normal / fast presets priced off what the network is paying;
  the chain's own venues on Robinhood and BNB. "Check it first" simulates the signed
  transaction; the platform fee and where it is taken are printed on the card.
- **Bridge** (Wallet Utilities, **off by default**) — move a chain's own coin to
  another chain through LI.FI. Five directions are live: Solana → Robinhood (Relay),
  Robinhood → Solana, Robinhood → BNB, BNB → Solana, BNB → Robinhood. Solana → BNB
  is refused on purpose: the only route hides its destination in lookup tables the
  signer cannot vouch for. The page says which leg it can verify and which it can
  only trust, keeps a record of every transfer in flight (written before the money
  moves), shows how each one ended, and raises a desktop notification when it lands,
  refunds or fails. Minimum $5 per transfer — under that a failed one is not refunded.
- **Launch a token** (**off by default**, separate launch wallet) — pump.fun
  `create_v2` on Solana (a first buy of your own is required; cashback and mayhem
  options) and Pons on Robinhood. Creator fees can be **claimed** from the page.
  Every launch this page has sent is kept on it, with mint and transaction.
- **Copy Trading on every chain.** A config has a chain and its own wallet: follow a
  Solana leader on Wallet 2 and a Robinhood leader on Wallet 3 while trading by hand
  on Wallet 1 — every config is its own runner. On Robinhood and BNB a leader is
  followed through the Observatory's trade feed while a token is on its launchpad
  curve; sells mirror the share they sold. Paper first, live and paper scored apart,
  totals per chain.
- **Trades / Runners / Portfolio on Robinhood and BNB** — the same pages as
  Solana's: closed round trips with a share card and a candle replay each, the
  chain's flagged launches with Open / Buy / Sell, positions and every fill.
- **Funder** picks the wallet the SOL leaves and the wallet a collect lands in.
- **Grimoire** is a live feed now: everything the app logs reaches it as it happens.
- **Update notice** — the app checks `krypt.cc/version.json` 30 s after start and
  every six hours, and only ever shows a notice with a link. Nothing is downloaded or
  run for you.
- The block feed (the largest thing the app downloads) has a switch.

## What the audits changed (three swarms, one per chain)

Eighteen auditors read the new features against real chains, with real quotes and
one real round trip per chain. The fixes that matter to a user:

- **Bridge:** the Solana → Robinhood route could not be signed at all (lookup table +
  fee refused) — it now resolves the table at signing and checks every account
  against the measured ones; the EVM leg decodes the recipient from the calldata
  instead of searching for it (a search was satisfied by the *sender's* address);
  the fee ceiling scales with the amount; a check that is refused keeps its quote; an
  amount above your balance is refused before a quote token is spent.
- **Swap:** the loss guard refused to run when it could not read a balance (it used
  to skip); a receipt check now requires the quote's minimum to actually arrive in
  your account; the slippage you type is the slippage that goes out on EVM; sells are
  sized in exact base units (a typed 150 used to sell 200); a swap in Paper is refused
  rather than pretended.
- **Runner model:** graduations after the 130-second tracking window were being
  recorded as failures, and restored launches past the ask cap were failed unasked.
  Both fixed; the flag now requires a bucket's lower bound to clear every other
  launch's upper bound, so a single graduation against a 0 % base is not a
  "runner". **Robinhood and BNB tallies rebuild from scratch after this update**
  (`n / 100` per bucket for about a day).
- **Runner flags (Solana), after a six-agent outcome study on 73,890 launches
  plus two live days:** the "creator sold never flags" gate was blind after the
  first 15 s (a fifth of live flags had a creator sell inside their own scoring
  window); the odds tape stopped at 600 trades so the hottest launches scored a
  zero trade rate; the Twitter feature was always null; a sold-out curve was only
  known from an event the feed drops; curves not quoted in SOL (9 % of flags, a
  launch farm the builder cannot buy) were scored. All fixed. A flag now says its
  curve regime — three in four flags are "mixed" curves whose graduation seeds
  about 0.16 SOL into the pool instead of 85 — shows when the creator sold after
  it, prints the share of supply sold instead of a SOL-side curve %, and carries
  the measured line for the day it was calibrated on: of 873 flagged like this,
  18 in 100 graduated (11 in 100 live), 33 in 100 reached +50 % before −25 %,
  25 in 100 beat break-even on a 25 % trailing stop, 39 in 100 had no trade at
  10 min. Buying every flag loses money under every exit rule tested; the flag
  is a place to look, not a signal to buy. `docs/runner-outcome-2026-09-11.md`.
- **Observatory on BNB:** 78 % of four.meme curves are quoted in something other
  than BNB; their money columns showed the wrong unit and now show a dash.
- **Launcher:** a create that timed out waiting for its receipt lost its signature
  and mint — both are kept now, and the buy's gates run before the token exists.
- **Wallet IPC:** import, rename and remove for EVM wallets were reading their
  arguments one slot short and did nothing; fixed and pinned by a contract test.
- **Privacy:** the policy now names li.quest (sent both your addresses when you
  bridge), pump.fun (sent your image and metadata when you launch), krypt.cc (the
  update check), the publicnode endpoints, and the opt-in Discord presence.

## Known limits

- Solana → BNB bridging is refused by design; BNB needs an exchange or the
  two-hop path through Robinhood.
- Copy trading on Robinhood and BNB covers launchpad-curve activity (Pons,
  four.meme) while the chain's scanner is running; pool trades after graduation are
  not followed.
- Public RPC endpoints are rate-gated (Robinhood: 5 requests/s); a Helius key for
  Solana and an Alchemy key for Robinhood make trades markedly faster.
- The Solana swap's speed presets are scoped to the pair, not the exact pools a
  route uses; "fast" can over-pay on a quiet pool.
- Windows only for now; unsigned.

## Verified on real chains, 2026-09-11

- 0.05 SOL Solana → Robinhood through Relay: 0.002003 ETH delivered, above the
  quoted minimum; recorded, polled and closed by the app.
- A Pons buy and sell on Robinhood, fee rebased on the actual fill; the first fee
  ever to land in the Robinhood treasury.
- A pump.fun `create_v2` simulated clean against the on-chain IDL (0.0067 SOL).
- Two LI.FI quotes from BNB (Mayan → Solana, Relay → Robinhood) decoded and pinned
  as fixtures for the recipient check.

114 test suites pass; typecheck and build clean on the released commit. The packaged
build (commit b76940b) smoke-booted on an existing profile: legacy profile picked up
with its wallet, both EVM rails ready, window up in 0.2 s, still running at 25 s, and
the DevTools port stays closed even with the debug variable set. Fuses and asar
contents verified (bytecode present, no sources, no source maps).
