// LI.FI — the bridge aggregator, and everything it gets wrong.
//
// This is a thin client over two endpoints, and most of its length is guards
// against behaviour measured on 2026-09-11 and written up in
// docs/bridge-research-2026-09-11.md. Every one of these was a bug waiting to
// ship:
//
//  · `action.slippage` is ECHOED BACK AND NEVER APPLIED. Sending 0.5 %, 5 %
//    and 30 % all produced an enforced minimum set by the aggregator per route (0.995 on the 09-11 Solana quotes, 0.990025 on the BNB ones the same day) and READ from the response, never assumed. The only real
//    number is `estimate.toAmountMin` from the returned step. This client does
//    not read `slippage` at all.
//  · A 200 does not mean a requested floor was honoured — a transaction came
//    back with an enforced minimum BELOW what was asked for.
//  · `/v1/status` accepts a caller-chosen `transactionId` and will happily
//    return a populated DONE for somebody else's unrelated transaction. It is
//    only 8 bytes on Solana. This client asks by txHash and asserts the answer
//    is about that hash.
//  · `DONE` is not success: `PARTIAL` and `REFUNDED` are both terminal DONE
//    substatuses.
//  · `GET /v1/chains` is EVM-only unless `chainTypes` is passed — an app that
//    probes support with the plain call concludes Solana is unsupported.
//  · The quote budget is 75 calls per TWO HOURS per IP, and exhausting it
//    takes the whole feature down for that long. See the gap in http.ts.
//
// Nothing here takes a URL, a host or a path from a caller. The host is
// hardcoded in `data/http.ts` like every other, and the paths are literals in
// this file.

import { getJson } from '../data/http';
import { logger } from '../system/logger';
import { LIFI_CHAIN_ID, LIFI_NATIVE_TOKEN, readStatus, type BridgeChain, type BridgeStatus } from '@shared/bridge';

/** What a quote is asked for. Amounts are BASE UNITS, as strings — never floats. */
export interface LifiQuoteRequest {
  from: BridgeChain;
  to: BridgeChain;
  fromAmountRaw: string;
  /** The address funds leave. */
  fromAddress: string;
  /** The address funds must arrive at — ours on the destination chain. */
  toAddress: string;
}

