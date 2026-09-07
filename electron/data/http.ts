// Hardened outbound JSON fetch for the market-data providers.
//
// WHY THIS FILE EXISTS. `metadata.ts` took a URL out of a token-creator's
// create event and fetched it (product swarm 2026-08-16 §8.3): any creator
// could launch a mint pointing at their own server and harvest the IP of
// every running install. The terminal makes far MORE outbound requests than
// the sniper did, so the rule here is inverted from the start:
//
//   A provider may only ever contact a host that is hardcoded in this file.
//
// There is no way to pass an arbitrary URL through this module. Callers
// name a provider and a PATH; the host comes from HOSTS below. Redirects
// are refused outright (a 30x to a private address is the classic bypass),
// responses are capped while streaming rather than after buffering, and
// every call has a hard timeout.
//
// Nothing here is reachable from the renderer except through the typed
// market:* IPC channels, which never accept a host or a URL.

import type { ProviderId } from '@shared/market';

/** The complete set of hosts this application will ever contact for market
 *  data. Adding a provider means adding a line here, deliberately. */
const HOSTS: Record<ProviderId, string> = {
  jupiter: 'lite-api.jup.ag',
  dexscreener: 'api.dexscreener.com',
  pumpfun: 'frontend-api-v3.pump.fun',
  geckoterminal: 'api.geckoterminal.com',
  pumpswap: 'swap-api.pump.fun',
  birdeye: 'public-api.birdeye.so',
  helius: 'mainnet.helius-rpc.com',
  rugcheck: 'api.rugcheck.xyz',
};

export function providerHost(id: ProviderId): string {
  return HOSTS[id];
}

/** 512 KB. Discover pages of 40 rows land around 90 KB; candles are smaller. */
const MAX_BYTES = 512 * 1024;

/**
 * Per-provider cap overrides. RugCheck's full `/report` runs to 2 MB and is
 * deliberately never requested — only `/report/summary` (a few KB) and
 * `/insiders/networks`. A tighter cap makes a mistaken call to the big
 * route fail loudly instead of being parsed.
 */
const MAX_BYTES_BY_PROVIDER: Partial<Record<ProviderId, number>> = {
  rugcheck: 256 * 1024,
};
const DEFAULT_TIMEOUT_MS = 9_000;

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** POST body. Omit for GET. */
  json?: unknown;
  /** Jump the per-host FIFO queue (the minimum gap is still honoured). For
   *  the TRADE path only: a buy must not wait behind thirty Discover
   *  lookups — on 2026-08-30 a paper buy sat ~60 s in the pump.fun queue. */
  priority?: boolean;
  /** Route class with its own per-minute window (see WINDOW_LIMIT). */
  lane?: FetchLane;
}

export interface FetchResult<T> {
  ok: boolean;
  message: string;
  data?: T;
  /** Round-trip in ms, recorded even on failure. */
  ms: number;
  /** HTTP status when we got one. */
  status: number | null;
}

// ── Per-provider telemetry (local only — never transmitted) ───────────

interface Stats {
  calls: number;
  errors: number;
  lastError: string | null;
  lastCallAt: number | null;
  samples: number[];
}

const stats = new Map<ProviderId, Stats>();

function statsFor(id: ProviderId): Stats {
  let s = stats.get(id);
  if (!s) {
    s = { calls: 0, errors: 0, lastError: null, lastCallAt: null, samples: [] };
    stats.set(id, s);
  }
  return s;
}

export interface ProviderTelemetry {
  calls: number;
  errors: number;
  lastError: string | null;
  lastCallAt: number | null;
  latencyMs: number | null;
}

export function telemetry(id: ProviderId): ProviderTelemetry {
  const s = statsFor(id);
  const sorted = [...s.samples].sort((a, b) => a - b);
  return {
    calls: s.calls,
    errors: s.errors,
    lastError: s.lastError,
    lastCallAt: s.lastCallAt,
    latencyMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
  };
}

// ── Per-host rate limiting ────────────────────────────────────────────
//
// GeckoTerminal's free tier is 30 req/min and starts 429-ing hard above it;
// DexScreener publishes 300/min on the pairs endpoints. A terminal polling
// four Discover columns plus a token page will blow through a naive limit
// within seconds, and a 429 storm looks exactly like "the app is broken".
// One in-flight queue per host, with a minimum gap, keeps us inside.

