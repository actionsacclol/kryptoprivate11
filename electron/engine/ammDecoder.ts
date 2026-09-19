// pump-amm (PumpSwap) Anchor event decoder.
//
// Companion to pumpDecoder.ts, same rules: discriminators are computed from
// sha256("event:<Name>")[0..8] at runtime rather than hardcoded, the
// guaranteed prefix of each layout is decoded, trailing fields are read only
// if the bytes are there, and an unparseable KNOWN event is a layout error
// (skip + signal drift), never a crash.
//
// The layouts below were learned offline against the 2026-07-25 tape
// (9.9M `tape_amm` records) as engine.ts:975 intends. Provenance:
//
//   • Buy/Sell share one shape: 14 u64 fields, then 7 pubkeys, then trailing
//     fee/volume fields and a bool. Proven by reserve accounting — for
//     consecutive trades on the same pool, the change in poolBaseReserves
//     equals the PREVIOUS event's baseAmount as an exact 64-bit quantity.
//     Reserves are therefore PRE-trade (state before this trade is applied).
//   • CompletePumpAmmMigrationEvent carries mint@40 and pool@136; all 874
//     migration events in the tape resolved to a pool that also appears as
//     the `pool` field of a Buy/Sell event (874/874).
//
// Anything not needed downstream (ATAs, fee recipients, volume accumulators)
// is deliberately left undecoded — see PARSED_PREFIX notes per event.

import { createHash } from 'node:crypto';
import { base58Encode } from '../chain/base58';
import { CPI_EVENT_WRAPPER } from './pumpDecoder';

export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
/** pump-amm global config — an account every swap references. The block
 *  feed filters on THIS rather than the program id: publicnode's
 *  blockSubscribe delivered 0 blocks in 45 s for the program id (three
 *  sockets) and 125 blocks / 39 s for this account (2026-08-30). */
export const PUMP_AMM_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

/** Wrapped SOL — the quote mint for every pump-amm pool we care about. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const DISC_BUY = eventDiscriminator('BuyEvent');
const DISC_SELL = eventDiscriminator('SellEvent');
const DISC_MIGRATE = eventDiscriminator('CompletePumpAmmMigrationEvent');
const DISC_CREATE_POOL = eventDiscriminator('CreatePoolEvent');

/** A pump-amm swap. `base` is the token, `quote` is SOL (lamports).
 *  Reserve fields are the pool state BEFORE this trade is applied. */
export interface AmmSwapEvent {
  kind: 'amm_swap';
  isBuy: boolean;
  timestamp: number;
  /** Tokens out (buy) or tokens in (sell), in base units. */
  baseAmount: bigint;
  /** Lamports in (buy) or lamports out (sell), before fee splitting. */
  quoteAmount: bigint;
  /** Slippage bound the user signed: max quote in (buy) / min quote out (sell). */
  quoteLimit: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  userBaseReserves: bigint;
  userQuoteReserves: bigint;
  lpFeeBps: bigint;
  lpFee: bigint;
  protocolFeeBps: bigint;
  protocolFee: bigint;
  /** Net lamports the user actually paid (buy) or received (sell). */
  userQuoteAmount: bigint;
  pool: string;
  user: string;
  coinCreator: string;
}

/** Bonding curve → AMM graduation. This is the record that links a pump mint
 *  to its PumpSwap pool; without it the swap tape cannot be joined to a mint. */
export interface AmmMigrationEvent {
  kind: 'amm_migration';
  timestamp: number;
  mint: string;
  pool: string;
  user: string;
  bondingCurve: string;
  /** Tokens seeded into the pool (206.9M × 10^6 on the standard migration). */
  mintAmount: bigint;
  /** Lamports seeded into the pool. */
  solAmount: bigint;
  poolMigrationFee: bigint;
}

export type AmmEvent = AmmSwapEvent | AmmMigrationEvent;

