import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  builtinPresets,
  DISCOVER_COLUMNS,
  emptyFilters,
  passesFilters,
  reuseRows,
  type DiscoverColumn,
  type StatsWindow,
  type DiscoverFilters,
  type FilterPreset,
  type ProviderStatus,
  type TokenSummary,
} from '@shared/market';
import type { OddsBucket } from '@shared/odds';
import { isEvmAddress, isEvmChain, type ChainKind } from '@shared/evm';
import { useToast } from './ToastProvider';
import { useAppState } from './AppStateProvider';
import { newLiveRows, impliedSolUsd } from '@shared/liveRows';
import type { LaunchRow } from '@shared/types';
import { ODDS_BUCKET_ORDER, oddsBucketRank } from '../utils/odds';

// Terminal state, kept separate from AppStateProvider on purpose.
//
// AppStateProvider mirrors the ENGINE: it is push-driven off the IPC event
// stream and represents this session's launches and paper positions.
// This provider mirrors the MARKET: it is poll-driven, every field can be
// stale, and every request can fail because someone else's API is down.
// Mixing the two would make an engine bug and a rate limit look identical.

const REFRESH_MIN_MS = 2_000;

/** How often the launch feed is sampled into the New column, and how many
 *  of its newest rows are considered. One second is under the eye's patience
 *  for "did that just appear?" and far above the render budget. */
const LIVE_SAMPLE_MS = 1_000;
const LIVE_SAMPLE_MAX = 40;

/** A launch the tape still remembers from an hour ago is not new. Main uses
 *  the column's own 24 h window for the rails that launch rarely; pump is
 *  not one of them, and a row that old would only push a real one out. */
const LIVE_MAX_AGE_MS = 60 * 60_000;

