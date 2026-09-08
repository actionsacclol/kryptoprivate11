// Potential runners — the scanner's output as a terminal tab (2026-09-02).
//
// Each row is a launch the graduation-odds model put in a top bucket at
// +60 s or +120 s. The rate shown is what that bucket did on the measured
// day (docs/runner-odds-2026-08-30.md); the base rate sits beside it so the
// odds AGAINST are never hidden. Open takes you to the token page, where the
// trade panel is — nothing here buys.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Star } from 'lucide-react';
import type { LaunchRow } from '@shared/types';
import { Sparkline } from '../components/viz/Sparkline';
import { useAppState } from '../state/AppStateProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useToast } from '../state/ToastProvider';
import { Card, Empty, IconButton, NumberInput, Page, Section } from '../components/common';
import { cls } from '../utils/format';
import { RUNNER_BUCKET_LABEL, RUNNER_TTL_MS, bucketLabel, pruneRunners } from '@shared/runners';
import type { RunnerFlag } from '@shared/runners';

/** Where the quick-buy size is remembered, matching Discover's own. */
const QUICK_KEY = 'krypto:runners:quickBuySol';

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function RunnerRow({
  r,
  live,
  refreshedPriceSol,
  watched,
  quickSol,
  canBuy,
  held,
  busy,
  onOpen,
  onToggleWatch,
  onBuy,
  onSell,
}: {
  r: RunnerFlag;
  /** The scanner's live row for this mint, while it is still tracked —
   *  the source of the sparkline and the price now. */
  live: LaunchRow | null;
  /** A price pulled by the refresh button for a launch the scanner has
   *  stopped tracking, so the move since the flag is still answerable. */
  refreshedPriceSol: number | null;
  watched: boolean;
  /** Size a quick buy sends, in SOL. */
  quickSol: number;
  /** Whether a real buy can be placed at all right now. */
  canBuy: boolean;
  /** True when the wallet actually holds this token, so Sell means something. */
  held: boolean;
  /** 'buy' or 'sell' while an order for THIS row is in flight. */
  busy: 'buy' | 'sell' | null;
  onOpen: () => void;
  onToggleWatch: () => void;
  onBuy: () => void;
  onSell: () => void;
}) {
  const failPct = Math.max(0, 100 - r.observedPct);
  // Move since the flag, from the scanner's own price — the honest answer to
  // "was this flag any good?", not a provider quote that may lag.
  const nowPrice = live?.priceSol ?? refreshedPriceSol;
  const sinceFlag = nowPrice !== null && nowPrice !== undefined && r.priceSol > 0 ? (nowPrice / r.priceSol - 1) * 100 : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex items-center gap-4 px-5 py-3 border-b border-white/5 last:border-b-0 cursor-pointer hover:bg-white/[0.03] transition"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-[14px] text-white truncate">{r.symbol || r.mint.slice(0, 6)}</span>
          <span className="text-[11px] text-krypt-muted truncate">{r.name}</span>
          <span className="text-[10px] font-mono text-krypt-muted/60 whitespace-nowrap">
            {ago(r.flaggedAt)} · judged at +{r.windowS} s
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          <span className="text-arc-gold font-semibold">
            {bucketLabel(r.bucket)} · {r.observedPct.toFixed(0)} % graduated
          </span>
          <span className="text-krypt-muted">base {r.basePct.toFixed(1)} % · {failPct.toFixed(0)} % did not · n={r.n}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] font-mono text-white/75">
          <span>curve {r.curvePct.toFixed(0)} %</span>
          <span>{r.uniqueBuyers} buyers</span>
          <span className={r.netInflowSol >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
            {r.netInflowSol >= 0 ? '+' : ''}{r.netInflowSol.toFixed(2)} SOL net
          </span>
          <span>{r.tradesSeen} trades</span>
        </div>
      </div>
      <div
        className="flex flex-shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <button
          onClick={onBuy}
          disabled={!canBuy || busy !== null}
          title={canBuy ? `Buy ${quickSol} SOL of ${r.symbol || 'this token'} now` : 'Needs a funded wallet with live execution armed'}
          className={cls(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition',
            canBuy
              ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
              : 'cursor-not-allowed border-white/8 bg-white/[0.02] text-krypt-muted/40',
          )}
        >
          {busy === 'buy' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Buy {quickSol}
        </button>
        <button
          onClick={onSell}
          disabled={!held || busy !== null}
          title={held ? 'Sell your whole position in this token' : 'You hold none of this token'}
          className={cls(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition',
            held
              ? 'border-rose-400/45 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
              : 'cursor-not-allowed border-white/8 bg-white/[0.02] text-krypt-muted/40',
          )}
        >
          {busy === 'sell' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Sell
        </button>
      </div>

      <div className="hidden md:flex flex-col items-end gap-0.5 flex-shrink-0 w-28">
        {live && live.priceHistory.length > 1 ? (
          <Sparkline data={live.priceHistory} width={96} height={24} positive={sinceFlag === null ? undefined : sinceFlag >= 0} />
        ) : (
          <span
            className="text-[10px] text-krypt-muted/50"
            title="The scanner has stopped tracking this launch, so there is no tape to draw here. Refresh pulls its price; open it for the full chart."
          >
            {refreshedPriceSol === null ? 'no live tape' : 'price only'}
          </span>
        )}
        <span
          className={cls('font-mono text-[11px]', sinceFlag === null ? 'text-krypt-muted/50' : sinceFlag >= 0 ? 'text-emerald-300' : 'text-rose-300')}
          title="Price now vs price at the moment of the flag"
        >
          {sinceFlag === null ? '—' : `${sinceFlag >= 0 ? '+' : ''}${sinceFlag.toFixed(1)}% since flag`}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleWatch();
          }}
          title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
          className={cls('transition', watched ? 'text-arc-gold' : 'text-krypt-muted/40 hover:text-arc-gold/70')}
        >
          <Star className="h-4 w-4" fill={watched ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="rounded-md border border-krypt-purple/45 bg-krypt-purple/15 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-krypt-purple/30 hover:shadow-krypt-glow transition"
        >
          Open
        </button>
      </div>
    </div>
  );
}

