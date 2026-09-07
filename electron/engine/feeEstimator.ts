// Priority-fee estimator — research action #8. Behind an interface so the
// Helius getPriorityFeeEstimate backend can front a raw-RPC fallback.
//
// Solana priority = compute-unit price × requested units, and fee markets
// are LOCAL to the writable accounts a tx locks. So we scope the estimate
// to the bonding curve + global accounts the snipe will write, not the
// network at large (global levels are irrelevant to a specific account).
// All fee quantities are integer micro-lamports per CU.

import type { FeeUrgency } from '@shared/types';
import { mentionsRateLimit } from '@shared/rpcErrors';
import { rpcCall } from './rpcClient';

export interface FeeEstimate {
  /** Compute-unit price in micro-lamports, per urgency percentile. */
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  /** Which backend produced this. */
  source: 'helius' | 'rpc' | 'fallback';
  /** Writable accounts the estimate was scoped to. */
  scopedTo: string[];
}

const FALLBACK: Omit<FeeEstimate, 'source' | 'scopedTo'> = { p50: 50_000, p75: 100_000, p90: 250_000, p95: 500_000 };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Both backends go through rpcClient (2026-09-06): the raw fetches here
// ignored a 429 — no park, no failover, and a Helius refusal was followed by
// a second call to the same host — and then quietly priced the trade with
// the hard-coded FALLBACK. `rpcCall` shares the per-host park and bucket
// with the trade's own calls.

/** Raw getRecentPrioritizationFees scoped to the given writable accounts. */
async function fromRpc(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate | null> {
  const r = await rpcCall<Array<{ prioritizationFee: number }>>(httpUrl, 'getRecentPrioritizationFees', [writableAccounts.slice(0, 128)]);
  if (!r.ok) return null;
  const fees = (r.data ?? []).map((x) => x.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
  if (fees.length === 0) return { ...FALLBACK, source: 'fallback', scopedTo: writableAccounts };
  return {
    p50: percentile(fees, 50),
    p75: percentile(fees, 75),
    p90: percentile(fees, 90),
    p95: percentile(fees, 95),
    source: 'rpc',
    scopedTo: writableAccounts,
  };
}

/** Helius getPriorityFeeEstimate (only when the RPC host is Helius).
 *  'rate-limited' when the host said 429: asking it the raw method next
 *  would only be refused again. */
async function fromHelius(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate | null | 'rate-limited'> {
  if (!/helius/i.test(httpUrl)) return null;
  const r = await rpcCall<{ priorityFeeLevels?: { medium?: number; high?: number; veryHigh?: number } }>(
    httpUrl,
    'getPriorityFeeEstimate',
    [{ accountKeys: writableAccounts.slice(0, 128), options: { includeAllPriorityFeeLevels: true } }],
  );
  if (!r.ok) return mentionsRateLimit(r.message) ? 'rate-limited' : null;
  const lv = r.data?.priorityFeeLevels;
  if (!lv) return null;
  return {
    p50: Math.round(lv.medium ?? FALLBACK.p50),
    p75: Math.round(lv.high ?? FALLBACK.p75),
    p90: Math.round(lv.veryHigh ?? FALLBACK.p90),
    p95: Math.round((lv.veryHigh ?? FALLBACK.p95) * 1.5),
    source: 'helius',
    scopedTo: writableAccounts,
  };
}

export async function estimate(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate> {
  const helius = await fromHelius(httpUrl, writableAccounts);
  if (helius && helius !== 'rate-limited') return helius;
  const rpc = helius === 'rate-limited' ? null : await fromRpc(httpUrl, writableAccounts);
  return rpc ?? { ...FALLBACK, source: 'fallback', scopedTo: writableAccounts };
}

export function priceFor(est: FeeEstimate, urgency: FeeUrgency): number {
  switch (urgency) {
    case 'normal': return est.p50;
    case 'competitive': return est.p75;
    case 'high': return est.p90;
    case 'emergency': return est.p95;
  }
}
