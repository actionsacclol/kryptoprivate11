import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, Pause, Play, RefreshCw, Sprout, TrendingUp, Trophy, X, Zap } from 'lucide-react';
import type { DiscoverColumn, Launchpad } from '@shared/market';
import type { AppSettings, LiveState, WalletInfo } from '@shared/types';
import { isEvmChain, nativeSymbolOf, type ChainKind, type EvmChainKind } from '@shared/evm';
import { FilterBar } from '../components/terminal/FilterBar';
import { TokenCard } from '../components/terminal/TokenCard';
import { SortBar, sortRows, type SortState } from '../components/terminal/SortBar';
import { useTerminal } from '../state/TerminalProvider';
import { useEvmState } from '../state/useEvmState';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAgo } from '../utils/format';
import { isPendingResult, PENDING_TOAST } from '../utils/evm';

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

/** The same four columns mean slightly different things on an EVM chain:
 *  the curve is the launchpad's (Pons / four.meme), the line is its
 *  graduation threshold, and trending is GeckoTerminal's ranking for the
 *  network rather than a windowed volume sort. */
const EVM_HINTS: Record<EvmChainKind, Record<DiscoverColumn, string>> = {
  robinhood: {
    new: 'Just launched on Pons, still on the bonding curve',
    graduating: 'Closest to 4.2 ETH — the Pons graduation line',
    migrated: 'Swept into a locked Uniswap v4 pool',
    trending: 'Trending pools on Robinhood Chain right now',
  },
  bnb: {
    // ~85 % of four.meme launches are quoted in USDT, USD1 or a tokenised
    // stock; this version settles BNB only, so those are not listed at all.
    new: 'Just launched on four.meme, still on the bonding curve — BNB-quoted launches only',
    graduating: 'Closest to 18 BNB — the four.meme graduation line. BNB-quoted launches only; USDT- and stock-quoted ones are not tradeable here',
    migrated: 'Graduated into a PancakeSwap v2 pair',
    trending: 'Trending pools on BNB Smart Chain right now',
  },
};

const SUBTITLE: Record<ChainKind, string> = {
  solana: 'Every Solana memecoin as it launches, graduates and trends — with the numbers that decide a trade.',
  robinhood: 'Every Pons launch on Robinhood Chain as it launches, graduates and trends — priced in ETH.',
  bnb: 'Every four.meme launch on BNB Smart Chain as it launches, graduates and trends — priced in BNB.',
};

/** The quick-buy seed per EVM chain: a small real bet in that chain's coin. */
const DEFAULT_QUICK_BUY: Record<EvmChainKind, number> = { robinhood: 0.01, bnb: 0.02 };