export function RunnersPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const { runners, launches, settings, status, refreshFromEngine } = useAppState();
  const term = useTerminal();
  const toast = useToast();
  const cfg = settings.strategy.runnerAlerts;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  /** Prices pulled for flags the scanner no longer tracks, by mint. */
  const [pulled, setPulled] = useState<Record<string, number>>({});
  /** Quick-buy size, remembered per viewer like the one on Discover. */
  const [quickSol, setQuickSol] = useState<number>(() => {
    const stored = Number(localStorage.getItem(QUICK_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : 0.1;
  });
  /** Mints the wallet actually holds, so Sell is only offered when it means
   *  something. Read from the portfolio, refreshed after every fill. */
  const [heldMints, setHeldMints] = useState<Set<string>>(new Set());
  const [busyMint, setBusyMint] = useState<{ mint: string; side: 'buy' | 'sell' } | null>(null);
  // Ages ("3m ago", "since flag") tick along without anything else changing —
  // and the tick is what expires rows between engine pushes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Which runners are held decides the Sell button, nothing more — so the
  // engine's kept build is enough. This used to start a full 5–10 s
  // provider build on every visit (measured 2026-09-08).
  const loadHoldings = useCallback(async () => {
    const r = await window.krypt.portfolio.summary({ stale: true });
    if (r.ok && r.data) setHeldMints(new Set(r.data.positions.filter((p) => p.amount > 0).map((p) => p.mint)));
  }, []);

  useEffect(() => {
    void loadHoldings();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'portfolio') setHeldMints(new Set(ev.summary.positions.filter((p) => p.amount > 0).map((p) => p.mint)));
    });
    return off;
  }, [loadHoldings]);
  const liveByMint = useMemo(() => {
    const m = new Map<string, LaunchRow>();
    for (const l of launches) m.set(l.mint, l);
    return m;
  }, [launches]);
  // A flag is a call about the next few minutes; past the TTL it is history,
  // not a suggestion. Filtering here as well as in the engine means a row
  // disappears on the clock even while the engine is stopped.
  const visible = useMemo(() => pruneRunners(runners, Date.now()), [runners, tick]);
  const ttlMin = Math.round(RUNNER_TTL_MS / 60_000);

  // Same gate the Discover quick buy uses: a real broadcast needs live
  // execution armed and a funded wallet. Nothing here is capped — a click is
  // a manual trade, and the per-trade cap bounds unattended execution.
  const canBuy = settings.execution.liveEnabled && status.liveActive && (status.walletBalanceSol ?? 0) > 0;

  const quickBuy = async (r: RunnerFlag): Promise<void> => {
    if (!canBuy || busyMint) return;
    setBusyMint({ mint: r.mint, side: 'buy' });
    try {
      const res = await window.krypt.live.testTrade(r.mint, quickSol, false);
      if (res.ok) toast.success(`${r.symbol || 'Token'}: ${res.message}`);
      else toast.error(`${r.symbol || 'Token'}: ${res.message}`);
      await loadHoldings();
    } finally {
      setBusyMint(null);
    }
  };

  const quickSell = async (r: RunnerFlag): Promise<void> => {
    if (busyMint) return;
    setBusyMint({ mint: r.mint, side: 'sell' });
    try {
      const res = await window.krypt.live.sellToken(r.mint, 100);
      if (res.ok) toast.success(`${r.symbol || 'Token'}: ${res.message}`);
      else toast.error(`${r.symbol || 'Token'}: ${res.message}`);
      await loadHoldings();
    } finally {
      setBusyMint(null);
    }
  };

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    const startedAt = Date.now();
    try {
      await refreshFromEngine();
      // Re-price the flags the scanner has stopped tracking. Without this the
      // button could only re-read what the engine had already pushed, so a
      // second press had nothing left to change. Bounded, newest first.
      const stale = pruneRunners(runners, Date.now())
        .filter((r) => !liveByMint.has(r.mint))
        .slice(0, 8);
      if (stale.length) {
        const got = await Promise.all(
          stale.map(async (r) => {
            try {
              const res = await window.krypt.market.summary(r.mint);
              const price = res.ok && res.data ? res.data.priceSol : null;
              return price && price > 0 ? [r.mint, price] : null;
            } catch {
              return null;
            }
          }),
        );
        const next: Record<string, number> = {};
        for (const g of got) if (g) next[g[0] as string] = g[1] as number;
        if (Object.keys(next).length) setPulled((cur) => ({ ...cur, ...next }));
      }
      setRefreshedAt(Date.now());
    } finally {
      // Hold the spinner briefly so a press is always visibly acknowledged,
      // even when everything was already up to date.
      const spent = Date.now() - startedAt;
      if (spent < 350) await new Promise((res) => setTimeout(res, 350 - spent));
      setRefreshing(false);
    }
  };

  return (
    <Page
      title="Potential runners"
      subtitle={`${visible.length} active · flags expire after ${ttlMin} min · floor: ${cfg ? RUNNER_BUCKET_LABEL[cfg.minBucket] : '—'}${refreshedAt ? ` · refreshed ${ago(refreshedAt)}` : ''}`}
      actions={
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="whitespace-nowrap text-[11px] text-krypt-muted">Quick buy</span>
          <NumberInput
            value={quickSol}
            min={0.001}
            max={100}
            onChange={(v) => {
              setQuickSol(v);
              try {
                localStorage.setItem(QUICK_KEY, String(v));
              } catch {
                /* storage unavailable; the size just resets next launch */
              }
            }}
            suffix="SOL"
            className="w-32"
          />
          <IconButton onClick={() => void refresh()} title="Re-pull the list and live prices from the scanner" disabled={refreshing}>
            <RefreshCw className={cls('h-4 w-4', refreshing && 'animate-spin')} />
          </IconButton>
        </div>
      }
    >
      <Section
        description={`Every launch the scanner sees is judged at +60 s and +120 s with the graduation-odds model measured on 73,890 launches. The ones in the top buckets land here, newest first, with what that bucket actually did on the measured day. Most still did not graduate. A flag drops off after ${ttlMin} minutes — by then it has moved or it has not. Buy and Sell act the moment you click them, at the size beside the refresh button; nothing is ever bought for you.`}
      >
        {!cfg?.enabled ? (
          <Empty
            title="Runner alerts are off"
            message="Turn on “Flag potential runners” in Spellbook → Runner alerts. The scanner must be running too."
          />
        ) : !status.running && runners.length === 0 ? (
          <Empty
            title="Scanner is stopped"
            message="Start the scanner from the Observatory. A launch is judged about a minute after it appears."
          />
        ) : visible.length === 0 ? (
          <Empty
            title={runners.length ? `Nothing flagged in the last ${ttlMin} minutes` : 'Nothing flagged yet'}
            message="Flags arrive a minute or two after a launch. Lower the bucket floor in Spellbook → Runner alerts to see more; raise it to see only the top 1 %."
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            {visible.map((r) => (
              <RunnerRow
                key={r.mint}
                r={r}
                live={liveByMint.get(r.mint) ?? null}
                refreshedPriceSol={pulled[r.mint] ?? null}
                quickSol={quickSol}
                canBuy={canBuy}
                held={heldMints.has(r.mint)}
                busy={busyMint?.mint === r.mint ? busyMint.side : null}
                onBuy={() => void quickBuy(r)}
                onSell={() => void quickSell(r)}
                watched={term.isWatched(r.mint)}
                onOpen={() => onOpenToken(r.mint)}
                onToggleWatch={() => term.toggleWatch(r.mint)}
              />
            ))}
          </Card>
        )}
      </Section>
    </Page>
  );
}
