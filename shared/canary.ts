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

import { FEE_BPS, REFERRAL_SHARE_BPS, TREASURY_ADDRESS, splitFee, feesEnabled } from './fees';
import { resolveTreasury, canonicalTreasury } from './feeIntegrity';
import { PRESENCE, packIdentity } from './presence';
import { resolvePresence, canonicalPresence } from './presenceIntegrity';

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
  return [
    // 1. The canonical treasury blob decodes to a valid address.
    canon.length !== 44,
    // 2. The readable constant still matches the canonical (not redirected).
    resolveTreasury(TREASURY_ADDRESS).state !== 'ok',
    // 3. The fee rate is untouched.
    FEE_BPS !== 50,
    // 4. The referral share is untouched.
    REFERRAL_SHARE_BPS !== 2000,
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
    packIdentity(PRESENCE).split('|').slice(1, 5).join('|') !== 'Free Tools|https://krypt.cc/tools|Krypt.cc|https://discord.gg/muzFKR657F',
    // 12. The art and the product name are unchanged.
    ident?.largeImageKey !== 'krypt' || ident?.largeImageText !== 'Krypto Bot',
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
