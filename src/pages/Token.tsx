import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, ExternalLink, Loader2, RefreshCw, Star } from 'lucide-react';
import { useAccent } from '../state/useAccent';
import {
  CANDLE_INTERVALS,
  imageSrc,
  type CandleInterval,
  type CandleSeries,
  type HolderGraph,
  type TokenSummary,
  type HolderReport,
  type TokenDetail,
  type TradeRow,
  type TraderScanRow,
} from '@shared/market';
import type { AppSettings, LiveState, WalletInfo } from '@shared/types';
import { triggerPriceSol, type AdvOrder } from '@shared/orders';
import type { Alert } from '@shared/alerts';
import type { CreatorHistory, LaunchIntelReport } from '@shared/launchintel';
import { KryptChart, type KryptChartHandle } from '../components/terminal/KryptChart';
import { SecurityPanel } from '../components/terminal/SecurityPanel';
import { XLinkPanel } from '../components/terminal/XLinkPanel';
import { OddsPanel } from '../components/terminal/OddsPanel';
import { LaunchPanel } from '../components/terminal/LaunchPanel';
import { HoldersPanel } from '../components/terminal/HoldersPanel';
import { HolderMap } from '../components/terminal/HolderMap';
import { LiveTrades, TraderScan } from '../components/terminal/TradesPanel';
import { TradePanel } from '../components/terminal/TradePanel';
import { OrdersPanel } from '../components/terminal/OrdersPanel';
import { PositionPanel } from '../components/terminal/PositionPanel';
import { AlertsPanel } from '../components/terminal/AlertsPanel';
import { AiPanel } from '../components/terminal/AiPanel';
import { useTerminal } from '../state/TerminalProvider';
import { lastRows } from '../state/routeCache';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAge, fmtAgo, fmtChange, fmtNum, fmtPriceUsd, fmtUsd, scoreTone, shortAddr, toneFor } from '../utils/format';
import { Stat } from '../components/common';

// The token page — chart, security, holders, trades and the trade panel on
// one screen (term.txt sections 5–8).
//
// Everything on it refreshes on its own cadence: the chart follows the
// interval, live trades follow the tape, and the security report is only
// re-read on demand because it costs two RPC round trips.

type Tab = 'security' | 'launch' | 'holders' | 'trades' | 'traders' | 'ai';

/** Seconds per candle bucket — used to bucket live ticks client-side so the
 *  chart's last bar can be built between polls. */
const BUCKET_SEC: Record<CandleInterval, number> = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
};

/** How stale a summary has to be before the page says so. Three poll cycles:
 *  long enough that a slow answer is not announced as a fault, short enough
 *  that a parked provider is named while the user is still looking at it. */
const HELD_OVER_NOTE_MS = 45_000;

/** How often the SOL/USD rate is re-read. Main memoises it for 20 s and
 *  Discover keeps it warm, so this is a read of a number already in memory;
 *  a minute is far inside what SOL moves in a session. */
const SOL_RATE_POLL_MS = 60_000;

