// Moving value BETWEEN chains — the rules, in one place.
//
// A swap happens inside one chain and is atomic: it fills or it reverts, and
// nobody ever holds your money. A bridge is two transactions on two ledgers
// with a gap in the middle where a third party has your funds and OWES you the
// other side. That is a different thing, and this file exists so the
// difference is stated once, in code, rather than implied in six places.
//
// Everything here comes out of docs/bridge-research-2026-09-11.md — a
// six-agent swarm run before a line of this was written. The numbers below are
// MEASURED on 2026-09-11, not estimated, and the ones that could not be
// measured are absent rather than guessed.
//
// ─── The three rules that shape the whole feature ────────────────────────
//
//  1. NATIVE COINS ONLY. Both LI.FI incidents — $600K in March 2022 and
//     $11.6M in July 2024 — were infinite-approval drains. Bridging a native
//     coin grants no approval at all, so that vector does not exist here.
//     Token bridging is a separate decision for another day.
//
//  2. KRYPT'S FEE, SINCE 2026-10-01 (the owner's call). Until then there was
//     none: a percentage cut on a cross-chain TRANSFER was judged closer to
//     "transfer services on behalf of clients" than a swap fee. Every route
//     converts one coin into another (SOL to ETH, BNB to SOL), which is a
//     swap, and the owner chose to charge the ordinary rate: 0.5 %, halved for
//     $KRYPTO holders, a fifth to the referrer, disclosed in Terms §8 and in
//     every quote. On Solana it rides the deposit transaction; on BNB and
//     Robinhood it is the ordinary follow-up transfer to the treasury and the
//     referrer, as on a curve buy (bridge.ts quoteRelay / sendFromEvmRelay).
//
//  3. THE SAFETY STORY IS NOT UNIFORM, AND THE UI SAYS SO. On an EVM source
//     chain the recipient, the destination chain id and the minimum output all
//     sit at fixed offsets in the calldata and can be checked locally. On a
//     Solana source chain NONE of them appear in the transaction at all — the
//     destination is bound only to an opaque id that changes between identical
//     quotes. A green tick that means less on one rail than the other is
//     exactly the dishonesty this codebase's em-dash rule exists to prevent.

import { EVM_CHAIN_META, type EvmChainKind } from './evm';

export type BridgeChain = 'solana' | EvmChainKind;

export const BRIDGE_CHAINS: BridgeChain[] = ['solana', 'robinhood', 'bnb'];

/** LI.FI's own chain ids. Solana's is not a chain id in any EVM sense. */
export const LIFI_CHAIN_ID: Record<BridgeChain, number> = {
  solana: 1151111081099710,
  robinhood: 4663,
  bnb: 56,
};

/** What LI.FI calls "the native coin" on each side. */
export const LIFI_NATIVE_TOKEN: Record<BridgeChain, string> = {
  solana: '11111111111111111111111111111111',
  robinhood: '0x0000000000000000000000000000000000000000',
  bnb: '0x0000000000000000000000000000000000000000',
};

export function chainLabel(c: BridgeChain): string {
  return c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name;
}

export function nativeSymbolOf(c: BridgeChain): string {
  return c === 'solana' ? 'SOL' : EVM_CHAIN_META[c].nativeSymbol;
}

export const isEvmBridgeChain = (c: BridgeChain): c is EvmChainKind => c !== 'solana';

// ─── What can be checked, per source chain ───────────────────────────────

/**
 * Whether the destination of a bridge can be verified from the transaction
 * this app is about to sign.
 *
 * 'verified'  — the recipient, destination chain and minimum output are all
 *               in the bytes at fixed offsets, and were byte-identical across
 *               two independent quotes. The app asserts them before signing.
 * 'trusted'   — none of them are in the bytes. Measured on a real Solana
 *               route: the address, the chain id, the amount and the minimum
 *               are all absent, and the destination is carried only by an
 *               opaque 32-byte id. The app can prove how much leaves and where
 *               it goes on THIS chain, and nothing about the far side.
 */
