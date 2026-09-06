// Strategy Lab — N paper strategies running in tandem. SHADOW ONLY.
//
// Config-driven runner that trades many strategy specs simultaneously against
// the live firehose, each with honest latency fills (entry AND exit fill at
// the first tick ≥ LATENCY_MS after their trigger, at THAT tick's reserves —
// never at the trigger tick), curve walking with both pump fees, and
// per-strategy tagged records (`strat_signal` / `strat_exit`) so every
// strategy's forward PnL is measurable independently. Nothing here signs,
// sends, or touches the engine's paper book — pure measurement.
//
// The 2026-07-21 research swarm (docs/strat-swarm-2026-07-21.md) shaped this:
//  - GRADUATION IS NOT AN EXIT AT THE COMPLETION TICK. Every backtest "edge"
//    that reached verification died because its profit sat in sells booked at
//    the curve-completion tick, which cannot execute (the position migrates to
//    the AMM still holding).
//    UPDATED 2026-07-25: it is no longer *unresolvable*. `ammDecoder` decodes
//    the pump-amm tape, so a migrated position now waits in phase 'migrated'
//    and is marked at a real post-migration trade — see `onAmmTrade`. The
//    completion tick is still never booked. Positions whose pool produces no
//    observed trade inside RESOLVE_TIMEOUT_MS fall back to the old
//    unresolved:true record via `sweepMigrated`, so nothing is booked on
//    hope. Basis for the +60s mark delay: docs\amm-decoder-2026-07-25.md
//    (25/25 graduations profitable at first trade; +60s beat both the first
//    trade and +300s, where a third had already gone negative).
//  - Entry families: 'dip' (drawdown arm → bounce confirm — the family the
//    swarm confirmed dead; kept for future re-tests with new confirm ideas),
//    'zone' (first tick inside an age × vSol × drawdown cell), 'runner'
//    (curve-progress crossing with buy pressure), 'creatorRecovery' (buy the
//    bid-confirmed absorption after a creator dump), 'breakout' (second-leg
//    consolidation break — a graduation-probe, not an edge).
//  - Exits: stop / take-profit / trail (with arming threshold) / conditional
//    time-stop (fires only below a gain threshold) / exit-on-creator-sell.

import { spotPriceSol, buyQuote, sellQuote, curveProgressPct, LAMPORTS_PER_SOL } from './curve';

export type StratFamily = 'dip' | 'zone' | 'runner' | 'creatorRecovery' | 'breakout';

export interface StratEntrySpec {
  ageMinS: number | null;
  ageMaxS: number | null;
  /** Drawdown-from-running-peak band (fractions, e.g. 0.25–0.5).
   *  dip: arm threshold (min only). zone: band membership at the tick. */
  drawdownMin: number | null;
  drawdownMax: number | null;
  bounceMin: number | null; // dip only
  bounceMax: number | null; // dip only
  confirmBuys: number | null; // dip: buys since low; runner/breakout: buys in window
  vSolMinSol: number | null; // virtual SOL band
  vSolMaxSol: number | null;
  curvePctMin: number | null; // runner: upward crossing threshold
  requireNoCreatorSell: boolean;
  // creatorRecovery:
  creatorSellMinSol: number | null; // trigger sell size
  confirmBuyVolSol: number | null; // buy volume within confirm window
  confirmWindowS: number | null;
  // breakout:
  breakoutOverWindowMax: number | null; // e.g. 1.02 = price > 1.02× 5-min max
  windowRangeMax: number | null; // consolidation: windowMax/windowMin cap
  athOverWindowMax: number | null; // second-leg: prior ATH > x× window max
  confirmBuySolS: number | null; // min buy-SOL in trailing 60s
}

export interface StratExitSpec {
  stop: number | null; // fraction below entry
  tp: number | null; // take-profit multiple (1.2 = +20%)
  trail: number | null; // fraction off hold-peak
  trailArm: number; // gain fraction that arms the trail
  timeoutS: number | null;
  timeoutIfBelow: number | null; // time-stop fires only if gain < this fraction (null = always)
  exitOnCreatorSell: boolean;
}

export interface StratSpec {
  key: string;
  family: StratFamily;
  entry: StratEntrySpec;
  exit: StratExitSpec;
  oncePerMint: boolean;
  cooldownS: number; // re-trigger cooldown after an exit (ignored if oncePerMint)
}

