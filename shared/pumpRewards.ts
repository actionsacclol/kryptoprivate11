// pump.fun callout rewards — what pump says it has paid, and whether an
// account has accepted the terms rewards are paid under (2026-09-23).
//
// Read from pump's own routes, found in its web bundle:
//
//   GET  /payouts?kind=reward|referral&page&pageSize   (auth)
//        → { payouts: [{ walletAddress, amountUsdc, status, txSignature,
//             createdAt, kind }], totalPaidUsdc }
//        totalPaidUsdc is CONFIRMED-only, across all the account's wallets.
//        status: awaiting_approval → pending → signed → submitted →
//        confirmed | failed | rejected.
//   GET  /creator-rewards-tos                          (auth)
//        → { accepted, acceptedAt }
//   POST /creator-rewards-tos/accept                   (auth, idempotent)
//        → { acceptedAt, alreadyAccepted }
//
// Rewards are paid in USDC to the account's wallet. Nothing here pays or
// claims anything; accepting the terms is a button a person presses.

/** The terms rewards are paid under, as pump's own page links them. */
export const CALLOUT_REWARD_TERMS_URL = 'https://pump.fun/docs/callout-reward-terms';

export type PayoutStatus = 'awaiting_approval' | 'pending' | 'signed' | 'submitted' | 'confirmed' | 'failed' | 'rejected' | 'unknown';

export interface PumpPayout {
  walletAddress: string | null;
  amountUsdc: number | null;
  status: PayoutStatus;
  txSignature: string | null;
  createdAt: string | null;
  kind: 'reward' | 'referral' | 'unknown';
}

export interface PumpRewards {
  /** Wallet id in this app. */
  walletId: string;
  address: string;
  username: string | null;
  /** null = pump did not say (never read as "not accepted"). */
  termsAccepted: boolean | null;
  termsAcceptedAt: string | null;
  /** Confirmed callout rewards, USDC. null = unknown. */
  rewardsPaidUsdc: number | null;
  /** Confirmed referral commissions, USDC. null = unknown. */
  referralPaidUsdc: number | null;
  /** Newest first, callout rewards only. */
  recent: PumpPayout[];
  /** What pump would not answer, in words. */
  problem: string | null;
}

const STATUSES = new Set<PayoutStatus>(['awaiting_approval', 'pending', 'signed', 'submitted', 'confirmed', 'failed', 'rejected']);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One payout row, shaped defensively: an unknown status is 'unknown', a
 *  missing amount is null — never 0. */
export function payoutFrom(raw: unknown): PumpPayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const status = String(o.status ?? '') as PayoutStatus;
  const kind = o.kind === 'reward' || o.kind === 'referral' ? o.kind : 'unknown';
  return {
    walletAddress: str(o.walletAddress),
    amountUsdc: num(o.amountUsdc),
    status: STATUSES.has(status) ? status : 'unknown',
    txSignature: str(o.txSignature),
    createdAt: str(o.createdAt),
    kind,
  };
}

/** GET /payouts' body → rows + confirmed total. Null when it is not that shape. */
export function payoutsFrom(raw: unknown): { payouts: PumpPayout[]; totalPaidUsdc: number | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.payouts) && o.totalPaidUsdc === undefined) return null;
  const payouts = (Array.isArray(o.payouts) ? o.payouts : []).map(payoutFrom).filter((p): p is PumpPayout => p !== null);
  return { payouts, totalPaidUsdc: num(o.totalPaidUsdc) };
}

/** GET /creator-rewards-tos → accepted / when. Null when not that shape. */
export function termsFrom(raw: unknown): { accepted: boolean; acceptedAt: string | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.accepted !== 'boolean') return null;
  return { accepted: o.accepted, acceptedAt: str(o.acceptedAt) };
}

/** Plain words for a payout's state, for the panel. */
export function payoutStatusLabel(s: PayoutStatus): string {
  switch (s) {
    case 'awaiting_approval':
      return 'awaiting approval';
    case 'pending':
    case 'signed':
    case 'submitted':
      return 'on its way';
    case 'confirmed':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    default:
      return 'unknown';
  }
}