// Documented / measured ceilings (docs re-read 2026-09-06, rate-limit swarm):
//   GeckoTerminal 30/min per IP · DexScreener 300/min (pairs) per IP ·
//   Birdeye Standard (free) 1 rps PER ACCOUNT · RugCheck ~60/min, 15 burst ·
//   pump.fun `/coins?…` list route advertises x-ratelimit-limit 60 per 60 s
//   while `/coins/{mint}` tolerates bursts · Jupiter lite-api is officially
//   deprecated but still un-throttled today (api.jup.ag keyless is 0.5 rps).
const MIN_GAP_MS: Record<ProviderId, number> = {
  jupiter: 120,
  dexscreener: 250,
  pumpfun: 260,
  geckoterminal: 2_100, // 30/min with headroom
  pumpswap: 300,
  // The free package is one request per second, per account — the old
  // 120 ms gap 429'd every free-key user's chart and holders panel by the
  // second call of any burst.
  birdeye: 1_100,
  helius: 110,
  rugcheck: 1_100, // measured 2026-08-30: 15 burst, ~1/s sustained
};

/**
 * Sliding-window budgets on top of the gap, keyed by provider or
 * `provider:lane`. A gap bounds the rate between two calls; a window bounds
 * the count over a minute, which is how these providers actually meter. A
 * call that would overflow its window waits for the oldest stamp to age out
 * (priority calls are counted but never held — the trade path does not
 * queue behind Discover).
 */
const WINDOW_LIMIT: Record<string, { n: number; ms: number }> = {
  'pumpfun:list': { n: 55, ms: 60_000 },
  geckoterminal: { n: 28, ms: 60_000 },
  rugcheck: { n: 50, ms: 60_000 },
};

/** Route classes with their own window. Callers tag list routes; everything
 *  else is the provider's default lane. */
export type FetchLane = 'list';

const lastCallAt = new Map<ProviderId, number>();
/** One serial chain per provider, and a SECOND one for priority calls — they
 *  jump the normal queue but still space themselves out. Six liquidation
 *  quotes fired together used to read the same `lastCallAt` and hit Jupiter
 *  in one burst. */
const queues = new Map<string, Promise<unknown>>();
const windowStamps = new Map<string, number[]>();
/** Calls waiting in a provider's normal queue right now. */
const queued = new Map<ProviderId, number>();

/** A call that has sat this long in the queue is answered "busy" without a
 *  request: the queue used to be unbounded, and a Discover refresh could put
 *  hundreds of seek pages ahead of a token page's own lookup (minutes of
 *  waiting for a 9 s "timeout"). */
const MAX_QUEUE_WAIT_MS = 20_000;

/**
 * Cool-down after a 429.
 *
 * Without this, a rate-limited provider keeps getting hammered: every queued
 * call still fires, still 429s, and keeps the window pinned open so it never
 * recovers. Worse, those doomed calls hold the per-host serial queue, so a
 * burst of low-value requests (a Discover refresh) starves a high-value one
 * (the chart) — measured on 2026-08-24: GeckoTerminal 429'd after four calls
 * and the token chart then returned "no data" while a plain curl to the same
 * endpoint answered 200.
 *
 * On a 429 the provider is parked and further calls fail fast, without a
 * request and without occupying the queue. The park is checked when a call
 * is queued AND again when it reaches the front: until 2026-09-06 only the
 * first check existed, so forty calls already chained behind the one that
 * 429'd all still fired into the park, each 429'd in turn, and each reset
 * the 20 s clock — the "cooldown" was the provider being hammered at full
 * gap rate for as long as the backlog lasted.
 *
 * Length: the provider's own `Retry-After` when it sends one, else 20 s
 * doubling per repeat (40, 80, capped at 120 s) with the strike count
 * decaying five minutes after the last 429. A park is only ever extended,
 * never shortened, and a success clears it.
 */
const blockedUntil = new Map<ProviderId, number>();
const parkStrikes = new Map<ProviderId, { count: number; lastAt: number }>();
const RATE_LIMIT_COOLDOWN_MS = 20_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 120_000;
const STRIKE_DECAY_MS = 5 * 60_000;

/** Milliseconds until this provider is usable again, or 0. */
export function cooldownRemainingMs(id: ProviderId): number {
  return Math.max(0, (blockedUntil.get(id) ?? 0) - Date.now());
}

/** Calls waiting in this provider's normal queue — for the diagnostics panel. */
export function queueDepth(id: ProviderId): number {
  return queued.get(id) ?? 0;
}

