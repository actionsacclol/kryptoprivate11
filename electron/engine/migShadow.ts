// Migration-block strategy — SHADOW ONLY.
//
// The 2026-07-25 scoping (docs/migration-block-scope-2026-07-25.md) found the
// only unconsumed value in this market sits in the migration block itself:
// position 1–2 into a fresh PumpSwap pool, 5 SOL, 5 s hold, 5% slippage cap.
// It also found (same day, one day of tape) that the profitable bucket is the
// one we cannot reach reactively — median lead from the 95% crossing to the
// migration is one block. That kill was a single-day replay. This module runs
// the same simulation forward against the live tape so the decision rests on
// live, multi-day numbers instead: every migration opens a paper position in
// three arrival lanes and books honest constant-product fills from observed
// AMM trades. Nothing here signs, sends, or touches the engine's paper book.
//
// Lanes (each an independent counterfactual, never stacked):
//   block0   — lands with the migration, before any trade (position 1 — the
//              unreachable reference the offline study priced at +4.34%).
//   react400 — lands one block after we see the migration: the best a
//              reactive sender with top-of-block priority could do.
//   react800 — conservative reactive landing.
//
// Fill semantics mirror the offline sim exactly: a lane fills at the pool
// state after every observed trade that arrived before its landing time
// (arrivalPos = that count), pays FEE per side, aborts as a free no-fill if
// price has already moved more than SLIP_CAP off the migration seed, then
// replays subsequent observed trades against its own shifted pool and sells
// after HOLD_MS. Reserves in swap events are PRE-trade (proven to 99.93% in
// docs/amm-decoder-2026-07-25.md), so the first swap's reserves are the seed.
//
// The 95%-crossing lead time is attached to every record because it was the
// decisive discriminator offline: <400 ms lead ⇒ 95.9% win at position 1,
// >30 s ⇒ dump. Offline filtering by leadMs answers the reachability question
// on forward data without re-running anything.

import type { AmmSwapEvent } from './ammDecoder';
import { curveProgressPct } from './curve';

export interface MigEvent {
  kind: 'signal' | 'exit';
  mint: string;
  detail: Record<string, unknown>;
}

const SIZE_SOL = 5; // paper size — the strat needs ~50–100 SOL working capital live
const FEE = 0.011; // per-side cost, matches the offline scoping sim
const SLIP_CAP = 0.05; // max price move off seed before we abort the fill
const HOLD_MS = 5_000;
const CROSS_PCT = 95; // curve-progress crossing that starts the lead clock
const WATCH_TTL_MS = 120_000; // migration watch lifetime
const CROSS_CAP = 20_000;
const WATCH_CAP = 512;
const L = 1e9;

const LANES = [
  { key: 'block0', delayMs: 0 },
  { key: 'react400', delayMs: 400 },
  { key: 'react800', delayMs: 800 },
] as const;

type LaneKey = (typeof LANES)[number]['key'];

interface LaneState {
  key: LaneKey;
  landAt: number;
  phase: 'pending' | 'holding' | 'done';
  // holding:
  ourBase: number;
  B: number; // shifted pool after our buy
  Q: number;
  entryPriceSol: number;
  arrivalPos: number;
  movedPct: number;
  exitDeadline: number;
  holdTrades: number;
}

interface Watch {
  mint: string;
  pool: string;
  migAt: number;
  leadMs: number | null;
  // observed pool replay (no insertion) — the state a pending lane fills at.
  B: number;
  Q: number;
  seedPx: number;
  tradesSeen: number;
  lanes: LaneState[];
}

interface LaneStats {
  fills: number;
  aborts: number;
  noFills: number;
  pnlSol: number;
  open: number;
}

export class MigShadow {
  private cross = new Map<string, number>(); // mint → first ts curvePct ≥ CROSS_PCT
  private watches = new Map<string, Watch>(); // pool → watch
  private stat = new Map<LaneKey, LaneStats>(LANES.map((l) => [l.key, { fills: 0, aborts: 0, noFills: 0, pnlSol: 0, open: 0 }] as [LaneKey, LaneStats]));

  /** Curve-side input: note the first time a mint crosses CROSS_PCT. */
  onCurveTrade(mint: string, virtualSolReserves: bigint, nowMs: number): void {
    if (this.cross.has(mint)) return;
    if (curveProgressPct(virtualSolReserves) < CROSS_PCT) return;
    this.cross.set(mint, nowMs);
    while (this.cross.size > CROSS_CAP) {
      const oldest = this.cross.keys().next().value;
      if (oldest === undefined) break;
      this.cross.delete(oldest);
    }
  }

  onMigration(mint: string, pool: string, nowMs: number): MigEvent[] {
    if (this.watches.has(pool)) return [];
    const crossAt = this.cross.get(mint);
    const leadMs = crossAt === undefined ? null : nowMs - crossAt;
    const out: MigEvent[] = [];
    while (this.watches.size >= WATCH_CAP) {
      const oldest = this.watches.keys().next().value;
      if (oldest === undefined) break;
      out.push(...this.finalize(this.watches.get(oldest)!, nowMs, 'evicted'));
      this.watches.delete(oldest);
    }
    this.watches.set(pool, {
      mint,
      pool,
      migAt: nowMs,
      leadMs,
      B: 0,
      Q: 0,
      seedPx: 0,
      tradesSeen: 0,
      lanes: LANES.map((l) => ({
        key: l.key,
        landAt: nowMs + l.delayMs,
        phase: 'pending',
        ourBase: 0,
        B: 0,
        Q: 0,
        entryPriceSol: 0,
        arrivalPos: 0,
        movedPct: 0,
        exitDeadline: 0,
        holdTrades: 0,
      })),
    });
    out.push({ kind: 'signal', mint, detail: { pool, leadMs } });
    return out;
  }

