// Relay's HTTP API (api.relay.link), keyless. Quotes and status only — what
// the transaction may contain, and how it is signed, is bridge.ts's job, and
// what a quote must look like to be signed at all is shared/relay.ts.

import { getJson } from '../data/http';
import { bridgeStatusOfRelay, parseRelayQuote, type RelayQuote, type RelayQuoteRequest, cleanRelayReason } from '@shared/relay';
import type { BridgeStatus } from '@shared/bridge';
import { relayBindingProblem } from '@shared/relayOrder';

export type RelayResult<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * One quote. Relay explains a refusal in its body ("Insufficient
 * liquidity", "Amount too low") and http.ts carries that text through on a
 * 4xx, so the message is Relay's own words.
 */
export async function quote(req: RelayQuoteRequest): Promise<RelayResult<RelayQuote>> {
  // includeProtocolData: the order behind the quote, so it can be checked.
  const r = await getJson<unknown>('relay', '/quote', { json: { ...req, includeProtocolData: true }, timeoutMs: 12_000 });
  if (!r.ok) return { ok: false, message: r.message.replace(/^relay: /, 'Relay: ') };
  const parsed = parseRelayQuote(r.data);
  if (!parsed.ok) return { ok: false, message: `Relay's quote cannot be signed: ${parsed.why}` };
  // The deposit commits to an order; the order names where the money goes.
  // Both are checked against what WE asked for — recipient, chain, coin, the
  // floor, where a refund goes, the deadline — and the commitment against an
  // id recomputed here (shared/relayOrder.ts, 2026-10-03). Before this, where
  // a move arrived rested on Relay's word alone.
  const bound = relayBindingProblem(r.data, {
    recipient: req.recipient,
    destinationChainId: req.destinationChainId,
    destinationCurrency: req.destinationCurrency,
    minOutRaw: req.tradeType === 'EXACT_OUTPUT' ? BigInt(req.amount) : BigInt(parsed.quote.minOutRaw),
    // A refund may come back where the money left (user / refundTo) OR, on
    // the far side, to the recipient — all three are our own addresses.
    refundRecipients: [req.user, req.refundTo, req.recipient],
    nowSec: Math.floor(Date.now() / 1000),
  });
  if (bound) return { ok: false, message: `Relay's quote cannot be signed: ${bound}` };
  return { ok: true, data: parsed.quote };
}

export interface RelayStatusRead {
  status: BridgeStatus;
  /** Relay's own word, for the record. */
  raw: string;
  /** Deposit transactions Relay matched to the request. */
  inTxHashes: string[];
  /** Fill transactions on the destination chain. */
  outTxHashes: string[];
  detail: string | null;
}

/** Where a request stands. "unknown" is Relay not having seen it (yet). */
export async function status(requestId: string): Promise<RelayResult<RelayStatusRead>> {
  if (!/^0x[0-9a-f]{64}$/i.test(requestId)) return { ok: false, message: 'not a Relay request id' };
  const r = await getJson<Record<string, unknown>>('relay-status', `/intents/status/v3?requestId=${requestId}`, { timeoutMs: 8_000 });
  if (!r.ok || !r.data) return { ok: false, message: r.ok ? 'empty answer' : r.message };
  const d = r.data;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const reason = [d.failReason, d.refundFailReason].find((x) => typeof x === 'string' && x !== 'N/A') as string | undefined;
  return {
    ok: true,
    data: {
      status: bridgeStatusOfRelay(d.status),
      raw: typeof d.status === 'string' ? d.status : 'unknown',
      inTxHashes: list(d.inTxHashes),
      outTxHashes: list(d.txHashes),
      detail: reason ? cleanRelayReason(reason) : null,
    },
  };
}
