# Raydium rail (AMM v4 + CPMM) — 2026-09-19

The Discover "Raydium" chip used to say *post-migration AMM pools* and show
only what Jupiter happened to list. Now the engine hears every Raydium AMM v4
and CPMM pool creation off the chain the moment it lands, the Migrated column
takes those rows seconds ahead of any indexer, and opening a token whose pool
is on either program gives it a live tape decoded from logs — no transaction
fetch per trade. CLMM (concentrated liquidity, `CAMMCzo5…`) is deliberately
not covered: different program, different event, different economics.

Files: `electron/engine/raydiumDecoder.ts`, `electron/data/raydiumAccounts.ts`,
`electron/engine/raydiumWatcher.ts`, `shared/raydium.ts`; wired in
`engine.ts` (attach, start/stop/suspend/resume) and `market.ts` (token page
`watch()`, Migrated column). Tests: `test/raydium.test.mjs` (fixtures in
`test/fixtures/raydium.json`, all captured from mainnet) and
`npm run test:raydium` (live).

## What was measured before anything was written

| fact | how | result |
|---|---|---|
| CPMM emits swaps as `Program data:` LOG lines (`emit!`) | 2-minute `logsSubscribe` on the program | 1,598 notifications, 1,087 SwapEvents from logs, 0 emit_cpi-only |
| CPMM program-wide rate | same window | **13.3 notifications/s** — too much to run for the rare creation |
| AMM v4 creation rate | newest 25 tx on its fee account | span 19,002 min ≈ **2 creations/day** |
| Every v4 fee-account tx is a creation | those 25 | 25/25 carried an InitLog (`ray_log` type 0, 75 B) |
| CPMM creation fee account | a LaunchLab graduation (`MigrateToCpswap`) | 0.15 SOL paid into `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` (a WSOL token account) |
| CPMM emits nothing on creation | that transaction's logs | no `Program data:` under CPMM; instruction was `InitializeWithPermission`, not `Initialize` |
| AMM v4 pool = PDA(program, market, "amm_associated_seed") | two fresh pools | 2/2 |
| AMM v4 swap direction | 7 swaps, two pools (SOL as coin; SOL as pc) vs vault deltas | **2 = coin in / pc out, 1 = pc in / coin out**, 7/7 |
| CPMM SwapEvent amounts | 4 swaps vs vault deltas | input vault +`inputAmount`, output vault −`outputAmount`, 4/4 |

The v4 fee receiver is `7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5`. My
recollection of the CPMM one was wrong by its tail (`…vwRHWKKxdBW5…` does not
exist on chain); the real one came out of the graduation transaction. Both
are pinned by a test — a typo subscribes to nothing, silently.

## Layouts (verified by search, not copied)

**AMM v4 `ray_log`** (base64 after `Program log: ray_log: `):

```
InitLog (type 0, 75 B): 0 type u8 · 1 time u64 · 9 pcDecimals u8 · 10 coinDecimals u8
                        · 11 pcLotSize · 19 coinLotSize · 27 pcAmount · 35 coinAmount · 43 market pubkey
SwapBaseIn  (type 3, 57 B): 1 amountIn · 9 minimumOut · 17 direction · 25 userSource · 33 poolCoin · 41 poolPc · 49 outAmount
SwapBaseOut (type 4, 57 B): 1 maxIn · 9 amountOut · 17 direction · 25 userSource · 33 poolCoin · 41 poolPc · 49 deductIn
```
`poolCoin`/`poolPc` are the reserves BEFORE the swap: the next swap's logged
reserve equals this one's plus this one's input, exactly. The log names no
pool and no trader.

**AMM v4 `AmmInfo`** (752 B): status u64@0 · coinDecimals u64@32 ·
pcDecimals u64@40 · poolOpenTime u64@224 · coinVault@336 · pcVault@368 ·
coinMint@400 · pcMint@432 · lpMint@464 · market@528 · targetOrders@592.
Found by searching two new pools for the accounts their own `initialize2`
named (21 accounts: 4 amm · 7 lpMint · 8 coinMint · 9 pcMint · 10 coinVault ·
11 pcVault · 12 targetOrders · 13 ammConfig · 14 feeDestination · 16 market ·
17 creator). "coin" is base and "pc" is quote in Raydium's words, but SOL was
the **coin** on one sampled memecoin pool (Pepe/SOL) and the **pc** on
another — nothing may assume which side SOL is.

**CPMM `SwapEvent`** (disc `40c6cde8260871e2` = sha256("event:SwapEvent"),
body 162 B): poolId@0 · inputVaultBefore@32 · outputVaultBefore@40 ·
inputAmount@48 · outputAmount@56 · inputTransferFee@64 · outputTransferFee@72
· baseInput u8@80 · inputMint@81 · outputMint@113 · tradeFee@145 ·
creatorFee@153 · creatorFeeOnInput u8@161. An older 81-byte body exists in
the program's history and is refused as drift: without the mints a swap
cannot be sided.

