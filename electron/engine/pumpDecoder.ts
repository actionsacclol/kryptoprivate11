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
  /** pump's own `is_mayhem_mode`, carried by the event after token_program.
   *  Null on layouts that predate it — unknown, never "standard". */
  isMayhem: boolean | null;
  /**
   * The curve's quote token when it is NOT SOL (2026-10-26: pump launches
   * coins against tokenized stocks — `quote_mint` after is_cashback_enabled).
   * Null means SOL: the field is absent on older layouts, and all-zero or
   * WSOL on every SOL-paired curve. Everything downstream that reads a
   * "SOL" figure off a trade of a quote-paired coin reads ZERO (the program
   * zeroes sol_amount / virtual_sol_reserves and fills the quote fields
   * instead), so a non-null value here means "convert or skip, never price".
   */
  quoteMint: string | null;
  /** `virtual_quote_reserves` at creation, raw units of the quote token.
   *  Null when the layout predates it. */
  virtualQuoteReserves: bigint | null;
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
  /**
   * Quote token of the curve when it is NOT SOL — see PumpCreateEvent. On a
   * quote-paired coin `solAmount`, `virtualSolReserves` and the real SOL
   * reserve are all ZERO on the wire; the money is in the three quote fields
   * below, in the quote token's raw units. Null = SOL (absent, zero or WSOL),
   * and then the quote fields simply mirror the SOL ones.
   */
  quoteMint: string | null;
  quoteAmount: bigint | null;
  virtualQuoteReserves: bigint | null;
  realQuoteReserves: bigint | null;
}

