// Meteora DBC curve progress, read straight from the chain.
//
// ─── Why account reads rather than events ─────────────────────────────
//
// The Graduating column needs progress for MANY pools at once. Events only
// arrive for pools we are subscribed to (see dbcWatcher.ts), and a
// `getProgramAccounts` sweep is off the table — measured on mainnet
// 2026-08-24, the DBC program owns **2,172,559 accounts** and a bare count
// took 20 seconds.
//
// Reading specific accounts is the cheap path: `getMultipleAccounts` takes
// 100 addresses per call, so a whole column costs one request. The candidate
// pool list comes from GeckoTerminal, which indexes the `meteora-dbc` dex.
//
// ─── Layouts ──────────────────────────────────────────────────────────
//
// Offsets computed from the program's own on-chain Anchor IDL
// (`dynamic_bonding_curve` v0.1.10) by summing field sizes, then verified
// against a live pool: the progress this file derives (15.50%) matched the
// figure the event decoder produced from EvtSwap2 for the same pool moments
// earlier (15.30%), the difference being trades that landed in between. Two
// independent derivations agreeing is the check that matters.
//
//   VirtualPool  424 bytes:  72 config · 136 baseMint · 232 baseReserve
//                            240 quoteReserve · 304 poolType · 305 isMigrated
//   PoolConfig  1048 bytes: 264 migrationQuoteThreshold
//
// THE THRESHOLD IS PER-CONFIG. Observed values range from 0.000499 SOL to
// 66.04 SOL across real pools. Never hardcode it; that is exactly why the
// config account is read at all.

import { getMultipleAccountsRaw } from '../chain/rpcClient';
import { base58Encode } from '../chain/base58';

const VIRTUAL_POOL_SIZE = 424;
const POOL_CONFIG_MIN_SIZE = 272;

const OFF_CONFIG = 72;
const OFF_BASE_MINT = 136;
const OFF_BASE_RESERVE = 232;
const OFF_QUOTE_RESERVE = 240;
const OFF_POOL_TYPE = 304;
const OFF_IS_MIGRATED = 305;
const OFF_MIGRATION_QUOTE_THRESHOLD = 264;

export interface DbcPoolState {
  pool: string;
  config: string;
  baseMint: string;
  baseReserve: bigint;
  /** Quote (lamports, when the quote mint is SOL) accumulated so far. */
  quoteReserve: bigint;
  poolType: number;
  isMigrated: boolean;
}

/**
 * Config → migration threshold, cached for the process lifetime.
 *
 * A DBC config is immutable in the fields we read, and a launchpad reuses one
 * config across thousands of pools — so this cache turns "read a threshold
 * for every pool" into "read a threshold once per launchpad".
 */
const thresholdCache = new Map<string, bigint>();

export function cachedThresholdCount(): number {
  return thresholdCache.size;
}

/** Parse a VirtualPool account. Returns null when the size is not what the
 *  IDL says — a layout change must yield nothing, not nonsense. */
function parsePool(pool: string, data: Buffer): DbcPoolState | null {
  if (data.length < VIRTUAL_POOL_SIZE) return null;
  try {
    return {
      pool,
      config: base58Encode(data.subarray(OFF_CONFIG, OFF_CONFIG + 32)),
      baseMint: base58Encode(data.subarray(OFF_BASE_MINT, OFF_BASE_MINT + 32)),
      baseReserve: data.readBigUInt64LE(OFF_BASE_RESERVE),
      quoteReserve: data.readBigUInt64LE(OFF_QUOTE_RESERVE),
      poolType: data.readUInt8(OFF_POOL_TYPE),
      isMigrated: data.readUInt8(OFF_IS_MIGRATED) !== 0,
    };
  } catch {
    return null;
  }
}

/** Read many DBC pool accounts in as few requests as possible. */
export async function readPools(httpUrl: string, pools: string[]): Promise<Map<string, DbcPoolState>> {
  const out = new Map<string, DbcPoolState>();
  const unique = [...new Set(pools.filter(Boolean))];
  if (!unique.length) return out;

  const res = await getMultipleAccountsRaw(httpUrl, unique);
  if (!res.ok || !res.data) return out;
  for (const [addr, data] of res.data) {
    const parsed = parsePool(addr, data);
    if (parsed) out.set(addr, parsed);
  }
  return out;
}

/** Migration thresholds for a set of configs, using and filling the cache. */
export async function readThresholds(httpUrl: string, configs: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const missing: string[] = [];
  for (const c of new Set(configs.filter(Boolean))) {
    const hit = thresholdCache.get(c);
    if (hit !== undefined) out.set(c, hit);
    else missing.push(c);
  }
  if (!missing.length) return out;

  const res = await getMultipleAccountsRaw(httpUrl, missing);
  if (!res.ok || !res.data) return out;
  for (const [addr, data] of res.data) {
    if (data.length < POOL_CONFIG_MIN_SIZE) continue;
    try {
      const t = data.readBigUInt64LE(OFF_MIGRATION_QUOTE_THRESHOLD);
      if (t > 0n) {
        thresholdCache.set(addr, t);
        out.set(addr, t);
      }
    } catch {
      /* a config we cannot parse simply yields no progress for its pools */
    }
  }
  return out;
}

export interface DbcProgress extends DbcPoolState {
  /** 0..100, or null when the config's threshold could not be read. */
  progressPct: number | null;
  migrationThreshold: bigint | null;
}

/**
 * Exact curve progress for a batch of pools. Two RPC calls in the common
 * case: one for the pools, one for any config not already cached.
 *
 * A pool whose threshold is unknown gets `progressPct: null` rather than an
 * estimate — the thresholds observed in the wild span five orders of
 * magnitude, so a default would be wrong far more often than right.
 */
export async function progressFor(httpUrl: string, pools: string[]): Promise<Map<string, DbcProgress>> {
  const states = await readPools(httpUrl, pools);
  if (!states.size) return new Map();

  const thresholds = await readThresholds(httpUrl, [...states.values()].map((s) => s.config));

  const out = new Map<string, DbcProgress>();
  for (const [addr, s] of states) {
    const t = thresholds.get(s.config) ?? null;
    const progressPct =
      t !== null && t > 0n
        ? Math.max(0, Math.min(100, (Number(s.quoteReserve) / Number(t)) * 100))
        : null;
    out.set(addr, { ...s, migrationThreshold: t, progressPct: s.isMigrated ? 100 : progressPct });
  }
  return out;
}

/** Test seam. */
export function _clearCache(): void {
  thresholdCache.clear();
}