export interface LifiQuote {
  tool: string;
  toolName: string;
  fromAmountRaw: string;
  toAmountRaw: string;
  /** The ONLY honest slippage figure. See the header. */
  toAmountMinRaw: string;
  toDecimals: number;
  fromUsd: number | null;
  toUsd: number | null;
  durationSec: number | null;
  /** Solana: a base64 v0 transaction. EVM: the call to make. */
  solanaTxBase64: string | null;
  evmCall: { to: string; data: string; value: string; chainId: number } | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull the REAL reason out of a LI.FI error.
 *
 * The top-level `message` is useless for diagnosis: an amount that is too
 * large and a bridge that is down produce the same string, "No available
 * quotes for the requested transfer". The actual cause sits several levels
 * down in `errors.failed[].subpaths[<path>][].message`, and a user told "no
 * route" when the truth is "you asked for more than this pair can carry" will
 * try again with the same number.
 */
function realReason(body: unknown): string | null {
  const b = body as { errors?: { failed?: Array<{ subpaths?: Record<string, Array<{ message?: unknown }>> }> } } | null;
  const failed = b?.errors?.failed;
  if (!Array.isArray(failed)) return null;
  for (const f of failed) {
    for (const list of Object.values(f?.subpaths ?? {})) {
      for (const e of list ?? []) {
        if (typeof e?.message === 'string' && e.message.trim()) return e.message.trim();
      }
    }
  }
  return null;
}

export type LifiResult<T> = { ok: true; data: T } | { ok: false; message: string; retryAfterSec?: number };

/**
 * Price one bridge.
 *
 * Expensive in a way no other call in this app is: it spends one of 75 tokens
 * that refill over two hours. Callers must quote on demand, never on a timer.
 */
export async function quote(req: LifiQuoteRequest): Promise<LifiResult<LifiQuote>> {
  const q = new URLSearchParams({
    fromChain: String(LIFI_CHAIN_ID[req.from]),
    toChain: String(LIFI_CHAIN_ID[req.to]),
    fromToken: LIFI_NATIVE_TOKEN[req.from],
    toToken: LIFI_NATIVE_TOKEN[req.to],
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    fromAmount: req.fromAmountRaw,
  });
  const r = await getJson<Record<string, unknown>>('lifi', `/v1/quote?${q.toString()}`, { priority: false, timeoutMs: 15_000 });
  if (!r.ok || !r.data) {
    // A refusal the user can act on, not a status code. The two-hour lockout
    // is named explicitly because it is a state, not a hiccup.
    if (r.status === 429) {
      // A two-hour outage of the whole feature. It belongs on the live log,
      // not only in the toast of whoever happened to click.
      logger.error('bridge: LI.FI quotes are rate-limited — no bridge can be priced for up to two hours');
      return { ok: false, message: 'Bridge quotes are rate-limited for up to two hours. Nothing was sent.', retryAfterSec: 7200 };
    }
    const why = realReason(r.data) ?? r.message;
    logger.warn(`bridge quote refused (${req.from} to ${req.to}): ${why}`);
    return { ok: false, message: why };
  }
  const d = r.data as {
    tool?: unknown;
    toolDetails?: { name?: unknown };
    estimate?: Record<string, unknown>;
    action?: { toToken?: { decimals?: unknown } };
    transactionRequest?: Record<string, unknown>;
  };
  const est = d.estimate ?? {};
  const toAmount = typeof est.toAmount === 'string' ? est.toAmount : '';
  const toAmountMin = typeof est.toAmountMin === 'string' ? est.toAmountMin : '';
  // A 200 without the numbers that make it a quote is a polite refusal, not a
  // quote. Same bug class the provider layer already has a name for.
  if (!toAmount || !toAmountMin) return { ok: false, message: 'The bridge answered without a usable quote.' };

  const tr = d.transactionRequest ?? {};
  const solanaTxBase64 = req.from === 'solana' && typeof tr.data === 'string' && !tr.to ? tr.data : null;
  const evmCall =
    req.from !== 'solana' && typeof tr.to === 'string' && typeof tr.data === 'string'
      ? {
          to: tr.to,
          data: tr.data,
          value: typeof tr.value === 'string' ? tr.value : '0x0',
          chainId: Number(tr.chainId ?? LIFI_CHAIN_ID[req.from]),
        }
      : null;
  if (!solanaTxBase64 && !evmCall) return { ok: false, message: 'The bridge answered without a transaction to send.' };

  return {
    ok: true,
    data: {
      tool: typeof d.tool === 'string' ? d.tool : 'unknown',
      toolName: typeof d.toolDetails?.name === 'string' ? d.toolDetails.name : (typeof d.tool === 'string' ? d.tool : 'unknown'),
      fromAmountRaw: req.fromAmountRaw,
      toAmountRaw: toAmount,
      toAmountMinRaw: toAmountMin,
      toDecimals: num(d.action?.toToken?.decimals) ?? 18,
      fromUsd: num(est.fromAmountUSD),
      toUsd: num(est.toAmountUSD),
      durationSec: num(est.executionDuration),
      solanaTxBase64,
      evmCall,
    },
  };
}

export interface LifiStatus {
  status: BridgeStatus;
  /** Base units actually delivered, when the far side has reported. */
  deliveredRaw: string | null;
  /** LI.FI's own words, for the log and for a stuck transfer's detail line. */
  detail: string | null;
}

/**
 * Where a transfer got to.
 *
 * Asked BY TRANSACTION HASH and never by `transactionId`: that id is
 * caller-chosen, is not unique, and is only 8 bytes on Solana. Querying a
 * nonsense one returned a populated DONE for a real, unrelated Arbitrum
 * transaction — so an app polling by id can be told somebody else's transfer
 * succeeded. The answer is then checked to be about the hash we asked for.
 */
export async function status(txHash: string, from: BridgeChain, to: BridgeChain): Promise<LifiResult<LifiStatus>> {
  const q = new URLSearchParams({
    txHash,
    fromChain: String(LIFI_CHAIN_ID[from]),
    toChain: String(LIFI_CHAIN_ID[to]),
  });
  const r = await getJson<Record<string, unknown>>('lifi-status', `/v1/status?${q.toString()}`, { priority: false, timeoutMs: 12_000 });
  if (!r.ok || !r.data) {
    // Could not ask is NOT "did not arrive". The caller keeps it in flight.
    return { ok: false, message: r.message };
  }
  const d = r.data as {
    status?: unknown;
    substatus?: unknown;
    substatusMessage?: unknown;
    sending?: { txHash?: unknown };
    receiving?: { amount?: unknown };
  };
  // The spoofing check. An answer about a different transaction is no answer.
  const echoed = typeof d.sending?.txHash === 'string' ? d.sending.txHash : '';
  if (echoed && echoed.toLowerCase() !== txHash.toLowerCase()) {
    // This one is close to alarming: the aggregator answered a status query
    // with a different transaction's record. Measured as possible on
    // 2026-09-11. Never silent.
    logger.error(`bridge: status answer was about ${echoed}, not the transaction we asked about (${txHash}) — discarded`);
    return { ok: false, message: 'The bridge answered about a different transaction — ignoring it.' };
  }
  return {
    ok: true,
    data: {
      status: readStatus(d.status, d.substatus),
      deliveredRaw: typeof d.receiving?.amount === 'string' ? d.receiving.amount : null,
      detail: typeof d.substatusMessage === 'string' ? d.substatusMessage : null,
    },
  };
}
