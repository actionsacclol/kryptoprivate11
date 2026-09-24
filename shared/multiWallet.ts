// Splitting a position across wallets you own, spread over time.
//
// ─── What this is for, and what it is not ────────────────────────────────
//
// The point is spacing and privacy: entering a position in pieces rather than
// one visible buy, held across a few of your own addresses rather than all in
// one. That is an ordinary thing to want. A single address holding an entire
// position is a target, and one large buy in one block is a signal other
// people trade against.
//
// It is NOT bundling. On 2026-09-14 the previous version of this — a panel
// where N wallets bought the same coin at once — was removed, with this in the
// commit: "Both manufactured trading activity across wallets one person
// controls, which reads as wash trading / market manipulation whatever the
// intent behind it." That reasoning did not stop being true, so the feature
// comes back shaped by it rather than in spite of it.
//
// ─── The one change that makes the difference ────────────────────────────
//
// SIMULTANEOUS IS NOT OFFERED. Every wallet's buy is separated by a real gap,
// enforced in main. That single rule is what separates the two cases, and it
// happens to be the thing the feature is FOR — someone who wants to space out
// an entry wants the gap; only someone manufacturing the look of independent
// demand needs them in the same block.
//
// Alongside it:
//
//  • A HARD CAP on wallets per coin. Splitting an entry five ways is sizing.
//    Twenty ways is depth that does not exist. Enforced in main, not the
//    form, so it cannot be reached around, and not configurable — a limit the
//    user can raise is not a limit.
//
//  • AN ACKNOWLEDGEMENT, off by default, that says plainly where the line is,
//    so nobody arrives at it by accident.
//
//  • NOTHING THAT DISGUISES COMMON CONTROL. Uneven split sizes stay, because
//    splitting a position unevenly is a real thing people do. What is gone is
//    describing or offering that as a way to look like unrelated buyers. A
//    tool whose purpose is to hide who is behind the trades is a different
//    product from this one.
//
// None of this is legal advice, and none of it makes anything legal that is
// not. It keeps the shape of the tool honest.

/**
 * The most of your wallets that may hold one coin through these paths.
 *
 * Raised from five to ten 2026-09-22 at the user's ask. The spacing (a 5 s
 * floor, random gaps and a random size per wallet) is unchanged, so ten is ten
 * ordinary buys blocks apart, never a bundle. Deliberately not configurable.
 */
export const MAX_WALLETS_PER_TOKEN = 10;

/**
 * The smallest gap between one wallet's buy and the next, milliseconds.
 *
 * This is the rule that makes it spacing rather than a bundle, so it is a
 * floor rather than a default: a caller may ask for longer and cannot ask for
 * shorter.
 *
 * Five seconds is about a dozen Solana blocks. That is the distinction that
 * matters here — "bundling" means one block or one Jito bundle, and anything
 * separated by blocks is a sequence of ordinary buys rather than a single
 * coordinated event.
 */
export const MIN_GAP_MS = 5_000;

/**
 * The longest a single gap may be: five minutes.
 *
 * There has to be a ceiling, because a queued buy is a decision made earlier
 * and executed later. On a memecoin, twenty minutes is long enough for the
 * thing you decided to buy to be a different proposition entirely — so the
 * whole entry should finish inside a window you can still reason about. At
 * the cap, ten wallets take nine gaps, or forty-five minutes end to end.
 */
export const MAX_GAP_MS = 5 * 60_000;

/** What the form starts at — a range, above the floor, because the point is
 *  to be spread out rather than to scrape past a limit. */
export const DEFAULT_GAP_MIN_MS = 10_000;
export const DEFAULT_GAP_MAX_MS = 45_000;

/**
 * A gap range, cleaned up: floored, capped, and ordered.
 *
 * Why a RANGE rather than one number — the gaps are randomised inside it.
 * Buys at an exact interval are their own signature: a metronome is what a
 * script looks like, and irregular spacing is what ordinary trading looks
 * like. This is about the entry not being one recognisable event, which is
 * the same reason the feature exists. It is NOT about making related wallets
 * look unrelated; that is a different thing and this app does not do it.
 */
export function gapRange(minMs: number, maxMs: number): { minMs: number; maxMs: number } {
  const lo = Number.isFinite(minMs) ? Math.round(minMs) : DEFAULT_GAP_MIN_MS;
  const hi = Number.isFinite(maxMs) ? Math.round(maxMs) : DEFAULT_GAP_MAX_MS;
  // The floor wins over everything, including a caller asking for less.
  const min = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, lo));
  // A max below the min is a mistake, not an instruction to go faster.
  const max = Math.min(MAX_GAP_MS, Math.max(min, hi));
  return { minMs: min, maxMs: max };
}

