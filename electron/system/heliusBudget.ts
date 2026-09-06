// Helius credit budget — persistence and the cut-off decision.
//
// The arithmetic is in shared/credits.ts. This owns the file and the one
// action that matters: when the budget is spent, TURN THE EXPENSIVE SOCKET
// OFF rather than letting it run into an overage bill.
//
// Counting is derived from the feed pool's own per-socket BYTE totals, so
// nothing in the hot path does extra work — each socket already knows the
// length of every frame it parsed. Helius bills websocket traffic at
// 2 credits per 0.1 MB uncompressed (shared/credits.ts), not per push.

import fs from 'node:fs';
import path from 'node:path';
import { emptyUsage, feedCreditsForBytes, overBudget, record, rollWindow, type CreditUsage } from '@shared/credits';

let file = '';
let usage: CreditUsage = emptyUsage(Date.now());
let dirty = false;
/** Last byte total seen per socket, so we bill the DELTA, not the total. */
const lastByteCount = new Map<string, number>();
/** Credits owed but under one whole credit, per socket. `record` floors, so
 *  without this a socket delivering small frames would never be billed. */
const fractionalCarry = new Map<string, number>();

export function init(userDataDir: string, limit: number): void {
  file = path.join(userDataDir, 'helius-credits.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CreditUsage>;
    usage = {
      used: typeof raw.used === 'number' ? raw.used : 0,
      limit,
      windowStartedAt: typeof raw.windowStartedAt === 'number' ? raw.windowStartedAt : Date.now(),
      wsEvents: typeof raw.wsEvents === 'number' ? raw.wsEvents : 0,
      httpCalls: typeof raw.httpCalls === 'number' ? raw.httpCalls : 0,
    };
  } catch {
    usage = { ...emptyUsage(Date.now()), limit };
  }
  usage = rollWindow(usage, Date.now());
  persist();
}

export function setLimit(limit: number): void {
  usage = { ...usage, limit: Math.max(0, Math.floor(limit)) };
  dirty = true;
}

export function current(): CreditUsage {
  return { ...usage };
}

/**
 * Bill the bytes a Helius socket has delivered since we last looked:
 * 2 credits per 0.1 MB (bytes / 51,200), fractions carried forward.
 *
 * `stats` is the feed pool's own list. Only sockets whose URL is a Helius one
 * are billed — the free endpoints cost nothing and must not inflate the
 * number the user is being warned about.
 */
export function billFeed(stats: Array<{ url: string; bytes: number }>): void {
  const now = Date.now();
  usage = rollWindow(usage, now);
  for (const s of stats) {
    if (!/helius/i.test(s.url)) continue;
    const seen = lastByteCount.get(s.url) ?? 0;
    // A reconnect resets the socket's counter; treat a drop as a fresh start
    // rather than billing a negative delta.
    const delta = s.bytes >= seen ? s.bytes - seen : s.bytes;
    lastByteCount.set(s.url, s.bytes);
    if (delta <= 0) continue;
    const owed = (fractionalCarry.get(s.url) ?? 0) + feedCreditsForBytes(delta);
    const whole = Math.floor(owed);
    fractionalCarry.set(s.url, owed - whole);
    if (whole > 0) {
      usage = record(usage, 'ws', whole);
      dirty = true;
    }
  }
}

export function billHttp(calls = 1): void {
  usage = rollWindow(usage, Date.now());
  usage = record(usage, 'http', calls);
  dirty = true;
}

/** True the first time the budget is exceeded, so the caller acts once. */
let announced = false;
export function shouldCutOff(): boolean {
  if (!overBudget(usage)) {
    announced = false;
    return false;
  }
  if (announced) return false;
  announced = true;
  return true;
}

export function persist(): void {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(usage), 'utf8');
    dirty = false;
  } catch {
    /* a read-only profile must not break the engine */
  }
}

/** Called on the engine's 1 s timer; the write itself happens at most
 *  every 30 s — it is a synchronous disk hit on the trade-serving thread,
 *  and a 30 s-old credit count is no less honest. */
const FLUSH_EVERY_MS = 30_000;
let lastFlushAt = 0;
export function flush(): void {
  if (!dirty) return;
  if (Date.now() - lastFlushAt < FLUSH_EVERY_MS) return;
  lastFlushAt = Date.now();
  persist();
}

export function reset(): void {
  usage = { ...emptyUsage(Date.now()), limit: usage.limit };
  lastByteCount.clear();
  fractionalCarry.clear();
  announced = false;
  persist();
}
