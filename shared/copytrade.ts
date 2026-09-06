// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — copy trading (term.txt section 11).
//
// PAPER IS THE DEFAULT AND THE POINT.
//
// Six months of adversarial research in `docs/` failed to find a profitable
// automated memecoin strategy on this data, and copying a wallet is exactly
// such a strategy — one whose edge you have not measured, delegated to a
// stranger who does not know you exist. term.txt asks for paper-copy mode
// ("simulate following this wallet for 7 days without risking money") and
// that is the honest primary: you follow a wallet on paper, the app keeps an
// unforgiving scorecard, and only then do you get to decide.
//
// Live copying exists, is off, and requires the same arming as every other
// real trade plus its own daily loss limit. The UI shows the paper record
// next to the switch, so the decision is made against evidence rather than
// against a follower count.
// ──────────────────────────────────────────────────────────────────────

export type CopyMode = 'paper' | 'live';

export type SizingMode =
  /** Always the same SOL amount, whatever they spent. */
  | 'fixed'
  /** A percentage of what they spent, capped. */
  | 'proportional';

export interface CopyConfig {
  id: string;
  /** Wallet being followed. */
  wallet: string;
  label: string;
  enabled: boolean;
  mode: CopyMode;

  sizing: SizingMode;
  /** `fixed`: SOL per trade. `proportional`: percent of their size. */
  sizeValue: number;
  /** Hard ceiling per copied trade, SOL. */
  maxTradeSol: number;

  /** Skip a copy when the token fails these. Null = no constraint. */
  minLiquidityUsd: number | null;
  maxMarketCapUsd: number | null;
  minKryptScore: number | null;
  /** Only copy tokens on these launchpads. Empty = any. */
  onlyPumpfun: boolean;

  /** Wait this long after their trade before copying, ms. */
  delayMs: number;
  maxSlippagePct: number;
  /** Mirror their sells too, proportionally to what we hold. */
  copySells: boolean;

  /** Stop copying for the day after losing this much (paper or live). */
  dailyLossLimitSol: number;
  /** Stop after this many copies in a day. */
  dailyTradeLimit: number;

  createdAt: number;
}

export interface CopyStats {
  configId: string;
  /** Paper and live are scored separately — they are different experiments. */
  mode: CopyMode;
  trades: number;
  wins: number;
  losses: number;
  /** Sum of realized PnL across closed copies, SOL. */
  realizedPnlSol: number;
  /** Currently open copies. */
  openCount: number;
  openCostSol: number;
  /** Skipped because a filter rejected the token. */
  skipped: number;
  /** Skipped because a limit was hit. */
  blocked: number;
  firstAt: number | null;
  lastAt: number | null;
}

export type CopyTradeState = 'open' | 'closed' | 'skipped';

export interface CopyTrade {
  id: string;
  configId: string;
  mode: CopyMode;
  wallet: string;
  mint: string;
  symbol: string;
  at: number;
  /** What they did. */
  theirSol: number;
  /** What we did (or would have done). */
  ourSol: number;
  entryPriceSol: number | null;
  exitPriceSol: number | null;
  closedAt: number | null;
  pnlSol: number | null;
  state: CopyTradeState;
  /** Why it was skipped, when it was. */
  reason: string | null;
}

export interface CopySnapshot {
  configs: CopyConfig[];
  stats: Record<string, CopyStats>;
  recent: CopyTrade[];
  /** Live copying is possible right now. */
  liveExecutable: boolean;
  liveBlockedReason: string | null;
}

export function defaultConfig(wallet: string, label: string): Omit<CopyConfig, 'id' | 'createdAt'> {
  return {
    wallet,
    label,
    enabled: false,
    // Paper. Always paper, until the user has a reason not to.
    mode: 'paper',
    sizing: 'fixed',
    sizeValue: 0.05,
    maxTradeSol: 0.1,
    minLiquidityUsd: 5_000,
    maxMarketCapUsd: null,
    minKryptScore: null,
    onlyPumpfun: false,
    delayMs: 0,
    maxSlippagePct: 15,
    copySells: true,
    dailyLossLimitSol: 0.25,
    dailyTradeLimit: 20,
  };
}

export function validateConfig(c: Omit<CopyConfig, 'id' | 'createdAt'>): { ok: boolean; message: string } {
  if (!c.wallet || c.wallet.length < 32) return { ok: false, message: 'Enter a valid wallet address' };
  if (!(c.sizeValue > 0)) return { ok: false, message: 'Size must be greater than zero' };
  if (c.sizing === 'proportional' && c.sizeValue > 500) {
    return { ok: false, message: 'Proportional size cannot exceed 500% of their trade' };
  }
  if (!(c.maxTradeSol > 0) || c.maxTradeSol > 25) {
    return { ok: false, message: 'Max per trade must be between 0 and 25 SOL' };
  }
  if (c.sizing === 'fixed' && c.sizeValue > c.maxTradeSol) {
    return { ok: false, message: 'Fixed size is above your own max per trade' };
  }
  if (c.delayMs < 0 || c.delayMs > 60_000) return { ok: false, message: 'Delay must be between 0 and 60 seconds' };
  if (c.maxSlippagePct <= 0 || c.maxSlippagePct > 50) {
    return { ok: false, message: 'Slippage must be between 0% and 50%' };
  }
  if (!(c.dailyLossLimitSol > 0)) return { ok: false, message: 'Set a daily loss limit' };
  if (!(c.dailyTradeLimit > 0) || c.dailyTradeLimit > 500) {
    return { ok: false, message: 'Daily trade limit must be between 1 and 500' };
  }
  return { ok: true, message: 'ok' };
}

/** How much we would copy for a trade of `theirSol`. */
export function copySize(c: CopyConfig, theirSol: number): number {
  const raw = c.sizing === 'fixed' ? c.sizeValue : theirSol * (c.sizeValue / 100);
  return Math.min(raw, c.maxTradeSol);
}

export function describeConfig(c: CopyConfig): string {
  const size = c.sizing === 'fixed' ? `${c.sizeValue} SOL` : `${c.sizeValue}% of their size`;
  return `${c.mode === 'paper' ? 'Paper-copy' : 'COPY'} ${c.label || `${c.wallet.slice(0, 6)}…`} at ${size} (max ${c.maxTradeSol})`;
}

/** Win rate, or null when nothing has closed yet. */
export function winRate(s: CopyStats): number | null {
  const closed = s.wins + s.losses;
  return closed > 0 ? (s.wins / closed) * 100 : null;
}
