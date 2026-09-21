# PumpSwap local builder — 2026-09-19

A graduated pump coin trades on pump's own AMM (pump-amm, "PumpSwap"). Until
today the terminal reached it only through two HTTP services: Jupiter
(keyless, one host, a 120 ms gap between calls, parked on 429s) and
PumpPortal (rate-limited, 400s for days at a time, wrong on mayhem and
cashback coins). A user asked for "a proper integration with pump swap … to
avoid rate limits". This is that: the buy and the sell are built locally
from chain state, like the bonding-curve trade already is, and go through
the same validate → simulate → loss-guard → sign pipeline. No key is
involved anywhere; a wrong layout shows up as a simulation error, never as
a sent transaction.

## Where it sits

`electron/engine/pumpSwapBuilder.ts`, with the PDAs in
`electron/chain/addresses.ts`. The live signer tries sources in this order
once the curve builder has spoken:

    local (bonding curve) → pumpswap → jupiter → relayer (PumpPortal)

PumpSwap is only tried when the curve builder said the coin is
**graduated** — that verdict is the one fact that says a canonical pool
exists. A PumpSwap build that fails validation, simulation or the loss
guard falls through to Jupiter; it never aborts the order and never
invalidates the curve template.

## The layout, and how each fact was found

Everything below was read from mainnet on 2026-09-19/20. The capture is
`test/capture-pumpswap-layout.mjs` → `test/fixtures/pumpswap-layout.json`
(a real buy and a real sell on one pool, with the pool and GlobalConfig
bytes and the program's own events); the pins are `test/pumpswap.test.mjs`
(25 checks); the live proof is `test/pumpswap.live.mjs`.

**Programs.** pump-amm `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`,
pump-fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`, migration
authority `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg` (its signatures
are how the tests find fresh graduates).

**Discriminators.** Anchor `global:buy` / `global:sell` — the same eight
bytes the curve uses. Buy data is 24 bytes (disc · base_amount_out u64 ·
max_quote_amount_in u64); real clients append a 25th `track_volume` byte,
which the program accepts either way (simulated both). Sell data is 24
bytes (base_amount_in · min_quote_amount_out).

**Accounts, buy 26 / sell 24, in order:** pool (w) · user (signer, w) ·
global_config · base_mint · quote_mint · user base ATA (w) · user WSOL ATA
(w) · pool base vault (w) · pool quote vault (w) · protocol_fee_recipient ·
its WSOL ATA (w) · base token program · quote token program (classic
Token) · system · ATA program · event_authority · pump-amm program ·
coin_creator vault ATA (w) · coin_creator vault authority · [buy only:
global_volume_accumulator · user_volume_accumulator (w)] · fee_config ·
pump-fees program · **pool_v2** · buyback_vault · buyback vault WSOL ATA (w).

**PDAs.** global_config `["global_config"]` → `ADyA8hde…`; event_authority
`["__event_authority"]` → `GS4CU59F…`; global_volume_accumulator →
`C2aFPdEN…`; user_volume_accumulator `["user_volume_accumulator", user]`;
creator vault authority `["creator_vault", coin_creator]`; fee_config
`["fee_config", pump-amm]` under pump-fees → `5PHirr8j…`. The canonical
pool is `PDA(["pool", u16 0, PDA(["pool-authority", mint], pump), mint,
WSOL], pump-amm)` — reproduced on every migration sampled.

**pool_v2** is `PDA(["pool-v2", base_mint], pump-amm)`. It exists on no coin
sampled, and the program still validates the address: a build without it
reverted `InvalidPoolV2 (6062)` in simulation. Found by searching seed
words against the account every real trade passed in that slot.

**Pool account (301 bytes).** bump @8 · index u16 @9 · creator @11 ·
base_mint @43 · quote_mint @75 · lp_mint @107 · pool_base_token_account
@139 · pool_quote_token_account @171 · lp_supply u64 @203 · coin_creator
@211 · **virtual quote reserve u64 @245**.

**The virtual quote reserve is the fact that makes pricing work.** A
pump-migrated pool does not price on its vaults. Fitting twelve consecutive
real swaps on one pool, every one was constant product on the quote vault
PLUS a fixed 17.5845 SOL, to the lamport — and that number is the u64 at
byte 245 (0 on a third-party pool, whose swaps priced on the bare vaults).
Sizing on the vault alone asked for 1.4–1.8× the tokens the pool would give
and reverted `ExceededSlippage (6004)`. Both fixture events reproduce
exactly with it and are off by 43 % and 76 % without it. The program's
events report the vault as "pool_quote_reserves", which is why this is easy
to get wrong.

**GlobalConfig (949 bytes).** lp_fee_bps u64 @40 · protocol_fee_bps u64
@48 · disable_flags u8 @56 · protocol_fee_recipients[8] @57 ·
coin_creator_fee_bps u64 @313 · **reserved recipient @385 and seven more
from @418** (32-byte step, the same one-byte gap as the curve's Global) ·
**buyback vaults [8] @643..875** (pfee-owned `BuybackVault` accounts, 208
bytes each). A normal coin's trade may name any of the eight recipients
(five different ones seen on one pool) and any of the vaults; the builder
spreads both by pool address so retries repeat the same choice.

**Mayhem coins** (bonding-curve byte 81) must name a RESERVED recipient:
naming a normal one reverts `InvalidProtocolFeeRecipient (6013)`. The
builder reads the curve's flag in the same batch as the pool and picks from
the reserved list. A mayhem coin's buy simulated clean on 2026-09-19.

**fee_config (4097 bytes).** Flat lp 25 / protocol 5 / creator 0 at @41,
then 25 market-cap tiers from @69 (40 bytes: u128 threshold, lp, protocol,
creator): 2 + 93 + 30 = 125 bps under ~420 SOL of market cap, falling to
30 bps past ~98k SOL. The builder sizes with the 125 bps ceiling and keeps
3 lamports back — each component is rounded up on its own, and the fixture
buy paid exactly 125 bps and 3 lamports. Sizing with the ceiling can only
leave budget unspent; the program charges its tier at execution.

## What the builder does

- One batch read at `processed`: pool, quote vault, bonding curve (mayhem
  flag), mint (token program), GlobalConfig, base vault, user base ATA.
- Verifies the pool is the canonical one for the mint, quoted in WSOL, and
  that the vaults it names are the pool's ATAs.
- Buy: tokens = pool's answer for budget ÷ (1 + ceiling) − 3 lamports,
  then × (1 − slippage); the whole budget is `max_quote_amount_in`. The
  same convention as the curve builder: the amount is what you meant to
  spend, slippage is the margin on the tokens.
- Sell: `min_quote_amount_out` = gross × (1 − ceiling) − 3, × (1 − slippage).
  Sizes from the balance the batch read returned, all of it at 100 %.
- Instructions: compute limit max(setting, 250 000) + price (the priority
  fee the user chose stays fixed in SOL); createIdempotent ATAs; buy wraps
  through the wallet's OWN WSOL ATA (transfer + SyncNative, allowed by the
  sign policy under a trade) and closes it after the swap so the change
  comes back as SOL; a 100 % sell closes the emptied token account too.
- Closing the WSOL ATA unwraps whatever it held, so a wallet that kept WSOL
  gets it back as SOL. Jupiter's wrap-and-unwrap does the same.

## Live results

`npm run test:pumpswap` finds the four newest migrations, borrows a funded
recent holder's public key per coin, builds a 0.01 SOL buy and a 50 % and
100 % sell, and simulates each with `sigVerify` off. Five runs on
2026-09-19/20, after the three fixes above landed:

| what | result |
|---|---|
| buys | tokens received, spend within budget + rent, 99–123k CU |
| sells 50 % | SOL received, about half left, 82–99k CU |
| sells 100 % | SOL received, token account closed (rent back), 84–99k CU |
| mayhem coin | buy simulated clean with a reserved recipient |

The holders it borrows are live traders; the test snapshots their balances
at `processed` right before each simulation, prefers the oldest funded
holder among the last 30 trades, and rebuilds once when a pool moved
underneath it. Dead pools (no funded holder) are noted, not failed; the run
insists on at least one coin fully exercised.

## Open

- Only the canonical pool is used. A pump coin can also have third-party
  pools on pump-amm (index ≠ 0, virtual reserve 0); Jupiter still covers
  those and Raydium.
- A mayhem coin's SELL has not been simulated (none had a funded holder
  during the runs). The recipient rule is the same account list on both
  instructions, and the buy proved it.
- If pump ever creates `pool_v2` accounts the builder already passes the
  right address; what the program then does with them is unknown.
- The fee tiers are read from the chain but the ceiling is a constant. A
  tier above 125 bps would surface as `ExceededSlippage` in simulation and
  the order would fall through to Jupiter; `PUMP_SWAP_FEE_CEILING_BPS` is
  the one number to raise.
