// How much $KRYPTO this install holds, across every wallet it has keys for.
//
// This decides whether Krypt's own fee is waived (shared/krypto.ts), so two
// properties matter more than the number itself:
//
//   • IT NEVER BLOCKS A TRADE. The fee path reads `current()`, which is a
//     cached value and never a request. A refresh runs on a timer and after
//     a wallet changes; a trade that arrives mid-refresh uses the last
//     answer. Putting an RPC read in front of a buy to work out a discount
//     would cost more than the discount is worth.
//   • UNKNOWN IS NOT QUALIFIED. A failed read, or a wallet list we could not
//     derive, leaves `tokens` null and `waivesFee` refuses null. Otherwise
//     breaking one request would be the cheapest way to trade for free. The
//     USD figure is DISPLAY ONLY — the threshold is a token count, so a
//     token nobody can price still waives the fee for someone holding it.
//
// One request for every wallet: the KRYPTO account of a wallet is its
// associated token account, which is derivable, so N wallets are N derived
// addresses and a single `getMultipleAccounts`. ($KRYPTO is a Token-2022
// mint — pinned and verified in shared/krypto.ts — so the ATA is derived
// under that program, not the classic one. Deriving under the wrong program
// yields a real-looking address that simply never has a balance, which would
// read as "holds nothing" rather than as an error.)

import { KRYPTO_TOKEN, isValidMint, waivesFee, type KryptoHolding } from '@shared/krypto';
import { ataFor, TOKEN_2022_PROGRAM } from '../chain/addresses';
import { getMultipleAccountInfo } from '../chain/rpcClient';
import { logger } from '../system/logger';

/** SPL token account layout: amount is a u64 at offset 64. */
const AMOUNT_OFFSET = 64;

export interface KryptoHost {
  /** Every Solana wallet this install holds keys for. */
  wallets(): string[];
  httpUrl(): string;
  /** USD per KRYPTO from the market layer, or null when it cannot be priced.
   *  Cached by the caller — this is read on a timer, not on a trade. */
  priceUsd(mint: string): number | null;
}

let host: KryptoHost | null = null;
let snapshot: KryptoHolding = { tokens: 0, usd: null, wallets: 0, at: 0, problem: 'not read yet' };
let inFlight: Promise<void> | null = null;

export function attach(h: KryptoHost): void {
  host = h;
}

/** The last reading. NEVER a request — this is what the fee path calls. */
export function current(): KryptoHolding {
  return { ...snapshot };
}

/**
 * Is the fee waived right now?
 *
 * The one question the signer asks. False whenever the holding is unknown,
 * for the reason in `waivesFee`: a waiver the app cannot justify is a fee
 * anyone can avoid by breaking a single read.
 */
export function feeWaived(): boolean {
  return waivesFee(usableTokens());
}

/**
 * Past this the reading is too old to act on.
 *
 * Not "too old to show" — the UI renders a stale figure and says it is
 * stale. This is the money rule: after ten minutes with no successful read
 * (the app was asleep, the endpoint was parked), the app no longer knows
 * enough to give anything away.
 */
const MAX_AGE_MS = 10 * 60_000;

/**
 * The reading, with staleness applied. What `feeWaived` really means.
 *
 * Null when nothing has been read or the last read is too old, and null does
 * not waive — a balance from twenty minutes ago is not evidence of a balance
 * now. `problem` is set whenever the balance itself failed, and that leaves
 * the previous reading in place rather than replacing it with a zero; this
 * is where that stale value stops counting.
 */
export function usableTokens(now = Date.now()): number | null {
  if (snapshot.at === 0 || now - snapshot.at > MAX_AGE_MS) return null;
  if (snapshot.problem !== null) return null;
  return snapshot.tokens;
}

function parseAmount(data: Uint8Array | null, decimals: number): number | null {
  if (!data || data.length < AMOUNT_OFFSET + 8) return null;
  try {
    const raw = Buffer.from(data).readBigUInt64LE(AMOUNT_OFFSET);
    return Number(raw) / 10 ** decimals;
  } catch {
    return null;
  }
}

/**
 * Re-read the holding. Safe to call often — concurrent calls share one
 * request, and a failure leaves the previous reading in place rather than
 * replacing it with a zero.
 */
export async function refresh(): Promise<KryptoHolding> {
  if (inFlight) {
    await inFlight;
    return current();
  }
  const h = host;
  const mint = KRYPTO_TOKEN.mint;
  if (!h || !isValidMint(mint)) {
    snapshot = { tokens: 0, usd: null, wallets: 0, at: Date.now(), problem: 'no token to check' };
    return current();
  }
  inFlight = (async () => {
    const owners = [...new Set(h.wallets().filter(Boolean))];
    if (!owners.length) {
      snapshot = { tokens: 0, usd: 0, wallets: 0, at: Date.now(), problem: null };
      return;
    }
    let accounts: string[];
    try {
      accounts = owners.map((o) => ataFor(o, mint, TOKEN_2022_PROGRAM));
    } catch (e) {
      // Keep the previous reading: a derivation that threw says nothing
      // about what is held.
      snapshot = { ...snapshot, problem: `could not derive the token accounts (${(e as Error).message})` };
      return;
    }
    const r = await getMultipleAccountInfo(h.httpUrl(), accounts).catch((e: unknown) => ({
      ok: false as const,
      message: (e as Error).message,
      data: undefined,
    }));
    if (!r.ok || !r.data) {
      snapshot = { ...snapshot, problem: `balance unreadable (${r.message})` };
      return;
    }
    let tokens = 0;
    for (const acc of r.data) {
      // An account that does not exist is a wallet holding none, which is a
      // real zero — unlike a read that failed, handled above.
      if (!acc) continue;
      const amount = parseAmount(acc.data, 6);
      if (amount !== null) tokens += amount;
    }
    // Display only. The waiver is decided by `tokens`, so a price we cannot
    // read costs a line on the card and never a fee.
    const price = h.priceUsd(mint);
    const usd = typeof price === 'number' && Number.isFinite(price) && price > 0 ? tokens * price : null;
    snapshot = { tokens, usd, wallets: owners.length, at: Date.now(), problem: null };
  })()
    .catch((e: unknown) => {
      snapshot = { ...snapshot, problem: `balance unreadable (${(e as Error).message})` };
    })
    .finally(() => {
      inFlight = null;
    });
  await inFlight;
  return current();
}

/** Test seam. */
export function _set(next: KryptoHolding): void {
  snapshot = { ...next };
}

export function _reset(): void {
  snapshot = { tokens: 0, usd: null, wallets: 0, at: 0, problem: 'not read yet' };
  inFlight = null;
  host = null;
}

/** One line for the log when the waiver changes state, so a user who asks
 *  "why was I charged" has an answer in the file. */
export function logState(prev: boolean, now: boolean): void {
  if (prev === now) return;
  logger.info(
    now
      ? `krypto: fee waived — this install holds ${snapshot.tokens.toLocaleString()} KRYPTO${snapshot.usd !== null ? ` (~$${snapshot.usd.toFixed(2)})` : ''} across ${snapshot.wallets} wallet(s)`
      : `krypto: fee no longer waived — ${snapshot.problem ?? `holding is ${snapshot.tokens.toLocaleString()} KRYPTO`}`,
  );
}
