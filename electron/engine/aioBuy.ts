// "Buy anywhere" for the All-in-One wallet (phase 3, 2026-10-02): when the
// chain a buy is on is short, top it up from another chain through Relay,
// wait until the money is ON that chain, then place the ordinary buy.
//
// Two steps, never one: the buy is the app's own manual buy path with every
// guard it has (fee, loss guard, breakers, PnL from chain), and the top-up is
// the bridge engine's Relay rail with every guard IT has. This module only
// decides what to move and runs them in order — and never places the buy on
// money that has not arrived.
//
// Speed (measured pieces, 2026-10-01): quote ~0.6 s, deposit ~1 s, Relay
// fill p50 0-1 s, arrival seen within a 300 ms poll, then the buy. The plan
// is made while the user is still looking at the panel (pre-quote), so the
// click pays only for the move and the buy.

import {
  CHAIN_RESERVE,
  chooseSource,
  costVerdict,
  fundedTarget,
  topUpTarget,
  type AioBuyPlan,
  type SourceQuote,
} from '@shared/aioConvert';
import { AIO_CHAIN_LABEL, AIO_CHAINS, type AioChain } from '@shared/aio';
import { abandonAfterMs, arrivalPollMs, type AioSpeed } from '@shared/aioSpeed';
import { QUOTE_LIFE_MS, QUOTE_UI_MARGIN_MS, nativeSymbolOf, type BridgeQuote } from '@shared/bridge';

const DECIMALS: Record<AioChain, number> = { solana: 9, bnb: 18, robinhood: 18 };
// How often a top-up's arrival is checked, and how long a buy waits for it,
// follow the speed tier (shared/aioSpeed.ts) — 300 ms / 90 s at Normal.
/** A plan with less quote life than this is re-made before anything is
 *  asked or sent: a question answered on a dying quote was asked twice. */
const PLAN_MIN_LIFE_MS = 5_000;
/** Slack on top of the cost ceiling when the app's OWN prices check what
 *  Relay asks for: price feeds differ by a little, never by this much. */
const OWN_PRICE_SLACK_USD = 1;
/** How far over the app's own valuation a quote may ask before it is
 *  refused outright. Relay measured 0.5–1.3 %; an expensive-but-real quote
 *  is the ask ceiling's job (CONVERT_COST_CEILING_PCT) — this catches a
 *  quote that is simply wrong. */
const OWN_PRICE_MAX_OVER = 0.1;

export interface AioBuyHost {
  /** Why "buy anywhere" is off right now (no wallet, not signing everywhere,
   *  the chain in Paper…), or null when it is on. */
  offReason(chain: AioChain): string | null;
  enabled(chain: AioChain): boolean;
  /** The All-in-One wallet's native balance on a chain, read NOW. Null = unknown. */
  nativeHeld(chain: AioChain): Promise<number | null>;
  priceUsd(chain: AioChain): Promise<number | null>;
  quoteTopUp(from: AioChain, to: AioChain, outRaw: bigint): Promise<{ ok: boolean; message: string; quote?: BridgeQuote }>;
  sendTopUp(quoteId: string): Promise<{ ok: boolean; message: string; txHash?: string }>;
  /** `heldNow`: the chain balance this module just read (null = not read).
   *  The buy must size itself from it, not from a cache that has not seen the
   *  top-up yet (swarm 2026-10-03, MS-1). */
  /** `pending`: broadcast, not confirmed in time — it may still land. */
  buy(chain: AioChain, token: string, amount: number, heldNow: number | null): Promise<{ ok: boolean; message: string; pending?: boolean }>;
  /**
   * The owner's rule (2026-10-03): a top-up is fee-free only because the buy
   * it funds pays the fee. When the money ARRIVED but the buy then failed,
   * the top-up was just a move between chains — bill it like one (0.5 %).
   * Returns what was charged, or null when nothing could be (logged, never
   * thrown: the move has happened either way).
   */
  chargeMoveFee(from: AioChain, to: AioChain, inAmount: number, outAmount: number): Promise<{ amount: number; symbol: string } | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The All-in-One speed tier. Absent = Normal. */
  speed?(): AioSpeed;
  /** What the bridge's record says of a sent top-up: 'refunded' / 'failed'
   *  end the wait at once (no point waiting for money that is going back). */
  transferEnded?(txHash: string): 'refunded' | 'failed' | null;
}

