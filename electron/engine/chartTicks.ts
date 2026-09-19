// Live chart ticks — the per-mint throttle between the trade firehose and the
// renderer's chart.
//
// A hot pump token trades 30x a second. The chart reads as live at about 8
// updates a second, so within each 125 ms window the volume is summed and the
// last price and side win. Gated on the tape subscription — the same "this
// mint is open" signal that gates tape recording — so the firehose costs
// nothing when nobody is looking at a chart.
//
// Lifted out of engine.ts unchanged (2026-09-18). It was ~70 lines of timers
// and a bounded Map in a 5,763-line class, related to nothing around it, and
// it needs exactly two things from its host: somewhere to emit, and a way to
// ask whether a mint is still open. Both are injected, which is also what
// makes it testable without a tape or an engine.

import type { EngineEvent } from '@shared/types';

/** Chart reads as live at ~8 updates a second; anything faster is spent on
 *  frames nobody can see. */
const GAP_MS = 125;

/**
 * How many mints keep tick state.
 *
 * It tracks the tape's own small subscription budget rather than growing with
 * everything that ever traded: when the map is full, state for mints that are
 * no longer open is dropped before a new one is added.
 */
const MAX_TRACKED = 16;

interface Pending {
  time: number;
  priceSol: number;
  volSol: number;
  isBuy: boolean;
}

interface MintState {
  lastEmitAt: number;
  pending: Pending | null;
  timer: NodeJS.Timeout | null;
}

export interface ChartTickHost {
  /** Where a throttled tick goes. */
  emit: (ev: EngineEvent) => void;
  /** Is this mint still open in the terminal? Ticks for anything else are
   *  dropped rather than queued. */
  isOpen: (mint: string) => boolean;
}

export interface ChartTicks {
  /** A live trade. `priceSol` is SOL per token; `volSol` is the SOL that
   *  changed hands. Throttled to <=8/s per mint. */
  push(mint: string, atMs: number, priceSol: number, volSol: number, isBuy: boolean): void;
  /** Drop every pending tick and timer — the scanner stopping, or a reset. */
  clear(): void;
  /** Mints currently holding state. Diagnostics only. */
  size(): number;
}

export function createChartTicks(host: ChartTickHost): ChartTicks {
  const mints = new Map<string, MintState>();

  function flush(mint: string, s: MintState): void {
    const p = s.pending;
    s.pending = null;
    s.lastEmitAt = Date.now();
    // Re-checked at flush time, not only on the way in: a mint can be closed
    // while a tick is waiting out its 125 ms, and a tick for a chart nobody
    // has open is a message the renderer has to route and then discard.
    if (!p || !host.isOpen(mint)) return;
    host.emit({ kind: 'tick', mint, time: p.time, priceSol: p.priceSol, volSol: p.volSol, isBuy: p.isBuy });
  }

  return {
    push(mint, atMs, priceSol, volSol, isBuy) {
      if (!host.isOpen(mint)) return;
      // A non-positive or unreadable price is not a cheap tick, it is a wrong
      // one — it would draw a candle at a price nothing traded at.
      if (!Number.isFinite(priceSol) || priceSol <= 0) return;
      let s = mints.get(mint);
      if (!s) {
        if (mints.size >= MAX_TRACKED) {
          for (const [m, st] of mints) {
            if (!host.isOpen(m)) {
              if (st.timer) clearTimeout(st.timer);
              mints.delete(m);
            }
          }
        }
        s = { lastEmitAt: 0, pending: null, timer: null };
        mints.set(mint, s);
      }
      if (s.pending) {
        s.pending.time = Math.floor(atMs / 1000);
        s.pending.priceSol = priceSol;
        s.pending.volSol += volSol;
        s.pending.isBuy = isBuy;
      } else {
        s.pending = { time: Math.floor(atMs / 1000), priceSol, volSol, isBuy };
      }
      if (s.timer) return; // a flush is already scheduled and will carry this trade
      const wait = s.lastEmitAt + GAP_MS - Date.now();
      if (wait <= 0) {
        flush(mint, s);
      } else {
        const state = s;
        state.timer = setTimeout(() => {
          state.timer = null;
          flush(mint, state);
        }, wait);
      }
    },

    clear() {
      for (const s of mints.values()) {
        if (s.timer) clearTimeout(s.timer);
      }
      mints.clear();
    },

    size() {
      return mints.size;
    },
  };
}
