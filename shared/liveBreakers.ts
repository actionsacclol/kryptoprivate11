// Pure decision rules for REAL-money execution. No I/O; the engine feeds
// them state and acts on the answer. Kept out of the engine so each rule is
// pinned by a test (test/livebreakers.test.mjs), the way the order-safety
// rules are.

/**
 * May a sell that did not confirm be rebuilt and re-sent?
 *
 * Only a 100% sell: a re-sent full sell of an already-sold bag has nothing to
 * sell and dies in simulation, so it cannot double-spend. A PARTIAL sell is
 * resolved against the balance at build time — if the first tx lands late,
 * a retried "50%" sells 50% of what is LEFT, i.e. 75% of the original bag.
 * And a `pending` result (not landed, not provably dead) is never retried for
 * any amount: the first tx may still land.
 */
/**
 * Slippage for the SECOND attempt at an exit that did not land.
 *
 * The first attempt goes at the user's setting (floored at 15 %), which is
 * the right price for an ordinary exit. If that fails to land, the position
 * is still open and the market has already proved it is moving faster than
 * that — so the retry accepts a worse fill rather than leaving someone in a
 * token they asked to leave. Bounded at 50 %: past that a "fill" is a
 * donation, and the honest answer becomes "this did not sell, here is why".
 */
export function escalatedSellSlippagePct(current: number): number {
  const base = Number.isFinite(current) && current > 0 ? current : 15;
  return Math.min(50, Math.max(35, Math.round(base * 2.5)));
}

export function shouldRetrySell(
  amount: number | string,
  res: { ok: boolean; stage: string },
): boolean {
  if (res.ok) return false;
  if (res.stage !== 'send' && res.stage !== 'confirm') return false;
  return amount === '100%' || amount === 100;
}

/**
 * Consecutive-loss counter fed from REALISED sell PnL. Unknown PnL (null —
 * no cost basis) changes nothing: a breaker must not count a guess, in
 * either direction. Break-even is not a loss.
 */
export function nextConsecutiveLosses(prev: number, realizedPnlSol: number | null): number {
  if (realizedPnlSol === null || !Number.isFinite(realizedPnlSol)) return prev;
  if (realizedPnlSol < 0) return prev + 1;
  if (realizedPnlSol > 0) return 0;
  return prev;
}

export interface LiveBreakerState {
  /** Real SOL lost this live session (negative = up). */
  sessionLossSol: number;
  consecutiveLosses: number;
  /** A non-market hard stop (decoder drift, program redeploy). */
  hardPauseReason: string | null;
}

export interface LiveBreakerLimits {
  maxLiveSessionLossSol: number;
  maxLiveConsecutiveLosses: number;
}

/**
 * Why a real BUY must not go out right now, or null. Applies to buys only —
 * a breaker that refuses an exit turns a loss limit into a trap, so sells
 * never consult this.
 */
export function liveBreakerReason(st: LiveBreakerState, lim: LiveBreakerLimits): string | null {
  if (st.hardPauseReason) return st.hardPauseReason;
  if (lim.maxLiveSessionLossSol > 0 && st.sessionLossSol >= lim.maxLiveSessionLossSol)
    return `Live loss limit hit (−${lim.maxLiveSessionLossSol} SOL real)`;
  if (lim.maxLiveConsecutiveLosses > 0 && st.consecutiveLosses >= lim.maxLiveConsecutiveLosses)
    return `${lim.maxLiveConsecutiveLosses} live losses in a row`;
  return null;
}