/** Destination base units, rounded UP so the target is never short a unit. */
function toRawUp(amount: number, decimals: number): bigint {
  const nano = BigInt(Math.ceil(amount * 1e9));
  return decimals >= 9 ? nano * 10n ** BigInt(decimals - 9) : nano / 10n ** BigInt(9 - decimals);
}

const fromRaw = (raw: string, decimals: number): number => Number(BigInt(raw)) / 10 ** decimals;

/**
 * Plans made HERE, by quote id. The page sends back only the id: amounts,
 * sources and the arrival target come from main's own record, never from
 * what the renderer hands over.
 */
const recentPlans = new Map<string, AioBuyPlan>();
function remember(p: AioBuyPlan, now: number): AioBuyPlan {
  for (const [k, v] of recentPlans) if (!v.convert || v.convert.expiresAt < now) recentPlans.delete(k);
  if (p.convert) recentPlans.set(p.convert.quoteId, p);
  return p;
}

/**
 * What a buy of `amount` (destination coin) on `chain` needs: nothing, a
 * top-up from the cheapest other chain, a question (too costly), or a
 * refusal (nothing anywhere can cover it).
 */
export async function plan(req: { chain: AioChain; amount: number }, host: AioBuyHost): Promise<AioBuyPlan> {
  const base = { chain: req.chain, amount: req.amount };
  const off = host.offReason(req.chain);
  if (off) return { ...base, kind: 'off', message: off };
  const [held, price] = await Promise.all([host.nativeHeld(req.chain), host.priceUsd(req.chain)]);
  // An unread balance is not "short": the ordinary buy reads it again and
  // says what it finds. Never move money on a guess.
  if (held === null) return { ...base, kind: 'direct', message: 'Balance not read — the buy goes ahead and checks it.' };
  const target = topUpTarget({ buy: req.amount, held, reserve: CHAIN_RESERVE[req.chain], priceUsd: price });
  if (!target) return { ...base, kind: 'direct', message: 'Enough on this chain.' };

  const sources = AIO_CHAINS.filter((c) => c !== req.chain && host.enabled(c));
  // A source that could not be read or quoted is UNKNOWN, not short: saying
  // "no other chain can spare it" would be a guess (swarm 2026-10-03, UX-4).
  let unknown = 0;
  const quotes = (
    await Promise.all(
      sources.map(async (src): Promise<SourceQuote | null> => {
        const srcHeld = await host.nativeHeld(src);
        if (srcHeld === null) {
          unknown += 1;
          return null;
        }
        const spare = srcHeld - CHAIN_RESERVE[src];
        if (!(spare > 0)) return null;
        const ask = async (out: number): Promise<SourceQuote | null> => {
          const r = await host.quoteTopUp(src, req.chain, toRawUp(out, DECIMALS[req.chain]));
          if (!r.ok || !r.quote || !r.quote.quoteId) return null;
          return {
            from: src,
            inAmount: fromRaw(r.quote.fromAmountRaw, DECIMALS[src]),
            spare,
            outAmount: fromRaw(r.quote.toAmountRaw, r.quote.toDecimals),
            inUsd: r.quote.fromUsd,
            outUsd: r.quote.toUsd,
            etaSec: r.quote.durationSec,
            quoteId: r.quote.quoteId,
            expiresAt: host.now() + QUOTE_LIFE_MS.relay - QUOTE_UI_MARGIN_MS,
          };
        };
        // The minimum top-up first; if this source cannot spare that much,
        // just what the buy needs.
        const full = await ask(target.target);
        if (full && full.inAmount <= spare) return full;
        if (target.target > target.need) {
          const lean = await ask(target.need);
          if (lean && lean.inAmount <= spare) return lean;
        }
        if (!full) unknown += 1;
        return full;
      }),
    )
  ).filter((q): q is SourceQuote => q !== null);

  const pick = chooseSource(quotes);
  const sym = nativeSymbolOf(req.chain);
  if (!pick) {
    if (unknown > 0) {
      return {
        ...base,
        kind: 'direct',
        message: `Other chains could not be checked just now, so nothing is moved — the buy uses what is here (${held.toPrecision(4)} ${sym}).`,
      };
    }
    return {
      ...base,
      kind: 'refuse',
      message: `Not enough here (${held.toPrecision(4)} ${sym}) and no other chain can spare the ${target.need.toPrecision(4)} ${sym} this buy needs while keeping its own reserve.`,
    };
  }
  // Relay sets the deposit of an exact-output top-up. Bound it with the app's
  // OWN prices, not Relay's dollar figures (swarm 2026-10-03, MS-6): a quote
  // asking far more than the money is worth is refused before anything moves.
  const srcPx = await host.priceUsd(pick.from);
  if (srcPx !== null && price !== null && srcPx > 0 && price > 0) {
    const ownIn = pick.inAmount * srcPx;
    const ownOut = pick.outAmount * price;
    if (ownIn > ownOut * (1 + OWN_PRICE_MAX_OVER) + OWN_PRICE_SLACK_USD) {
      return {
        ...base,
        kind: 'refuse',
        message: `The top-up quote asks for $${ownIn.toFixed(2)} of ${nativeSymbolOf(pick.from)} to deliver $${ownOut.toFixed(2)} by the app's own prices — refused, nothing moved.`,
      };
    }
  }
  const costUsd = pick.inUsd !== null && pick.outUsd !== null ? pick.inUsd - pick.outUsd : null;
  // Against the money MOVED, not the order: with the minimum top-up, most of
  // a small order's top-up is the user's own float, not spent on this buy.
  // A conversion that is mostly fees is what the ceiling exists to stop.
  const verdict = costVerdict(costUsd, pick.outUsd ?? (price !== null ? req.amount * price : null));
  const srcSym = nativeSymbolOf(pick.from);
  const what = `Converts ${pick.inAmount.toPrecision(4)} ${srcSym} from ${AIO_CHAIN_LABEL[pick.from]} into ${pick.outAmount.toPrecision(4)} ${sym} first`;
  // The share is of the money MOVED (most of a small order's top-up stays on
  // the chain as the user's own), and says so (swarm 2026-10-03, UX-5).
  const moved = pick.outUsd !== null ? ` of the $${pick.outUsd.toFixed(2)} moved` : '';
  const costLine = costUsd === null ? 'cost unknown' : `about $${costUsd.toFixed(2)}${verdict.pct !== null ? ` (${verdict.pct.toFixed(1)}%${moved})` : ''}`;
  return remember({
    ...base,
    kind: verdict.ask ? 'ask' : 'convert',
    // Relay's own time estimate said 1 s on every quote while landings took
    // 1–7 s: no number is better than a wrong one.
    message: `${what} — ${costLine}, usually a few seconds, no Krypt fee on the top-up (if the buy fails, it counts as a normal move: 0.5%).`,
    convert: {
      from: pick.from,
      inAmount: pick.inAmount,
      outAmount: pick.outAmount,
      costUsd,
      costPct: verdict.pct,
      etaSec: pick.etaSec,
      quoteId: pick.quoteId,
      expiresAt: pick.expiresAt,
    },
  }, host.now());
}