export interface StratTradeInput {
  mint: string;
  isBuy: boolean;
  user: string;
  solLamports: bigint;
  vSol: bigint;
  vTok: bigint;
  createdAtMs: number | null;
  creator: string | null;
  nowMs: number;
}

export interface StratEvent {
  kind: 'signal' | 'exit';
  strat: string;
  mint: string;
  detail: Record<string, unknown>;
}

const SHADOW_SIZE_SOL = 0.05;
const OVERHEAD_SOL = 0.001;
const LATENCY_MS = 800;
const ENTRY_ABANDON_MS = 30_000;
const RECENT_WINDOW_MS = 30_000; // runner buy-pressure window
const BREAKOUT_WINDOW_MS = 300_000; // 5-min consolidation window
const BREAKOUT_VOL_WINDOW_MS = 60_000;
const PRICE_RING_CAP = 256; // per-mint price history cap (hot mints see a shorter window)
const MINT_CAP = 8_192;

const E0: StratEntrySpec = {
  ageMinS: null, ageMaxS: null, drawdownMin: null, drawdownMax: null, bounceMin: null, bounceMax: null,
  confirmBuys: null, vSolMinSol: null, vSolMaxSol: null, curvePctMin: null, requireNoCreatorSell: false,
  creatorSellMinSol: null, confirmBuyVolSol: null, confirmWindowS: null,
  breakoutOverWindowMax: null, windowRangeMax: null, athOverWindowMax: null, confirmBuySolS: null,
};
const X0: StratExitSpec = { stop: null, tp: null, trail: null, trailArm: 0.05, timeoutS: null, timeoutIfBelow: null, exitOnCreatorSell: false };

// The 2026-07-21 swarm synthesis specs — two marginal candidates, one
// regime-persistence test, one graduation instrumentation probe. Expected
// values are breakeven-ish; these run to gather protocol-grade forward
// evidence, not because an edge is proven. A fifth spec (grad60 + socials=0)
// is DORMANT until metadata capture spans ≥2 weeks (~2026-08-04) and the lab
// can query socials synchronously.
export const DEFAULT_STRATS: StratSpec[] = [
  {
    // Best-of-484 in-sample, n=105, unverified: 70% curve cross, no creator
    // sell, ≥20 buys/30s, TP 1.2×/SL −20%. If graduated exits carry the PnL
    // it is the known mirage; if TP exits do, it is real.
    key: 'grad_scalp_70_gated',
    family: 'runner',
    entry: { ...E0, curvePctMin: 70, vSolMinSol: 89.5, confirmBuys: 20, requireNoCreatorSell: true },
    exit: { ...X0, stop: 0.2, tp: 1.2 },
    oncePerMint: true,
    cooldownS: 0,
  },
  {
    // The only cell of 95 whose raw drift beat the cost floor: age 30–60min,
    // vSol 55–80, drawdown 25–50%, TP 1.6×/SL −35%/60s cap. n=150, H1 flat.
    key: 'postpeak_30_60m',
    family: 'zone',
    entry: { ...E0, ageMinS: 1800, ageMaxS: 3600, vSolMinSol: 55, vSolMaxSol: 80, drawdownMin: 0.25, drawdownMax: 0.5 },
    exit: { ...X0, stop: 0.35, tp: 1.6, timeoutS: 60 },
    oncePerMint: true,
    cooldownS: 0,
  },
  {
    // Gross 1.0003 — the signal exactly pays the fees. Runs to test whether
    // the 07-21-positive regime persists; kill if a week of shadow is net <0.
    key: 'creator_recovery',
    family: 'creatorRecovery',
    entry: { ...E0, ageMinS: 120, vSolMinSol: 32, creatorSellMinSol: 0.25, confirmBuyVolSol: 0.2, confirmBuys: 2, confirmWindowS: 60 },
    exit: { ...X0, stop: 0.12, tp: 1.12, timeoutS: 90, timeoutIfBelow: 0.03, exitOnCreatorSell: true },
    oncePerMint: false,
    cooldownS: 120,
  },
  {
    // DATA PROBE, refuted as an edge (−0.00316 on executable exits): 41% of
    // these entries graduate — it exists to record what graduation rides
    // actually do, feeding the future PumpSwap capture.
    key: 'secondleg_grad_probe',
    family: 'breakout',
    entry: {
      ...E0, ageMinS: 300, ageMaxS: 2880, vSolMinSol: 60, vSolMaxSol: 110,
      breakoutOverWindowMax: 1.02, windowRangeMax: 1.5, athOverWindowMax: 1.05, confirmBuys: 3, confirmBuySolS: 0.5,
    },
    exit: { ...X0, trail: 0.18, trailArm: 0.35, stop: 0.25, timeoutS: 600, timeoutIfBelow: 0.05 },
    oncePerMint: false,
    cooldownS: 120,
  },
];

