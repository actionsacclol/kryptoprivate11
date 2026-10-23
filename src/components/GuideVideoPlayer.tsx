// The in-app player for the bundled guide videos (2026-10-22).
//
// An overlay over whatever page opened it, so closing it puts the reader back
// exactly where they were. Built for someone who has never used the app: it
// starts playing on its own, captions are on by default (plenty of people
// watch with the sound off), and a Slower button is one click away, because
// the narration goes at the pace of someone reading it, not following it.
//
// The captions are drawn in a strip UNDER the picture, not over it: every
// frame already carries its step in a bar along the bottom, and the browser's
// own captions land right on top of that bar. So the track stays 'hidden'
// (cues still load and fire) and the native CC button is hidden with it.
//
// Plain div, not a glass lens: the lens costs a few ms per frame and this sits
// over a playing video for minutes at a time (liquid-glass memory, 09-28).

import { useEffect, useRef, useState } from 'react';
import { Captions, CaptionsOff, PlayCircle, X } from 'lucide-react';
import { appVideoFile, type AppGuideVideo } from '../guideVideos';
import { GhostButton } from './common';
import { cls } from '../utils/format';

const SPEEDS = [0.75, 1, 1.25] as const;
const SPEED_LABEL: Record<(typeof SPEEDS)[number], string> = { 0.75: 'Slower', 1: 'Normal', 1.25: 'Faster' };

export function GuideVideoPlayer({ video, onClose }: { video: AppGuideVideo; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLTrackElement>(null);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [captions, setCaptions] = useState(true);
  const [line, setLine] = useState('');
  const [failed, setFailed] = useState(false);

  // Escape closes; the handler reads the latest onClose through a ref so a
  // parent re-render never re-subscribes (ScriptInputsDialog, 2026-09-23).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (player.current) player.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    el.track.mode = 'hidden';
    const onCue = (): void => {
      const cue = el.track.activeCues?.[0] as VTTCue | undefined;
      setLine(cue?.text ?? '');
    };
    el.addEventListener('cuechange', onCue);
    return () => el.removeEventListener('cuechange', onCue);
  }, [failed]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <style>{'.guide-video::-webkit-media-controls-toggle-closed-captions-button{display:none}'}</style>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={video.title}
        tabIndex={-1}
        className="w-full max-w-5xl rounded-xl border border-white/10 bg-krypt-panel p-3 shadow-2xl outline-none"
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <PlayCircle className="h-4 w-4 text-krypt-purple" />
          <span className="text-value font-semibold text-white">{video.title}</span>
          <div className="flex-1" />
          <button
            onClick={() => setCaptions((c) => !c)}
            aria-pressed={captions}
            className={cls('flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-label font-semibold transition', captions ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white' : 'border-white/10 text-krypt-muted hover:text-white')}
          >
            {captions ? <Captions className="h-3.5 w-3.5" /> : <CaptionsOff className="h-3.5 w-3.5" />}
            Captions {captions ? 'on' : 'off'}
          </button>
          <div role="group" aria-label="Speed" className="flex overflow-hidden rounded-md border border-white/10">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                aria-pressed={speed === s}
                className={cls('px-2.5 py-1 text-label font-semibold transition', speed === s ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
              >
                {SPEED_LABEL[s]}
              </button>
            ))}
          </div>
          <span title="Close (Esc)">
            <GhostButton onClick={onClose} className="!py-1">
              <X className="h-4 w-4" />
            </GhostButton>
          </span>
        </div>
        {failed ? (
          <div className="flex aspect-video items-center justify-center rounded-lg bg-black/60 p-6 text-center text-body text-krypt-muted">
            This video could not be played. The written guide on this page has the same steps.
          </div>
        ) : (
          <video
            ref={player}
            className="guide-video aspect-video w-full rounded-lg bg-black"
            src={appVideoFile(video.id, 'mp4')}
            poster={appVideoFile(video.id, 'jpg')}
            controls
            autoPlay
            playsInline
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = speed;
            }}
            onError={() => setFailed(true)}
          >
            <track ref={track} kind="captions" srcLang="en" label="English" src={appVideoFile(video.id, 'vtt')} default />
          </video>
        )}
        {captions && !failed && (
          <div aria-live="polite" className="mt-2 flex min-h-[3.25rem] items-center justify-center rounded-lg bg-black/40 px-4 py-2 text-center text-value leading-snug text-white">
            {line}
          </div>
        )}
        <p className="mt-2 text-label text-krypt-muted">Pause any time and follow along in the app. Slower plays it at three-quarter speed.</p>
      </div>
    </div>
  );
}

/** "2:35" */
export function videoLength(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
