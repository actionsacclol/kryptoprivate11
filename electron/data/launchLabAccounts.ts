// Raydium LaunchLab curve progress, read straight from the chain.
//
// Same shape and the same reasons as dbcAccounts.ts: the Graduating column
// needs progress for MANY pools at once, `getMultipleAccounts` takes 100
// addresses per call, and GeckoTerminal supplies the candidate pool list from
// its `raydium-launchlab` dex.
//
// ─── The layout, and how it was established ───────────────────────────
//
// NOT copied from documentation. A live trade event was decoded first (see
// launchLabDecoder.ts), then the pool account was read and searched for the
// exact u64 values that event reported. Every field below is where those
// values were found, confirmed across 10 pools on 2026-08-24:
//
//   16  authBump      u8    — 250 on every pool seen
//   17  status        u8    — 0 while funding, 2 once migrated
//   18  baseDecimals  u8
//   19  quoteDecimals u8    — 9 for SOL-quoted pools, 6 for USDC/USDT
//   29  totalBaseSell u64   — the pool's OWN migration target
//   37  virtualBase   u64
//   45  virtualQuote  u64
//   53  realBase      u64   — progress numerator
//   61  realQuote     u64
//   205 baseMint      pubkey
//   237 quoteMint     pubkey
//
// The status byte correlated perfectly with progress: every pool reading 2
// was at 100%, every pool reading 0 was below it (10/10).
//
// ─── Not every LaunchLab pool is quoted in SOL ────────────────────────
//
// Measured in the same sample: 3 of 10 pools quoted in USDC or USDT. Their
// reserves are therefore NOT lamports, and treating them as such would put a
// wrong number on a row a user might trade. `isSolQuoted` says which is
// which, and the caller is expected to honour it.

import { base58Encode } from '../chain/base58';
import { getMultipleAccountsRaw } from '../chain/rpcClient';

/** Raydium LaunchLab program — pool accounts are owned by it. */
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

const WSOL = 'So11111111111111111111111111111111111111112';

/** Every pool account seen was exactly this size. A different size means a
 *  different layout, so those are skipped rather than misread. */
const POOL_LEN = 429;

const OFF = {
  status: 17,
  baseDecimals: 18,
  quoteDecimals: 19,
  totalBaseSell: 29,
  virtualBase: 37,
  virtualQuote: 45,
  realBase: 53,
  realQuote: 61,
  baseMint: 205,
  quoteMint: 237,
} as const;

/** Observed status values. Anything else is treated as "not tradeable here". */
const STATUS_FUNDING = 0;
const STATUS_MIGRATED = 2;

export interface LaunchLabPoolState {
  pool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** False for USDC/USDT-quoted pools, whose reserves are not lamports. */
  isSolQuoted: boolean;
  totalBaseSell: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  status: number;
  isMigrated: boolean;
  /** 0..100, or null when the pool reports no target to divide by. */
  progressPct: number | null;
}

/** Parse one pool account. Exported for tests — it is pure. */
export function parsePoolAccount(pool: string, data: Buffer): LaunchLabPoolState | null {
  if (data.length !== POOL_LEN) return null;
  try {
    const totalBaseSell = data.readBigUInt64LE(OFF.totalBaseSell);
    const realBase = data.readBigUInt64LE(OFF.realBase);
    const quoteMint = base58Encode(data.subarray(OFF.quoteMint, OFF.quoteMint + 32));
    const status = data.readUInt8(OFF.status);
    // Progress divides by the pool's OWN target. Hardcoding a migration
    // threshold is the trap that has already cost this codebase a feature —
    // DBC thresholds spanned five orders of magnitude.
    const progressPct =
      totalBaseSell > 0n
        ? Math.max(0, Math.min(100, Number((realBase * 10_000n) / totalBaseSell) / 100))
        : null;
    return {
      pool,
      baseMint: base58Encode(data.subarray(OFF.baseMint, OFF.baseMint + 32)),
      quoteMint,
      baseDecimals: data.readUInt8(OFF.baseDecimals),
      quoteDecimals: data.readUInt8(OFF.quoteDecimals),
      isSolQuoted: quoteMint === WSOL,
      totalBaseSell,
      virtualBase: data.readBigUInt64LE(OFF.virtualBase),
      virtualQuote: data.readBigUInt64LE(OFF.virtualQuote),
      realBase,
      realQuote: data.readBigUInt64LE(OFF.realQuote),
      status,
      // Read the status byte rather than inferring migration from 100%: a
      // pool can sit at the threshold for a while before it actually moves.
      isMigrated: status === STATUS_MIGRATED,
      progressPct,
    };
  } catch {
    return null;
  }
}

/**
 * Read curve state for many pools at once.
 *
 * A pool that cannot be read, or that is not a LaunchLab pool of the expected
 * size, is simply absent from the map — the caller then has an unknown, and
 * an unknown must not be ranked as a zero.
 */
export async function progressFor(httpUrl: string, pools: string[]): Promise<Map<string, LaunchLabPoolState>> {
  const out = new Map<string, LaunchLabPoolState>();
  const unique = [...new Set(pools.filter(Boolean))];
  if (!unique.length) return out;
  const res = await getMultipleAccountsRaw(httpUrl, unique);
  if (!res.ok || !res.data) return out;
  for (const [pool, data] of res.data) {
    const state = parsePoolAccount(pool, data);
    if (state) out.set(pool, state);
  }
  return out;
}

/** Status names, for a tooltip. Unknown codes say so rather than guessing. */
export function statusLabel(status: number): string {
  if (status === STATUS_FUNDING) return 'On the curve';
  if (status === STATUS_MIGRATED) return 'Migrated';
  return `Unknown status ${status}`;
}