export interface PumpCompleteEvent {
  kind: 'complete';
  user: string;
  mint: string;
  bondingCurve: string;
  /** The curve's quote mint when it is NOT SOL (2026-10) — the pool it
   *  graduates into is quoted in it. Null = SOL. */
  quoteMint: string | null;
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
  u16(): number {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
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
  /** A `quote_mint` field as the app wants it: null for SOL. The program
   *  writes all zeros on a SOL curve (observed on every current trade,
   *  2026-10-26) and may one day write WSOL; both mean SOL. */
  quoteMint(): string | null {
    const raw = this.buf.subarray(this.off, this.off + 32);
    this.off += 32;
    if (raw.every((b) => b === 0)) return null;
    const v = base58Encode(raw);
    return v === WSOL_MINT ? null : v;
  }
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Bytes per Shareholder entry in a TradeEvent: pubkey + share_bps (u16). */
const SHAREHOLDER_BYTES = 32 + 2;

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
  // Newer layouts append: creator, timestamp, virtual reserves, real token
  // reserves, supply, token_program, is_mayhem_mode.
  let creator = user;
  let virtualTokenReserves: bigint | null = null;
  let virtualSolReserves: bigint | null = null;
  let isMayhem: boolean | null = null;
  if (r.remaining() >= 32) creator = r.pubkey();
  if (r.remaining() >= 8) r.i64(); // timestamp — chain time comes from the tx anyway
  if (r.remaining() >= 16) {
    virtualTokenReserves = r.u64();
    virtualSolReserves = r.u64();
  }
  // The mayhem flag is the ONLY create-time sign of a mayhem coin: on
  // 2026-09-24 mayhem and standard curves both started at exactly 30 virtual
  // SOL, so the reserves-based guess this replaced never said mayhem once
  // (test/fixtures/create-mayhem.json). A byte other than 0/1 is not trusted.
  let quoteMint: string | null = null;
  let virtualQuoteReserves: bigint | null = null;
  if (r.remaining() >= 8 + 8 + 32 + 1) {
    r.u64(); // real_token_reserves
    r.u64(); // token_total_supply
    r.pubkey(); // token_program
    const b = r.u8();
    isMayhem = b === 1 ? true : b === 0 ? false : null;
    // 2026-10 layout: is_cashback_enabled · quote_mint · virtual_quote_reserves
    // · creator_fee_bps · is_holder_reward. Read only what is there.
    if (r.remaining() >= 1 + 32 + 8) {
      r.u8(); // is_cashback_enabled
      quoteMint = r.quoteMint();
      virtualQuoteReserves = r.u64();
    }
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
    isMayhem,
    quoteMint,
    virtualQuoteReserves,
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
  let quoteMint: string | null = null;
  let quoteAmount: bigint | null = null;
  let virtualQuoteReserves: bigint | null = null;
  let realQuoteReserves: bigint | null = null;
  if (r.remaining() >= 8 + 8 + 32 + 8 + 8 + 32) {
    r.u64(); // real_sol_reserves
    r.u64(); // real_token_reserves
    r.pubkey(); // fee_recipient
    r.u64(); // fee_basis_points
    r.u64(); // fee
    creator = r.pubkey();
    // The 2026-10 tail, read field by field and only while the bytes are
    // there (pump's IDL, fetched from the chain 2026-10-26):
    //   creator_fee_basis_points u64 · creator_fee u64 · track_volume bool ·
    //   total_unclaimed_tokens u64 · total_claimed_tokens u64 ·
    //   current_sol_volume u64 · last_update_timestamp i64 · ix_name string ·
    //   mayhem_mode bool · cashback_fee_basis_points u64 · cashback u64 ·
    //   buyback_fee_basis_points u64 · buyback_fee u64 ·
    //   shareholders vec<{pubkey, u16}> · quote_mint pubkey · quote_amount u64 ·
    //   virtual_quote_reserves u64 · real_quote_reserves u64 · …
    // A coin paired with a tokenized stock has sol_amount and both SOL
    // reserves at ZERO and its money here. Anything that stops short leaves
    // the quote fields null, which the engine treats as "SOL" exactly as the
    // older layouts were.
    const quote = readTradeQuoteTail(r);
    if (quote) {
      quoteMint = quote.quoteMint;
      quoteAmount = quote.quoteAmount;
      virtualQuoteReserves = quote.virtualQuoteReserves;
      realQuoteReserves = quote.realQuoteReserves;
    }
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
    quoteMint,
    quoteAmount,
    virtualQuoteReserves,
    realQuoteReserves,
  };
}

/** The quote fields at the end of a current TradeEvent, or null when the
 *  bytes run out first (an older layout — SOL throughout). A short tail is
 *  not drift, just an older event, so it never throws. */
function readTradeQuoteTail(r: Reader): { quoteMint: string | null; quoteAmount: bigint; virtualQuoteReserves: bigint; realQuoteReserves: bigint } | null {
  // creator_fee_basis_points · creator_fee · track_volume · total_unclaimed ·
  // total_claimed · current_sol_volume · last_update_timestamp · string len
  if (r.remaining() < 8 + 8 + 1 + 8 + 8 + 8 + 8 + 4) return null;
  r.u64();
  r.u64();
  r.u8();
  r.u64();
  r.u64();
  r.u64();
  r.i64();
  r.string(); // ix_name — its own guard throws on a length past the end
  // mayhem_mode · cashback bps · cashback · buyback bps · buyback fee · vec len
  if (r.remaining() < 1 + 8 + 8 + 8 + 8 + 4) return null;
  r.u8();
  r.u64();
  r.u64();
  r.u64();
  r.u64();
  const shareholders = r.u32();
  if (shareholders > 64 || r.remaining() < shareholders * SHAREHOLDER_BYTES) return null;
  for (let i = 0; i < shareholders; i++) {
    r.pubkey();
    r.u16();
  }
  if (r.remaining() < 32 + 8 + 8 + 8) return null;
  const quoteMint = r.quoteMint();
  const quoteAmount = r.u64();
  const virtualQuoteReserves = r.u64();
  const realQuoteReserves = r.u64();
  return { quoteMint, quoteAmount, virtualQuoteReserves, realQuoteReserves };
}

function decodeComplete(body: Buffer): PumpCompleteEvent {
  const r = new Reader(body);
  const user = r.pubkey();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  // timestamp (i64), then quote_mint — pump.fun since 2026-10; an older,
  // shorter event is a SOL curve.
  let quoteMint: string | null = null;
  if (r.remaining() >= 8 + 32) {
    r.i64();
    quoteMint = r.quoteMint();
  }
  return { kind: 'complete', user, mint, bondingCurve, quoteMint };
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