export interface AioBuyResult {
  ok: boolean;
  message: string;
  /** A fresh plan the user must accept before anything moves (too costly). */
  needsConfirm?: AioBuyPlan;
  /** Milliseconds per stage, for the log and the panel. */
  timings?: { topUpSendMs?: number; arrivalMs?: number; buyMs?: number };
  topUpTx?: string;
  /** The buy was broadcast but not confirmed: not failed, and not billed. */
  stage?: 'pending';
}

const busy = new Set<AioChain>();
/** One top-up in flight ANYWHERE: two at once could both draw on the same
 *  source past its reserve, and nothing is gained by running them together. */
let funding = false;
/** A top-up is being funded right now — the float stays out of its way. */
export function isFunding(): boolean {
  return funding;
}

/** What a top-up that ARRIVED leaves behind for the buy that follows it. */
export interface FundedTopUp {
  from: AioChain;
  to: AioChain;
  inAmount: number;
  outAmount: number;
  /** The destination balance seen when the money landed — the buy sizes from it. */
  seen: number;
  topUpTx?: string;
  timings: { topUpSendMs: number; arrivalMs: number };
}

type TopUpOutcome = { kind: 'arrived'; funded: FundedTopUp } | { kind: 'stopped'; result: AioBuyResult };

/**
 * Send a planned top-up and wait for the money ON the chain — never buy on a
 * promise. One top-up at a time anywhere; the source re-read right before;
 * a refund or failure ends the wait at once; the tier sets the cadence.
 */
