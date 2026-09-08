import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Coins, RefreshCw } from 'lucide-react';
import { Badge, Card, Empty, GhostButton, Page, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { Sparkline } from '../components/viz/Sparkline';
import { NumberTicker } from '../components/viz/NumberTicker';
import type { PaperPosition, WalletHolding } from '@shared/types';
import { cachedHoldings, rememberHoldings } from '../state/routeCache';
import { cls, fmtAgo, fmtClock, fmtPct, fmtPrice, fmtSol, shortAddr } from '../utils/format';

/** On-chain truth: every SPL token the trading wallet holds right now —
 *  including leftovers from previous runs or crashes that no session
 *  position list remembers. */
export function HoldingsSection() {
  const { settings } = useAppState();
  const toast = useToast();
  const modal = useModal();
  // Opens on the last read (routeCache / the engine's snapshot); the chain
  // read that follows lands as a 'holdings' event when anything changed.
  const [holdings, setHoldings] = useState<WalletHolding[] | null>(() => cachedHoldings()?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busyMint, setBusyMint] = useState<string | null>(null);
  const liveEnabled = settings.execution.liveEnabled;

  const refresh = useCallback(async () => {
    const r = await window.krypt.wallet.holdings();
    if (r.ok && r.data) {
      setHoldings(r.data);
      rememberHoldings(r.data, Date.now());
      setError(null);
    } else {
      setError(r.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'holdings') {
        setHoldings(ev.data);
        rememberHoldings(ev.data, ev.at);
      }
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [refresh]);

  const sellOne = async (h: WalletHolding): Promise<void> => {
    const label = h.symbol ?? shortAddr(h.mint, 6);
    const yes = await modal.confirm({
      title: 'Sell token (100%)',
      message: `Sell your entire on-chain balance of ${label} (${h.uiAmount.toLocaleString()}) back to SOL?`,
      confirmLabel: 'Sell 100%',
      destructive: true,
    });
    if (!yes) return;
    setBusyMint(h.mint);
    const r = await window.krypt.live.sellToken(h.mint);
    setBusyMint(null);
    if (r.ok) {
      toast.success(`Sell sent for ${label}`);
      void refresh();
    } else {
      toast.error(r.message);
    }
  };

  const sellAll = async (): Promise<void> => {
    const n = holdings?.length ?? 0;
    const yes = await modal.confirm({
      title: 'Sell everything',
      message: `Sell 100% of all ${n} token${n === 1 ? '' : 's'} the wallet holds back to SOL?`,
      confirmLabel: 'Sell all',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.live.sellAll();
    if (r.ok) toast.warn('Sell-all queued — watch the Grimoire');
    else toast.error(r.message);
  };

  const sweepRent = async (): Promise<void> => {
    toast.info('Sweeping rent from empty token accounts…');
    const r = await window.krypt.live.sweepRent();
    if (r.ok) {
      toast.success(r.message);
      void refresh();
    } else {
      toast.error(r.message);
    }
  };

  return (
    <Section
      title="Wallet holdings"
      description="What the wallet actually holds on-chain — including leftovers from previous runs."
      actions={
        <>
          {holdings != null && holdings.length > 0 && (
            <GhostButton destructive onClick={() => void sellAll()} disabled={!liveEnabled} className="!py-1.5 !px-3 text-xs">
              Sell all
            </GhostButton>
          )}
          <GhostButton onClick={() => void sweepRent()} disabled={!liveEnabled} className="!py-1.5 !px-3 text-xs">
            Reclaim rent
          </GhostButton>
          <GhostButton onClick={() => void refresh()} className="!py-1.5 !px-3 text-xs">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </GhostButton>
        </>
      }
    >
      {error ? (
        <Card className="text-xs text-krypt-muted">{error}</Card>
      ) : holdings == null ? (
        <Card className="text-xs text-krypt-muted">Reading the chain…</Card>
      ) : holdings.length === 0 ? (
        <Card className="flex items-center gap-3 text-xs text-krypt-muted">
          <Coins className="h-4 w-4 text-krypt-purple flex-shrink-0" />
          The wallet holds no tokens — every position is fully closed on-chain.
        </Card>
      ) : (
        <Card padded={false} className="divide-y divide-white/5">
          {!liveEnabled && (
            <div className="px-5 py-2 text-[11px] text-amber-300 border-b border-white/10">
              Switch to Live in the top bar to sell from here.
            </div>
          )}
          {holdings.map((h) => (
            <div key={h.tokenAccount} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{h.symbol ?? shortAddr(h.mint, 6)}</span>
                  {h.warning ? <Badge tone="warn">airdrop?</Badge> : !h.symbol && <Badge tone="warn">previous run</Badge>}
                </div>
                <div className="text-[11px] font-mono text-krypt-muted truncate mt-0.5">{h.mint}</div>
                {h.warning && <div className="text-[11px] text-amber-300/90 mt-1">{h.warning}</div>}
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <span className="text-sm font-mono tabular-nums text-white/90">
                  {h.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <GhostButton
                  destructive
                  onClick={() => void sellOne(h)}
                  disabled={!liveEnabled || busyMint !== null}
                  className="!py-1.5 !px-3 text-xs"
                >
                  {busyMint === h.mint ? 'Selling…' : 'Sell 100%'}
                </GhostButton>
              </div>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

const STATE_TONE: Record<PaperPosition['state'], 'neutral' | 'success' | 'warn' | 'danger' | 'gradient'> = {
  open: 'gradient',
  take_profit_1: 'success',
  trailing: 'success',
  closed: 'neutral',
};

/**
 * Memoised by VALUE on what it draws (see LaunchRowView / TokenCard): the
 * engine emits `positionUpdate` on every trade of a held mint, each with a
 * fresh object, so reference equality never held and every card — with its
 * NumberTicker tween and sparkline — reconciled on every trade. The mount
 * tween went too: a card replaced dozens of times a second never finished it.
 */
const PositionCard = memo(function PositionCard({ p, spark }: { p: PaperPosition; spark: number[] }) {
  const [expanded, setExpanded] = useState(false);
  const up = p.pnlSol >= 0;
  return (
    <Card padded={false} className={cls(p.state !== 'closed' && 'border-krypt-purple/25 shadow-krypt-glow')}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-4 px-5 py-3.5 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-krypt-muted flex-shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-krypt-muted flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">{p.symbol}</span>
              {p.live ? <Badge tone="danger">● LIVE</Badge> : <Badge tone="neutral">paper</Badge>}
              <Badge tone={STATE_TONE[p.state]}>{p.state.replace(/_/g, ' ')}</Badge>
              {p.exitReason && <Badge tone="warn">{p.exitReason.replace(/_/g, ' ')}</Badge>}
            </div>
            <div className="text-xs text-krypt-muted truncate mt-0.5">
              {p.name} · opened {fmtAgo(p.openedAt)} ago
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0">
          <Sparkline data={spark} width={110} height={30} positive={up} />
          <div className="text-right">
            <NumberTicker
              value={p.pnlSol}
              format={(v) => `${v >= 0 ? '+' : ''}${fmtSol(v)}`}
              className={cls('block text-base font-mono font-bold tabular-nums', up ? 'text-emerald-300' : 'text-rose-300')}
            />
            <div className={cls('text-xs font-mono', up ? 'text-emerald-300/70' : 'text-rose-300/70')}>
              {fmtPct(p.pnlPct)}
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-5 pb-4 space-y-3 animate-fade-in">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
            {(
              [
                ['Entry', `${fmtPrice(p.entryPriceSol)} SOL`],
                ['Now', `${fmtPrice(p.currentPriceSol)} SOL`],
                ['Peak', `${fmtPrice(p.peakPriceSol)} SOL`],
                ['Recovered', fmtSol(p.recoveredSol)],
              ] as Array<[string, string]>
            ).map(([label, v]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-krypt-muted">{label}</div>
                <div className="font-mono text-white mt-0.5">{v}</div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 divide-y divide-white/5">
            {p.events.map((e, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
                <span className="text-white/90">{e.label}</span>
                <span className="text-krypt-muted font-mono">{fmtClock(e.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}, (a, b) => {
  const x = a.p;
  const y = b.p;
  if (x !== y) {
    if (
      x.id !== y.id ||
      x.symbol !== y.symbol ||
      x.name !== y.name ||
      x.live !== y.live ||
      x.state !== y.state ||
      x.exitReason !== y.exitReason ||
      x.openedAt !== y.openedAt ||
      x.pnlSol !== y.pnlSol ||
      x.pnlPct !== y.pnlPct ||
      x.entryPriceSol !== y.entryPriceSol ||
      x.currentPriceSol !== y.currentPriceSol ||
      x.peakPriceSol !== y.peakPriceSol ||
      x.recoveredSol !== y.recoveredSol ||
      x.events.length !== y.events.length
    ) {
      return false;
    }
  }
  const sx = a.spark;
  const sy = b.spark;
  if (sx === sy) return true;
  return sx.length === sy.length && (sx.length === 0 || sx[sx.length - 1] === sy[sy.length - 1]);
});

const NO_SPARK: number[] = [];

export function Positions() {
  const { positions, launches } = useAppState();
  const open = positions.filter((p) => p.state !== 'closed');
  const closed = positions.filter((p) => p.state === 'closed');
  const counted = closed.filter((p) => p.exitReason !== 'orphaned');
  const realized = counted.reduce((a, p) => a + p.pnlSol, 0);
  const wins = counted.filter((p) => p.pnlSol > 0).length;
  // One map per launches change instead of a linear `find` per card per
  // render — that was O(positions × 300) on every position AND launch push.
  const sparkByMint = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const l of launches) m.set(l.mint, l.priceHistory);
    return m;
  }, [launches]);
  const sparkFor = (mint: string): number[] => sparkByMint.get(mint) ?? NO_SPARK;

  return (
    <Page
      title="Positions"
      subtitle={`Research paper positions (opt-in) · ${counted.length} closed · ${wins}/${counted.length || 0} wins · ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL realized`}
    >
      <HoldingsSection />
      <Section title={`Open (${open.length})`}>
        {open.length === 0 ? (
          <Empty title="No open paper positions" message="Paper entries are off by default — the scanner flags potential runners on the Launches page instead. Turn on “Paper entries (research)” in Strategy to simulate entries here." />
        ) : (
          <div className="space-y-3">
            {open.map((p) => <PositionCard key={p.id} p={p} spark={sparkFor(p.mint)} />)}
          </div>
        )}
      </Section>
      <Section title={`Closed (${closed.length})`}>
        {closed.length === 0 ? (
          <Empty title="Nothing closed yet" />
        ) : (
          <div className="space-y-3">
            {closed.map((p) => <PositionCard key={p.id} p={p} spark={sparkFor(p.mint)} />)}
          </div>
        )}
      </Section>
    </Page>
  );
}
