// Launch tape — the affordable recorder mode.
//
// The firehose measured 15 GB/day (2026-08-25). Nearly all of it is mature
// tokens trading for hours and post-graduation PumpSwap payloads, none of
// which the launch dataset (scripts/analysis/build_launchset_*.py) reads.
// What that dataset needs per pump mint is small and bounded:
//
//   - the create event                          (always)
//   - its trades for the first 30 min           (capped per mint)
//   - the complete / migration event            (always, whenever it lands)
//   - feed_health / decoder_drift / lifecycle    (always — they are the
//     "was this tape healthy" evidence an analyst checks before trusting it)
//   - metadata (socials)                        (always — one row per mint)
//
// This module is a pure filter over the recorder's `record(kind, payload)`
// stream. It never writes; recorder.ts asks it `accept()` and keeps writing
// the same JSONL envelope, so the Python builder reads launch-mode day files
// unchanged. Kinds are matched with and without the `tape_` prefix, so the
// engine's own `create`/`trade`/`complete` echoes follow the same rule.
//
// Everything is bounded: a Map of at most `maxMints` windows, evicted when
// older than `windowMs` (or oldest-first when full). Malformed payloads are
// dropped (or kept, for always-kept kinds) — this code sits on the hot path
// and must never throw.

export type LaunchDecision = 'keep' | 'drop';

export interface LaunchFilterOptions {
  /** Window after the create inside which a mint's trades are kept. */
  windowMs?: number;
  /** Ceiling on kept trades per mint inside the window. */
  maxTradesPerMint?: number;
  /** Ceiling on tracked mint windows (oldest evicted first). */
  maxMints?: number;
}

export const LAUNCH_WINDOW_MS = 30 * 60_000;
export const LAUNCH_MAX_TRADES_PER_MINT = 3_000;
export const LAUNCH_MAX_MINTS = 20_000;

/** Kinds that are always kept, regardless of mint state. Small and rare. */
const ALWAYS_KEEP: ReadonlySet<string> = new Set([
  'create',
  'complete',
  'migrated',
  'metadata',
  'feed_health',
  'decoder_drift',
  'engine_start',
  'engine_stop',
  'armed',
  'disarmed',
  'program_upgrade',
]);

interface MintWindow {
  start: number;
  /** Kept trades per exact kind — `tape_trade` (market truth) and the
   *  engine's bare `trade` echo are capped separately, so the echo can never
   *  eat the tape's budget. */
  trades: Record<string, number>;
  capped: boolean;
}

export interface LaunchFilterStats {
  /** Mint windows currently tracked. */
  mints: number;
  /** Mints whose trade cap was reached (cumulative since reset). */
  cappedMints: number;
  /** Windows evicted because they aged out or the map was full. */
  evicted: number;
  kept: Record<string, number>;
  dropped: Record<string, number>;
}

/** `tape_trade` → `trade`, `trade` → `trade`. */
export function baseKind(kind: string): string {
  return kind.startsWith('tape_') ? kind.slice(5) : kind;
}

function mintOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const m = (payload as { mint?: unknown }).mint;
  return typeof m === 'string' && m.length > 0 ? m : null;
}

function timeOf(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const r = (payload as { receivedAt?: unknown }).receivedAt;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}

export class LaunchFilter {
  private readonly windowMs: number;
  private readonly maxTrades: number;
  private readonly maxMints: number;
  private windows = new Map<string, MintWindow>();
  private kept: Record<string, number> = {};
  private dropped: Record<string, number> = {};
  private cappedMints = 0;
  private evicted = 0;
  private lastSweep = 0;
  private sinceSweep = 0;

  constructor(opts: LaunchFilterOptions = {}) {
    this.windowMs = Math.max(1_000, opts.windowMs ?? LAUNCH_WINDOW_MS);
    this.maxTrades = Math.max(1, opts.maxTradesPerMint ?? LAUNCH_MAX_TRADES_PER_MINT);
    this.maxMints = Math.max(1, opts.maxMints ?? LAUNCH_MAX_MINTS);
  }

  /** The configuration, for the `engine_start` row so an analyst can see
   *  exactly what was censored. */
  config(): { windowMs: number; maxTradesPerMint: number; maxMints: number } {
    return { windowMs: this.windowMs, maxTradesPerMint: this.maxTrades, maxMints: this.maxMints };
  }

  /**
   * Decide whether a record is kept. `now` defaults to the payload's
   * `receivedAt` (the feed's own clock, same one the builder offsets by) and
   * falls back to the wall clock.
   */
  accept(kind: string, payload: unknown, now?: number): boolean {
    try {
      const ok = this.decide(kind, payload, now);
      const table = ok ? this.kept : this.dropped;
      table[kind] = (table[kind] ?? 0) + 1;
      return ok;
    } catch {
      // A filter bug must never cost a record of an always-kept kind, and
      // must never throw into the engine.
      return ALWAYS_KEEP.has(baseKind(String(kind)));
    }
  }

  private decide(kind: string, payload: unknown, nowArg?: number): boolean {
    const base = baseKind(typeof kind === 'string' ? kind : String(kind));
    const now = nowArg ?? timeOf(payload) ?? Date.now();
    this.maybeSweep(now);

    if (base === 'create') {
      const mint = mintOf(payload);
      if (mint && !this.windows.has(mint)) {
        if (this.windows.size >= this.maxMints) this.evictOldest();
        this.windows.set(mint, { start: now, trades: {}, capped: false });
      }
      return true;
    }
    if (base === 'trade') {
      const mint = mintOf(payload);
      if (!mint) return false;
      const w = this.windows.get(mint);
      if (!w) return false;
      if (now - w.start > this.windowMs) {
        this.windows.delete(mint);
        this.evicted++;
        return false;
      }
      const n = w.trades[kind] ?? 0;
      if (n >= this.maxTrades) {
        if (!w.capped) {
          w.capped = true;
          this.cappedMints++;
        }
        return false;
      }
      w.trades[kind] = n + 1;
      return true;
    }
    return ALWAYS_KEEP.has(base);
  }

  private maybeSweep(now: number): void {
    this.sinceSweep++;
    if (this.sinceSweep < 2_000 && now - this.lastSweep < 60_000) return;
    this.sinceSweep = 0;
    this.lastSweep = now;
    for (const [mint, w] of this.windows) {
      if (now - w.start > this.windowMs) {
        this.windows.delete(mint);
        this.evicted++;
      }
    }
  }

  private evictOldest(): void {
    // Map iteration is insertion order; the first key is the oldest window.
    const first = this.windows.keys().next();
    if (!first.done) {
      this.windows.delete(first.value);
      this.evicted++;
    }
  }

  /** Force a sweep at `now` (tests; also cheap enough for a timer). */
  sweep(now: number): void {
    this.sinceSweep = 2_000;
    this.maybeSweep(now);
  }

  /** Whether a mint currently has an open window (tests / stats). */
  has(mint: string): boolean {
    return this.windows.has(mint);
  }

  stats(): LaunchFilterStats {
    return {
      mints: this.windows.size,
      cappedMints: this.cappedMints,
      evicted: this.evicted,
      kept: { ...this.kept },
      dropped: { ...this.dropped },
    };
  }

  reset(): void {
    this.windows.clear();
    this.kept = {};
    this.dropped = {};
    this.cappedMints = 0;
    this.evicted = 0;
    this.lastSweep = 0;
    this.sinceSweep = 0;
  }
}