async function topUpAndWait(p: AioBuyPlan, req: { chain: AioChain; amount: number }, host: AioBuyHost): Promise<TopUpOutcome> {
  const c = p.convert!;
  if (funding) return { kind: 'stopped', result: { ok: false, message: 'Another top-up is on its way — wait a few seconds and buy again.' } };
  funding = true;
  try {
    const [before, srcHeld] = await Promise.all([host.nativeHeld(req.chain), host.nativeHeld(c.from)]);
    if (before === null) return { kind: 'stopped', result: { ok: false, message: 'Could not read this chain\'s balance before the top-up. Nothing was sent.' } };
    // Re-read: the plan's view of the source can be seconds old, and a source
    // must never be drawn below its own reserve (swarm 2026-10-03, MS-3).
    if (srcHeld === null || srcHeld - c.inAmount < CHAIN_RESERVE[c.from]) {
      return { kind: 'stopped', result: { ok: false, message: `${AIO_CHAIN_LABEL[c.from]} no longer has ${c.inAmount.toPrecision(4)} ${nativeSymbolOf(c.from)} to spare above its reserve. Nothing was sent — try again.` } };
    }
    // Spent here, the moment its top-up is sent — not when a question was
    // only asked about it.
    recentPlans.delete(c.quoteId);
    const t0 = host.now();
    const sent = await host.sendTopUp(c.quoteId);
    const topUpSendMs = host.now() - t0;
    if (!sent.ok) return { kind: 'stopped', result: { ok: false, message: `Top-up not sent: ${sent.message}`, timings: { topUpSendMs } } };

    // Arrived when the balance has gone up by (almost all of) what Relay said
    // it delivers, or simply covers the buy, its fee and the reserve.
    const want = fundedTarget(req.amount, CHAIN_RESERVE[req.chain]);
    const speed = host.speed?.() ?? 'normal';
    const timeoutMs = abandonAfterMs(speed);
    const pollMs = arrivalPollMs(speed);
    const t1 = host.now();
    let seen: number | null = null;
    let ended: 'refunded' | 'failed' | null = null;
    while (host.now() - t1 < timeoutMs) {
      await host.sleep(pollMs);
      ended = sent.txHash ? host.transferEnded?.(sent.txHash) ?? null : null;
      if (ended) break;
      const nowHeld = await host.nativeHeld(req.chain);
      if (nowHeld !== null && (nowHeld >= before + c.outAmount * 0.999 || nowHeld >= want)) {
        seen = nowHeld;
        break;
      }
    }
    const arrivalMs = host.now() - t1;
    if (ended) {
      return {
        kind: 'stopped',
        result: {
          ok: false,
          message:
            ended === 'refunded'
              ? `Relay could not deliver the top-up and refunded it to ${AIO_CHAIN_LABEL[c.from]}, so no buy was placed.`
              : `The top-up failed, so no buy was placed. See Recent transfers on the All-in-One page.`,
          timings: { topUpSendMs, arrivalMs },
          topUpTx: sent.txHash,
        },
      };
    }
    if (seen === null) {
      return {
        kind: 'stopped',
        result: {
          ok: false,
          message: `The top-up was sent but has not arrived after ${Math.round(timeoutMs / 1000)}s, so the buy was NOT placed (the price may have moved). The money still lands on ${AIO_CHAIN_LABEL[req.chain]} — it is tracked under Recent transfers on the All-in-One page.`,
          timings: { topUpSendMs, arrivalMs },
          topUpTx: sent.txHash,
        },
      };
    }
    return {
      kind: 'arrived',
      funded: { from: c.from, to: req.chain, inAmount: c.inAmount, outAmount: c.outAmount, seen, topUpTx: sent.txHash, timings: { topUpSendMs, arrivalMs } },
    };
  } finally {
    funding = false;
  }
}