export interface ColumnState {
  rows: TokenSummary[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const emptyColumn = (): ColumnState => ({ rows: [], loading: false, error: null, fetchedAt: null });

/** 'provider' keeps each column in the order its provider ranked it (age,
 *  curve progress, pool creation, volume). 'odds' re-orders every column by
 *  graduation-odds bucket, best first, not-judged rows last. */
export type DiscoverSort = 'provider' | 'odds';

interface TerminalState {
  columns: Record<DiscoverColumn, ColumnState>;
  filters: DiscoverFilters;
  setFilters: (next: DiscoverFilters) => void;
  presets: FilterPreset[];
  activePresetId: string | null;
  applyPreset: (id: string | null) => void;
  /** Rows after filters, per column. */
  visible: (column: DiscoverColumn) => TokenSummary[];
  /** "Hide flagged launches" — drops rows where a measured hide-severity rug
   *  rule fired (`rug.hide === true`). Rows not yet judged (`rug === null`)
   *  are NOT hidden: unknown is not flagged. Default on; persisted. */
  hideFlagged: boolean;
  setHideFlagged: (on: boolean) => void;
  /** Rows the toggle removed across every column, after the other filters. */
  hiddenFlaggedCount: number;
  /** Column ordering. Lives beside `hideFlagged`, outside DiscoverFilters,
   *  because it does not change WHICH rows show — only their order. */
  sortBy: DiscoverSort;
  setSortBy: (s: DiscoverSort) => void;
  /** "Odds bucket ≥ …": keep only rows judged at least this good. `null`
   *  = off. Rows with `odds === null` (not judged) are dropped while the
   *  filter is on — a threshold on an unknown cannot pass — and counted in
   *  `hiddenByOddsCount` so the bar can say so. */
  minOddsBucket: OddsBucket | null;
  setMinOddsBucket: (b: OddsBucket | null) => void;
  hiddenByOddsCount: number;
  providers: ProviderStatus[];
  refreshProviders: () => Promise<void>;
  /** Poll cadence, seconds. Mirrors settings.data.discoverRefreshSec. */
  refreshSec: number;
  setRefreshSec: (n: number) => void;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Discover reports itself mounted/unmounted. The column polls run ONLY
   *  while it is on screen: off-route they cost provider budget (and the
   *  GeckoTerminal queue the token page's chart waits in) for rows nobody
   *  can see. Ref-counted so StrictMode's double mount cannot strand it. */
  setDiscoverActive: (on: boolean) => void;
  refreshNow: (column?: DiscoverColumn) => void;
  /** The mint the token page is showing, or null, and the chain it is on. */
  openMint: string | null;
  openChain: ChainKind;
  openToken: (mint: string | null, chain?: ChainKind) => void;
  /** The app-wide chain — Solana, Robinhood Chain or BNB Smart Chain.
   *  Discover's columns, the top bar's wallet and Paper/Live, the quick buy
   *  and the wallet page all follow it. Persisted. Switching clears the
   *  columns and refetches — a Solana row must never sit under an EVM header. */
  chain: ChainKind;
  setChain: (c: ChainKind) => void;
  /** Locally pinned tokens — the watchlist, persisted in localStorage. A
   *  Solana pin is the bare mint; an EVM pin is `${chain}:${address}`,
   *  because an 0x address alone does not say which chain it is on. */
  watchlist: string[];
  toggleWatch: (mint: string, chain?: ChainKind) => void;
  isWatched: (mint: string, chain?: ChainKind) => boolean;
}

const Ctx = createContext<TerminalState | null>(null);

export function useTerminal(): TerminalState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTerminal must be used inside <TerminalProvider>');
  return ctx;
}

/** The watchlist key for a token: the bare mint on Solana, `chain:address`
 *  on an EVM chain. An 0x address with no chain given is Robinhood's — the
 *  only EVM chain that existed when bare 0x pins were written. */
export function pinKey(mint: string, chain?: ChainKind): string {
  const c: ChainKind = chain ?? (isEvmAddress(mint) ? 'robinhood' : 'solana');
  return isEvmChain(c) ? `${c}:${mint.toLowerCase()}` : mint;
}

export function parsePin(pin: string): { mint: string; chain: ChainKind } {
  const i = pin.indexOf(':');
  if (i > 0) {
    const c = pin.slice(0, i);
    if (isEvmChain(c)) return { mint: pin.slice(i + 1), chain: c };
  }
  return isEvmAddress(pin) ? { mint: pin.toLowerCase(), chain: 'robinhood' } : { mint: pin, chain: 'solana' };
}

/**
 * The tokens a chain's wallet currently holds, as watchlist keys, or null
 * when the balance could not be read. Used to unpin on a sell only once the
 * coin is actually gone — a null (a failed read) leaves the pin alone.
 */
async function heldMints(chain: ChainKind): Promise<Set<string> | null> {
  try {
    if (chain === 'solana') {
      const r = await window.krypt.wallet.holdings();
      if (!r.ok || !r.data) return null;
      return new Set(r.data.filter((h) => h.uiAmount > 0).map((h) => pinKey(h.mint)));
    }
    const r = await window.krypt.evm.holdings(chain);
    if (!r.ok || !r.data) return null;
    return new Set(r.data.filter((h) => h.amount > 0).map((h) => pinKey(h.token, h.chain)));
  } catch {
    return null;
  }
}

const WATCH_KEY = 'krypt.terminal.watchlist';
const FILTER_KEY = 'krypt.terminal.filters';
const HIDE_FLAGGED_KEY = 'krypt.terminal.hideFlagged';
const SORT_KEY = 'krypt.terminal.sortBy';
const MIN_ODDS_KEY = 'krypt.terminal.minOddsBucket';
const CHAIN_KEY = 'krypt.terminal.chain';

function loadChain(): ChainKind {
  try {
    const raw = localStorage.getItem(CHAIN_KEY);
    return raw === 'robinhood' || raw === 'bnb' ? raw : 'solana';
  } catch {
    return 'solana';
  }
}

function loadSortBy(): DiscoverSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'odds' ? 'odds' : 'provider';
  } catch {
    return 'provider';
  }
}

function loadMinOddsBucket(): OddsBucket | null {
  try {
    const raw = localStorage.getItem(MIN_ODDS_KEY);
    return raw && (ODDS_BUCKET_ORDER as readonly string[]).includes(raw) ? (raw as OddsBucket) : null;
  } catch {
    return null;
  }
}

