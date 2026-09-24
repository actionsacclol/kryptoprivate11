// A video the user picked, playing behind a share card or a trade replay.
//
// Unlike a GIF, a video is NOT decoded into frames (see gifFrames.ts). A
// playing <video> element is already a valid CanvasImageSource, so the draw
// loop copies whatever frame it is showing — exactly the trick the GIF path
// uses, minus the decoding. That is also what makes the exported recording
// move: the canvas is what gets recorded, and the canvas is drawing the
// video.
//
// ── Why the audio goes through Web Audio ──────────────────────────────
//
// The card wants a SILENT preview and a file WITH sound. The obvious way —
// set `el.muted` and capture the element — rests on whether a muted element
// still yields audio through captureStream(), which is not something to bet
// a feature on: if it does not, every exported card is silently soundless and
// nothing says so.
//
// So the routing is explicit instead. `createMediaElementSource` takes the
// element's audio out of the normal output path entirely and hands it to a
// graph we control:
//
//     source ──► MediaStreamDestination   (always — this is what is recorded)
//            └─► ctx.destination          (only while the preview is audible)
//
// The recording tap is unconditional, so the file has sound whatever the
// preview is doing, and "muted" is simply the speaker branch being
// disconnected. There is no flag whose meaning has to be guessed.

/** Big enough for any sensible clip, small enough that a mistaken pick of a
 *  two-hour film is refused rather than swallowing a gigabyte of memory. */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** A background longer than this still loads — it simply loops, and an export
 *  records only this much. A share card is not a film. */
export const VIDEO_MAX_EXPORT_MS = 30_000;

export interface VideoBackground {
  /** The element the draw loop copies from. Playing and looping while the
   *  card is open. */
  el: HTMLVideoElement;
  width: number;
  height: number;
  durationMs: number;
  /** Whether the file actually carries sound. A silent clip is common, and
   *  promising audio that is not there would be a small lie on the button. */
  hasAudio: boolean;
  /** The audio to record, or null when there is none to record. */
  stream: MediaStream | null;
  /** Speakers on or off. Never touches what gets recorded. */
  setAudible: (on: boolean) => void;
  /** Release the graph, the element and the object URL. */
  close: () => void;
}

export type VideoLoad = { ok: true; video: VideoBackground } | { ok: false; reason: string };

/** Whether a picked file is something this module can take. */
export function isVideoFile(file: { type: string }): boolean {
  return file.type.startsWith('video/');
}

/**
 * Whether this build can record at all. Checked before offering the button
 * rather than after the user presses it.
 */
export function canRecordVideo(): boolean {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/** Does this file have an audio track at all? Asked of the element's own
 *  capture, which reports the media's tracks — not of the graph, which always
 *  has one whether or not anything is coming down it. */
function detectAudio(el: HTMLVideoElement): boolean {
  const withCapture = el as HTMLVideoElement & { captureStream?: () => MediaStream };
  if (typeof withCapture.captureStream !== 'function') return false;
  try {
    const probe = withCapture.captureStream();
    const has = probe.getAudioTracks().length > 0;
    for (const t of probe.getTracks()) t.stop();
    return has;
  } catch {
    return false;
  }
}

interface AudioGraph {
  stream: MediaStream;
  setAudible: (on: boolean) => void;
  close: () => void;
}

/** The graph above, or null when this build has no Web Audio. */
function buildAudioGraph(el: HTMLVideoElement): AudioGraph | null {
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext === 'function'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    const source = ctx.createMediaElementSource(el);
    const dest = ctx.createMediaStreamDestination();
    // Unconditional: the export's sound does not depend on the preview.
    source.connect(dest);
    let audible = false;
    // A context created outside a gesture starts suspended; the pick that got
    // us here IS a gesture, so this resolves immediately in practice.
    void ctx.resume().catch(() => {
      /* a context that will not resume still feeds the recording tap */
    });
    return {
      stream: dest.stream,
      setAudible: (on: boolean) => {
        if (on === audible) return;
        audible = on;
        try {
          if (on) source.connect(ctx.destination);
          else source.disconnect(ctx.destination);
        } catch {
          /* disconnecting something already disconnected is not an error
             worth surfacing on a decoration */
        }
      },
      close: () => {
        try {
          source.disconnect();
        } catch {
          /* already torn down */
        }
        void ctx.close().catch(() => {
          /* nothing to do about a context that will not close */
        });
      },
    };
  } catch {
    // createMediaElementSource throws if the element already has a source
    // node, and on a cross-origin element. Neither can happen here — the
    // element is ours and the URL is a blob — but a failure must not cost
    // the background.
    return null;
  }
}

/**
 * Load a video from an object URL and get it playing.
 *
 * Resolves only once the element has real dimensions, because a zero-sized
 * source would be drawn as nothing and look like a failure that never
 * reported itself.
 */
export function loadVideoBackground(objectUrl: string): Promise<VideoLoad> {
  return new Promise<VideoLoad>((resolve) => {
    const el = document.createElement('video');
    el.src = objectUrl;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'auto';
    // Chromium will not autoplay a video with sound without a gesture, and
    // once the graph below exists the element's own output is routed away
    // anyway — `muted` here is only what makes play() certain to start.
    el.muted = true;

    let settled = false;
    const done = (r: VideoLoad): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const fail = (reason: string): void => {
      try {
        el.removeAttribute('src');
        el.load();
      } catch {
        /* nothing to unwind */
      }
      done({ ok: false, reason });
    };

    el.onerror = () => fail('that video could not be read');

    el.onloadeddata = () => {
      const width = el.videoWidth;
      const height = el.videoHeight;
      if (!width || !height) {
        fail('that file has no picture in it');
        return;
      }
      // Ask about the audio BEFORE the graph takes the element's output over:
      // afterwards the element has no output of its own left to report on.
      const hasAudio = detectAudio(el);
      const graph = hasAudio ? buildAudioGraph(el) : null;
      void el
        .play()
        .then(() => {
          // `muted` attenuates the element's source node as well as its
          // speakers in Chromium, so leaving it set would silence the
          // RECORDING too — the exact failure this module is built to avoid.
          // It is safe to drop now: the graph owns the output, so the only
          // way to the speakers is the branch setAudible() controls, and
          // playback has already started so no autoplay rule is re-applied.
          if (graph) el.muted = false;
        })
        .catch(() => {
          /* a background that will not autoplay still draws its first frame,
             and stays muted so a later play() is still allowed */
        });
      done({
        ok: true,
        video: {
          el,
          width,
          height,
          durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0,
          hasAudio,
          stream: graph ? graph.stream : null,
          setAudible: (on: boolean) => graph?.setAudible(on),
          close: () => {
            graph?.close();
            try {
              el.pause();
              el.removeAttribute('src');
              el.load();
            } catch {
              /* already gone */
            }
            try {
              URL.revokeObjectURL(objectUrl);
            } catch {
              /* not an object URL, or already revoked */
            }
          },
        },
      });
    };

    // A file that never fires either event — a container the build cannot
    // demux — must not leave the card waiting forever.
    window.setTimeout(() => fail('that video took too long to open — try an MP4 (H.264)'), 20_000);
  });
}

/**
 * How long an export should run for this background: one whole pass, bounded.
 *
 * A looping clip is recorded once rather than twice (the GIF path doubles a
 * short loop) because with sound a second pass is a repeat the viewer hears.
 */
export function exportMsFor(video: { durationMs: number }): number {
  const once = video.durationMs > 0 ? video.durationMs : 6_000;
  return Math.min(VIDEO_MAX_EXPORT_MS, Math.max(2_000, Math.round(once)));
}
