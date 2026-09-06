// Dip-buy survivor detector — SHADOW ONLY.
//
// The 2026-07-21 tape analysis found every momentum/sniper strategy loses at
// our achievable latency, because 76% of creators dump and reactive exits sell
// into cascades. The ONE family that broke even at realistic latency was
// buying SURVIVORS after their capitulation: a token that has already crashed
// ~50% off its peak, aged past the sniper window, then shows a real bid
// returning. Its dynamics are slow (no same-slot MEV competition) so latency
// barely matters — plausibly positive once the feed is clean and the relayer
// fee is gone, both of which shipped alongside this.
//
// This module ONLY observes and paper-simulates. It never opens a real or
// paper position in the engine's book, never signs, never sends. It emits
// `dip_signal` / `dip_exit` records so the edge can be measured forward on
// live data before a single lamport is risked.
//
// v2 (2026-07-21, after the first 3,774-exit forward day): both entry AND
// exit now fill at the first tick at least LATENCY_MS after their trigger,
// at THAT tick's reserves — v1 filled at the trigger tick itself, which is
// the exact fill-at-trigger mirage the tape analysis warned about and
// understated stop-loss cascades. Each entry also runs a matrix of exit
// variants in parallel (one `dip_exit` record per variant, tagged) so a
// single forward day answers several tuning questions at once. Entry gates
// stay broad on purpose: signals carry their features (offPeakPct, age,
// curveVSol…) so tighter gates are evaluated OFFLINE by filtering records —
// for a shadow strategy that is exactly equivalent and costs nothing.

import { spotPriceSol, buyQuote, sellQuote, LAMPORTS_PER_SOL } from './curve';

export interface DipTradeInput {
  mint: string;
  isBuy: boolean;
  vSol: bigint;
  vTok: bigint;
  createdAtMs: number | null; // null if we didn't see the create
  nowMs: number;
}

export interface DipEvent {
  kind: 'signal' | 'exit';
  mint: string;
  detail: Record<string, unknown>;
}

// Entry tuning — the validated dip-survivor setup, exposed for future re-fit.
const MIN_AGE_MS = 45_000;
const DRAWDOWN = 0.5; // must fall this far below peak to arm
const BOUNCE = 0.15; // …then rise this far off the low to confirm
const CONFIRM_BUYS = 3; // …with at least this many buys since the low
const MIN_CURVE_VSOL = 32n * BigInt(LAMPORTS_PER_SOL); // ≥ ~2 real SOL in curve
const ARM_GAIN = 0.05; // trail only engages once +5% in profit
const SHADOW_SIZE_SOL = 0.05;
const LATENCY_MS = 800; // trigger→fill delay, applied to entry AND every exit
const ENTRY_ABANDON_MS = 30_000; // no fill tick within this → abandon entry
const MINT_CAP = 8_192;

// Exit matrix — variant 0 is the baseline (feeds stats()). Forward data on
// all variants accumulates simultaneously from the same entries.
interface ExitVariant {
  key: string;
  trail: number;
  stop: number;
  timeoutMs: number;
}
const EXIT_VARIANTS: ExitVariant[] = [
  { key: 'trail15_sl25_t180', trail: 0.15, stop: 0.25, timeoutMs: 180_000 },
  { key: 'trail10_sl15_t180', trail: 0.1, stop: 0.15, timeoutMs: 180_000 },
  { key: 'trail25_sl35_t600', trail: 0.25, stop: 0.35, timeoutMs: 600_000 },
  { key: 'trail15_sl25_t600', trail: 0.15, stop: 0.25, timeoutMs: 600_000 },
];

type Phase = 'watch' | 'armed' | 'entering' | 'holding';

interface VariantHold {
  holdPeak: number;
  // 'live' → watching for a trigger; number → trigger time, fill pending;
  // 'closed' → done for this entry.
  pending: 'live' | 'closed' | { triggerMs: number; triggerPrice: number; reason: string };
}

