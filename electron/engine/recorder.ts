// Event recorder — research §9: store decoded events *and* decisions with
// local timestamps so strategies can be replayed and re-fit honestly.
// JSONL, one file per day, in userData/recordings. Append-only, buffered,
// never blocks the hot path.
//
// ─── It is OFF by default, and capped when on ─────────────────────────
//
// Measured on this machine 2026-08-25: a research archive of **40.4 GB across
// seven day-files, the largest a single day of 15 GB**. That is a fine thing
// to collect deliberately onto a spare drive; it is not something to do by
// default on a stranger's system drive, which is where userData lives.
//
// So `recorderEnabled` now defaults to false, and whenever it IS on, old day
// files are pruned to stay under a size ceiling. A research tool that can
// silently fill a disk is a bug in a shipped app.

import fs from 'node:fs';
import path from 'node:path';
import { LaunchFilter, type LaunchFilterStats } from './launchRecorder';

let dir = '';
let enabled = false;

// ─── Two modes ────────────────────────────────────────────────────────
//
// 'launch'   — the default when the recorder is on. Every record goes through
//              launchRecorder.ts: creates, the first 30 min of each mint's
//              trades (capped), completions, metadata and health rows are
//              kept; mature-token trades and post-graduation AMM payloads are
//              dropped. Measured on E:/data/2026-07-25.jsonl (a 10 GB
//              firehose day): see LAUNCH_MODE_MEASURED below.
// 'firehose' — everything, unfiltered (settings.recordFirehose = true).
//
// The mode changes what is written, never the file format: same JSONL
// envelope, same day files, same prune. `engine_start` rows carry `mode`
// (and the filter's config) so an analyst can tell which one produced a day.
export type RecorderMode = 'launch' | 'firehose';
let mode: RecorderMode = 'launch';
const launchFilter = new LaunchFilter();

export function setMode(m: RecorderMode): void {
  if (m === mode) return;
  mode = m;
  launchFilter.reset();
}

export function getMode(): RecorderMode {
  return mode;
}

/** True when the engine should hand the recorder every decoded tape event
 *  (`tape_create`/`tape_trade`/…). In launch mode the recorder trims them
 *  itself, so the answer is "whenever recording at all" — gating the tape on
 *  `recordFirehose` alone would leave launch mode with nothing to keep. */
export function wantsTape(): boolean {
  return enabled && dir !== '';
}
let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let dropped = 0;
// Firehose can produce hundreds of records/sec. Cap the in-memory buffer so a
// slow disk can never OOM the process — drop-oldest and count what was lost.
const BUFFER_CAP = 100_000;

/** Point the recorder at a directory. `customDir` (e.g. D:\memedata) wins;
 *  otherwise userData/recordings. Falls back to userData if the custom dir
 *  can't be created. Returns the directory actually in use. */
export function init(userDataDir: string, on: boolean, customDir = ''): string {
  const target = customDir.trim() ? customDir.trim() : path.join(userDataDir, 'recordings');
  try {
    fs.mkdirSync(target, { recursive: true });
    dir = target;
  } catch {
    // Custom dir failed (bad path / no drive) — fall back to userData.
    dir = path.join(userDataDir, 'recordings');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* handled on first write */
    }
  }
  enabled = on;
  return dir;
}

export function setEnabled(on: boolean): void {
  enabled = on;
  if (!on) flushSync();
}

export function recordingsDir(): string {
  return dir;
}

/** Ceiling in bytes for everything in the recordings directory. 0 = no cap. */
let maxBytes = 0;

export function setMaxBytes(bytes: number): void {
  maxBytes = Math.max(0, Math.floor(bytes));
}

export interface RecordingsUsage {
  files: number;
  bytes: number;
  dir: string;
}

export function usage(): RecordingsUsage {
  if (!dir) return { files: 0, bytes: 0, dir: '' };
  try {
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let bytes = 0;
    for (const f of names) {
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
      } catch {
        /* a file vanished mid-scan */
      }
    }
    return { files: names.length, bytes, dir };
  } catch {
    return { files: 0, bytes: 0, dir };
  }
}

/**
 * Delete the OLDEST day files until the directory fits under the ceiling.
 *
 * Oldest-first because the newest data is what a re-fit actually wants, and
 * because the current day's file is still being appended to — it is never a
 * candidate. Returns how many bytes were reclaimed.
 */
export function prune(): number {
  if (!dir || maxBytes <= 0) return 0;
  let freed = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith(today))
      .map((f) => {
        const full = path.join(dir, f);
        try {
          return { f, full, size: fs.statSync(full).size };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; full: string; size: number } => x !== null)
      .sort((a, b) => a.f.localeCompare(b.f)); // day files sort chronologically

    let total = usage().bytes;
    for (const file of files) {
      if (total <= maxBytes) break;
      try {
        fs.rmSync(file.full, { force: true });
        total -= file.size;
        freed += file.size;
      } catch {
        /* locked by something else — try the next one */
      }
    }
  } catch {
    /* an unreadable directory is not worth crashing the engine for */
  }
  return freed;
}

