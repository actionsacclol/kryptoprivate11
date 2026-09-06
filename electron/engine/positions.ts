// Paper position manager — research §8: "a sniper that buys quickly but
// sells poorly is useless." Every position runs the full exit state
// machine: OPEN → TAKE_PROFIT_1 → TRAILING → CLOSED, with independent
// triggers (hard stop, time stop, trailing stop, partial take-profits,
// creator sell, flow reversal, curve completion, kill switch).
//
// All monetary state is integer (lamports / token base units). Fills are
// quoted against live virtual reserves — price impact and fees included.
// The floats on PaperPosition are derived display values only. Marking is
// LIQUIDATION VALUE: what the remaining tokens would fetch if sold right
// now, never token_balance × spot_price.
//
// HONEST FILLS (2026-07-24 swarm): trigger-tick fills made the paper book
// ~66x optimistic vs an 800ms-latency replay of the same positions — the
// entire live-vs-paper gap. Every entry and strategy exit now BOOKS at the
// reserves prevailing >= FILL_LATENCY_MS after its trigger (the 500ms tick
// timer resolves pending fills), matching stratLab's fill semantics. Live
// sells still fire at TRIGGER time via onExitTriggered — their latency is
// physical, not simulated. killAll remains immediate (engine is stopping;
// no future ticks would resolve a pending fill).

import type { ExitReason, PaperPosition, StrategySettings } from '@shared/types';
import {
  buyQuote,
  sellQuote,
  spotPriceSol,
  lamportsToSol,
  solToLamports,
  tokensToWhole,
} from './curve';

export interface TokenMarket {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** Rolling last-5s sell and buy volume in SOL, maintained by the tracker. */
  recentBuyVolSol: number;
  recentSellVolSol: number;
  creatorSold: boolean;
  curveComplete: boolean;
}

export interface PositionCallbacks {
  onOpen: (p: PaperPosition) => void;
  onUpdate: (p: PaperPosition) => void;
  onClose: (p: PaperPosition) => void;
  /** Fires the moment an exit TRIGGERS (before the latency-delayed paper
   *  fill) — the hook for real sells, whose latency is physical. */
  onExitTriggered: (p: PaperPosition, reason: ExitReason) => void;
}

/** Integer books per position — the source of truth for money. */
interface Book {
  rawTokens: bigint;
  costLamports: bigint;
  recoveredLamports: bigint;
  /** Entry decided but not yet booked — fills at the reserves prevailing
   *  FILL_LATENCY_MS after the decision. */
  entryPendingSince: number | null;
  pendingExit: { reason: ExitReason; requestedAt: number } | null;
  pendingPartial: { label: string; nextState: PaperPosition['state']; requestedAt: number } | null;
}

const FILL_LATENCY_MS = 800;

let seq = 0;

export class PositionManager {
  private positions = new Map<string, PaperPosition>(); // by position id
  private books = new Map<string, Book>(); // by position id
  private byMint = new Map<string, string>(); // mint -> open position id

  constructor(
    private settings: () => StrategySettings,
    private market: (mint: string) => TokenMarket | null,
    private cb: PositionCallbacks,
  ) {}

