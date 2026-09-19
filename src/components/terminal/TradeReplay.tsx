// Trade replay — the trade played back as it happened (2026-09-03).
//
// Candles arrive one by one, the entry and exit are marked where they
// actually were, and a running PnL counts up and down against the price the
// wallet really paid. It ends on the realised number.
//
// Drawn on a canvas rather than driven through the chart library, for the
// same reason the PnL card is: the output has to be a file. The canvas is
// recorded straight to WebM with MediaRecorder, so a replay leaves as a
// video without any screen-capture tool. Nothing about the trade leaves the
// machine unless the user posts it.
//
// Every number on screen comes from the ledger or the chart: the entry is
// the average price actually paid, the end state is the realised PnL from
// the fills. The replay is an animation of a record, not a simulation.

import { useCallback, useEffect, useRef, useState } from 'react';
import { accent } from '../../state/theme';
import { Image as ImageIcon, Loader2, Play, RotateCcw, Sparkles, Video, X } from 'lucide-react';
import type { Candle, CandleInterval, CandleSeries } from '@shared/market';
import type { IpcResult } from '@shared/types';
import type { ClosedTrade } from '@shared/portfolio';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';
import { GifPicker } from './GifPicker';
import { dataUrlType, decodeAnimation, frameAt, type GifAnimation } from './gifFrames';
import { replayLayout } from './replayLayout';
import {
  REPLAY_CANDLE_LIMIT,
  pickInterval,
  priceRange,
  replayWindow,
  revealCount,
  runningPnl,
  trimCandles,
  anchorCandlesToEntry,
  pickSyntheticInterval,
  syntheticCandles,
} from './replayPlan';

type Shape = 'wide' | 'tall';
const SHAPES: Record<Shape, { w: number; h: number; label: string; hint: string }> = {
  wide: { w: 1280, h: 720, label: '16:9', hint: 'X, YouTube' },
  tall: { w: 720, h: 1280, label: '9:16', hint: 'TikTok, Reels, Shorts' },
};

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

const UP = '#34d399';
const DOWN = '#f43f5e';
const INK = '#F0EDE2';
// Read per draw: a canvas keeps whatever colour it was painted with, so a
// module constant would survive a theme change until something else
// happened to repaint.
const ACCENT = (): string => accent();

/** How long the candles take to arrive, before speed. */
const BASE_SECONDS = 9;
/** A beat on the final frame so the result is readable, and recordable. */
const HOLD_SECONDS = 2.2;

function fmtPrice(p: number): string {
  if (!(p > 0)) return '—';
  return p >= 0.001 ? p.toFixed(6) : p.toExponential(2);
}