type SPhase = 'watch' | 'armed' | 'confirming' | 'entering' | 'holding' | 'migrated' | 'done';

/** How long after migration to mark a graduated position. The tape says value
 *  decays fast post-migration: summed over the 25 graduations in the
 *  2026-07-25 audit, +60s (+0.877 SOL) beat the first trade (+0.79) and both
 *  beat +300s, where 8 of 25 had turned negative. */
const GRAD_MARK_DELAY_MS = 60_000;

/** If a migrated pool shows no observed trade within this window, give up and
 *  emit the honest unresolved record rather than inventing a mark. */
const GRAD_RESOLVE_TIMEOUT_MS = 10 * 60_000;

/** Pump mints are 6-decimal; `entryTokens` is in base units. */
const BASE_UNITS_PER_TOKEN = 1e6;

interface PerStrat {
  phase: SPhase;
  low: number; // dip machine
  buysSinceLow: number;
  confirmStartMs: number; // creatorRecovery: creator-sell trigger time
  confirmBuyVol: number;
  confirmBuyers: Set<string> | null;
  cooldownUntil: number;
  triggerMs: number;
  triggerPrice: number;
  features: Record<string, unknown>;
  entryPrice: number;
  entryTokens: bigint;
  entryMs: number;
  holdPeak: number;
  exitPending: { triggerMs: number; triggerPrice: number; reason: string } | null;
  /** phase 'migrated': when the curve completed, and the best mark seen so
   *  far inside the delay window (0 = no post-migration trade observed yet). */
  migratedAtMs: number;
  markPrice: number;
}

interface Tick {
  t: number;
  price: number;
  isBuy: boolean;
  sol: number;
}

interface MintState {
  createdAtMs: number | null;
  firstSeenMs: number;
  creator: string | null;
  creatorSold: boolean;
  lastCreatorSell: { t: number; sol: number } | null;
  peak: number; // running ATH
  prevCurvePct: number;
  ring: Tick[]; // recent ticks, capped, used for windows
  strats: PerStrat[];
}

export class StratLab {
  private states = new Map<string, MintState>();
  private totals: Map<string, { trades: number; wins: number; pnlSol: number; graduated: number }>;

  constructor(private specs: StratSpec[] = DEFAULT_STRATS) {
    this.totals = new Map(specs.map((s) => [s.key, { trades: 0, wins: 0, pnlSol: 0, graduated: 0 }]));
  }

  stats(): Array<{ key: string; trades: number; wins: number; pnlSol: number; graduated: number; open: number }> {
    const open = new Map<string, number>();
    for (const st of this.states.values())
      st.strats.forEach((p, i) => {
        // 'migrated' is still an open position — it holds tokens awaiting a
        // post-migration mark — so it must stay visible in the rollup.
        if (p.phase === 'holding' || p.phase === 'migrated')
          open.set(this.specs[i].key, (open.get(this.specs[i].key) ?? 0) + 1);
      });
    return this.specs.map((s) => {
      const t = this.totals.get(s.key)!;
      return { key: s.key, trades: t.trades, wins: t.wins, pnlSol: Math.round(t.pnlSol * 1e6) / 1e6, graduated: t.graduated, open: open.get(s.key) ?? 0 };
    });
  }

  reset(): void {
    this.states.clear();
    for (const t of this.totals.values()) {
      t.trades = 0;
      t.wins = 0;
      t.pnlSol = 0;
      t.graduated = 0;
    }
  }

  /** The mint's curve completed. Held positions CANNOT exit here — they
   *  migrate to the AMM still holding, so the completion tick is never booked
   *  (the #1 backtest poison from the swarm). They move to 'migrated' and
   *  wait for a real post-migration trade via `onAmmTrade`. */
  onComplete(mint: string, nowMs: number): StratEvent[] {
    const s = this.states.get(mint);
    if (!s) return [];
    for (let i = 0; i < this.specs.length; i++) {
      const p = s.strats[i];
      if (p.phase !== 'holding') {
        if (p.phase === 'entering' || p.phase === 'confirming' || p.phase === 'armed') p.phase = 'done';
        continue;
      }
      this.totals.get(this.specs[i].key)!.graduated++;
      p.phase = 'migrated';
      p.migratedAtMs = nowMs;
      p.markPrice = 0;
      p.exitPending = null;
    }
    return [];
  }