interface DipState {
  createdAtMs: number | null;
  firstSeenMs: number;
  peak: number;
  low: number;
  buysSinceLow: number;
  phase: Phase;
  // entering:
  entryTriggerMs: number;
  entryTriggerPrice: number;
  entryFeatures: Record<string, unknown>;
  // holding:
  entryPrice: number;
  entryTokens: bigint;
  entryMs: number;
  variants: VariantHold[];
}

export class DipShadow {
  private states = new Map<string, DipState>();
  private wins = 0;
  private trades = 0;
  private pnlSol = 0;

  stats(): { open: number; trades: number; wins: number; pnlSol: number } {
    let open = 0;
    for (const s of this.states.values()) if (s.phase === 'holding') open++;
    return { open, trades: this.trades, wins: this.wins, pnlSol: Math.round(this.pnlSol * 1e6) / 1e6 };
  }

  reset(): void {
    this.states.clear();
    this.wins = 0;
    this.trades = 0;
    this.pnlSol = 0;
  }

  /** Feed one decoded trade. Returns events to record. */
  observe(t: DipTradeInput): DipEvent[] {
    const price = spotPriceSol(t.vSol, t.vTok);
    if (price <= 0) return [];
    let s = this.states.get(t.mint);
    if (s === undefined) {
      s = {
        createdAtMs: t.createdAtMs,
        firstSeenMs: t.nowMs,
        peak: price,
        low: price,
        buysSinceLow: 0,
        phase: 'watch',
        entryTriggerMs: 0,
        entryTriggerPrice: 0,
        entryFeatures: {},
        entryPrice: 0,
        entryTokens: 0n,
        entryMs: 0,
        variants: [],
      };
      this.states.set(t.mint, s);
      this.evict();
      return [];
    }
    // Refresh recency (LRU): re-insert on touch.
    this.states.delete(t.mint);
    this.states.set(t.mint, s);

    const out: DipEvent[] = [];
    if (price > s.peak) s.peak = price;

    if (s.phase === 'holding') {
      this.stepHold(s, t, price, out);
      return out;
    }
    if (s.phase === 'entering') {
      this.stepEntering(s, t, price, out);
      return out;
    }

    // Arm once the token has crashed far enough off its peak.
    const age = t.createdAtMs !== null ? t.nowMs - t.createdAtMs : t.nowMs - s.firstSeenMs;
    if (s.phase === 'watch' && age >= MIN_AGE_MS && price <= s.peak * (1 - DRAWDOWN)) {
      s.phase = 'armed';
      s.low = price;
      s.buysSinceLow = 0;
    }
    if (s.phase === 'armed') {
      if (price < s.low) {
        s.low = price;
        s.buysSinceLow = 0;
      }
      if (t.isBuy) s.buysSinceLow++;
      // Confirmed bounce with real liquidity remaining → queue the entry; it
      // fills at the first tick ≥ LATENCY_MS from now, at that tick's price.
      if (s.buysSinceLow >= CONFIRM_BUYS && price >= s.low * (1 + BOUNCE) && t.vSol >= MIN_CURVE_VSOL) {
        s.phase = 'entering';
        s.entryTriggerMs = t.nowMs;
        s.entryTriggerPrice = price;
        s.entryFeatures = {
          offPeakPct: Math.round((1 - price / s.peak) * 1000) / 10,
          bounceOffLowPct: Math.round((price / s.low - 1) * 1000) / 10,
          ageMs: age,
          curveVSol: Number(t.vSol) / LAMPORTS_PER_SOL,
        };
      }
    }
    return out;
  }