function loadHideFlagged(): boolean {
  try {
    const raw = localStorage.getItem(HIDE_FLAGGED_KEY);
    // Default ON: the toggle is the shipped 10 %-budget hide from
    // docs/rug-filter-2026-08-30.md. Only an explicit "0" turns it off.
    return raw === null ? true : raw !== '0';
  } catch {
    return true;
  }
}

function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    // Pins saved before BNB existed stored a bare 0x address; that was Robinhood.
    return parsed.filter((v): v is string => typeof v === 'string').map((v) => (isEvmAddress(v) ? pinKey(v, 'robinhood') : v));
  } catch {
    return [];
  }
}

function loadFilters(): DiscoverFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return emptyFilters();
    // Merge over defaults: a filter set saved before a field existed must not
    // produce `undefined` where passesFilters expects a Range.
    return { ...emptyFilters(), ...(JSON.parse(raw) as Partial<DiscoverFilters>) };
  } catch {
    return emptyFilters();
  }
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [columns, setColumns] = useState<Record<DiscoverColumn, ColumnState>>({
    new: emptyColumn(),
    graduating: emptyColumn(),
    migrated: emptyColumn(),
    trending: emptyColumn(),
  });
  const [filters, setFiltersState] = useState<DiscoverFilters>(loadFilters);
  const [presets, setPresets] = useState<FilterPreset[]>(builtinPresets);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [refreshSec, setRefreshSec] = useState(8);
  const [paused, setPaused] = useState(false);
  const [discoverMounts, setDiscoverMounts] = useState(0);
  const setDiscoverActive = useCallback((on: boolean) => {
    setDiscoverMounts((n) => Math.max(0, n + (on ? 1 : -1)));
  }, []);
  const [openMint, setOpenMint] = useState<string | null>(null);
  const [openChain, setOpenChain] = useState<ChainKind>('solana');
  const [watchlist, setWatchlist] = useState<string[]>(loadWatchlist);
  const [hideFlagged, setHideFlaggedState] = useState<boolean>(loadHideFlagged);
  const [sortBy, setSortByState] = useState<DiscoverSort>(loadSortBy);
  const [minOddsBucket, setMinOddsBucketState] = useState<OddsBucket | null>(loadMinOddsBucket);
  const [tick, setTick] = useState(0);
  const [chain, setChainState] = useState<ChainKind>(loadChain);
  // Read through a ref by `load`, which must stay identity-stable.
  const chainRef = useRef<ChainKind>(chain);

  const setChain = useCallback((c: ChainKind) => {
    if (chainRef.current === c) return;
    chainRef.current = c;
    setChainState(c);
    try {
      localStorage.setItem(CHAIN_KEY, c);
    } catch {
      /* non-fatal */
    }
    // Nothing from the other chain may survive under the new header.
    setColumns({ new: emptyColumn(), graduating: emptyColumn(), migrated: emptyColumn(), trending: emptyColumn() });
    setTick((t) => t + 1);
  }, []);

  const setSortBy = useCallback((s: DiscoverSort) => {
    setSortByState(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* non-fatal */
    }
  }, []);

  const setMinOddsBucket = useCallback((b: OddsBucket | null) => {
    setMinOddsBucketState(b);
    try {
      if (b === null) localStorage.removeItem(MIN_ODDS_KEY);
      else localStorage.setItem(MIN_ODDS_KEY, b);
    } catch {
      /* non-fatal */
    }
  }, []);

  const setHideFlagged = useCallback((on: boolean) => {
    setHideFlaggedState(on);
    try {
      localStorage.setItem(HIDE_FLAGGED_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable — the toggle just won't persist */
    }
  }, []);

  const limitRef = useRef(40);
  // Read through a ref, never a dep: `load` must stay identity-stable or the
  // poll effect tears itself down and rebuilds on every filter keystroke.
  const winRef = useRef<StatsWindow>(filters.window);
  const inflight = useRef<Set<DiscoverColumn>>(new Set());

  const setFilters = useCallback((next: DiscoverFilters) => {
    setFiltersState(next);
    setActivePresetId(null);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable (private window) — filters just won't persist */
    }
  }, []);

  const applyPreset = useCallback(
    (id: string | null) => {
      if (id === null) {
        setFiltersState(emptyFilters());
        setActivePresetId(null);
        return;
      }
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      setFiltersState({ ...emptyFilters(), ...p.filters });
      setActivePresetId(id);
    },
    [presets],
  );

  // Settings feed the poll cadence and the row limit.
  useEffect(() => {
    void window.krypt.settings.get().then((r) => {
      if (!r.ok || !r.data) return;
      setRefreshSec(Math.max(2, r.data.data.discoverRefreshSec));
      limitRef.current = r.data.data.discoverLimit;
    });
    void window.krypt.market.presets().then((r) => {
      if (r.ok && r.data?.length) setPresets(r.data);
    });
  }, []);

  const refreshProviders = useCallback(async () => {
    const r = await window.krypt.market.providers();
    // Same status → same array. Every column load asks for this, and a new
    // identity for unchanged data re-rendered every consumer of the context.
    if (r.ok && r.data) {
      const next = r.data;
      setProviders((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const load = useCallback(async (column: DiscoverColumn) => {
    // One request per column at a time. A slow provider must not stack up
    // requests behind itself and then land them all at once.
    if (inflight.current.has(column)) return;
    inflight.current.add(column);
    // The spinner is for the FIRST fill. A background refresh of a column
    // that already has rows used to write `loading: true` first and the
    // result second — two context replacements, and two renders of every
    // consumer, per poll, to show a spinner nobody needs beside live rows.
    setColumns((c) => (c[column].rows.length > 0 ? c : { ...c, [column]: { ...c[column], loading: true } }));
    try {
      const askedChain = chainRef.current;
      const r = isEvmChain(askedChain)
        ? await window.krypt.evm.discover(askedChain, column, limitRef.current)
        : await window.krypt.market.discover(column, limitRef.current, winRef.current);
      // The chain flipped while this was in flight: the answer belongs to
      // the previous header and must not land under the new one.
      if (chainRef.current !== askedChain) return;
      setColumns((c) => {
        const prev = c[column];
        if (r.ok && r.data) {
          // An empty page while a provider is parked is the park, not the
          // market: keep what is on screen and say why (main puts the park
          // note in `message`), rather than blanking the column under a
          // fresh "2s ago" stamp — which read as "nothing is launching".
          if (r.data.length === 0 && prev.rows.length > 0 && r.message !== 'ok') {
            return { ...c, [column]: { ...prev, loading: false, error: `${r.message} Showing the last good rows.` } };
          }
          return {
            ...c,
            [column]: { rows: reuseRows(prev.rows, r.data), loading: false, error: r.message !== 'ok' ? r.message : null, fetchedAt: Date.now() },
          };
        }
        // Same error again: nothing on screen changes, so keep the object.
        if (!prev.loading && prev.error === r.message) return c;
        return { ...c, [column]: { ...prev, loading: false, error: r.message } };
      });
    } catch (err) {
      setColumns((c) => ({ ...c, [column]: { ...c[column], loading: false, error: (err as Error).message } }));
    } finally {
      inflight.current.delete(column);
    }
  }, []);

  // The stats window changes what "trending" MEANS — Jupiter ranks by traded
  // volume in that window and returns a materially different set for each —
  // so that one column refetches. The other three are ranked by age, curve
  // progress and pool creation, none of which have a window.
  useEffect(() => {
    winRef.current = filters.window;
    void load('trending');
  }, [filters.window, load]);

  const refreshNow = useCallback(
    (column?: DiscoverColumn) => {
      if (column) void load(column);
      else setTick((t) => t + 1);
    },
    [load],
  );

  // Poll loop — PER COLUMN, because the four move at very different speeds.
  //
  // One shared clock meant New refreshed as slowly as Migrated. New is the
  // sniping column: a token that launched four seconds ago is the whole point
  // of it, while a migration from ten minutes ago is not more interesting for
  // being re-fetched.
  //
  // This costs no more provider traffic than the single clock did. The
  // GeckoTerminal listings behind Graduating and New are memoised for 60s and
  // shared between them, so polling more often re-reads a cache; pump.fun's
  // own feeds carry 4-6s TTLs of their own. What actually changes is how
  // quickly a new row reaches the screen.
  //
  // Columns are still staggered so four providers are never hit in the same
  // millisecond — that pattern is what trips rate limits.
  useEffect(() => {
    if (paused) return;
    // Nothing draws the columns off-route; the effect re-runs (and loads at
    // once) when Discover mounts again.
    if (discoverMounts === 0) return;
    const cancelled = { current: false };
    const base = Math.max(REFRESH_MIN_MS, refreshSec * 1000);
    const CADENCE: Record<DiscoverColumn, number> = {
      new: 0.5,        // fastest — this is the one people watch
      graduating: 1,
      trending: 1,
      migrated: 2,     // a migration does not become newer by asking again
    };
    const order: DiscoverColumn[] = ['new', 'graduating', 'migrated', 'trending'];
    const timers = order.map((col, i) => {
      const every = Math.max(REFRESH_MIN_MS, base * CADENCE[col]);
      // Stagger the FIRST fire, then let each column keep its own rhythm.
      const startDelay = i * 350;
      let interval: ReturnType<typeof setInterval> | null = null;
      const startTimer = setTimeout(() => {
        if (cancelled.current || document.hidden) return;
        void load(col);
        interval = setInterval(() => {
          // A minimised or backgrounded window shows nobody these rows, and
          // Discover is the route the app OPENS on — so without this the
          // whole four-column poll (230 provider calls a minute, measured
          // 2026-09-09) ran all day behind a hidden window. The token page,
          // the watchlist and the position panel already gate this way.
          if (!cancelled.current && !document.hidden) void load(col);
        }, every);
      }, startDelay);
      return () => {
        clearTimeout(startTimer);
        if (interval) clearInterval(interval);
      };
    });
    // Coming back into view must not wait out a 16 s migrated tick: refresh
    // every column once, immediately, then let the timers carry on.
    const onVisible = () => {
      if (cancelled.current || document.hidden) return;
      for (const col of order) void load(col);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      for (const stop of timers) stop();
    };
  }, [load, refreshSec, paused, tick, discoverMounts]);

  // Provider telemetry refresh — cheap, main-side only, no network.
  useEffect(() => {
    const id = setInterval(() => void refreshProviders(), 5_000);
    return () => clearInterval(id);
  }, [refreshProviders]);

  // The token page subscribes the engine's tape to whatever mint is open, so
  // sub-second candles start recording. Unsubscribe on close so the tape's
  // small subscription budget is not spent on tokens nobody is watching.
  useEffect(() => {
    // The Solana engine's tape only; an EVM address has nothing to tape.
    if (!openMint || isEvmAddress(openMint)) return;
    void window.krypt.market.watch(openMint);
    return () => {
      void window.krypt.market.unwatch(openMint);
    };
  }, [openMint]);

  // ── The New column between polls ─────────────────────────────────────
  //
  // Main already merges the scanner's launches into this column, but only
  // when a poll asks for it - up to four seconds after the token exists, and
  // not at all while pump.fun is parked. The launch feed is in this process
  // too, so the row can be on screen the moment the create is decoded.
  //
  // SAMPLED on a one-second timer rather than driven by the feed. The engine
  // pushes a launch update up to four times a second PER token, and a grid
  // that re-renders on every one of those is not smoother than one that
  // waits for the poll; it is the same screen drawn forty times as often.
  // Sampling also stops a burst of launches from turning into a burst of
  // renders.
  //
  // Solana only, and only while Discover is on screen: the scanner watches
  // pump.fun, and an EVM chain's column has nothing to gain from it.
  const { launches } = useAppState();
  const launchesRef = useRef<LaunchRow[]>(launches);
  launchesRef.current = launches;
  const [liveSample, setLiveSample] = useState<LaunchRow[]>([]);

  useEffect(() => {
    if (discoverMounts === 0 || isEvmChain(chain)) {
      setLiveSample((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const sample = (): void => {
      if (document.hidden) return;
      const next = launchesRef.current.slice(0, LIVE_SAMPLE_MAX);
      // Same first mint and same length means nothing has been created since
      // the last sample. Returning `prev` keeps the memo below from running
      // and every card from re-rendering.
      setLiveSample((prev) =>
        prev.length === next.length && prev[0]?.mint === next[0]?.mint ? prev : next,
      );
    };
    sample();
    const id = setInterval(sample, LIVE_SAMPLE_MS);
    return () => clearInterval(id);
  }, [discoverMounts, chain]);

  const livened = useMemo(() => {
    if (liveSample.length === 0) return columns;
    const rows = columns.new.rows;
    const added = newLiveRows(
      rows.map((r) => r.mint),
      liveSample,
      impliedSolUsd(rows),
      LIVE_MAX_AGE_MS,
    );
    if (added.length === 0) return columns;
    // Provider rows keep their identity - only the array is new - so the
    // memoised cards that were already drawn skip the render.
    const merged = [...added, ...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return { ...columns, new: { ...columns.new, rows: merged } };
  }, [columns, liveSample]);

  // Filter ONCE per change, not once per render per column. `visible()` used
  // to run passesFilters over every row each time it was called, and Discover
  // calls it four times per render.
  //
  // The rug-rule hide runs AFTER the user's filters so "N hidden" counts only
  // rows the toggle itself removed. `rug === null` (not judged yet) passes:
  // unknown is not flagged.
  //
  // The odds threshold runs after that, and the odds sort last. Both key off
  // `odds.graduate.bucket`; a row with no judgement ranks last and cannot
  // pass a threshold. The sort is stable, so within a bucket the provider's
  // own order survives.
  const { visibleByColumn, hiddenFlaggedCount, hiddenByOddsCount } = useMemo(() => {
    const now = Date.now();
    const out = {} as Record<DiscoverColumn, TokenSummary[]>;
    let hidden = 0;
    let hiddenOdds = 0;
    const minRank = minOddsBucket === null ? null : oddsBucketRank(minOddsBucket);
    for (const col of DISCOVER_COLUMNS) {
      const passing = livened[col].rows.filter((r) => passesFilters(r, filters, now));
      let rows = passing;
      if (hideFlagged) {
        rows = rows.filter((r) => r.rug?.hide !== true);
        hidden += passing.length - rows.length;
      }
      if (minRank !== null) {
        const before = rows.length;
        rows = rows.filter((r) => {
          const b = r.odds?.graduate?.bucket ?? null;
          return b !== null && oddsBucketRank(b) <= minRank;
        });
        hiddenOdds += before - rows.length;
      }
      if (sortBy === 'odds') {
        rows = [...rows].sort(
          (a, b) => oddsBucketRank(a.odds?.graduate?.bucket) - oddsBucketRank(b.odds?.graduate?.bucket),
        );
      }
      out[col] = rows;
    }
    return { visibleByColumn: out, hiddenFlaggedCount: hidden, hiddenByOddsCount: hiddenOdds };
  }, [livened, filters, hideFlagged, minOddsBucket, sortBy]);

  const visible = useCallback((column: DiscoverColumn) => visibleByColumn[column], [visibleByColumn]);

  const toggleWatch = useCallback((mint: string, chain?: ChainKind) => {
    const key = pinKey(mint, chain);
    setWatchlist((cur) => {
      const next = cur.includes(key) ? cur.filter((m) => m !== key) : [key, ...cur];
      try {
        localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);

  const isWatched = useCallback((mint: string, chain?: ChainKind) => watchlist.includes(pinKey(mint, chain)), [watchlist]);

  // A coin you just put money into is the definition of one you want to keep
  // an eye on, and pinning it by hand is the step people skip. Driven by the
  // engine's own fill event rather than by the click, so a buy from the
  // Discover quick-buy, the Runners page, a hotkey or the paired chat all
  // land here the same way. Never removes anything.
  useEffect(() => {
    const off = window.krypt.engine.onEvent((ev) => {
      // A user script's watch / unwatch (Automation → Scripts). The list is
      // the renderer's, so main asks; this is the only writer besides clicks.
      if (ev.kind === 'pin') {
        const key = pinKey(ev.mint);
        setWatchlist((cur) => {
          const has = cur.includes(key);
          if (ev.on === has) return cur;
          const next = ev.on ? [key, ...cur] : cur.filter((m) => m !== key);
          try {
            localStorage.setItem(WATCH_KEY, JSON.stringify(next));
          } catch {
            /* non-fatal */
          }
          return next;
        });
        return;
      }
      // "Watch what you buy" — a buy pins the coin, a sell UNPINS it once the
      // coin is no longer held. A Solana fill is the bare mint; an EVM fill is
      // `chain:address` (fee-leg rows carry requested 0 and are not buys of
      // anything). Both halves are gated on the same watchOnBuy switch, so a
      // pin you added by hand is never removed by a sell.
      let key: string | null = null;
      let side: 'buy' | 'sell' | null = null;
      let fillChain: ChainKind = 'solana';
      if (ev.kind === 'fill') {
        if (ev.state === 'failed') return;
        key = ev.mint;
        side = ev.side;
      } else if (ev.kind === 'evmFill') {
        if (ev.state === 'failed' || ev.fill.requested === 0) return;
        key = pinKey(ev.fill.token, ev.fill.chain);
        side = ev.fill.side;
        fillChain = ev.fill.chain;
      }
      if (key === null || side === null) return;
      const pin = key;
      const writeWatch = (next: string[]): void => {
        try {
          localStorage.setItem(WATCH_KEY, JSON.stringify(next));
        } catch {
          /* non-fatal: the pin is a convenience, not a record */
        }
      };
      void window.krypt.settings.get().then((s) => {
        if (!s.ok || !s.data?.watchOnBuy) return;
        if (side === 'buy') {
          setWatchlist((cur) => {
            if (cur.includes(pin)) return cur;
            const next = [pin, ...cur];
            writeWatch(next);
            return next;
          });
          return;
        }
        // A sell. Only unpin once the wallet no longer holds the coin — a
        // partial sell (a take-profit that trims, say) keeps it watched. If
        // the balance cannot be read, the pin is left alone rather than
        // guessed away.
        void heldMints(fillChain).then((held) => {
          if (held === null || held.has(pin)) return;
          setWatchlist((cur) => {
            if (!cur.includes(pin)) return cur;
            const next = cur.filter((m) => m !== pin);
            writeWatch(next);
            return next;
          });
        });
      });
    });
    return off;
  }, []);

  const openToken = useCallback((mint: string | null, chain?: ChainKind) => {
    setOpenMint(mint);
    if (mint === null) return;
    // The row's own chain when it says; an 0x address without one is read on
    // the selected EVM chain, or Robinhood while Solana is selected.
    if (chain) setOpenChain(chain);
    else if (isEvmAddress(mint)) setOpenChain(isEvmChain(chainRef.current) ? chainRef.current : 'robinhood');
    else setOpenChain('solana');
  }, []);

  const value = useMemo<TerminalState>(
    () => ({
      // The livened set, so a column's own row count matches what it draws.
      columns: livened,
      filters,
      setFilters,
      presets,
      activePresetId,
      applyPreset,
      visible,
      hideFlagged,
      setHideFlagged,
      hiddenFlaggedCount,
      sortBy,
      setSortBy,
      minOddsBucket,
      setMinOddsBucket,
      hiddenByOddsCount,
      providers,
      refreshProviders,
      refreshSec,
      setRefreshSec,
      paused,
      setPaused,
      setDiscoverActive,
      refreshNow,
      openMint,
      openChain,
      openToken,
      chain,
      setChain,
      watchlist,
      toggleWatch,
      isWatched,
    }),
    [
      livened, filters, setFilters, presets, activePresetId, applyPreset, visible,
      hideFlagged, setHideFlagged, hiddenFlaggedCount,
      sortBy, setSortBy, minOddsBucket, setMinOddsBucket, hiddenByOddsCount,
      providers, refreshProviders, refreshSec, paused, setDiscoverActive, refreshNow, openMint,
      openChain, openToken, chain, setChain, watchlist, toggleWatch, isWatched,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
