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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChainKind } from '@shared/evm';
import { useAppState } from '../state/AppStateProvider';
import { chainMatches, usePanelChain } from './chainFilter';
import { loadChartToken, setChartToken, subscribeChartToken, type ChartToken } from './chartToken';
import { parsePin, useTerminal } from '../state/TerminalProvider';
import { KryptChart } from '../components/terminal/KryptChart';
import type { Candle } from '@shared/market';
import type { AdvOrder, OrdersSnapshot } from '@shared/orders';
import type { TradeHistoryRow } from '@shared/portfolio';
import type { EvmFill } from '@shared/evm';
import { scriptChain, type ScriptSnapshot } from '@shared/automation';
import { chainOf, leaderTooFast, type CopySnapshot } from '@shared/copytrade';
import type { Alert } from '@shared/alerts';
import type { Position } from '@shared/portfolio';
import { tokenLinks, type TokenLink, type TokenLinkKind } from '@shared/tokenLinks';
import { describeXStats, fmtCount, validateXStats, xPageKindOf, xStatsReaderScript, type XStats } from '@shared/xStats';
import { loadXStats, saveXStats } from '../state/useXStats';
import { loadSiteRead, saveSiteRead } from '../state/useSiteRead';
import { useLinkIntel } from '../state/useLinkIntel';
import { describeSiteRead, siteReaderScript, validateSiteRead, type SiteRead } from '@shared/siteRead';
import { describeTelegram, fmtRegistered } from '@shared/linkIntel';
import { parseXLink } from '@shared/xLink';
import { ExternalLink } from 'lucide-react';
import { GamesBody } from './GamesBody';
import { cls } from '../utils/format';
import { newestFirst } from '@shared/callouts';
import { useCallouts } from '../state/callouts';
import { CalloutRow } from '../components/CalloutRow';

/**
 * What a panel may ask the app to do. Panels render as `<p.Body />` with no
 * props, so this is a context rather than a prop drilled through every one of
 * them. Empty by default: a panel rendered outside a provider is inert, never
 * broken.
 */
export interface PanelActions {
  openToken?: (mint: string, chain?: ChainKind) => void;
}
export const PanelActionsContext = createContext<PanelActions>({});

export interface PanelSpec {
  /** Stable forever — it keys both the saved layout and the enabled set. */
  id: string;
  title: string;
  /** One line, shown in the panel picker. Say what it is, not why it is good. */
  blurb: string;
  /** Default placement on the 12-column grid. */
  layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
  /** Rows on this panel belong to a chain, so it gets a chain picker in its
   *  header and its Body reads `usePanelChain()`. */
  chainAware?: true;
  /** A panel that wants a DIFFERENT control in the middle of its header
   *  supplies one. It shares state with the Body through a store rather than
   *  props, because the two are rendered in different places. */
  HeaderControl?: () => ReactNode;
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
      <div className="text-micro uppercase tracking-label text-krypt-muted/70">{label}</div>
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
  return <p className="py-6 text-center text-body text-krypt-muted">{children}</p>;
}

/** A scrolling list that stays readable when the panel is dragged small. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="space-y-1 text-body">{children}</div>;
}

/**
 * pump.fun callouts, on the grid.
 *
 * The same rows as the right-hand rail, from the same single poll - both
 * subscribe to one store, so having the widget AND the rail open costs one
 * request every 30 s, not two.
 *
 * Chain-aware like its neighbours, with one difference worth knowing: pump's
 * feed carries chains this app has no rail for (hyperevm, arc). Those rows
 * survive the `all` filter - a call is a call - but they are not clickable,
 * because offering to open a coin this app cannot open is a worse answer
 * than plain information.
 */
function CalloutsBody(): ReactNode {
  const filter = usePanelChain();
  const { openToken } = useContext(PanelActionsContext);
  const { rows, answered, error, loading } = useCallouts(true);
  const shown = useMemo(() => {
    const sorted = newestFirst(rows).slice(0, 60);
    return filter === 'all' ? sorted : sorted.filter((c) => c.chain !== null && chainMatches(filter, c.chain));
  }, [rows, filter]);
  if (!answered && loading) return <Empty>Reading pump.fun…</Empty>;
  if (!answered && error) return <Empty>{error}</Empty>;
  if (!shown.length) {
    return <Empty>No callouts right now{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  }
  return (
    <Rows>
      {shown.map((c) => (
        <CalloutRow key={c.id} c={c} onOpen={openToken} />
      ))}
    </Rows>
  );
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
        <p className="rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-label text-amber-200">{status.pauseReason}</p>
      )}
      {/* feedLossPct is null until enough trades are seen — that is a real
          "not measured yet", so it must not read as a healthy 0%. */}
      <div className="text-label text-krypt-muted">
        Feed loss: {typeof status.feedLossPct === 'number' ? `${status.feedLossPct.toFixed(1)}%` : '— not measured yet'}
      </div>
    </div>
  );
}

function WalletBody(): ReactNode {
  const { status } = useAppState();
  // While live, the session's REAL fills (shared/liveSession.ts — the same
  // ledger the Observatory shows). This panel used to read `liveBuys` /
  // `liveSells`, which counted the scanner's own trades — gone since
  // 2026-08-16 — so a session of manual trades read "0 / 0" (user report
  // 2026-09-20). A paper session shows the paper book instead.
  const ls = status.liveActive ? status.liveSession ?? null : null;
  const toneOf = (v: number | null): 'good' | 'bad' | 'muted' => (v === null ? 'muted' : v >= 0 ? 'good' : 'bad');
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label="Balance" value={status.walletBalanceSol === null ? '—' : `${status.walletBalanceSol.toFixed(4)}`} />
      {ls ? (
        <>
          <Stat label="Buys / sells (session)" value={`${ls.buys} / ${ls.sells}${ls.pending ? ` · ${ls.pending} settling` : ''}`} />
          {/* The wallet's change since the session began — every fee and
              every open bag's cost included. Null until the baseline is read. */}
          <Stat label="Wallet change (session)" value={sol(status.liveRealizedPnlSol)} tone={toneOf(status.liveRealizedPnlSol)} />
          {/* Closed round trips only. "—" until one closes: no trip is not
              a profit of zero. */}
          <Stat label="Realised (session)" value={sol(ls.realizedSol)} tone={toneOf(ls.realizedSol)} />
        </>
      ) : (
        <>
          <Stat label="Mode" value={status.liveActive ? 'Live' : 'Paper'} tone="muted" />
          <Stat label="Paper PnL" value={sol(status.realizedPnlSol)} tone={status.realizedPnlSol >= 0 ? 'good' : 'bad'} />
          <Stat label="Paper open / closed" value={`${num(status.openPositions)} / ${num(status.closedPositions)}`} />
        </>
      )}
    </div>
  );
}

