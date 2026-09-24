import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Image as ImageIcon, Loader2, Sparkles, Video, Volume2, VolumeX, X } from 'lucide-react';
import type { ClosedTrade, Position } from '@shared/portfolio';
import { cls, fmtUsd } from '../../utils/format';
import { CARD_H, CARD_PAD, CARD_W, cardLayout } from './cardLayout';
import { GifPicker } from './GifPicker';
import { dataUrlType, decodeAnimation, frameAt, type GifAnimation } from './gifFrames';
import { encodeCardGif } from './gifExport';
import {
  exportMsFor,
  isVideoFile,
  loadVideoBackground,
  VIDEO_MAX_BYTES,
  type VideoBackground,
} from './videoBackground';
import { bestMime, recordCanvas } from './cardRecord';
import { useToast } from '../../state/ToastProvider';

// PnL cards (term.txt §15).
//
// Drawn on a <canvas> rather than composed in DOM and screenshotted, for two
// reasons: the output is a real PNG the user can paste anywhere, and it
// works with no network and no external rendering service — nothing about
// the position leaves the machine unless the user pastes it somewhere.
//
// The numbers on the card are the same ones the portfolio computed, and a
// card can only be made for a position whose cost basis is known. A share
// card is the most public artefact this app produces; putting a made-up
// multiple on one would be the worst possible place to be wrong.

type Style = 'dark' | 'gold' | 'crimson';

const STYLES: Record<Style, { bg: string; bg2: string; accent: string; label: string }> = {
  dark: { bg: '#06070F', bg2: '#12172B', accent: '#8B7CE8', label: 'Void' },
  gold: { bg: '#0A0806', bg2: '#241B08', accent: '#D9B45B', label: 'Gold' },
  crimson: { bg: '#0B0407', bg2: '#2A0A10', accent: '#E5484D', label: 'Crimson' },
};

const W = CARD_W;
const H = CARD_H; // 16:9, the shape every social preview crops to
const PAD = CARD_PAD;

/** Where a chosen background lives between openings of the card. Kept small
 *  enough not to threaten the storage quota; a bigger image simply is not
 *  remembered, rather than breaking the card. */
const BG_KEY = 'krypt.cardBackground';
const BG_MAX_BYTES = 1_500_000;

/** Set when the remembered background is a VIDEO, which lives on disk rather
 *  than in storage (an mp4 is tens of megabytes). The flag is here so the
 *  card knows to ask main for it instead of reading BG_KEY. */
const BG_VIDEO_KEY = 'krypt.cardBackgroundIsVideo';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * What the card is about. An OPEN position shows an unrealized number and
 * says so; a CLOSED round trip shows what was actually paid and actually
 * received. The distinction is on the card itself, because a share card is
 * the most public thing this app produces and "up 400 %" on a bag someone
 * still holds is the oldest lie in the genre.
 */
export type CardSubject = { kind: 'position'; position: Position } | { kind: 'trade'; trade: ClosedTrade };

interface CardView {
  symbol: string;
  /** The big number. */
  pct: number;
  pnlSol: number | null;
  /** Left-hand rows, already formatted. */
  rows: Array<[string, string]>;
  /** The line that says what kind of number this is; empty for a closed
   *  trade, whose figures are its own explanation. */
  footer: string;
  fileTag: string;
}

function holdLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function viewFor(subject: CardSubject, unit: string): CardView {
  if (subject.kind === 'trade') {
    const tr = subject.trade;
    const rows: Array<[string, string]> = [
      ['In', `${tr.costSol.toFixed(3)} ${unit}`],
      ['Out', `${tr.proceedsSol.toFixed(3)} ${unit}`],
      ['Held', holdLabel(tr.holdMs)],
    ];
    return {
      symbol: tr.symbol,
      pct: tr.pnlPct,
      pnlSol: tr.pnlSol,
      rows,
      // No footer. The in / out / held rows already say this trade is over,
      // and the label was the line that collided with them.
      footer: '',
      fileTag: `${(tr.symbol || 'token').toLowerCase()}-closed`,
    };
  }
  const p = subject.position;
  const rows: Array<[string, string]> = [];
  if (p.entryMcapUsd !== null) rows.push(['Entry', `${fmtUsd(p.entryMcapUsd)} MC`]);
  if (p.marketCapUsd !== null) rows.push(['Now', `${fmtUsd(p.marketCapUsd)} MC`]);
  return {
    symbol: p.symbol,
    pct: p.unrealizedPnlPct ?? 0,
    pnlSol: p.unrealizedPnlSol,
    rows,
    footer: 'Open position · unrealized',
    fileTag: (p.symbol || 'token').toLowerCase(),
  };
}

