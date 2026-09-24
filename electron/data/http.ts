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
// name a provider and a PATH; the host comes from HOSTS below (Jupiter has
// two, both hardcoded, and a user's key picks between them). Redirects
// are refused outright (a 30x to a private address is the classic bypass),
// responses are capped while streaming rather than after buffering, and
// every call has a hard timeout.
//
// Nothing here is reachable from the renderer except through the typed
// market:* IPC channels, which never accept a host or a URL.

import { humanWait } from '@shared/market';
import type { ProviderId } from '@shared/market';
import { describeBody } from './refusals';

// Re-exported so the classifier's table can be pinned by the same test that
// pins the park it feeds (test/http.test.mjs) without a second bundle.
export { classifyBody, describeBody } from './refusals';
export type { BodyVerdict } from './refusals';

/**
 * Every host this module will talk to.
 *
 * `ProviderId` (shared/market.ts) is the set of MARKET providers — the ones a
 * user switches on and off in Settings, the ones that assemble a
 * `TokenSummary`, the ones the Providers panel lists. Not every host this
 * layer fetches from belongs to that set, and pretending otherwise has a
 * cost: `ProviderId` is the key of `settings.providers`, so widening it means
 * a settings migration and a user-facing toggle for something that is not a
 * market source at all.
 *
 * So the gate keys on a SUPERSET. `merkl` is the first member: a rewards
 * source for the Rewards page, never consulted for a price, a candle or a
 * security check. Everything else — the queue, the gap, the window, the park,
 * the escalating backoff, the redirect refusal, the streaming cap — is
 * identical, because it is literally the same code path.
 */
export type HttpProviderId = ProviderId | 'merkl' | 'lifi' | 'lifi-status';

/** The complete set of hosts this application will ever contact for market
 *  data. Adding a provider means adding a line here, deliberately. */
const HOSTS: Record<HttpProviderId, string> = {
  jupiter: 'lite-api.jup.ag',
  dexscreener: 'api.dexscreener.com',
  pumpfun: 'frontend-api-v3.pump.fun',
  geckoterminal: 'api.geckoterminal.com',
  pumpswap: 'swap-api.pump.fun',
  birdeye: 'public-api.birdeye.so',
  helius: 'mainnet.helius-rpc.com',
  rugcheck: 'api.rugcheck.xyz',
  // Published, funded reward campaigns and this wallet's accrued rewards on
  // the two EVM chains (docs/airdrop-research-2026-09-09.md §8). Keyless.
  merkl: 'api.merkl.xyz',
  // Cross-chain bridge quotes and transfer status. Second member of the
  // superset, same reasoning as merkl: not a market source, never consulted
  // for a price or a security check, but it must obey the one rule this file
  // exists for — the host is hardcoded here and no caller can point it
  // anywhere else.
  lifi: 'li.quest',
  // Same host, its own lane: following a transfer must never wait behind
  // (or be parked with) the quote budget. See the gap table.
  'lifi-status': 'li.quest',
};

/**
 * Jupiter is the one provider with two hosts, and the choice is the user's
 * key (API swarm 2026-09-09 §7).
 *
 * `lite-api.jup.ag` is hardcoded above, is the app's most-called market host,
 * and is on the trade path — and Jupiter's own migration doc says its limit
 * "will be reduced progressively until it is fully retired". The successor is
 * `api.jup.ag`, 1 request/second with a free key.
 *
 * So: no key keeps today's host and today's speed (nothing is taken away from
 * anyone), a key moves off the retiring endpoint. The gap and the window BOTH
 * follow the host — pointing the keyless 8 rps gap at a 1 rps host would park
 * the provider on the second call.
 *
 * The key rides in a header, never in the URL: no URL crosses IPC in this
 * codebase, and a key in a query string ends up in logs.
 */
const JUPITER_HOST_KEYLESS = 'lite-api.jup.ag';
const JUPITER_HOST_KEYED = 'api.jup.ag';

/**
 * The key is PULLED from settings rather than pushed in, so it is registered
 * exactly once (market.attach) and can never go stale: a user pasting a key
 * changes the host, the gap and the window on the very next call, with no
 * settings-change listener to forget to wire up.
 */
let jupiterKeySource: (() => string) | null = null;

export function setJupiterKeySource(fn: (() => string) | null): void {
  jupiterKeySource = fn;
}

/** Static form of the above — for tests and one-shot callers. */
export function setJupiterApiKey(key: string): void {
  const v = typeof key === 'string' ? key.trim() : '';
  jupiterKeySource = v ? () => v : null;
}

function jupiterKey(): string {
  if (!jupiterKeySource) return '';
  try {
    const v = jupiterKeySource();
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    // Settings unreadable is not a reason to fail a market call — stay keyless.
    return '';
  }
}

/** Is a Jupiter key configured right now? */
export function jupiterKeyed(): boolean {
  return jupiterKey().length > 0;
}

/**
 * The key travels as a header on every Jupiter route — including the trade
 * path's quote and swap — so no call site knows about it and it never reaches
 * a URL, a log line or IPC. Jupiter's own portal names `x-api-key`, the same
 * form Birdeye uses.
 */
