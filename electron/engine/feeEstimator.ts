// Priority-fee estimator — research action #8. Behind an interface so the
// Helius getPriorityFeeEstimate backend can front a raw-RPC fallback.
//
// Solana priority = compute-unit price × requested units, and fee markets
// are LOCAL to the writable accounts a tx locks. So we scope the estimate
// to the bonding curve + global accounts the snipe will write, not the
// network at large (global levels are irrelevant to a specific account).
// All fee quantities are integer micro-lamports per CU.

import type { FeeUrgency } from '@shared/types';

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

/** Raw getRecentPrioritizationFees scoped to the given writable accounts. */
async function fromRpc(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate | null> {
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getRecentPrioritizationFees',
        params: [writableAccounts.slice(0, 128)],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: Array<{ prioritizationFee: number }> };
    const fees = (body.result ?? []).map((r) => r.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    if (fees.length === 0) return { ...FALLBACK, source: 'fallback', scopedTo: writableAccounts };
    return {
      p50: percentile(fees, 50),
      p75: percentile(fees, 75),
      p90: percentile(fees, 90),
      p95: percentile(fees, 95),
      source: 'rpc',
      scopedTo: writableAccounts,
    };
  } catch {
    return null;
  }
}

/** Helius getPriorityFeeEstimate (only when the RPC host is Helius). */
async function fromHelius(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate | null> {
  if (!/helius/i.test(httpUrl)) return null;
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getPriorityFeeEstimate',
        params: [{ accountKeys: writableAccounts.slice(0, 128), options: { includeAllPriorityFeeLevels: true } }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: { priorityFeeLevels?: { medium?: number; high?: number; veryHigh?: number } };
    };
    const lv = body.result?.priorityFeeLevels;
    if (!lv) return null;
    return {
      p50: Math.round(lv.medium ?? FALLBACK.p50),
      p75: Math.round(lv.high ?? FALLBACK.p75),
      p90: Math.round(lv.veryHigh ?? FALLBACK.p90),
      p95: Math.round((lv.veryHigh ?? FALLBACK.p95) * 1.5),
      source: 'helius',
      scopedTo: writableAccounts,
    };
  } catch {
    return null;
  }
}

export async function estimate(httpUrl: string, writableAccounts: string[]): Promise<FeeEstimate> {
  return (
    (await fromHelius(httpUrl, writableAccounts)) ??
    (await fromRpc(httpUrl, writableAccounts)) ??
    { ...FALLBACK, source: 'fallback', scopedTo: writableAccounts }
  );
}

export function priceFor(est: FeeEstimate, urgency: FeeUrgency): number {
  switch (urgency) {
    case 'normal': return est.p50;
    case 'competitive': return est.p75;
    case 'high': return est.p90;
    case 'emergency': return est.p95;
  }
}
