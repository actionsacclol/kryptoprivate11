import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import { accent } from '../../state/theme';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, ChartMarker } from '@shared/market';

// The chart. TradingView's lightweight-charts, bundled locally — no remote
// script, no CDN, nothing for the CSP to allow.
//
// Three things here are ours rather than the library's:
//
//   • the MC toggle. Candles arrive priced per token; multiplying every OHLC
//     by circulating supply turns the same series into a market-cap chart,
//     which is how memecoin traders actually read a price. Doing it in the
//     renderer (rather than fetching a second series) means the toggle is
//     instant and the two views can never disagree.
//   • price lines for orders and fills, which is what makes a chart a
//     trading surface instead of a picture.
//   • INCREMENTAL updates. `setData` repaints the whole series and is
//     reserved for identity changes (new token, new interval, MC toggle).
//     Everything that happens while the user watches — live ticks off the
//     engine feed, tail candles off the poll — goes through `series.update`
//     on the imperative handle below, which repaints one bar and never
//     touches the user's pan/zoom.

export interface PriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

/** Imperative surface for live updates that must not re-render React. */
export interface KryptChartHandle {
  /**
   * Merge one live trade into the chart. `price` must already be in the
   * series' unit (per-token, UNmultiplied — the MC multiplier is applied
   * here); `volSol` is SOL, same as the tape's candle volume. The bar is
   * bucketed client-side at `bucketSec`.
   */
  applyTick: (timeSec: number, price: number, volSol: number) => void;
  /** Append/replace trailing candles (same unit as the `candles` prop).
   *  Candles at or after the current last bucket update in place; older
   *  ones are ignored — `series.update` cannot rewrite history. */
  appendCandles: (candles: Candle[]) => void;
}

const UP = '#34d399';
const DOWN = '#f43f5e';

const volColor = (up: boolean): string => (up ? 'rgba(52,211,153,0.28)' : 'rgba(244,63,94,0.28)');

interface KryptChartProps {
  candles: Candle[];
  markers?: ChartMarker[];
  priceLines?: PriceLine[];
  /** 'price' shows per-token price; 'mcap' multiplies by supply. */
  mode: 'price' | 'mcap';
  supply: number | null;
  /** Seconds per candle bucket at the active interval — used to bucket
   *  live ticks client-side. */
  bucketSec: number;
  height?: number;
}

