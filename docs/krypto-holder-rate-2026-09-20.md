# The $KRYPTO holder rate: half the fee, not none (2026-09-20)

Krypt's call: "make it half fees so the referral system still works — half
ref fee and our fee if the user has 1 mil krypto."

Since 2026-09-16 a wallet set holding 1,000,000 $KRYPTO paid NO Krypt fee.
A waived trade paid the referrer 20 % of nothing, which broke the referral
programme for exactly the users most likely to have been referred. Now a
holder pays HALF: Krypt's 0.5 %/side becomes 0.25 %/side, and because the
referrer's cut is a share OF the fee (20 %), it halves with it — 0.1 % of
the trade becomes 0.05 % — instead of disappearing.

## Where the rule lives

- `shared/krypto.ts`: `KRYPTO_HOLDER_TOKENS = 1_000_000` (was
  KRYPTO_FEE_WAIVER_TOKENS), `KRYPTO_HOLDER_FEE_SHARE_BPS = 5000`,
  `holderRateApplies(tokens)` (was waivesFee — null still never qualifies)
  and `holderFeeBps(baseBps, qualifies)` → 25 for 50. Floored to whole
  basis points and never below 1 for a positive base.
- `shared/fees.ts`: `splitFee(basis, hasReferrer, bps)` already took a
  rate (the farming rate uses it); `holderFeePctLabel()` → "0.25%".
- `shared/evm.ts`: `splitEvmFee(basisWei, hasReferrer, bps)` now takes a
  rate too, clamped to the ordinary one — never a surcharge.

## Where it is charged

- Solana signer (`liveSigner.ts`): the fee block always runs;
  `splitFee(…, holderFeeBps(FEE_BPS, holder))`; the log note reads
  "fee halved ($KRYPTO holder)". The buy-side interlock is derived from what
  is actually sent, so the halved treasury transfer is what it requires.
- Swap engine (`swap.ts`): **had never asked about the holding at all** —
  the card said "waived" over a quote priced in full. Now the quote and the
  execution both use the holder rate.
- EVM buys (`evm/trade.ts` `feePlanFor`): `setHolderRate()` injected from
  ipc.ts (was setFeeWaiver), `splitEvmFee(…, holderFeeBps(EVM_FEE_BPS, …))`.
- EVM sells: **had never asked either** — `sellFeeBips(EVM_FEE_BPS, …)`
  charged holders in full on every sell. Now `sellFeeBips(holderFeeBps(…))`.

## Where it is shown

The renderer's shared state (`useKryptoWaiver.ts`, the IPC payload of
`krypto:holding`) carries `halved` instead of `waived`. Trade panel:
"Krypt fee halved to 0.25% ($KRYPTO holder)" and the estimate uses the
halved rate; EVM panel: the rate label follows the holding and the
main-priced amount says "halved"; swap card: "halved"; Settings: "Krypt
charges you half its fee right now — 0.25% instead of 0.5% … the referral
share halves with it"; Onboarding: "halved while you hold"; Hub card:
"Half fees on Krypto Bot — active" / "Use Krypto Bot at half the fee", and
the offer names the referral share. The `waiver.hold` line ("Hold N
$KRYPTO to halve this fee") is retranslated in all eight languages. The
issuer disclosure under the card says "halves".

The legal documents state no rate ("shown in the application before you
trade and in Settings"), so nothing there changed.

## Pins

Canary (`shared/canary.ts`) gained three flags — the share is 5000, 50 bps
halves to 25, and the halved fee still reaches the referral arithmetic
(500,000 lamports to the referrer on 1 SOL); the count in canary.test moved
25 → 28. krypto.test: the disclosure says halves and not waives and names
the referral share; holderFeeBps cases. fees.test and evmshared.test: the
25 bps split on both rails, and that a rate above the ordinary one falls
back rather than surcharging. kryptoholding.test renamed to
holderRateApplies. i18n.test pins the new English line.
