// Feed-health estimator — reserve-continuity check.
//
// The 2026-07-21 tape analysis (docs/tape-analysis-2026-07-21.md) found ~20%
// of trade events were silently dropped by the public websocket under load.
// The fingerprint of a dropped event: two consecutive trades we DID receive
// for a mint whose virtual-SOL reserves moved by far more than the second
// trade's own SOL amount — the gap is the missing trade(s). A buy adds
// exactly solAmount to vSol; a sell removes it (the ≤1% fee sits inside the
// tolerance). This tracker applies that test live so the engine can surface
// an estimated event-loss rate and alarm when the feed degrades — corrupted
// flow features were one of the ways the old backtest edge turned out fake.
//
// Deliberately float-free on the money path: all comparisons are bigint.

/** Sub-tolerance absolute slack: 0.05 SOL in lamports. Covers fee rounding. */
const ABS_TOLERANCE_LAMPORTS = 50_000_000n;
/** Relative slack: 10% of the expected reserve delta. */
const REL_TOLERANCE_DIV = 10n;
/** Per-mint baseline cap — oldest evicted first (Map preserves insert order). */
const MINT_CAP = 4_096;
/** Rolling estimate window. */
const WINDOW_MS = 15 * 60_000;
/** Below this many checks the loss estimate is statistically meaningless. */
const MIN_CHECKS_FOR_ESTIMATE = 200;

export type ContinuityResult = 'first' | 'ok' | 'mismatch' | 'stale';

interface MinuteBucket {
  minute: number;
  checked: number;
  mismatched: number;
  stale: number;
}