export function PnlCard({
  subject,
  solUsd,
  unit = 'SOL',
  onClose,
}: {
  subject: CardSubject;
  /** USD per unit of the coin the figures are in. */
  solUsd: number | null;
  /** The coin the figures are in — SOL, or an EVM chain's own (2026-09-11). */
  unit?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [style, setStyle] = useState<Style>('dark');
  /** A background the user chose, as a data URL, or null for the gradient. */
  const [bg, setBg] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BG_KEY);
    } catch {
      return null; // storage can be unavailable; the card still works
    }
  });
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  /** Decoded frames, when the background is animated. */
  const [bgAnim, setBgAnim] = useState<GifAnimation | null>(null);
  const bgAnimRef = useRef<GifAnimation | null>(null);
  bgAnimRef.current = bgAnim;
  /** A video the user picked, playing behind the card. Mutually exclusive
   *  with the image and the GIF: one background at a time. */
  const [bgVideo, setBgVideo] = useState<VideoBackground | null>(null);
  const bgVideoRef = useRef<VideoBackground | null>(null);
  bgVideoRef.current = bgVideo;
  /** The preview is silent until asked. A card that starts shouting when it
   *  opens is the kind of thing people close immediately — the sound is in
   *  the export either way. */
  const [previewSound, setPreviewSound] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  /** Milliseconds into the background loop; the frame the canvas is on. */
  const clockRef = useRef(0);

  // Decode the chosen background once, not on every redraw. An animated one
  // becomes frames we run ourselves — a PNG can only ever be one of them,
  // but the preview should move, and Save video keeps the motion.
  useEffect(() => {
    if (!bg) {
      setBgImage(null);
      setBgAnim((prev) => {
        prev?.close();
        return null;
      });
      return;
    }
    let live = true;
    void decodeAnimation(bg).then((res) => {
      if (!live) {
        if (res.ok) res.anim.close();
        return;
      }
      setBgAnim((prev) => {
        prev?.close();
        return res.ok ? res.anim : null;
      });
      if (res.ok) {
        setBgImage(null);
        return;
      }
      if (dataUrlType(bg) === 'image/gif') toast.warn(`Using a still frame — ${res.reason}.`);
      const img = new Image();
      img.onload = () => {
        if (live) setBgImage(img);
      };
      img.onerror = () => {
        if (live) {
          setBgImage(null);
          toast.error('That image could not be read');
        }
      };
      img.src = bg;
    });
    return () => {
      live = false;
    };
  }, [bg, toast]);

  useEffect(() => () => bgAnimRef.current?.close(), []);
  useEffect(() => () => bgVideoRef.current?.close(), []);

  // The speaker branch of the audio graph, and only that. The recording tap
  // is wired separately and unconditionally, so a quiet preview never means a
  // silent file. See videoBackground.ts.
  useEffect(() => {
    bgVideo?.setAudible(previewSound);
  }, [bgVideo, previewSound]);

  /** Put a loaded video in place of whatever background was there. */
  const useVideo = useCallback((video: VideoBackground | null): void => {
    setBgVideo((prev) => {
      prev?.close();
      return video;
    });
    if (video) {
      setBgImage(null);
      setBgAnim((prev) => {
        prev?.close();
        return null;
      });
      setBg(null);
    }
  }, []);

  // The remembered video background, fetched from main on open. An image
  // background comes from localStorage above; a video is too big for that,
  // so it lives on disk and arrives as bytes.
  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(BG_VIDEO_KEY) === '1';
    } catch {
      stored = false;
    }
    if (!stored) return;
    let live = true;
    setLoadingVideo(true);
    void window.krypt.card
      .loadBackground()
      .then(async (r) => {
        if (!live || !r.ok || !r.data) return;
        // Copied into a buffer of its own: the bytes arrive as a view over
        // the IPC message, and Blob wants an ArrayBuffer it can keep.
        const copy = new Uint8Array(r.data.bytes.byteLength);
        copy.set(r.data.bytes);
        const url = URL.createObjectURL(new Blob([copy.buffer], { type: r.data.type }));
        const res = await loadVideoBackground(url);
        if (!live) {
          if (res.ok) res.video.close();
          else URL.revokeObjectURL(url);
          return;
        }
        if (res.ok) useVideo(res.video);
        else URL.revokeObjectURL(url);
      })
      .finally(() => {
        if (live) setLoadingVideo(false);
      });
    return () => {
      live = false;
    };
  }, [useVideo]);

  /** A video the user dropped or chose: played from an object URL, and kept
   *  on disk so it is still here next time. */
  const pickVideoBackground = async (file: File): Promise<void> => {
    if (file.size > VIDEO_MAX_BYTES) {
      toast.error(`That video is ${(file.size / 1e6).toFixed(0)} MB — the limit is ${VIDEO_MAX_BYTES / 1e6} MB`);
      return;
    }
    setLoadingVideo(true);
    const url = URL.createObjectURL(file);
    try {
      const res = await loadVideoBackground(url);
      if (!res.ok) {
        URL.revokeObjectURL(url);
        toast.error(`Could not use that video — ${res.reason}`);
        return;
      }
      useVideo(res.video);
      if (!res.video.hasAudio) toast.info('That clip has no sound — the card will be silent');
      // Remember it. A failure here costs the memory, not the background.
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await window.krypt.card.saveBackground(bytes, file.type);
        localStorage.setItem(BG_VIDEO_KEY, saved.ok ? '1' : '0');
        localStorage.removeItem(BG_KEY);
        if (!saved.ok) toast.warn(`Using it now, but it will not be remembered: ${saved.message}`);
      } catch {
        /* storage or disk unavailable — the background still applies now */
      }
    } finally {
      setLoadingVideo(false);
    }
  };

  const pickBackground = (file: File | null | undefined): void => {
    if (!file) return;
    if (isVideoFile(file)) {
      void pickVideoBackground(file);
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error('Pick an image or a video file');
      return;
    }
    useVideo(null);
    try {
      localStorage.removeItem(BG_VIDEO_KEY);
      void window.krypt.card.clearBackground();
    } catch {
      /* nothing to clean up */
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : null;
      if (!url) return;
      setBg(url);
      // Remember it for next time when it is small enough to be polite about
      // the storage quota; a large one is used now and simply not stored.
      try {
        if (url.length <= BG_MAX_BYTES) localStorage.setItem(BG_KEY, url);
        else localStorage.removeItem(BG_KEY);
      } catch {
        /* storage unavailable — the background still applies this session */
      }
    };
    reader.onerror = () => toast.error('That image could not be read');
    reader.readAsDataURL(file);
  };

  const clearBackground = (): void => {
    setBg(null);
    setBgImage(null);
    useVideo(null);
    setPreviewSound(false);
    try {
      localStorage.removeItem(BG_KEY);
      localStorage.removeItem(BG_VIDEO_KEY);
    } catch {
      /* nothing to clean up */
    }
    void window.krypt.card.clearBackground();
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = STYLES[style];
    const view = viewFor(subject, unit);
    const pct = view.pct;
    const up = pct >= 0;
    const pnlColor = up ? '#34d399' : '#f43f5e';

    // Background: the user's image if they chose one, else the gradient.
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, s.bg);
    grad.addColorStop(1, s.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // A playing <video> is already a CanvasImageSource, so it needs no
    // decoding the way a GIF does — copying it every frame is what makes both
    // the preview and the recording move.
    const bgSource: CanvasImageSource | null = bgVideo
      ? bgVideo.el
      : bgAnim
        ? frameAt(bgAnim, clockRef.current)
        : bgImage;
    const bgW = bgVideo ? bgVideo.width : bgAnim ? bgAnim.width : bgImage?.width ?? 0;
    const bgH = bgVideo ? bgVideo.height : bgAnim ? bgAnim.height : bgImage?.height ?? 0;
    if (bgSource && bgW > 0 && bgH > 0) {
      // Cover: fill the frame, crop the overflow, never squash the picture.
      const scale = Math.max(W / bgW, H / bgH);
      const dw = bgW * scale;
      const dh = bgH * scale;
      ctx.drawImage(bgSource, (W - dw) / 2, (H - dh) / 2, dw, dh);
      // A scrim, so white text stays readable on a bright photo. Heavier on
      // the left, where every line of text is.
      const scrim = ctx.createLinearGradient(0, 0, W, 0);
      scrim.addColorStop(0, 'rgba(4,4,10,0.86)');
      scrim.addColorStop(0.55, 'rgba(4,4,10,0.62)');
      scrim.addColorStop(1, 'rgba(4,4,10,0.34)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, W, H);
      const foot = ctx.createLinearGradient(0, H - 200, 0, H);
      foot.addColorStop(0, 'transparent');
      foot.addColorStop(1, 'rgba(4,4,10,0.55)');
      ctx.fillStyle = foot;
      ctx.fillRect(0, H - 200, W, 200);
    } else {
      // Corner glow in the accent
      const glow = ctx.createRadialGradient(W * 0.5, -80, 0, W * 0.5, -80, 700);
      glow.addColorStop(0, `${s.accent}33`);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }

    // Plate
    ctx.strokeStyle = bgSource ? 'rgba(240,237,226,0.22)' : 'rgba(240,237,226,0.10)';
    ctx.lineWidth = 2;
    roundRect(ctx, 48, 48, W - 96, H - 96, 18);
    ctx.stroke();

    // Every line below is placed by the layout, which a test holds apart.
    const L = cardLayout(view.rows.length, view.pnlSol !== null);
    // On a photo the text carries its own shadow so it never sits on an
    // accidental highlight.
    if (bgSource) {
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 2;
    }

    // Wordmark
    ctx.fillStyle = '#F0EDE2';
    ctx.font = '700 30px Cinzel, Georgia, serif';
    ctx.fillText('KRYPTO', PAD, 116);
    ctx.fillStyle = s.accent;
    ctx.font = '600 17px Cinzel, Georgia, serif';
    ctx.fillText('B O T', PAD, 142);

    // Ticker
    ctx.fillStyle = '#F0EDE2';
    ctx.font = '700 84px "Spline Sans", system-ui, sans-serif';
    ctx.fillText(`$${(view.symbol || '???').toUpperCase()}`, PAD, L.ticker);

    // The number
    ctx.fillStyle = pnlColor;
    ctx.font = '700 152px "Spline Sans", system-ui, sans-serif';
    const pctText = `${up ? '+' : ''}${Math.abs(pct) >= 1000 ? pct.toFixed(0) : pct.toFixed(1)}%`;
    ctx.fillText(pctText, PAD, L.big);

    // The supporting rows
    ctx.font = '500 26px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(240,237,226,0.55)';
    view.rows.forEach(([label, value], i) => {
      ctx.fillText(`${label.padEnd(9, ' ')} ${value}`, PAD, L.rows[i]);
    });
    if (view.pnlSol !== null && L.pnl !== null) {
      ctx.fillStyle = pnlColor;
      const sign = view.pnlSol >= 0 ? '+' : '';
      const usd = solUsd !== null ? `  (${sign}${fmtUsd(view.pnlSol * solUsd)})` : '';
      const word = subject.kind === 'trade' ? 'Realised ' : 'Unrealized';
      ctx.fillText(`${word} ${sign}${view.pnlSol.toFixed(3)} ${unit}${usd}`, PAD, L.pnl);
    }

    // Footer — kept ONLY for an open position, because an unrealized number
    // is not a result and a card that implies it is would be the exact thing
    // this product exists not to do. A closed trade needs no such warning:
    // its in and out are the whole story.
    if (view.footer) {
      ctx.fillStyle = 'rgba(240,237,226,0.45)';
      ctx.font = '500 22px "Spline Sans", system-ui, sans-serif';
      ctx.fillText(view.footer, PAD, L.bottom);
    }

    ctx.fillStyle = s.accent;
    ctx.font = '600 26px "Spline Sans", system-ui, sans-serif';
    const brand = 'krypt.cc';
    const w = ctx.measureText(brand).width;
    ctx.fillText(brand, W - PAD - w, L.bottom);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }, [subject, style, solUsd, unit, bgImage, bgAnim, bgVideo]);

  useEffect(() => {
    // Fonts may not be ready on first paint; redraw once they are so the
    // card never ships with fallback serif metrics.
    draw();
    if (document.fonts?.ready) void document.fonts.ready.then(draw);
  }, [draw]);

  // An animated background runs in the preview, so what you see before you
  // save is what the background actually does.
  useEffect(() => {
    if (!bgAnim && !bgVideo) {
      clockRef.current = 0;
      return;
    }
    let raf = 0;
    const started = performance.now();
    const tick = (now: number): void => {
      clockRef.current = now - started;
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bgAnim, bgVideo, draw]);

  /**
   * Record the card while its background runs, for what a PNG cannot carry.
   *
   * With a VIDEO background the clip's audio rides along (the stream was
   * captured when the video loaded, so muting the preview does not silence
   * the file). With a GIF there is nothing to hear and the result is a silent
   * clip, which is what a GIF is.
   */
  const makeVideo = async (): Promise<{ bytes: Uint8Array; ext: 'mp4' | 'webm'; withAudio: boolean } | null> => {
    const canvas = canvasRef.current;
    if (!canvas || (!bgAnim && !bgVideo) || recording) return null;
    setRecording(true);
    try {
      // One whole pass of a video; two loops of a short GIF, as before.
      const durationMs = bgVideo
        ? exportMsFor(bgVideo)
        : Math.min(12_000, Math.max(2_000, (bgAnim?.durationMs ?? 3_000) * 2));
      if (bgVideo) {
        // Start the clip at the beginning so the sound does not open mid-word.
        try {
          bgVideo.el.currentTime = 0;
          await bgVideo.el.play();
        } catch {
          /* a background that will not seek still records from where it is */
        }
      }
      return await recordCanvas({
        canvas,
        fps: 30,
        durationMs,
        audioFrom: bgVideo?.stream ?? null,
        videoBitsPerSecond: 6_000_000,
      });
    } catch (err) {
      toast.error(`Could not record the card: ${(err as Error).message}`);
      return null;
    } finally {
      setRecording(false);
    }
  };

  const saveVideo = async (): Promise<void> => {
    const made = await makeVideo();
    if (!made) return;
    const r = await window.krypt.card.saveFile(`krypt-${viewFor(subject, unit).fileTag}`, made.bytes, made.ext);
    if (r.ok) toast.success(`${r.message}${made.withAudio ? ' — with sound' : ''}`);
    else if (!/cancelled/i.test(r.message)) toast.error(r.message);
  };

  const copyVideo = async (): Promise<void> => {
    const made = await makeVideo();
    if (!made) return;
    const r = await window.krypt.card.copyFile(`krypt-${viewFor(subject, unit).fileTag}`, made.bytes, made.ext);
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
  };

  const copy = async (): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('could not render');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success(bgAnim ? 'Still image copied (a copied image cannot animate — use Copy GIF for the moving one)' : 'PnL card copied — paste it anywhere');
    } catch (err) {
      toast.error(`Copy failed: ${(err as Error).message}`);
    }
  };

  // ── The animated card as a real GIF ───────────────────────────────────
  // A copied IMAGE is a bitmap on every platform, so with a GIF behind the
  // card "Copy image" gave a still (2026-09-06). The moving card is encoded
  // as an actual GIF — one frame per background frame, drawn at the moment
  // that frame shows — and travels as a file: onto the clipboard where the
  // OS carries file references, or saved.
  const [encoding, setEncoding] = useState<number | null>(null);

  const makeGif = async (): Promise<Uint8Array | null> => {
    const canvas = canvasRef.current;
    if (!canvas || !bgAnim || encoding !== null) return null;
    setEncoding(0);
    try {
      const bytes = await encodeCardGif(
        bgAnim,
        W,
        H,
        (elapsed) => {
          clockRef.current = elapsed;
          draw();
          return canvasRef.current;
        },
        (f) => setEncoding(f),
      );
      return bytes;
    } catch (err) {
      toast.error(`Could not encode the GIF: ${(err as Error).message}`);
      return null;
    } finally {
      setEncoding(null);
    }
  };

  const copyGif = async (): Promise<void> => {
    const bytes = await makeGif();
    if (!bytes) return;
    const r = await window.krypt.card.copyFile(`krypt-${viewFor(subject, unit).fileTag}`, bytes);
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
  };

  const saveGif = async (): Promise<void> => {
    const bytes = await makeGif();
    if (!bytes) return;
    const r = await window.krypt.card.saveFile(`krypt-${viewFor(subject, unit).fileTag}`, bytes);
    if (r.ok) toast.success(r.message);
    else if (!/cancelled/i.test(r.message)) toast.error(r.message);
  };

  const download = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A renderer-initiated download is allowed here (this is the app's own
    // window, not a sandboxed artifact), so an anchor is the simplest path.
    const a = document.createElement('a');
    a.download = `krypt-${viewFor(subject, unit).fileTag}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    toast.info('Saved');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div className="plate rounded-xl p-4 max-w-3xl w-full animate-pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="font-display text-body font-semibold uppercase tracking-heading text-krypt-muted">
            {subject.kind === 'trade' ? 'Trade card' : 'PnL card'}
          </h3>
          <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
          <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
            {(Object.keys(STYLES) as Style[]).map((k) => (
              <button
                key={k}
                onClick={() => setStyle(k)}
                className={cls(
                  'px-2.5 py-1 text-label font-semibold transition',
                  style === k ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                )}
              >
                {STYLES[k].label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setGifOpen(true)}
            title="Search a GIF to sit behind the card"
            className="ml-1 inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
          >
            <Sparkles className="h-3.5 w-3.5" />
            GIF
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title="Use your own image or video behind the card"
            disabled={loadingVideo}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white disabled:opacity-50"
          >
            {loadingVideo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
            {bg || bgVideo ? 'Change' : 'Upload'}
          </button>
          {/* Only offered when there is something to hear. */}
          {bgVideo?.hasAudio && (
            <button
              onClick={() => setPreviewSound((v) => !v)}
              title={previewSound ? 'Mute the preview (the saved video keeps its sound)' : 'Hear the background'}
              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
            >
              {previewSound ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              {previewSound ? 'Sound' : 'Muted'}
            </button>
          )}
          {(bg || bgVideo) && (
            <button
              onClick={clearBackground}
              title="Back to the plain card"
              className="rounded-md border border-white/10 px-2 py-1 text-label font-semibold text-krypt-muted transition hover:text-white"
            >
              Clear
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime,video/x-matroska"
            className="hidden"
            onChange={(e) => {
              pickBackground(e.target.files?.[0]);
              e.target.value = ''; // let the same file be picked again
            }}
          />
          <button onClick={onClose} className="text-krypt-muted hover:text-white transition ml-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pickBackground(e.dataTransfer.files?.[0]);
          }}
          title="Drop an image or a video here to use it as the background"
          className="w-full rounded-lg border border-white/10"
        />

        {gifOpen && (
          <GifPicker
            onClose={() => setGifOpen(false)}
            onPick={(dataUrl) => {
              // Same path as an uploaded image: bytes in hand, nothing linked.
              // One background at a time, so a video in place is dropped —
              // otherwise both would be set and the draw would keep the video
              // while the UI showed a GIF had been chosen.
              useVideo(null);
              setBg(dataUrl);
              try {
                localStorage.removeItem(BG_VIDEO_KEY);
                void window.krypt.card.clearBackground();
                if (dataUrl.length <= BG_MAX_BYTES) localStorage.setItem(BG_KEY, dataUrl);
                else localStorage.removeItem(BG_KEY);
              } catch {
                /* storage unavailable — it still applies this session */
              }
            }}
          />
        )}

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {/* A video background exports as a VIDEO, never a GIF: a GIF has no
              sound and re-encoding a clip into 150 palettised frames is a
              worse artefact than the thing the user already handed us. */}
          {bgVideo && (
            <>
              <button
                onClick={() => void copyVideo()}
                disabled={recording || !bestMime()}
                className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
              >
                {recording ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                {recording ? 'Recording…' : 'Copy video'}
              </button>
              <button
                onClick={() => void saveVideo()}
                disabled={recording || !bestMime()}
                className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
              >
                {recording ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
                Save video
              </button>
            </>
          )}
          {bgAnim && !bgVideo && (
            <>
              {/* With a moving background the GIF is the primary artefact;
                  the still copy stays available but says what it is. */}
              <button
                onClick={() => void copyGif()}
                disabled={encoding !== null}
                className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
              >
                {encoding !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                {encoding !== null ? `Encoding ${Math.round(encoding * 100)}%` : 'Copy GIF'}
              </button>
              <button
                onClick={() => void saveGif()}
                disabled={encoding !== null}
                className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Save GIF
              </button>
              <button
                onClick={() => void saveVideo()}
                disabled={recording}
                className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-50"
              >
                {recording ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
                {recording ? 'Recording…' : 'Save video'}
              </button>
            </>
          )}
          <button
            onClick={() => void copy()}
            className={cls(
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition',
              bgAnim || bgVideo
                ? 'border border-white/10 bg-white/5 text-white/90 hover:bg-white/10'
                : 'border border-krypt-purple/50 bg-krypt-gradient hover:brightness-110',
            )}
          >
            <Copy className="h-4 w-4" />
            {bgAnim || bgVideo ? 'Copy still' : 'Copy image'}
          </button>
          <button
            onClick={download}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10"
          >
            <Download className="h-4 w-4" />
            Save PNG
          </button>
          <p className="text-label text-krypt-muted/60 ml-2 leading-relaxed">
            Rendered locally.{' '}
            {subject.kind === 'position' && (
              <>
                The card is marked <span className="text-white/80">unrealized</span> because the position is still
                open.{' '}
              </>
            )}
            {bgVideo && (
              <>
                The video saves as {bestMime()?.ext === 'mp4' ? 'an MP4' : 'a WebM'}
                {bgVideo.hasAudio ? ' with the clip’s sound' : ' (the clip has no sound)'}, up to{' '}
                {Math.round(exportMsFor(bgVideo) / 1000)}s.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
