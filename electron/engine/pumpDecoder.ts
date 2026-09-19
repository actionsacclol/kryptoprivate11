// Pump.fun Anchor event decoder.
//
// Pump's program emits Anchor events as `Program data: <base64>` log lines.
// An Anchor event is: 8-byte discriminator = sha256("event:<Name>")[0..8],
// followed by the borsh-serialized fields. We compute the discriminators
// from the spec at runtime instead of hardcoding magic bytes, and we parse
// layouts *defensively*: the guaranteed prefix of each event is decoded and
// any newer trailing fields are read only if the bytes are actually there.
// Per research: the account/event layout has moved ahead of published
// examples before — fixture tests in /test pin the current shape, and an
// unknown layout must mean "skip event", never "crash the engine".

import { createHash } from 'node:crypto';
import { base58Encode } from '../chain/base58';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const DISC_CREATE = eventDiscriminator('CreateEvent');
const DISC_TRADE = eventDiscriminator('TradeEvent');
const DISC_COMPLETE = eventDiscriminator('CompleteEvent');

export interface PumpCreateEvent {
  kind: 'create';
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string; // falls back to `user` on older layouts
  virtualTokenReserves: bigint | null;
  virtualSolReserves: bigint | null;
}

export interface PumpTradeEvent {
  kind: 'trade';
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** The token's creator, from the event's trailing fields. Null on the older
   *  (shorter) event that predates the field. Used to identify the creator-vault
   *  slot during tx-template learning without any external lookup. */
  creator: string | null;
}

export interface PumpCompleteEvent {
  kind: 'complete';
  user: string;
  mint: string;
  bondingCurve: string;
}

export type PumpEvent = PumpCreateEvent | PumpTradeEvent | PumpCompleteEvent;