export interface ContinuitySnapshot {
  /** Consecutive-trade checks performed in the window. */
  checked: number;
  /** Checks whose reserve delta didn't match the trade (≈ dropped events). */
  mismatched: number;
  /** Estimated event-loss %, or null until enough checks accumulate. */
  lossPct: number | null;
  /**
   * Arrivals skipped because they were provably out of order.
   *
   * Diagnostic, not a fault: a late event is one we HAVE. A high number next
   * to a low loss rate means the racing pool is doing its job — several
   * sockets, different latencies, and the slow one's copy arriving after the
   * fast one's successor.
   */
  stale: number;
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export class ReserveContinuity {
  private lastVSol = new Map<string, bigint>();
  /** mint -> the highest slot observed for it, 0 when unknown. */
  private lastSlot = new Map<string, number>();
  private buckets: MinuteBucket[] = [];

  /**
   * Feed one decoded trade event. Returns what the check concluded.
   *
   * `slot` is what makes the answer trustworthy, and it was missing until
   * 2026-09-14. This check compares a trade's reserves against the LAST
   * trade seen for the mint, which is only a loss test if the two actually
   * arrived in chain order — and nothing guarantees that:
   *
   *   * the feed races several sockets and takes whichever delivers a
   *     signature first, so two trades can come from two sockets with
   *     different latencies and land inverted;
   *   * the block-feed standby runs ~200 ms behind the log path and wins
   *     whenever the log path drops one;
   *   * the priority socket runs ~150 ms AHEAD for held mints.
   *
   * An inverted pair fails the reserve test exactly like a dropped event
   * does, so every inversion was being counted as loss. That inflates the
   * one number the "feed losing ~N% of events" warning is built on — the
   * app was telling users to go fix their RPC because its own racing pool
   * was working.
   *
   * A provably older slot is therefore skipped, and does NOT become the new
   * baseline: it is a stale view of a mint we have already seen further
   * along. Only a STRICTLY older slot is skipped. Trades sharing a slot are
   * still checked, because their true order is the transaction index and we
   * do not have it — under-suppressing is the safe direction for a health
   * metric, since the failure mode of over-suppressing is a warning that
   * never fires.
   */
  observe(mint: string, isBuy: boolean, solLamports: bigint, vSolAfter: bigint, slot = 0): ContinuityResult {
    const prevSlot = this.lastSlot.get(mint) ?? 0;
    if (slot > 0 && prevSlot > 0 && slot < prevSlot) {
      this.countStale();
      return 'stale';
    }
    const prev = this.lastVSol.get(mint);
    // Refresh recency ordering (delete+set) and cap the baseline map.
    if (prev !== undefined) this.lastVSol.delete(mint);
    this.lastVSol.set(mint, vSolAfter);
    if (slot > 0) this.lastSlot.set(mint, slot);
    if (this.lastVSol.size > MINT_CAP) {
      const oldest = this.lastVSol.keys().next().value;
      if (oldest !== undefined) {
        this.lastVSol.delete(oldest);
        this.lastSlot.delete(oldest);
      }
    }
    if (prev === undefined) return 'first';

    const expected = isBuy ? solLamports : -solLamports;
    const err = abs(vSolAfter - prev - expected);
    const tolerance = ABS_TOLERANCE_LAMPORTS > abs(expected) / REL_TOLERANCE_DIV
      ? ABS_TOLERANCE_LAMPORTS
      : abs(expected) / REL_TOLERANCE_DIV;
    const ok = err <= tolerance;
    this.count(ok);
    return ok ? 'ok' : 'mismatch';
  }

  private bucket(): MinuteBucket {
    const minute = Math.floor(Date.now() / 60_000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.minute !== minute) {
      b = { minute, checked: 0, mismatched: 0, stale: 0 };
      this.buckets.push(b);
      const cutoff = minute - WINDOW_MS / 60_000;
      while (this.buckets.length && this.buckets[0].minute < cutoff) this.buckets.shift();
    }
    return b;
  }

  private count(ok: boolean): void {
    const b = this.bucket();
    b.checked += 1;
    if (!ok) b.mismatched += 1;
  }

  /** A skipped arrival is NOT a check: it neither passed nor failed, and
   *  must not move the denominator the loss rate is taken over. */
  private countStale(): void {
    this.bucket().stale += 1;
  }

  snapshot(): ContinuitySnapshot {
    const cutoff = Math.floor(Date.now() / 60_000) - WINDOW_MS / 60_000;
    let checked = 0;
    let mismatched = 0;
    let stale = 0;
    for (const b of this.buckets) {
      if (b.minute < cutoff) continue;
      checked += b.checked;
      mismatched += b.mismatched;
      stale += b.stale;
    }
    return {
      checked,
      mismatched,
      stale,
      lossPct: checked >= MIN_CHECKS_FOR_ESTIMATE ? Math.round((mismatched / checked) * 1000) / 10 : null,
    };
  }

  reset(): void {
    this.lastVSol.clear();
    this.lastSlot.clear();
    this.buckets = [];
  }
}

// ── Per-mint feed liveness ────────────────────────────────────────────
//
// Everything above measures the feed as a whole. This answers a narrower
// question the orders/alerts poller asks about ONE mint: "is the curve feed
// carrying this token right now, so I can skip polling a price for it?"
//
// Until 2026-09-13 the poller answered it with `this.tokens.has(mint)` —
// membership of the launch list, which is a different question entirely. A
// GRADUATED token stays in that list (it launched recently) while its trades
// move to pump-amm, so the poller skipped it AND the curve feed no longer
// carried it: every armed order on that mint stopped being evaluated at the
// exact moment it mattered. A user watched a trailing stop freeze its peak at
// graduation and never fire. The same hole swallowed any token whose feed
// went quiet — a stopped scanner, a dropped socket, a calm market.
//
// So the test is three facts, and membership alone is none of them.

/** A tracked mint whose curve feed has gone quiet for this long is polled
 *  like any other. 30 s without a trade is ordinary for a calm token and
 *  costs one batched provider call; a blind stop-loss costs the position. */
export const CURVE_TICK_FRESH_MS = 30_000;

export interface FeedLivenessInput {
  /** Is the mint in the launch tracker at all? Evicted ⇒ nothing ticks it. */
  tracked: boolean;
  /** Has its bonding curve completed? Graduated ⇒ trades moved to the AMM
   *  and the curve feed will never carry it again. */
  curveComplete: boolean;
  /** When the curve feed last delivered a trade for it, or null if never. */
  lastTickAt: number | null;
  now: number;
}

/**
 * Is the pump curve feed actually ticking this mint right now?
 *
 * `false` is the safe answer in every uncertain case: it only means "poll a
 * price for this one", which costs a slot in a batched call. `true` means
 * "no need" — and being wrong about that is what blinds an armed order.
 */
export function curveFeedIsTicking(i: FeedLivenessInput): boolean {
  if (!i.tracked) return false;
  if (i.curveComplete) return false;
  if (i.lastTickAt === null) return false;
  return i.now - i.lastTickAt < CURVE_TICK_FRESH_MS;
}