function jupiterHeader(id: HttpProviderId): Record<string, string> {
  if (id !== 'jupiter') return {};
  const key = jupiterKey();
  return key ? { 'x-api-key': key } : {};
}

export function providerHost(id: HttpProviderId): string {
  if (id === 'jupiter') return jupiterKey() ? JUPITER_HOST_KEYED : JUPITER_HOST_KEYLESS;
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
const MAX_BYTES_BY_PROVIDER: Partial<Record<HttpProviderId, number>> = {
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
  /** route key → requests, capped at ROUTE_ROWS_CAP distinct routes. */
  routes: Map<string, number>;
}

const stats = new Map<HttpProviderId, Stats>();

function statsFor(id: HttpProviderId): Stats {
  let s = stats.get(id);
  if (!s) {
    s = { calls: 0, errors: 0, lastError: null, lastCallAt: null, samples: [], routes: new Map() };
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
  /** Requests per route this session, most-called first — what is actually
   *  spending the budget. Dynamic path segments are collapsed. */
  routes: Array<{ route: string; calls: number }>;
}

/**
 * A request's path with its variable parts collapsed, so forty token pages
 * are one row: base58 keys (32–44 chars) and long hex become `:key`, bare
 * numbers `:n`, and the query string is dropped except for the route's own
 * name where a Jupiter list is told apart by it (`/tokens/v2/search`
 * carries `query=` for both a single mint and a batch — the batch is
 * marked by its commas).
 */
export function routeKey(url: URL): string {
  const path = url.pathname
    .split('/')
    .map((seg) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seg) || /^0x[0-9a-fA-F]{20,}$/.test(seg) || /^[0-9a-fA-F]{32,}$/.test(seg) ? ':key' : /^\d+$/.test(seg) ? ':n' : seg))
    .join('/');
  const q = url.searchParams;
  if (path.endsWith('/tokens/v2/search')) return q.get('query')?.includes(',') ? `${path}?batch` : `${path}?one`;
  if (q.has('sort')) return `${path}?sort=${q.get('sort')}`;
  return path;
}

const ROUTE_ROWS_CAP = 64;

function noteRoute(s: Stats, url: URL): void {
  const key = routeKey(url);
  const cur = s.routes.get(key);
  if (cur !== undefined) s.routes.set(key, cur + 1);
  else if (s.routes.size < ROUTE_ROWS_CAP) s.routes.set(key, 1);
}