class Reader {
  private off = 0;
  constructor(private buf: Buffer) {}
  remaining(): number {
    return this.buf.length - this.off;
  }
  u8(): number {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
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
    const v = base58Encode(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
  string(): string {
    const len = this.buf.readUInt32LE(this.off);
    this.off += 4;
    if (len > this.remaining()) throw new Error('string length past end of buffer');
    const v = this.buf.subarray(this.off, this.off + len).toString('utf8');
    this.off += len;
    return v;
  }
}

export interface DecodeOutcome {
  event: PumpEvent | null;
  /** True when a KNOWN discriminator failed to parse — layout drift.
   *  Unknown discriminators are normal (other pump events) and don't count. */
  layoutError: boolean;
}

/** Decode one `Program data:` payload. */
export function decodeEventDataEx(b64: string): DecodeOutcome {
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
    if (disc.equals(DISC_CREATE)) return { event: decodeCreate(body), layoutError: false };
    if (disc.equals(DISC_TRADE)) return { event: decodeTrade(body), layoutError: false };
    if (disc.equals(DISC_COMPLETE)) return { event: decodeComplete(body), layoutError: false };
  } catch {
    // A known event we can no longer parse — the fail-closed drift signal.
    return { event: null, layoutError: true };
  }
  return { event: null, layoutError: false };
}

/** Back-compat helper: decode returning just the event (tests use this). */
export function decodeEventData(b64: string): PumpEvent | null {
  return decodeEventDataEx(b64).event;
}

/**
 * Anchor's emit_cpi! wrapper discriminator (sha256("anchor:event")[0..8]).
 *
 * Around 2026-08 pump moved TradeEvent (and CreateEvent/CompleteEvent) OUT of
 * `Program data:` logs and into a self-CPI inner instruction, whose data is
 * `[this 8-byte wrapper][8-byte event disc][borsh body]`. The body layout is
 * UNCHANGED — same fields our decoders already read — so once the wrapper is
 * stripped the existing decodeEventData handles it verbatim. This is why the
 * log-only decoder suddenly saw zero trades: the events simply moved.
 */
export const CPI_EVENT_WRAPPER = Buffer.from('e445a52e51cb9a1d', 'hex');

/**
 * Decode a pump event from the raw data of an emit_cpi inner instruction.
 * Returns null when the instruction is not a wrapped pump event.
 */
export function decodeCpiEventData(data: Buffer): PumpEvent | null {
  return decodeCpiEventDataEx(data).event;
}

/** As decodeCpiEventData, but reports layout drift the same way the log path
 *  does, so a block-feed delivery can feed the decoder-drift breaker. A
 *  non-wrapper instruction (a real pump Buy/Sell ix, say) is not an error. */
export function decodeCpiEventDataEx(data: Buffer): DecodeOutcome {
  if (data.length < 16 || !data.subarray(0, 8).equals(CPI_EVENT_WRAPPER)) return { event: null, layoutError: false };
  return decodeEventDataEx(data.subarray(8).toString('base64'));
}

/** Instruction lines pump logs for a trade. Used by the feed watchdog to
 *  tell "a trade happened but nothing decoded" from "nothing happened". */
export function logsMentionPumpTrade(logs: string[]): boolean {
  for (const l of logs) {
    if (l === 'Program log: Instruction: Buy' || l === 'Program log: Instruction: Sell') return true;
  }
  return false;
}

function decodeCreate(body: Buffer): PumpCreateEvent {
  const r = new Reader(body);
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  // Newer layouts append: creator, timestamp, virtual reserves, supply.
  let creator = user;
  let virtualTokenReserves: bigint | null = null;
  let virtualSolReserves: bigint | null = null;
  if (r.remaining() >= 32) creator = r.pubkey();
  if (r.remaining() >= 8) r.i64(); // timestamp — chain time comes from the tx anyway
  if (r.remaining() >= 16) {
    virtualTokenReserves = r.u64();
    virtualSolReserves = r.u64();
  }
  return {
    kind: 'create',
    name,
    symbol,
    uri,
    mint,
    bondingCurve,
    user,
    creator,
    virtualTokenReserves,
    virtualSolReserves,
  };
}

function decodeTrade(body: Buffer): PumpTradeEvent {
  const r = new Reader(body);
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.u8() === 1;
  const user = r.pubkey();
  const timestamp = Number(r.i64());
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  // Trailing fields (current layout): real_sol_reserves(8), real_token_reserves(8),
  // fee_recipient(32), fee_basis_points(8), fee(8), creator(32), … We only want
  // the creator — it identifies the creator-vault slot during template learning.
  let creator: string | null = null;
  if (r.remaining() >= 8 + 8 + 32 + 8 + 8 + 32) {
    r.u64(); // real_sol_reserves
    r.u64(); // real_token_reserves
    r.pubkey(); // fee_recipient
    r.u64(); // fee_basis_points
    r.u64(); // fee
    creator = r.pubkey();
  }
  return {
    kind: 'trade',
    mint,
    solAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    creator,
  };
}

function decodeComplete(body: Buffer): PumpCompleteEvent {
  const r = new Reader(body);
  return { kind: 'complete', user: r.pubkey(), mint: r.pubkey(), bondingCurve: r.pubkey() };
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

export interface DecodedLogs {
  events: PumpEvent[];
  /** Known-discriminator payloads that failed layout parsing. */
  layoutErrors: number;
}

/** Extract every decodable pump event from a transaction's log lines,
 *  reporting layout drift so the engine can fail closed. */
export function decodeLogsEx(logs: string[]): DecodedLogs {
  const events: PumpEvent[] = [];
  let layoutErrors = 0;
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const r = decodeEventDataEx(line.slice(PROGRAM_DATA_PREFIX.length));
    if (r.event) events.push(r.event);
    else if (r.layoutError) layoutErrors++;
  }
  return { events, layoutErrors };
}

/** Back-compat helper for tests. */
export function decodeLogs(logs: string[]): PumpEvent[] {
  return decodeLogsEx(logs).events;
}