/** `Retry-After` as milliseconds: integer seconds or an HTTP date. Null when
 *  absent or unparseable. Clamped so a hostile header cannot park a provider
 *  for an hour, nor a "0" un-park it. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const t = Date.parse(v);
    if (Number.isFinite(t)) ms = t - Date.now();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.max(2_000, Math.min(RATE_LIMIT_COOLDOWN_MAX_MS, ms));
}

/** Park the provider after a 429. Returns the park length chosen. */
function park(id: ProviderId, retryAfter: string | null): number {
  const now = Date.now();
  const prev = parkStrikes.get(id);
  const count = prev && now - prev.lastAt < STRIKE_DECAY_MS ? prev.count + 1 : 1;
  parkStrikes.set(id, { count, lastAt: now });
  const escalated = Math.min(RATE_LIMIT_COOLDOWN_MAX_MS, RATE_LIMIT_COOLDOWN_MS * 2 ** (count - 1));
  const length = parseRetryAfterMs(retryAfter) ?? escalated;
  const until = now + length;
  if (until > (blockedUntil.get(id) ?? 0)) blockedUntil.set(id, until);
  slowStartUntil.set(id, until + SLOW_START_MS);
  return length;
}

/**
 * Slow start after a park. A park ending is not the limit ending: the
 * backlog that built up behind it resumes at the full gap rate and trips the
 * same window again a few seconds later (2026-09-06: swap-api was parked
 * twice in a row, 20 s then 40 s, exactly like that). For a minute after a
 * park the gap is doubled, so the provider is re-entered at half speed.
 */
const slowStartUntil = new Map<ProviderId, number>();
const SLOW_START_MS = 60_000;

function effectiveGap(id: ProviderId): number {
  const gap = MIN_GAP_MS[id];
  return Date.now() < (slowStartUntil.get(id) ?? 0) ? gap * 2 : gap;
}

/**
 * Self-throttle from the provider's OWN counters, before a 429 happens.
 * pump.fun's list and swap routes, Jupiter and Birdeye all answer with
 * `x-ratelimit-remaining` and `x-ratelimit-reset`. When the remaining count
 * is about to hit zero, the provider is soft-parked until the reset — the
 * same fail-fast as a real park, but without the refused request, the
 * escalation, or the log line. `reset` is seconds-until (pump.fun) or a
 * unix timestamp (Jupiter); both are handled, and the wait is capped.
 */
const SOFT_PARK_MAX_MS = 60_000;

function softParkFromHeaders(id: ProviderId, headers: { get(name: string): string | null }): void {
  let remaining: number;
  let reset: number;
  try {
    remaining = Number(headers.get('x-ratelimit-remaining'));
    reset = Number(headers.get('x-ratelimit-reset'));
  } catch {
    return;
  }
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || reset <= 0) return;
  const limit = Number(headers.get('x-ratelimit-limit'));
  const floor = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.ceil(limit * 0.05)) : 1;
  if (remaining > floor) return;
  const now = Date.now();
  // > 1e12 is unix milliseconds, > 1e9 unix seconds, else seconds from now.
  const untilMs = reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000;
  const wait = Math.min(SOFT_PARK_MAX_MS, Math.max(1_000, untilMs - now));
  const until = now + wait;
  if (until > (blockedUntil.get(id) ?? 0)) blockedUntil.set(id, until);
}

function parkedResult<T>(id: ProviderId): FetchResult<T> {
  const cooling = cooldownRemainingMs(id);
  return {
    ok: false,
    message: `${id}: rate limited, retrying in ${Math.ceil(cooling / 1000)}s`,
    ms: 0,
    status: 429,
  };
}

function windowKey(id: ProviderId, lane: FetchLane | undefined): string {
  return lane ? `${id}:${lane}` : id;
}

/** How long until the window has room, or 0. */
function windowWaitMs(key: string): number {
  const lim = WINDOW_LIMIT[key];
  if (!lim) return 0;
  const now = Date.now();
  const stamps = (windowStamps.get(key) ?? []).filter((t) => now - t < lim.ms);
  windowStamps.set(key, stamps);
  if (stamps.length < lim.n) return 0;
  return Math.max(0, stamps[0] + lim.ms - now);
}