const KryptChartInner = forwardRef<KryptChartHandle, KryptChartProps>(function KryptChart(
  { candles, markers, priceLines, mode, supply, bucketSec, height = 380 },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const fittedRef = useRef(false);

  // The raw (unit-priced, unmultiplied) bars currently on the chart: the
  // last full `setData` plus everything applied incrementally since. A mode
  // or supply change redraws from THIS, not from the `candles` prop, so
  // toggling MC never discards live bars the prop has not caught up with.
  const rawBarsRef = useRef<Candle[]>([]);
  const multRef = useRef(1);
  const bucketSecRef = useRef(bucketSec);
  bucketSecRef.current = bucketSec;
  // Identity of the last array fed through setData, so the data effect can
  // tell "new series" (full redraw + refit) from "same series, new
  // mode/supply" (full redraw from rawBars) and skip everything else.
  const lastDataIdRef = useRef<Candle[] | null>(null);
  const lastModeRef = useRef<'price' | 'mcap' | null>(null);

  // Create once. Re-creating on every data change would reset the user's pan
  // and zoom on every poll, which makes the chart unusable while it updates.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const chart = createChart(box, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8C92AB',
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(240,237,226,0.04)' },
        horzLines: { color: 'rgba(240,237,226,0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: accent(0.5), width: 1, style: LineStyle.Dashed, labelBackgroundColor: accent(0.85) },
        horzLine: { color: accent(0.5), width: 1, style: LineStyle.Dashed, labelBackgroundColor: accent(0.85) },
      },
      rightPriceScale: {
        borderColor: 'rgba(240,237,226,0.08)',
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderColor: 'rgba(240,237,226,0.08)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 4,
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 },
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: accent(0.35),
    });
    // Pin volume to the bottom quarter so it reads as a sub-panel rather
    // than fighting the candles for vertical space.
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    // The new series starts empty; force the next data effect to setData.
    lastDataIdRef.current = null;
    lastModeRef.current = null;
    rawBarsRef.current = [];

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) chart.applyOptions({ width: Math.floor(w) });
    });
    ro.observe(box);
    chart.applyOptions({ width: box.clientWidth });

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [height]);

  /** Push one raw bar to both series, multiplied for the current mode.
   *  try/catch: the chart can be disposed between a schedule and the call,
   *  and `update` throws on a bar older than the series tail. */
  const pushBar = (bar: Candle): void => {
    const series = candleRef.current;
    const vol = volumeRef.current;
    if (!series || !vol) return;
    const mult = multRef.current;
    const t = bar.time as UTCTimestamp;
    try {
      series.update({
        time: t,
        open: bar.open * mult,
        high: bar.high * mult,
        low: bar.low * mult,
        close: bar.close * mult,
      });
      vol.update({ time: t, value: bar.volume, color: volColor(bar.close >= bar.open) });
    } catch {
      /* disposed mid-flight, or a stale bar raced a full redraw — drop it */
    }
  };

  useImperativeHandle(
    ref,
    (): KryptChartHandle => ({
      applyTick: (timeSec, price, volSol) => {
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timeSec)) return;
        const bucket = bucketSecRef.current;
        if (!bucket || bucket <= 0) return;
        const bars = rawBarsRef.current;
        // A tick cannot open a chart: with no bars there has been no first
        // load, and the component is not even mounted without data anyway.
        if (bars.length === 0) return;
        const b = Math.floor(timeSec / bucket) * bucket;
        const last = bars[bars.length - 1];
        if (b < last.time) return; // stale tick — history is settled
        const v = Number.isFinite(volSol) && volSol > 0 ? volSol : 0;
        let bar: Candle;
        if (b === last.time) {
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          last.close = price;
          last.volume += v;
          bar = last;
        } else {
          bar = { time: b, open: price, high: price, low: price, close: price, volume: v };
          bars.push(bar);
          if (bars.length > 1500) bars.splice(0, bars.length - 1500);
        }
        pushBar(bar);
      },
      appendCandles: (incoming) => {
        const bars = rawBarsRef.current;
        if (bars.length === 0) return; // no base series yet — wait for the first load
        for (const c of incoming) {
          if (!Number.isFinite(c.time) || !Number.isFinite(c.close)) continue;
          const last = bars[bars.length - 1];
          if (c.time < last.time) continue; // `update` cannot rewrite history
          const copy: Candle = { ...c };
          if (c.time === last.time) {
            bars[bars.length - 1] = copy; // authoritative replacement of the live bucket
          } else {
            bars.push(copy);
            if (bars.length > 1500) bars.splice(0, bars.length - 1500);
          }
          pushBar(copy);
        }
      },
    }),
    [],
  );

  // Full redraws — ONLY when the series identity changes (new token or
  // interval → new `candles` array from the loader) or the projection
  // changes (MC toggle, supply revision). The old version of this effect
  // ran setData + applyOptions on every 2 s poll, a full repaint that also
  // recomputed both arrays; live data now arrives through the handle above
  // and never comes back through here.
  useEffect(() => {
    const series = candleRef.current;
    const vol = volumeRef.current;
    if (!series || !vol) return;

    const mult = mode === 'mcap' && supply && supply > 0 ? supply : 1;
    const newData = lastDataIdRef.current !== candles;
    const newMult = multRef.current !== mult;
    if (!newData && !newMult && lastModeRef.current === mode) return;

    if (newData) {
      // Rebuild the raw-bar mirror from the prop: sort/dedupe guard because
      // lightweight-charts throws on non-ascending or duplicate timestamps,
      // and two providers merged into one series can produce both.
      const raw: Candle[] = [];
      let lastTime = -1;
      for (const c of candles) {
        if (c.time <= lastTime) continue;
        lastTime = c.time;
        raw.push({ ...c });
      }
      // History arriving behind a first, thin paint (the cache/tape answer
      // comes first, the provider merge follows) is a different chart: refit
      // so the user sees the history, not a viewport zoomed on five bars.
      const before = rawBarsRef.current.length;
      if (before > 0 && raw.length > before * 2) fittedRef.current = false;
      rawBarsRef.current = raw;
      lastDataIdRef.current = candles;
    }
    multRef.current = mult;

    // priceFormat is a function of the mode alone, so applyOptions runs
    // only when the mode actually flips — not on every data change.
    if (lastModeRef.current !== mode) {
      lastModeRef.current = mode;
      series.applyOptions({
        priceFormat:
          mode === 'mcap'
            ? { type: 'price', precision: 0, minMove: 1 }
            : { type: 'price', precision: 8, minMove: 0.00000001 },
      });
    }

    const data: CandlestickData<Time>[] = [];
    const volData: HistogramData<Time>[] = [];
    for (const c of rawBarsRef.current) {
      const t = c.time as UTCTimestamp;
      data.push({ time: t, open: c.open * mult, high: c.high * mult, low: c.low * mult, close: c.close * mult });
      volData.push({ time: t, value: c.volume, color: volColor(c.close >= c.open) });
    }
    series.setData(data);
    vol.setData(volData);

    // Close the open-to-paint measure the token page opened at fetch time.
    // Once per open: the mark is cleared so a later redraw cannot re-measure.
    if (newData && data.length) {
      try {
        if (performance.getEntriesByName('krypt:candles:fetch', 'mark').length) {
          performance.mark('krypt:chart:paint');
          const m = performance.measure('krypt:chart:open', 'krypt:candles:fetch', 'krypt:chart:paint');
          performance.clearMarks('krypt:candles:fetch');
          performance.clearMarks('krypt:chart:paint');
          // eslint-disable-next-line no-console
          console.debug(`[chart] open→paint ${Math.round(m.duration)} ms (${data.length} bars)`);
        }
      } catch {
        /* measurement is optional */
      }
    }

    // Fit once on first data; after that leave the viewport where the user
    // put it — a redraw must never yank them back to the full range.
    if (!fittedRef.current && data.length) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [candles, mode, supply]);

  // Reset the auto-fit when the series identity changes (new token/interval).
  useEffect(() => {
    fittedRef.current = false;
  }, [candles.length === 0]);

  // Markers — our own fills and tracked-wallet activity.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const list: SeriesMarker<Time>[] = (markers ?? []).map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.kind === 'buy' || m.kind === 'tracked_buy' ? 'belowBar' : 'aboveBar',
      color:
        m.kind === 'buy' ? UP
        : m.kind === 'sell' ? DOWN
        : m.kind === 'dev_sell' ? '#E5484D'
        : '#D9B45B',
      shape: m.kind === 'buy' || m.kind === 'tracked_buy' ? 'arrowUp' : 'arrowDown',
      text: m.label,
    }));
    list.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(list);
  }, [markers]);

  // Price lines — limit orders, TP/SL, entry.
  //
  // Guarded by a value signature: the effect's inputs change identity on
  // every orders/solUsd poll, but the drawn lines rarely change VALUE, and
  // tearing down and recreating identical lines every push is churn on the
  // chart for nothing. Lines are removed at the top of the next run rather
  // than in a cleanup, so an unmount never touches a disposed series
  // (`chart.remove()` already took the lines down with it).
  const linesRef = useRef<{ owner: ISeriesApi<'Candlestick'> | null; sig: string; lines: IPriceLine[] }>({
    owner: null,
    sig: '',
    lines: [],
  });
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const mult = mode === 'mcap' && supply && supply > 0 ? supply : 1;
    const wanted = (priceLines ?? []).filter((l) => Number.isFinite(l.price) && l.price > 0);
    const sig = wanted
      .map((l) => `${l.price * mult}|${l.color}|${l.title}|${l.dashed ? 1 : 0}`)
      .join(';');
    const cur = linesRef.current;
    if (cur.owner === series && cur.sig === sig) return; // nothing actually changed
    if (cur.owner === series) {
      for (const line of cur.lines) {
        try {
          series.removePriceLine(line);
        } catch {
          /* already disposed */
        }
      }
    }
    const created: IPriceLine[] = [];
    for (const l of wanted) {
      try {
        created.push(
          series.createPriceLine({
            price: l.price * mult,
            color: l.color,
            lineWidth: 1,
            lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
            axisLabelVisible: true,
            title: l.title,
          }),
        );
      } catch {
        /* chart was disposed between render and effect */
      }
    }
    linesRef.current = { owner: series, sig, lines: created };
  }, [priceLines, mode, supply]);

  return <div ref={boxRef} className="w-full" style={{ height }} />;
});

// memo: the token page re-renders on every header tick and orders push; the
// chart's props (memoised arrays, two scalars) rarely change, and even a
// no-op re-render here is a forwardRef + four effects re-evaluated.
export const KryptChart = memo(KryptChartInner);
