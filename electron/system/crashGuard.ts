// Main-process crash guard.
//
// ─── Why this exists ──────────────────────────────────────────────────
//
// Electron 30 runs Node 20, where an unhandled promise rejection is FATAL by
// default. The main process is full of `fetch` — market providers, the bots,
// the feed pool, the credit budget — and any one unawaited rejection took the
// whole terminal down with it, potentially with a position open. Dying is the
// worst possible response for a UI process that is holding money.
//
// So: catch, record, and keep running. That is deliberately NOT "swallow".
// A swallowed error is how a terminal ends up quietly showing stale numbers,
// which for this app is worse than a crash. Every catch is shouted into the
// Grimoire, raised once per run as a desktop notification, and appended to a
// file on disk that survives the process — the in-memory logger holds 500
// lines and takes them to the grave.
//
// ─── The two cases where we still quit ────────────────────────────────
//
//  1. Before a window exists. Staying alive then means an invisible process
//     holding the single-instance lock, so the user's next double-click does
//     nothing at all. A visible failure beats a zombie.
//  2. A crash STORM. If the same fault fires in a tight loop we are burning
//     CPU and filling the disk, not surviving. The breaker trips and quits.
//
// The logic here is deliberately free of any `electron` import so it can be
// tested offline; main.ts supplies the paths and the side effects.

import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './logger';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

export interface CrashGuardHost {
  /** Directory for crash files. Created on demand. */
  dir: string;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  /** True once a window exists. Before that, a crash is fatal by policy. */
  windowUp(): boolean;
  /** Tear the app down — only ever called for the two cases above. */
  quit(reason: string): void;
  /** Raise the first crash of the run to the user. Optional. */
  notify?(summary: string): void;
  /** Extra lines for the crash file: versions, platform. */
  context?(): Record<string, string>;
}

/** More than this many crashes inside the window means a loop, not a blip. */
export const STORM_MAX = 25;
export const STORM_WINDOW_MS = 10_000;
/** Crash files older than this are pruned; the disk is not a landfill. */
export const KEEP_DAYS = 7;
/** A single fault repeating must not write a gigabyte of identical stacks. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// ─── Pure helpers (tested offline) ────────────────────────────────────

/** Anything can be thrown or rejected — coerce it without losing the stack. */
export function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}`, stack: err.stack ?? '(no stack)' };
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return { message: JSON.stringify(err).slice(0, 500), stack: '(non-Error rejection)' };
    } catch {
      return { message: String(err), stack: '(non-Error rejection, unserialisable)' };
    }
  }
  return { message: String(err), stack: '(non-Error rejection)' };
}

export function formatCrash(
  kind: CrashKind,
  err: unknown,
  context: Record<string, string>,
  now: number,
): string {
  const { message, stack } = describe(err);
  const head = `[${new Date(now).toISOString()}] ${kind}: ${message}`;
  const ctx = Object.entries(context)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `${head}\n${ctx ? ctx + '\n' : ''}${stack}\n\n`;
}

/** True when crashes are arriving faster than the breaker allows. */
export function isStorm(times: number[], now: number): boolean {
  const recent = times.filter((t) => now - t <= STORM_WINDOW_MS);
  return recent.length > STORM_MAX;
}

/** Crash filenames (`crash-YYYY-MM-DD.log`) that have aged out. */
export function prunable(names: string[], now: number): string[] {
  const cutoff = now - KEEP_DAYS * 86_400_000;
  return names.filter((n) => {
    const m = /^crash-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(n);
    if (!m) return false;
    const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isFinite(at) && at < cutoff;
  });
}

export function fileNameFor(now: number): string {
  return `crash-${new Date(now).toISOString().slice(0, 10)}.log`;
}

// ─── Installation ─────────────────────────────────────────────────────

let host: CrashGuardHost | null = null;
let installed = false;
let notified = false;
const crashTimes: number[] = [];
let total = 0;

export function crashCount(): number {
  return total;
}

/** Where crash files live, or null before install. Shown to the user. */
export function crashDir(): string | null {
  return host?.dir ?? null;
}

/** Append a crash to today's file. Never throws — we are already in trouble. */
function record(text: string): void {
  if (!host) return;
  try {
    fs.mkdirSync(host.dir, { recursive: true });
    const file = path.join(host.dir, fileNameFor(Date.now()));
    // A repeating fault must not fill the disk. Once today's file is at the
    // cap we stop appending; the first occurrences are the informative ones.
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* first crash today */
    }
    // A crash report is the file a user is most likely to paste into a
    // support chat; it must carry no key (same rule as app.log).
    if (size < MAX_FILE_BYTES) fs.appendFileSync(file, redactSecrets(text), 'utf8');
  } catch {
    /* a read-only profile must not turn a survivable crash into a fatal one */
  }
}

export function pruneOld(now = Date.now()): number {
  if (!host) return 0;
  let removed = 0;
  try {
    for (const name of prunable(fs.readdirSync(host.dir), now)) {
      try {
        fs.unlinkSync(path.join(host.dir, name));
        removed += 1;
      } catch {
        /* locked by something else; next run will get it */
      }
    }
  } catch {
    /* no crash directory yet — the happy path */
  }
  return removed;
}

function handle(kind: CrashKind, err: unknown): void {
  if (!host) return;
  const now = Date.now();
  total += 1;
  crashTimes.push(now);
  if (crashTimes.length > STORM_MAX * 2) crashTimes.splice(0, crashTimes.length - STORM_MAX * 2);

  const { message } = describe(err);
  let ctx: Record<string, string> = {};
  try {
    ctx = host.context?.() ?? {};
  } catch {
    /* context is a nicety, never a reason to fail here */
  }
  record(formatCrash(kind, err, ctx, now));

  // Loud, because a caught crash may have left a trade half-done.
  host.log(
    'error',
    `${kind}: ${message} — the app kept running; crash file in ${host.dir}. If a trade was in flight, CHECK YOUR POSITION.`,
  );

  // `windowUp` reaches into main.ts state that may not exist yet — a crash
  // during module initialisation hits the binding's temporal dead zone. A
  // throw here means "no window", which is the safe reading either way.
  let up = false;
  try {
    up = host.windowUp();
  } catch {
    up = false;
  }
  if (!up) {
    host.quit(`${kind} before the window opened: ${message}`);
    return;
  }
  if (isStorm(crashTimes, now)) {
    host.log(
      'error',
      `crash storm: more than ${STORM_MAX} in ${STORM_WINDOW_MS / 1000}s — shutting down rather than spinning.`,
    );
    host.quit(`crash storm: ${message}`);
    return;
  }
  if (!notified) {
    notified = true;
    try {
      host.notify?.(message);
    } catch {
      /* notifications are cosmetic */
    }
  }
}

export function install(h: CrashGuardHost): void {
  if (installed) return;
  installed = true;
  host = h;
  process.on('uncaughtException', (err) => handle('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
  pruneOld();
}

/** Testing seam — lets a test drive the handlers without real process events. */
export function __handleForTest(kind: CrashKind, err: unknown): void {
  handle(kind, err);
}

export function __resetForTest(h: CrashGuardHost | null): void {
  host = h;
  installed = false;
  notified = false;
  total = 0;
  crashTimes.length = 0;
}
