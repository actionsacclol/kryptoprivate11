// Recording a canvas to a real video file, with sound when there is sound.
//
// Both the PnL card and the trade replay used to carry their own copy of this
// (2026-09-21), and neither could record audio: they captured the canvas and
// nothing else, so a video background's soundtrack was dropped on the floor.
// One module now, so the audio path cannot be fixed in one place and stay
// broken in the other.
//
// The container is whatever the build can actually encode. MP4 is preferred
// because it is the one every phone, every chat app and X itself accept
// without a re-encode; WebM is the fallback and the caller is told which it
// got rather than the extension quietly disagreeing with the bytes.

export interface Recording {
  bytes: Uint8Array;
  /** 'mp4' or 'webm' — the real container, for the filename and the message. */
  ext: 'mp4' | 'webm';
  /** Whether sound made it in. False when the source was silent, or when this
   *  build could not capture the element. */
  withAudio: boolean;
}

/** Candidates in preference order. The first the build supports wins. */
const MIME_CANDIDATES: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4;codecs=h264,aac', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp9', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

/** The best container this build can write, or null when it can write none. */
export function bestMime(): { mime: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder !== 'function') return null;
  const supported = MediaRecorder.isTypeSupported;
  if (typeof supported !== 'function') return null;
  return MIME_CANDIDATES.find((c) => supported.call(MediaRecorder, c.mime)) ?? null;
}

export interface RecordOptions {
  canvas: HTMLCanvasElement;
  /** Frames per second to capture the canvas at. */
  fps: number;
  /**
   * How long to record, in milliseconds.
   *
   * With `onStart` this is a CEILING rather than the length: a replay ends
   * when the playback ends, and the ceiling is only there so a run that never
   * finishes cannot record forever.
   */
  durationMs: number;
  /** Where the sound comes from, when there is any: the captured stream of
   *  the background video. Its audio tracks are added to the recording. */
  audioFrom?: MediaStream | null;
  videoBitsPerSecond?: number;
  /**
   * Called once recording has actually begun, for a caller that needs to
   * start its own animation from zero at that exact moment. It is handed a
   * `stop` it may call when its own run is over; otherwise `durationMs`
   * ends the recording.
   */
  onStart?: (stop: () => void) => void;
}

/**
 * Record the canvas for a fixed span and hand back the bytes.
 *
 * Rejects rather than resolving empty: a zero-byte file that reports success
 * is the failure the user discovers later, in the chat they pasted it into.
 */
export async function recordCanvas(opts: RecordOptions): Promise<Recording> {
  const picked = bestMime();
  if (!picked) throw new Error('this build has no video encoder');

  let canvasStream: MediaStream;
  try {
    canvasStream = opts.canvas.captureStream(opts.fps);
  } catch (e) {
    throw new Error(`the canvas could not be captured: ${(e as Error).message}`);
  }

  // The audio rides along as an extra track on the same stream. Copied, not
  // moved: the background keeps playing in the preview while this records.
  const audioTracks = opts.audioFrom ? opts.audioFrom.getAudioTracks() : [];
  const tracks = [...canvasStream.getVideoTracks(), ...audioTracks];
  const stream = new MediaStream(tracks);

  const rec = new MediaRecorder(stream, {
    mimeType: picked.mime,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 6_000_000,
  });

  const chunks: BlobPart[] = [];
  // try/finally, not a line after the await: a recording that fails still has
  // to give the canvas track back, or every failed attempt leaks one.
  try {
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      let timer = 0;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('the recorder stopped with an error'));
      };
      rec.onstop = () => {
        window.clearTimeout(timer);
        const blob = new Blob(chunks, { type: picked.mime });
        if (!blob.size) {
          reject(new Error('the recording came back empty'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch((e: Error) => reject(new Error(`the recording could not be read: ${e.message}`)));
      };
      try {
        rec.start();
      } catch (e) {
        reject(new Error(`recording could not start: ${(e as Error).message}`));
        return;
      }
      // Idempotent: the caller's stop and the ceiling can both fire, and the
      // second one must not throw an InvalidState at the recorder.
      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(timer);
        try {
          rec.stop();
        } catch (e) {
          reject(new Error(`the recorder would not stop: ${(e as Error).message}`));
        }
      };
      opts.onStart?.(stop);
      timer = window.setTimeout(stop, opts.durationMs);
    });
    return { bytes, ext: picked.ext, withAudio: audioTracks.length > 0 };
  } finally {
    // Only the canvas track is ours to end; the audio belongs to the still
    // playing background and stopping it would silence the preview.
    for (const t of canvasStream.getVideoTracks()) t.stop();
  }
}