export type DestinationAssurance = 'verified' | 'trusted';

export function assuranceOf(from: BridgeChain, rail: BridgeRail = 'lifi'): DestinationAssurance {
  // Relay's deposit carries a 32-byte commitment, and since 2026-10-03 that
  // commitment is CHECKED: it must equal the EIP-712 id, recomputed here, of
  // an order paying our own address on the chosen chain, in its native coin,
  // at no less than the floor shown (shared/relayOrder.ts, on every quote).
  // The far side is bound in the bytes we sign; that Relay FILLS it is still
  // Relay's promise — the same as on any bridge.
  if (rail === 'relay') return 'verified';
  return from === 'solana' ? 'trusted' : 'verified';
}

/** Who carries the transfer. Relay since 2026-10-01; LI.FI before that
 *  (its in-flight records are still followed through LI.FI). */
export type BridgeRail = 'relay' | 'lifi';

/**
 * How long a quote may be sent, from the moment it was QUOTED — one number
 * that main enforces and every page counts down, so a button never offers a
 * send that main will refuse as expired. Relay's request carries a deadline
 * of its own; half a minute keeps well inside it. Pages stop two seconds
 * early for the round trip.
 */
export const QUOTE_LIFE_MS: Record<BridgeRail, number> = { relay: 30_000, lifi: 60_000 };
export const QUOTE_UI_MARGIN_MS = 2_000;

// ─── Route readiness ─────────────────────────────────────────────────────

/**
 * A route is enabled only once the programs or contracts it uses have been
 * MEASURED from a real quote and pinned as build constants.
 *
 * This is the launcher's `BUILDER_VERIFIED` pattern (src/pages/Launch.tsx) and
 * it is here for the same reason: the alternative is accepting a program id
 * that the quote itself supplies, which is attacker data. A route whose set
 * has not been measured refuses, and the page says which and why — rather than
 * failing at the signer with something unreadable.
 */
export interface RouteKey {
  from: BridgeChain;
  to: BridgeChain;
}

export const routeId = (from: BridgeChain, to: BridgeChain): string => `${from}->${to}`;

/** Every directed pair, all six. */
export function allRoutes(): RouteKey[] {
  const out: RouteKey[] = [];
  for (const from of BRIDGE_CHAINS) for (const to of BRIDGE_CHAINS) if (from !== to) out.push({ from, to });
  return out;
}

// ─── Minimums, measured ──────────────────────────────────────────────────

/**
 * Below this a bridge is not worth doing, in US dollars of input.
 *
 * Measured round-trip cost as a percentage of the original, 2026-09-11:
 *
 *            $1       $5      $25     $100    $1000
 *   SOL↔BNB  16.37%   2.68%   1.16%   0.67%   0.56%
 *   SOL↔RH   21.89%   5.71%   2.48%   1.63%   1.45%
 *   BNB↔RH   24.74%   6.34%   2.45%     —       —
 *
 * The floors below are the measured point at which a single leg costs 2 % or
 * less. They are WARNINGS, not refusals: it is the user's money and a small
 * transfer may be deliberate. The one hard refusal is HARD_FLOOR_USD.
 */
export const SOFT_MIN_USD: Record<string, number> = {
  'solana->bnb': 25,
  'bnb->solana': 25,
  'bnb->robinhood': 25,
  'robinhood->bnb': 100,
  'solana->robinhood': 50,
  'robinhood->solana': 50,
};

/**
 * Under five dollars a failed bridge is not refunded AT ALL.
 *
 * Relay's own documentation: if the refund is worth less than the gas to send
 * it, no refund is sent. So below this the downside is not "an expensive
 * transfer", it is "the money is gone and nobody will send it back". That is a
 * refusal, not a warning.
 */
export const HARD_FLOOR_USD = 5;

// ─── The draft ───────────────────────────────────────────────────────────

