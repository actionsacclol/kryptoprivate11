// pump.fun's referral programme: every account made or signed in through
// Krypt is referred by Krypt's own pump.fun account.
//
// Decided 2026-09-22 by the owner: Krypto Bot is free software, and this is
// one of the ways it earns — like the 0.5 % trade fee, it is applied without a
// switch and DISCLOSED (terms › fees, the summary, and a line where accounts
// are made). Pinned by test/pumpreferral.test.mjs the way the fee treasury is.
//
// ─── How pump's programme works — READ from their route table 09-22 ───────
//
//   POST /referral/apply { username }   the code IS the referrer's username,
//                                       matched case-insensitively. Always a
//                                       200; the decision is `outcome`.
//   GET  /referral/me                   eligibleReferee, referralWindowEndsAt
//
// An account can be referred only within 24 HOURS of first signing in (a fresh
// throwaway showed referralWindowEndsAt = sign-in + 24 h), and never if it
// predates the programme. So the code is applied straight after sign-in; an
// older account brought in by key simply answers applyWindowClosed or
// accountPredatesProgram, which is logged and left alone.
//
// What it pays the referrer (their descriptions, verbatim in substance):
//   • a first-deposit match — paid by pump, costs the user nothing;
//   • a callout-rewards share — "each daily payout round cuts every referred
//     earner's reward slice by a share and pays it to their referrer". That
//     one comes OUT of the user's own callout rewards, which is why the terms
//     say so in those words.
//
// Confirmed live 09-22 with a throwaway: register → apply with a made-up name
// → 200 {"outcome":"unknownUsername"}. The real code was NOT applied to a
// throwaway, so no test account sits on Krypt's referral list.

/** Krypt's pump.fun username, which pump uses as the referral code. Account
 *  Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm (checked 09-22). RENAMING
 *  THAT ACCOUNT BREAKS THIS: pump matches the username as it is today. */
export const KRYPT_REFERRAL_CODE = 'kryptcc';

export const REFERRAL_APPLY_PATH = '/referral/apply';

/** Every outcome pump's schema lists. Anything else reads as 'unknown'. */
export const REFERRAL_OUTCOMES = [
  'applied',
  'alreadyReferred',
  'unknownUsername',
  'selfReferral',
  'referrerNotEligible',
  'referrerNotOlder',
  'refereeNotEligible',
  'accountPredatesProgram',
  'applyWindowClosed',
] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number] | 'unknown';

/** The outcome out of pump's answer, whatever else it carries. */
export function referralOutcomeFrom(body: unknown): ReferralOutcome {
  const o = body && typeof body === 'object' ? (body as { outcome?: unknown }).outcome : undefined;
  return (REFERRAL_OUTCOMES as readonly string[]).includes(o as string) ? (o as ReferralOutcome) : 'unknown';
}

/** Outcomes that are final for this account: asking again changes nothing.
 *  `unknownUsername` is NOT here — that is our code gone wrong (a rename),
 *  and is logged as a warning rather than remembered as settled. */
export const SETTLED_OUTCOMES: readonly ReferralOutcome[] = [
  'applied',
  'alreadyReferred',
  'selfReferral',
  'refereeNotEligible',
  'accountPredatesProgram',
  'applyWindowClosed',
];

/** The disclosure shown where accounts are made. One sentence, plain words. */
export const REFERRAL_NOTICE =
  `pump.fun accounts made or signed in here are referred by Krypt (code “${KRYPT_REFERRAL_CODE}”): pump pays Krypt a share of the callout rewards the account earns, taken from the account’s share. This is how the free app earns, alongside the trade fee.`;

// ─── Retrying a referral that did not land ───────────────────────────────
//
// The code only counts inside pump's 24 h window, and the first attempt can
// fail for reasons that have nothing to do with the account — pump busy, a
// Cloudflare block, the app closed a minute after sign-in. A referral that was
// not settled is therefore kept (pump-referral-pending.json in userData) and
// retried until pump gives a final answer or the window is over. Pure rules
// here; the file and the timer are in system/pumpSocial.ts.

export const REFERRAL_WINDOW_MS = 24 * 3_600_000;
/** How often an unsettled referral is asked again. */
export const REFERRAL_RETRY_MS = 5 * 60_000;
/** Stop a little before the window ends: an answer that late is applyWindowClosed anyway. */
export const REFERRAL_STOP_MARGIN_MS = 10 * 60_000;

export interface PendingReferral {
  address: string;
  walletId: string;
  /** When the account was first seen unreferred — the window is counted from here, never later than pump's own. */
  since: number;
  lastTried: number;
  tries: number;
  last: ReferralOutcome;
}

/** Whether this outcome is final, so the account leaves the queue. */
export function referralIsSettled(outcome: ReferralOutcome): boolean {
  return SETTLED_OUTCOMES.includes(outcome);
}

/** Past the point where asking can still work. */
export function referralExpired(p: PendingReferral, now: number): boolean {
  return now - p.since >= REFERRAL_WINDOW_MS - REFERRAL_STOP_MARGIN_MS;
}

/** Worth asking again right now. */
export function referralDue(p: PendingReferral, now: number): boolean {
  return !referralExpired(p, now) && now - p.lastTried >= REFERRAL_RETRY_MS;
}

/**
 * The queue after one attempt's answer: settled leaves it, anything else stays
 * (a new entry keeps its first `since`). Returns a new array.
 */
export function referralQueueAfter(
  queue: readonly PendingReferral[],
  who: { address: string; walletId: string },
  outcome: ReferralOutcome,
  now: number,
): PendingReferral[] {
  const rest = queue.filter((p) => p.address !== who.address);
  if (referralIsSettled(outcome)) return rest;
  const prev = queue.find((p) => p.address === who.address);
  return [...rest, { address: who.address, walletId: who.walletId, since: prev?.since ?? now, lastTried: now, tries: (prev?.tries ?? 0) + 1, last: outcome }];
}