  /** A post-migration AMM trade for `mint`, priced in SOL per whole token.
   *  Feed it `executedPriceSol` from ammDecoder — never a reserve-derived mid,
   *  which the tape shows runs ~1.22x off.
   *
   *  Marks are taken at the last trade inside the delay window; the first
   *  trade after it closes the position. A pool whose first observed trade
   *  already sits past the window books at that trade — still a real fill,
   *  just a later one than intended. */
  onAmmTrade(mint: string, priceSol: number, nowMs: number): StratEvent[] {
    if (!(priceSol > 0)) return [];
    const s = this.states.get(mint);
    if (!s) return [];
    const out: StratEvent[] = [];
    for (let i = 0; i < this.specs.length; i++) {
      const p = s.strats[i];
      if (p.phase !== 'migrated') continue;
      if (nowMs < p.migratedAtMs + GRAD_MARK_DELAY_MS) {
        p.markPrice = priceSol; // keep the latest mark inside the window
        continue;
      }
      out.push(this.bookGraduation(this.specs[i], p, mint, p.markPrice || priceSol, nowMs));
    }
    return out;
  }

  /** Give up on migrated positions whose pool never produced an observed
   *  trade. Emits the pre-2026-07-25 unresolved record — honest, unbooked.
   *  Call periodically; the engine drives it from its shadow-summary tick. */
  sweepMigrated(nowMs: number): StratEvent[] {
    const out: StratEvent[] = [];
    for (const [mint, s] of this.states) {
      for (let i = 0; i < this.specs.length; i++) {
        const p = s.strats[i];
        if (p.phase !== 'migrated') continue;
        if (nowMs - p.migratedAtMs < GRAD_RESOLVE_TIMEOUT_MS) continue;
        if (p.markPrice > 0) {
          // A mark landed inside the window but no later trade ever closed it.
          out.push(this.bookGraduation(this.specs[i], p, mint, p.markPrice, nowMs));
          continue;
        }
        p.phase = 'done';
        out.push({
          kind: 'exit',
          strat: this.specs[i].key,
          mint,
          detail: {
            reason: 'graduated',
            unresolved: true,
            entryPrice: p.entryPrice,
            entryTokens: p.entryTokens.toString(),
            holdMs: nowMs - p.entryMs,
            note: 'migrated to AMM; no post-migration trade observed within timeout — PnL unresolved',
          },
        });
      }
    }
    return out;
  }

  private bookGraduation(spec: StratSpec, p: PerStrat, mint: string, priceSol: number, nowMs: number): StratEvent {
    const grossOut = (Number(p.entryTokens) / BASE_UNITS_PER_TOKEN) * priceSol;
    const pnl = grossOut - SHADOW_SIZE_SOL - OVERHEAD_SOL;
    const tot = this.totals.get(spec.key)!;
    tot.trades++;
    if (pnl > 0) tot.wins++;
    tot.pnlSol += pnl;
    p.phase = 'done';
    return {
      kind: 'exit',
      strat: spec.key,
      mint,
      detail: {
        reason: 'graduated',
        resolved: true,
        pnlSol: Math.round(pnl * 1e6) / 1e6,
        multiple: Math.round((grossOut / SHADOW_SIZE_SOL) * 1000) / 1000,
        holdMs: nowMs - p.entryMs,
        entryPrice: p.entryPrice,
        markPriceSol: priceSol,
        markDelayMs: nowMs - p.migratedAtMs,
        markTargetMs: GRAD_MARK_DELAY_MS,
      },
    };
  }

