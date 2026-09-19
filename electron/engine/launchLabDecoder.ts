// Raydium LaunchLab decoder — the rail behind letsbonk.fun.
//
// ─── Why this one is cheap, and DBC is not ────────────────────────────
//
// The three launch rails this app touches emit their events differently, and
// that difference decides what a live feed costs:
//
//   pump.fun   `emit!`      → a `Program data:` LOG line. One logsSubscribe
//                             sees every trade, free.
//   Meteora DBC `emit_cpi!` → an inner instruction only. A whole-program feed
//                             would need a getTransaction PER TRADE, so the
//                             terminal watches DBC pools one at a time.
//   LaunchLab   BOTH        → measured 2026-08-24: every sampled transaction
//                             carried an emit_cpi event instruction AND a
//                             `Program data:` line, and the log line is byte
//                             for byte the event-CPI payload from offset 8.
//
// So LaunchLab can be taped from logs alone, like pump.fun. That is the whole
// reason this decoder exists in this shape.
//
// Its firehose is also far healthier than pump's: 57 of 60 recent program
// signatures were successful (95%), against pump's 4 in 100.
//
// ─── What the logs do NOT give you ────────────────────────────────────
//
// The event carries the POOL, not the mint. A log subscription never sees an
// account list, so mapping pool → mint needs one lookup, cached — the same
// shape as the existing PumpSwap `registerPool` path. `poolStateFor` is not
// derivable here, so the caller resolves it once and remembers.

import { base58Encode } from '../chain/base58';

/** Raydium LaunchLab. Verified against mainnet 2026-08-24. */
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

/** Anchor event discriminator for LaunchLab's TradeEvent. */
const TRADE_EVENT_DISC = 'bddb7fd34ee661ee';

/** Anchor's event-CPI marker, which prefixes the inner-instruction copy. */
const EVENT_CPI_DISC = 'e445a52e51cb9a1d';

/**
 * Payload sizes, both measured rather than assumed.
 *
 * A `Program data:` line is `eventDisc(8) + body(139)`. The emit_cpi variant
 * prefixes the CPI marker, so it is 8 bytes longer. Both are accepted, and a
 * length that is neither is skipped rather than parsed into nonsense.
 */
const BODY_LEN = 139;
const LOG_LEN = 8 + BODY_LEN;
const CPI_LEN = 8 + LOG_LEN;

const LOG_PREFIX = 'Program data: ';

export interface LaunchLabTradeEvent {
  kind: 'trade';
  /** Pool state account. The mint is NOT in the event — resolve and cache it. */
  pool: string;
  /** True for BuyExactIn (quote in, base out). */
  isBuy: boolean;
  /** Amount the trader put IN: lamports on a buy, token base units on a sell. */
  amountIn: bigint;
  /** Amount the trader got OUT: token base units on a buy, lamports on a sell. */
  amountOut: bigint;
  /** Curve state after this trade — what progress is computed from. */
  realBaseAfter: bigint;
  realQuoteAfter: bigint;
  realBaseBefore: bigint;
  realQuoteBefore: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  /** Total base the curve will ever sell. Per-pool config, never assumed. */
  totalBaseSell: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  /** Raw pool status byte, passed through rather than interpreted. */
  poolStatus: number;
}

/**
 * Decode one event payload.
 *
 * Accepts either the log form or the emit_cpi form; anything else returns
 * null. The field order below was verified field by field against chain:
 * `amountIn` matched the trade instruction's own `amount_in` argument in 6
 * of 6 sampled transactions, and the direction byte was 0 on three buys and
 * 1 on three sells.
 */
export function decodeTradeEvent(payload: Buffer): LaunchLabTradeEvent | null {
  let body: Buffer;
  if (payload.length === CPI_LEN && payload.subarray(0, 8).toString('hex') === EVENT_CPI_DISC) {
    if (payload.subarray(8, 16).toString('hex') !== TRADE_EVENT_DISC) return null;
    body = payload.subarray(16);
  } else if (payload.length === LOG_LEN) {
    if (payload.subarray(0, 8).toString('hex') !== TRADE_EVENT_DISC) return null;
    body = payload.subarray(8);
  } else {
    return null;
  }
  if (body.length !== BODY_LEN) return null;

  try {
    const u64 = (i: number): bigint => body.readBigUInt64LE(32 + i * 8);
    return {
      kind: 'trade',
      pool: base58Encode(body.subarray(0, 32)),
      totalBaseSell: u64(0),
      virtualBase: u64(1),
      virtualQuote: u64(2),
      realBaseBefore: u64(3),
      realQuoteBefore: u64(4),
      realBaseAfter: u64(5),
      realQuoteAfter: u64(6),
      amountIn: u64(7),
      amountOut: u64(8),
      protocolFee: u64(9),
      platformFee: u64(10),
      creatorFee: u64(11),
      shareFee: u64(12),
      // 32 + 13*8 = 136, leaving three trailing bytes: direction, status, and
      // one more that has read 1 on every sample seen. Only the first two are
      // interpreted; guessing at the third would be inventing meaning.
      isBuy: body[136] === 0,
      poolStatus: body[137],
    };
  } catch {
    return null;
  }
}

/**
 * Every LaunchLab trade in a transaction's logs.
 *
 * Built for `logsSubscribe`, which hands over log lines and nothing else. A
 * line that does not decode is skipped silently — other programs write
 * `Program data:` lines too, and a foreign event is not an error.
 */
export function decodeLogs(logs: string[]): LaunchLabTradeEvent[] {
  const out: LaunchLabTradeEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(LOG_PREFIX)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(LOG_PREFIX.length), 'base64');
    } catch {
      continue;
    }
    const ev = decodeTradeEvent(buf);
    if (ev) out.push(ev);
  }
  return out;
}

/** True when these logs came from a LaunchLab invocation at all. */
export function touchesLaunchLab(logs: string[]): boolean {
  return logs.some((l) => l.includes(LAUNCHLAB_PROGRAM));
}

/**
 * Curve progress, 0..100, or null.
 *
 * Computed from the pool's OWN `totalBaseSell` rather than a hardcoded
 * migration threshold. That constant is per-config on every launch rail this
 * app has touched — DBC thresholds spanned five orders of magnitude — and
 * baking one in is the trap that has already cost this codebase a feature.
 * If the event does not carry a sane total, this returns null and the UI
 * shows an em dash.
 */
export function curveProgressPct(ev: LaunchLabTradeEvent): number | null {
  if (ev.totalBaseSell <= 0n) return null;
  if (ev.realBaseAfter < 0n) return null;
  const pct = Number((ev.realBaseAfter * 10_000n) / ev.totalBaseSell) / 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Price in lamports per whole token, from the trade itself.
 *
 * Uses the amounts actually exchanged rather than the reserve ratio: the
 * reserves are a curve position, the amounts are what somebody paid.
 */
export function priceLamportsPerToken(ev: LaunchLabTradeEvent, baseDecimals: number): number | null {
  const lamports = ev.isBuy ? ev.amountIn : ev.amountOut;
  const tokens = ev.isBuy ? ev.amountOut : ev.amountIn;
  if (lamports <= 0n || tokens <= 0n) return null;
  const price = Number(lamports) / (Number(tokens) / 10 ** baseDecimals);
  return Number.isFinite(price) ? price : null;
}