export interface BridgeDraft {
  from: BridgeChain;
  to: BridgeChain;
  /** Human units of the SOURCE chain's native coin. */
  amount: number;
}

export function emptyDraft(from: BridgeChain = 'solana', to: BridgeChain = 'bnb'): BridgeDraft {
  return { from, to, amount: 0 };
}

/**
 * Everything wrong with this draft, in the order a person would fix it.
 *
 * `heldAmount` null means UNKNOWN, never zero — an unreadable balance must not
 * read as "you have nothing", and the chain refuses what it cannot cover
 * anyway. Runs on both sides of the IPC boundary.
 */
export function bridgeProblems(d: BridgeDraft, heldAmount: number | null, enabledRoutes: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!BRIDGE_CHAINS.includes(d.from)) return ['Pick a chain to send from.'];
  if (!BRIDGE_CHAINS.includes(d.to)) return ['Pick a chain to send to.'];
  if (d.from === d.to) out.push('Pick two different chains — use Swap to move between tokens on one chain.');
  else if (!enabledRoutes.has(routeId(d.from, d.to))) {
    out.push(`${chainLabel(d.from)} to ${chainLabel(d.to)} is not enabled in this build yet.`);
  }
  if (!Number.isFinite(d.amount) || d.amount <= 0) out.push('Enter an amount.');
  else if (heldAmount !== null && d.amount > heldAmount) out.push('That is more than you hold.');
  return out;
}

// ─── The quote ───────────────────────────────────────────────────────────

export interface BridgeQuote {
  from: BridgeChain;
  to: BridgeChain;
  /** Base units of the source native coin. */
  fromAmountRaw: string;
  /** Base units expected on the far side, and the enforced minimum. */
  toAmountRaw: string;
  /**
   * The ONLY real slippage figure.
   *
   * `action.slippage` in LI.FI's response is echoed back verbatim and never
   * applied — measured: sending 0.5 %, 5 % and 30 % all produced an enforced
   * minimum set by the aggregator per route (0.995 on the 09-11 Solana quotes, 0.990025 on the BNB ones the same day) and READ from the response, never assumed. Never read that field; read this one.
   */
  toAmountMinRaw: string;
  toDecimals: number;
  /** Dollar value in and out, as LI.FI priced them. Null when unpriced. */
  fromUsd: number | null;
  toUsd: number | null;
  /** Which bridge is actually carrying it. */
  tool: string;
  /** Seconds LI.FI expects it to take. */
  durationSec: number | null;
  /** Whether the destination can be checked from the bytes we sign. */
  assurance: DestinationAssurance;
  /** Everything the route takes, already deducted from `toAmount`. */
  feeUsd: number | null;
  /** Who carries it. Absent on a LI.FI quote from before 2026-10-01. */
  rail?: BridgeRail;
  /**
   * This quote's identity. A send must name it: the Bridge page and the
   * All-in-One move share one cache keyed by route and amount, so without it
   * one page could send a quote the other made, with amounts nobody saw.
   */
  quoteId?: string;
  /** Krypt's own fee on this transfer, in dollars (part of `feeUsd`), and a
   *  plain line for the page. Null/absent when fees are off. */
  kryptFeeUsd?: number | null;
  kryptFeeNote?: string | null;
}

/** What the user loses on this transfer, as a percentage. Null = unpriceable. */
export function costPct(q: BridgeQuote): number | null {
  if (q.fromUsd === null || q.toUsd === null || q.fromUsd <= 0) return null;
  return ((q.fromUsd - q.toUsd) / q.fromUsd) * 100;
}

/** A warning about this quote's size, or null. Refusals are separate. */
export function sizeWarning(q: BridgeQuote): string | null {
  if (q.fromUsd === null) return null;
  const min = SOFT_MIN_USD[routeId(q.from, q.to)];
  if (min === undefined || q.fromUsd >= min) return null;
  const pct = costPct(q);
  return pct === null
    ? `Small transfers on this route lose a large share to fixed costs. Below about $${min} it is rarely worth it.`
    : `This transfer loses ${pct.toFixed(1)}% to fees. Below about $${min} on this route, fixed costs dominate.`;
}

