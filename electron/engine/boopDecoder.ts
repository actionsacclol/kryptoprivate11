// Boop (boop.fun) decoder.
//
// Boop runs its OWN bonding-curve program — it is not a Meteora DBC front end,
// which is the assumption to check first with any new launchpad and the one
// that would have saved this file.
//
// ─── Where its events live ────────────────────────────────────────────
//
// In LOGS, like pump.fun and Raydium LaunchLab, and unlike Meteora DBC.
// Measured 2026-08-24: 14 of 14 sampled transactions carried a `Program data:`
// line of exactly 128 bytes, and NONE carried an Anchor event-CPI instruction.
// So one program-wide `logsSubscribe` tapes the whole rail.
//
// ─── What makes Boop the richest of the three log rails ───────────────
//
// Its event carries the MINT and the TRADER. LaunchLab's carries only the pool,
// which is why LaunchLab ticks have no wallet and get no trader scan. Boop
// needs no pool→mint mapping at all, and its ticks are complete.
//
// ─── Direction ────────────────────────────────────────────────────────
//
// There is no direction flag in the body — buys and sells are DIFFERENT
// EVENTS with different discriminators. Verified 3/3 each way.

import { base58Encode } from './base58';

export const BOOP_PROGRAM = 'boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4';

/** Event discriminators, one per direction. */
const BUY_EVENT_DISC = '4759de7cd7c0e68a';
const SELL_EVENT_DISC = 'ccefb64df1334d42';

/** 8-byte discriminator + a 120-byte body. */
const BODY_LEN = 120;
const LOG_LEN = 8 + BODY_LEN;

const LOG_PREFIX = 'Program data: ';

export interface BoopTradeEvent {
  kind: 'trade';
  mint: string;
  /** The wallet that traded — Boop puts it in the event, unlike LaunchLab. */
  trader: string;
  isBuy: boolean;
  /**
   * What went in, NET of the fee.
   *
   * Buy: lamports (the instruction's requested amount MINUS `fee`; verified
   * exactly — 619144 + 6253 == 625397 on a real trade). Sell: token base units.
   */
  amountIn: bigint;
  /** What came out. Buy: token base units. Sell: lamports. */
  amountOut: bigint;
  /** Protocol fee in lamports. */
  fee: bigint;
  /** Second pubkey in the body. Equals the trader on every sample seen. */
  recipient: string;
}

/**
 * Decode one `Program data:` payload.
 *
 * Field order verified against chain rather than documentation: on a buy,
 * `amountIn + fee` reproduced the instruction's own requested amount to the
 * lamport, and the trader field matched the transaction's fee payer.
 */
export function decodeTradeEvent(payload: Buffer): BoopTradeEvent | null {
  if (payload.length !== LOG_LEN) return null;
  const disc = payload.subarray(0, 8).toString('hex');
  const isBuy = disc === BUY_EVENT_DISC;
  if (!isBuy && disc !== SELL_EVENT_DISC) return null;
  const body = payload.subarray(8);
  try {
    return {
      kind: 'trade',
      mint: base58Encode(body.subarray(0, 32)),
      amountIn: body.readBigUInt64LE(32),
      amountOut: body.readBigUInt64LE(40),
      fee: body.readBigUInt64LE(48),
      trader: base58Encode(body.subarray(56, 88)),
      recipient: base58Encode(body.subarray(88, 120)),
      isBuy,
    };
  } catch {
    return null;
  }
}

/** Every Boop trade in a log stream. Foreign `Program data:` lines are skipped. */
export function decodeLogs(logs: string[]): BoopTradeEvent[] {
  const out: BoopTradeEvent[] = [];
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

export function touchesBoop(logs: string[]): boolean {
  return logs.some((l) => l.includes(BOOP_PROGRAM));
}

/**
 * Price in lamports per whole token, from the amounts actually exchanged.
 *
 * The fee is added back on a buy: the trader parted with `amountIn + fee` to
 * receive `amountOut`, so leaving it out would report a price a few tenths of
 * a percent cheaper than anyone can actually get.
 */
export function priceLamportsPerToken(ev: BoopTradeEvent, decimals: number): number | null {
  const lamports = ev.isBuy ? ev.amountIn + ev.fee : ev.amountOut;
  const baseUnits = ev.isBuy ? ev.amountOut : ev.amountIn;
  if (lamports <= 0n || baseUnits <= 0n) return null;
  const price = Number(lamports) / (Number(baseUnits) / 10 ** decimals);
  return Number.isFinite(price) ? price : null;
}
