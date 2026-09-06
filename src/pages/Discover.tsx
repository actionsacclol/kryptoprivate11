import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Maximize2, Pause, Play, RefreshCw, Sprout, TrendingUp, Trophy, X, Zap } from 'lucide-react';
import type { DiscoverColumn, Launchpad } from '@shared/market';
import type { AppSettings, LiveState, WalletInfo } from '@shared/types';
import { FilterBar } from '../components/terminal/FilterBar';
import { TokenCard } from '../components/terminal/TokenCard';
import { SortBar, sortRows, type SortState } from '../components/terminal/SortBar';
import { useTerminal } from '../state/TerminalProvider';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAgo } from '../utils/format';

// Discover — the Pulse-equivalent, and the screen this app now opens on.
//
// Four independent columns, each polling its own provider set, each failing
// on its own. That isolation is deliberate: pump.fun rate-limiting the
// GRADUATING feed must not blank out TRENDING, which comes from Jupiter.

const COLUMNS: Array<{
  id: DiscoverColumn;
  label: string;
  hint: string;
  icon: typeof Sprout;
  accent: string;
}> = [
  { id: 'new', label: 'New', hint: 'Just created, still on the curve', icon: Sprout, accent: 'text-emerald-400' },
  { id: 'graduating', label: 'Graduating', hint: 'Closest to completing the bonding curve', icon: TrendingUp, accent: 'text-arc-gold' },
  { id: 'migrated', label: 'Migrated', hint: 'Graduated onto a DEX', icon: Trophy, accent: 'text-krypt-purple' },
  { id: 'trending', label: 'Trending', hint: 'Most traded in the selected window', icon: Zap, accent: 'text-krypt-pink' },
];