export function TradeReplay({
  trade,
  candles: given,
  candleSource,
  nativeSymbol = 'SOL',
  onClose,
}: {
  trade: ClosedTrade;
  /** Candles to animate instead of fetching — the simulator supplies these. */
  candles?: Candle[];
  /**
   * Where history comes from when it is fetched: Solana's market feed by
   * default, an EVM chain's own candles when the Trades page is on one
   * (2026-09-11). Same window, same USD-to-entry anchoring, same frame.
   */
  candleSource?: (interval: CandleInterval, limit: number) => Promise<IpcResult<CandleSeries>>;
  /** What the coin is called on the frame: SOL, or ETH / BNB. */
  nativeSymbol?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const [shape, setShape] = useState<Shape>('wide');
  const [speed, setSpeed] = useState<Speed>(1);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [interval, setIntervalUsed] = useState<CandleInterval | null>(null);
  const [unit, setUnit] = useState<'sol' | 'usd'>('sol');
  /** Where the candles came from: the provider as-is, the provider scaled
   *  to SOL at the entry, or a seeded path drawn between the two fills. */
  const [path, setPath] = useState<'real' | 'scaled' | 'illustrative'>('real');
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  /** A still background (an upload, or a GIF we could not decode). */
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  /** An animated background, decoded frame by frame so WE run the loop. */
  const [bgAnim, setBgAnim] = useState<GifAnimation | null>(null);
  const bgAnimRef = useRef<GifAnimation | null>(null);
  bgAnimRef.current = bgAnim;
  const fileRef = useRef<HTMLInputElement>(null);

  const useBackground = useCallback(
    (dataUrl: string) => {
      // Try the animated path first; a still is the fallback, not the plan,
      // and when it happens the user is told why rather than left wondering
      // whether the GIF was animated at all.
      void decodeAnimation(dataUrl).then((res) => {
        setBgAnim((prev) => {
          prev?.close();
          return res.ok ? res.anim : null;
        });
        if (res.ok) {
          setBgImage(null);
          return;
        }
        if (dataUrlType(dataUrl) === 'image/gif') toast.warn(`Using a still frame — ${res.reason}.`);
        const img = new Image();
        img.onload = () => setBgImage(img);
        img.src = dataUrl;
      });
    },
    [toast],
  );

  const clearBackground = useCallback(() => {
    setBgAnim((prev) => {
      prev?.close();
      return null;
    });
    setBgImage(null);
  }, []);

  // Frames hold GPU memory; give them back when the panel closes.
  useEffect(() => () => bgAnimRef.current?.close(), []);

  // ── Load the window this trade lived in ────────────────────────────
  useEffect(() => {
    let live = true;
    // Supplied candles skip the provider entirely.
    if (given) {
      setCandles(given);
      setIntervalUsed(null);
      setUnit('sol');
      setProblem(null);
      setLoading(false);
      return;
    }
    /** The illustrative path, when the fills allow one. True if it was used. */
    const useSyntheticPath = (): boolean => {
      const iv = pickSyntheticInterval(trade.openedAt, trade.closedAt);
      const synth = syntheticCandles(trade, iv);
      if (!synth) return false;
      setCandles(synth);
      setIntervalUsed(iv);
      setUnit('sol');
      setPath('illustrative');
      setProblem(null);
      return true;
    };
    void (async () => {
      setLoading(true);
      setProblem(null);
      setPath('real');
      try {
        const iv = pickInterval(trade.openedAt, trade.closedAt, Date.now());
        // The FULL series: market.candles is the token page's fast answer and
        // hands back an empty pending placeholder after 1.2 s, which a
        // one-shot caller would read as "no history".
        const r = await (candleSource ?? ((i: CandleInterval, n: number) => window.krypt.market.candlesFull(trade.mint, i, n)))(iv, REPLAY_CANDLE_LIMIT);
        if (!live) return;
        if (!r.ok || !r.data) {
          if (!useSyntheticPath()) setProblem(r.message || 'No chart data came back for this token.');
          return;
        }
        const win = replayWindow(trade.openedAt, trade.closedAt);
        const inWindow = trimCandles(r.data.candles, win);
        if (inWindow.length < 3) {
          // No history survives for this window. The entry and exit prices
          // still do, so draw a path between them and say so on the frame.
          if (!useSyntheticPath()) {
            setIntervalUsed(r.data.effectiveInterval ?? r.data.interval);
            setUnit(r.data.unit);
            setProblem(
              `Only ${inWindow.length} candle${inWindow.length === 1 ? '' : 's'} exist for the window this trade lived in, ` +
                'and neither fill price is known, so there is nothing honest to animate.',
            );
            setCandles(inWindow);
          }
          return;
        }
        // USD history is scaled to SOL at the entry fill, so the running
        // PnL compares like with like (see replayPlan.anchorCandlesToEntry).
        if (r.data.unit === 'usd') {
          const a = anchorCandlesToEntry(inWindow, trade.openedAt, trade.entryPriceSol);
          setCandles(a.candles);
          setUnit(a.anchored ? 'sol' : 'usd');
          setPath(a.anchored ? 'scaled' : 'real');
        } else {
          setCandles(inWindow);
          setUnit('sol');
          setPath('real');
        }
        setIntervalUsed(r.data.effectiveInterval ?? r.data.interval);
      } catch (e) {
        if (!live) return;
        if (!useSyntheticPath()) setProblem(`Chart load failed: ${(e as Error).message}`);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [trade, given]);

  // ── Draw one frame at `progress` (0..1 over the candles, then the hold) ──
  const drawFrame = useCallback(
    (progress: number, elapsedMs = 0) => {
      const canvas = canvasRef.current;
      const list = candles;
      if (!canvas || !list || list.length < 2) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { w: W, h: H } = SHAPES[shape];

      const shown = revealCount(progress, list.length);
      const visible = list.slice(0, shown);
      const last = visible[visible.length - 1];
      // The scale is fixed on the WHOLE window, so the chart does not jump
      // around under the candles as they arrive.
      const { min, max } = priceRange(list);
      const openSec = Math.floor(trade.openedAt / 1000);
      const closeSec = Math.floor(trade.closedAt / 1000);

      // Positions and font sizes come from the layout, which a test holds
      // apart — nothing here is a hand-picked fraction of the frame.
      const L = replayLayout(W, H);
      const padX = L.padX;
      const chartTop = L.chartTop;
      const chartBottom = L.chartBottom;
      const chartH = chartBottom - chartTop;
      const chartW = W - padX * 2;
      const xFor = (i: number): number => padX + (chartW * (i + 0.5)) / list.length;
      const yFor = (p: number): number => chartBottom - ((p - min) / (max - min)) * chartH;

      // Background: the gradient, then the chosen GIF over it. Drawing the
      // <img> every frame is what makes the background ANIMATE in the
      // exported video — the browser advances the GIF, we just keep copying
      // whatever frame it is showing.
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#06070F');
      bg.addColorStop(1, '#12172B');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // The animated background, at the frame this moment of the replay
      // lands on. Because the canvas is what gets recorded, the exported
      // video animates too.
      const bgSource = bgAnim ? frameAt(bgAnim, elapsedMs) : bgImage;
      const bgW = bgAnim ? bgAnim.width : bgImage?.width ?? 0;
      const bgH = bgAnim ? bgAnim.height : bgImage?.height ?? 0;
      if (bgSource && bgW > 0 && bgH > 0) {
        const scale = Math.max(W / bgW, H / bgH);
        const dw = bgW * scale;
        const dh = bgH * scale;
        ctx.drawImage(bgSource, (W - dw) / 2, (H - dh) / 2, dw, dh);
        // A scrim heavy enough that white text survives any GIF.
        const scrim = ctx.createLinearGradient(0, 0, W, H);
        scrim.addColorStop(0, 'rgba(4,4,10,0.84)');
        scrim.addColorStop(0.6, 'rgba(4,4,10,0.66)');
        scrim.addColorStop(1, 'rgba(4,4,10,0.5)');
        ctx.fillStyle = scrim;
        ctx.fillRect(0, 0, W, H);
      }

      // Grid
      ctx.strokeStyle = 'rgba(240,237,226,0.06)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = chartTop + (chartH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(W - padX, y);
        ctx.stroke();
      }

      // Entry line, once the replay has reached it
      const reachedEntry = last.time >= openSec;
      if (reachedEntry && trade.entryPriceSol !== null) {
        const y = yFor(trade.entryPriceSol);
        ctx.strokeStyle = 'rgba(240,237,226,0.45)';
        ctx.setLineDash([8, 8]);
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(W - padX, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(240,237,226,0.75)';
        ctx.font = `600 ${L.footerSize}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.fillText(`BOUGHT ${fmtPrice(trade.entryPriceSol)}`, padX + 6, y - 10);
      }

      // Candles
      const bw = Math.max(2, Math.min(18, (chartW / list.length) * 0.68));
      visible.forEach((c, i) => {
        const x = xFor(i);
        const up = c.close >= c.open;
        ctx.strokeStyle = up ? UP : DOWN;
        ctx.fillStyle = up ? UP : DOWN;
        ctx.lineWidth = Math.max(1, bw * 0.16);
        ctx.beginPath();
        ctx.moveTo(x, yFor(c.high));
        ctx.lineTo(x, yFor(c.low));
        ctx.stroke();
        const yo = yFor(c.open);
        const yc = yFor(c.close);
        const top = Math.min(yo, yc);
        const h = Math.max(2, Math.abs(yc - yo));
        ctx.fillRect(x - bw / 2, top, bw, h);
      });

      // Entry and exit markers, dropped where they actually happened
      const markerAt = (sec: number, label: string, color: string): void => {
        let idx = -1;
        for (let i = 0; i < visible.length; i++) if (visible[i].time <= sec) idx = i;
        if (idx < 0) return;
        const x = xFor(idx);
        const y = yFor(visible[idx].close);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(5, W * 0.006), 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `700 ${L.footerSize}px "Spline Sans", system-ui, sans-serif`;
        ctx.fillText(label, x + 10, y - 12);
      };
      if (reachedEntry) markerAt(openSec, 'IN', INK);
      const reachedExit = last.time >= closeSec;
      if (reachedExit) markerAt(closeSec, 'OUT', ACCENT());

      // ── The numbers ───────────────────────────────────────────────
      // While the trade is open the PnL follows the price. Once the replay
      // passes the exit it locks to the REALISED figure from the fills,
      // which is the only number that was ever real.
      const live = runningPnl(last.close, trade.entryPriceSol, trade.costSol);
      const showRealised = reachedExit || live === null;
      const pct = showRealised ? trade.pnlPct : live.pct;
      const sol = showRealised ? trade.pnlSol : live.sol;
      const up = pct >= 0;
      const color = up ? UP : DOWN;

      // Every line below is placed by the layout, which a test holds apart.
      ctx.fillStyle = INK;
      ctx.font = `700 ${L.wordmarkSize}px Cinzel, Georgia, serif`;
      ctx.fillText('KRYPTO BOT', padX, L.wordmark);

      ctx.font = `700 ${L.tickerSize}px "Spline Sans", system-ui, sans-serif`;
      ctx.fillText(`$${(trade.symbol || '???').toUpperCase()}`, padX, L.ticker);

      ctx.fillStyle = color;
      ctx.font = `700 ${L.bigSize}px "Spline Sans", system-ui, sans-serif`;
      ctx.fillText(`${up ? '+' : ''}${Math.abs(pct) >= 1000 ? pct.toFixed(0) : pct.toFixed(1)}%`, padX, L.big);

      // The SOL figure and its OPEN / REALISED tag. The tag is placed from
      // the width of the figure measured IN THE FIGURE'S OWN FONT —
      // measuring it in the small font is what dropped OPEN on the number.
      const solText = `${up ? '+' : ''}${sol.toFixed(3)} ${nativeSymbol}`;
      ctx.font = `500 ${L.solSize}px "JetBrains Mono", ui-monospace, monospace`;
      const solWidth = ctx.measureText(solText).width;
      ctx.fillText(solText, padX, L.sol);
      ctx.fillStyle = 'rgba(240,237,226,0.55)';
      ctx.font = `500 ${L.tagSize}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText(showRealised ? 'REALISED' : 'OPEN', padX + solWidth + L.tagSize, L.sol);

      // Footer: the numbers that cannot be argued with. A part that is not
      // known is left out rather than printed as an empty word.
      ctx.fillStyle = 'rgba(240,237,226,0.55)';
      ctx.font = `500 ${L.footerSize}px "JetBrains Mono", ui-monospace, monospace`;
      const parts = [`in ${trade.costSol.toFixed(3)}`, `out ${trade.proceedsSol.toFixed(3)} ${nativeSymbol}`];
      if (interval) parts.push(`${interval} candles${unit === 'usd' ? ' (USD)' : ''}`);
      // The frame says what the path is. A synthetic path is never passed
      // off as history: entry and exit are the real fills, the rest is not.
      if (path === 'illustrative') parts.push('path illustrative · entry & exit real');
      else if (path === 'scaled') parts.push(`USD history scaled to ${nativeSymbol} at entry`);
      ctx.fillText(parts.join('  ·  '), padX, L.footer);

      ctx.fillStyle = ACCENT();
      ctx.font = `600 ${L.footerSize}px "Spline Sans", system-ui, sans-serif`;
      const brand = 'krypt.cc';
      ctx.fillText(brand, W - padX - ctx.measureText(brand).width, L.footer);
    },
    [candles, shape, trade, interval, unit, path, bgImage, bgAnim],
  );

  // First paint and any change to shape or data: show the finished chart, so
  // the panel is never blank before Play. With an animated background this
  // keeps ticking, so the panel previews the motion instead of a still.
  useEffect(() => {
    if (!candles || candles.length < 2) return;
    if (playing || recording) return;
    if (!bgAnim) {
      drawFrame(1);
      return;
    }
    let raf = 0;
    const started = performance.now();
    const tick = (now: number): void => {
      drawFrame(1, now - started);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [candles, drawFrame, shape, bgAnim, playing, recording]);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(false);
  }, []);

  const play = useCallback(
    (onDone?: () => void) => {
      if (!candles || candles.length < 2) return;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const runMs = (BASE_SECONDS / speed) * 1000;
      const holdMs = HOLD_SECONDS * 1000;
      startedAtRef.current = performance.now();
      setPlaying(true);
      const step = (t: number): void => {
        const elapsed = t - startedAtRef.current;
        const progress = Math.min(1, elapsed / runMs);
        drawFrame(progress, elapsed);
        if (elapsed < runMs + holdMs) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          setPlaying(false);
          onDone?.();
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [candles, drawFrame, speed],
  );

  useEffect(() => stop, [stop]);

  // ── Record the canvas straight to a file ───────────────────────────
  const record = (): void => {
    const canvas = canvasRef.current;
    if (!canvas || !candles || candles.length < 2 || recording) return;
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(60);
    } catch (e) {
      toast.error(`This build cannot record the canvas: ${(e as Error).message}. Play it and screen-record instead.`);
      return;
    }
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((m) => MediaRecorder.isTypeSupported?.(m));
    if (!mime) {
      toast.error('No video encoder is available here. Play it and screen-record instead.');
      return;
    }
    const chunks: BlobPart[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch (e) {
      toast.error(`Recorder failed to start: ${(e as Error).message}`);
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      recorderRef.current = null;
      setRecording(false);
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (!blob.size) {
        toast.error('The recording came back empty.');
        return;
      }
      const a = document.createElement('a');
      a.download = `krypt-${(trade.symbol || 'trade').toLowerCase()}-replay.webm`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.success('Replay saved as WebM — drop it straight into any editor');
    };
    setRecording(true);
    rec.start();
    play(() => {
      // A beat after the last frame so the result is not clipped.
      setTimeout(() => {
        try {
          rec.stop();
        } catch {
          setRecording(false);
        }
      }, 250);
    });
  };

  const { w, h } = SHAPES[shape];
  const ready = !!candles && candles.length >= 3;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className={cls('plate relative w-full animate-pop-in rounded-xl p-4', shape === 'tall' ? 'max-w-md' : 'max-w-4xl')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-display text-body font-semibold uppercase tracking-heading text-krypt-muted">
            Replay · {trade.symbol || trade.mint.slice(0, 6)}
          </h3>
          <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />

          <div className="flex items-center overflow-hidden rounded-md border border-white/10">
            {(Object.keys(SHAPES) as Shape[]).map((k) => (
              <button
                key={k}
                onClick={() => setShape(k)}
                title={SHAPES[k].hint}
                className={cls(
                  'px-2.5 py-1 text-label font-semibold transition',
                  shape === k ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                )}
              >
                {SHAPES[k].label}
              </button>
            ))}
          </div>
          <div className="flex items-center overflow-hidden rounded-md border border-white/10">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={cls(
                  'px-2 py-1 text-label font-semibold transition',
                  speed === s ? 'bg-arc-gold/20 text-arc-gold' : 'text-krypt-muted hover:text-white',
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <button
            onClick={() => setGifOpen(true)}
            title="Search a GIF to play behind the chart"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
          >
            <Sparkles className="h-3.5 w-3.5" />
            GIF
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="Use your own image behind the chart"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Upload
          </button>
          {(bgImage || bgAnim) && (
            <button
              onClick={clearBackground}
              title="Back to the plain background"
              className="rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
            >
              Clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string') useBackground(reader.result);
              };
              reader.readAsDataURL(file);
            }}
          />
          <button onClick={onClose} className="ml-1 text-krypt-muted transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the candles this trade lived through…
          </div>
        ) : problem ? (
          <div className="rounded-lg border border-arc-gold/30 bg-arc-gold/10 px-4 py-3 text-note leading-relaxed text-arc-gold">
            {problem}
          </div>
        ) : (
          <canvas ref={canvasRef} width={w} height={h} className="w-full rounded-lg border border-white/10 bg-black" />
        )}

        {!loading && !problem && path === 'illustrative' && (
          <div className="mt-2 rounded-lg border border-arc-gold/30 bg-arc-gold/10 px-4 py-2 text-body leading-relaxed text-arc-gold">
            No candle history survives for this token, so the price path is drawn, not fetched: a seeded random walk that
            starts at your real entry price and ends at your real exit price. The entry, exit and PnL are the actual
            fills; the shape in between is illustrative, and the frame says so.
          </div>
        )}
        {!loading && !problem && path === 'scaled' && (
          <div className="mt-2 text-label leading-relaxed text-krypt-muted/60">
            The provider&rsquo;s history is in USD; it is scaled to {nativeSymbol} at your entry fill so the running PnL compares
            like with like. The realised figure at the end is from the fills themselves.
          </div>
        )}

        {gifOpen && <GifPicker onClose={() => setGifOpen(false)} onPick={useBackground} />}

        {ready && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => (playing ? stop() : play())}
              disabled={recording}
              className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {playing ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {playing ? 'Stop' : 'Play'}
            </button>
            <button
              onClick={record}
              disabled={recording || playing}
              className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
            >
              {recording ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
              {recording ? 'Recording…' : 'Save video'}
            </button>
            <span className="text-body leading-relaxed text-krypt-muted">
              {recording
                ? 'Recording the animation — it saves when the replay ends.'
                : 'Saves a WebM at the chosen shape.'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