/** A refusal about this quote's size, or null. */
export function sizeRefusal(q: BridgeQuote): string | null {
  if (q.fromUsd === null) return null;
  if (q.fromUsd < HARD_FLOOR_USD) {
    return `Under $${HARD_FLOOR_USD} a failed transfer is not refunded — the refund would cost more in gas than it is worth, and the route simply does not send it. Send more, or send nothing.`;
  }
  return null;
}

// ─── In flight ───────────────────────────────────────────────────────────

/**
 * A transfer that has left one chain and not yet arrived on the other.
 *
 * Persisted the moment the source transaction is broadcast, and restored on
 * start — the scanner's `pending` shape, fixed on 2026-09-11 for exactly this
 * class of bug: state that lived only in memory was lost on every restart.
 * After a crash the CHAIN is the source of truth, never this record.
 */
export interface InFlight {
  id: string;
  from: BridgeChain;
  to: BridgeChain;
  /** The transaction we broadcast. The ONLY safe key to ask status by. */
  txHash: string;
  fromAmountRaw: string;
  toAmountMinRaw: string;
  toDecimals: number;
  tool: string;
  startedAt: number;
  status: BridgeStatus;
  /** What the far side actually delivered, once known. */
  deliveredRaw: string | null;
  /** Why it ended, when it ended badly. */
  note: string | null;
  /**
   * Solana source only: the blockhash the transaction was built on. Once it
   * has expired, a signature the chain has never seen is a transaction that
   * never landed — provable, and the record is closed as 'failed' instead of
   * being polled forever as 'unknown'.
   */
  blockhash?: string;
  /** Who carries it — decides which status API is asked. Absent = LI.FI. */
  rail?: BridgeRail;
  /** Relay's request id: the key its status is asked by. */
  requestId?: string;
}

/**
 * Where a transfer is.
 *
 * `unknown` is a real state and the commonest one after a restart: LI.FI may
 * not answer, may rate-limit us for two hours, or may not recognise the hash
 * yet. It must never render as "pending" (which implies we know it is moving)
 * nor as "failed" (which implies we know it is not).
 */
export type BridgeStatus = 'pending' | 'done' | 'partial' | 'refunded' | 'failed' | 'unknown';

export const STATUS_LABEL: Record<BridgeStatus, string> = {
  pending: 'On its way',
  done: 'Arrived',
  // Terminal, and NOT success: LI.FI documents PARTIAL as "the transfer was
  // partially successful… may provide alternative tokens in case of low
  // liquidity". A user may be holding something they did not ask for.
  partial: 'Arrived, but not as asked',
  refunded: 'Refunded on the chain it left',
  failed: 'Failed',
  unknown: 'Could not check',
};

/** True while the money is neither here nor there. */
export const isInFlight = (s: BridgeStatus): boolean => s === 'pending' || s === 'unknown';

/**
 * Map LI.FI's status and substatus onto ours.
 *
 * `DONE` alone is not success — `PARTIAL` is a terminal DONE substatus, and
 * `REFUNDED` is a DONE too. Reading only the top-level status would report a
 * refund as an arrival.
 */
export function readStatus(status: unknown, substatus: unknown): BridgeStatus {
  const s = typeof status === 'string' ? status.toUpperCase() : '';
  const sub = typeof substatus === 'string' ? substatus.toUpperCase() : '';
  if (s === 'DONE') {
    if (sub === 'PARTIAL') return 'partial';
    if (sub === 'REFUNDED') return 'refunded';
    return 'done';
  }
  if (s === 'FAILED') return 'failed';
  if (s === 'PENDING') return 'pending';
  // NOT_FOUND and INVALID are not failures: a hash LI.FI has not indexed yet
  // looks exactly like one it will never know about, and calling that "failed"
  // would tell a user their money is gone while it is still moving.
  return 'unknown';
}
