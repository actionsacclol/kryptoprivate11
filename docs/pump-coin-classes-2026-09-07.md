# Pump coin classes: mayhem, cashback, and what a sell needs (2026-09-07)

A user reported two sells failing. One came back as

```
Simulation reverted: Overflow (6024): Overflow {"InstructionError":[3,{"Custom":6024}]}
```

and the other, for `GNhCph…pump`, as "not an open pump curve / not tradable /
relayer 400". Both were diagnosed by building real transactions for real
holders and simulating them unsigned (`sigVerify: false`). No key was needed
and nothing was broadcast.

## The three curve classes

The bonding-curve account (151 bytes after the first trade, 115 at creation)
carries two flags the builder never read:

| offset | field              | effect on a trade                                                        |
| ------ | ------------------ | ------------------------------------------------------------------------ |
| 48     | `complete`         | graduated — not a curve trade                                            |
| 81     | `is_mayhem_mode`   | `fee_recipient` must be a RESERVED recipient (Global @483 / @516×7)      |
| 82     | `is_cashback_coin` | the SELL must pass `user_volume_accumulator` right before `bonding_curve_v2` |
| 83     | `quote_mint`       | zero = SOL; anything else is a stable-quoted curve this layout cannot build |

The program validates all of it:

| trade                                         | result                              |
| --------------------------------------------- | ----------------------------------- |
| mayhem coin, normal fee recipient (buy or sell) | `NotAuthorized (6000)`              |
| mayhem coin, reserved fee recipient            | clean                               |
| cashback sell without the accumulator          | `InvalidCashbackAccumulator (6073)` |
| non-cashback sell WITH the accumulator         | `InvalidBondingCurveV2 (6074)`      |
| any sell without the trailing buyback slot     | `BuybackFeeRecipientMissing (6062)` |

## Why the user saw "Overflow (6024)"

Mayhem coins are the ones that run to a six-figure cap while still on the curve
(virtual SOL of 300–560 instead of 30) and then collapse — a "previous runner".
Selling one walked every route:

1. local builder → `NotAuthorized (6000)` (normal fee recipient);
2. Jupiter → "No routes found";
3. PumpPortal router → builds, but its inner pump sell reverts
   `Overflow (6024)` at pump's `lib.rs:801`, at instruction index 3. That is the
   message the user saw, verbatim.

Partial sells never reached the local builder at all, so a take-profit ladder
on such a coin had only routes 2 and 3.

## What changed

- `parseCurve` exposes `mayhem`, `cashback`, `quoteMint`; `parseGlobal` exposes
  `reservedFeeRecipient` (offset 483, fallback to pump's published #0).
- `derivedTemplate('sell', { cashback })` inserts the user volume accumulator
  before `bonding_curve_v2`; `buildLocalTrade` picks the reserved recipient on
  a mayhem coin and refuses non-SOL-quoted curves up front (they fall to
  Jupiter).
- The local builder sizes sells by `sellPct` and closes the ATA only at 100%,
  so partial sells use it too.
- `mintExtensions.ts` reads Token-2022 extensions. `GNhCph…pump` is a spam
  airdrop: PermanentDelegate, an advertisement for a name, no curve, no pool.
  Holdings now carry a `warning`, the Positions page labels them "airdrop?",
  sell-all puts them last, and the all-routes-failed message names the reason.
- The stale "relayer answers 400 to everyone" hint is gone — it builds again.

## Verified by simulation (real holders, 2026-09-07)

| coin class | sell | buy 0.002 SOL | partial 50% sell |
| ---------- | ---- | ------------- | ---------------- |
| normal     | ok   | ok            | —                |
| mayhem     | ok   | ok            | ok (no ATA close, exact half) |
| cashback   | ok   | ok            | —                |

Pinned offline by `test/txbuilder.test.mjs` (fixture
`test/fixtures/pump-curve-classes.json`) and `test/mintextensions.test.mjs`
(fixture `test/fixtures/mint-extensions.json`).

Sources: pump-public-docs `docs/FEE_RECIPIENTS.md`, `docs/instructions/SELL.md`,
`docs/PUMP_CASHBACK_README.md`; `@pump-fun/pump-sdk` 1.36.0 (`fees.ts`
`getFeeRecipient`, `state.ts` Global).
