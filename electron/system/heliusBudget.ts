// Helius credit budget — persistence and the cut-off decision.
//
// The arithmetic is in shared/credits.ts. This owns the file and the one
// action that matters: when the budget is spent, TURN THE EXPENSIVE SOCKET
// OFF rather than letting it run into an overage bill.
//
// Every socket on a Helius URL reports its frames' lengths here, and every HTTP
// call its method. Helius bills websocket traffic at 2 credits per 0.1 MB
// uncompressed (shared/credits.ts), not per push. This used to bill only the
// launch feed and the token tape, so with the AMM tape on the key too it read
// 955k when Helius had already cut the socket off, and the ceiling never fired.

import fs from 'node:fs';
import path from 'node:path';
import {
  emptyBreakdown,
  emptyUsage,
  feedCreditsForBytes,
  isBilledHeliusUrl,
  overBudget,
  record,
  rollWindow,
  type CreditBreakdown,
  type CreditUsage,
} from '@shared/credits';

let file = '';
let usage: CreditUsage = emptyUsage(Date.now());
let dirty = false;
/** Bytes received per stream and not yet turned into credits. */
const pendingBytes = new Map<string, number>();
/** Credits owed but under one whole credit, per stream. `record` floors, so
 *  without this a socket delivering small frames would never be billed. */
const fractionalCarry = new Map<string, number>();
let meterTimer: ReturnType<typeof setInterval> | null = null;

/** A saved file is only ever trusted for numbers. */
function readBreakdown(raw: unknown): CreditBreakdown {
  const numbers = (o: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && v >= 0 && k.length <= 60) out[k] = v;
    }
    return out;
  };
  const r = (raw ?? {}) as Partial<CreditBreakdown>;
  return {
    since: typeof r.since === 'number' ? r.since : Date.now(),
    sockets: numbers(r.sockets),
    methods: numbers(r.methods),
  };
}

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
      breakdown: readBreakdown(raw.breakdown),
    };
  } catch {
    usage = { ...emptyUsage(Date.now()), limit };
  }
  usage = rollWindow(usage, Date.now());
  persist();
  // On its own timer: the token tape and confirmations spend credits with the
  // scanner stopped, when the engine's timers are not running.
  if (!meterTimer) {
    meterTimer = setInterval(() => {
      settleSockets();
      flush();
    }, 1_000);
    meterTimer.unref?.();
  }
}

export function setLimit(limit: number): void {
  usage = { ...usage, limit: Math.max(0, Math.floor(limit)) };
  dirty = true;
}

export function current(): CreditUsage {
  return { ...usage };
}

/** One frame from a Helius socket. Called per frame, so it only adds. */
export function addSocketBytes(stream: string, bytes: number): void {
  pendingBytes.set(stream, (pendingBytes.get(stream) ?? 0) + bytes);
}

/** Turn the bytes received so far into credits: 2 per 0.1 MB (bytes / 51,200),
 *  fractions carried forward. */
export function settleSockets(): void {
  if (pendingBytes.size === 0) return;
  usage = rollWindow(usage, Date.now());
  for (const [stream, bytes] of pendingBytes) {
    const owed = (fractionalCarry.get(stream) ?? 0) + feedCreditsForBytes(bytes);
    const whole = Math.floor(owed);
    fractionalCarry.set(stream, owed - whole);
    if (whole > 0) {
      usage = record(usage, 'ws', whole, stream);
      dirty = true;
    }
  }
  pendingBytes.clear();
}

export function billHttp(calls = 1, method = 'other'): void {
  usage = rollWindow(usage, Date.now());
  usage = record(usage, 'http', calls, method);
  dirty = true;
}

/** Count an HTTP call if this URL costs credits. Metering must never break a trade. */
export function meterHttp(url: string, method: string, calls = 1): void {
  if (!isBilledHeliusUrl(url)) return;
  try {
    billHttp(calls, method);
  } catch {
    /* see above */
  }
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
  settleSockets();
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
  usage = { ...emptyUsage(Date.now()), limit: usage.limit, breakdown: emptyBreakdown(Date.now()) };
  pendingBytes.clear();
  fractionalCarry.clear();
  announced = false;
  persist();
}
