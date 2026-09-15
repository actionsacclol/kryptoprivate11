// Platform fee + referral split — pure arithmetic, no I/O.
//
// ─── The deal ─────────────────────────────────────────────────────────
//
// 0.5% of each trade, both sides (1% round trip), on top of pump's own
// 1%/side and — when the relayer fallback path is used — its 0.5%/side.
// When the user names a referrer at onboarding, 20% of OUR fee — 0.1% of the
// trade — goes to that address in the same transaction. Not a promise
// redeemable later, not a points balance: a `SystemProgram.transfer` in the same tx as the trade, so
// it either both happens or neither does.
//
// That matters because onboarding says the referrer earns something. Saying it
// and not doing it is the kind of small lie that ends a mass-adoption tool, so
// the payment is atomic with the trade rather than a ledger we promise to
// settle.
//
// ─── What this cannot do ──────────────────────────────────────────────
//
// The app runs on the user's machine. Anyone determined can patch the fee out.
// Hardcoding the treasury (rather than exposing it as a setting) stops casual
// editing, and that is the honest ceiling on enforcement — plan revenue as
// "most people won't bother", never as "cannot be avoided".

import { resolveTreasury } from './feeIntegrity';

/** Our cut, in basis points of the trade's SOL value. 50 bps = 0.5%. */
export const FEE_BPS = 50;

/**
 * The farming rate: 5 bps = 0.05% a side, 0.10% a round trip.
 *
 * WHY A SECOND RATE EXISTS. Volume farming is not trading. A farmer does
 * hundreds of round trips whose expected price move is zero, purely to be
 * counted by some external programme — so the app's fee is not a share of a
 * gain, it is the entire cost of the activity. Measured 2026-09-14, the whole
 * market friction of a WSOL->USDC->WSOL round trip is about 0.5 bps at size.
 * Charging 100 bps on top of a 0.5 bps activity means the user needs a
 * programme paying more than 1% of volume to break even, and nothing pays
 * that — the fee would not be expensive, it would make the feature
 * arithmetically impossible.
 *
 * At 10 bps a round trip the bar is ~0.11% instead, which most programmes
 * clear, so the feature can exist and still pay for itself.
 *
 * THIS IS NOT A BYPASS AND MUST NEVER BECOME ONE. It applies only to round
 * trips the farming runner itself places. Every ordinary buy and sell — every
 * manual trade, every copy, every order, every script — stays at FEE_BPS.
 * `splitFee` defaults to FEE_BPS precisely so that reaching the farm rate has
 * to be deliberate at the call site, and the canary (shared/canary.ts) checks
 * this constant the same way it checks the main one.
 */
export const FARM_FEE_BPS = 5;

/** The referrer's share OF OUR FEE, in basis points. 2000 = 20% of the fee,
 *  which is 0.1% of the trade. */
export const REFERRAL_SHARE_BPS = 2000;

/**
 * Where our share goes. Verified 2026-08-25: decodes to 32 bytes, round-trips,
 * and is on the ed25519 curve (a normal wallet, not a PDA).
 *
 * An empty string here disables the fee entirely, which is what shipped before
 * this address existed — a build must never send lamports to a placeholder
 * somebody else might control.
 */
export const TREASURY_ADDRESS = 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n';

/**
 * Below this the transfer is not worth the compute units and the extra account
 * in the transaction. A 1,000-lamport floor means trades under ~0.0002 SOL pay
 * nothing, which is noise either way.
 */
export const MIN_FEE_LAMPORTS = 1_000;

export interface FeeSplit {
  /** Everything leaving the wallet for us and the referrer. */
  totalLamports: number;
  /** Our share. */
  treasuryLamports: number;
  /** The referrer's share; 0 when nobody was named. */
  referrerLamports: number;
}

export const ZERO_SPLIT: FeeSplit = { totalLamports: 0, treasuryLamports: 0, referrerLamports: 0 };