class Reader {
  private off = 0;
  constructor(private buf: Buffer) {}
  remaining(): number {
    return this.buf.length - this.off;
  }
  skip(n: number): void {
    if (n > this.remaining()) throw new Error('skip past end of buffer');
    this.off += n;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  pubkey(): string {
    if (this.remaining() < 32) throw new Error('pubkey past end of buffer');
    const v = base58Encode(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
}

export interface AmmDecodeOutcome {
  event: AmmEvent | null;
  /** True when a KNOWN discriminator failed to parse — layout drift. */
  layoutError: boolean;
}

/** Decode one `Program data:` payload emitted by pump-amm. */
export function decodeAmmEventEx(b64: string): AmmDecodeOutcome {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { event: null, layoutError: false };
  }
  if (buf.length < 8) return { event: null, layoutError: false };
  const disc = buf.subarray(0, 8);
  const body = buf.subarray(8);
  try {
    if (disc.equals(DISC_BUY)) return { event: decodeSwap(body, true), layoutError: false };
    if (disc.equals(DISC_SELL)) return { event: decodeSwap(body, false), layoutError: false };
    if (disc.equals(DISC_MIGRATE)) return { event: decodeMigration(body), layoutError: false };
  } catch {
    return { event: null, layoutError: true };
  }
  // CreatePoolEvent and the accumulator/fee events are known but not decoded —
  // nothing downstream needs them, and they must not count as drift.
  if (disc.equals(DISC_CREATE_POOL)) return { event: null, layoutError: false };
  return { event: null, layoutError: false };
}

export function decodeAmmEvent(b64: string): AmmEvent | null {
  return decodeAmmEventEx(b64).event;
}

/**
 * Decode a pump-amm event from the raw data of an emit_cpi inner instruction:
 * `[8-byte Anchor CPI wrapper][8-byte event disc][borsh body]`. Twin of
 * pumpDecoder.decodeCpiEventData — pAMM emits every swap in BOTH places today
 * (emit! log + emit_cpi!, verified 10,360/10,361 on 2026-08-30), and the body
 * layout is identical, so this only strips the wrapper. Anything that is not
 * a wrapped event (a real swap instruction, say) is null, not an error.
 */
export function decodeCpiAmmEventDataEx(data: Buffer): AmmDecodeOutcome {
  if (data.length < 16 || !data.subarray(0, 8).equals(CPI_EVENT_WRAPPER)) return { event: null, layoutError: false };
  return decodeAmmEventEx(data.subarray(8).toString('base64'));
}

export function decodeCpiAmmEventData(data: Buffer): AmmEvent | null {
  return decodeCpiAmmEventDataEx(data).event;
}

// Buy and Sell are field-for-field the same shape; only the semantics of
// baseAmount/quoteAmount/quoteLimit flip. Body offsets (post-discriminator):
//   0 timestamp · 8 baseAmount · 16 quoteLimit · 24 userBase · 32 userQuote
//   40 poolBase · 48 poolQuote · 56 quoteAmount · 64 lpFeeBps · 72 lpFee
//   80 protocolFeeBps · 88 protocolFee · 96 quoteNoLpFee · 104 userQuoteAmount
//   112 pool · 144 user · 176/208/240/272 ATAs+fee recipients · 304 coinCreator
// Trailing fields after 336 (creator fee, volume accumulators, track_volume)
// vary by layout version — 465B and 480B Buy variants both appear in the tape
// — so we stop at coinCreator, which every observed variant contains.
const SWAP_PARSED_PREFIX = 336;

function decodeSwap(body: Buffer, isBuy: boolean): AmmSwapEvent {
  if (body.length < SWAP_PARSED_PREFIX) throw new Error('swap event shorter than parsed prefix');
  const r = new Reader(body);
  const timestamp = Number(r.i64());
  const baseAmount = r.u64();
  const quoteLimit = r.u64();
  const userBaseReserves = r.u64();
  const userQuoteReserves = r.u64();
  const poolBaseReserves = r.u64();
  const poolQuoteReserves = r.u64();
  const quoteAmount = r.u64();
  const lpFeeBps = r.u64();
  const lpFee = r.u64();
  const protocolFeeBps = r.u64();
  const protocolFee = r.u64();
  r.skip(8); // quote amount excluding the LP fee — derivable, not carried
  const userQuoteAmount = r.u64();
  const pool = r.pubkey();
  const user = r.pubkey();
  r.skip(32 * 4); // user base/quote ATAs, protocol fee recipient + its ATA
  const coinCreator = r.pubkey();
  return {
    kind: 'amm_swap',
    isBuy,
    timestamp,
    baseAmount,
    quoteAmount,
    quoteLimit,
    poolBaseReserves,
    poolQuoteReserves,
    userBaseReserves,
    userQuoteReserves,
    lpFeeBps,
    lpFee,
    protocolFeeBps,
    protocolFee,
    userQuoteAmount,
    pool,
    user,
    coinCreator,
  };
}

// Body offsets: 0 user · 32 mint · 64 mintAmount · 72 solAmount
//               80 poolMigrationFee · 88 bondingCurve · 120 timestamp · 128 pool
function decodeMigration(body: Buffer): AmmMigrationEvent {
  const r = new Reader(body);
  const user = r.pubkey();
  const mint = r.pubkey();
  const mintAmount = r.u64();
  const solAmount = r.u64();
  const poolMigrationFee = r.u64();
  const bondingCurve = r.pubkey();
  const timestamp = Number(r.i64());
  const pool = r.pubkey();
  return {
    kind: 'amm_migration',
    timestamp,
    mint,
    pool,
    user,
    bondingCurve,
    mintAmount,
    solAmount,
    poolMigrationFee,
  };
}

/** Pre-trade mid from the reported reserves, in SOL per whole token.
 *  Pump mints are 6-decimal, SOL is 9 — hence the 1e-3 scale.
 *
 *  CAUTION — this is a biased estimator, do not use it to mark a position.
 *  Measured on the 2026-07-25 tape (n=6,799 adjacent trades, 30 graduated
 *  pools), realized execution runs a median 1.22x this value, in the SAME
 *  direction for buys and sells, at trade sizes too small (median 0.05% of
 *  pool) for impact to explain it. The migration record shows why: it seeds
 *  `solAmount` = 85 SOL where the pool's first trade reports
 *  `poolQuoteReserves` = 67.4 SOL — the field tracks trade deltas exactly
 *  (0.9998) but sits below the true quote balance by a per-pool constant we
 *  have not yet identified. Use `executedPriceSol` for anything that books
 *  money; keep this only for relative/curve-shape work.
 *
 *  Sanity anchor: at migration the mid reads 3.26e-7 SOL/token = ~326 SOL
 *  fully diluted, which is the well-known ~$69k pump graduation cap — so the
 *  field is right in scale, and only the constant is missing. */
export function poolPriceSol(
  poolQuoteReserves: bigint,
  poolBaseReserves: bigint,
  baseDecimals = 6,
): number {
  if (poolBaseReserves === 0n) return 0;
  const scale = 10 ** (baseDecimals - 9);
  return (Number(poolQuoteReserves) / Number(poolBaseReserves)) * scale;
}

/** Price a swap actually cleared at, in SOL per whole token — net lamports
 *  the user paid/received over tokens moved. Exact by construction: it needs
 *  no interpretation of the reserve fields. This is the one to mark with. */
export function executedPriceSol(e: AmmSwapEvent, baseDecimals = 6): number {
  if (e.baseAmount === 0n) return 0;
  const scale = 10 ** (baseDecimals - 9);
  return (Number(e.userQuoteAmount) / Number(e.baseAmount)) * scale;
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

export interface DecodedAmmLogs {
  events: AmmEvent[];
  layoutErrors: number;
}

/** Extract every decodable pump-amm event from a transaction's log lines. */
export function decodeAmmLogsEx(logs: string[]): DecodedAmmLogs {
  const events: AmmEvent[] = [];
  let layoutErrors = 0;
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const r = decodeAmmEventEx(line.slice(PROGRAM_DATA_PREFIX.length));
    if (r.event) events.push(r.event);
    else if (r.layoutError) layoutErrors++;
  }
  return { events, layoutErrors };
}

export function decodeAmmLogs(logs: string[]): AmmEvent[] {
  return decodeAmmLogsEx(logs).events;
}
