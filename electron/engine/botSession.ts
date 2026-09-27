// The machinery a bot session runs on — main process, no trading rules.
//
// Krypto Trader (electron/engine/kryptoTrader.ts) is built on this. Krypto
// Mode moves onto it later (design step 9); until then it keeps its own loop.
// What lives here is the part both need and both got wrong the first time
// (design §0 D10, K2–K6):
//
//   • ONE async lock per session. The tick, an AI answer, an MCP call and
//     the user's sell-all all mutate the same book; each takes the lock, so
//     room is reserved and the in-flight record written before any await
//     another caller could interleave with (K4).
//   • Sessions step CONCURRENTLY, each inside its own try/catch: one session
//     that throws, or waits 30 s on a fill, never stalls or kills the rest.
//   • A persisted store in the ledger.ts shape: an unreadable file is NOT
//     an empty one (fail-open-persistence). ENOENT is a first run; any other
//     read or parse failure makes the store read-only for the run and says
//     why through `failure()`, which electron/main.ts lists at startup.
//     `saveNow` is synchronous — the in-flight record must be on disk BEFORE
//     a transaction is signed (exactly once, K5).
//   • A once-a-minute warner for conditions that are pending, not consumed
//     (order-safety rule 2).

import fs from 'node:fs';
import path from 'node:path';

// ─── Per-session lock ──────────────────────────────────────────────────────

export class SessionLocks {
  private tails = new Map<string, Promise<unknown>>();
  private held = new Set<string>();

  /** Run `fn` holding `id`'s lock. Callers queue; they never run together. */
  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const next = prev.then(
      async () => {
        this.held.add(id);
        try {
          return await fn();
        } finally {
          this.held.delete(id);
        }
      },
      async () => {
        this.held.add(id);
        try {
          return await fn();
        } finally {
          this.held.delete(id);
        }
      },
    );
    const tail = next.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return next;
  }

  /** Whether `id`'s lock is held right now — the tick skips a busy session
   *  rather than queueing a stale step behind a slow one. */
  busy(id: string): boolean {
    return this.held.has(id) || this.tails.has(id);
  }

  clear(): void {
    this.tails.clear();
    this.held.clear();
  }
}

/** Step every id concurrently; a throw is reported, never propagated. */
export async function stepAll(ids: string[], step: (id: string) => Promise<void>, onError: (id: string, e: Error) => void): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      try {
        await step(id);
      } catch (e) {
        onError(id, e instanceof Error ? e : new Error(String(e)));
      }
    }),
  );
}

// ─── Fail-closed persistence ───────────────────────────────────────────────

export class SessionStore<T> {
  private filePath = '';
  private loadFailure: string | null = null;

  constructor(
    private readonly fileName: string,
    private readonly label: string,
  ) {}

  /**
   * Read the file. ENOENT → `empty` (a first run, writable). Anything else →
   * `empty` served, but the store is READ-ONLY for the run and the damaged
   * file survives byte for byte.
   */
  load(userDataDir: string, parse: (raw: unknown) => T, empty: () => T, warn: (line: string) => void): T {
    this.filePath = userDataDir ? path.join(userDataDir, this.fileName) : '';
    this.loadFailure = null;
    if (!this.filePath) return empty();
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadFailure = `${this.filePath} could not be read (${(e as Error).message})`;
        warn(`${this.label}: ${this.loadFailure} — read-only this run`);
      }
      return empty();
    }
    try {
      return parse(JSON.parse(text));
    } catch (e) {
      this.loadFailure = `${this.filePath} is corrupt (${(e as Error).message})`;
      warn(`${this.label}: ${this.loadFailure} — read-only this run`);
      return empty();
    }
  }

  failure(): string | null {
    return this.loadFailure;
  }

  /** Whether a file is configured at all (tests run without one). */
  hasFile(): boolean {
    return this.filePath !== '';
  }

  /** Synchronous write, tmp + rename. Never over an unreadable file. */
  saveNow(data: T): boolean {
    if (!this.filePath || this.loadFailure) return false;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch {
      return false; // memory stays authoritative this run
    }
  }

  reset(): void {
    this.filePath = '';
    this.loadFailure = null;
  }
}

// ─── Pending, not consumed ─────────────────────────────────────────────────

/** True when a pending condition should warn again (first time, then once a minute). */
export function dueForWarning(lastWarnAt: number | null, now: number, everyMs = 60_000): boolean {
  return lastWarnAt === null || now - lastWarnAt >= everyMs;
}
