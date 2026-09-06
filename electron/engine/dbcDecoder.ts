// Meteora Dynamic Bonding Curve decoder.
//
// DBC is the shared launch rail behind LetsBonk, Believe and several other
// launchpads, so one decoder covers all of them. Jupiter tags these tokens
// `met-dbc`.
//
// ─── Why this is not shaped like pumpDecoder.ts ───────────────────────
//
// pump.fun uses Anchor's `emit!`, which writes each event into a
// `Program data:` LOG LINE. That is why the pump decoder can work purely off
// `logsSubscribe` output.
//
// DBC uses `emit_cpi!` instead. The event is not a log at all — it is the
// instruction data of a self-CPI, reachable only through a transaction's
// INNER INSTRUCTIONS. Verified against mainnet on 2026-08-24: DBC
// transactions carry no decodable `Program data:` line, and the event bytes
// sit in an inner instruction prefixed with Anchor's event-CPI marker
// `e445a52e51cb9a1d`.
//
// The practical consequence is the reason the terminal does not run a
// whole-program DBC firehose: seeing every DBC trade would mean a
// `getTransaction` call per trade, which rate-limits a free RPC instantly.
// Instead the feed subscribes to a SPECIFIC POOL (logsSubscribe supports a
// `mentions` filter) for the token the user has open, and fetches only those
// transactions. See `feed.ts` / the pool tape wiring.
//
// ─── Layouts ──────────────────────────────────────────────────────────
//
// Every layout below is derived from the program's OWN on-chain Anchor IDL
// (`dynamic_bonding_curve` v0.1.10, read from the IDL account at
// B8daPXJqt9sv94r1s9GM13sNH6CSak6UtYHV2yyDGbtf) and then verified byte-for-byte
// against harvested mainnet events — see test/fixtures/dbc-events.json and
// test/dbcdecoder.test.mjs. Nothing here is guessed.

import { base58Decode, base58Encode } from './base58';

export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

/** sha256("anchor:event")[0..8] — Anchor's event-CPI instruction prefix. */
const EVENT_CPI_DISC = Buffer.from('e445a52e51cb9a1d', 'hex');

// Event discriminators, straight from the IDL.
const DISC_INIT_POOL = Buffer.from([228, 50, 246, 85, 203, 66, 134, 37]);
const DISC_SWAP = Buffer.from([27, 60, 21, 213, 138, 170, 187, 147]);
const DISC_SWAP2 = Buffer.from([189, 66, 51, 168, 38, 80, 117, 153]);
const DISC_CURVE_COMPLETE = Buffer.from([229, 231, 86, 84, 156, 134, 75, 24]);

/** Exact payload sizes (after the 8-byte event discriminator). A mismatch is
 *  layout drift, which must trip the breaker rather than decode garbage. */
const LEN_INIT_POOL = 137;
const LEN_SWAP = 154;
const LEN_SWAP2 = 179;
const LEN_CURVE_COMPLETE = 80;

/** Lamports per SOL. DBC allows other quote mints, but every launchpad the
 *  terminal surfaces (LetsBonk, Believe, Boop) quotes in SOL. A non-SOL pool
 *  would price wrongly here, so callers that cannot confirm a SOL quote
 *  should not use the price helpers below. */
const QUOTE_DECIMALS = 9;

// ── Event shapes ──────────────────────────────────────────────────────

export interface DbcInitPoolEvent {
  kind: 'dbc_init_pool';
  pool: string;
  config: string;
  creator: string;
  baseMint: string;
  poolType: number;
  activationPoint: bigint;
}

export interface DbcSwapEvent {
  kind: 'dbc_swap';
  pool: string;
  config: string;
  /** True when quote (SOL) went in and base (the token) came out. */
  isBuy: boolean;
  /** Amount of the INPUT token, base units. */
  amountIn: bigint;
  /** Amount of the OUTPUT token, base units. */
  outputAmount: bigint;
  /** Q64.64 sqrt price after the swap. */
  nextSqrtPrice: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  /** Unix seconds, as the program saw it. */
  timestamp: bigint;
  /** Swap2 only: quote accumulated so far, and the graduation threshold.
   *  Together these give exact curve progress. Null on the v1 event. */
  quoteReserve: bigint | null;
  migrationThreshold: bigint | null;
}

