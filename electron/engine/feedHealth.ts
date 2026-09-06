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

export type ContinuityResult = 'first' | 'ok' | 'mismatch';

interface MinuteBucket {
  minute: number;
  checked: number;
  mismatched: number;
}

export interface ContinuitySnapshot {
  /** Consecutive-trade checks performed in the window. */
  checked: number;
  /** Checks whose reserve delta didn't match the trade (≈ dropped events). */
  mismatched: number;
  /** Estimated event-loss %, or null until enough checks accumulate. */
  lossPct: number | null;
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export class ReserveContinuity {
  private lastVSol = new Map<string, bigint>();
  private buckets: MinuteBucket[] = [];

  /** Feed one decoded trade event. Returns what the check concluded. */
  observe(mint: string, isBuy: boolean, solLamports: bigint, vSolAfter: bigint): ContinuityResult {
    const prev = this.lastVSol.get(mint);
    // Refresh recency ordering (delete+set) and cap the baseline map.
    if (prev !== undefined) this.lastVSol.delete(mint);
    this.lastVSol.set(mint, vSolAfter);
    if (this.lastVSol.size > MINT_CAP) {
      const oldest = this.lastVSol.keys().next().value;
      if (oldest !== undefined) this.lastVSol.delete(oldest);
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

  private count(ok: boolean): void {
    const minute = Math.floor(Date.now() / 60_000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.minute !== minute) {
      b = { minute, checked: 0, mismatched: 0 };
      this.buckets.push(b);
      const cutoff = minute - WINDOW_MS / 60_000;
      while (this.buckets.length && this.buckets[0].minute < cutoff) this.buckets.shift();
    }
    b.checked += 1;
    if (!ok) b.mismatched += 1;
  }

  snapshot(): ContinuitySnapshot {
    const cutoff = Math.floor(Date.now() / 60_000) - WINDOW_MS / 60_000;
    let checked = 0;
    let mismatched = 0;
    for (const b of this.buckets) {
      if (b.minute < cutoff) continue;
      checked += b.checked;
      mismatched += b.mismatched;
    }
    return {
      checked,
      mismatched,
      lossPct: checked >= MIN_CHECKS_FOR_ESTIMATE ? Math.round((mismatched / checked) * 1000) / 10 : null,
    };
  }

  reset(): void {
    this.lastVSol.clear();
    this.buckets = [];
  }
}
