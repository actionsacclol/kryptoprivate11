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
import { useToast } from './ToastProvider';
import { ODDS_BUCKET_ORDER, oddsBucketRank } from '../utils/odds';

// Terminal state, kept separate from AppStateProvider on purpose.
//
// AppStateProvider mirrors the ENGINE: it is push-driven off the IPC event
// stream and represents this session's launches and paper positions.
// This provider mirrors the MARKET: it is poll-driven, every field can be
// stale, and every request can fail because someone else's API is down.
// Mixing the two would make an engine bug and a rate limit look identical.

const REFRESH_MIN_MS = 2_000;

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
  /** The mint the token page is showing, or null. */
  openMint: string | null;
  openToken: (mint: string | null) => void;
  /** Locally pinned mints — the watchlist, persisted in localStorage. */
  watchlist: string[];
  toggleWatch: (mint: string) => void;
  isWatched: (mint: string) => boolean;
}

const Ctx = createContext<TerminalState | null>(null);

export function useTerminal(): TerminalState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTerminal must be used inside <TerminalProvider>');
  return ctx;
}

const WATCH_KEY = 'krypt.terminal.watchlist';
const FILTER_KEY = 'krypt.terminal.filters';
const HIDE_FLAGGED_KEY = 'krypt.terminal.hideFlagged';
const SORT_KEY = 'krypt.terminal.sortBy';
const MIN_ODDS_KEY = 'krypt.terminal.minOddsBucket';

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
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
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
  const [watchlist, setWatchlist] = useState<string[]>(loadWatchlist);
  const [hideFlagged, setHideFlaggedState] = useState<boolean>(loadHideFlagged);
  const [sortBy, setSortByState] = useState<DiscoverSort>(loadSortBy);
  const [minOddsBucket, setMinOddsBucketState] = useState<OddsBucket | null>(loadMinOddsBucket);
  const [tick, setTick] = useState(0);

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
    if (r.ok && r.data) setProviders(r.data);
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
      const r = await window.krypt.market.discover(column, limitRef.current, winRef.current);
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
        if (cancelled.current) return;
        void load(col);
        interval = setInterval(() => {
          if (!cancelled.current) void load(col);
        }, every);
      }, startDelay);
      return () => {
        clearTimeout(startTimer);
        if (interval) clearInterval(interval);
      };
    });
    return () => {
      cancelled.current = true;
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
    if (!openMint) return;
    void window.krypt.market.watch(openMint);
    return () => {
      void window.krypt.market.unwatch(openMint);
    };
  }, [openMint]);

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
      const passing = columns[col].rows.filter((r) => passesFilters(r, filters, now));
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
  }, [columns, filters, hideFlagged, minOddsBucket, sortBy]);

  const visible = useCallback((column: DiscoverColumn) => visibleByColumn[column], [visibleByColumn]);

  const toggleWatch = useCallback((mint: string) => {
    setWatchlist((cur) => {
      const next = cur.includes(mint) ? cur.filter((m) => m !== mint) : [mint, ...cur];
      try {
        localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }, []);

  const isWatched = useCallback((mint: string) => watchlist.includes(mint), [watchlist]);

  // A coin you just put money into is the definition of one you want to keep
  // an eye on, and pinning it by hand is the step people skip. Driven by the
  // engine's own fill event rather than by the click, so a buy from the
  // Discover quick-buy, the Runners page, a hotkey or the paired chat all
  // land here the same way. Never removes anything.
  useEffect(() => {
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'fill' || ev.side !== 'buy' || ev.state === 'failed') return;
      void window.krypt.settings.get().then((s) => {
        if (!s.ok || !s.data?.watchOnBuy) return;
        setWatchlist((cur) => {
          if (cur.includes(ev.mint)) return cur;
          const next = [ev.mint, ...cur];
          try {
            localStorage.setItem(WATCH_KEY, JSON.stringify(next));
          } catch {
            /* non-fatal: the pin is a convenience, not a record */
          }
          return next;
        });
      });
    });
    return off;
  }, []);

  const openToken = useCallback((mint: string | null) => setOpenMint(mint), []);

  const value = useMemo<TerminalState>(
    () => ({
      columns,
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
      openToken,
      watchlist,
      toggleWatch,
      isWatched,
    }),
    [
      columns, filters, setFilters, presets, activePresetId, applyPreset, visible,
      hideFlagged, setHideFlagged, hiddenFlaggedCount,
      sortBy, setSortBy, minOddsBucket, setMinOddsBucket, hiddenByOddsCount,
      providers, refreshProviders, refreshSec, paused, setDiscoverActive, refreshNow, openMint,
      openToken, watchlist, toggleWatch, isWatched,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
