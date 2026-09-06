// Decode an animated GIF into frames we can draw ourselves.
//
// The first attempt leaned on the browser: put the GIF in an <img>, park the
// element off-screen, and copy whatever frame it happened to be showing.
// Chromium does not guarantee it animates an image that is not actually
// painted, so the card previewed a still and the replay recorded a still
// background — the whole point of the feature, missing.
//
// ImageDecoder (WebCodecs) hands us every frame and its duration, so the
// animation is ours to run: deterministic, independent of whether anything
// is on screen, and the same frame the canvas draws is the frame that gets
// recorded. Where the API is missing the caller falls back to a single
// still, which is what it had before.
//
// The bytes are parsed out of the data: URL by hand rather than with
// fetch(). This app's CSP is `connect-src 'self'`, and a fetch of a data:
// URL is a connect — so it was refused, the decode threw, and every caller
// quietly fell back to a still. Decoding the base64 ourselves touches no
// network policy at all. Failures now come back with a REASON so the UI can
// say why it is showing a still instead of pretending it meant to.

/** One decoded frame, ready for drawImage. */
export interface GifAnimation {
  frames: CanvasImageSource[];
  /** Milliseconds each frame is shown; same length as `frames`. */
  delays: number[];
  width: number;
  height: number;
  /** Total loop length in milliseconds. */
  durationMs: number;
  /** Release the decoded frames. Call when the animation is no longer used. */
  close: () => void;
}

/** A GIF longer than this is trimmed: past a few seconds of loop it is
 *  memory for no visible gain behind a chart. */
const MAX_FRAMES = 150;
/** Frames with a nonsense duration get the browser's own default. */
const DEFAULT_DELAY_MS = 100;

interface DecoderLike {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount?: number } };
  decode(opts: { frameIndex: number }): Promise<{ image: CanvasImageSource & { duration?: number | null; close?: () => void } }>;
  close?: () => void;
}

export function canDecodeAnimation(): boolean {
  return typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function';
}

/** Either the animation, or why there isn't one. */
export type DecodeResult = { ok: true; anim: GifAnimation } | { ok: false; reason: string };

/**
 * The bytes inside a base64 data: URL. Done by hand because fetch() on a
 * data: URL is blocked by this app's connect-src policy.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  if (!meta.includes(';base64')) return null; // only base64 payloads are used here
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** The media type of a data: URL, or null. */
export function dataUrlType(dataUrl: string): string | null {
  const semi = dataUrl.indexOf(';');
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const end = semi >= 0 && semi < comma ? semi : comma;
  const type = dataUrl.slice(5, end);
  return type || null;
}

/**
 * Decode a data: URL into frames. Returns null when the format is not
 * animatable, the API is missing, or anything at all goes wrong — the caller
 * then draws the image as a still rather than showing nothing.
 */
export async function decodeAnimation(dataUrl: string): Promise<DecodeResult> {
  if (!canDecodeAnimation()) return { ok: false, reason: 'this build has no image decoder' };
  const type = dataUrlType(dataUrl);
  if (!type || !type.startsWith('image/')) return { ok: false, reason: 'not an image' };
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes) return { ok: false, reason: 'the image data could not be read' };

  try {
    const Ctor = (globalThis as unknown as { ImageDecoder: new (init: { data: BufferSource; type: string }) => DecoderLike }).ImageDecoder;
    const decoder = new Ctor({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type });
    await decoder.tracks.ready;
    const total = decoder.tracks.selectedTrack?.frameCount ?? 1;
    const count = Math.max(1, Math.min(MAX_FRAMES, total));
    if (total < 2) {
      decoder.close?.();
      return { ok: false, reason: 'that image has a single frame' };
    }

    const frames: CanvasImageSource[] = [];
    const delays: number[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      frames.push(image);
      // duration is microseconds, and is null on some encoders.
      const us = typeof image.duration === 'number' && image.duration > 0 ? image.duration : null;
      delays.push(us === null ? DEFAULT_DELAY_MS : Math.max(20, Math.round(us / 1000)));
    }
    decoder.close?.();

    const first = frames[0] as { displayWidth?: number; codedWidth?: number; width?: number; displayHeight?: number; codedHeight?: number; height?: number };
    const width = first.displayWidth ?? first.codedWidth ?? first.width ?? 0;
    const height = first.displayHeight ?? first.codedHeight ?? first.height ?? 0;
    if (!width || !height) {
      for (const f of frames) (f as { close?: () => void }).close?.();
      return { ok: false, reason: 'the frames had no size' };
    }

    return {
      ok: true,
      anim: {
        frames,
        delays,
        width,
        height,
        durationMs: delays.reduce((a, d) => a + d, 0),
        close: () => {
          for (const f of frames) (f as { close?: () => void }).close?.();
        },
      },
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || 'the decoder refused it' };
  }
}

/** Which frame is showing `elapsedMs` into the loop. */
export function frameAt(anim: GifAnimation, elapsedMs: number): CanvasImageSource {
  if (anim.frames.length === 1 || anim.durationMs <= 0) return anim.frames[0];
  let t = elapsedMs % anim.durationMs;
  for (let i = 0; i < anim.frames.length; i++) {
    t -= anim.delays[i];
    if (t < 0) return anim.frames[i];
  }
  return anim.frames[anim.frames.length - 1];
}
