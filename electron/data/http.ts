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

const MIN_GAP_MS: Record<ProviderId, number> = {
  jupiter: 120,
  dexscreener: 220,
  pumpfun: 260,
  geckoterminal: 2_100, // 30/min with headroom
  pumpswap: 300,
  birdeye: 120,
  helius: 60,
  rugcheck: 1_100, // measured 2026-08-30: 15 burst, ~1/s sustained
};

const lastCallAt = new Map<ProviderId, number>();
const queues = new Map<ProviderId, Promise<unknown>>();

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
 * On a 429 the provider is parked for a while and further calls fail fast,
 * without a request and without occupying the queue.
 */
const blockedUntil = new Map<ProviderId, number>();
const RATE_LIMIT_COOLDOWN_MS = 20_000;

/** Seconds until this provider is usable again, or 0. */
export function cooldownRemainingMs(id: ProviderId): number {
  return Math.max(0, (blockedUntil.get(id) ?? 0) - Date.now());
}

function gate<T>(id: ProviderId, run: () => Promise<T>, priority = false): Promise<T> {
  if (priority) {
    // No chaining: wait only for the host gap, then go. The queue keeps its
    // own last-call bookkeeping through lastCallAt, so the gap still holds.
    return (async () => {
      const gap = MIN_GAP_MS[id];
      const since = Date.now() - (lastCallAt.get(id) ?? 0);
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      lastCallAt.set(id, Date.now());
      return run();
    })();
  }
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const gap = MIN_GAP_MS[id];
    const since = Date.now() - (lastCallAt.get(id) ?? 0);
    if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
    lastCallAt.set(id, Date.now());
    return run();
  });
  // Keep the chain alive on rejection so one failure never wedges the host.
  queues.set(id, next.catch(() => undefined));
  return next;
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
  const cooling = cooldownRemainingMs(id);
  if (cooling > 0 && opts.priority !== true) {
    return {
      ok: false,
      message: `${id}: rate limited, retrying in ${Math.ceil(cooling / 1000)}s`,
      ms: 0,
      status: 429,
    };
  }

  return gate(id, async () => {
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
        const msg = res.status === 429 ? `${id}: rate limited (429)` : `${id}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        if (res.status === 429) blockedUntil.set(id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        s.errors += 1;
        s.lastError = msg;
        return { ok: false, message: msg, ms: Date.now() - started, status };
      }
      // A success clears any lingering park.
      blockedUntil.delete(id);
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
  }, opts.priority === true);
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