function noteWindow(key: string): void {
  if (!WINDOW_LIMIT[key]) return;
  const stamps = windowStamps.get(key) ?? [];
  stamps.push(Date.now());
  windowStamps.set(key, stamps);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serialise `run` behind the provider's queue. `skip` is consulted when the
 * call reaches the FRONT of the queue; a non-null answer is returned in
 * place of a request (the park, or a queue wait past the cap).
 */
function gate<T>(
  id: ProviderId,
  opts: { priority: boolean; lane?: FetchLane; skip: () => T | null },
  run: () => Promise<T>,
): Promise<T> {
  const wkey = windowKey(id, opts.lane);
  const waitGap = async (): Promise<void> => {
    const gap = effectiveGap(id);
    const since = Date.now() - (lastCallAt.get(id) ?? 0);
    if (since < gap) await sleep(gap - since);
  };
  if (opts.priority) {
    // Own chain: spaced among priority callers and by the host gap, never
    // held for the window or the park — a buy must not wait behind Discover.
    const key = `${id}:priority`;
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      await waitGap();
      lastCallAt.set(id, Date.now());
      noteWindow(wkey);
      return run();
    });
    queues.set(key, next.catch(() => undefined));
    return next;
  }
  const enqueuedAt = Date.now();
  queued.set(id, (queued.get(id) ?? 0) + 1);
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    queued.set(id, Math.max(0, (queued.get(id) ?? 1) - 1));
    const early = opts.skip();
    if (early !== null) return early;
    if (Date.now() - enqueuedAt > MAX_QUEUE_WAIT_MS) {
      throw new QueueWaitError(Math.round((Date.now() - enqueuedAt) / 1000));
    }
    const w = windowWaitMs(wkey);
    if (w > 0) await sleep(w);
    await waitGap();
    // The park may have been set while this call waited for the window.
    const late = opts.skip();
    if (late !== null) return late;
    lastCallAt.set(id, Date.now());
    noteWindow(wkey);
    return run();
  });
  // Keep the chain alive on rejection so one failure never wedges the host.
  queues.set(id, next.catch(() => undefined));
  return next;
}

class QueueWaitError extends Error {
  constructor(public readonly waitedS: number) {
    super(`dropped after ${waitedS}s in the queue`);
  }
}

// ── Response reading with a streaming cap ─────────────────────────────

