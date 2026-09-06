// Tiny in-process logger with a renderer feed and a rotating file sink.
//
// The Console page subscribes via window.krypt.log.onAppend and sees the last
// 500 lines. Those die with the process, which is useless for "it crashed
// yesterday, what happened?" — so every line is ALSO appended to
// `<userData>/logs/app.log`, capped at ~5 MB with one rotated `app.log.1`.
//
// Rules for the file sink:
//  • Never sync on the hot path. Lines are buffered and flushed by an
//    unref'd timer with async appends; `flushSync` exists for before-quit.
//  • Every line written to disk goes through `redactSecrets` — the same
//    classes of secret feed.ts / engine.ts already scrub from tape URLs.
//  • Disk failures (read-only profile, EBUSY) are swallowed; a log that
//    cannot be written must never take down what it is logging.
//
// No `electron` import: main.ts supplies the directory so this stays
// testable offline (test/crashguard.test.mjs bundles it).

import fs from 'node:fs';
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';

export interface LogLine {
  at: number;
  level: Level;
  line: string;
}

export const LOG_FILE = 'app.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 250;

// ─── Pure helpers (tested offline) ────────────────────────────────────

/**
 * Scrub the secrets this app handles from a line before it touches disk:
 * Helius `api-key=` query params, Telegram bot tokens (`123456:AbC…`, with
 * or without the `bot` URL prefix) and `sk-…` style API keys.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/api-key=[^&\s"'`]+/gi, 'api-key=***')
    .replace(/(\b|bot)(\d{6,}):[A-Za-z0-9_-]{20,}/g, '$1$2:***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

export function formatLine(l: LogLine): string {
  return `${new Date(l.at).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${redactSecrets(l.line)}\n`;
}

/**
 * Decide whether a write of `incoming` bytes onto a file of `current` bytes
 * must rotate first. Pure so the boundary is pinned by a test.
 */
export function shouldRotate(current: number, incoming: number, max = LOG_MAX_BYTES): boolean {
  return current > 0 && current + incoming > max;
}

// ─── In-memory feed ───────────────────────────────────────────────────

const listeners = new Set<(l: LogLine) => void>();
const recent: LogLine[] = [];
const CAP = 500;

// ─── File sink ────────────────────────────────────────────────────────

let sinkDir: string | null = null;
let sinkFile: string | null = null;
let sinkBytes = 0;
let pending = '';
let timer: NodeJS.Timeout | null = null;
let writing: Promise<void> | null = null;

function rotateIfNeeded(incoming: number): void {
  if (!sinkFile || !shouldRotate(sinkBytes, incoming)) return;
  try {
    fs.renameSync(sinkFile, `${sinkFile}.1`);
  } catch {
    /* rotation is best-effort; keep appending to the current file */
  }
  sinkBytes = 0;
}

function takePending(): string {
  const chunk = pending;
  pending = '';
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return chunk;
}

function flushAsync(): void {
  if (!sinkFile || !pending || writing) return;
  const chunk = takePending();
  const bytes = Buffer.byteLength(chunk, 'utf8');
  rotateIfNeeded(bytes);
  const file = sinkFile;
  writing = fs.promises
    .appendFile(file, chunk, 'utf8')
    .then(() => {
      sinkBytes += bytes;
    })
    .catch(() => {
      /* read-only profile / EBUSY — drop the chunk rather than throw */
    })
    .finally(() => {
      writing = null;
      if (pending) schedule();
    });
}

function schedule(): void {
  if (timer || !sinkFile) return;
  timer = setTimeout(flushAsync, FLUSH_MS);
  timer.unref?.();
}

/**
 * Start writing to `<dir>/app.log`. `header` is written first (versions,
 * platform). Safe to call once; a second call is ignored.
 */
function attachFileSink(dir: string, header: string): string | null {
  if (sinkFile) return sinkFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);
    try {
      sinkBytes = fs.statSync(file).size;
    } catch {
      sinkBytes = 0;
    }
    sinkDir = dir;
    sinkFile = file;
    pending = `\n${redactSecrets(header)}\n` + pending;
    // The header should reach disk even if the app dies before the first
    // timer tick — that is the "could not start" case we most want recorded.
    flushSync();
    return file;
  } catch {
    sinkDir = null;
    sinkFile = null;
    return null;
  }
}

/** Drain the buffer synchronously — before-quit and the fatal path only. */
function flushSync(): void {
  if (!sinkFile || !pending) return;
  const chunk = takePending();
  try {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    rotateIfNeeded(bytes);
    fs.appendFileSync(sinkFile, chunk, 'utf8');
    sinkBytes += bytes;
  } catch {
    /* never throw from a flush — we may already be on the way out */
  }
}

function push(level: Level, line: string): void {
  const entry: LogLine = { at: Date.now(), level, line };
  recent.push(entry);
  if (recent.length > CAP) recent.splice(0, recent.length - CAP);
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* listener errors never propagate */
    }
  }
  if (sinkFile) {
    pending += formatLine(entry);
    schedule();
  }
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[sniper] ${line}`);
}

export const logger = {
  info: (line: string) => push('info', line),
  warn: (line: string) => push('warn', line),
  error: (line: string) => push('error', line),
  subscribe: (cb: (l: LogLine) => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  recent: (): LogLine[] => [...recent],
  attachFileSink,
  flushSync,
  /** Directory of app.log, or null when no sink is attached. */
  logsDir: (): string | null => sinkDir,
  /** Full path of app.log, or null when no sink is attached. */
  filePath: (): string | null => sinkFile,
};

/** Testing seam — detach the sink and drop buffered lines. */
export function __resetSinkForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = '';
  writing = null;
  sinkDir = null;
  sinkFile = null;
  sinkBytes = 0;
}
