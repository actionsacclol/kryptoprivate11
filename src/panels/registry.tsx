// The widgets a user can put on their own layout.
//
// PanelGrid is the container; this is the catalogue. Every entry here must be
// SELF-CONTAINED: it takes no props, reads what it needs from AppState, and
// renders sensibly at any size the user drags it to. That rule is what makes a
// free-form grid possible at all — most of the panels in components/terminal
// are pieces of the token page and need a mint, a fetched report or a refresh
// key, so they cannot go on a grid that has no selected token.
//
// The house rules apply here exactly as everywhere else: a number is shown
// only when it was actually read, and unknown renders as an em dash, never 0.
// A widget on a dashboard is read at a glance and acted on without a second
// look, which makes a confident zero worse here than almost anywhere.

import type { ReactNode } from 'react';
import { useAppState } from '../state/AppStateProvider';

export interface PanelSpec {
  /** Stable forever — it keys both the saved layout and the enabled set. */
  id: string;
  title: string;
  /** One line, shown in the panel picker. Say what it is, not why it is good. */
  blurb: string;
  /** Default placement on the 12-column grid. */
  layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
  Body: () => ReactNode;
}

/** Unknown is an em dash. Never 0. */
const num = (v: number | null | undefined, digits = 0): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

const sol = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(4)} SOL` : '—';

const ago = (t: number | null | undefined): string => {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'muted' }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.18em] text-krypt-muted/70">{label}</div>
      <div
        className={`mt-0.5 font-mono text-base font-semibold ${
          tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'muted' ? 'text-krypt-muted' : 'text-white'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[11px] text-krypt-muted">{children}</p>;
}

/** A scrolling list that stays readable when the panel is dragged small. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="space-y-1 text-[11px]">{children}</div>;
}

// ── the widgets ──────────────────────────────────────────────────────────────

function EngineBody(): ReactNode {
  const { status } = useAppState();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Scanner" value={status.running ? 'Running' : 'Stopped'} tone={status.running ? 'good' : 'muted'} />
        <Stat label="Uptime" value={status.startedAt ? ago(status.startedAt) : '—'} />
        <Stat label="Launches seen" value={num(status.launchesSeen)} />
        <Stat label="Runners flagged" value={num(status.runnersFlagged)} />
      </div>
      {status.entriesPaused && status.pauseReason && (
        <p className="rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">{status.pauseReason}</p>
      )}
      {/* feedLossPct is null until enough trades are seen — that is a real
          "not measured yet", so it must not read as a healthy 0%. */}
      <div className="text-[10px] text-krypt-muted">
        Feed loss: {typeof status.feedLossPct === 'number' ? `${status.feedLossPct.toFixed(1)}%` : '— not measured yet'}
      </div>
    </div>
  );
}

function WalletBody(): ReactNode {
  const { status } = useAppState();
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label="Balance" value={status.walletBalanceSol === null ? '—' : `${status.walletBalanceSol.toFixed(4)}`} />
      <Stat label="Live buys / sells" value={`${num(status.liveBuys)} / ${num(status.liveSells)}`} />
      {/* Null when live has not been armed this session. Not zero. */}
      <Stat
        label="Live PnL (session)"
        value={sol(status.liveRealizedPnlSol)}
        tone={status.liveRealizedPnlSol === null ? 'muted' : status.liveRealizedPnlSol >= 0 ? 'good' : 'bad'}
      />
      <Stat label="Paper PnL" value={sol(status.realizedPnlSol)} tone={status.realizedPnlSol >= 0 ? 'good' : 'bad'} />
    </div>
  );
}

function PositionsBody(): ReactNode {
  const { positions } = useAppState();
  const open = positions.filter((p) => p.state !== 'closed');
  if (!open.length) return <Empty>Nothing open.</Empty>;
  return (
    <Rows>
      {open.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2 rounded border border-white/5 bg-white/[0.02] px-2 py-1">
          <span className="truncate font-medium text-white/90">{p.symbol || `${p.mint.slice(0, 6)}…`}</span>
          <span className={`font-mono ${p.pnlPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {p.pnlPct >= 0 ? '+' : ''}
            {p.pnlPct.toFixed(1)}%
          </span>
        </div>
      ))}
    </Rows>
  );
}

function LaunchesBody(): ReactNode {
  const { launches } = useAppState();
  if (!launches.length) return <Empty>No launches yet. Start the scanner to see them arrive.</Empty>;
  return (
    <Rows>
      {launches.slice(0, 40).map((l) => (
        <div key={l.mint} className="flex items-center justify-between gap-2 rounded border border-white/5 bg-white/[0.02] px-2 py-1">
          <span className="truncate font-medium text-white/90">{l.symbol || l.name || `${l.mint.slice(0, 6)}…`}</span>
          <span className="shrink-0 font-mono text-krypt-muted">{ago(l.detectedAt)}</span>
        </div>
      ))}
    </Rows>
  );
}

function RunnersBody(): ReactNode {
  const { runners } = useAppState();
  if (!runners.length) return <Empty>Nothing flagged this session.</Empty>;
  return (
    <Rows>
      {runners.slice(0, 40).map((r) => (
        <div key={`${r.mint}-${r.flaggedAt}`} className="flex items-center justify-between gap-2 rounded border border-white/5 bg-white/[0.02] px-2 py-1">
          <span className="truncate font-medium text-white/90">{r.symbol || `${r.mint.slice(0, 6)}…`}</span>
          <span className="shrink-0 font-mono text-krypt-muted">
            {r.windowS}s · {ago(r.flaggedAt)}
          </span>
        </div>
      ))}
    </Rows>
  );
}

function EquityBody(): ReactNode {
  const { equity } = useAppState();
  if (equity.length < 2) return <Empty>Not enough points yet — this fills in while the engine runs.</Empty>;
  const vs = equity.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const last = vs[vs.length - 1];
  // A plain polyline: no chart library, no fetch, and it scales with the panel.
  const pts = equity
    .map((p, i) => `${(i / (equity.length - 1)) * 100},${100 - ((p.v - min) / span) * 100}`)
    .join(' ');
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-[0.18em] text-krypt-muted/70">Session realised</span>
        <span className={`font-mono text-sm font-semibold ${last >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{sol(last)}</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="min-h-[40px] w-full flex-1">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-krypt-purple" />
      </svg>
      <div className="flex justify-between text-[9px] text-krypt-muted">
        <span>{sol(min)}</span>
        <span>{sol(max)}</span>
      </div>
    </div>
  );
}

export const PANELS: PanelSpec[] = [
  { id: 'engine', title: 'Engine', blurb: 'Scanner state, uptime and what it has seen.', layout: { x: 0, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: EngineBody },
  { id: 'wallet', title: 'Wallet', blurb: 'Balance, live trade counts and session PnL.', layout: { x: 4, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: WalletBody },
  { id: 'equity', title: 'Session PnL', blurb: 'Realised PnL over this session.', layout: { x: 8, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: EquityBody },
  { id: 'positions', title: 'Open positions', blurb: 'What is open right now, and how it is doing.', layout: { x: 0, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: PositionsBody },
  { id: 'launches', title: 'Live launches', blurb: 'New tokens as the scanner sees them.', layout: { x: 4, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: LaunchesBody },
  { id: 'runners', title: 'Runner alerts', blurb: 'Launches flagged as potential runners this session.', layout: { x: 8, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: RunnersBody },
];

/** The panels a first-time layout opens with. */
export const DEFAULT_ENABLED = ['engine', 'wallet', 'equity', 'positions'];