/**
 * The owner's rule (2026-10-03): a top-up is fee-free only because the buy it
 * funds pays. When the money arrived and no buy was made with it, bill it as
 * an ordinary move. Returns the sentence to append to a failure, or ''.
 */
export async function billUnspentTopUp(f: FundedTopUp, host: AioBuyHost): Promise<string> {
  const fee = await host.chargeMoveFee(f.from, f.to, f.inAmount, f.outAmount).catch(() => null);
  return fee ? ` As the buy did not go through, the top-up counts as a move between chains: Krypt's fee of ${fee.amount.toPrecision(3)} ${fee.symbol} was charged.` : '';
}

/**
 * Top up (if needed) and buy. One at a time per chain — a double click must
 * never become two top-ups. The plan the page showed is used while it is
 * fresh; past that, a new one is made, and if the new one needs a yes the
 * user gets asked again rather than moved on a stale answer.
 */
export async function execute(
  req: { chain: AioChain; token: string; amount: number; quoteId?: string | null; acceptAsk?: boolean },
  host: AioBuyHost,
): Promise<AioBuyResult> {
  if (busy.has(req.chain)) return { ok: false, message: `A buy on ${AIO_CHAIN_LABEL[req.chain]} is already being funded — wait for it.` };
  busy.add(req.chain);
  try {
    let p = req.quoteId ? recentPlans.get(req.quoteId) ?? null : null;
    const shown = p;
    const usable =
      p !== null && p.chain === req.chain && p.amount === req.amount && (p.kind === 'convert' || p.kind === 'ask') && !!p.convert && p.convert.expiresAt > host.now() + PLAN_MIN_LIFE_MS;
    if (!usable) p = await plan({ chain: req.chain, amount: req.amount }, host);
    if (!p) return { ok: false, message: 'Could not plan this buy.' };
    // A yes given to the plan on screen covers its re-made twin — same source,
    // about the same cost — instead of asking the same question twice.
    const yesCarries =
      !usable && req.acceptAsk === true && p.kind === 'ask' && !!p.convert && !!shown?.convert &&
      shown.convert.from === p.convert.from &&
      (p.convert.costPct ?? Infinity) <= (shown.convert.costPct ?? -Infinity) + 0.5;
    if (p.kind === 'off' || p.kind === 'direct') {
      const t0 = host.now();
      const r = await host.buy(req.chain, req.token, req.amount, null);
      return { ...r, timings: { buyMs: host.now() - t0 } };
    }
    if (p.kind === 'refuse') return { ok: false, message: p.message };
    if (p.kind === 'ask' && !(req.acceptAsk && (usable || yesCarries))) {
      return { ok: false, message: 'This top-up costs more than usual — confirm it first.', needsConfirm: p };
    }
    const t = await topUpAndWait(p, req, host);
    if (t.kind === 'stopped') return t.result;
    const f = t.funded;
    const t2 = host.now();
    const bought = await host.buy(req.chain, req.token, req.amount, f.seen);
    const buyMs = host.now() - t2;
    const timing = `top-up ${(f.timings.topUpSendMs / 1000).toFixed(1)}s + arrival ${(f.timings.arrivalMs / 1000).toFixed(1)}s + buy ${(buyMs / 1000).toFixed(1)}s`;
    if (bought.ok) {
      return { ok: true, message: `${bought.message} (funded from ${AIO_CHAIN_LABEL[f.from]}: ${timing})`, timings: { ...f.timings, buyMs }, topUpTx: f.topUpTx };
    }
    // Sent but not confirmed in time: it may still land, with its own fee.
    // Billing the top-up now charged the fee twice when it did, and told the
    // user it had failed (v6 audit 2026-10-03). Not billed; said as it is.
    if (bought.pending) {
      return {
        ok: false,
        stage: 'pending',
        message: `Topped up from ${AIO_CHAIN_LABEL[f.from]}; the buy was sent but is not confirmed yet — check Trades in a minute. ${bought.message}`,
        timings: { ...f.timings, buyMs },
        topUpTx: f.topUpTx,
      };
    }
    // The money moved and no buy paid for it: an ordinary move, billed as one.
    const feeLine = await billUnspentTopUp(f, host);
    return {
      ok: false,
      message: `Topped up from ${AIO_CHAIN_LABEL[f.from]}, but the buy failed: ${bought.message} The funds are on ${AIO_CHAIN_LABEL[req.chain]}.${feeLine}`,
      timings: { ...f.timings, buyMs },
      topUpTx: f.topUpTx,
    };
  } finally {
    busy.delete(req.chain);
  }
}

