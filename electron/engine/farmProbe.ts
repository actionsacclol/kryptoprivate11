// The round-trip friction probe.
//
// Quote WSOL -> M for S lamports, then quote M -> WSOL for exactly what came
// back. `1 - back/S` is the ENTIRE immediate friction of a round trip at that
// size, on the route that would actually execute: spread, both price impacts,
// both LP fees, in one unbiased number with no modelling.
//
// It needs no wallet, signs nothing and spends nothing. Two quote calls.
//
// ─── Why this exists at all ───────────────────────────────────────────
//
// The farming page used to GUESS its costs — a 0.25%/side pool fee and a
// 0.05%/side slippage term, both invented. Measured, the pool fee was 0.30%
// and on a fresh pump pool 1.20%, while a real established pair is 0.000%.
// The guess was wrong by two orders of magnitude in the direction that makes
// a feature look viable when it is not. So the page no longer guesses: it
// measures, or it shows nothing and says why.
//
// ─── What it does NOT measure ─────────────────────────────────────────
//
// A quote is not a fill. Jupiter routes much of this to RFQ market makers who
// quote tight and may fill wider, and the quote carries no priority fee. It is
// also INSTANTANEOUS: it prices buying and selling back in the same breath,
// so it contains no directional risk. A farming run that holds for twenty
// seconds takes a price move that is zero-mean on a deep pair but is not
// zero-variance. Both caveats belong on screen next to the number.

import { getJson } from '../data/http';

/** Wrapped SOL — the quote leg every probe starts and ends on. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Pairs deep enough to be worth farming, measured 2026-09-14. The friction
 *  shown is the round trip at 10 SOL; it is a starting point for the picker,
 *  never a substitute for probing the pair you will actually trade. */
export const SUGGESTED_PAIRS: Array<{ symbol: string; mint: string; note: string }> = [
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', note: 'deepest pair on Solana; measured ~0.00%' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', note: 'measured ~0.00%' },
  { symbol: 'JitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', note: 'flat ~0.002% to 100 SOL' },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', note: 'measured ~0.08%' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', note: 'measured 0.07% at 1 SOL, 0.63% at 100' },
];

interface QuoteResponse {
  outAmount?: string;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  /** Round-trip friction in PERCENT, or null when it could not be measured. */
  frictionPct: number | null;
  /** Venues the two legs would route through — worth seeing, because an RFQ
   *  maker quoting tight is not the same promise as an AMM pool. */
  route: string;
  sizeSol: number;
}

const label = (q: QuoteResponse | undefined): string[] =>
  (q?.routePlan ?? []).map((p) => p.swapInfo?.label ?? '').filter(Boolean);

/**
 * Measure one round trip. Never throws; a failure comes back as ok:false with
 * frictionPct null, because "we could not measure it" must never render as a
 * zero — a zero here reads as "free", which is the most expensive possible lie
 * on this page.
 */
export async function probeRoundTrip(mint: string, sizeSol: number): Promise<ProbeResult> {
  const out: ProbeResult = { ok: false, message: '', frictionPct: null, route: '', sizeSol };
  const m = (mint ?? '').trim();
  if (!m || m === WSOL_MINT) {
    out.message = 'Pick a token other than SOL to trade against.';
    return out;
  }
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    out.message = 'Trade size must be above zero.';
    return out;
  }
  const lamports = Math.round(sizeSol * 1e9);
  const q = (i: string, o: string, a: string | number): string =>
    `/swap/v1/quote?inputMint=${i}&outputMint=${o}&amount=${a}&slippageBps=50`;

  try {
    const legA = await getJson<QuoteResponse>('jupiter', q(WSOL_MINT, m, lamports), { priority: false, timeoutMs: 8_000 });
    if (!legA.ok || !legA.data?.outAmount) {
      out.message = `Could not quote SOL into that token: ${legA.message || 'no route'}`;
      return out;
    }
    const legB = await getJson<QuoteResponse>('jupiter', q(m, WSOL_MINT, legA.data.outAmount), { priority: false, timeoutMs: 8_000 });
    if (!legB.ok || !legB.data?.outAmount) {
      out.message = `Could not quote that token back into SOL: ${legB.message || 'no route'}`;
      return out;
    }
    const back = Number(legB.data.outAmount);
    if (!Number.isFinite(back) || back <= 0) {
      out.message = 'The return quote did not parse.';
      return out;
    }
    // The whole thing, in one number. A tiny negative is quote noise around
    // zero on a very deep pair, not free money — it is reported as measured
    // rather than clamped, because clamping would hide how noisy it is.
    out.frictionPct = (1 - back / lamports) * 100;
    out.route = [...new Set([...label(legA.data), ...label(legB.data)])].join(', ');
    out.ok = true;
    out.message = `Measured ${out.frictionPct.toFixed(4)}% round-trip friction at ${sizeSol} SOL.`;
    return out;
  } catch (e) {
    out.message = (e as Error)?.message ?? 'The probe failed.';
    return out;
  }
}