function PositionsBody(): ReactNode {
  // NOT useAppState().positions. That is the AUTONOMOUS engine's simulated
  // book (shared/types.ts PaperPosition, "live once a REAL on-chain buy backs
  // this position") — on a manual-execution product it is empty, which is why
  // this panel showed nothing while the wallet held plenty.
  //
  // The real answer is the portfolio the Portfolio page reads: what the wallet
  // holds, priced, with an honest basis. Solana pushes a `portfolio` event;
  // the two EVM rails are pulled, because they have no equivalent push.
  const filter = usePanelChain();
  const [sol, setSol] = useState<Position[]>([]);
  const [evm, setEvm] = useState<Array<{ chain: ChainKind; mint: string; symbol: string; pnlPct: number | null }>>([]);

  useEffect(() => {
    let alive = true;
    void window.krypt.portfolio.summary({ stale: true }).then((r) => {
      if (alive && r.ok && r.data) setSol(r.data.positions);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'portfolio') setSol(ev.summary.positions);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // EVM holdings are a pull with no push behind them, so they are refreshed on
  // a slow timer rather than per event. Thirty seconds is the same order as
  // the portfolio's own refresh and costs two RPC reads.
  useEffect(() => {
    let alive = true;
    const chains: ChainKind[] = ['robinhood', 'bnb'];
    const pull = async (): Promise<void> => {
      const out: Array<{ chain: ChainKind; mint: string; symbol: string; pnlPct: number | null }> = [];
      for (const c of chains) {
        if (filter !== 'all' && filter !== c) continue;
        try {
          // portfolio(), not holdings(): the EVM ledger DOES compute cost
          // basis from reconciled on-chain fills (evm/ledger.ts basisByToken),
          // so these positions have real PnL. holdings() is the balance read
          // underneath and carries none — using it is what made this panel
          // show an em dash and made me call the basis missing.
          const r = await window.krypt.evm.portfolio(c as 'robinhood' | 'bnb');
          if (r.ok && r.data) {
            for (const h of r.data.positions) {
              // Still null when the basis genuinely is not known — an
              // unreconciled buy — which is the honest em dash, not a blanket one.
              out.push({ chain: c, mint: h.token, symbol: h.symbol, pnlPct: h.basisKnown ? h.unrealizedPnlPct : null });
            }
          }
        } catch {
          /* a chain that cannot answer contributes nothing, never a zero row */
        }
      }
      if (alive) setEvm(out);
    };
    void pull();
    const t = setInterval(() => void pull(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [filter]);

  const rows = useMemo(() => {
    const a = sol
      .filter((p) => p.amount > 0 && chainMatches(filter, 'solana'))
      .map((p) => ({ key: `solana-${p.mint}`, chain: 'solana' as ChainKind, mint: p.mint, symbol: p.symbol || `${p.mint.slice(0, 6)}…`, pnlPct: p.unrealizedPnlPct, paper: p.paper === true }));
    const b = evm
      .filter((h) => chainMatches(filter, h.chain))
      .map((h) => ({ key: `${h.chain}-${h.mint}`, chain: h.chain, mint: h.mint, symbol: h.symbol || `${h.mint.slice(0, 6)}…`, pnlPct: h.pnlPct, paper: false }));
    return [...a, ...b];
  }, [sol, evm, filter]);

  if (!rows.length) return <Empty>Nothing open{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  return (
    <Rows>
      {rows.map((r) => (
        <TokenRow
          key={r.key}
          mint={r.mint}
          chain={r.chain}
          left={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[r.chain])}>{CHAIN_SHORT[r.chain]}</span>
              <span className="truncate font-medium text-white/90">{r.symbol}</span>
              {r.paper && <span className="shrink-0 rounded bg-white/10 px-1 text-micro text-krypt-muted">paper</span>}
            </span>
          }
          right={
            // Unknown is an em dash, never 0 %.
            r.pnlPct === null ? (
              <span className="shrink-0 font-mono text-krypt-muted">—</span>
            ) : (
              <span className={`shrink-0 font-mono ${r.pnlPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {r.pnlPct >= 0 ? '+' : ''}
                {r.pnlPct.toFixed(1)}%
              </span>
            )
          }
        />
      ))}
    </Rows>
  );
}

function LaunchesBody(): ReactNode {
  const { launches } = useAppState();
  const filter = usePanelChain();
  // The live launch feed is Solana's. The EVM rails track a launch only for
  // its 130 s measurement window (EVM_SCAN_TRACK_MS) and surface what they
  // concluded as a runner call, which the Runner alerts panel already shows —
  // so rather than pad this list with rows that vanish in two minutes, it says
  // where to look.
  if (filter === 'robinhood' || filter === 'bnb') {
    return <Empty>The live launch feed is Solana&rsquo;s. {CHAIN_SHORT[filter]} launches are measured for two minutes and reported in Runner alerts.</Empty>;
  }
  if (!launches.length) return <Empty>No launches yet. Start the scanner to see them arrive.</Empty>;
  return (
    <Rows>
      {launches.slice(0, 40).map((l) => (
        <TokenRow
          key={l.mint}
          mint={l.mint}
          left={<span className="truncate font-medium text-white/90">{l.symbol || l.name || `${l.mint.slice(0, 6)}…`}</span>}
          right={<span className="shrink-0 font-mono text-krypt-muted">{ago(l.detectedAt)}</span>}
        />
      ))}
    </Rows>
  );
}

/**
 * A row that opens its coin.
 *
 * Shared by every panel whose rows are tokens, so the click target, the
 * disabled state and the hover affordance are defined once. Outside a
 * PanelActionsProvider `openToken` is absent and the row renders as plain
 * text rather than a button that does nothing.
 */
function TokenRow({
  mint,
  chain = 'solana',
  left,
  right,
  title,
}: {
  mint: string;
  chain?: ChainKind;
  left: ReactNode;
  right: ReactNode;
  title?: string;
}): ReactNode {
  const { openToken } = useContext(PanelActionsContext);
  const base = 'flex w-full items-center justify-between gap-2 rounded border border-white/5 bg-white/[0.02] px-2 py-1 text-left';
  if (!openToken) {
    return (
      <div className={base} title={title}>
        {left}
        {right}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => openToken(mint, chain)} title={title} className={cls(base, 'cursor-pointer transition hover:border-krypt-purple/40 hover:bg-white/[0.06]')}>
      {left}
      {right}
    </button>
  );
}

function RunnersBody(): ReactNode {
  const { runners, evmRunners } = useAppState();
  const filter = usePanelChain();
  // Both rails in one newest-first list. They are separate types on purpose —
  // an EVM chain measures buyers and a rate, not a curve regime or an odds
  // bucket — so only what BOTH actually have is shown per row, and each says
  // which chain it came from.
  const rows = useMemo(() => {
    const sol = runners.map((r) => ({
      key: `sol-${r.mint}-${r.flaggedAt}`,
      chain: 'solana' as ChainKind,
      mint: r.mint,
      symbol: r.symbol || `${r.mint.slice(0, 6)}…`,
      at: r.flaggedAt,
      note: `${r.windowS}s`,
      title: r.line,
    }));
    const evm = evmRunners.map((f) => ({
      key: `${f.chain}-${f.token}-${f.flaggedAt}`,
      chain: f.chain as ChainKind,
      mint: f.token,
      symbol: f.symbol || `${f.token.slice(0, 6)}…`,
      at: f.flaggedAt,
      note: `${f.uniqueBuyers} buyers`,
      title: f.detail,
    }));
    return [...sol, ...evm]
      .filter((r) => chainMatches(filter, r.chain))
      .sort((a, b) => b.at - a.at)
      .slice(0, 40);
  }, [runners, evmRunners, filter]);
  if (!rows.length) return <Empty>Nothing flagged this session{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  return (
    <Rows>
      {rows.map((r) => (
        <TokenRow
          key={r.key}
          mint={r.mint}
          chain={r.chain}
          title={r.title || undefined}
          left={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[r.chain])}>{CHAIN_SHORT[r.chain]}</span>
              <span className="truncate font-medium text-white/90">{r.symbol}</span>
            </span>
          }
          right={
            <span className="shrink-0 font-mono text-krypt-muted">
              {r.note} · {ago(r.at)}
            </span>
          }
        />
      ))}
    </Rows>
  );
}

/** Short names and tints, so a glance says which rail without reading. */
const CHAIN_SHORT: Record<ChainKind, string> = { solana: 'SOL', robinhood: 'RH', bnb: 'BNB' };
const CHAIN_TAG: Record<ChainKind, string> = {
  solana: 'bg-krypt-purple/20 text-krypt-purple',
  robinhood: 'bg-emerald-500/15 text-emerald-300',
  bnb: 'bg-amber-500/15 text-amber-300',
};

/**
 * A price chart for whatever token was opened last.
 *
 * The chart component itself is a dumb renderer, so this owns the fetch. It
 * follows `chartToken`, which App writes on every token open — click a runner
 * in the panel beside it and this follows, in this window or a popped-out one.
 *
 * Deliberately NOT chain-filtered: a chart has one subject and that subject
 * already knows its chain. A filter here would be a way to make it show
 * nothing.
 */
/**
 * The chart's subject picker: the watchlist, plus whatever is on the chart now.
 *
 * The chart follows the last token opened, which is useful and was also the
 * whole behaviour — so a chart could only be pointed somewhere by navigating
 * there. Picking from the watchlist writes the same `chartToken` the rest of
 * the app writes, so the two ways of choosing cannot disagree and a popped-out
 * chart follows either.
 *
 * The current token is always an option even when it is not on the watchlist;
 * a select whose value is not in its own list renders blank.
 */
function ChartHeaderControl(): ReactNode {
  const { watchlist } = useTerminal();
  const { launches } = useAppState();
  const [token, setToken] = useState<ChartToken | null>(() => loadChartToken());
  useEffect(() => subscribeChartToken(() => setToken(loadChartToken())), []);

  const options = useMemo(() => {
    const symbolOf = (mint: string): string => {
      const l = launches.find((x) => x.mint === mint);
      return l?.symbol || l?.name || `${mint.slice(0, 6)}…`;
    };
    const out = watchlist.map((pin) => {
      const { mint, chain } = parsePin(pin);
      return { key: pin, mint, chain, label: symbolOf(mint) };
    });
    // Whatever is on the chart, if the watchlist does not already carry it.
    if (token && !out.some((o) => o.mint === token.mint)) {
      out.unshift({ key: `current:${token.mint}`, mint: token.mint, chain: token.chain as ChainKind, label: token.symbol || symbolOf(token.mint) });
    }
    return out;
  }, [watchlist, launches, token]);

  if (!options.length) {
    return <span className="truncate text-micro text-krypt-muted">Watch a token to pick it here</span>;
  }
  const current = options.find((o) => o.mint === token?.mint)?.key ?? '';
  return (
    <select
      // Both drag systems have to leave it alone — see chainFilter.tsx.
      className="panel-action no-drag max-w-[9rem] cursor-pointer rounded border border-white/10 bg-black/30 px-1 py-0.5 text-micro text-krypt-muted outline-none transition hover:text-white focus:border-krypt-purple/50"
      value={current}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const o = options.find((x) => x.key === e.target.value);
        if (o) setChartToken({ mint: o.mint, chain: o.chain, symbol: o.label });
      }}
      title="Which token the chart shows — your watchlist"
      aria-label="Chart token"
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ChartBody(): ReactNode {
  const [token, setToken] = useState<ChartToken | null>(() => loadChartToken());
  const [candles, setCandles] = useState<Candle[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');

  useEffect(() => subscribeChartToken(() => setToken(loadChartToken())), []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    const pull = async (): Promise<void> => {
      try {
        const r =
          token.chain === 'solana'
            ? await window.krypt.market.candles(token.mint, '1m', 300)
            : await window.krypt.evm.candles(token.chain as 'robinhood' | 'bnb', token.mint, '1m', 300);
        if (!alive) return;
        const rows = r.ok && r.data ? r.data.candles : null;
        if (!rows) {
          setState('error');
          return;
        }
        setCandles(rows);
        setState(rows.length ? 'idle' : 'empty');
      } catch {
        if (alive) setState('error');
      }
    };
    setState('loading');
    setCandles([]);
    void pull();
    // Slower than the Terminal's own chart on purpose: this is a side panel,
    // not the page someone is trading from.
    const t = setInterval(() => void pull(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token?.mint, token?.chain]);

  if (!token) return <Empty>Open a token and its chart appears here — from this panel&rsquo;s neighbours, the search, or anywhere else.</Empty>;
  const label = token.symbol || `${token.mint.slice(0, 6)}…`;
  if (state === 'loading' && !candles.length) return <Empty>Loading {label}…</Empty>;
  if (state === 'error') return <Empty>No candles for {label} — the provider could not price it.</Empty>;
  if (state === 'empty') return <Empty>No candles for {label} yet.</Empty>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1 flex shrink-0 items-center justify-between">
        <span className="truncate text-body font-medium text-white/90">{label}</span>
        <span className="shrink-0 text-micro uppercase tracking-label text-krypt-muted">1m</span>
      </div>
      {/* The chart fills whatever the panel was resized to; `height` is a
          number rather than a class, so it is measured here. */}
      <div className="min-h-0 flex-1">
        <ChartAuto candles={candles} />
      </div>
    </div>
  );
}

/** Feeds the chart its pixel height, which the panel decides by being resized. */
function ChartAuto({ candles }: { candles: Candle[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.max(120, Math.floor(el.clientHeight))));
    ro.observe(el);
    setH(Math.max(120, Math.floor(el.clientHeight)));
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="h-full w-full">
      {/* Stable empties: a fresh `[]` per render defeated the chart's memo,
          so every grid re-render (each pointer move of a panel drag) ran the
          chart's marker and price-line effects for nothing. */}
      <KryptChart candles={candles} markers={NO_MARKERS} priceLines={NO_LINES} mode="price" supply={null} bucketSec={60} height={h} />
    </div>
  );
}
const NO_MARKERS: never[] = [];
const NO_LINES: never[] = [];

/**
 * The Observatory: what each chain's scanner is actually doing.
 *
 * All three rails in one panel, because "is it watching, and is it keeping
 * up" is the same question on each and the answer used to live on three
 * different pages. Solana's comes from the engine status it already pushes;
 * the two EVM chains push their own on every poll.
 *
 * Every number is the scanner's own. A chain that has not reported is an em
 * dash, and "off" is stated rather than shown as zero — a stopped scanner and
 * a scanner seeing nothing are different facts.
 */
function ObservatoryBody(): ReactNode {
  const { status, evmScan } = useAppState();
  const filter = usePanelChain();

  const rows: Array<{
    chain: ChainKind;
    on: boolean;
    state: string;
    behind: number | null;
    seen: number | null;
    flagged: number | null;
  }> = [];

  if (chainMatches(filter, 'solana')) {
    rows.push({
      chain: 'solana',
      on: status.running,
      state: status.running ? status.feed : 'stopped',
      // The pump feed is a socket, not a block cursor — it has no "behind".
      behind: null,
      seen: status.launchesSeen,
      flagged: status.runnersFlagged,
    });
  }
  for (const c of ['robinhood', 'bnb'] as const) {
    if (!chainMatches(filter, c)) continue;
    const st = evmScan[c];
    rows.push({
      chain: c,
      on: st?.running === true,
      state: st ? (st.running ? 'watching' : st.enabled ? 'stopped' : 'off in settings') : '—',
      behind: st?.behind ?? null,
      seen: st?.launchesSeen ?? null,
      flagged: st?.callsFlagged ?? null,
    });
  }

  if (!rows.length) return <Empty>No chain selected.</Empty>;
  return (
    <Rows>
      {rows.map((r) => (
        <div key={r.chain} className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[r.chain])}>{CHAIN_SHORT[r.chain]}</span>
              <span className={cls('truncate text-body', r.on ? 'text-white/90' : 'text-krypt-muted')}>{r.state}</span>
            </span>
            <span className={cls('shrink-0 h-1.5 w-1.5 rounded-full', r.on ? 'bg-emerald-400' : 'bg-krypt-muted/40')} aria-hidden="true" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-micro text-krypt-muted">
            <span>
              seen {num(r.seen)} · flagged {num(r.flagged)}
            </span>
            {/* Blocks behind the head. Only the EVM rails have one, and it is
                the number that says whether a scanner is keeping up. */}
            <span className={cls(r.behind !== null && r.behind > 50 ? 'text-krypt-warn' : '')}>
              {r.behind === null ? '' : `${r.behind} behind`}
            </span>
          </div>
        </div>
      ))}
    </Rows>
  );
}

/**
 * Advanced orders that are still live.
 *
 * The one panel worth having open while nothing is being watched: these are
 * the instructions that will spend or sell on their own. It says up front
 * whether they can execute at all — an armed stop that cannot fire is the
 * most dangerous thing here to mistake for protection.
 *
 * Solana only, and it says so rather than showing an empty list on the other
 * rails: shared/orders.ts carries no chain, and advanced orders have no EVM
 * implementation — the same gap the scripting work records.
 */
function OrdersBody(): ReactNode {
  const filter = usePanelChain();
  const [snap, setSnap] = useState<OrdersSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void window.krypt.orders.list().then((r) => {
      if (alive && r.ok && r.data) setSnap(r.data);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'orders') setSnap(ev.snapshot);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (filter === 'robinhood' || filter === 'bnb') {
    return <Empty>Advanced orders are Solana-only. {CHAIN_SHORT[filter]} has no order engine yet.</Empty>;
  }
  if (!snap) return <Empty>Loading…</Empty>;
  // "Live" means it could still act. A filled or cancelled order is history
  // and belongs on the Orders page, not on a watch panel.
  const live = snap.orders.filter((o) => o.state === 'armed' || o.state === 'paused' || o.state === 'triggered');
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {/* First, because an order that cannot fire is not protection. */}
      {snap.blockedReason && (
        <div className="shrink-0 rounded border border-krypt-warn/25 bg-krypt-warn/[0.07] px-2 py-1 text-micro text-krypt-muted">
          Cannot execute — {snap.blockedReason}
        </div>
      )}
      {snap.pausedCount > 0 && (
        <div className="shrink-0 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-micro text-krypt-muted">
          {snap.pausedCount} restored from disk, waiting for you to resume them.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!live.length ? (
          <Empty>Nothing armed.</Empty>
        ) : (
          <Rows>
            {live.map((o) => (
              <TokenRow
                key={o.id}
                mint={o.mint}
                left={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium text-white/90">{o.symbol || `${o.mint.slice(0, 6)}…`}</span>
                    <span className="shrink-0 text-micro text-krypt-muted">{ORDER_LABEL[o.kind] ?? o.kind}</span>
                  </span>
                }
                right={
                  <span className={cls('shrink-0 font-mono text-micro', o.state === 'paused' ? 'text-krypt-warn' : 'text-krypt-muted')}>
                    {o.state === 'paused' ? 'paused' : fmtTrigger(o)}
                  </span>
                }
              />
            ))}
          </Rows>
        )}
      </div>
    </div>
  );
}

/** Short names; this panel is three columns wide at its narrowest. */
const ORDER_LABEL: Record<string, string> = {
  stop_loss: 'stop',
  take_profit: 'TP',
  trailing_stop: 'trail',
  limit_buy: 'limit buy',
  limit_sell: 'limit sell',
};

function fmtTrigger(o: AdvOrder): string {
  if (o.triggerValue === null) return o.state;
  if (o.triggerBasis === 'pct') return `${o.triggerValue > 0 ? '+' : ''}${o.triggerValue}%`;
  if (o.triggerBasis === 'mcap_usd') return `$${Math.round(o.triggerValue).toLocaleString()}`;
  return String(o.triggerValue);
}

/**
 * What actually executed, newest first, on every rail.
 *
 * A fill whose chain delta has not been read yet says `pending` rather than
 * showing a zero: what a trade COST is the chain's number, never the size that
 * was asked for — the rule the ledger is built on.
 */
function FillsBody(): ReactNode {
  const filter = usePanelChain();
  const [sol, setSol] = useState<TradeHistoryRow[]>([]);
  const [evm, setEvm] = useState<EvmFill[]>([]);

  useEffect(() => {
    let alive = true;
    const pull = async (): Promise<void> => {
      if (chainMatches(filter, 'solana')) {
        const r = await window.krypt.portfolio.history();
        if (alive && r.ok && r.data) setSol(r.data);
      } else if (alive) {
        setSol([]);
      }
      const out: EvmFill[] = [];
      for (const c of ['robinhood', 'bnb'] as const) {
        if (!chainMatches(filter, c)) continue;
        try {
          const r = await window.krypt.evm.fills(c);
          if (r.ok && r.data) out.push(...r.data);
        } catch {
          /* a rail that cannot answer contributes nothing, never a zero row */
        }
      }
      if (alive) setEvm(out);
    };
    void pull();
    // Driven by the engine saying a fill landed, rather than a poll.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'fill' || ev.kind === 'evmFill' || ev.kind === 'paper') void pull();
    });
    return () => {
      alive = false;
      off();
    };
  }, [filter]);

  const rows = useMemo(() => {
    const a = sol.map((f) => ({
      key: `solana-${f.signature ?? f.at}-${f.mint}`,
      chain: 'solana' as ChainKind,
      mint: f.mint,
      symbol: f.symbol || `${f.mint.slice(0, 6)}…`,
      side: f.side,
      at: f.at,
      delta: f.state === 'reconciled' ? f.solDelta : null,
      pending: f.state !== 'reconciled',
      paper: f.paper === true,
    }));
    const b = evm.map((f) => ({
      key: `${f.chain}-${f.id}`,
      chain: f.chain as ChainKind,
      mint: f.token,
      symbol: f.symbol || `${f.token.slice(0, 6)}…`,
      side: f.side,
      at: f.at,
      delta: f.nativeDeltaWei === null ? null : Number(f.nativeDeltaWei) / 1e18,
      pending: f.nativeDeltaWei === null,
      paper: false,
    }));
    return [...a, ...b].sort((x, y) => y.at - x.at).slice(0, 40);
  }, [sol, evm]);

  if (!rows.length) return <Empty>No fills yet{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  return (
    <Rows>
      {rows.map((r) => (
        <TokenRow
          key={r.key}
          mint={r.mint}
          chain={r.chain}
          left={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[r.chain])}>{CHAIN_SHORT[r.chain]}</span>
              <span className={cls('shrink-0 text-micro font-semibold uppercase', r.side === 'buy' ? 'text-emerald-300/80' : 'text-rose-300/80')}>{r.side}</span>
              <span className="truncate font-medium text-white/90">{r.symbol}</span>
              {r.paper && <span className="shrink-0 rounded bg-white/10 px-1 text-micro text-krypt-muted">paper</span>}
            </span>
          }
          right={
            <span className="shrink-0 font-mono text-micro text-krypt-muted">
              {r.pending || r.delta === null ? 'pending' : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}`} · {ago(r.at)}
            </span>
          }
        />
      ))}
    </Rows>
  );
}

/**
 * Every script, with what it has actually done today.
 *
 * A script spends money with nobody at the button, so the numbers worth a
 * panel are the ones that say whether it is still inside its budget: buys
 * against its cap, realised against its own loss limit, and whether it is
 * erroring.
 */
function ScriptsBody(): ReactNode {
  const filter = usePanelChain();
  const [snap, setSnap] = useState<ScriptSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void window.krypt.automation.list().then((r) => {
      if (alive && r.ok && r.data) setSnap(r.data);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'automation') setSnap(ev.snapshot);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!snap) return <Empty>Loading…</Empty>;
  const scripts = snap.scripts.filter((sc) => chainMatches(filter, scriptChain(sc)));
  if (!scripts.length) return <Empty>No scripts{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {snap.killSwitch && (
        <div className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-micro text-rose-200">
          Kill switch on — every script is off.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <Rows>
          {scripts.map((sc) => {
            const st = snap.stats[sc.id];
            const chain = scriptChain(sc);
            // Against the script's OWN cap — the number that disables it.
            const lossCap = sc.budget.maxLossSolPerDay;
            const down = st ? Math.max(0, -st.realizedSolToday) : 0;
            return (
              <div key={sc.id} className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[chain])}>{CHAIN_SHORT[chain]}</span>
                    <span className="truncate font-medium text-white/90">{sc.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {sc.mode === 'live' && <span className="rounded bg-rose-500/20 px-1 text-micro font-semibold uppercase text-rose-200">live</span>}
                    <span className={cls('h-1.5 w-1.5 rounded-full', sc.enabled ? 'bg-emerald-400' : 'bg-krypt-muted/40')} aria-hidden="true" />
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-micro text-krypt-muted">
                  <span>{st ? `${st.buysToday}/${sc.budget.maxBuysPerDay} buys · ${st.openCount} open` : '—'}</span>
                  <span className={cls(down > 0 && down >= lossCap * 0.75 ? 'text-krypt-warn' : '')}>
                    {st ? `${st.realizedSolToday >= 0 ? '+' : ''}${st.realizedSolToday.toFixed(3)} of ${lossCap}` : '—'}
                  </span>
                </div>
                {st && st.lastError ? (
                  <div className="mt-0.5 truncate text-micro text-rose-300/80" title={st.lastError}>
                    {st.errorsInARow}x {st.lastError}
                  </div>
                ) : null}
              </div>
            );
          })}
        </Rows>
      </div>
    </div>
  );
}

/**
 * Followed wallets, and what copying them has done for you.
 *
 * Two different numbers sit side by side on purpose: THEIR record and YOUR
 * copies. Only the second is your money, and conflating them is how a wallet
 * with a great record looks like a great result.
 *
 * The "too fast to copy" flag rides along from the leaderboard work: a wallet
 * whose trips finish inside a minute was over before a copy could join it,
 * however good its own record looks.
 */
function CopyBody(): ReactNode {
  const filter = usePanelChain();
  const [snap, setSnap] = useState<CopySnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void window.krypt.copy.list().then((r) => {
      if (alive && r.ok && r.data) setSnap(r.data);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'copy') setSnap(ev.snapshot);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!snap) return <Empty>Loading…</Empty>;
  const configs = snap.configs.filter((c) => chainMatches(filter, chainOf(c)));
  if (!configs.length) return <Empty>Not following anyone{filter === 'all' ? '' : ` on ${CHAIN_SHORT[filter]}`}.</Empty>;
  return (
    <Rows>
      {configs.map((c) => {
        const chain = chainOf(c);
        const leader = snap.leaders[c.wallet];
        // Your side: every config on this wallet, summed.
        const mine = Object.values(snap.stats).filter((st) => {
          const owner = snap.configs.find((x) => x.id === st.configId);
          return owner && owner.wallet === c.wallet;
        });
        const copies = mine.reduce((a, st) => a + st.trades, 0);
        const realized = mine.reduce((a, st) => a + st.realizedPnlSol, 0);
        const closed = mine.reduce((a, st) => a + st.wins + st.losses, 0);
        return (
          <div key={c.id} className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cls('shrink-0 rounded px-1 text-micro font-semibold uppercase', CHAIN_TAG[chain])}>{CHAIN_SHORT[chain]}</span>
                <span className="truncate font-medium text-white/90">{c.label || `${c.wallet.slice(0, 6)}…`}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {c.mode === 'live' && <span className="rounded bg-rose-500/20 px-1 text-micro font-semibold uppercase text-rose-200">live</span>}
                <span className={cls('h-1.5 w-1.5 rounded-full', c.enabled ? 'bg-emerald-400' : 'bg-krypt-muted/40')} aria-hidden="true" />
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-micro text-krypt-muted">
              {/* Yours, not theirs. */}
              <span>
                {copies} {copies === 1 ? 'copy' : 'copies'}
                {closed > 0 ? ' · ' : ''}
                {closed > 0 && (
                  <span className={realized >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {realized >= 0 ? '+' : ''}
                    {realized.toFixed(3)}
                  </span>
                )}
              </span>
              {leader && leaderTooFast(leader) ? (
                <span className="text-krypt-warn" title="Most of this wallet's round trips finish inside a minute — they were over before a copy could join them.">
                  too fast to copy
                </span>
              ) : (
                <span>{leader ? `${leader.roundTrips} trips` : '—'}</span>
              )}
            </div>
          </div>
        );
      })}
    </Rows>
  );
}

/**
 * Alerts, armed and recently fired.
 *
 * Solana-side like the order engine — shared/alerts.ts carries no chain — so
 * it says that on the other rails rather than showing an empty list.
 */
function AlertsBody(): ReactNode {
  const filter = usePanelChain();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);

  useEffect(() => {
    let alive = true;
    // list() answers a snapshot (alerts + the notification switch); the event
    // carries the array alone.
    void window.krypt.alerts.list().then((r) => {
      if (alive && r.ok && r.data) setAlerts(r.data.alerts);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'alerts') setAlerts(ev.alerts);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (filter === 'robinhood' || filter === 'bnb') {
    return <Empty>Alerts are Solana-only. {CHAIN_SHORT[filter]} has no alert engine yet.</Empty>;
  }
  if (!alerts) return <Empty>Loading…</Empty>;
  if (!alerts.length) return <Empty>No alerts set.</Empty>;
  // Armed first — those can still fire, and that is what a watch panel is for.
  const sorted = [...alerts].sort((a, b) => {
    const rank = (x: Alert): number => (x.state === 'armed' ? 0 : 1);
    return rank(a) - rank(b) || (b.lastFiredAt ?? b.createdAt) - (a.lastFiredAt ?? a.createdAt);
  });
  return (
    <Rows>
      {sorted.slice(0, 40).map((a) => (
        <TokenRow
          key={a.id}
          mint={a.mint}
          left={
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cls('shrink-0 h-1.5 w-1.5 rounded-full', a.state === 'armed' ? 'bg-emerald-400' : 'bg-krypt-muted/40')} aria-hidden="true" />
              <span className="truncate font-medium text-white/90">{a.symbol || (a.mint ? `${a.mint.slice(0, 6)}…` : 'wallet')}</span>
              <span className="shrink-0 text-micro text-krypt-muted">{a.kind.replace(/_/g, ' ')}</span>
            </span>
          }
          right={
            <span className="shrink-0 font-mono text-micro text-krypt-muted">
              {a.lastFiredAt ? `fired ${ago(a.lastFiredAt)}` : a.threshold === null ? a.state : String(a.threshold)}
            </span>
          }
        />
      ))}
    </Rows>
  );
}

function EquityBody(): ReactNode {
  const { equity, status } = useAppState();
  // The series follows the mode (AppStateProvider): the wallet's change
  // since the live session began while live, the paper book's realized
  // otherwise. It used to be the paper line whatever the mode, so a live
  // session in profit read "Session realised 0.0000" (user report
  // 2026-09-20).
  const live = equity.length ? equity[equity.length - 1].live : status.liveActive;
  if (equity.length < 2) {
    return <Empty>{live ? 'No points yet — this fills in as the wallet moves.' : 'Not enough points yet — this fills in while the engine runs.'}</Empty>;
  }
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
        <span className="text-micro uppercase tracking-label text-krypt-muted/70">{live ? 'Session PnL (wallet change)' : 'Session realised (paper)'}</span>
        <span className={`font-mono text-sm font-semibold ${last >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{sol(last)}</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="min-h-[40px] w-full flex-1">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-krypt-purple" />
      </svg>
      <div className="flex justify-between text-micro text-krypt-muted">
        <span>{sol(min)}</span>
        <span>{sol(max)}</span>
      </div>
    </div>
  );
}

/**
 * The open token's own pages, inside the app (2026-09-20). A sandboxed
 * browser view — Electron's <webview>: its own process and cookie jar, no
 * preload, no access to anything of ours, enforced in main by
 * webSecurity.guardWebviews — shows the token's X, website or launchpad page;
 * clicking another button loads that page in the same box. It follows the
 * same token the Chart panel does, so opening a coin anywhere fills both.
 */
const hostOfUrl = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

/** A page that is the token's own site — not X, not Telegram, not a launchpad, not blank. */
function isTokenSitePage(url: string): boolean {
  let h: string;
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  if (!h) return false;
  if (/(^|\.)(x|twitter)\.com$/.test(h)) return false;
  if (h === 't.me' || h === 'telegram.me') return false;
  if (h === 'pump.fun' || h === 'four.meme' || h.endsWith('ponslaunchpad.com')) return false;
  return true;
}

function LinksBody(): ReactNode {
  const [token, setToken] = useState<ChartToken | null>(() => loadChartToken());
  const [links, setLinks] = useState<TokenLink[] | null>(null);
  const [active, setActive] = useState<TokenLinkKind | null>(null);
  /** Where the view actually is — a page may redirect; the line under it says so. */
  const [current, setCurrent] = useState<string | null>(null);
  const viewRef = useRef<HTMLElement | null>(null);
  /** What the view read off the X page this token links, and when. */
  const [xs, setXs] = useState<{ stats: XStats; readAt: number } | null>(null);
  const [reading, setReading] = useState(false);
  /** What the view read off the token's own website, and when. */
  const [site, setSite] = useState<{ read: SiteRead; readAt: number } | null>(null);
  /** Telegram members + the domain record, looked up by main for this token. */
  const intel = useLinkIntel(token?.chain === 'solana' ? token.mint : null);
  const readSeq = useRef(0);
  useEffect(() => subscribeChartToken(() => setToken(loadChartToken())), []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setLinks(null);
    setActive(null);
    setCurrent(null);
    setXs(loadXStats(token.mint));
    setSite(loadSiteRead(token.mint));
    const load = async (): Promise<void> => {
      try {
        const r =
          token.chain === 'solana'
            ? await window.krypt.market.summary(token.mint)
            : await window.krypt.evm.summary(token.chain as 'robinhood' | 'bnb', token.mint);
        if (!alive) return;
        const s = r.ok && r.data ? r.data : null;
        const list = tokenLinks(token.chain, token.mint, s?.launchpad ?? null, s?.socials ?? null);
        // The panel opens on the LAUNCHPAD page (pump.fun, four.meme, Pons)
        // when the token has one, with X, website and Telegram as the other
        // buttons — the token header keeps the socials-first order. A new
        // token resets to that default.
        const panelOrder = [...list.filter((l) => l.kind === 'launchpad'), ...list.filter((l) => l.kind !== 'launchpad')];
        setLinks(panelOrder);
        setActive(panelOrder[0]?.kind ?? null);
      } catch {
        if (alive) setLinks([]);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [token?.mint, token?.chain]);

  // Read the numbers off an X page the view is showing (2026-09-20): a
  // profile's followers, a post's likes. No API and no extra request — the
  // page is already rendered for the person looking at it, and the host
  // asks the view what is on its screen. Three looks, spaced, because X
  // paints after load; unknown stays unknown. Only ever on x.com pages, only
  // ever the page a person opened here: nothing is crawled.
  const readStats = useCallback(async (): Promise<void> => {
    const el = viewRef.current as (HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown>; getURL?: () => string }) | null;
    const mint = token?.mint;
    if (!el || !mint || typeof el.executeJavaScript !== 'function') return;
    const url = typeof el.getURL === 'function' ? el.getURL() : '';
    const onX = xPageKindOf(url) !== 'other';
    // The token's own website (2026-09-20) is read the same way — only the
    // page a person opened here, only for a Solana token (the record is kept
    // by mint), never a launchpad, X or Telegram page.
    const onSite = !onX && token?.chain === 'solana' && isTokenSitePage(url);
    if (!onX && !onSite) return;
    const seq = ++readSeq.current;
    setReading(true);
    try {
      if (onX) {
        for (const wait of [1200, 2500, 4000]) {
          await new Promise((r) => setTimeout(r, wait));
          if (seq !== readSeq.current) return;
          const raw = await el.executeJavaScript(xStatsReaderScript()).catch(() => null);
          const clean = validateXStats(raw);
          if (!clean) continue;
          const got = clean.followers !== null || clean.likes !== null || clean.views !== null;
          if (got || clean.loginWall) {
            setXs(saveXStats(mint, clean));
            void window.krypt.links.setXStats(mint, clean);
            return;
          }
        }
        return;
      }
      // Two looks: site builders paint after load, and an empty first read
      // is not a fact about the site.
      for (const wait of [1500, 4000]) {
        await new Promise((r) => setTimeout(r, wait));
        if (seq !== readSeq.current) return;
        const raw = await el.executeJavaScript(siteReaderScript(mint)).catch(() => null);
        const clean = validateSiteRead(raw);
        if (!clean) continue;
        if (clean.wordCount > 0 || wait === 4000) {
          setSite(saveSiteRead(mint, clean));
          void window.krypt.links.setSiteRead(mint, clean);
          return;
        }
      }
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  }, [token?.mint, token?.chain]);
  const readStatsRef = useRef(readStats);
  readStatsRef.current = readStats;

  // The view's own navigation events keep the URL line honest, and a
  // finished load (or an in-page hop — X is a single-page app) triggers a read.
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onNav = (e: Event): void => {
      const url = (e as Event & { url?: unknown }).url;
      if (typeof url === 'string') setCurrent(url);
      void readStatsRef.current();
    };
    const onLoad = (): void => void readStatsRef.current();
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('did-finish-load', onLoad);
    return () => {
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('did-finish-load', onLoad);
    };
  }, [links]);

  if (!token) return <Empty>Open a token and its links appear here — X, website and launchpad page, in this box.</Empty>;
  const label = token.symbol || `${token.mint.slice(0, 6)}…`;
  if (!links) return <Empty>Reading {label}’s links…</Empty>;
  if (!links.length) return <Empty>{label} has no X, website or launchpad page on record.</Empty>;
  const shown = links.find((l) => l.kind === active) ?? links[0];
  const where = current ?? shown.url;
  const tokenX = parseXLink(links.find((l) => l.kind === 'x')?.url ?? null).handle;
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {links.map((l) => (
          <button
            key={l.kind + l.url}
            onClick={() => {
              setActive(l.kind);
              setCurrent(l.url);
            }}
            title={l.url}
            className={cls(
              'panel-action no-drag rounded border px-2 py-0.5 text-micro font-semibold transition',
              shown.url === l.url ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
            )}
          >
            {l.label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => void window.krypt.app.openExternal(where)}
          title="Open this page in your browser"
          className="panel-action no-drag flex items-center gap-1 text-micro text-krypt-muted hover:text-white"
        >
          <ExternalLink className="h-3 w-3" />
          Browser
        </button>
      </div>
      {/* Said on the panel, every time: a site that LOOKS like part of the
          app is exactly how a phishing page would present itself. The view
          cannot see the wallet or the keys, and nothing on it is ours. */}
      <div className="shrink-0 truncate text-micro text-krypt-muted/70" title={where}>
        {hostOfUrl(where)} · external site in a sandbox — nothing on it is Krypt; never enter a key or seed phrase
      </div>
      <webview
        ref={viewRef}
        key={token.mint}
        src={shown.url}
        partition="persist:links"
        className="no-drag min-h-0 flex-1 rounded border border-white/10 bg-black/40"
        style={{ display: 'flex' }}
      />
      {/* The numbers, at the bottom: read off the page above when it is an X
          profile or post — no API, no extra request, the way a person would
          read them. The launchpad and website pages have nothing standard
          to read. X's layout changes without notice; anything it cannot
          find stays unknown, and the wall is named when X shows it. */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-label text-krypt-muted"
        title="Read off the X page the way a person would — no API, no extra request. Shown whichever page is open above. X's layout changes without notice; anything it cannot find stays unknown."
      >
        {/* The X numbers, whichever page is open above: the last read stays
            on the bar while the pump.fun page or the website is showing. */}
        {!xs ? (
          <span>{shown.kind === 'x' ? (reading ? 'reading the page…' : 'nothing read off this page yet') : links.some((l) => l.kind === 'x') ? 'open X above to read its numbers' : 'no X link to read'}</span>
        ) : xs.stats.loginWall ? (
          <span>{describeXStats(xs.stats)}</span>
        ) : (
          <>
            {xs.stats.handle && <span className="font-semibold text-white/90">@{xs.stats.handle}</span>}
            {xs.stats.page === 'profile' && (
              <>
                <XCell v={fmtCount(xs.stats.followers)} label="followers" />
                <XCell v={fmtCount(xs.stats.following)} label="following" />
                {xs.stats.joined && <XCell v={xs.stats.joined} label="joined" />}
                {xs.stats.verified === true && <span className="text-arc-gold">verified</span>}
              </>
            )}
            {xs.stats.page === 'post' && (
              <>
                <XCell v={fmtCount(xs.stats.likes)} label="likes" />
                <XCell v={fmtCount(xs.stats.reposts)} label="reposts" />
                <XCell v={fmtCount(xs.stats.replies)} label="replies" />
                <XCell v={fmtCount(xs.stats.views)} label="views" />
                <XCell v={fmtCount(xs.stats.bookmarks)} label="bookmarks" />
              </>
            )}
            {xs.stats.page === 'other' && <span>not a profile or a post — nothing to read</span>}
            <span className="text-krypt-muted/60">read {ago(xs.readAt)} ago</span>
          </>
        )}
        {/* Telegram and the domain, looked up by main (2026-09-20); the
            site read when the website is the page showing. */}
        {intel?.telegram && (
          <span title={intel.telegram.reason ?? intel.telegram.url}>
            {intel.telegram.preview && intel.telegram.preview.members !== null ? (
              <XCell v={fmtCount(intel.telegram.preview.members)} label={`Telegram ${intel.telegram.preview.countWord ?? 'members'}`} />
            ) : intel.telegram.state === 'pending' || intel.telegram.state === 'none' ? (
              'Telegram: looking up…'
            ) : (
              `Telegram: ${intel.telegram.preview ? describeTelegram(intel.telegram.preview) : intel.telegram.reason ?? 'unknown'}`
            )}
          </span>
        )}
        {intel?.website && (
          <span title={intel.website.reason ?? intel.website.url}>
            {intel.website.hostedOn ? (
              `site on ${intel.website.hostedOn}`
            ) : intel.website.record?.registeredAt ? (
              <XCell v={fmtRegistered(intel.website.record.registeredAt)} label="domain registered" />
            ) : intel.website.state === 'pending' || intel.website.state === 'none' ? (
              'domain: looking up…'
            ) : (
              `domain: ${intel.website.reason ?? 'unknown'}`
            )}
          </span>
        )}
        {site && shown.kind === 'website' && (
          <span className="text-krypt-muted/80" title={`Read off the site ${ago(site.readAt)} ago — what the page says, not a verdict`}>
            {describeSiteRead(site.read, tokenX)}
          </span>
        )}
        <span className="flex-1" />
        {(shown.kind === 'x' || shown.kind === 'website') && (
          <button onClick={() => void readStatsRef.current()} className="panel-action no-drag shrink-0 text-krypt-muted hover:text-white" disabled={reading}>
            {reading ? 'Reading…' : 'Read again'}
          </button>
        )}
      </div>
    </div>
  );
}

/** One number and its word, for the bar under the view. "—" is unknown. */
function XCell({ v, label }: { v: string; label: string }): ReactNode {
  return (
    <span>
      <span className="font-mono text-body font-semibold text-white/90">{v}</span> {label}
    </span>
  );
}

export const PANELS: PanelSpec[] = [
  { id: 'engine', title: 'Engine', blurb: 'Scanner state, uptime and what it has seen.', layout: { x: 0, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: EngineBody },
  { id: 'wallet', title: 'Wallet', blurb: 'Balance, live trade counts and session PnL.', layout: { x: 4, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: WalletBody },
  { id: 'equity', title: 'Session PnL', blurb: 'Realised PnL over this session.', layout: { x: 8, y: 0, w: 4, h: 6, minW: 3, minH: 5 }, Body: EquityBody },
  { id: 'positions', chainAware: true, title: 'Open positions', blurb: 'What is open right now, and how it is doing.', layout: { x: 0, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: PositionsBody },
  { id: 'launches', chainAware: true, title: 'Live launches', blurb: 'New tokens as the scanner sees them.', layout: { x: 4, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: LaunchesBody },
  { id: 'orders', chainAware: true, title: 'Open orders', blurb: 'Stops, take profits and limits that are still armed.', layout: { x: 9, y: 14, w: 3, h: 8, minW: 3, minH: 5 }, Body: OrdersBody },
  { id: 'fills', chainAware: true, title: 'Recent fills', blurb: 'What actually executed, on every chain.', layout: { x: 0, y: 24, w: 4, h: 8, minW: 3, minH: 4 }, Body: FillsBody },
  { id: 'scripts', chainAware: true, title: 'Scripts', blurb: 'Every script, what it has spent today and whether it is armed.', layout: { x: 4, y: 24, w: 4, h: 8, minW: 3, minH: 4 }, Body: ScriptsBody },
  { id: 'copy', chainAware: true, title: 'Copy trading', blurb: 'Followed wallets, and what copying them did for you.', layout: { x: 8, y: 24, w: 4, h: 8, minW: 3, minH: 4 }, Body: CopyBody },
  { id: 'alerts', chainAware: true, title: 'Alerts', blurb: 'Armed alerts and the ones that recently fired.', layout: { x: 9, y: 22, w: 3, h: 6, minW: 3, minH: 4 }, Body: AlertsBody },
  { id: 'observatory', chainAware: true, title: 'Observatory', blurb: 'Each chain’s scanner: watching or not, how far behind, what it has flagged.', layout: { x: 6, y: 14, w: 3, h: 8, minW: 3, minH: 5 }, Body: ObservatoryBody },
  { id: 'chart', HeaderControl: ChartHeaderControl, title: 'Chart', blurb: 'The last token you opened, on a 1-minute chart.', layout: { x: 0, y: 14, w: 6, h: 10, minW: 4, minH: 6 }, Body: ChartBody },
  { id: 'links', title: 'Links', blurb: 'The open token’s X, website and launchpad page, shown in a box you can switch between.', layout: { x: 6, y: 14, w: 6, h: 10, minW: 4, minH: 6 }, Body: LinksBody },
  { id: 'games', title: 'Games', blurb: 'Snake, Flappy Crypto, Dino and Tetris — for the wait between candles.', layout: { x: 0, y: 24, w: 4, h: 10, minW: 3, minH: 7 }, Body: GamesBody },
  { id: 'runners', chainAware: true, title: 'Runner alerts', blurb: 'Launches flagged as potential runners this session.', layout: { x: 8, y: 6, w: 4, h: 8, minW: 3, minH: 4 }, Body: RunnersBody },
  { id: 'callouts', chainAware: true, title: 'Callouts', blurb: 'Coins people are publicly calling on pump.fun, and whether the caller holds one.', layout: { x: 4, y: 32, w: 4, h: 8, minW: 3, minH: 4 }, Body: CalloutsBody },
];

/** The panels a first-time layout opens with. */
/**
 * Everything, on by default.
 *
 * Only reached by an install with no saved layout — anyone who has arranged
 * theirs keeps it. Thirteen panels is a lot to meet at once, but the picker is
 * right there and switching one off is easier than discovering it exists.
 */
export const DEFAULT_ENABLED = PANELS.map((p) => p.id);