/**
 * For a SCRIPT's buy (2026-10-03): make sure `chain` holds enough for a buy
 * of `amount`, topping it up from the user's other chains if not — and
 * nothing more. The buy itself is then the script's own, through every guard
 * a script buy has (budget, loss stop, cool-off, sizes). Unattended rules:
 * a top-up that costs more than the ceiling is REFUSED, never accepted.
 *   · funded: null → nothing needed moving (or the wallet is off);
 *   · funded: {...} → a top-up arrived; if the buy then fails, the caller
 *     bills it with `billUnspentTopUp` (the owner's rule).
 */
export async function fundForBuy(
  req: { chain: AioChain; amount: number },
  host: AioBuyHost,
): Promise<{ ok: boolean; message: string; funded: FundedTopUp | null }> {
  if (busy.has(req.chain)) return { ok: false, message: `A buy on ${AIO_CHAIN_LABEL[req.chain]} is already being funded.`, funded: null };
  busy.add(req.chain);
  try {
    const p = await plan({ chain: req.chain, amount: req.amount }, host);
    if (p.kind === 'off' || p.kind === 'direct') return { ok: true, message: p.message, funded: null };
    if (p.kind === 'refuse') return { ok: false, message: p.message, funded: null };
    if (p.kind === 'ask') {
      return {
        ok: false,
        message: `the top-up would cost ${p.convert?.costPct !== null && p.convert?.costPct !== undefined ? `${p.convert.costPct.toFixed(1)}%` : 'an unknown share'} of what it moves — over the ceiling an unattended buy may pay, so nothing moved`,
        funded: null,
      };
    }
    const t = await topUpAndWait(p, req, host);
    if (t.kind === 'stopped') return { ok: false, message: t.result.message, funded: null };
    return { ok: true, message: `topped up from ${AIO_CHAIN_LABEL[t.funded.from]}`, funded: t.funded };
  } finally {
    busy.delete(req.chain);
  }
}
