# Referral programme audit — 2026-09-21

Asked: is the referral programme working as intended.

The arithmetic is correct and always was. What was not working was everything
around it: four ways a referrer could earn nothing with nobody told, one way
the referral cut could revert a user's trade, and no way at all to *be* a
referrer.

## What the programme is

One constant chain: `FEE_BPS = 50` (0.5 % per side), `REFERRAL_SHARE_BPS =
2000` (20 % of that fee), so a referrer earns **0.1 % of trade value** per
side, paid out of Krypt's share in the same transaction as the trade. A
$KRYPTO holder pays 0.25 % and their referrer's cut halves with it, to 0.05 %.
The EVM rails mirror this exactly with their own constants
(`EVM_FEE_BPS`, `EVM_REFERRAL_SHARE_BPS`).

There is no server and no account. A referral *is* an address. Whoever you
name in Settings receives lamports; nothing is tracked, claimed or paid later.

## Verified correct (no change needed)

- **The split.** 60,000 odd basis values through `splitFee`: not one lamport
  invented or lost, and the treasury always receives `total − referrer`.
- **The rate cannot be raised.** `splitFee` derives from `FEE_BPS`; a caller
  cannot pass a higher one.
- **Four refusals work**: a fee larger than the allowance, a fee redirected to
  a stranger, a tampered treasury constant (the integrity layer routes to the
  canonical address anyway), and a dust trade (injects nothing, still signs).
- **Both treasury constants** match the pinned values on Solana and EVM.
- **The drop order is deliberate**: `treasury: 0, jito: 1, referrer: 2,
  helius: 3`. The referrer goes after the tip that makes the trade land,
  because a fee must never cost a fill.

## Defects found and fixed

### 1. A referral cut could revert a swap  (the serious one)

`liveSigner` runs every fee transfer through `rentSafeTransfers`, which drops
any payment that would leave its recipient above zero but below the network's
rent-exempt minimum — such a transfer fails the *whole transaction*
(`InsufficientFundsForRent`). `swap.ts` builds its own fee transfers and never
called it. A referral cut to a brand-new referrer wallet could therefore
revert a user's swap, which is the one outcome this entire layer exists to
prevent.

`rentSafeTransfers` is now exported and the swap path runs rent **before** the
size fit, so a reverting transfer never reaches it. Pinned by order, not just
by presence.

### 2. Four silent non-payments

Each of these ended with the trade landing, the referrer earning nothing, and
no log line, no note on the result and no hint in the UI. All four now say so.

| Where | Case |
|---|---|
| Solana signer | recipient below rent-exemption (partial drop) |
| Solana signer | referrer refused outright: not an address, the treasury, or the trading wallet |
| Swap path | both of the above, plus a size-limit drop, none reported |
| EVM | referrer cannot receive native currency, so the leg is stripped |

A drop to fit the 1232-byte limit was **already** reported on the Solana
signer (`dropped referrer (transaction at the … size cap)`) and needed no
change — an early version of this fix added a second, duplicate message and it
was removed.

The notes also had to be made to **survive**. The success summary reassigns
`feeNote` from scratch after the transfers are counted, so a note written into
it earlier was thrown away — the first version of this fix did exactly that
and reported nothing. Unpaid-referral text now accumulates in its own
`referralNote` and is appended after the summary, pinned by index order.

### 3. Self-referral was accepted by the UI and refused by the signer

`referralProblem` has had a sentence for "that is your own wallet" all along,
and the Settings page called it with an **empty** list of your own addresses,
so it could never fire. The signer refuses a self-referral (`referrer !==
owner`) without comment. Net effect: you paste your own address, the box looks
happy, and every trade forever credits nobody.

Settings now passes the real wallet list. The EVM card had the same gap in a
subtler form — it checked only the Robinhood address although the referrer
setting is shared by both EVM chains and the chains can hold different
wallets, so a BNB self-referral passed. `evmReferralProblem` now takes every
address you sign with.

The onboarding screen still passes an empty list, and that is correct: no
wallet exists yet at that step.

### 4. There was no way to refer anyone

The programme ran one direction only. You could say who referred you. Nothing
anywhere told you that you could be a referrer, what you would earn, or what
address to hand out. Settings now carries a card with your active address,
one click to copy, and the rate in plain words.

### 5. The terms promised something the code does not always do

Section 8 said a referral share "is sent to that address in the same
transaction", unqualified. Three real exceptions exist. The terms now name
them, and say the software tells you when one happens. `TERMS_VERSION` →
`2026-09-21.1`, which re-prompts for acceptance.

## What is still true and unfixable here

A user with two wallets can name wallet B while trading from wallet A and
collect 20 % of their own fee. `referrer !== owner` catches only the active
signer. This is not fixable on-chain — anyone can make a second wallet — and
every referral programme in this market has it. Noted, not defended against.

## Pinned by

`test/feeflow.test.mjs` (the reports, the drop order, the swap rent guard and
its ordering), `test/evmshared.test.mjs` (multi-wallet self-referral),
`test/fees.test.mjs`, `test/feebasis.test.mjs`, `test/canary.test.mjs`,
`test/feeintegrity.test.mjs`, `test/legal.test.mjs`.