  /** A decoded swap on some pool. Ignored unless a watch is open for it. */
  onAmmSwap(e: AmmSwapEvent, nowMs: number): MigEvent[] {
    const w = this.watches.get(e.pool);
    if (!w) return [];
    const out: MigEvent[] = [];

    // Seed from the FIRST observed swap's pre-trade reserves.
    if (w.tradesSeen === 0) {
      w.B = Number(e.poolBaseReserves);
      w.Q = Number(e.poolQuoteReserves);
      if (!(w.B > 0 && w.Q > 0)) return out; // unusable pool; sweep will clear it
      w.seedPx = w.Q / w.B;
    }

    // 1) Pending lanes whose landing time has passed fill at the CURRENT
    //    observed state — i.e. after every trade that beat them in.
    for (const lane of w.lanes) {
      if (lane.phase !== 'pending' || nowMs < lane.landAt) continue;
      const moved = w.Q / w.B / w.seedPx - 1;
      lane.movedPct = moved;
      lane.arrivalPos = w.tradesSeen;
      if (moved > SLIP_CAP) {
        lane.phase = 'done';
        this.stat.get(lane.key)!.aborts++;
        out.push(this.exitRecord(w, lane, 'abort_slippage', null, null));
        continue;
      }
      const qIn = SIZE_SOL * L * (1 - FEE);
      lane.ourBase = (w.B * qIn) / (w.Q + qIn);
      lane.B = w.B - lane.ourBase;
      lane.Q = w.Q + qIn;
      lane.entryPriceSol = qIn / lane.ourBase;
      lane.exitDeadline = lane.landAt + HOLD_MS;
      lane.phase = 'holding';
      this.stat.get(lane.key)!.open++;
    }

    // 2) Holding lanes past their deadline sell BEFORE this swap applies —
    //    the state as of the hold deadline, not the future.
    for (const lane of w.lanes) {
      if (lane.phase === 'holding' && nowMs > lane.exitDeadline) out.push(this.close(w, lane, 'hold'));
    }

    // 3) Apply the swap: observed state replays raw amounts; each holding
    //    lane replays it against its own shifted pool (buys are fixed
    //    quote-in, sells fixed base-in — same as the offline sim).
    const q = Number(e.quoteAmount);
    const b = Number(e.baseAmount);
    const states: { B: number; Q: number }[] = [w, ...w.lanes.filter((l) => l.phase === 'holding')];
    for (const s of states) {
      if (!(s.B > 0 && s.Q > 0)) continue;
      if (e.isBuy) {
        const outBase = (s.B * q) / (s.Q + q);
        s.B -= outBase;
        s.Q += q;
      } else {
        const outQuote = (s.Q * b) / (s.B + b);
        s.B += b;
        s.Q -= outQuote;
      }
    }
    for (const lane of w.lanes) if (lane.phase === 'holding') lane.holdTrades++;
    w.tradesSeen++;
    return out;
  }

  /** Close expired watches: quiet pools resolve holding lanes at their last
   *  known state and record pending lanes as no-fills, so nothing sits open
   *  forever or gets booked on hope. */
  sweep(nowMs: number): MigEvent[] {
    const out: MigEvent[] = [];
    for (const [pool, w] of this.watches) {
      if (nowMs - w.migAt < WATCH_TTL_MS) continue;
      out.push(...this.finalize(w, nowMs, 'sweep'));
      this.watches.delete(pool);
    }
    return out;
  }

  stats(): { lane: LaneKey; fills: number; aborts: number; noFills: number; pnlSol: number; open: number }[] {
    return LANES.map((l) => {
      const s = this.stat.get(l.key)!;
      return { lane: l.key, fills: s.fills, aborts: s.aborts, noFills: s.noFills, pnlSol: Math.round(s.pnlSol * 1e4) / 1e4, open: s.open };
    });
  }

  private finalize(w: Watch, nowMs: number, why: 'sweep' | 'evicted'): MigEvent[] {
    const out: MigEvent[] = [];
    for (const lane of w.lanes) {
      if (lane.phase === 'holding') {
        out.push(this.close(w, lane, why));
      } else if (lane.phase === 'pending') {
        lane.phase = 'done';
        this.stat.get(lane.key)!.noFills++;
        out.push(this.exitRecord(w, lane, w.tradesSeen === 0 ? 'no_trades' : 'no_fill', null, null));
      }
    }
    return out;
  }

  private close(w: Watch, lane: LaneState, exitReason: string): MigEvent {
    const proceeds = ((lane.Q * lane.ourBase) / (lane.B + lane.ourBase)) * (1 - FEE);
    const pnlSol = proceeds / L - SIZE_SOL;
    lane.phase = 'done';
    const s = this.stat.get(lane.key)!;
    s.open--;
    s.fills++;
    s.pnlSol += pnlSol;
    return this.exitRecord(w, lane, 'filled', Math.round(pnlSol * 1e6) / 1e6, exitReason);
  }

  private exitRecord(w: Watch, lane: LaneState, outcome: string, pnlSol: number | null, exitReason: string | null): MigEvent {
    return {
      kind: 'exit',
      mint: w.mint,
      detail: {
        pool: w.pool,
        lane: lane.key,
        leadMs: w.leadMs,
        outcome,
        arrivalPos: lane.arrivalPos,
        movedPct: Math.round(lane.movedPct * 1e4) / 1e4,
        sizeSol: SIZE_SOL,
        ...(pnlSol !== null ? { pnlSol, entryPriceSol: lane.entryPriceSol, holdTrades: lane.holdTrades, exitReason } : {}),
      },
    };
  }
}