  observe(t: StratTradeInput): StratEvent[] {
    const price = spotPriceSol(t.vSol, t.vTok);
    if (price <= 0) return [];
    let s = this.states.get(t.mint);
    if (s === undefined) {
      s = {
        createdAtMs: t.createdAtMs,
        firstSeenMs: t.nowMs,
        creator: t.creator,
        creatorSold: false,
        lastCreatorSell: null,
        peak: price,
        prevCurvePct: curveProgressPct(t.vSol),
        ring: [],
        strats: this.specs.map(() => ({
          phase: 'watch' as const,
          low: price,
          buysSinceLow: 0,
          confirmStartMs: 0,
          confirmBuyVol: 0,
          confirmBuyers: null,
          cooldownUntil: 0,
          triggerMs: 0,
          triggerPrice: 0,
          features: {},
          entryPrice: 0,
          entryTokens: 0n,
          entryMs: 0,
          holdPeak: 0,
          exitPending: null,
          migratedAtMs: 0,
          markPrice: 0,
        })),
      };
      this.states.set(t.mint, s);
      this.evict();
    }
    this.states.delete(t.mint); // LRU touch
    this.states.set(t.mint, s);

    if (s.creator === null && t.creator !== null) s.creator = t.creator;
    const sol = Number(t.solLamports) / LAMPORTS_PER_SOL;
    const isCreatorSell = !t.isBuy && s.creator !== null && t.user === s.creator;
    if (isCreatorSell) {
      s.creatorSold = true;
      s.lastCreatorSell = { t: t.nowMs, sol };
    }
    if (price > s.peak) s.peak = price;
    s.ring.push({ t: t.nowMs, price, isBuy: t.isBuy, sol });
    while (s.ring.length > PRICE_RING_CAP || (s.ring.length > 0 && s.ring[0].t < t.nowMs - BREAKOUT_WINDOW_MS)) s.ring.shift();

    const curvePct = curveProgressPct(t.vSol);
    const age = s.createdAtMs !== null ? t.nowMs - s.createdAtMs : t.nowMs - s.firstSeenMs;
    const ageKnown = s.createdAtMs !== null;

    const out: StratEvent[] = [];
    for (let i = 0; i < this.specs.length; i++) {
      this.step(this.specs[i], s.strats[i], s, t, price, sol, curvePct, age, ageKnown, isCreatorSell, out);
    }
    s.prevCurvePct = curvePct;
    return out;
  }

  private gatesPass(e: StratEntrySpec, s: MintState, t: StratTradeInput, age: number, ageKnown: boolean): boolean {
    if (e.ageMinS !== null && (!ageKnown || age < e.ageMinS * 1000)) return false;
    if (e.ageMaxS !== null && age > e.ageMaxS * 1000) return false;
    const vSolSol = Number(t.vSol) / LAMPORTS_PER_SOL;
    if (e.vSolMinSol !== null && vSolSol < e.vSolMinSol) return false;
    if (e.vSolMaxSol !== null && vSolSol > e.vSolMaxSol) return false;
    if (e.requireNoCreatorSell && (s.creatorSold || s.creator === null)) return false;
    return true;
  }

  private recentBuys(s: MintState, nowMs: number, windowMs: number): { count: number; sol: number } {
    let count = 0;
    let sol = 0;
    for (let i = s.ring.length - 1; i >= 0; i--) {
      const k = s.ring[i];
      if (k.t < nowMs - windowMs) break;
      if (k.isBuy) {
        count++;
        sol += k.sol;
      }
    }
    return { count, sol };
  }

