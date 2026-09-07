// Encode the card as an ANIMATED GIF, over the background's own frames.
//
// "Copy image" put a PNG on the clipboard, and a PNG is a still: with a GIF
// behind the card the copied thing did not move (2026-09-06). No clipboard
// carries an animated image as an image — Chromium's accepts image/png,
// Electron's takes a bitmap — so the animation has to travel as a FILE. This
// module makes that file: the card is drawn once per background frame, at
// the moment that frame is showing, and each drawing becomes a GIF frame
// with that frame's own delay. One loop of the background, looping forever.
//
// Bounded on purpose: frames are subsampled past MAX_FRAMES (their delays
// summed so timing survives) and the output is scaled down, because a
// 1200-pixel-wide, 150-frame, 256-colour GIF is tens of megabytes that no
// chat app accepts.

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { GifAnimation } from './gifFrames';

/** Output frames at most; a background with more is subsampled. */
export const MAX_FRAMES = 60;
/** Output width at most; the card is scaled down to fit. */
export const MAX_WIDTH = 800;
/** GIF timing is in centiseconds; below ~2 cs browsers clamp to 10 cs. */
const MIN_DELAY_MS = 20;

export interface GifExportPlan {
  /** Source frame index per output frame. */
  picks: number[];
  /** Delay per output frame, ms — the picked frame's delay plus every
   *  skipped frame's, so the loop keeps its length. */
  delays: number[];
  /** Elapsed ms at which each picked frame starts showing. */
  elapsed: number[];
  width: number;
  height: number;
}

/** Which frames to render and at what size. Pure, so a test can pin it. */
export function planGifExport(anim: Pick<GifAnimation, 'delays'>, cardW: number, cardH: number): GifExportPlan {
  const n = anim.delays.length;
  const step = Math.max(1, Math.ceil(n / MAX_FRAMES));
  const picks: number[] = [];
  const delays: number[] = [];
  const elapsed: number[] = [];
  let t = 0;
  for (let i = 0; i < n; i += step) {
    let d = 0;
    for (let k = i; k < Math.min(n, i + step); k++) d += anim.delays[k];
    picks.push(i);
    delays.push(Math.max(MIN_DELAY_MS, d));
    elapsed.push(t);
    t += d;
  }
  const scale = Math.min(1, MAX_WIDTH / Math.max(1, cardW));
  return { picks, delays, elapsed, width: Math.max(1, Math.round(cardW * scale)), height: Math.max(1, Math.round(cardH * scale)) };
}

/**
 * Render every planned frame through `render(elapsedMs)` — which must draw
 * the card for that moment and return the canvas — and encode the result.
 * `onProgress` gets 0..1 so a button can say how far along it is; the work
 * yields to the event loop between frames so the window stays responsive.
 */
export async function encodeCardGif(
  anim: GifAnimation,
  cardW: number,
  cardH: number,
  render: (elapsedMs: number) => HTMLCanvasElement | null,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const plan = planGifExport(anim, cardW, cardH);
  const scratch = document.createElement('canvas');
  scratch.width = plan.width;
  scratch.height = plan.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('no 2d context for the export');
  const gif = GIFEncoder();
  for (let i = 0; i < plan.picks.length; i++) {
    const source = render(plan.elapsed[i]);
    if (!source) throw new Error('the card could not be drawn');
    sctx.drawImage(source, 0, 0, plan.width, plan.height);
    const { data } = sctx.getImageData(0, 0, plan.width, plan.height);
    // A palette per frame: a GIF background changes colour from frame to
    // frame, and one global palette would band the one that differs most.
    const palette = quantize(data, 256, { format: 'rgb444' });
    const index = applyPalette(data, palette, 'rgb444');
    gif.writeFrame(index, plan.width, plan.height, { palette, delay: plan.delays[i], repeat: i === 0 ? 0 : undefined });
    onProgress?.((i + 1) / plan.picks.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return gif.bytes();
}