/** One gap, drawn uniformly from the cleaned range. `rand` is injected so a
 *  test can assert the bounds rather than trusting a sample. */
export function randomGap(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  const { minMs: lo, maxMs: hi } = gapRange(minMs, maxMs);
  if (hi <= lo) return lo;
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Bumping this invalidates every existing acknowledgement.
 *
 * Only change it when the WORDING changes materially — an acknowledgement is
 * worth nothing if it was given to different words.
 */
// .2 (2026-09-22): the Copier was removed, so the old wording — about Krypt
// spacing the pieces out and capping wallets per coin — no longer described
// what is being accepted. Scripts are now the only multi-wallet path, and
// they are not spaced or capped by the app. New words, new version, so every
// earlier acceptance is asked again.
export const MULTI_WALLET_CONSENT_VERSION = '2026-09-22.2';

/** What the user reads once, before any of this runs. */
export const MULTI_WALLET_CONSENT_TEXT = [
  'This lets a script trade from any of your own wallets by naming its address, instead of only your main wallet.',
  'Krypt does not space these trades out or limit how many of your wallets touch one coin — the script does exactly what it is written to do, inside its own budget.',
  'Buying the same coin from many wallets at once, or trading between wallets you control, can be wash trading or market manipulation — whatever the reason for doing it, and even when every trade is real. Krypt does not do those things for you and will not help make related wallets look unrelated.',
  'Every trade still appears in your own history, with the wallet that made it. You are responsible for what your scripts do and for the law where you live. This is not legal advice.',
];

/**
 * Recorded when the acknowledgement is given.
 *
 * `acceptedAt` is 0 rather than null for never-accepted, deliberately. It
 * lives in settings, and the settings validator compares a value's type to
 * its DEFAULT's type — `typeof null` is 'object', so a null default would
 * reject every real timestamp and the acceptance would silently never save.
 * That exact shape has bitten this codebase before (2026-09-08).
 */
export interface MultiWalletConsent {
  /** ms, or 0 for never. */
  acceptedAt: number;
  /** The wording accepted. An older version reads as not accepted. */
  version: string;
}

export const NO_CONSENT: MultiWalletConsent = { acceptedAt: 0, version: '' };

/** Present, and for the current wording. */
export function consentValid(c: MultiWalletConsent | undefined | null): boolean {
  return !!c && typeof c.acceptedAt === 'number' && c.acceptedAt > 0 && c.version === MULTI_WALLET_CONSENT_VERSION;
}



/**
 * Why a multi-wallet action cannot run, or null when it can.
 *
 * Called by the FORM so the button can explain itself, and again in MAIN
 * before anything is signed — the form's answer is a courtesy, main's is the
 * rule. Same function both sides so they cannot disagree.
 */
export function multiWalletProblem(
  walletCount: number,
  consent: MultiWalletConsent | undefined | null,
): string | null {
  if (!consentValid(consent)) {
    return 'Trading from your other wallets is off until you read and accept what it is — Automation › Scripts › Trading from your other wallets.';
  }
  if (!Number.isInteger(walletCount) || walletCount < 1) return 'Pick at least one wallet.';
  if (walletCount > MAX_WALLETS_PER_TOKEN) {
    return `${walletCount} wallets on one coin — Krypt allows ${MAX_WALLETS_PER_TOKEN}. Splitting further stops being position sizing.`;
  }
  return null;
}

/**
 * When each wallet's piece goes out, as offsets from now in milliseconds.
 *
 * The first is immediate; every one after it is a fresh random draw from the
 * range, so the spacing is irregular rather than a fixed beat. Pure, with
 * `rand` injected, so a test can assert the bounds and the ordering rather
 * than trusting a timer and a sample.
 */
export function scheduleFor(
  walletCount: number,
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): number[] {
  const n = Math.max(0, Math.min(MAX_WALLETS_PER_TOKEN, Math.floor(walletCount)));
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) at += randomGap(minMs, maxMs, rand);
    out.push(at);
  }
  return out;
}

/** The worst case for a whole run, so the form can say "up to N minutes"
 *  rather than leaving someone to guess how long their entry will take. */
export function maxRunMs(walletCount: number, minMs: number, maxMs: number): number {
  const n = Math.max(0, Math.min(MAX_WALLETS_PER_TOKEN, Math.floor(walletCount)));
  return n <= 1 ? 0 : (n - 1) * gapRange(minMs, maxMs).maxMs;
}