export function telemetry(id: HttpProviderId): ProviderTelemetry {
  const s = statsFor(id);
  const sorted = [...s.samples].sort((a, b) => a - b);
  return {
    calls: s.calls,
    errors: s.errors,
    lastError: s.lastError,
    lastCallAt: s.lastCallAt,
    latencyMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
    routes: [...s.routes.entries()].map(([route, calls]) => ({ route, calls })).sort((a, b) => b.calls - a.calls),
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
//   deprecated but still un-throttled today (api.jup.ag keyless is 0.5 rps,
//   1 rps with a free key — which is why the key switches the gap too).
const MIN_GAP_MS: Record<HttpProviderId, number> = {
  // Overridden per host by baseGap() — see JUPITER_HOST_* above. This entry is
  // the keyless lite-api figure and stays the fallback.
  jupiter: 120,
  dexscreener: 250,
  pumpfun: 260,
  geckoterminal: 2_100, // 30/min with headroom
  // swap-api.pump.fun — MEASURED 2026-09-21, because the Wallet Scout's scan
  // "worked for two minutes and then got limited". The `x-ratelimit-limit:
  // 1000` it answers is not the limit that bites: a Cloudflare rule (HTTP
  // 429, body `error code: 1015`, `Retry-After: 34`) blocks the IP for ~35 s
  // after roughly 22 requests inside a short window, and every request made
  // during the block extends it. 40 calls with no gap: 11 answered. 30 at
  // 1 s: the 23rd refused. 30 at 2.5 s and 30 at 3 s: all answered. The old
  // 300 ms gap tripped it a dozen calls into every scan, the park + slow
  // start then crawled for a minute, and the cycle repeated — which is what
  // "two minutes then limited" was. 2 s is ~15 per 30 s, under the edge with
  // room for the token page's launch scan to share the host.
  pumpswap: 2_000,
  // The free package is one request per second, per account — the old
  // 120 ms gap 429'd every free-key user's chart and holders panel by the
  // second call of any burst.
  birdeye: 1_100,
  helius: 110,
  rugcheck: 1_100, // measured 2026-08-30: 15 burst, ~1/s sustained
  //
  // Merkl: documented 10 req/s anonymous; observed 2026-09-09
  // `x-ratelimit-limit: 4200, 4200;w=60` (= 70/s) on both routes. The gap is
  // 1.1 s anyway — a hundredth of what is on offer — because the ceiling is
  // not the constraint here. This provider is asked for at most three things
  // (one campaign list per enabled EVM chain, plus a rewards lookup the user
  // clicks for), so nothing on screen waits on it, and a source whose whole
  // purpose is to state facts about someone's money should never be the
  // reason a keyless public API starts refusing this install. Room to move
  // exists if a later caller needs it; a park never had to be recovered from.
  merkl: 1_100,
  //
  // LI.FI: MEASURED 2026-09-11, and the tightest budget in this file by two
  // orders of magnitude. `/v1/quote` allows **75 calls per 7200 s** per IP —
  // and the bucket was already at 67 on the first call of the day, because it
  // is shared across everyone behind the same NAT. Exhausting it returns
  // `retry-after: ~6600`, i.e. the bridge is DEAD FOR TWO HOURS.
  //
  // 96 s between calls is 75 per two hours exactly. That is far too slow for
  // a panel that re-quotes as the user types, which is precisely the point:
  // the caller must cache and quote on demand, never on a timer, and the gap
  // is set where it is so that a bug which does quote on a timer is throttled
  // into visibility rather than silently burning the day's budget.
  //
  // Status polling is a separate endpoint with a separate, generous bucket
  // (100/60 s), so following a transfer never spends the quote budget.
  lifi: 96_000,
  // /v1/status has its own, generous bucket (100/60 s) and its own park:
  // until 2026-09-11 it shared the quote's 96 s gap, so a poll of N transfers
  // took 96 s × N and a quote 429 silenced status for two hours. Found by audit.
  'lifi-status': 1_000,
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
  // MEASURED 2026-09-19: pump answers `x-ratelimit-limit: 60` on BOTH
  // /home-feed and /coins, and its `x-ratelimit-remaining` is NOT usable as
  // a budget - twelve calls in three seconds read 59, 59, 59, 59, 59, 58,
  // 59 ... , which is several edge nodes each counting their own share. So
  // the app cannot see how much of the host's allowance it has spent, and
  // the safe reading is the pessimistic one: 60/60 s for the whole host,
  // whichever route asks.
  //
  // That allowance is carved between the two things that POLL. They also
  // share `pumpfun:poll` below, which is the ceiling for background traffic
  // as a whole and leaves the rest of the host's minute for the lookups a
  // user's own click makes.
  'pumpfun:list': { n: 30, ms: 60_000 },
  // Callouts ride the pump.fun host the app already uses, but they are
  // intel a user reads, never anything the trade path waits on. Twelve a
  // minute is six times what the 30 s feed poll actually spends, and the
  // rest stays for the coin lookups a buy depends on. A callouts burst must
  // never be the reason a trade cannot price its token.
  'pumpfun:callout': { n: 12, ms: 60_000 },
  // Both polls together. 40 of an advertised 60 leaves 20 a minute for
  // whatever the user is doing, which is the number that matters: the
  // callouts rail refusing is annoying, a pasted mint that cannot be priced
  // is a trade that does not happen.
  'pumpfun:poll': { n: 40, ms: 60_000 },
  geckoterminal: { n: 28, ms: 60_000 },
  rugcheck: { n: 50, ms: 60_000 },
  // LI.FI's real ceiling is a TWO-HOUR window, not a minute — 75 quotes per
  // 7200 s, measured. The window machinery below is per-minute by design, and
  // stretching it to two hours would hold a user's click for up to 96 s with
  // no way to say why. So the gap above carries this one, and the caller
  // surfaces the provider's own `retry-after` when the budget is gone: a
  // two-hour outage is a state the UI must name, not something to hide behind
  // a spinner.
  //
  // No `merkl` entry, deliberately. A window earns its place where a gap
  // cannot hold the ceiling on its own — which is what the priority lane
  // does, since it keeps its own `lastCallAt` chain and can run at twice the
  // gap rate. Nothing calls Merkl with `priority`, so its 1.1 s gap IS the
  // ceiling: ~54 calls a minute against a published 4,200 per 60 s. Adding a
  // number here would be inventing a limit no header states, and the cost of
  // guessing low is a refused refresh the user asked for.
};

/**
 * Lanes that spend from a budget bigger than their own.
 *
 * A lane budget carves an allowance between features; it cannot create more
 * of it. Without this, `pumpfun:list` at 30 and `pumpfun:callout` at 12 are
 * two promises adding up to 42 that nothing holds together - and when the
 * host refuses, the smallest lane is the one that loses (user report,
 * 2026-09-19: "pump.fun not answering" in the callouts rail while Discover
 * carried on working).
 *
 * Only POLLERS are grouped, deliberately. A call the user made by opening a
 * token is not background traffic and must not queue behind a rail that
 * refreshes itself.
 */
const LANE_GROUP: Record<string, string> = {
  'pumpfun:list': 'pumpfun:poll',
  'pumpfun:callout': 'pumpfun:poll',
};

/**
 * Keyless: lite-api is NOT un-throttled any more. Measured 2026-09-20 on
 * the Discover page: the 120 ms gap let a pass burst eight requests a second
 * and the host answered 429 at ~46 calls a minute (parking Jupiter for 40 s
 * twice in 150 s, with the New and Trending columns saying so). Probed the
 * same day: twelve requests at 2/s and six at 1/s all 200. So the gap is
 * 500 ms — bursts of two a second, which the host tolerates — and the
 * window below is the honest minute ceiling; without it `60_000 / gap`
 * would grant 120 a minute, twice what the host serves.
 * Keyed: api.jup.ag documents 1 request/second.
 */
const JUPITER_GAP_KEYLESS = 500;
const JUPITER_GAP_KEYED = 1_000;
/** Per minute, both lanes together. lite-api's ceiling is ~60 (no header
 *  says so; measured by its 429s), api.jup.ag's documented 1 rps is 60. */
const JUPITER_WINDOW_KEYLESS = 50;
const JUPITER_WINDOW_KEYED = 55;

/** The gap in force for a provider right now, before slow start. Jupiter's
 *  depends on which host the key selected; every other provider is static. */
function baseGap(id: HttpProviderId): number {
  if (id === 'jupiter') return jupiterKey() ? JUPITER_GAP_KEYED : JUPITER_GAP_KEYLESS;
  return MIN_GAP_MS[id];
}

/**
 * The window in force for a key, or undefined.
 *
 * Jupiter had NO window entry at all, which is how it ended up the one host
 * with a gap and no per-minute budget. Its window is derived from its own
 * gap rather than invented: `60_000 / gap` is the rate the gap already
 * implies. That is not redundant — the priority lane and the normal lane keep
 * separate `lastCallAt` chains, so the two together can run at twice the gap
 * rate (§4 of the swarm measured 11 of 22 gaps at 0 ms). The window is shared
 * by both lanes and is what actually holds the ceiling.
 */
function windowLimitFor(key: string): { n: number; ms: number } | undefined {
  if (key === 'jupiter') {
    // The lower of what the gap implies and the host's real ceiling.
    const implied = Math.floor(60_000 / baseGap('jupiter'));
    return { n: Math.min(implied, jupiterKey() ? JUPITER_WINDOW_KEYED : JUPITER_WINDOW_KEYLESS), ms: 60_000 };
  }
  return WINDOW_LIMIT[key];
}

/** Host, gap and window for a provider as they stand — diagnostics and the
 *  tests that pin the Jupiter host switch. */
export function providerLimits(id: HttpProviderId): {
  host: string;
  gapMs: number;
  window: { n: number; ms: number } | null;
} {
  return { host: providerHost(id), gapMs: baseGap(id), window: windowLimitFor(id) ?? null };
}

/** The window for a provider OR one of its `provider:lane` keys. Separate
 *  from `providerLimits` because a lane has no host and no gap of its own —
 *  it only carves the provider's allowance, and the test that pins the sum
 *  needs to read the carve without pretending a lane is a provider. */
export function windowBudget(key: string): { n: number; ms: number } | null {
  return windowLimitFor(key) ?? null;
}

/** Route classes with their own window. Callers tag list routes; everything
 *  else is the provider's default lane. */
export type FetchLane = 'list' | 'callout';

const lastCallAt = new Map<HttpProviderId, number>();
/** One serial chain per provider, and a SECOND one for priority calls — they
 *  jump the normal queue but still space themselves out. Six liquidation
 *  quotes fired together used to read the same `lastCallAt` and hit Jupiter
 *  in one burst. */
const queues = new Map<string, Promise<unknown>>();
const windowStamps = new Map<string, number[]>();
/** Calls waiting in a provider's normal queue right now. */
const queued = new Map<HttpProviderId, number>();

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
const blockedUntil = new Map<HttpProviderId, number>();
const parkStrikes = new Map<HttpProviderId, { count: number; lastAt: number }>();
const RATE_LIMIT_COOLDOWN_MS = 20_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 120_000;
const STRIKE_DECAY_MS = 5 * 60_000;

/** Milliseconds until this provider is usable again, or 0. */
export function cooldownRemainingMs(id: HttpProviderId): number {
  return Math.max(0, (blockedUntil.get(id) ?? 0) - Date.now());
}

/** Calls waiting in this provider's normal queue — for the diagnostics panel. */
export function queueDepth(id: HttpProviderId): number {
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

/** Park the provider after a refusal. Returns the park length chosen. */
/**
 * Where this module's lines go (2026-09-21).
 *
 * `http.ts` logged NOTHING until a logging audit found it, and it is one of
 * the two layers every feature sits on. A park is the single most common
 * explanation for "no price", "the chart is empty" and "Discover is blank",
 * and it was visible only in a live panel — a user who closed the app took
 * the evidence with them. Injected so the module stays offline-testable.
 */
type HttpLog = (level: 'info' | 'warn' | 'error', line: string) => void;
let httpLog: HttpLog = () => {};
export function attachLog(fn: HttpLog): void {
  httpLog = fn;
}

function park(id: HttpProviderId, retryAfter: string | null, quota = false): number {
  const now = Date.now();
  // Logged only when the park is NEW or longer than the one already running,
  // so a backlog firing into an existing park cannot fill the log with the
  // same sentence — the exact shape the 2026-09-06 storm had.
  const wasUntil = blockedUntil.get(id) ?? 0;
  // A spent allowance does not escalate and does not listen to Retry-After:
  // the provider is telling us to come back next billing period, and every
  // knock before then is another certain failure.
  if (quota) {
    quotaParked.add(id);
    const until = now + QUOTA_PARK_MS;
    if (until > wasUntil) {
      blockedUntil.set(id, until);
      httpLog('warn', `provider ${id}: allowance spent — paused for ${Math.round(QUOTA_PARK_MS / 60_000)} min. Top up the plan or switch it off in Settings.`);
    }
    slowStartUntil.set(id, until + SLOW_START_MS);
    return QUOTA_PARK_MS;
  }
  const prev = parkStrikes.get(id);
  const count = prev && now - prev.lastAt < STRIKE_DECAY_MS ? prev.count + 1 : 1;
  parkStrikes.set(id, { count, lastAt: now });
  const escalated = Math.min(RATE_LIMIT_COOLDOWN_MAX_MS, RATE_LIMIT_COOLDOWN_MS * 2 ** (count - 1));
  // `Retry-After` may EXTEND the park; it may never shorten it.
  //
  // It used to replace the escalation outright, which two shapes exploited.
  // GeckoTerminal answers `Retry-After: 0` (observed 2026-09-09); that hits
  // the parser's 2 s floor and replaced 20 s — so the provider we have the
  // least budget with was the one we re-entered fastest. And any provider
  // repeating a short wait on every refusal defeated the 20 → 40 → 80 s
  // ladder entirely.
  //
  // The cost of this rule is waiting 20 s when a provider said 3 and meant
  // it. That is the safe direction to be wrong in: under-waiting is what
  // produced the 429 storms this machinery was built for, and over-waiting
  // only costs us freshness.
  const length = Math.max(escalated, parseRetryAfterMs(retryAfter) ?? 0);
  const until = now + length;
  if (until > wasUntil) {
    blockedUntil.set(id, until);
    httpLog(
      'warn',
      `provider ${id} (${providerHost(id)}) rate limited — paused ${Math.round(length / 1000)}s${count > 1 ? `, strike ${count}` : ''}${retryAfter ? ` (it asked for ${retryAfter})` : ''}. Prices and charts from it are stale until then.`,
    );
  }
  slowStartUntil.set(id, until + SLOW_START_MS);
  return length;
}

/**
 * "You are out of allowance", as opposed to "you are going too fast".
 *
 * MEASURED on a user's session, 2026-09-16: Birdeye answered
 * `HTTP 400 — Compute units usage limit exceeded` and the app made
 * **1,743 calls and collected 1,743 errors**. Every one failed, and every one
 * was retried, because only a 429 parked a provider and this is a 400.
 *
 * The two are not the same thing and must not share a cool-down:
 *
 *   • A 429 says SLOW DOWN. Waiting twenty seconds fixes it, so the park is
 *     short and the ladder tops out at two minutes.
 *   • A spent plan says STOP. The allowance resets on the provider's own
 *     billing clock — usually a month, sometimes a day — and retrying at any
 *     speed cannot help. Twenty seconds later is 1,743 more failures.
 *
 * So a quota refusal parks for hours, and says what it is. The user's fix is
 * to top up the plan or turn the provider off, and neither of those happens
 * faster because the app kept knocking.
 *
 * Matched on the MESSAGE, not the status, because providers disagree about
 * the status: Birdeye uses 400, others use 402 Payment Required or a 403.
 * The phrases below are the ones that actually appeared, kept narrow — a
 * false positive here silences a working provider for six hours, so "limit"
 * or "exceeded" alone is deliberately not enough.
 */
const QUOTA_PHRASES = [
  'compute unit',
  'quota exceeded',
  'quota exhausted',
  'out of credits',
  'insufficient credits',
  'credit limit',
  'monthly limit',
  'daily limit',
  'plan limit',
  'payment required',
  'upgrade your plan',
];

/** Six hours. Long enough that a monthly allowance is not re-tested every
 *  few minutes, short enough that a top-up is noticed the same day. */
const QUOTA_PARK_MS = 6 * 60 * 60_000;

/**
 * Does this failure mean the ALLOWANCE is spent rather than the rate?
 *
 * **429 is deliberately not here.** It is definitionally "too fast", the
 * status free providers return constantly, and a six-hour park on one that
 * was merely throttled is a far worse outcome than a slow stand-down on one
 * that really is spent. A provider that answers a dead plan with 429 is
 * caught by the failure-streak breaker below instead, which needs to
 * recognise nothing.
 */
export function isQuotaExhausted(status: number, message: string): boolean {
  if (status === 402) return true; // Payment Required means exactly this
  if (status !== 400 && status !== 401 && status !== 403) return false;
  const m = message.toLowerCase();
  return QUOTA_PHRASES.some((p) => m.includes(p));
}

/** Is this provider parked because its ALLOWANCE is spent, rather than
 *  because it was going too fast? The two need different words. */
export function parkIsQuota(id: HttpProviderId): boolean {
  return quotaParked.has(id) && cooldownRemainingMs(id) > 0;
}
const quotaParked = new Set<HttpProviderId>();


/**
 * The net under every other rule: a provider that keeps failing is stood
 * down, whatever it is failing with.
 *
 * The quota classifier above needs to RECOGNISE a phrase. This one does not
 * need to understand anything — it counts. A provider whose last
 * `FAIL_STREAK_PARK` calls all failed is not serving this app right now, and
 * the next call is very probably the same failure again. That is the general
 * form of the Birdeye case (1,743 for 1,743) and it would have stopped it at
 * ten instead of at seventeen hundred, without anyone having predicted the
 * wording of the error.
 *
 * Deliberately generous and short: ten in a row, and a park that starts at a
 * minute and doubles to an hour. It must not fire on the ordinary bad
 * afternoon a free provider has — one success clears it completely.
 */
const failStreak = new Map<HttpProviderId, number>();
const FAIL_STREAK_PARK = 10;
const STREAK_PARK_MS = 60_000;
const STREAK_PARK_MAX_MS = 60 * 60_000;

function noteFailure(id: HttpProviderId, why: string): void {
  const n = (failStreak.get(id) ?? 0) + 1;
  failStreak.set(id, n);
  if (n < FAIL_STREAK_PARK || cooldownRemainingMs(id) > 0) return;
  // Every FAIL_STREAK_PARK-th failure in an unbroken run extends the park,
  // so a provider that is still dead after the first minute earns two, then
  // four — and one that recovers pays nothing.
  const doublings = Math.floor(n / FAIL_STREAK_PARK) - 1;
  const length = Math.min(STREAK_PARK_MAX_MS, STREAK_PARK_MS * 2 ** doublings);
  const until = Date.now() + length;
  if (until > (blockedUntil.get(id) ?? 0)) blockedUntil.set(id, until);
  slowStartUntil.set(id, until + SLOW_START_MS);
  const st = stats.get(id);
  if (st) {
    st.lastError = `${id}: ${n} failures in a row — paused ${Math.ceil(length / 60_000)}m. Last: ${why.replace(`${id}: `, '')}`;
  }
}

/**
 * Slow start after a park. A park ending is not the limit ending: the
 * backlog that built up behind it resumes at the full gap rate and trips the
 * same window again a few seconds later (2026-09-06: swap-api was parked
 * twice in a row, 20 s then 40 s, exactly like that). For a minute after a
 * park the gap is doubled, so the provider is re-entered at half speed.
 */
const slowStartUntil = new Map<HttpProviderId, number>();
const SLOW_START_MS = 60_000;

function effectiveGap(id: HttpProviderId): number {
  const gap = baseGap(id);
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

function softParkFromHeaders(id: HttpProviderId, headers: { get(name: string): string | null }): void {
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

function parkedResult<T>(id: HttpProviderId): FetchResult<T> {
  transportFailures += 1;
  const cooling = cooldownRemainingMs(id);
  return {
    ok: false,
    message: parkIsQuota(id)
      ? `${id}: allowance spent — paused ${humanWait(cooling)}`
      : `${id}: rate limited, retrying in ${humanWait(cooling)}`,
    ms: 0,
    status: 429,
  };
}

/**
 * How many times a call has failed WITHOUT the provider having answered.
 *
 * A park, a 429, a timeout, a dropped queue wait, a 5xx: the provider did
 * not tell us anything about the thing we asked for. That is a different
 * event from a 404 or an error body, which ARE answers - "this token has no
 * pair" is a fact, and a fact must not be overruled by a value from four
 * minutes ago.
 *
 * `memo` reads this counter either side of a load. If it moved and the load
 * came back empty, the emptiness is the network's, not the provider's, and
 * the last good value is served instead of a blank panel. The reading is a
 * heuristic - a concurrent call on another provider can move the counter
 * too - and the cost of being wrong is bounded: a real past value for that
 * exact key, carrying its own timestamp, where the alternative was an em
 * dash.
 */
let transportFailures = 0;

export function transportFailureCount(): number {
  return transportFailures;
}

/**
 * Every window a call has to fit inside.
 *
 * A lane is bounded by its OWN budget AND by the provider's, because a
 * provider's limit is usually one allowance for the whole host and the app
 * has no way to see it move. pump.fun is the case that proved it: both
 * routes advertise 60/60 s, so budgeting 55/min for the list lane and 20/min
 * for callouts let the app plan 75 against a ceiling of 60 - and the
 * smallest lane is the one that gets refused (user report, 2026-09-19:
 * "pump.fun not answering" in the callouts rail while Discover kept
 * working).
 *
 * Checking only the lane was the bug. A lane budget can carve the host's
 * allowance between features; it cannot create more of it.
 */
function windowKeys(id: HttpProviderId, lane: FetchLane | undefined): string[] {
  if (!lane) return [id];
  const key = `${id}:${lane}`;
  const group = LANE_GROUP[key];
  return group ? [id, key, group] : [id, key];
}

/** The keys a call is counted against, for diagnostics and the test that
 *  pins the grouping. Exported rather than re-derived in the test: a pin
 *  that reimplements the rule cannot catch the rule changing. */
export function windowKeysFor(id: HttpProviderId, lane: FetchLane | undefined): string[] {
  return windowKeys(id, lane);
}

/** How long until ONE window has room, or 0. */
function windowWaitForKey(key: string): number {
  const lim = windowLimitFor(key);
  if (!lim) return 0;
  const now = Date.now();
  const stamps = (windowStamps.get(key) ?? []).filter((t) => now - t < lim.ms);
  windowStamps.set(key, stamps);
  if (stamps.length < lim.n) return 0;
  return Math.max(0, stamps[0] + lim.ms - now);
}

/** The tightest of every window this call sits inside. */
function windowWaitMs(keys: string[]): number {
  let worst = 0;
  for (const k of keys) worst = Math.max(worst, windowWaitForKey(k));
  return worst;
}

/**
 * How much of a provider's window is spent right now.
 *
 * Read-only, and it prunes nothing: the stamps are pruned by the gate on the
 * next call, and a diagnostics read must not change what the next request is
 * allowed to do. Null when the key has no window - Merkl and LI.FI are held
 * by their gap alone, and inventing a number for them would be a claim no
 * header supports.
 */
export function windowUsage(key: string): { used: number; n: number; ms: number } | null {
  const lim = windowLimitFor(key);
  if (!lim) return null;
  const now = Date.now();
  const used = (windowStamps.get(key) ?? []).filter((t) => now - t < lim.ms).length;
  return { used, n: lim.n, ms: lim.ms };
}

/** A call spends from every budget it was counted against - including the
 *  provider's, which is what stops the lanes from outspending the host. */
function noteWindow(keys: string[]): void {
  for (const key of keys) {
    if (!windowLimitFor(key)) continue;
    const stamps = windowStamps.get(key) ?? [];
    stamps.push(Date.now());
    windowStamps.set(key, stamps);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serialise `run` behind the provider's queue. `skip` is consulted when the
 * call reaches the FRONT of the queue; a non-null answer is returned in
 * place of a request (the park, or a queue wait past the cap).
 */
function gate<T>(
  id: HttpProviderId,
  opts: { priority: boolean; lane?: FetchLane; skip: () => T | null },
  run: () => Promise<T>,
): Promise<T> {
  const wkeys = windowKeys(id, opts.lane);
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
      noteWindow(wkeys);
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
    const w = windowWaitMs(wkeys);
    if (w > 0) await sleep(w);
    await waitGap();
    // The park may have been set while this call waited for the window.
    const late = opts.skip();
    if (late !== null) return late;
    lastCallAt.set(id, Date.now());
    noteWindow(wkeys);
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
export async function getJson<T>(id: HttpProviderId, path: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
  if (!path.startsWith('/')) {
    return { ok: false, message: 'internal: path must start with /', ms: 0, status: null };
  }
  const host = providerHost(id);
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
    noteRoute(s, url);
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
          // Jupiter's key travels as a header on every route, including the
          // trade path's quote/swap, so no call site needs to know about it
          // and it never reaches a URL, a log line or IPC.
          ...jupiterHeader(id),
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
        // A SPENT ALLOWANCE is not a rate limit, whatever status carries it.
        // Birdeye says it with HTTP 400 ("Compute units usage limit
        // exceeded"), which used to take the plain-error branch below and
        // park for nothing at all — measured on a user's session, 1,743
        // calls and 1,743 errors, every one of them certain to fail.
        if (isQuotaExhausted(res.status, detail)) {
          transportFailures += 1;
          const parkedMs = park(id, null, true);
          msg = `${id}: allowance spent — ${detail || `HTTP ${res.status}`}. Paused ${Math.round(parkedMs / 3_600_000)}h; top up the plan or switch it off in Settings.`;
          void res.body?.cancel().catch(() => undefined);
        } else if (res.status === 429) {
          transportFailures += 1;
          const parkedMs = park(id, res.headers.get('retry-after'));
          msg = `${id}: rate limited (429) — pausing ${Math.ceil(parkedMs / 1000)}s`;
          // An unread body pins a keep-alive socket until GC.
          void res.body?.cancel().catch(() => undefined);
        } else {
          // A 5xx is the provider being broken, not the provider answering.
          if (res.status >= 500) transportFailures += 1;
          msg = `${id}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        }
        s.errors += 1;
        s.lastError = msg;
        noteFailure(id, msg);
        return { ok: false, message: msg, ms: Date.now() - started, status };
      }
      // A 2xx is not yet a success. The body is read FIRST — still streamed,
      // still capped per provider — and classified, because a provider that
      // refuses politely (GeckoTerminal answers a throttle with HTTP 200 and
      // a JSON error body) used to take the success path below and DELETE an
      // existing park on the way through. See refusals.ts.
      const text = await readCapped(res, MAX_BYTES_BY_PROVIDER[id] ?? MAX_BYTES);
      const verdict = describeBody(id, res.status, res.headers, text);
      if (verdict.verdict === 'refused') {
        // Exactly the 429 path: same park(), same Retry-After clamp, same
        // escalation, same strike decay. Nothing is un-parked. Unless the
        // refusal names a spent ALLOWANCE, which no cool-down fixes.
        transportFailures += 1;
        const spent = isQuotaExhausted(res.status, verdict.detail ?? '');
        const parkedMs = park(id, spent ? null : res.headers.get('retry-after'), spent);
        const msg = spent
          ? `${id}: allowance spent — ${verdict.detail ?? `HTTP ${res.status}`}. Paused ${Math.round(parkedMs / 3_600_000)}h; top up the plan or switch it off in Settings.`
          : `${id}: rate limited (HTTP ${res.status}${verdict.detail ? ` — ${verdict.detail}` : ''}) — pausing ${Math.ceil(parkedMs / 1000)}s`;
        s.errors += 1;
        s.lastError = msg;
        noteFailure(id, msg);
        return { ok: false, message: msg, ms: Date.now() - started, status };
      }
      if (verdict.verdict === 'error') {
        // The provider answered, but not with data. The call fails; no park
        // is created, and — the point of this branch — no park is cleared.
        const msg = `${id}: HTTP ${res.status}${verdict.detail ? ` — ${verdict.detail}` : ' — error body'}`;
        s.errors += 1;
        s.lastError = msg;
        noteFailure(id, msg);
        return { ok: false, message: msg, ms: Date.now() - started, status };
      }
      // A success clears any lingering park — unless the provider's own
      // counters say the next call would be the one refused.
      blockedUntil.delete(id);
      // …and ends the streak. One good answer is enough: the streak is about
      // a provider that is not working, not about its lifetime record.
      failStreak.delete(id);
      quotaParked.delete(id);
      softParkFromHeaders(id, res.headers);
      const ms = Date.now() - started;
      s.samples.push(ms);
      if (s.samples.length > 20) s.samples.shift();
      if (!text.trim()) return { ok: true, message: 'empty', data: undefined, ms, status };
      return { ok: true, message: 'ok', data: JSON.parse(text) as T, ms, status };
    } catch (err) {
      transportFailures += 1;
      const raw = (err as Error)?.message ?? 'request failed';
      const msg =
        raw.includes('timed out') || raw.includes('aborted')
          ? `${id}: timed out`
          : raw.includes('redirect')
            ? `${id}: refused a redirect`
            : `${id}: ${raw}`;
      s.errors += 1;
      s.lastError = msg;
      // A transport failure counts too. "fetch failed" on a loop is the same
      // waste as a 400 on a loop, and three providers in the reported
      // session were failing exactly that way.
      noteFailure(id, msg);
      return { ok: false, message: msg, ms: Date.now() - started, status };
    }
  };

  try {
    return await gate<FetchResult<T>>(id, { priority, lane: opts.lane, skip }, attempt);
  } catch (err) {
    if (err instanceof QueueWaitError) {
      transportFailures += 1;
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
/**
 * 600 until 2026-09-20, and that was the silent cause of a good share of the
 * Jupiter spend: four Discover columns of forty rows keep eight to ten keys
 * per row (the Jupiter row, its longer copy, the Shield verdict, the chain
 * read, the mint facts, the rug and odds memos, the seek…) — well over a
 * thousand — so every fill evicted a quarter of the cache and the memos
 * never survived to the next pass. Each entry is a few kilobytes; five
 * thousand is a few megabytes, on a desktop.
 */
const CACHE_CAP = 5_000;

/**
 * How long an expired entry is kept around after its TTL.
 *
 * Not to be served as current - `cached` still refuses it the millisecond it
 * goes stale, and every caller of that keeps the semantics it had. It is
 * kept so that when the network fails, the panel can show what it last knew
 * with its own timestamp on it, instead of going blank. A parked provider
 * used to empty the token page, the holders list and the intel fields into
 * em dashes, and the user reads that as "the app is broken", not "pump.fun
 * is throttling me".
 *
 * Ten TTLs, capped at five minutes. The cap is what keeps it honest: a
 * 20-second price is worth showing at 90 seconds with "90s ago" beside it,
 * and is worth nothing at all at half an hour.
 */
const STALE_GRACE_MULTIPLE = 10;
const STALE_GRACE_MAX_MS = 5 * 60_000;

function graceFor(ttl: number): number {
  return Math.min(ttl * STALE_GRACE_MULTIPLE, STALE_GRACE_MAX_MS);
}

export function cached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.at;
  if (age > e.ttl) {
    // Expired, but keep it within grace: it is the fallback for a failed
    // reload. Past grace it is deleted exactly as before.
    if (age > e.ttl + graceFor(e.ttl)) cache.delete(key);
    return null;
  }
  return e.value as T;
}

/**
 * The last good value for a key, past its TTL but inside grace, with its
 * age. Null when there is none. Callers that show it MUST show the age with
 * it - a stale number presented as current is worse than no number.
 */
export function staleValue<T>(key: string): { value: T; ageMs: number } | null {
  const e = cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.at;
  if (age <= e.ttl) return null;
  if (age > e.ttl + graceFor(e.ttl)) {
    cache.delete(key);
    return null;
  }
  return { value: e.value as T, ageMs: age };
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

/**
 * Run `load` unless a fresh cached value exists. Failures are NOT cached.
 * Concurrent callers of the same key await the same in-flight load.
 *
 * And when the load comes back empty because the NETWORK failed - a park, a
 * 429, a timeout - the last good value is served instead, for as long as
 * `graceFor` allows. That is the whole difference between a throttled
 * provider looking like a slow app and looking like a broken one.
 *
 * A load that came back empty because the provider ANSWERED and said there
 * is nothing is left alone: no transport failure was recorded, so the empty
 * answer stands. Deleting a token's pair and then re-serving it from four
 * minutes ago is the "polite refusal" bug wearing a different hat.
 */
export async function memo<T>(key: string, ttlMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cached<T>(key);
  if (hit !== null) return hit;
  const running = inflight.get(key) as Promise<T | null> | undefined;
  if (running) return running;
  const p = (async (): Promise<T | null> => {
    const failuresBefore = transportFailures;
    try {
      const value = await load();
      if (value !== null) {
        putCache(key, value, ttlMs);
        return value;
      }
      if (transportFailures === failuresBefore) return null;
      const stale = staleValue<T>(key);
      return stale ? stale.value : null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