export function Discover({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const term = useTerminal();
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [quickBuySol, setQuickBuySol] = useState(0.1);
  // Which column is expanded to fill the page, if any. Four narrow columns is
  // the right default for watching everything at once; it is the wrong shape
  // for actually reading one of them.
  const [expanded, setExpanded] = useState<DiscoverColumn | null>(null);
  // Per-column sort (6H / MC / LIQ / …), remembered per viewer. Applied AFTER
  // the shared filters, on the way to the screen — the provider's row
  // identity is untouched, so memoised cards still skip unchanged rows.
  const SORT_STORE = 'krypto:discover:sort';
  const [sort, setSort] = useState<Partial<Record<DiscoverColumn, SortState | null>>>(() => {
    try {
      const raw = localStorage.getItem(SORT_STORE);
      return raw ? (JSON.parse(raw) as Partial<Record<DiscoverColumn, SortState | null>>) : {};
    } catch {
      return {};
    }
  });
  const setColumnSort = useCallback((col: DiscoverColumn, next: SortState | null) => {
    setSort((prev) => {
      const out = { ...prev, [col]: next };
      try {
        localStorage.setItem(SORT_STORE, JSON.stringify(out));
      } catch {
        /* a private window forgets the sort — fine */
      }
      return out;
    });
  }, []);

  const reloadWallet = useCallback(async () => {
    const [s, w, l] = await Promise.all([
      window.krypt.settings.get(),
      window.krypt.wallet.info(),
      window.krypt.live.state(),
    ]);
    if (s.ok && s.data) {
      setSettings(s.data);
      setQuickBuySol(Math.min(0.1, s.data.execution.maxLiveSol));
    }
    if (w.ok && w.data) setWallet(w.data);
    if (l.ok && l.data) setLive(l.data);
  }, []);

  useEffect(() => {
    void reloadWallet();
  }, [reloadWallet]);

  // The column polls run only while this page is on screen (see the
  // provider): off-route they spent provider budget on rows nobody could see.
  const setDiscoverActive = term.setDiscoverActive;
  useEffect(() => {
    setDiscoverActive(true);
    return () => setDiscoverActive(false);
  }, [setDiscoverActive]);

  const canQuickBuy =
    !!settings?.execution.liveEnabled &&
    live?.armed === true &&
    !!wallet?.exists &&
    (wallet?.balanceSol ?? 0) > 0;

  const quickBuy = async (mint: string, symbol: string): Promise<void> => {
    if (!canQuickBuy) {
      toast.warn('Quick buy needs a funded wallet, live execution on, and the engine armed.');
      return;
    }
    // Quick buy from a discovery table is a REAL broadcast by definition —
    // there is no interstitial to confirm in. It is gated on the same arm +
    // liveEnabled the trade panel uses. It is a manual click, so the
    // per-trade cap (orders / copy / fan-out) does not clamp it; the amount
    // is exactly what the user set in the quick-buy field.
    const sol = quickBuySol;
    const r = await window.krypt.live.testTrade(mint, sol, false);
    if (r.ok) toast.success(`${symbol}: ${r.message}`);
    else toast.error(`${symbol}: ${r.message}`);
  };

  // What each launchpad would actually show, across everything loaded. A chip
  // reading 0 is usually a coverage fact — the New column is built from
  // pump.fun's own feed, so other rails simply are not in it — and saying so
  // beats letting someone click into an empty column and wonder.
  const launchpadCounts = useMemo(() => {
    const out: Partial<Record<Launchpad, number>> = {};
    for (const col of COLUMNS) {
      for (const row of term.columns[col.id].rows) {
        out[row.launchpad] = (out[row.launchpad] ?? 0) + 1;
      }
    }
    return out;
  }, [term.columns]);

  const providersOff = term.providers.length > 0 && term.providers.every((p) => !p.usable);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-5 pb-3 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-[0.06em] text-white">Discover</h1>
          <p className="mt-1 text-sm text-krypt-muted">
            Every Solana memecoin as it launches, graduates and trends — with the numbers that decide a trade.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-krypt-muted">Quick buy</span>
            <input
              type="number"
              min={0}
              step={0.05}
              value={quickBuySol}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setQuickBuySol(n);
              }}
              className="w-14 bg-transparent text-[12px] font-mono text-white outline-none text-right"
            />
            <span className="text-[10px] text-krypt-muted">SOL</span>
          </div>
          <button
            onClick={() => term.setPaused(!term.paused)}
            title={term.paused ? 'Resume polling' : 'Pause polling'}
            className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white hover:border-white/20 transition"
          >
            {term.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
          <button
            onClick={() => term.refreshNow()}
            title="Refresh all columns"
            className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white hover:border-white/20 transition"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-6 pb-3">
        <FilterBar
          filters={term.filters}
          onChange={term.setFilters}
          presets={term.presets}
          activePresetId={term.activePresetId}
          onApplyPreset={term.applyPreset}
          counts={launchpadCounts}
          hideFlagged={term.hideFlagged}
          onHideFlagged={term.setHideFlagged}
          hiddenFlagged={term.hiddenFlaggedCount}
          sortBy={term.sortBy}
          onSortBy={term.setSortBy}
          minOddsBucket={term.minOddsBucket}
          onMinOddsBucket={term.setMinOddsBucket}
          hiddenByOdds={term.hiddenByOddsCount}
        />
      </div>

      {providersOff && (
        <div className="mx-6 mb-3 rounded-lg border border-arc-gold/30 bg-arc-gold/10 px-4 py-2.5">
          <p className="text-[12px] text-arc-gold/90">
            All market-data providers are off, so there is nothing to discover. Turn them on in{' '}
            <span className="font-semibold">Settings → Market data</span>.
          </p>
        </div>
      )}

      <div className="flex-1 min-h-0 px-6 pb-6">
        <div
          className={cls(
            'gap-3 h-full',
            expanded ? 'flex flex-col' : 'grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-4',
          )}
        >
          {COLUMNS.filter((c) => !expanded || c.id === expanded).map((col) => {
            const state = term.columns[col.id];
            const rows = sortRows(term.visible(col.id), sort[col.id], term.filters.window);
            const Icon = col.icon;
            return (
              <div key={col.id} className="flex flex-col min-h-0 rounded-lg border border-white/8 bg-krypt-panel/40">
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/8">
                  <Icon className={cls('h-4 w-4', col.accent)} />
                  <button
                    onClick={() => setExpanded(expanded === col.id ? null : col.id)}
                    title={expanded === col.id ? 'Back to all four columns' : `Expand ${col.label} to fill the page`}
                    className="group flex items-center gap-1.5 font-display text-[12px] font-semibold tracking-[0.14em] uppercase text-white hover:text-krypt-pink transition"
                  >
                    {col.label}
                    {expanded === col.id ? (
                      <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                    ) : (
                      <Maximize2 className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                    )}
                  </button>
                  {/* Only Trending is window-scoped; showing the window on it
                      is what tells you the buttons above did something. */}
                  {col.id === 'trending' && (
                    <span
                      className="rounded border border-white/10 px-1 py-px text-[9px] font-mono text-krypt-muted"
                      title="Ranked by traded volume in this window"
                    >
                      {term.filters.window}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-krypt-muted">
                    {rows.length}
                    {rows.length !== state.rows.length && (
                      <span className="text-krypt-muted/50">/{state.rows.length}</span>
                    )}
                  </span>
                  <div className="flex-1" />
                  {state.loading && <Loader2 className="h-3 w-3 animate-spin text-krypt-purple" />}
                  {state.fetchedAt && !state.loading && (
                    <span className="text-[9px] text-krypt-muted/45" title={col.hint}>
                      {fmtAgo(state.fetchedAt)} ago
                    </span>
                  )}
                </div>
                <SortBar state={sort[col.id]} win={term.filters.window} onChange={(next) => setColumnSort(col.id, next)} />

                <div
                  className={cls(
                    'card-list flex-1 min-h-0 overflow-y-auto p-2',
                    // Expanded: one token per line, DexScreener-style rows.
                    expanded === col.id ? 'flex flex-col gap-1.5' : 'space-y-2',
                  )}
                >
                  {state.error ? (
                    <div className={cls('rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-3', expanded === col.id && 'col-span-full')}>
                      <p className="text-[11px] text-rose-200 leading-relaxed">{state.error}</p>
                      <button
                        onClick={() => term.refreshNow(col.id)}
                        className="mt-2 text-[10px] text-rose-200/80 hover:text-white underline underline-offset-2"
                      >
                        Retry
                      </button>
                    </div>
                  ) : rows.length === 0 ? (
                    <div className={cls('rounded-md border border-dashed border-white/10 px-3 py-8 text-center', expanded === col.id && 'col-span-full')}>
                      <p className="text-[11px] text-krypt-muted">
                        {state.loading
                          ? 'Loading…'
                          : state.rows.length > 0
                            ? 'Every row filtered out. Loosen the filters above.'
                            : col.hint}
                      </p>
                    </div>
                  ) : (
                    rows.map((t) => (
                      <TokenCard
                        key={t.mint}
                        token={t}
                        window={term.filters.window}
                        onOpen={() => onOpenToken(t.mint)}
                        onQuickBuy={() => void quickBuy(t.mint, t.symbol || t.mint.slice(0, 6))}
                        quickBuySol={quickBuySol}
                        watched={term.isWatched(t.mint)}
                        onToggleWatch={() => term.toggleWatch(t.mint)}
                        canQuickBuy={canQuickBuy}
                        layout={expanded === col.id ? 'row' : 'card'}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