  private stepEntering(s: DipState, t: DipTradeInput, price: number, out: DipEvent[]): void {
    const sinceTrigger = t.nowMs - s.entryTriggerMs;
    if (sinceTrigger < LATENCY_MS) return; // our buy is still in flight
    if (sinceTrigger > ENTRY_ABANDON_MS) {
      // Tape went silent past any realistic confirmation window — treat the
      // entry as failed and record it so illiquidity kills are measurable.
      out.push({
        kind: 'signal',
        mint: t.mint,
        detail: { ...s.entryFeatures, entryPrice: s.entryTriggerPrice, abandoned: true, fillDelayMs: sinceTrigger },
      });
      s.phase = 'watch';
      return;
    }
    const q = buyQuote(BigInt(Math.round(SHADOW_SIZE_SOL * LAMPORTS_PER_SOL)), t.vSol, t.vTok);
    if (q.tokensOut <= 0n) {
      s.phase = 'watch';
      return;
    }
    s.phase = 'holding';
    s.entryPrice = price;
    s.entryTokens = q.tokensOut;
    s.entryMs = t.nowMs;
    s.variants = EXIT_VARIANTS.map(() => ({ holdPeak: price, pending: 'live' as const }));
    out.push({
      kind: 'signal',
      mint: t.mint,
      detail: {
        ...s.entryFeatures,
        entryPrice: price,
        triggerPrice: s.entryTriggerPrice,
        entrySlipPct: Math.round((price / s.entryTriggerPrice - 1) * 1000) / 10,
        fillDelayMs: sinceTrigger,
      },
    });
  }

  private stepHold(s: DipState, t: DipTradeInput, price: number, out: DipEvent[]): void {
    const held = t.nowMs - s.entryMs;
    let closedAll = true;
    for (let i = 0; i < s.variants.length; i++) {
      const v = s.variants[i];
      const spec = EXIT_VARIANTS[i];
      if (v.pending === 'closed') continue;
      if (v.pending === 'live') {
        if (price > v.holdPeak) v.holdPeak = price;
        let reason: string | null = null;
        if (price <= s.entryPrice * (1 - spec.stop)) reason = 'stop_loss';
        else if (v.holdPeak >= s.entryPrice * (1 + ARM_GAIN) && price <= v.holdPeak * (1 - spec.trail)) reason = 'trailing';
        else if (held >= spec.timeoutMs) reason = 'timeout';
        if (reason !== null) v.pending = { triggerMs: t.nowMs, triggerPrice: price, reason };
        closedAll = false;
        continue;
      }
      // Fill pending: our sell lands at the first tick ≥ LATENCY_MS after the
      // trigger, at THAT tick's reserves — cascades cost what they really cost.
      if (t.nowMs - v.pending.triggerMs < LATENCY_MS) {
        closedAll = false;
        continue;
      }
      out.push(this.fillExit(s, t, spec, v.pending, price));
      v.pending = 'closed';
    }
    if (closedAll) {
      s.phase = 'watch'; // allow the same mint to set up again later
      s.buysSinceLow = 0;
      s.low = price;
    }
  }

  private fillExit(
    s: DipState,
    t: DipTradeInput,
    spec: ExitVariant,
    pending: { triggerMs: number; triggerPrice: number; reason: string },
    price: number,
  ): DipEvent {
    const q = sellQuote(s.entryTokens, t.vSol, t.vTok);
    const grossOut = Number(q.solOutLamports) / LAMPORTS_PER_SOL;
    const pnl = grossOut - SHADOW_SIZE_SOL - 0.001; // fixed overhead
    if (spec === EXIT_VARIANTS[0]) {
      this.trades++;
      if (pnl > 0) this.wins++;
      this.pnlSol += pnl;
    }
    return {
      kind: 'exit',
      mint: t.mint,
      detail: {
        variant: spec.key,
        reason: pending.reason,
        pnlSol: Math.round(pnl * 1e6) / 1e6,
        multiple: Math.round((s.entryTokens > 0n ? grossOut / SHADOW_SIZE_SOL : 0) * 1000) / 1000,
        holdMs: t.nowMs - s.entryMs,
        exitSlipPct: Math.round((price / pending.triggerPrice - 1) * 1000) / 10,
        fillDelayMs: t.nowMs - pending.triggerMs,
        exitLatencyModeledMs: LATENCY_MS,
      },
    };
  }

  private evict(): void {
    while (this.states.size > MINT_CAP) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }
}