// ─── Rolling byte rate ────────────────────────────────────────────────
// 60 one-minute buckets of bytes queued for writing. `bytesLastHour()` is
// what the Settings page turns into a "GB/day at this rate" figure.
const RATE_BUCKETS = 60;
const rateBytes = new Array<number>(RATE_BUCKETS).fill(0);
const rateMinute = new Array<number>(RATE_BUCKETS).fill(-1);
let bytesTotal = 0;
let recordsTotal = 0;
const keptByKind: Record<string, number> = {};
const droppedByKind: Record<string, number> = {};

function noteBytes(n: number, now: number): void {
  const minute = Math.floor(now / 60_000);
  const i = minute % RATE_BUCKETS;
  if (rateMinute[i] !== minute) {
    rateMinute[i] = minute;
    rateBytes[i] = 0;
  }
  rateBytes[i] += n;
  bytesTotal += n;
}

/** Bytes queued in the last 60 minutes (whole-minute buckets). */
export function bytesLastHour(now = Date.now()): number {
  const minute = Math.floor(now / 60_000);
  let sum = 0;
  for (let i = 0; i < RATE_BUCKETS; i++) {
    if (rateMinute[i] >= 0 && minute - rateMinute[i] < RATE_BUCKETS) sum += rateBytes[i];
  }
  return sum;
}

/** Append one record. `kind` becomes the JSONL `t` field. */
export function record(kind: string, payload: Record<string, unknown>): void {
  if (!enabled || !dir) return;
  const now = Date.now();
  if (mode === 'launch') {
    if (!launchFilter.accept(kind, payload)) {
      droppedByKind[kind] = (droppedByKind[kind] ?? 0) + 1;
      return;
    }
  }
  keptByKind[kind] = (keptByKind[kind] ?? 0) + 1;
  recordsTotal++;
  if (buffer.length >= BUFFER_CAP) {
    // Disk can't keep up — drop the oldest to protect memory.
    buffer.shift();
    dropped++;
  }
  const extra = kind === 'engine_start' ? { mode, launch: mode === 'launch' ? launchFilter.config() : null } : null;
  const line = JSON.stringify({ t: kind, at: now, ...payload, ...extra });
  noteBytes(line.length + 1, now);
  buffer.push(line);
  if (buffer.length >= 200) {
    flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 1_000);
  }
}

export function droppedCount(): number {
  return dropped;
}

let writing = false;

/** Async flush — appends off the hot path. Writes are serialized (one at a
 *  time) so lines never interleave. The engine never blocks on disk. */
export function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0 || !dir || writing) return;
  const lines = buffer.join('\n') + '\n';
  buffer = [];
  const day = new Date().toISOString().slice(0, 10);
  writing = true;
  fs.appendFile(path.join(dir, `${day}.jsonl`), lines, 'utf8', () => {
    writing = false;
    // Drain anything that accumulated during the write.
    if (buffer.length > 0) flush();
  });
}

/** Synchronous flush — only for shutdown, where blocking is acceptable and
 *  we must not lose the tail. */
export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0 || !dir) return;
  const lines = buffer.join('\n') + '\n';
  buffer = [];
  const day = new Date().toISOString().slice(0, 10);
  try {
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), lines, 'utf8');
  } catch {
    /* disk trouble must never take down the engine */
  }
}

/**
 * Measured 2026-08-30 by streaming the launch filter over
 * E:/data/2026-07-25.jsonl (9.99 GB, 18.58 tape hours, 12.58 M lines):
 * kept 933 MB = 9.3 % of the bytes → 1.2 GB/day launch vs 12.9 GB/day
 * firehose on that day (15 GB was the worst firehose day seen). 89 % of the
 * firehose is `tape_amm` (post-graduation PumpSwap payloads); the filter
 * kept 84 % of `tape_trade` rows (most curve trades happen inside the first
 * 30 min), all 20,089 creates, all 877 completions, all metadata; 24 mints
 * hit the 3,000-trade cap. See scripts/analysis/estimate_launchtape.mjs to
 * re-measure. Kept here so the Settings copy and this module agree.
 */
export const FIREHOSE_MEASURED_GB_PER_DAY = 15;
export const LAUNCH_MODE_MEASURED_GB_PER_DAY = 1.2;

export interface RecorderStats {
  files: number;
  totalBytes: number;
  mode: RecorderMode;
  enabled: boolean;
  /** Bytes queued in the last 60 min — multiply by 24 for a daily rate. */
  bytesLastHour: number;
  /** Bytes queued since the process started. */
  bytesSession: number;
  recordsSession: number;
  /** Records lost because the in-memory buffer overflowed (slow disk). */
  bufferDropped: number;
  keptByKind: Record<string, number>;
  droppedByKind: Record<string, number>;
  launch: LaunchFilterStats | null;
}

export function stats(): RecorderStats {
  const u = usage();
  return {
    files: u.files,
    totalBytes: u.bytes,
    mode,
    enabled: enabled && dir !== '',
    bytesLastHour: bytesLastHour(),
    bytesSession: bytesTotal,
    recordsSession: recordsTotal,
    bufferDropped: dropped,
    keptByKind: { ...keptByKind },
    droppedByKind: { ...droppedByKind },
    launch: mode === 'launch' ? launchFilter.stats() : null,
  };
}