export interface DbcCurveCompleteEvent {
  kind: 'dbc_curve_complete';
  pool: string;
  config: string;
  baseReserve: bigint;
  /**
   * Quote (lamports, when the quote mint is SOL) held at graduation.
   *
   * NOT a protocol constant. The migration threshold is set per DBC config:
   * of the harvested mainnet fixtures two graduate at exactly 12.000 SOL and
   * one at 0.000499. Never hardcode a threshold — read it from EvtSwap2's
   * `migrationThreshold`, which exists precisely because it varies.
   */
  quoteReserve: bigint;
}

export type DbcEvent = DbcInitPoolEvent | DbcSwapEvent | DbcCurveCompleteEvent;

export interface DbcDecodeOutcome {
  event: DbcEvent | null;
  /** True when a KNOWN discriminator failed to parse — layout drift. */
  layoutError: boolean;
}

// ── Reading helpers ───────────────────────────────────────────────────

const PUBKEY_LEN = 32;

function pubkey(b: Buffer, off: number): string {
  return base58Encode(b.subarray(off, off + PUBKEY_LEN));
}

function u128le(b: Buffer, off: number): bigint {
  const lo = b.readBigUInt64LE(off);
  const hi = b.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}

// ── Decoders ──────────────────────────────────────────────────────────

function decodeInitPool(p: Buffer): DbcInitPoolEvent {
  return {
    kind: 'dbc_init_pool',
    pool: pubkey(p, 0),
    config: pubkey(p, 32),
    creator: pubkey(p, 64),
    baseMint: pubkey(p, 96),
    poolType: p.readUInt8(128),
    activationPoint: p.readBigUInt64LE(129),
  };
}

/**
 * EvtSwap (v1). Offsets after the discriminator:
 *   0   pool           32
 *   32  config         32
 *   64  tradeDirection  1   (1 = quote→base = BUY; verified on mainnet)
 *   65  hasReferral     1
 *   66  params.amountIn            8
 *   74  params.minimumAmountOut    8
 *   82  result.actualInputAmount   8
 *   90  result.outputAmount        8
 *   98  result.nextSqrtPrice      16 (u128)
 *   114 result.tradingFee          8
 *   122 result.protocolFee         8
 *   130 result.referralFee         8
 *   138 amountIn                   8
 *   146 currentTimestamp           8
 */
function decodeSwap(p: Buffer): DbcSwapEvent {
  return {
    kind: 'dbc_swap',
    pool: pubkey(p, 0),
    config: pubkey(p, 32),
    isBuy: p.readUInt8(64) === 1,
    amountIn: p.readBigUInt64LE(138),
    outputAmount: p.readBigUInt64LE(90),
    nextSqrtPrice: u128le(p, 98),
    tradingFee: p.readBigUInt64LE(114),
    protocolFee: p.readBigUInt64LE(122),
    timestamp: p.readBigUInt64LE(146),
    quoteReserve: null,
    migrationThreshold: null,
  };
}

/**
 * EvtSwap2. Same head, then a wider params/result pair, and — the useful
 * part — the running quote reserve and the migration threshold, which give
 * exact curve progress without a separate account read.
 *   64  tradeDirection  1
 *   65  hasReferral     1
 *   66  params.amount0            8
 *   74  params.amount1            8
 *   82  params.swapMode           1
 *   83  result.includedFeeInput   8
 *   91  result.excludedFeeInput   8
 *   99  result.amountLeft         8
 *   107 result.outputAmount       8
 *   115 result.nextSqrtPrice     16
 *   131 result.tradingFee         8
 *   139 result.protocolFee        8
 *   147 result.referralFee        8
 *   155 quoteReserveAmount        8
 *   163 migrationThreshold        8
 *   171 currentTimestamp          8
 */
function decodeSwap2(p: Buffer): DbcSwapEvent {
  return {
    kind: 'dbc_swap',
    pool: pubkey(p, 0),
    config: pubkey(p, 32),
    isBuy: p.readUInt8(64) === 1,
    amountIn: p.readBigUInt64LE(83), // includedFeeInputAmount
    outputAmount: p.readBigUInt64LE(107),
    nextSqrtPrice: u128le(p, 115),
    tradingFee: p.readBigUInt64LE(131),
    protocolFee: p.readBigUInt64LE(139),
    timestamp: p.readBigUInt64LE(171),
    quoteReserve: p.readBigUInt64LE(155),
    migrationThreshold: p.readBigUInt64LE(163),
  };
}

