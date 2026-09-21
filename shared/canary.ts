// Runtime self-checks ("canaries").
//
// ─── What this is ─────────────────────────────────────────────────────
//
// A set of independent, pure checks that all pass on a genuine build and trip
// only when the fee/treasury logic has been modified. They exist so that a
// cracked build — one where someone removed or neutered the platform fee — can
// be DETECTED from many unrelated places in the code, not one. Removing a
// single check does nothing, because the others still fire and the thing that
// consumes them (integrityGuard.ts) sums all of them.
//
// ─── Why it is safe for real users ────────────────────────────────────
//
// Every check is a pure function of the app's OWN embedded constants — the
// treasury blob, the fee basis points, the fee arithmetic. No network, no
// timing, no environment, no user input. A genuine build therefore passes all
// of them deterministically, on every machine, forever. A false positive is
// only possible if the shipped binary itself was altered, which is exactly the
// case we WANT to catch. That is the whole safety argument, and it is why the
// degradation these feed is allowed to exist at all.
//
// Nothing here throws, blocks, or touches the sell/exit path. It only reports.

import { FARM_FEE_BPS, FEE_BPS, REFERRAL_SHARE_BPS, TREASURY_ADDRESS, feesEnabled, splitFee } from './fees';
import { KRYPTO_HOLDER_FEE_SHARE_BPS, KRYPTO_HOLDER_TOKENS, holderFeeBps, holderRateApplies } from './krypto';
import { resolveTreasury, canonicalTreasury } from './feeIntegrity';
import { PRESENCE, packIdentity } from './presence';
import { resolvePresence, canonicalPresence } from './presenceIntegrity';
import { EVM_FEE_BPS, EVM_REFERRAL_SHARE_BPS, EVM_TREASURY_ADDRESS, evmFeesEnabled, isEvmAddress, splitEvmFee, WEI } from './evm';
import { canonicalEvmTreasury, resolveEvmTreasury } from './evmFeeIntegrity';

const SOL = 1_000_000_000;

/**
 * One boolean per canary. `true` means that canary TRIPPED — i.e. it detected
 * tampering. On a genuine build every entry is `false`.
 *
 * Deliberately many independent routes to the same two facts — the fee is
 * intact, and the app still advertises itself — each touching a different
 * constant or code path, so no single edit clears the signal.
 *
 * Note what is NOT checked: whether presence is switched ON. That toggle
 * belongs to the user, it is off by default, and treating it as tampering
 * would punish almost everyone. Only the embedded identity is checked.
 */
export function tamperFlags(): boolean[] {
  const canon = canonicalTreasury();
  const ident = canonicalPresence();
  const one = splitFee(SOL, false);
  const withRef = splitFee(SOL, true);
  const evmCanon = canonicalEvmTreasury();
  const evmSplit = splitEvmFee(WEI, true);
  return [
    // 1. The canonical treasury blob decodes to a valid address.
    canon.length !== 44,
    // 2. The readable constant still matches the canonical (not redirected).
    resolveTreasury(TREASURY_ADDRESS).state !== 'ok',
    // 3. The fee rate is untouched.
    FEE_BPS !== 50,
    // 4. The referral share is untouched.
    REFERRAL_SHARE_BPS !== 2000,
    // 4b. The farming rate is untouched, and is still a REDUCTION of the main
    //     rate rather than a way around it. A build where the farm rate has
    //     been widened to cover ordinary trades is a cracked build.
    FARM_FEE_BPS !== 5,
    FARM_FEE_BPS >= FEE_BPS,
    // 4c. The farm rate reaches the arithmetic: 5 bps of 1 SOL = 500,000.
    splitFee(SOL, false, FARM_FEE_BPS).treasuryLamports !== 500_000,
    // 4d. The $KRYPTO holder rate is still a threshold and not a hole. A
    //     build where it has been lowered discounts everyone, and one where
    //     an unknown holding qualifies discounts anyone willing to break a
    //     single balance read.
    KRYPTO_HOLDER_TOKENS !== 1_000_000,
    holderRateApplies(null),
    holderRateApplies(KRYPTO_HOLDER_TOKENS - 1),
    !holderRateApplies(KRYPTO_HOLDER_TOKENS),
    // 4e. The holder rate is HALF, not nothing: a build that set the share to
    //     0 has restored the full waiver and cut every referrer out; one that
    //     raised it past the full rate charges holders more. And the halved
    //     fee still reaches the referral arithmetic: 20 % of 25 bps on 1 SOL
    //     is 500,000 lamports to the referrer.
    KRYPTO_HOLDER_FEE_SHARE_BPS !== 5000,
    holderFeeBps(FEE_BPS, true) !== 25,
    splitFee(SOL, true, holderFeeBps(FEE_BPS, true)).referrerLamports !== 500_000,
    // 5. Fees are still enabled (treasury present and verified).
    !feesEnabled(),
    // 6. The fee arithmetic still produces the right treasury cut.
    one.treasuryLamports !== 5_000_000,
    // 7. The referral arithmetic still produces the right referrer cut.
    withRef.referrerLamports !== 1_000_000,

    // ── Attribution. The presence identity is the app's only advertising,
    //    which makes it the second thing a cracker strips. Same rules: pure
    //    functions of embedded constants, no network, no user state.
    // 8. The identity blob decodes and matches its own checksum.
    ident === null,
    // 9. The readable constants still match the canonical identity.
    resolvePresence(PRESENCE).state !== 'ok',
    // 10. The Discord application is still ours.
    ident?.clientId !== '1495323918234423406',
    // 11. Both buttons still point where they should, in order.
    packIdentity(PRESENCE).split('|').slice(1, 5).join('|') !==
      'Free Tools|https://krypt.cc/tools|$KRYPTO|https://pump.fun/coin/2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump',
    // 12. The art and the product name are unchanged.
    ident?.largeImageKey !== 'krypt' || ident?.largeImageText !== 'Krypto Bot',

    // ── Robinhood Chain fee (shared/evm.ts + evmFeeIntegrity.ts). The same
    //    facts as 1–7, for the second chain: pure functions of embedded
    //    constants, no network, no user state.
    // 13. The canonical EVM treasury blob decodes to a valid 0x address.
    !isEvmAddress(evmCanon),
    // 14. The readable constant still matches the canonical (not redirected).
    resolveEvmTreasury(EVM_TREASURY_ADDRESS).state !== 'ok',
    // 15. The EVM fee rate is untouched.
    EVM_FEE_BPS !== 50,
    // 16. The EVM referral share is untouched.
    EVM_REFERRAL_SHARE_BPS !== 2000,
    // 17. EVM fees are still enabled (treasury present and verified).
    !evmFeesEnabled(),
    // 18. The EVM fee arithmetic still produces the right treasury and
    //     referrer cuts on 1 ETH (0.004 + 0.001).
    evmSplit.treasuryWei !== 4_000_000_000_000_000n || evmSplit.referrerWei !== 1_000_000_000_000_000n,
  ];
}

/** How many canaries tripped. 0 on a genuine build. */
export function tamperCount(): number {
  let n = 0;
  for (const tripped of tamperFlags()) if (tripped) n += 1;
  return n;
}

/** True only when nothing has been tampered with. */
export function isIntact(): boolean {
  return tamperCount() === 0;
}
