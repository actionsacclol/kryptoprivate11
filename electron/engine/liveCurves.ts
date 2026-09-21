// What the feed already knows about EVERY pump curve and every migration —
// the Discover columns' free source (2026-09-20).
//
// The scanner's program socket hears every pump.fun trade, on every mint,
// whether or not this session saw the mint created. Until now a trade on an
// untracked mint was dropped on the floor, and the Graduating and Migrated
// columns bought their rows from pump.fun's list routes — the same host
// that 429s this app around the clock. But each trade event carries the
// curve's virtual reserves, which IS the progress and the price, and each
// AMM migration event names the mint and its pool. So this module keeps
// two small, bounded books:
//
//   LiveCurves      mint → last reserves + last trade time, for every curve
//                   trading right now. `graduating(n)` is the curves closest
//                   to graduation that traded recently — pump.fun's own
//                   "about to graduate" list, computed locally, seconds
//                   fresh, zero requests.
//   LiveMigrations  the migrations seen, newest first — pump.fun's
//                   "migrated" list, same deal.
//
// Neither book fetches anything. The rows they seed still get their name,
// exact reserves and real SOL from one batched chain read (data/pumpChain)
// and their image and holders from the batched Jupiter route, so nothing a
// user saw before goes missing — only the parked provider does.
//
// Pure and injectable-clock, so the ordering, the completion rule, the idle
// cut-off and the caps are pinned by test/livecurves.test.mjs.

import { CURVE_COMPLETE_VIRTUAL_TOKENS, curveProgressTokenPct } from './curve';

export interface LiveCurve {
  mint: string;
  vSol: bigint;
  vTok: bigint;
  /** The creator, when the trade event carried it (older events do not). */
  creator: string | null;
  /** Trades seen for this mint since the book first saw it. */
  trades: number;
  firstSeenAt: number;
  lastTradeAt: number;
  /** Token-side progress 0..100 as of the last trade. */
  progressPct: number;
  complete: boolean;
}

export interface LiveMigration {
  mint: string;
  pool: string;
  /** Lamports seeded into the pool, when the event said. */
  solSeeded: bigint | null;
  detectedAt: number;
}

/** Curves remembered at most. Pump trades on a few thousand distinct mints
 *  an hour; the idle cut-off keeps the live set far below this. */
export const LIVE_CURVES_CAP = 20_000;
/** A curve nobody has traded for this long is not "graduating" today. */
export const GRADUATING_MAX_IDLE_MS = 15 * 60_000;
/** Below this the curve is a launch, not a graduation candidate. pump's own
 *  list is sorted by market cap among incomplete coins; the equivalent on a
 *  curve is progress, and a coin under a fifth sold is nowhere near. */
export const GRADUATING_MIN_PCT = 20;
/** Migrations remembered. ~1–3 a minute on pump; a day is plenty. */
export const LIVE_MIGRATIONS_CAP = 2_000;
/** Idle entries are swept this often (in notes), not on every note. */
const SWEEP_EVERY = 500;
const IDLE_EVICT_MS = 60 * 60_000;

export class LiveCurves {
  private readonly curves = new Map<string, LiveCurve>();
  private notes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** One decoded trade. Cheap: a map write. */
  note(mint: string, vSol: bigint, vTok: bigint, creator: string | null, at: number = this.now()): void {
    if (!mint) return;
    const cur = this.curves.get(mint);
    const complete = vTok <= CURVE_COMPLETE_VIRTUAL_TOKENS;
    if (cur) {
      // Out-of-order arrival (the racing pool delivers late copies): an
      // older trade must not move the reserves backwards.
      if (at < cur.lastTradeAt) {
        cur.trades += 1;
        return;
      }
      this.curves.delete(mint); // re-insert so Map order is recency
      cur.vSol = vSol;
      cur.vTok = vTok;
      cur.creator = cur.creator ?? creator;
      cur.trades += 1;
      cur.lastTradeAt = at;
      cur.progressPct = curveProgressTokenPct(vTok);
      cur.complete = cur.complete || complete;
      this.curves.set(mint, cur);
    } else {
      this.curves.set(mint, {
        mint,
        vSol,
        vTok,
        creator,
        trades: 1,
        firstSeenAt: at,
        lastTradeAt: at,
        progressPct: curveProgressTokenPct(vTok),
        complete,
      });
    }
    if (++this.notes % SWEEP_EVERY === 0) this.sweep(at);
    while (this.curves.size > LIVE_CURVES_CAP) {
      const oldest = this.curves.keys().next().value;
      if (oldest === undefined) break;
      this.curves.delete(oldest);
    }
  }

  /** The curve finished (complete event, or its migration was seen). */
  complete(mint: string): void {
    const cur = this.curves.get(mint);
    if (cur) cur.complete = true;
  }

  get(mint: string): LiveCurve | null {
    return this.curves.get(mint) ?? null;
  }

  get size(): number {
    return this.curves.size;
  }

  /**
   * The curves closest to graduating that are still trading: incomplete,
   * traded within `maxIdleMs`, at or above `minPct`, most progressed first.
   * Ties (two curves at 100 % waiting on the migration crank) go to the one
   * traded most recently.
   */
  graduating(limit: number, opts: { minPct?: number; maxIdleMs?: number; now?: number } = {}): LiveCurve[] {
    const minPct = opts.minPct ?? GRADUATING_MIN_PCT;
    const maxIdle = opts.maxIdleMs ?? GRADUATING_MAX_IDLE_MS;
    const now = opts.now ?? this.now();
    const out: LiveCurve[] = [];
    for (const c of this.curves.values()) {
      if (c.complete || c.progressPct < minPct) continue;
      if (now - c.lastTradeAt > maxIdle) continue;
      out.push(c);
    }
    out.sort((a, b) => b.progressPct - a.progressPct || b.lastTradeAt - a.lastTradeAt);
    return out.slice(0, Math.max(0, limit));
  }

  /** Drop what nobody has traded for an hour. */
  sweep(now: number = this.now()): number {
    let dropped = 0;
    for (const [mint, c] of this.curves) {
      if (now - c.lastTradeAt > IDLE_EVICT_MS) {
        this.curves.delete(mint);
        dropped++;
      }
    }
    return dropped;
  }

  clear(): void {
    this.curves.clear();
    this.notes = 0;
  }
}

export class LiveMigrations {
  private list: LiveMigration[] = [];
  private readonly seen = new Set<string>();

  note(mint: string, pool: string, solSeeded: bigint | null, detectedAt: number): void {
    if (!mint || !pool || this.seen.has(mint)) return;
    this.seen.add(mint);
    this.list.unshift({ mint, pool, solSeeded, detectedAt });
    if (this.list.length > LIVE_MIGRATIONS_CAP) {
      const gone = this.list.splice(LIVE_MIGRATIONS_CAP);
      for (const g of gone) this.seen.delete(g.mint);
    }
  }

  /** Newest first. */
  recent(limit: number): LiveMigration[] {
    return this.list.slice(0, Math.max(0, limit));
  }

  has(mint: string): boolean {
    return this.seen.has(mint);
  }

  get size(): number {
    return this.list.length;
  }

  clear(): void {
    this.list = [];
    this.seen.clear();
  }
}