**CPMM `PoolState`** (637 B): ammConfig@8 · token0Vault@72 · token1Vault@104
· lpMint@136 · token0Mint@168 · token1Mint@200 · authBump u8@328 · status
u8@329 · lpMintDecimals@330 · mint0Decimals@331 · mint1Decimals@332. The
mints were located from a swap's own event, the vaults from its balance
changes, and the decimals bytes matched the mints' (8 and 6).

## Design

**Attribution by the invoke stack.** Anchor discriminators hash the event
NAME, so every program that calls its event `SwapEvent` shares CPMM's
discriminator. A CPMM swap routed through Jupiter shares its transaction
with other programs' `Program data:` lines. So `attributeLogs()` tags each
line with the program executing it (`invoke` pushes, `success|failed` pops)
and the decoder reads only lines under a Raydium program, with exact length
checks on top. Pinned by a test that feeds a real SwapEvent line under a
foreign program and expects nothing — and not drift either.

**Creations: subscribe to the fee account.** Two `logsSubscribe`s that
mention the two fee accounts, on the primary socket only, deliver creations
and nothing else. A creation then costs `getTransaction` (accounts the
Raydium instruction touched — top-level or inner, since a LaunchLab
migration creates by CPI) plus one `getMultipleAccounts` over those accounts,
in which the pool is found **by owner** (never by position: the CPMM
variants order accounts differently) and its two vaults come along, so the
opening price is in the same reply. `getTransaction` reads at `confirmed`
while the notification is `processed`, so it retries three times 1.5 s
apart.

**Which side is the token.** Opposite SOL; else opposite USDC/USDT (a row
with the right mint and no SOL price); else the pool is not listed at all. A
LaunchLab curve can be quoted in an arbitrary token and graduates in it — the
captured graduation was — and a row under the wrong mint would advertise the
quote as a new coin.

**The tape.** Per open pool, the DBC watcher's shape: a `mentions` subscription
on the pool, ticks decoded from the logs. CPMM events name their pool, so
they are matched exactly. v4 logs do not, so the watcher reads the pool's
reserves once and accepts a swap only when its logged pre-swap reserves are
within 10 % of the expected ones, then rolls them forward — a transaction
that swaps through two v4 pools yields two logs, and the other pool's
reserves are off by orders of magnitude. Until the read lands, only a
notification with a single swap is trusted. Two pools at most (each is a
socket per endpoint against the ten-connection budget). A pool with no SOL
side gets no tape: every price on it would be in the wrong currency and it
would feed the chart and every trigger.

**Wallet.** Empty on every tick. Logs carry no account list and neither event
names the signer. The trades panel renders the em dash it already used for
LaunchLab; trader scan and copy trading cannot run on this rail.

**Engine.** Attached in the constructor; creations start with the scanner
(`start()`), stop in `stop()` and `suspendSockets()`, resume with the other
sockets. `alerts.onTick` gets `curvePct: null`, not 100: an AMM pool has no
curve, and an alert keyed on graduation must not fire because a pool exists.
The recorder gets a `raydium_pool` row per creation.

**Token page.** `market.watch()` tries the Raydium tape when a provider's
`dexId` says raydium (but not launchlab); the DBC path's owner read hands a
Raydium-owned pool to the same watcher when the label was something else.
The label picks what to try first, the owner decides.

## Live results (2026-09-19, `npm run test:raydium` + probes)

- CPMM swaps still decode from the log stream, 0 layout drift.
- The v4 fee account: 3/3 newest transactions were creations; 2 resolved to
  a priced pool by the two calls, the third was not SOL-quoted (correctly
  unpriced). The CPMM fee account: 3/3 newest were `Initialize*`
  instructions, the newest 3 minutes old.
- v4 tape: **190 ticks in 60 s** on the busiest v4 SOL pool (SOL/USDC, with
  SOL as the *coin* side — the sided price read 9.16e-3 SOL per USDC, i.e.
  the right way round).
- CPMM tape: SOL-quoted CPMM traffic is sparse — ~6 swaps per 25 s across
  the whole program, spread over several pools — so a single pool is often
  silent for a minute. Cross-checked instead: with 8 pools subscribed
  alongside the program stream for 120 s, **2 of 2** program-side swaps on
  those pools arrived on their own pool's subscription, same signature,
  1 ms apart; nothing arrived on one side only.

## Known limits

- The creation feed is only as good as the fee accounts: if Raydium moves a
  fee receiver, creations go quiet. `npm run test:raydium` checks both
  accounts still see creations.
- v4 SwapBaseOut logs (type 4) are decoded but were not observed in the
  sampled swaps; the amount fields are laid out per Raydium's log struct and
  sided the same way. Treat a type-4 tick with the same trust as any
  unverified branch until one is seen live.
- GeckoTerminal has no separate CPMM dex id: `raydium` covers both programs,
  and rows are tagged `dexId: 'raydium'` for that reason.