/**
 * Split a trade's SOL value into treasury and referrer shares.
 *
 * `hasReferrer` rather than an address, because whether an address is USABLE
 * (valid, not the user's own, not the treasury) is a separate decision made
 * once at onboarding — not re-litigated on the hot path of every trade.
 */
export function splitFee(basisLamports: number, hasReferrer: boolean, bps: number = FEE_BPS): FeeSplit {
  if (!Number.isFinite(basisLamports) || basisLamports <= 0) return ZERO_SPLIT;
  // Defaulted, never inferred. A caller that wants the farm rate says so; a
  // caller that forgets gets the ordinary fee, which is the safe direction.
  const rate = Number.isFinite(bps) && bps > 0 && bps <= FEE_BPS ? bps : FEE_BPS;
  const total = Math.floor((basisLamports * rate) / 10_000);
  if (total < MIN_FEE_LAMPORTS) return ZERO_SPLIT;
  if (!hasReferrer) return { totalLamports: total, treasuryLamports: total, referrerLamports: 0 };
  const referrer = Math.floor((total * REFERRAL_SHARE_BPS) / 10_000);
  // Treasury takes the remainder, so rounding never loses or invents a lamport.
  return { totalLamports: total, treasuryLamports: total - referrer, referrerLamports: referrer };
}

// ─── Address validation ───────────────────────────────────────────────

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Structural check only: base58 alphabet and a length that decodes to 32
 * bytes. It cannot tell you the address is on the ed25519 curve or that
 * anybody holds its key — the caller decides how much that matters.
 */
export function looksLikeSolAddress(addr: string): boolean {
  const a = (addr ?? '').trim();
  if (a.length < 32 || a.length > 44) return false;
  return BASE58.test(a);
}

export interface ReferralContext {
  /** Every address this user signs with — self-referral is not a referral. */
  ownAddresses: string[];
  treasury: string;
}

/**
 * Why a referral address is unusable, or null when it is fine.
 *
 * Returns a sentence for a human, because this is shown during onboarding to
 * someone who has just pasted something that did not work, and "invalid" on
 * its own gives them nothing to act on.
 */
export function referralProblem(addr: string, ctx: ReferralContext): string | null {
  const a = (addr ?? '').trim();
  if (!a) return null; // empty is fine — the field is optional
  if (!looksLikeSolAddress(a)) {
    return 'That does not look like a Solana address — check for a missing or extra character.';
  }
  if (ctx.ownAddresses.some((o) => o && o.trim() === a)) {
    return 'That is your own wallet. A referral has to point at whoever told you about Krypt.';
  }
  if (ctx.treasury && a === ctx.treasury) {
    return 'That is the Krypt fee address, not a referrer.';
  }
  return null;
}

// ─── Presentation ─────────────────────────────────────────────────────

/** "0.5%" — the fee as a percentage string, derived so the copy in the UI can
 *  never drift from the constant that is actually charged. */
export function feePctLabel(): string {
  return `${(FEE_BPS / 100).toFixed(FEE_BPS % 100 === 0 ? 0 : 2).replace(/\.?0+$/, '')}%`;
}

/** "0.1%" — what a referrer earns per trade, as a share of trade value. */
export function referralPctLabel(): string {
  const bps = (FEE_BPS * REFERRAL_SHARE_BPS) / 10_000;
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Whether this build charges anything at all. Routed through the integrity
 *  layer so a build whose treasury blob is corrupt charges nothing rather than
 *  sending to an unverifiable address. */
export function feesEnabled(): boolean {
  return looksLikeSolAddress(activeTreasury());
}

/**
 * The address the fee actually goes to — resolved through the integrity layer,
 * never the raw constant. Editing TREASURY_ADDRESS in a cracked build does not
 * change this; the canonical encoded copy wins. See feeIntegrity.ts.
 */
export function activeTreasury(): string {
  return resolveTreasury(TREASURY_ADDRESS).treasury;
}

/** Tamper state, for logging and the interlock. */
export function treasuryIntegrity() {
  return resolveTreasury(TREASURY_ADDRESS);
}