  private step(
    spec: StratSpec,
    p: PerStrat,
    s: MintState,
    t: StratTradeInput,
    price: number,
    sol: number,
    curvePct: number,
    age: number,
    ageKnown: boolean,
    isCreatorSell: boolean,
    out: StratEvent[],
  ): void {
    if (p.phase === 'done') return;
    // Migrated positions are settled by onAmmTrade, not by curve ticks. Any
    // residual curve trade after completion must not touch them.
    if (p.phase === 'migrated') return;
    if (p.phase === 'holding') {
      this.stepHold(spec, p, t, price, isCreatorSell, out);
      return;
    }
    if (p.phase === 'entering') {
      this.stepEntering(spec, p, t, price, out);
      return;
    }
    if (t.nowMs < p.cooldownUntil) return;
    const e = spec.entry;
    const base = { ageMs: age, curveVSol: Number(t.vSol) / LAMPORTS_PER_SOL, curvePct: Math.round(curvePct * 10) / 10 };

    switch (spec.family) {
      case 'dip': {
        if (p.phase === 'watch' && this.gatesPass(e, s, t, age, ageKnown) && e.drawdownMin !== null && price <= s.peak * (1 - e.drawdownMin)) {
          p.phase = 'armed';
          p.low = price;
          p.buysSinceLow = 0;
        }
        if (p.phase !== 'armed') return;
        if (price < p.low) {
          p.low = price;
          p.buysSinceLow = 0;
        }
        if (t.isBuy) p.buysSinceLow++;
        const bounce = price / p.low - 1;
        if (
          p.buysSinceLow >= (e.confirmBuys ?? 3) &&
          bounce >= (e.bounceMin ?? 0.15) &&
          (e.bounceMax === null || bounce <= e.bounceMax) &&
          this.gatesPass(e, s, t, age, ageKnown)
        ) {
          this.trigger(p, t, price, { ...base, offPeakPct: Math.round((1 - price / s.peak) * 1000) / 10, bounceOffLowPct: Math.round(bounce * 1000) / 10 });
        }
        return;
      }
      case 'zone': {
        const dd = 1 - price / s.peak;
        if (
          this.gatesPass(e, s, t, age, ageKnown) &&
          (e.drawdownMin === null || dd >= e.drawdownMin) &&
          (e.drawdownMax === null || dd < e.drawdownMax)
        ) {
          this.trigger(p, t, price, { ...base, offPeakPct: Math.round(dd * 1000) / 10 });
        }
        return;
      }
      case 'runner': {
        if (e.curvePctMin === null) return;
        const crossed = s.prevCurvePct < e.curvePctMin && curvePct >= e.curvePctMin;
        if (!crossed || !t.isBuy || !this.gatesPass(e, s, t, age, ageKnown)) return;
        const rb = this.recentBuys(s, t.nowMs, RECENT_WINDOW_MS);
        if (rb.count < (e.confirmBuys ?? 1)) return;
        this.trigger(p, t, price, { ...base, recentBuys: rb.count });
        return;
      }
      case 'creatorRecovery': {
        if (p.phase === 'watch') {
          if (isCreatorSell && sol >= (e.creatorSellMinSol ?? 0.25) && this.gatesPass(e, s, t, age, ageKnown)) {
            p.phase = 'confirming';
            p.confirmStartMs = t.nowMs;
            p.confirmBuyVol = 0;
            p.confirmBuyers = new Set();
          }
          return;
        }
        // confirming
        if (t.nowMs - p.confirmStartMs > (e.confirmWindowS ?? 60) * 1000) {
          p.phase = 'watch';
          return;
        }
        if (isCreatorSell) {
          // A second dump during confirmation restarts the clock.
          p.confirmStartMs = t.nowMs;
          p.confirmBuyVol = 0;
          p.confirmBuyers!.clear();
          return;
        }
        if (t.isBuy) {
          p.confirmBuyVol += sol;
          p.confirmBuyers!.add(t.user);
          if (p.confirmBuyVol >= (e.confirmBuyVolSol ?? 0.2) && p.confirmBuyers!.size >= (e.confirmBuys ?? 2)) {
            this.trigger(p, t, price, { ...base, confirmBuyVol: Math.round(p.confirmBuyVol * 1000) / 1000, confirmBuyers: p.confirmBuyers!.size, sinceCreatorSellMs: t.nowMs - p.confirmStartMs });
            p.confirmBuyers = null;
          }
        }
        return;
      }
      case 'breakout': {
        if (!t.isBuy || !this.gatesPass(e, s, t, age, ageKnown)) return;
        // Window = ring ticks BEFORE this one within 5 min.
        let wMax = 0;
        let wMin = Infinity;
        for (let i = 0; i < s.ring.length - 1; i++) {
          const k = s.ring[i];
          if (k.price > wMax) wMax = k.price;
          if (k.price < wMin) wMin = k.price;
        }
        if (wMax <= 0 || !isFinite(wMin) || wMin <= 0) return;
        if (price < wMax * (e.breakoutOverWindowMax ?? 1.02)) return;
        if (wMax / wMin > (e.windowRangeMax ?? 1.5)) return; // not consolidating
        if (s.peak < wMax * (e.athOverWindowMax ?? 1.05)) return; // no prior leg
        const rb = this.recentBuys(s, t.nowMs, BREAKOUT_VOL_WINDOW_MS);
        if (rb.count < (e.confirmBuys ?? 3) || rb.sol < (e.confirmBuySolS ?? 0.5)) return;
        this.trigger(p, t, price, { ...base, windowMax: wMax, windowRange: Math.round((wMax / wMin) * 100) / 100, recentBuySol: Math.round(rb.sol * 100) / 100 });
        return;
      }
    }
  }

