// Leader feed frames — the two subscriptions a followed wallet can ride on,
// and the parser for the one that pushes the transaction itself.
//
// `logsSubscribe` (every Solana RPC): a signature per transaction that
// mentions the wallet; the watcher then reads the transaction back. That
// read-back is the slow, fragile half of copy trading on a public endpoint —
// up to six retries against a host that parks itself, ~150–600 ms on a good
// day and "That trade was not copied" on a bad one (docs/tx-v1-2026-09-20.md,
// docs/copy-trade-competitors-2026-09-21.md §5).
//
// `transactionSubscribe` (Helius Enhanced WebSockets; Developer plan and up,
// docs fetched 2026-09-21): the whole transaction — message and meta — comes
// WITH the notification, filtered by `accountInclude`. No read-back, no
// retries, no per-method budget spent. The watcher tries it on a keyed
// socket and falls back to `logs` on a refusal that names the plan or the
// method, so a free key is left exactly where it was.
//
// Both frames are built here, as pure functions with fixtures in
// test/leaderfeedframes.test.mjs, so the watcher's socket code never has to
// know what a Helius notification looks like — and a shape change on their
// side degrades to the read-back path rather than to silence.

import { MAX_SUPPORTED_TX_VERSION, type RawTransaction } from '../chain/rpcClient';

export type LeaderFeedMethod = 'logs' | 'tx';

/**
 * Confirmed on both transports. On `logs` the transaction is read back at
 * confirmed, and a processed notification would only be asked for before it
 * can be answered. On `tx` a processed push can describe a transaction that
 * never lands — and a copy must not fire on one. Helius allows `processed`
 * here; it is a deliberate non-choice, worth ~400 ms and a phantom-signal
 * risk, and belongs behind a measurement, not a default.
 */
export const FEED_COMMITMENT = 'confirmed';

export function subscribeFrame(method: LeaderFeedMethod, id: number, wallet: string): string {
  if (method === 'tx') {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'transactionSubscribe',
      params: [
        { vote: false, failed: false, accountInclude: [wallet] },
        {
          commitment: FEED_COMMITMENT,
          encoding: 'json',
          transactionDetails: 'full',
          showRewards: false,
          // Required for the account list and full details to come back at
          // all, and the same constant every read in the app uses.
          maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        },
      ],
    });
  }
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [wallet] }, { commitment: FEED_COMMITMENT }] });
}

export function unsubscribeFrame(method: LeaderFeedMethod, id: number, subscription: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: method === 'tx' ? 'transactionUnsubscribe' : 'logsUnsubscribe', params: [subscription] });
}

/**
 * A refusal that means "not this method on this plan", as opposed to a
 * transient one (too many subscriptions, a hiccup). -32601 is JSON-RPC's
 * "method not found", which is what a host without the method answers.
 */
export function isPlanRefusal(message: string, code?: number): boolean {
  if (code === -32601) return true;
  return /method not found|not supported|unsupported|plan|upgrade|unauthori[sz]ed|forbidden|not available|not enabled|invalid method/i.test(message);
}

export interface TxNotification {
  subscription: number;
  signature: string;
  slot: number | null;
  /** The transaction as `getTransaction` would return it, or null when the
   *  push did not carry a shape the decoder knows — the caller then reads
   *  it back by signature, exactly as on the `logs` transport. */
  tx: RawTransaction | null;
}

export function parseTransactionNotification(msg: unknown): TxNotification | null {
  const m = msg as { method?: unknown; params?: { subscription?: unknown; result?: { signature?: unknown; slot?: unknown; transaction?: unknown; meta?: unknown } } } | null;
  if (!m || m.method !== 'transactionNotification') return null;
  const sub = m.params?.subscription;
  const r = m.params?.result;
  if (typeof sub !== 'number' || !r || typeof r.signature !== 'string' || !r.signature) return null;
  return { subscription: sub, signature: r.signature, slot: typeof r.slot === 'number' ? r.slot : null, tx: unwrap(r.transaction, r.meta) };
}

function unwrap(t: unknown, metaBeside: unknown): RawTransaction | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as { transaction?: { message?: unknown }; meta?: unknown; message?: unknown; blockTime?: unknown };
  // Helius: result.transaction = { transaction: { message, signatures }, meta }
  // — the getTransaction shape, which the decoder already reads.
  if (o.transaction && typeof o.transaction === 'object' && o.transaction.message && o.meta !== undefined) {
    return o as unknown as RawTransaction;
  }
  // Or the message on its own with the meta beside it.
  const meta = o.meta !== undefined ? o.meta : metaBeside;
  if (o.message && meta !== undefined) {
    return { transaction: o, meta, blockTime: typeof o.blockTime === 'number' ? o.blockTime : null } as unknown as RawTransaction;
  }
  return null;
}
