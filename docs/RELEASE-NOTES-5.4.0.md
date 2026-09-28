# Krypto Bot 5.4.0

Scripts can now read everything the app knows and press every button its
pages have. The Launch tab's dev / bundle / sniper cohorts reach scripts as
facts and as a call, the security report crosses whole, and fourteen reads,
nine housekeeping calls, per-trade options, a settings read and five events
were added. Two `bot.order` bugs are fixed. The shipped Callout Farm script
and its private twin stop throwing away coins whose creator record pump.fun
could not serve.

No terms change. No settings migration.

---

## The Launch tab, for scripts

The Launch tab measures who bought a coin's first blocks and what they still
hold, from pump's own trade history and one balance read. Scripts only ever
had the providers' `bundledPct` / `sniperPct`, which are null on nearly every
new pump coin.

- `bot.launchIntel(mint)` returns the whole report: `dev`, `bundle`,
  `snipers` (bought %, held-now %, retained %, wallet counts), the early
  wallets, `top3BuyersPct`, and `complete` — false means the launch block
  could not be isolated and nothing is guessed.
- Thirteen facts ride into the token object for 45 seconds after the call
  (or after `bot.security`, or after someone opens the coin's page):
  `launchDevPct`, `launchBundlePct`, `launchSniperPct`, their `HeldPct`,
  `RetainedPct`, wallet and still-holding counts, `launchTop3BuyersPct`.
  `bundledPct` / `sniperPct` fall back to the scan when no provider had them.
- `bot.security()` now carries the concentration block (including what the
  bundle and snipers hold NOW), the rug rules, the odds, the volatility notes
  and the creator record with the Launch tab's verdict.

## Every other read

`holders`, `trades`, `candles`, `search`, `discover`, `callouts`, `history`,
`holdings`, `solUsd`, `walletScores`, `walletRecord`, `copyConfigs`,
`alerts`. Each is the matching panel's answer. Reads that leave the machine
count against the script's actions-per-minute like `market` does; the
reference lists them in their own group. Solana-only reads answer null (or
an empty list) on BNB and Robinhood rather than rejecting.

## Trade options, housekeeping, settings, events

- `bot.buy(mint, sol, {wallet, slippagePct})` and `bot.sell(mint, {pct |
  tokens, slippagePct, wallet})`: a per-trade slippage (0.1–50 %), and a
  sell sized in tokens — converted against the position the app can see,
  refused while a fresh buy has no holdings row, still capped at what the
  script itself bought.
- `cancelOrder(id)`, `resumeOrders()`, `removeAlert(id)`, `muteAlert(id)`,
  `clearFiredAlerts()`, `saveTemplate({…})`, `deleteTemplate(id)`,
  `setActiveTemplate(id)` — the page buttons.
- `bot.settings()`: execution, strategy, data, alerts and EVM settings,
  read-only, with every key, token and URL removed. A script learns THAT a
  key is set, never the key.
- Events `migration`, `devSell`, `holdings`, `copyFill`, `runnerExpired`.

## USDC is swapped to SOL for you

pump.fun pays callout rewards in USDC, into whichever of your wallets made
the call. This is a SOL terminal: while live is armed, any USDC of 0.25 or
more that lands in one of your Solana wallets is now swapped to SOL within
minutes, through the same path as the Swap page — Krypt's fee applies to it
like to every swap, halved for a $KRYPTO holder. One attempt per wallet
every ten minutes; a refused swap is logged and tried again later; nothing
is read or sent while live is off.

**If you hold USDC on purpose, turn this off**: Sol Wallet page →
"Auto-swap USDC to SOL". The rewards panel's own Swap and Send buttons
still work either way.

## bot.order

- A `stop_loss`, `take_profit` or `trailing_stop` sent with a market-cap or
  price basis used to be armed as a PERCENT order at that number and
  reported success. It is refused with the reason.
- `expiresAt` was dropped from a script's order. It now applies.

## Callout Farm (shipped script) v2.5

- pump.fun's creator list is rate-limited for minutes at a time; the script
  skipped every coin whose record it could not read (234 of them in six
  hours on 2026-09-27, twelve of the twenty-two that later doubled). New
  setting "When pump.fun's creator record cannot be read": the default falls
  back to the app's own record of the creator; "skip" keeps the old rule.
- An unknown market cap at the flag no longer skips a coin when the cap
  floor is 0. The watch prices the cap itself from SOL/USD and pump's fixed
  supply, and the ceiling applies at confirm.

## Onboarding runs once more

On first start of 5.4.0 the setup screens appear again, for everyone. The
keys step now asks for a Jupiter API key alongside Helius and Birdeye — it
unlocks no extra data; it moves every Jupiter call off the endpoint Jupiter
is retiring. Everything you already answered is kept: the terms are not
asked again if you accepted the current version, your referrer is shown
prefilled and only changes if you edit it, your wallet and keys stay. Every
step can be skipped. The theme picker is no longer on the first screen; it
is on the Settings page.

## Under the hood

- The provider park log names the route that tripped the rate limit.
- The AI prompt pack, the variable guide and the API reference are generated
  from the same tables as the code and include all of the above.