  private trigger(p: PerStrat, t: StratTradeInput, price: number, features: Record<string, unknown>): void {
    p.phase = 'entering';
    p.triggerMs = t.nowMs;
    p.triggerPrice = price;
    p.features = features;
  }

  private stepEntering(spec: StratSpec, p: PerStrat, t: StratTradeInput, price: number, out: StratEvent[]): void {
    const since = t.nowMs - p.triggerMs;
    if (since < LATENCY_MS) return;
    if (since > ENTRY_ABANDON_MS) {
      out.push({ kind: 'signal', strat: spec.key, mint: t.mint, detail: { ...p.features, entryPrice: p.triggerPrice, abandoned: true, fillDelayMs: since } });
      this.rearm(spec, p, t.nowMs);
      return;
    }
    const q = buyQuote(BigInt(Math.round(SHADOW_SIZE_SOL * LAMPORTS_PER_SOL)), t.vSol, t.vTok);
    if (q.tokensOut <= 0n) {
      this.rearm(spec, p, t.nowMs);
      return;
    }
    p.phase = 'holding';
    p.entryPrice = price;
    p.entryTokens = q.tokensOut;
    p.entryMs = t.nowMs;
    p.holdPeak = price;
    p.exitPending = null;
    out.push({
      kind: 'signal',
      strat: spec.key,
      mint: t.mint,
      detail: {
        ...p.features,
        entryPrice: price,
        triggerPrice: p.triggerPrice,
        entrySlipPct: Math.round((price / p.triggerPrice - 1) * 1000) / 10,
        fillDelayMs: since,
      },
    });
  }

  private stepHold(spec: StratSpec, p: PerStrat, t: StratTradeInput, price: number, isCreatorSell: boolean, out: StratEvent[]): void {
    const x = spec.exit;
    if (p.exitPending === null) {
      if (price > p.holdPeak) p.holdPeak = price;
      const held = t.nowMs - p.entryMs;
      const gain = price / p.entryPrice - 1;
      let reason: string | null = null;
      if (x.stop !== null && price <= p.entryPrice * (1 - x.stop)) reason = 'stop_loss';
      else if (x.tp !== null && price >= p.entryPrice * x.tp) reason = 'take_profit';
      else if (x.trail !== null && p.holdPeak >= p.entryPrice * (1 + x.trailArm) && price <= p.holdPeak * (1 - x.trail)) reason = 'trailing';
      else if (x.exitOnCreatorSell && isCreatorSell) reason = 'creator_sell';
      else if (x.timeoutS !== null && held >= x.timeoutS * 1000 && (x.timeoutIfBelow === null || gain < x.timeoutIfBelow)) reason = 'timeout';
      if (reason !== null) p.exitPending = { triggerMs: t.nowMs, triggerPrice: price, reason };
      return;
    }
    if (t.nowMs - p.exitPending.triggerMs < LATENCY_MS) return;
    const q = sellQuote(p.entryTokens, t.vSol, t.vTok);
    const grossOut = Number(q.solOutLamports) / LAMPORTS_PER_SOL;
    const pnl = grossOut - SHADOW_SIZE_SOL - OVERHEAD_SOL;
    const tot = this.totals.get(spec.key)!;
    tot.trades++;
    if (pnl > 0) tot.wins++;
    tot.pnlSol += pnl;
    out.push({
      kind: 'exit',
      strat: spec.key,
      mint: t.mint,
      detail: {
        reason: p.exitPending.reason,
        pnlSol: Math.round(pnl * 1e6) / 1e6,
        multiple: Math.round((grossOut / SHADOW_SIZE_SOL) * 1000) / 1000,
        holdMs: t.nowMs - p.entryMs,
        exitSlipPct: Math.round((price / p.exitPending.triggerPrice - 1) * 1000) / 10,
        fillDelayMs: t.nowMs - p.exitPending.triggerMs,
        exitLatencyModeledMs: LATENCY_MS,
      },
    });
    this.rearm(spec, p, t.nowMs);
  }

  private rearm(spec: StratSpec, p: PerStrat, nowMs: number): void {
    p.exitPending = null;
    p.confirmBuyers = null;
    if (spec.oncePerMint) {
      p.phase = 'done';
      return;
    }
    p.phase = 'watch';
    p.buysSinceLow = 0;
    p.cooldownUntil = nowMs + spec.cooldownS * 1000;
  }

  private evict(): void {
    while (this.states.size > MINT_CAP) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
}