async function readCapped(res: Response, maxBytes = MAX_BYTES): Promise<string> {
  // `await res.arrayBuffer()` then checking the length is what metadata.ts
  // did wrong: the whole body is already in memory by the time you look.
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response exceeded ${Math.round(maxBytes / 1024)} KB cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch JSON from a KNOWN provider host. `path` must start with '/' and is
 * appended verbatim — callers are responsible for encoding their own query
 * values, and the URL constructor rejects anything that would escape the
 * origin (a path of "//evil.com/x" resolves against the fixed origin, and a
 * path containing a scheme throws).
 */
export async function getJson<T>(id: ProviderId, path: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  if (!path.startsWith('/')) {
    return { ok: false, message: 'internal: path must start with /', ms: 0, status: null };
  }
  const host = HOSTS[id];
  if (!host) return { ok: false, message: `internal: unknown provider ${id}`, ms: 0, status: null };

  // Build against a fixed origin so nothing in `path` can redirect the host.
  let url: URL;
  try {
    url = new URL(path, `https://${host}`);
  } catch {
    return { ok: false, message: 'internal: malformed path', ms: 0, status: null };
  }
  if (url.host !== host || url.protocol !== 'https:') {
    return { ok: false, message: 'internal: path escaped the provider origin', ms: 0, status: null };
  }

  // Fail fast while the provider is parked — do not enter the queue. The
  // TRADE path is exempt: a Discover-driven 429 on pump.fun used to lock the
  // local builder's curve lookup out for 20 s and push every pasted-mint buy
  // to the relayer. A priority call that 429s simply extends the park.
  const priority = opts.priority === true;
  if (!priority && cooldownRemainingMs(id) > 0) return parkedResult<T>(id);

  const skip = (): FetchResult<T> | null => (!priority && cooldownRemainingMs(id) > 0 ? parkedResult<T>(id) : null);

  const attempt = async (): Promise<FetchResult<T>> => {
    const s = statsFor(id);
    const started = Date.now();
    s.calls += 1;
    s.lastCallAt = started;
    let status: number | null = null;
    try {
      const res = await fetch(url, {
        method: opts.json === undefined ? 'GET' : 'POST',
        // A 30x to 127.0.0.1 / 169.254.169.254 is the standard SSRF pivot.
        // We never follow one; a provider that starts redirecting is a
        // provider we stop talking to until the code is updated.
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(opts.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...(opts.headers ?? {}),
        },
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      status = res.status;
      if (!res.ok) {
        // A 4xx body usually names the reason (Jupiter: "Could not find any
        // route", "not tradable"); a bare status sent people hunting.
        let detail = '';
        if (res.status !== 429 && res.status >= 400 && res.status < 500) {
          try {
            const text = (await readCapped(res, 2_048)).trim();
            const parsed = text.startsWith('{') ? (JSON.parse(text) as { error?: string; message?: string }) : null;
            detail = (parsed?.error ?? parsed?.message ?? text).replace(/\s+/g, ' ').slice(0, 160);
          } catch {
            /* body unreadable — the status still tells enough */
          }
        }
        let msg: string;
        if (res.status === 429) {
          const parkedMs = park(id, res.headers.get('retry-after'));
          msg = `${id}: rate limited (429) — pausing ${Math.ceil(parkedMs / 1000)}s`;
          // An unread body pins a keep-alive socket until GC.
          void res.body?.cancel().catch(() => undefined);
        } else {
          msg = `${id}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        }
        s.errors += 1;
        s.lastError = msg;
        return { ok: false, message: msg, ms: Date.now() - started, status };
      }
      // A success clears any lingering park — unless the provider's own
      // counters say the next call would be the one refused.
      blockedUntil.delete(id);
      softParkFromHeaders(id, res.headers);
      const text = await readCapped(res, MAX_BYTES_BY_PROVIDER[id] ?? MAX_BYTES);
      const ms = Date.now() - started;
      s.samples.push(ms);
      if (s.samples.length > 20) s.samples.shift();
      if (!text.trim()) return { ok: true, message: 'empty', data: undefined, ms, status };
      return { ok: true, message: 'ok', data: JSON.parse(text) as T, ms, status };
    } catch (err) {
      const raw = (err as Error)?.message ?? 'request failed';
      const msg =
        raw.includes('timed out') || raw.includes('aborted')
          ? `${id}: timed out`
          : raw.includes('redirect')
            ? `${id}: refused a redirect`
            : `${id}: ${raw}`;
      s.errors += 1;
      s.lastError = msg;
      return { ok: false, message: msg, ms: Date.now() - started, status };
    }
  };

  try {
    return await gate<FetchResult<T>>(id, { priority, lane: opts.lane, skip }, attempt);
  } catch (err) {
    if (err instanceof QueueWaitError) {
      const s = statsFor(id);
      s.errors += 1;
      s.lastError = `${id}: busy — ${err.message}`;
      return { ok: false, message: s.lastError, ms: 0, status: null };
    }
    throw err;
  }
}

// ── Tiny TTL cache ────────────────────────────────────────────────────
//
// Discover polls four columns on a timer and the token page re-reads the
// same summary the column already fetched. Without a cache the app would
// burn its rate budget re-asking for rows it has.

interface Entry {
  at: number;
  ttl: number;
  value: unknown;
}

const cache = new Map<string, Entry>();
const CACHE_CAP = 600;

export function cached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl) {
    cache.delete(key);
    return null;
  }
  return e.value as T;
}

export function putCache(key: string, value: unknown, ttlMs: number): void {
  if (cache.size >= CACHE_CAP) {
    // Cheap eviction: drop the oldest quarter rather than tracking LRU order.
    const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < Math.ceil(CACHE_CAP / 4); i++) cache.delete(entries[i][0]);
  }
  cache.set(key, { at: Date.now(), ttl: ttlMs, value });
}

export function clearCache(): void {
  cache.clear();
}

/** Loads in progress, so concurrent misses share ONE fetch. A cold token
 *  page fired summary() three times in the same tick (page, chart, header)
 *  and each ran the full five-provider assembly. */
const inflight = new Map<string, Promise<unknown>>();

/** Run `load` unless a fresh cached value exists. Failures are NOT cached.
 *  Concurrent callers of the same key await the same in-flight load. */
export async function memo<T>(key: string, ttlMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cached<T>(key);
  if (hit !== null) return hit;
  const running = inflight.get(key) as Promise<T | null> | undefined;
  if (running) return running;
  const p = (async (): Promise<T | null> => {
    try {
      const value = await load();
      if (value !== null) putCache(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