export function Discover({
  onOpenToken,
  active = true,
}: {
  onOpenToken: (mint: string, chain?: ChainKind) => void;
  /** False while another route is on screen. App keeps this page mounted
   *  (its ~10,000 row elements are what made a return visit slow); while
   *  inactive it polls nothing, and it re-reads wallet, live state and
   *  settings when it comes back. */
  active?: boolean;
}) {
  const term = useTerminal();
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  // The quick-buy size: SOL on Solana, ETH on Robinhood, BNB on BNB. One
  // field, re-seeded when the chain switches — 0.1 SOL, 0.1 ETH and 0.1 BNB
  // are not the same bet.
  const [quickBuySol, setQuickBuySol] = useState(0.1);
  const chain = term.chain;
  const evmChain: EvmChainKind | null = isEvmChain(chain) ? chain : null;
  const isEvm = evmChain !== null;
  const unit = nativeSymbolOf(chain);
  // The selected EVM chain's wallet + arm state, kept live by its own pushes.
  const { evm } = useEvmState(evmChain);
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
      if (!isEvm) setQuickBuySol(Math.min(0.1, s.data.execution.maxLiveSol));
    }
    if (w.ok && w.data) setWallet(w.data);
    if (l.ok && l.data) setLive(l.data);
  }, [isEvm]);

  useEffect(() => {
    if (active) void reloadWallet();
  }, [active, reloadWallet]);

  useEffect(() => {
    setQuickBuySol(evmChain ? DEFAULT_QUICK_BUY[evmChain] : Math.min(0.1, settings?.execution.maxLiveSol ?? 0.1));
    // Re-seed on the chain switch only; the settings read above handles the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmChain]);

  // The column polls run only while this page is on screen (see the
  // provider): off-route they spent provider budget on rows nobody could see.
  const setDiscoverActive = term.setDiscoverActive;
  useEffect(() => {
    if (!active) return;
    setDiscoverActive(true);
    return () => setDiscoverActive(false);
  }, [active, setDiscoverActive]);

  // EVM: the button works whenever a wallet exists — disarmed it simulates
  // the real bytes (the result says so), armed it spends ETH / BNB.
  const evmLoading = evmChain !== null && evm === null;
  const evmArmed = evm?.live.armed === true;
  const canQuickBuy = evmChain
    ? !evmLoading && evm?.wallet.exists === true && (!evmArmed || (evm?.wallet.balanceNative ?? 0) > 0)
    : !!settings?.execution.liveEnabled &&
      live?.armed === true &&
      !!wallet?.exists &&
      (wallet?.balanceSol ?? 0) > 0;
  const quickBuyHint = evmChain
    ? evmLoading
      ? 'Reading the EVM wallet…'
      : evm?.wallet.exists !== true
        ? 'Quick buy needs an EVM wallet — create one on the Wallet page'
        : `Live with an empty ${nativeSymbolOf(evmChain)} balance — send some in, or switch to Paper`
    : undefined;

  // The cards are memoised and this closure is not part of the comparison, so
  // a card rendered before you armed would keep the OLD arm bit and simulate
  // a trade you meant to be live. Read the volatile parts through refs.
  const quickRef = useRef({ evmChain, evmArmed, quickBuySol, canQuickBuy });
  quickRef.current = { evmChain, evmArmed, quickBuySol, canQuickBuy };

  const quickBuy = async (mint: string, symbol: string): Promise<void> => {
    const { evmChain: qChain, evmArmed: qArmed, quickBuySol: qSol, canQuickBuy: qCan } = quickRef.current;
    if (qChain) {
      if (!qCan) {
        toast.warn('Quick buy needs an EVM wallet — create one on the Wallet page.');
        return;
      }
      const r = await window.krypt.evm.buy(qChain, mint, qSol, !qArmed);
      if (r.ok) (qArmed ? toast.success : toast.info)(`${symbol}: ${qArmed ? r.message : `Paper — ${r.message}`}`);
      else if (isPendingResult(r)) toast.warn(`${symbol}: ${PENDING_TOAST}`);
      else toast.error(`${symbol}: ${r.message}`);
      return;
    }
    if (!qCan) {
      toast.warn('Quick buy needs a funded wallet, live execution on, and the engine armed.');
      return;
    }
    // Quick buy from a discovery table is a REAL broadcast by definition —
    // (Solana path; the EVM path returned above.)
    // there is no interstitial to confirm in. It is gated on the same arm +
    // liveEnabled the trade panel uses. It is a manual click, so the
    // per-trade cap (orders / copy / fan-out) does not clamp it; the amount
    // is exactly what the user set in the quick-buy field.
    const r = await window.krypt.live.testTrade(mint, quickRef.current.quickBuySol, false);
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
          <h1 className="font-display text-2xl font-semibold tracking-display text-white">Discover</h1>
          <p className="mt-1 text-sm text-krypt-muted">{SUBTITLE[chain]}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* The chain switch lives in the top bar: it is app-wide, not a
              Discover setting. */}
          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
            <span className="text-label uppercase tracking-label text-krypt-muted">Quick buy</span>
            <input
              type="number"
              min={0}
              step={isEvm ? 0.005 : 0.05}
              value={quickBuySol}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0) setQuickBuySol(n);
              }}
              className="w-14 bg-transparent text-note font-mono text-white outline-none text-right"
            />
            <span className="text-label text-krypt-muted">{unit}</span>
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
          <p className="text-note text-arc-gold/90">
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
          {COLUMNS.filter((c) => !expanded || c.id === expanded).map((raw) => {
            const col = evmChain ? { ...raw, hint: EVM_HINTS[evmChain][raw.id] } : raw;
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
                    className="group flex items-center gap-1.5 font-display text-note font-semibold tracking-label uppercase text-white hover:text-krypt-pink transition"
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
                  {col.id === 'trending' && !isEvm && (
                    <span
                      className="rounded border border-white/10 px-1 py-px text-micro font-mono text-krypt-muted"
                      title="Ranked by traded volume in this window"
                    >
                      {term.filters.window}
                    </span>
                  )}
                  <span className="text-label font-mono text-krypt-muted">
                    {rows.length}
                    {rows.length !== state.rows.length && (
                      <span className="text-krypt-muted/50">/{state.rows.length}</span>
                    )}
                  </span>
                  <div className="flex-1" />
                  {state.loading && <Loader2 className="h-3 w-3 animate-spin text-krypt-purple" />}
                  {state.fetchedAt && !state.loading && (
                    <span className="text-micro text-krypt-muted/45" title={state.error ? `Not refreshing right now: ${state.error}` : col.hint}>
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
                  {/* No banner when rows survived a parked provider
                      (removed 2026-09-23, user: "makes the app feel like
                      shit"). A rate-limit park clears itself within seconds,
                      the rows stay, and the column's "Xs ago" stamp already
                      shows the age; the reason is in that stamp's tooltip.
                      The red box below still shows when a column is EMPTY. */}
                  {state.error && rows.length === 0 ? (
                    <div className={cls('rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-3', expanded === col.id && 'col-span-full')}>
                      <p className="text-body text-rose-200 leading-relaxed">{state.error}</p>
                      <button
                        onClick={() => term.refreshNow(col.id)}
                        className="mt-2 text-label text-rose-200/80 hover:text-white underline underline-offset-2"
                      >
                        Retry
                      </button>
                    </div>
                  ) : rows.length === 0 ? (
                    <div className={cls('rounded-md border border-dashed border-white/10 px-3 py-8 text-center', expanded === col.id && 'col-span-full')}>
                      <p className="text-body text-krypt-muted">
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
                        onOpen={() => onOpenToken(t.mint, t.chain ?? chain)}
                        onQuickBuy={() => void quickBuy(t.mint, t.symbol || t.mint.slice(0, 6))}
                        quickBuySol={quickBuySol}
                        watched={term.isWatched(t.mint, t.chain ?? chain)}
                        onToggleWatch={() => term.toggleWatch(t.mint, t.chain ?? chain)}
                        canQuickBuy={canQuickBuy}
                        quickBuyHint={quickBuyHint}
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