  openCount(): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.state !== 'closed') n++;
    return n;
  }

  all(): PaperPosition[] {
    return [...this.positions.values()];
  }

  hasOpenFor(mint: string): boolean {
    return this.byMint.has(mint);
  }

  /** Mark an open position as backed by a real on-chain buy. */
  markLive(mint: string): void {
    const id = this.byMint.get(mint);
    if (!id) return;
    const p = this.positions.get(id);
    if (p && p.state !== 'closed') {
      p.live = true;
      this.cb.onUpdate(p);
    }
  }

  /** Open a paper position. The BUY BOOKS LATER: at the reserves prevailing
   *  FILL_LATENCY_MS after this decision (honest-fill discipline). */
  open(mint: string, name: string, symbol: string): PaperPosition | null {
    const s = this.settings();
    if (this.openCount() >= s.maxOpenPositions) return null;
    if (this.byMint.has(mint)) return null;
    const m = this.market(mint);
    if (!m) return null;
    const costLamports = solToLamports(s.positionSizeSol);
    const price = spotPriceSol(m.virtualSolReserves, m.virtualTokenReserves);
    const p: PaperPosition = {
      id: `pos-${++seq}-${Date.now()}`,
      mint,
      name,
      symbol,
      state: 'open',
      openedAt: Date.now(),
      closedAt: null,
      entryPriceSol: 0,
      tokenAmount: 0,
      remainingTokens: 0,
      costSol: s.positionSizeSol,
      recoveredSol: 0,
      currentPriceSol: price,
      peakPriceSol: price,
      pnlSol: 0,
      pnlPct: 0,
      exitReason: null,
      events: [{ at: Date.now(), label: `Paper buy ${s.positionSizeSol} SOL queued (fills in ${FILL_LATENCY_MS}ms)` }],
    };
    this.positions.set(p.id, p);
    this.books.set(p.id, {
      rawTokens: 0n,
      costLamports,
      recoveredLamports: 0n,
      entryPendingSince: Date.now(),
      pendingExit: null,
      pendingPartial: null,
    });
    this.byMint.set(mint, p.id);
    this.cb.onOpen(p);
    return p;
  }

  /** Book the delayed entry fill at CURRENT reserves. */
  private fillEntry(p: PaperPosition, b: Book, m: TokenMarket): void {
    b.entryPendingSince = null;
    const q = buyQuote(b.costLamports, m.virtualSolReserves, m.virtualTokenReserves);
    if (q.tokensOut <= 0n) {
      // Curve gone unquotable between decision and fill. A REAL buy may exist
      // regardless (a user-initiated one, or one from a pre-2026-08-16 build
      // when autonomous firing still existed) — fire the exit hook so it gets
      // sold, then void the paper side.
      this.cb.onExitTriggered(p, 'orphaned');
      this.voidPosition(p.mint, 'entry fill impossible (curve unquotable)');
      return;
    }
    b.rawTokens = q.tokensOut;
    p.tokenAmount = tokensToWhole(q.tokensOut);
    p.remainingTokens = p.tokenAmount;
    p.entryPriceSol = p.tokenAmount > 0 ? p.costSol / p.tokenAmount : 0;
    const price = spotPriceSol(m.virtualSolReserves, m.virtualTokenReserves);
    p.peakPriceSol = Math.max(price, 0);
    p.events.push({ at: Date.now(), label: `Filled @ ${p.entryPriceSol.toExponential(3)} (honest ${FILL_LATENCY_MS}ms latency)` });
    this.refreshPnl(p, m);
    this.cb.onUpdate(p);
  }

  /** Evaluate all exit triggers for every open position. Call on a timer
   *  AND on every trade for a held mint. */
  tick(): void {
    for (const p of this.positions.values()) {
      if (p.state === 'closed') continue;
      this.evaluate(p);
    }
  }

  onTradeFor(mint: string): void {
    const id = this.byMint.get(mint);
    if (!id) return;
    const p = this.positions.get(id);
    if (p && p.state !== 'closed') this.evaluate(p);
  }

  killAll(reason: ExitReason): void {
    for (const p of this.positions.values()) {
      if (p.state === 'closed') continue;
      const b = this.books.get(p.id);
      // Fire the live-sell hook unless one already fired for this position
      // (a pending exit means onExitTriggered already ran).
      if (!b?.pendingExit) this.cb.onExitTriggered(p, reason);
      this.executeClose(p, reason);
    }
  }

  /**
   * Void a position whose launch tx turned out to live on a dropped fork
   * (fork-awareness): the trades never canonically happened, so the paper
   * position is neutralized — PnL zero, excluded from win/loss stats by
   * its 'orphaned' reason — rather than counted as a real outcome.
   */
  voidPosition(mint: string, detail: string): boolean {
    const id = this.byMint.get(mint);
    if (!id) return false;
    const p = this.positions.get(id);
    const b = this.books.get(id);
    if (!p || !b || p.state === 'closed') return false;
    b.rawTokens = 0n;
    b.recoveredLamports = b.costLamports;
    p.remainingTokens = 0;
    p.recoveredSol = p.costSol;
    p.pnlSol = 0;
    p.pnlPct = 0;
    p.state = 'closed';
    p.closedAt = Date.now();
    p.exitReason = 'orphaned';
    p.events.push({ at: Date.now(), label: `Voided — ${detail}` });
    this.byMint.delete(mint);
    this.cb.onClose(p);
    return true;
  }

  private evaluate(p: PaperPosition): void {
    const s = this.settings();
    const m = this.market(p.mint);
    if (!m) return;
    const b = this.books.get(p.id);
    if (!b) return;
    const now = Date.now();

    // 0. Resolve pending fills first — they book at CURRENT reserves, which
    //    is exactly the honesty this exists for.
    if (b.entryPendingSince !== null) {
      if (now >= b.entryPendingSince + FILL_LATENCY_MS) this.fillEntry(p, b, m);
      return; // no exit logic until the entry is booked
    }
    if (b.pendingExit) {
      if (now >= b.pendingExit.requestedAt + FILL_LATENCY_MS) this.executeClose(p, b.pendingExit.reason);
      return; // an exit is in flight — nothing else can trigger
    }
    if (b.pendingPartial) {
      if (now >= b.pendingPartial.requestedAt + FILL_LATENCY_MS) {
        const pp = b.pendingPartial;
        b.pendingPartial = null;
        this.partialSell(p, m, pp.label);
        p.state = pp.nextState;
        this.cb.onUpdate(p);
      }
      // fall through: a full-exit trigger may still fire (and supersede)
    }

    const price = spotPriceSol(m.virtualSolReserves, m.virtualTokenReserves);
    if (price <= 0) return;
    p.currentPriceSol = price;
    if (price > p.peakPriceSol) p.peakPriceSol = price;
    const gain = p.entryPriceSol > 0 ? price / p.entryPriceSol - 1 : 0;
    this.refreshPnl(p, m);

    // 1. Emergency-class triggers first.
    if (m.curveComplete) return this.requestExit(p, b, 'curve_complete');
    if (s.exitOnCreatorSell && m.creatorSold) return this.requestExit(p, b, 'creator_sell');
    if (
      s.exitOnFlowReversal &&
      m.recentSellVolSol > 0.5 &&
      m.recentSellVolSol > m.recentBuyVolSol * 3
    )
      return this.requestExit(p, b, 'flow_reversal');

    // 2. Hard stop.
    if (gain <= -s.stopLossPct) return this.requestExit(p, b, 'stop_loss');

    // 3. Take-profit ladder (skip if a partial is already in flight).
    if (!b.pendingPartial) {
      if (p.state === 'open' && gain >= s.takeProfit1Pct) {
        b.pendingPartial = { label: `TP1 +${Math.round(gain * 100)}%`, nextState: 'take_profit_1', requestedAt: now };
        p.events.push({ at: now, label: `TP1 triggered — fill in ${FILL_LATENCY_MS}ms` });
        this.cb.onUpdate(p);
        return;
      }
      if (p.state === 'take_profit_1' && gain >= s.takeProfit2Pct) {
        b.pendingPartial = { label: `TP2 +${Math.round(gain * 100)}%`, nextState: 'trailing', requestedAt: now };
        p.events.push({ at: now, label: `TP2 triggered — fill in ${FILL_LATENCY_MS}ms` });
        this.cb.onUpdate(p);
        return;
      }
    }

    // 4. Trailing stop once any profit was banked.
    if (p.state === 'take_profit_1' || p.state === 'trailing') {
      const fromPeak = 1 - price / p.peakPriceSol;
      if (fromPeak >= s.trailingPct) return this.requestExit(p, b, 'trailing_stop');
    }

    // 5. Time stop: flat positions don't get to rot.
    const ageSec = (now - p.openedAt) / 1000;
    if (p.state === 'open' && ageSec >= s.timeStopSec && gain < 0.1)
      return this.requestExit(p, b, 'time_stop');

    this.cb.onUpdate(p);
  }

  /** Trigger a full exit: real sells fire NOW (their latency is physical);
   *  the paper book fills FILL_LATENCY_MS later at then-current reserves.
   *  A pending partial is superseded — one sell per position at a time. */
  private requestExit(p: PaperPosition, b: Book, reason: ExitReason): void {
    b.pendingPartial = null;
    b.pendingExit = { reason, requestedAt: Date.now() };
    p.events.push({ at: Date.now(), label: `Exit triggered (${reason}) — fill in ${FILL_LATENCY_MS}ms` });
    this.cb.onExitTriggered(p, reason);
    this.cb.onUpdate(p);
  }

  /** Sell half the remaining book (integer halving — no fractional tokens). */
  private partialSell(p: PaperPosition, m: TokenMarket, label: string): void {
    const b = this.books.get(p.id);
    if (!b || b.rawTokens <= 0n) return;
    const tokens = b.rawTokens / 2n;
    if (tokens <= 0n) return;
    const q = sellQuote(tokens, m.virtualSolReserves, m.virtualTokenReserves);
    b.rawTokens -= tokens;
    b.recoveredLamports += q.solOutLamports;
    p.remainingTokens = tokensToWhole(b.rawTokens);
    p.recoveredSol = lamportsToSol(b.recoveredLamports);
    p.events.push({
      at: Date.now(),
      label: `${label} — sold 50% for ${lamportsToSol(q.solOutLamports).toFixed(4)} SOL`,
    });
    this.refreshPnl(p, m);
  }

  /** Immediate close — used by killAll (engine stopping, no future ticks to
   *  resolve a pending fill) and by pending-exit resolution. */
  private executeClose(p: PaperPosition, reason: ExitReason): void {
    const b = this.books.get(p.id);
    const m = this.market(p.mint);
    if (b && m && b.rawTokens > 0n) {
      const q = sellQuote(b.rawTokens, m.virtualSolReserves, m.virtualTokenReserves);
      b.recoveredLamports += q.solOutLamports;
      p.events.push({
        at: Date.now(),
        label: `Exit (${reason}) — sold rest for ${lamportsToSol(q.solOutLamports).toFixed(4)} SOL`,
      });
      b.rawTokens = 0n;
      p.remainingTokens = 0;
      p.recoveredSol = lamportsToSol(b.recoveredLamports);
    }
    p.state = 'closed';
    p.closedAt = Date.now();
    p.exitReason = reason;
    if (b) {
      const pnlLamports = b.recoveredLamports - b.costLamports;
      p.pnlSol = lamportsToSol(pnlLamports);
      p.pnlPct = b.costLamports > 0n ? (Number(pnlLamports) / Number(b.costLamports)) * 100 : 0;
    }
    this.byMint.delete(p.mint);
    this.cb.onClose(p);
  }

  private refreshPnl(p: PaperPosition, m: TokenMarket): void {
    const b = this.books.get(p.id);
    if (!b) return;
    // Liquidation-value mark: what the remaining tokens would fetch NOW.
    let markLamports = 0n;
    if (b.rawTokens > 0n) {
      markLamports = sellQuote(b.rawTokens, m.virtualSolReserves, m.virtualTokenReserves).solOutLamports;
    }
    const pnlLamports = b.recoveredLamports + markLamports - b.costLamports;
    p.pnlSol = lamportsToSol(pnlLamports);
    p.pnlPct = b.costLamports > 0n ? (Number(pnlLamports) / Number(b.costLamports)) * 100 : 0;
  }

  /** Realized PnL over closed positions, excluding voided (orphaned) ones. */
  realizedPnlSol(): number {
    let total = 0;
    for (const p of this.positions.values()) {
      if (p.state === 'closed' && p.exitReason !== 'orphaned') total += p.pnlSol;
    }
    return total;
  }

  closedCount(): number {
    let n = 0;
    for (const p of this.positions.values()) if (p.state === 'closed') n++;
    return n;
  }

  /** Losses in a row, newest close backwards (voided positions excluded). */
  consecutiveLosses(): number {
    const closed = [...this.positions.values()]
      .filter((p) => p.state === 'closed' && p.exitReason !== 'orphaned' && p.closedAt !== null)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    let n = 0;
    for (const p of closed) {
      if (p.pnlSol < 0) n++;
      else break;
    }
    return n;
  }
}
