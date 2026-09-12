// Formatting for the EVM surfaces (Robinhood Chain, BNB Smart Chain). Same
// rule as format.ts: a null is unknown and prints an em dash, never a zero.
// Every native amount takes its symbol — ETH on one chain, BNB on the other.

const DASH = '—';

export function fmtNative(v: number | null | undefined, symbol: string, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  // Tiny amounts (a fee, a gas estimate) need more places than a balance.
  const d = abs > 0 && abs < 0.001 ? 6 : digits;
  return `${v.toFixed(d)} ${symbol}`;
}

/**
 * A trade result that was BROADCAST but had no receipt within the wait: the
 * rail records it pending and reconciles it later, so it is a warning, not a
 * failure. Read from the result's stage when the IPC carried it, else from
 * the rail's own wording.
 */
export function isPendingResult(r: { ok: boolean; message: string; data?: { stage?: string } | null }): boolean {
  if (r.ok) return false;
  if (r.data?.stage === 'pending') return true;
  return /\bpending\b|not confirmed within|waiting for the receipt/i.test(r.message);
}

export const PENDING_TOAST = 'Sent — waiting for the receipt; it will settle on the ledger';

/** Signed native with a leading + for gains. */
export function fmtNativeSigned(v: number | null | undefined, symbol: string, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${fmtNative(v, symbol, digits)}`;
}

/** Token amounts: 1.2M, 340.5K, 12,345.6 — whole tokens, compact. */
export function fmtTokens(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: abs >= 100 ? 0 : 2 });
}

/** Native per token, in a form that survives eight leading zeros. */
export function fmtPriceNative(v: number | null | undefined, symbol: string): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return DASH;
  if (v >= 0.0001) return `${v.toFixed(6)} ${symbol}`;
  return `${v.toExponential(3)} ${symbol}`;
}

/** A raw string amount at `decimals` → whole tokens. Safe for 1e27. */
export function rawToNumber(raw: string | null | undefined, decimals: number): number | null {
  if (!raw) return null;
  try {
    const n = Number(BigInt(raw)) / 10 ** decimals;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** A wei string → native units (both chains use 18 decimals). */
export function weiToNumber(wei: string | null | undefined): number | null {
  return rawToNumber(wei, 18);
}