export function TokenPage({ mint, onBack }: { mint: string; onBack: () => void }) {
  const term = useTerminal();
  const toast = useToast();

  const [detail, setDetail] = useState<TokenDetail | null>(null);
  /** Header data, fetched separately so the page paints before the slow
   *  parts finish. See loadDetail. Seeded from the row the user clicked —
   *  Discover's columns or the last rows any panel painted — so the page
   *  has a header on its first frame instead of a spinner for the 0.3–1 s
   *  the provider assembly takes (measured 2026-09-08). Keyed on the mint
   *  only: the columns' identity changes on every poll. */
  const seeded = useMemo(() => {
    for (const c of Object.values(term.columns)) {
      const hit = c.rows.find((r) => r.mint === mint);
      if (hit) return hit;
    }
    return lastRows.get(mint) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint]);
  const [quick, setQuick] = useState<TokenSummary | null>(seeded);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [interval, setInterval] = useState<CandleInterval>('1m');
  const [chartMode, setChartMode] = useState<'price' | 'mcap'>('mcap');
  const [series, setSeries] = useState<CandleSeries | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  /** Why the last full chart load failed — a parked provider, usually — so
   *  the empty chart says "rate limited, retrying in 12 s" and not "no data". */
  const [chartError, setChartError] = useState<string | null>(null);
  // Live-update plumbing. The chart handle applies ticks and tail candles
  // imperatively — no setState, no React re-render, no full repaint.
  const chartApiRef = useRef<KryptChartHandle>(null);
  const seriesRef = useRef<CandleSeries | null>(null);
  const solUsdRef = useRef<number | null>(null);
  /** Bucket time (epoch s) of the newest candle the DATA LAYER has given us
   *  — the `sinceTime` for the next tail poll. Tick-built buckets don't
   *  advance it; the tail re-serves and reconciles those. */
  const lastCandleTimeRef = useRef(0);
  /** Header price/MC as the tick stream moves it — the summary is what the
   *  providers said at load; this is what the chart is drawing NOW. */
  const [liveHeader, setLiveHeader] = useState<{ priceUsd: number; marketCapUsd: number | null } | null>(null);
  const liveHeaderPendingRef = useRef<{ priceUsd: number; marketCapUsd: number | null } | null>(null);
  const liveHeaderTimerRef = useRef<number | null>(null);
  const supplyRef = useRef<number | null>(null);

  const [tab, setTab] = useState<Tab>('security');
  const [holders, setHolders] = useState<HolderReport | null>(null);
  const [graph, setGraph] = useState<HolderGraph | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [holderView, setHolderView] = useState<'list' | 'map'>('list');
  const [trades, setTrades] = useState<{ rows: TradeRow[]; source: string; note: string | null } | null>(null);
  const [scan, setScan] = useState<{ rows: TraderScanRow[]; note: string | null } | null>(null);
  const [launch, setLaunch] = useState<LaunchIntelReport | null>(null);
  const [creator, setCreator] = useState<CreatorHistory | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);

  const [orders, setOrders] = useState<AdvOrder[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [ordersExecutable, setOrdersExecutable] = useState(true);
  const [ordersBlocked, setOrdersBlocked] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(() => (seeded?.priceUsd && seeded.priceSol ? seeded.priceUsd / seeded.priceSol : null));
  // Bumped after every trade so the position panel re-reads the chain.
  const [posKey, setPosKey] = useState(0);

  // ── The SOL/USD rate, from main rather than from this token ──────────
  //
  // Everything live on this page runs through this number. The chart is
  // drawn in USD, and a tick priced in SOL with no rate to convert it is
  // DROPPED rather than mixed - so with no rate the chart simply stops
  // moving, while the tape underneath is running perfectly. The header
  // market cap goes with it.
  //
  // It used to be derived: this token's USD price divided by its SOL price.
  // That fails for precisely the tokens worth watching - one minted a
  // minute ago that no provider has priced yet - and for every token at
  // once whenever the provider serving those prices is throttled. Main has
  // held the real rate all along, memoised for 20 s by the route Discover
  // already calls, so this asks for it and keeps the derivation as a
  // fallback for when even that is unavailable.
  // True once main has answered: after that the derived rate below is
  // ignored, because a token's own USD price can be stale or simply wrong
  // and the real rate never is.
  const rateFromMainRef = useRef(false);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void window.krypt.market.solUsd().then((r) => {
        if (!alive || !r.ok || typeof r.data !== 'number' || r.data <= 0) return;
        rateFromMainRef.current = true;
        setSolUsd(r.data);
      });
    };
    read();
    const id = window.setInterval(() => {
      if (!document.hidden) read();
    }, SOL_RATE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Tell the engine to tape this mint for as long as the page is open.
  //
  // Depends on the STABLE callback, never on `term` itself. The terminal
  // context value is memoised over `columns`, which the Discover poll
  // replaces every few seconds — so `[mint, term]` re-ran this effect on
  // every poll, tearing the subscription down and rebuilding it. That would
  // wipe the tape (`unsubscribe` deletes the mint's ticks, so the 1s chart
  // could never accumulate) and re-resolve the Meteora DBC pool, costing
  // several RPC calls and a fresh websocket, every few seconds. It only
  // happened to be harmless because React batched the null→mint state writes
  // into no net change; that is luck, not a design.
  const openToken = term.openToken;
  useEffect(() => {
    openToken(mint);
    return () => openToken(null);
  }, [mint, openToken]);

  /**
   * Load in TWO stages, because the slow half should not hold the page shut.
   *
   * The full `market:token` payload includes the security report, which is
   * two on-chain reads — and on a rate-limited public RPC each can burn its
   * full 8s timeout, measured at 18s end-to-end for BONK. Blocking on that
   * meant a bare spinner for eighteen seconds with no indication of what was
   * happening or that a Helius key would fix it.
   *
   * So the header renders off `market:summary` as soon as it lands, and the
   * security panel and pools fill in behind it.
   */
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);

    const quickPromise = window.krypt.market.summary(mint).then((r) => {
      if (r.ok && r.data) {
        setQuick(r.data);
        if (!rateFromMainRef.current && r.data.priceUsd && r.data.priceSol) {
          setSolUsd(r.data.priceUsd / r.data.priceSol);
        }
      }
      return r;
    });

    const full = await window.krypt.market.token(mint);
    if (full.ok && full.data) {
      setDetail(full.data);
      if (!rateFromMainRef.current && full.data.summary.priceUsd && full.data.summary.priceSol) {
        setSolUsd(full.data.summary.priceUsd / full.data.summary.priceSol);
      }
    } else {
      // Only a hard error when even the cheap summary failed; otherwise the
      // page is usable and the detail panels say what is missing.
      const q = await quickPromise;
      if (!q.ok) setError(full.message);
    }
    setLoading(false);
  }, [mint]);

  /** The mode the trade panel was last built for, so a status push only
   *  costs a re-read when Paper/Live actually flipped. */
  const liveActiveRef = useRef<boolean | null>(null);

  const loadWalletState = useCallback(async () => {
    // The three synchronous main-side reads first, so the trade panel exists
    // one IPC round trip after open; the chain balance read follows as a
    // patch. It used to gate all three (177–262 ms, up to 8 s under a park).
    const [s, w, l] = await Promise.all([window.krypt.settings.get(), window.krypt.wallet.info(), window.krypt.live.state()]);
    if (s.ok && s.data) setSettings(s.data);
    if (w.ok && w.data) setWallet(w.data);
    if (l.ok && l.data) setLive(l.data);
    // One chain read on open (same shape as info()). Without it a token
    // opened before the Wallet page showed an unknown balance, which the
    // panel read as "no SOL". onTraded relies on this refresh too.
    void window.krypt.wallet.refreshBalance().then((r) => {
      if (r.ok && r.data) setWallet(r.data);
    });
  }, []);

  const loadAlerts = useCallback(async () => {
    const r = await window.krypt.alerts.list();
    if (r.ok && r.data) setAlerts(r.data.alerts.filter((a) => a.mint === mint));
  }, [mint]);

  const loadOrders = useCallback(async () => {
    const r = await window.krypt.orders.list();
    if (r.ok && r.data) {
      setOrders(r.data.orders.filter((o) => o.mint === mint));
      setOrdersExecutable(r.data.executable);
      setOrdersBlocked(r.data.blockedReason);
    }
  }, [mint]);

  useEffect(() => {
    void loadDetail();
    void loadWalletState();
    void loadOrders();
    void loadAlerts();
    // Orders change from the engine too (a stop firing), so mirror the push
    // stream rather than relying on the poll to notice.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'alerts') {
        setAlerts(ev.alerts.filter((a) => a.mint === mint));
      }
      if (ev.kind === 'orders') {
        setOrders(ev.snapshot.orders.filter((o) => o.mint === mint));
        setOrdersExecutable(ev.snapshot.executable);
        setOrdersBlocked(ev.snapshot.blockedReason);
      }
      // Paper/Live is switched in the top bar, from another component. Without
      // this the trade panel kept the mode the page opened with — labelled
      // Paper while a click would have spent real SOL, or the reverse — until
      // the page was remounted. Only an actual change re-reads.
      if (ev.kind === 'status') {
        const nowLive = ev.status.liveActive;
        if (nowLive !== liveActiveRef.current) {
          liveActiveRef.current = nowLive;
          void loadWalletState();
        }
      }
    });
    return off;
  }, [loadDetail, loadWalletState, loadOrders, loadAlerts, mint]);

  // Mirror the pieces the async chart loops need without re-subscribing.
  useEffect(() => {
    seriesRef.current = series;
  }, [series]);
  useEffect(() => {
    solUsdRef.current = solUsd;
  }, [solUsd]);

  // Chart, stage 1: ONE full history load per mint+interval. This is the
  // only path that goes through setState → setData; everything after it is
  // incremental via the chart handle.
  useEffect(() => {
    let cancelled = false;
    lastCandleTimeRef.current = 0;
    setChartLoading(true);
    // Open-to-paint is measured (KryptChart closes the measure on its first
    // setData); before this nothing in the chart path was timed at all.
    try {
      performance.clearMarks('krypt:candles:fetch');
      performance.mark('krypt:candles:fetch');
    } catch {
      /* perf API unavailable — measurement is optional */
    }
    void window.krypt.market.candles(mint, interval, 500).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) {
        setSeries(r.data);
        setChartError(null);
        const cs = r.data.candles;
        lastCandleTimeRef.current = cs.length ? cs[cs.length - 1].time : 0;
      } else if (!r.ok) {
        setChartError(r.message);
      }
      // A cache/tape answer arrives first; the provider-merged series follows
      // as a `candles` event (below), so the spinner stays while it loads.
      const upgrading = r.ok && r.data?.pending === true;
      if (!upgrading) setChartLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mint, interval]);

  // Chart, stage 1b: the background upgrade. `market.candles` answers from
  // cache or the local tape the moment it can, so the chart paints at once;
  // the provider-merged history lands here when its (slow, rate-limited)
  // fetch completes. Only the series for what is on screen is applied — a
  // late event for a previous interval is dropped.
  useEffect(() => {
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'candles') return;
      if (ev.series.mint !== mint || ev.series.interval !== interval) return;
      setSeries(ev.series);
      const cs = ev.series.candles;
      if (cs.length) lastCandleTimeRef.current = cs[cs.length - 1].time;
      setChartLoading(false);
    });
    return off;
  }, [mint, interval]);

  // Chart, stage 2: the tail poll. Asks the data layer only for what is new
  // since the last known bucket and appends it in place — one `update` per
  // bar instead of the old full setData every 2 s. Sub-minute charts read
  // the local tape (cheap, 1 s); minute-and-up hit rate-limited providers
  // (5 s). Fully paused while the window is hidden.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const isSub = interval === '1s' || interval === '5s' || interval === '15s';
    // Empty-series retries back off: the full `candles` call is the heavy,
    // provider-bound one, and at 1 Hz it hammered a parked provider (and the
    // main process) for a token that simply had no candles yet.
    let emptyDelayMs = 1_000;
    let nextEmptyRetryAt = 0;
    const poll = async (): Promise<void> => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const cur = seriesRef.current;
        if (!cur || cur.candles.length === 0) {
          // Nothing on screen yet (a token nobody had charted) — retry the
          // full load until a first candle exists for the tail to grow from.
          if (Date.now() < nextEmptyRetryAt) return;
          nextEmptyRetryAt = Date.now() + emptyDelayMs;
          emptyDelayMs = Math.min(10_000, emptyDelayMs * 2);
          const r = await window.krypt.market.candles(mint, interval, 500);
          if (!cancelled && r.ok && r.data && r.data.candles.length > 0) {
            setSeries(r.data);
            lastCandleTimeRef.current = r.data.candles[r.data.candles.length - 1].time;
            emptyDelayMs = 1_000;
          }
          return;
        }
        emptyDelayMs = 1_000;
        const r = await window.krypt.market.candlesTail(mint, interval, lastCandleTimeRef.current);
        if (cancelled || !r.ok || !r.data || r.data.candles.length === 0) return;
        // UNIT GUARD. The tail is APPENDED to bars already on screen, so it
        // must be priced the same way they are. It is not always: a chart
        // that first painted from the local tape with no SOL/USD rate is in
        // SOL, and the next tail — by then the rate is cached, or a provider
        // answered — comes back in USD. Appending that drew one series with
        // two scales ~1e9 apart: the y-axis blew out to 1e11+ and every real
        // candle squashed into the baseline (user report, 2026-09-13). A
        // changed unit (or a changed effective interval) is a different
        // series, so redraw it instead of gluing it on.
        const cur2 = seriesRef.current;
        const unitChanged = !!cur2 && (r.data.unit !== cur2.unit || r.data.effectiveInterval !== cur2.effectiveInterval);
        if (unitChanged) {
          const full = await window.krypt.market.candles(mint, interval, 500);
          if (cancelled || !full.ok || !full.data) return;
          setSeries(full.data);
          const fc = full.data.candles;
          lastCandleTimeRef.current = fc.length ? fc[fc.length - 1].time : 0;
          return;
        }
        chartApiRef.current?.appendCandles(r.data.candles);
        lastCandleTimeRef.current = r.data.candles[r.data.candles.length - 1].time;
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void poll(), isSub ? 1_000 : 5_000);
    // Coming back from a hidden window, catch up immediately.
    const onVis = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [mint, interval]);

  // Chart, stage 3: live ticks. While the engine is running and this mint is
  // taped, every trade lands here within 125 ms and moves the last bar
  // immediately — this is what makes the chart move between polls. When the
  // engine is not running no ticks arrive and the poll alone applies; the
  // chart says nothing and invents nothing.
  //
  // UNIT DISCIPLINE (see priceLines below): ticks are priced in SOL, the
  // chart in `series.unit`. A USD chart with no SOL/USD rate drops the tick
  // rather than mixing units.
  useEffect(() => {
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'tick' || ev.mint !== mint) return;
      if (document.hidden) return;
      // The header follows the same ticks, throttled to ~4 renders/s through
      // a ref — the chart moves at 8/s, and a header that sat frozen on the
      // load-time price beside a moving chart read as a bug. USD only: with
      // no SOL/USD rate the summary's own figure stays (no unit mixing).
      const rate = solUsdRef.current;
      if (rate !== null && rate > 0) {
        const priceUsd = ev.priceSol * rate;
        const supply = supplyRef.current;
        liveHeaderPendingRef.current = {
          priceUsd,
          marketCapUsd: supply !== null && supply > 0 ? priceUsd * supply : null,
        };
        if (liveHeaderTimerRef.current === null) {
          liveHeaderTimerRef.current = window.setTimeout(() => {
            liveHeaderTimerRef.current = null;
            const next = liveHeaderPendingRef.current;
            liveHeaderPendingRef.current = null;
            if (next) setLiveHeader(next);
          }, 250);
        }
      }
      const cur = seriesRef.current;
      if (!cur || cur.candles.length === 0) return;
      let price = ev.priceSol;
      if (cur.unit === 'usd') {
        if (rate === null || rate <= 0) return;
        price = ev.priceSol * rate;
      }
      chartApiRef.current?.applyTick(ev.time, price, ev.volSol);
    });
    return () => {
      off();
      if (liveHeaderTimerRef.current !== null) {
        window.clearTimeout(liveHeaderTimerRef.current);
        liveHeaderTimerRef.current = null;
      }
      liveHeaderPendingRef.current = null;
    };
  }, [mint]);

  // Tab data
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (tab === 'holders' && !holders) {
        const r = await window.krypt.market.holders(mint, 50);
        if (!cancelled && r.ok && r.data) setHolders(r.data);
      }
      if (tab === 'holders' && holderView === 'map' && !graph) {
        const r = await window.krypt.market.holderGraph(mint, 50);
        if (!cancelled && r.ok && r.data) setGraph(r.data);
      }
      if (tab === 'trades') {
        const r = await window.krypt.market.trades(mint, 80);
        if (!cancelled && r.ok && r.data) setTrades(r.data);
      }
      if (tab === 'traders') {
        const r = await window.krypt.market.traderScan(mint);
        if (!cancelled && r.ok && r.data) setScan(r.data);
      }
      if (tab === 'launch' && !launch) {
        setLaunchLoading(true);
        const r = await window.krypt.market.launchIntel(mint);
        if (cancelled) return;
        if (r.ok && r.data) {
          setLaunch(r.data);
          // The creator only becomes known once the launch report resolves,
          // so this is chained rather than fired alongside it.
          if (r.data.creator) {
            const h = await window.krypt.market.creatorHistory(r.data.creator);
            if (!cancelled && h.ok) setCreator(h.data ?? null);
          }
        }
        if (!cancelled) setLaunchLoading(false);
      }
    };
    void load();
    // Trades and trader scan are live views on the tape; poll them.
    const id =
      tab === 'trades' || tab === 'traders' ? window.setInterval(() => void load(), 3_000) : undefined;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
  }, [tab, mint, holders, holderView, graph, launch]);

  // Reset per-token caches when the mint changes.
  useEffect(() => {
    setQuick(null);
    setHolders(null);
    setGraph(null);
    setTrades(null);
    setScan(null);
    setSeries(null);
    setLaunch(null);
    setCreator(null);
    setLiveHeader(null);
  }, [mint]);

  const s = detail?.summary ?? quick;
  // Circulating supply for the tick-driven market cap: the chart's own
  // multiplier first (same number the MC toggle uses), the summary's second.
  supplyRef.current = series?.supplyForMcap ?? s?.circSupply ?? null;
  const change24 = s?.stats['24h']?.priceChangePct ?? null;
  /**
   * When these numbers were actually fetched, if that was a while ago.
   *
   * `fetchedAt` is stamped when a provider answered, and a summary held over
   * by the grace tier in data/http.ts keeps its original stamp - which is
   * exactly what makes it safe to show. Under the threshold there is nothing
   * to say: every page is a few seconds behind the chain, and labelling that
   * would be noise.
   */
  const heldOverAt =
    s && s.fetchedAt > 0 && Date.now() - s.fetchedAt > HELD_OVER_NOTE_MS ? s.fetchedAt : null;
  // The +120 s re-judgement arrives with the next detail reload (the page
  // polls via loadDetail), so this is read fresh on every render rather than
  // memoised. The security report is the authoritative copy; the summary's
  // is the same judgement carried on the Discover row.
  const odds = detail?.security.odds ?? s?.odds ?? null;

  /** What the drawn chart is priced in. USD when a provider (or a converted
   *  tape) supplied it; SOL when the only source we had was our own
   *  SOL-priced feed and no SOL/USD rate. The axis says which. */
  const chartUnit = series?.unit ?? 'usd';

  // Order markers are drawn onto the chart as literal colours; the semantic
  // ones (stop = rose, limit buy = emerald) are fixed, the rest is the accent.
  const accent = useAccent().rgb();

  const markers = useMemo(() => [], []);

  // Draw every armed order that has a knowable SOL trigger.
  //
  // UNIT DISCIPLINE. `triggerPriceSol` returns SOL per token; the chart's
  // candles are whatever `series.unit` says, and USD is the usual case
  // (GeckoTerminal and Birdeye both price in USD). Drawing a SOL number on a
  // USD axis put the stop-loss line ~94x below where it belonged — visually
  // convincing and completely wrong. Convert to the series' own unit here,
  // and draw nothing at all if the rate needed for that conversion is
  // missing, because a line in the wrong unit is worse than no line.
  //
  // Market-cap and conditional orders have no single price to sit at, so
  // they are listed in the panel but deliberately not faked onto the chart.
  const priceLines = useMemo(
    () => {
      const unit = series?.unit ?? 'usd';
      const toChartUnit = (sol: number): number | null => {
        if (unit === 'sol') return sol;
        return solUsd !== null && solUsd > 0 ? sol * solUsd : null;
      };
      return orders
        .filter((o) => o.state === 'armed' || o.state === 'paused')
        .map((o) => {
          const sol = triggerPriceSol(o);
          return { o, price: sol === null ? null : toChartUnit(sol) };
        })
        .filter((x): x is { o: AdvOrder; price: number } => x.price !== null && x.price > 0)
        .map(({ o, price }) => ({
          price,
          color:
            o.state === 'paused' ? '#D9B45B'
            : o.kind === 'stop_loss' || o.kind === 'trailing_stop' ? '#f43f5e'
            : o.kind === 'limit_buy' ? '#34d399'
            : accent,
          title:
            (o.state === 'paused' ? 'PAUSED ' : '') +
            (o.kind === 'stop_loss' ? 'SL'
              : o.kind === 'trailing_stop' ? 'TRAIL'
              : o.kind === 'take_profit' ? 'TP'
              : o.kind === 'limit_buy' ? 'BUY'
              : 'SELL') +
            ` ${o.amount}${o.kind === 'limit_buy' ? ' SOL' : '%'}`,
          dashed: o.state === 'paused',
        }));
    },
    [orders, series?.unit, solUsd],
  );

  const copyMint = (): void => {
    void navigator.clipboard.writeText(mint).then(
      () => toast.success('Mint address copied'),
      () => toast.error('Could not copy'),
    );
  };

  if (loading && !detail && !quick) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-krypt-purple" />
      </div>
    );
  }

  if (error && !detail && !quick) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-rose-300">{error}</p>
        <button onClick={onBack} className="text-note text-krypt-muted hover:text-white underline underline-offset-2">
          Back to Discover
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-white/8">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="h-10 w-10 rounded-md overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
            {imageSrc(s?.imageUrl) ? (
              <img src={imageSrc(s?.imageUrl) as string} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-body font-display text-krypt-muted">
                {(s?.symbol || '?').slice(0, 3)}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-semibold text-white truncate">{s?.symbol || shortAddr(mint)}</h1>
              <span className="text-sm text-krypt-muted truncate max-w-[240px]">{s?.name}</span>
              {s?.liveTracked ? (
                <span
                  className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-emerald-300"
                  title="Krypt is receiving this token’s trades on its own feed — 1s candles, live trades and Trader Scan all work."
                >
                  Taped live
                </span>
              ) : (
                <span
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-krypt-muted/70"
                  title="Krypt is not receiving this token’s trades. Press Start scanning to tape it — that is what enables 1s candles, live trades and Trader Scan."
                >
                  Not taped
                </span>
              )}
              {heldOverAt !== null && (
                // A throttled provider no longer blanks this page: the last
                // good numbers are held over instead (see the grace tier in
                // data/http.ts). That is only honest if the page says so -
                // numbers from a minute ago presented as current are worse
                // than no numbers at all.
                <span
                  className="rounded-full border border-arc-gold/30 bg-arc-gold/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-arc-gold/90"
                  title="A data provider is rate limited, so these figures are the last ones it answered with. They will refresh as soon as it does."
                >
                  As of {fmtAgo(heldOverAt as number)} ago
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <button
                onClick={copyMint}
                className="flex items-center gap-1 text-body font-mono text-krypt-muted hover:text-white transition"
              >
                {shortAddr(mint, 6)}
                <Copy className="h-3 w-3" />
              </button>
              <button
                onClick={() => void window.krypt.app.openExternal(`https://solscan.io/token/${mint}`)}
                className="flex items-center gap-1 text-body text-krypt-muted hover:text-krypt-purple transition"
              >
                Solscan
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-6">
            <Stat label="Price" value={fmtPriceUsd(liveHeader?.priceUsd ?? s?.priceUsd)} />
            <Stat label="Market cap" value={fmtUsd(liveHeader?.marketCapUsd ?? s?.marketCapUsd)} />
            <Stat label="Liquidity" value={fmtUsd(s?.liquidityUsd)} />
            <Stat label="Holders" value={fmtNum(s?.holders)} />
            <Stat label="24h" value={fmtChange(change24)} tone={toneFor(change24)} />
            <Stat label="Age" value={fmtAge(s?.createdAt)} />
            <Stat
              label="Score"
              value={s?.kryptScore === null || s?.kryptScore === undefined ? '—' : String(s.kryptScore)}
              tone={scoreTone(s?.kryptScore)}
            />
          </div>

          <button
            onClick={() => term.toggleWatch(mint)}
            title={term.isWatched(mint) ? 'Remove from watchlist' : 'Add to watchlist'}
            className={cls(
              'h-8 w-8 rounded-lg border flex items-center justify-center transition',
              term.isWatched(mint)
                ? 'border-arc-gold/45 bg-arc-gold/15 text-arc-gold'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:text-arc-gold',
            )}
          >
            <Star className="h-4 w-4" fill={term.isWatched(mint) ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => void loadDetail()}
            title="Refresh"
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          >
            <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        {detail?.warnings.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {detail.warnings.map((w) => (
              <span key={w} className="rounded border border-arc-gold/25 bg-arc-gold/10 px-2 py-0.5 text-label text-arc-gold/90">
                {w}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 p-4 overflow-hidden">
        <div className="min-w-0 flex flex-col gap-4 overflow-y-auto pr-1">
          {/* Chart */}
          <div className="plate rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                {CANDLE_INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setInterval(iv)}
                    className={cls(
                      'px-2 py-1 text-label font-mono font-semibold transition',
                      interval === iv ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
                    )}
                  >
                    {iv}
                  </button>
                ))}
              </div>

              <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                {(['mcap', 'price'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setChartMode(m)}
                    title={
                      m === 'mcap'
                        ? chartUnit === 'sol'
                          ? 'Market cap in SOL — this chart is SOL-priced because no SOL/USD rate was available when it loaded'
                          : 'Market cap: the chart price multiplied by circulating supply'
                        : chartUnit === 'sol'
                          ? 'Price in SOL per token'
                          : 'Price in USD per token'
                    }
                    className={cls(
                      'px-2.5 py-1 text-label font-semibold uppercase tracking-wider transition',
                      chartMode === m ? 'bg-arc-gold/20 text-arc-gold' : 'text-krypt-muted hover:text-white hover:bg-white/5',
                    )}
                  >
                    {m === 'mcap' ? 'MC' : 'Price'}
                    {/* Say which currency the axis is in. A SOL-priced series
                        multiplied by supply is a market cap in SOL, and
                        showing it bare next to a $-denominated header read as
                        a broken chart (user report, 2026-09-13). */}
                    {chartUnit === 'sol' && <span className="ml-1 normal-case text-krypt-muted/70">SOL</span>}
                  </button>
                ))}
              </div>

              {chartLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-krypt-purple" />}

              <div className="flex-1" />
              {series && (
                <span className="text-label text-krypt-muted/60 uppercase tracking-label">
                  via {series.source}
                </span>
              )}
            </div>

            {series && series.candles.length > 0 ? (
              <KryptChart
                ref={chartApiRef}
                candles={series.candles}
                markers={markers}
                priceLines={priceLines}
                mode={chartMode}
                supply={series.supplyForMcap}
                // A degraded series (1m served for a sub-minute ask) must
                // bucket live ticks by what the bars ARE, not what was asked.
                bucketSec={BUCKET_SEC[series.effectiveInterval ?? interval]}
                height={360}
              />
            ) : (
              <div className="h-[360px] flex items-center justify-center rounded-md border border-dashed border-white/10">
                <p className="max-w-md text-center text-note text-krypt-muted leading-relaxed px-6">
                  {series?.note ?? chartError ?? (chartLoading ? 'Loading candles…' : 'No chart data for this token yet.')}
                </p>
              </div>
            )}

            {series?.note && series.candles.length > 0 && (
              <p className="text-label text-krypt-muted/60 mt-2 leading-relaxed">{series.note}</p>
            )}
          </div>

          {/* Tabs */}
          <div className="plate rounded-lg p-3 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-1 mb-3 border-b border-white/8 pb-2">
              {([
                ['security', 'Security'],
                ['launch', 'Launch'],
                ['holders', 'Holders'],
                ['trades', 'Live trades'],
                ['traders', 'Trader scan'],
                ['ai', 'AI'],
              ] as Array<[Tab, string]>).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cls(
                    'rounded-md px-3 py-1.5 text-body font-semibold transition',
                    tab === id ? 'bg-white/8 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              {tab === 'security' &&
                (detail ? (
                  <div className="space-y-3">
                    {/* Free, offline: what the X link actually points at, and
                        whether the same account or post is behind other
                        launches on screen. */}
                    <XLinkPanel
                      mint={mint}
                      twitter={s?.socials.twitter ?? null}
                      launches={Object.values(term.columns).flatMap((c) => c.rows)}
                    />
                    <SecurityPanel report={detail.security} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
                    <p className="text-body text-krypt-muted max-w-sm leading-relaxed">
                      Reading the mint and holder accounts from your RPC. The free public endpoint rate-limits these
                      calls heavily — a free Helius key in Settings makes this near-instant.
                    </p>
                  </div>
                ))}
              {tab === 'launch' && <LaunchPanel report={launch} history={creator} loading={launchLoading} />}
              {tab === 'holders' && (
                <div className="space-y-3">
                  <div className="flex items-center rounded-md border border-white/10 overflow-hidden w-fit">
                    {(['list', 'map'] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setHolderView(v)}
                        className={cls(
                          'px-3 py-1 text-label font-semibold uppercase tracking-wider transition',
                          holderView === v ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  {holderView === 'list' ? (
                    holders ? (
                      <HoldersPanel report={holders} />
                    ) : (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
                      </div>
                    )
                  ) : graph ? (
                    <HolderMap
                      graph={graph}
                      analysing={analysing}
                      creator={s?.creator ?? null}
                      emptyNote={holders?.note ?? null}
                      onAnalyse={() => {
                        setAnalysing(true);
                        void window.krypt.market
                          .analyseHolders(mint, 50)
                          .then((r) => {
                            if (r.ok && r.data) setGraph(r.data);
                            else toast.error(r.message);
                          })
                          .finally(() => setAnalysing(false));
                      }}
                    />
                  ) : (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
                    </div>
                  )}
                </div>
              )}
              {tab === 'trades' && (
                <LiveTrades
                  rows={trades?.rows ?? []}
                  note={trades?.note ?? null}
                  source={trades?.source ?? 'none'}
                />
              )}
              {tab === 'traders' && <TraderScan rows={scan?.rows ?? []} note={scan?.note ?? null} />}
              {tab === 'ai' && <AiPanel mint={mint} symbol={s?.symbol ?? ''} />}
            </div>
          </div>
        </div>

        {/* Trade panel */}
        <div className="min-w-0 overflow-y-auto">
          {/* Graduation odds — the first thing a buyer should see, so it sits
              above the trade panel rather than in the Security tab. */}
          {s && (
            <div className="plate rounded-lg p-3 mb-4">
              <OddsPanel odds={odds} />
            </div>
          )}

          <div className="plate rounded-lg p-3">
            {s && settings ? (
              <TradePanel
                token={s}
                settings={settings}
                wallet={wallet}
                live={live}
                solUsd={solUsd}
                onTraded={() => {
                  void loadWalletState();
                  void loadDetail();
                  setPosKey((k) => k + 1);
                }}
              />
            ) : (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
              </div>
            )}
          </div>

          {/* Your position — renders only when the wallet holds this token */}
          {s && settings && (
            <PositionPanel
              mint={mint}
              solUsd={solUsd}
              isLive={live?.armed === true && settings.execution.liveEnabled}
              refreshKey={posKey}
              onTraded={() => {
                void loadWalletState();
                void loadDetail();
                setPosKey((k) => k + 1);
              }}
            />
          )}

          {/* Orders */}
          {s && (
            <div className="plate rounded-lg p-3 mt-4">
              <OrdersPanel
                token={s}
                orders={orders}
                executable={ordersExecutable}
                blockedReason={ordersBlocked}
                maxLiveSol={settings?.execution.maxLiveSol ?? null}
                onChanged={() => void loadOrders()}
              />
            </div>
          )}

          {/* Alerts */}
          {s && (
            <div className="plate rounded-lg p-3 mt-4">
              <AlertsPanel token={s} alerts={alerts} onChanged={() => void loadAlerts()} />
            </div>
          )}

          {/* Pools */}
          {detail && detail.pools.length > 0 && (
            <div className="plate rounded-lg p-3 mt-4">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-label font-semibold uppercase tracking-heading text-krypt-muted whitespace-nowrap">
                  Pools
                </h3>
                <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
              </div>
              <div className="space-y-1">
                {detail.pools.slice(0, 5).map((p) => (
                  <div key={p.address} className="flex items-center gap-2 text-body">
                    <span className="text-krypt-muted uppercase text-micro tracking-wider w-16 truncate">{p.dexId}</span>
                    <span className="font-mono text-white/80 truncate flex-1">{p.label}</span>
                    <span className="font-mono text-krypt-muted">{fmtUsd(p.liquidityUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