function decodeCurveComplete(p: Buffer): DbcCurveCompleteEvent {
  return {
    kind: 'dbc_curve_complete',
    pool: pubkey(p, 0),
    config: pubkey(p, 32),
    baseReserve: p.readBigUInt64LE(64),
    quoteReserve: p.readBigUInt64LE(72),
  };
}

/**
 * Decode one inner-instruction payload from the DBC program.
 *
 * `data` is the raw instruction data: the Anchor event-CPI marker, then the
 * event discriminator, then the borsh body. Anything that is not an event
 * CPI (a real nested instruction, for example) returns null WITHOUT flagging
 * drift — those are expected and routine.
 */
export function decodeDbcEventEx(data: Uint8Array): DbcDecodeOutcome {
  const buf = Buffer.from(data);
  if (buf.length < 16) return { event: null, layoutError: false };
  if (!buf.subarray(0, 8).equals(EVENT_CPI_DISC)) return { event: null, layoutError: false };

  const disc = buf.subarray(8, 16);
  const payload = buf.subarray(16);

  const known: Array<[Buffer, number, (p: Buffer) => DbcEvent]> = [
    [DISC_SWAP, LEN_SWAP, decodeSwap],
    [DISC_SWAP2, LEN_SWAP2, decodeSwap2],
    [DISC_INIT_POOL, LEN_INIT_POOL, decodeInitPool],
    [DISC_CURVE_COMPLETE, LEN_CURVE_COMPLETE, decodeCurveComplete],
  ];

  for (const [d, len, fn] of known) {
    if (!disc.equals(d)) continue;
    // A known event whose size moved is layout drift, not a parse we should
    // attempt — decoding a shifted buffer produces confident nonsense.
    if (payload.length !== len) return { event: null, layoutError: true };
    try {
      return { event: fn(payload), layoutError: false };
    } catch {
      return { event: null, layoutError: true };
    }
  }
  // A DBC event we do not model (fee claims, config changes, metadata). Not
  // drift — there are ~20 of them and none affect trading.
  return { event: null, layoutError: false };
}

export function decodeDbcEvent(data: Uint8Array): DbcEvent | null {
  return decodeDbcEventEx(data).event;
}

/** Decode from the base58 form `getTransaction` returns for instruction data. */
export function decodeDbcEventB58(data: string): DbcDecodeOutcome {
  try {
    return decodeDbcEventEx(base58Decode(data));
  } catch {
    return { event: null, layoutError: false };
  }
}

// ── Derived values ────────────────────────────────────────────────────

/**
 * Executed price in SOL per whole token.
 *
 * Derived from the amounts actually exchanged rather than from
 * `nextSqrtPrice`, for the same reason `ammDecoder.executedPriceSol` does:
 * the sqrt price is a Q64.64 figure in raw base/quote units whose decimal
 * scaling depends on the pool config, whereas in/out amounts are unambiguous.
 * Returns 0 when the swap cannot be priced, which callers must treat as
 * "unknown" — the tape drops non-positive prices.
 */
export function executedPriceSol(e: DbcSwapEvent, baseDecimals = 6): number {
  const quoteIn = e.isBuy ? e.amountIn : e.outputAmount;
  const baseOut = e.isBuy ? e.outputAmount : e.amountIn;
  if (baseOut === 0n) return 0;
  const sol = Number(quoteIn) / 10 ** QUOTE_DECIMALS;
  const tokens = Number(baseOut) / 10 ** baseDecimals;
  if (!(tokens > 0)) return 0;
  return sol / tokens;
}

/** SOL that changed hands in this swap. */
export function swapSol(e: DbcSwapEvent): number {
  const quote = e.isBuy ? e.amountIn : e.outputAmount;
  return Number(quote) / 10 ** QUOTE_DECIMALS;
}

/** Whole tokens that changed hands. */
export function swapTokens(e: DbcSwapEvent, baseDecimals = 6): number {
  const base = e.isBuy ? e.outputAmount : e.amountIn;
  return Number(base) / 10 ** baseDecimals;
}

/**
 * Curve completion, 0..100. Only EvtSwap2 carries the numbers for this;
 * the v1 event returns null rather than an estimate.
 */
export function curveProgressPct(e: DbcSwapEvent): number | null {
  if (e.quoteReserve === null || e.migrationThreshold === null) return null;
  if (e.migrationThreshold === 0n) return null;
  const pct = (Number(e.quoteReserve) / Number(e.migrationThreshold)) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}
