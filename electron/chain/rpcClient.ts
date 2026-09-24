// Thin Solana JSON-RPC HTTP client (fetch-based, no SDK). Only the calls
// the risk engine actually needs. Every method returns a typed result and
// never throws — a dead RPC must degrade the engine, not crash it.

import { base58Encode } from './base58';
import { classifyRpcFailure, credentialsMessage, safeHost } from '../../shared/rpcErrors';
import * as heliusBudget from '../system/heliusBudget';

export interface AccountInfo {
  /** Owner program id, base58. */
  owner: string;
  /** Raw account data. */
  data: Buffer;
  lamports: number;
}

export interface RpcResult<T> {
  ok: boolean;
  message: string;
  data?: T;
}

let nextId = 1;

// ── Transport resilience ──────────────────────────────────────────────
//
// 2026-09-02: a live buy died on `account read: RPC HTTP 500` from the Helius
// endpoint (Cloudflare-fronted; the same front had answered the priority
// socket with a 520 eighteen seconds earlier — a VPN exit being throttled is
// the usual cause). One transport hiccup on one endpoint should not kill an
// order when a second endpoint is configured and healthy. So every call:
//   1. retries ONCE after a short pause on a 5xx / connection error (never on
//      a JSON-RPC error — those are answers, not outages; never on a timeout —
//      the caller's budget is spent);
//   2. then, if a fallback endpoint is registered and differs, tries it once.
// Each fallback use is reported (rate-limited) so the user learns their
// primary is unhealthy instead of wondering why a trade took longer.

let fallbackHttpUrl: (() => string) | null = null;
let fallbackLog: ((line: string) => void) | null = null;
let onRejected: ((line: string) => void) | null = null;
let lastFallbackNoteAt = 0;
const RETRY_PAUSE_MS = 200;

/** The engine registers the public endpoint as the fallback for the keyed one. */
export function setRpcFallback(
  getUrl: () => string,
  log: (line: string) => void,
  /** Told once when an endpoint refuses our credentials — a log line alone
   *  is not enough for something the user has to go and fix. */
  rejectedNotice?: (line: string) => void,
): void {
  fallbackHttpUrl = getUrl;
  fallbackLog = log;
  onRejected = rejectedNotice ?? null;
}

// 429 counts too (2026-09-03: a buy died at "Simulation call failed: RPC HTTP
// 429" on the keyed endpoint — the token page's own reads plus the trade's
// burst crossed the free tier's rate for a second). A rate limit is exactly
// the case where a short pause and then the other endpoint answers.
const isTransportFailure = (r: { ok: boolean; message: string }): boolean =>
  !r.ok && (classify(r.message) === 'transient' || classify(r.message) === 'rate-limited');
const isRateLimited = (r: { ok: boolean; message: string }): boolean => !r.ok && classify(r.message) === 'rate-limited';

// ── Rejected credentials ──────────────────────────────────────────────
//
// 2026-09-05: a user hit "RPC HTTP 401" over and over. 401 is not a
// transport failure, so it was neither retried nor failed over — every read
// simply died with that string, and the app looked broken rather than
// mis-keyed. A key the endpoint has rejected will be rejected again, so the
// endpoint is now remembered as bad and SKIPPED in favour of the public one
// until the key changes or the memory ages out. That keeps the app usable
// on a wrong key instead of dead.
//
// The host is remembered, never the URL: a keyed RPC URL carries the key in
// its query string and must not reach a log file.
const rejected = new Map<string, { at: number; code: '401' | '403' }>();
const REJECT_TTL_MS = 15 * 60_000;

/** Record a credentials rejection and tell the user once, in English. */
export function noteRpcRejection(url: string, status: number): void {
  if (status !== 401 && status !== 403) return;
  const host = safeHost(url);
  const code = String(status) as '401' | '403';
  const prev = rejected.get(host);
  rejected.set(host, { at: Date.now(), code });
  // One sentence per host per TTL, not one per failed call.
  if (!prev || Date.now() - prev.at > REJECT_TTL_MS) {
    const line = credentialsMessage(host, code);
    if (onRejected) onRejected(line);
    else fallbackLog?.(line);
  }
}

/**
 * A websocket handshake reports a rejected key as text, not a status code
 * ("Unexpected server response: 401"), and a bad key there means an endless
 * reconnect loop rather than one failed read. Same registry, same message.
 */
export function noteSocketRejection(url: string, errText: string): boolean {
  // Only a keyed socket can have its credentials refused, and the code is
  // matched with digit boundaries so a "401" inside some other number can
  // never condemn a working public endpoint.
  if (!/api-key=|[?&]token=/i.test(url)) return false;
  const m = /(?:^|[^0-9])(401|403)(?:[^0-9]|$)/.exec(errText ?? '');
  if (!m) return false;
  noteRpcRejection(url, Number(m[1]));
  return true;
}

/** True while this endpoint is known to refuse our credentials. */
export function isEndpointRejected(url: string): boolean {
  return isRejectedNow(url);
}

function isRejectedNow(url: string): boolean {
  const hit = rejected.get(safeHost(url));
  return !!hit && Date.now() - hit.at < REJECT_TTL_MS;
}

/** For the UI: the endpoint currently refusing our key, if any. */
export function rpcCredentialsRejected(): { host: string; code: '401' | '403'; message: string } | null {
  for (const [host, hit] of rejected) {
    if (Date.now() - hit.at < REJECT_TTL_MS) return { host, code: hit.code, message: credentialsMessage(host, hit.code) };
  }
  return null;
}

/** Editing the RPC settings is a new key: forget every rejection. */
export function clearRpcRejections(): void {
  rejected.clear();
}

/** Helius bills HTTP RPC as well as the websocket. A meter that counted only
 *  the socket showed a fraction of real spend, so the ceiling never bit and
 *  the number on the Settings page was not the user's usage. */
function billIfHelius(httpUrl: string): void {
  if (!/helius/i.test(httpUrl)) return;
  try {
    heliusBudget.billHttp(1);
  } catch {
    /* metering must never break a trade */
  }
}

// ── Rate-limit memory per host, and per METHOD ────────────────────────
//
// 2026-09-06 (rate-limit swarm): nothing in this file remembered a 429. N
// concurrent callers each paused 400 ms and re-hit the same host, then
// failed over — a burst that crossed the limit became two to three times
// the traffic, on two hosts. Two things fix that:
//
//   1. The host is PARKED on a 429 for its own Retry-After (the public RPC
//      sends 10 s) or 1 s doubling to 10 s. Every caller consults the park:
//      reads go to the other endpoint while it lasts, and when there is no
//      other endpoint the caller waits it out (bounded) instead of firing
//      into it. A trade is delayed by at most PARK_WAIT_CAP_MS, never lost.
//   2. A token bucket per host paces bursts BEFORE they 429. Ordinary
//      traffic never touches the bucket; a fan-out of ten wallets is spread
//      over ~3 s instead of dying at t=0. `sendTransaction` is never
//      delayed — it has its own lanes and its own resend cadence, and a
//      late send is worse than a refused one.
//
// 2026-09-09 (API swarm): both of those were keyed by HOST alone, and the
// public endpoint does not meter by host — it meters PER METHOD and says so
// in an `x-ratelimit-*` header set on every reply. Two consequences:
//
//   * `getTokenLargestAccounts` has a method limit of ZERO on the free tier.
//     Its first call from a cold IP is a 429 with `retry-after: 10`, so a
//     single holder lookup — guaranteed on a default install — parked the
//     whole host for the maximum 10 s and blinded balances, blockhash,
//     account reads and fill detection. A refusal that names a method now
//     parks `host#method`; only a host-level 429 parks the host.
//   * The flat 4/s-per-method guess was wrong in both directions: 4× over
//     budget on the three indexed methods, and a third of the real budget
//     on the cheap ones. Budgets are now read from the server's own headers
//     and seeded from the measured floors below, so a cold start is safe
//     before any header has been seen, and a method the server closes is
//     refused locally rather than spending a round trip to be refused.
//
// Everything is keyed by HOST (plus method), never URL, so a keyed URL never
// reaches a log.

const parkedUntil = new Map<string, number>();
const parkStrikes = new Map<string, { count: number; lastAt: number }>();
const PARK_BASE_MS = 1_000;
const PARK_MAX_MS = 10_000;
const PARK_STRIKE_DECAY_MS = 60_000;
/** Longest a caller with no alternative endpoint waits for a park to end. */
const PARK_WAIT_CAP_MS = 2_500;

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** A park key is the host, or `host#method` when the server refused ONE
 *  method rather than the endpoint. */
const parkKey = (host: string, method?: string | null): string => (method ? `${host}#${method}` : host);

/**
 * Remember a refusal. `method` is passed only when the refusal is
 * method-scoped (the server said so); otherwise the whole host is parked,
 * exactly as before.
 */
function noteRateLimit(httpUrl: string, retryAfter: string | null, method?: string | null): number {
  const key = parkKey(safeHost(httpUrl), method);
  const now = Date.now();
  const prev = parkStrikes.get(key);
  const count = prev && now - prev.lastAt < PARK_STRIKE_DECAY_MS ? prev.count + 1 : 1;
  parkStrikes.set(key, { count, lastAt: now });
  let length = Math.min(PARK_MAX_MS, PARK_BASE_MS * 2 ** (count - 1));
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra > 0) length = Math.min(PARK_MAX_MS, Math.max(length, ra * 1000));
  const until = now + length;
  if (until > (parkedUntil.get(key) ?? 0)) {
    parkedUntil.set(key, until);
    // ONLY when nothing else will say it (2026-09-21). `noteFallback` already
    // reports a call rescued by the other endpoint, and saying it twice is
    // what `test/rpcratelimit.test.mjs` calls "the user is told once". This
    // covers the case it cannot: a park with NO fallback configured, where
    // the call simply waits and the user sees a spinner with nothing in the
    // log behind it. Throttled per key, so a storm is not a storm of logging.
    const rescued = Boolean(fallbackHttpUrl?.());
    if (!rescued && now - (lastParkNoteAt.get(key) ?? 0) > 60_000) {
      lastParkNoteAt.set(key, now);
      fallbackLog?.(`RPC ${key} is rate limited — paused ${Math.round(length / 1000)}s${count > 1 ? `, strike ${count}` : ''}`);
    }
  }
  return length;
}

/** Throttle for the line above: a storm must not become a storm of logging. */
const lastParkNoteAt = new Map<string, number>();

/**
 * Milliseconds until this endpoint stops being rate limited, or 0. With a
 * method, the longer of the host park and that method's own park — a park on
 * one method never speaks for the rest of the endpoint.
 */
export function rpcParkRemainingMs(httpUrl: string, method?: string | null): number {
  const host = safeHost(httpUrl);
  const now = Date.now();
  const hostPark = (parkedUntil.get(host) ?? 0) - now;
  const methodPark = method ? (parkedUntil.get(parkKey(host, method)) ?? 0) - now : 0;
  return Math.max(0, hostPark, methodPark);
}

/** Wait out a park when there is nowhere else to go — bounded, jittered so
 *  the callers that piled up do not all fire in the same millisecond. */
async function awaitPark(httpUrl: string, method?: string | null): Promise<void> {
  const parked = rpcParkRemainingMs(httpUrl, method);
  if (parked > 0) await sleep(Math.min(parked, PARK_WAIT_CAP_MS) + Math.random() * 250);
}

/** Websocket handshakes refused with 429 park the host for sockets too, so
 *  every socket class backs off together instead of each redialing on its
 *  own clock (eight sockets × their own 1 s backoff was a handshake storm). */
const socketParkedUntil = new Map<string, number>();
const SOCKET_PARK_MS = 30_000;

export function noteSocketRateLimit(url: string, errText: string): boolean {
  if (!/(?:^|[^0-9])429(?:[^0-9]|$)/.test(errText ?? '')) return false;
  const host = safeHost(url);
  const prev = socketParkedUntil.get(host) ?? 0;
  const until = Date.now() + SOCKET_PARK_MS;
  if (until > prev) socketParkedUntil.set(host, until);
  return true;
}

export function socketParkRemainingMs(url: string): number {
  return Math.max(0, (socketParkedUntil.get(safeHost(url)) ?? 0) - Date.now());
}

interface Bucket {
  tokens: number;
  last: number;
  rate: number;
  burst: number;
}
const buckets = new Map<string, Bucket>();
const PUBLIC_HOSTS = new Set(['api.mainnet-beta.solana.com', 'api.mainnet.solana.com']);
/** Deepest pacing delay handed out: past this the backlog is a bug, not a burst. */
const BUCKET_WAIT_CAP_MS = 8_000;

// ── What the server says its budgets are ──────────────────────────────
//
// `api.mainnet-beta.solana.com` publishes, on EVERY reply:
//     x-ratelimit-tier / -method-limit / -method-remaining / -rps-limit
//     x-ratelimit-endpoint-limit / -conn-limit / -connrate-limit
// The method limit is a count per ten-second window (the window Solana's own
// docs describe its free tier in). These are the floors measured from those
// headers on 2026-09-09, used until this run has seen a header of its own —
// a cold start must be safe, not optimistic.
const METHOD_WINDOW_S = 10;
const PUBLIC_METHOD_BUDGET: Record<string, number> = {
  getBalance: 150,
  getHealth: 150,
  getTokenSupply: 150,
  getLatestBlockhash: 100,
  getAccountInfo: 50,
  getMultipleAccounts: 50,
  // Indexed reads. The old flat guess allowed 40 per window here — four
  // times what the endpoint actually grants.
  getSignatureStatuses: 10,
  getSignaturesForAddress: 10,
  getTokenAccountsByOwner: 10,
  // Not throttled: CLOSED. `x-ratelimit-method-limit: 0`, 429 on the first
  // call from a cold IP. Spending a request on it only earns a park.
  getTokenLargestAccounts: 0,
};
/** Methods with no measured floor keep the pre-2026-09-09 pacing (4/s). */
const PUBLIC_DEFAULT_BUDGET = 4 * METHOD_WINDOW_S;
/** Host-wide seed before a `x-ratelimit-rps-limit` header is seen. */
const PUBLIC_HOST_RATE = 10;
/** However high the server's rps allowance is, one desktop app pacing itself
 *  above this is a bug in us, not headroom (conn-limit is 40). */
const HOST_RATE_CEILING = 50;

/** Per `host#method`, the budget the SERVER last stated for this window. */
const observedMethodBudget = new Map<string, number>();
/** Per host, the `x-ratelimit-rps-limit` the server last stated. */
const observedHostRps = new Map<string, number>();

const headerNumber = (
  res: { headers?: { get?: (name: string) => string | null } },
  name: string,
): number | null => {
  try {
    const raw = res.headers?.get?.(name);
    if (raw === null || raw === undefined) return null;
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
};

/**
 * Read the endpoint's own rate-limit headers off any reply, success or
 * refusal, and let them drive the buckets. A keyed endpoint (Helius,
 * Alchemy) sends none of these, so nothing is recorded for it and it keeps
 * its own seeded budget — the public endpoint's tiny per-method allowances
 * are never inherited by a host that never claimed them.
 */
function noteRateLimitHeaders(
  httpUrl: string,
  method: string,
  res: { headers?: { get?: (name: string) => string | null } },
): void {
  const host = safeHost(httpUrl);
  const limit = headerNumber(res, 'x-ratelimit-method-limit');
  if (limit !== null) {
    observedMethodBudget.set(parkKey(host, method), limit);
    // A budget the server has just revised down must not be spendable from
    // tokens accrued under the old one.
    const b = buckets.get(parkKey(host, method));
    if (b) applySpec(b, methodSpec(host, method));
  }
  const remaining = headerNumber(res, 'x-ratelimit-method-remaining');
  if (remaining !== null && remaining <= 0) {
    // The next call in this window is the one that gets refused. Drain the
    // bucket rather than park: pacing resumes on its own as the window
    // refills, and no other method is touched.
    const b = buckets.get(parkKey(host, method));
    if (b) b.tokens = Math.min(b.tokens, 0);
  }
  const rps = headerNumber(res, 'x-ratelimit-rps-limit');
  if (rps !== null && rps > 0) observedHostRps.set(host, rps);
}

/** The budget this host grants this method per window, or null when the
 *  host publishes nothing and we have no measured floor for it. */
function methodBudget(host: string, method: string): number | null {
  const seen = observedMethodBudget.get(parkKey(host, method));
  if (seen !== undefined) return seen;
  if (PUBLIC_HOSTS.has(host)) return PUBLIC_METHOD_BUDGET[method] ?? PUBLIC_DEFAULT_BUDGET;
  return null;
}

/**
 * What this client currently believes an endpoint grants a method per
 * ten-second window: the server's own header if one has been seen, else the
 * measured floor, else null for a host that publishes nothing. Exported for
 * the tests, which must be able to pin the seeds and the header handling
 * without touching the live endpoint.
 */
export function rpcMethodBudget(httpUrl: string, method: string): number | null {
  return methodBudget(safeHost(httpUrl), method);
}

/** True when this endpoint does not serve this method at all (budget 0). */
function methodIsClosed(httpUrl: string, method: string): boolean {
  return methodBudget(safeHost(httpUrl), method) === 0;
}

function closedMethodMessage(httpUrl: string, method: string): string {
  return (
    `RPC HTTP 429 — ${safeHost(httpUrl)} sets a method limit of 0 for ${method} on this tier, ` +
    'so the request was not sent. Too many requests would be the only possible answer.'
  );
}

function methodSpec(host: string, method: string): { key: string; rate: number; burst: number } {
  const budget = methodBudget(host, method) ?? PUBLIC_DEFAULT_BUDGET;
  const rate = Math.max(0.1, budget / METHOD_WINDOW_S);
  // Burst stays at two seconds' worth, as the old 4/s + burst 8 did, so the
  // first calls of a page load still go out together.
  return { key: parkKey(host, method), rate, burst: Math.max(1, Math.min(budget, rate * 2)) };
}

function bucketSpecs(host: string, method: string): Array<{ key: string; rate: number; burst: number }> {
  const rps = observedHostRps.get(host);
  if (rps !== undefined) {
    const rate = Math.min(HOST_RATE_CEILING, rps);
    const specs = [{ key: host, rate, burst: rate }];
    if (methodBudget(host, method) !== null) specs.push(methodSpec(host, method));
    return specs;
  }
  if (/helius/i.test(host)) return [{ key: host, rate: 9, burst: 9 }];
  if (PUBLIC_HOSTS.has(host)) return [{ key: host, rate: PUBLIC_HOST_RATE, burst: PUBLIC_HOST_RATE }, methodSpec(host, method)];
  const specs: Array<{ key: string; rate: number; burst: number }> = [{ key: host, rate: 20, burst: 20 }];
  if (methodBudget(host, method) !== null) specs.push(methodSpec(host, method));
  return specs;
}

/** Re-rate a live bucket when the server revises the budget, without letting
 *  it keep tokens the new budget never granted. */
function applySpec(b: Bucket, spec: { rate: number; burst: number }): void {
  b.rate = spec.rate;
  b.burst = spec.burst;
  b.tokens = Math.min(b.tokens, spec.burst);
}

/** Reserve `cost` tokens; returns how long the caller must wait first. A
 *  bucket may go negative — that is the reservation, and it is what turns
 *  a burst into a paced sequence rather than a pile-up at the front. */
function reserve(spec: { key: string; rate: number; burst: number }, cost: number, now: number): number {
  let b = buckets.get(spec.key);
  if (!b) {
    b = { tokens: spec.burst, last: now, rate: spec.rate, burst: spec.burst };
    buckets.set(spec.key, b);
  } else if (b.rate !== spec.rate || b.burst !== spec.burst) {
    applySpec(b, spec);
  }
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 1000) * b.rate);
  b.last = now;
  b.tokens -= cost;
  return b.tokens >= 0 ? 0 : Math.min(BUCKET_WAIT_CAP_MS, (-b.tokens / b.rate) * 1000);
}

async function acquire(httpUrl: string, method: string, cost = 1): Promise<void> {
  if (method === 'sendTransaction') return;
  const host = safeHost(httpUrl);
  const now = Date.now();
  let wait = 0;
  for (const spec of bucketSpecs(host, method)) wait = Math.max(wait, reserve(spec, cost, now));
  if (wait > 0) await sleep(wait);
}

/** Read a 429's Retry-After without assuming a real Response (tests stub
 *  fetch with bare objects). */
function retryAfterOf(res: { headers?: { get?: (name: string) => string | null } }): string | null {
  try {
    return res.headers?.get?.('retry-after') ?? null;
  } catch {
    return null;
  }
}

// ── Refusals that do not look like refusals ───────────────────────────
//
// 2026-09-09 (API swarm). Two shapes were invisible to the classifier, and
// a refusal the machinery cannot see defeats all of the machinery:
//
//   * A rate limit delivered as a JSON-RPC error inside HTTP 200. A harness
//     fired 60 calls in 2 s into a host answering "Too many requests" and
//     got no park, no failover, and a healthy fallback left untouched. The
//     text also failed `mentionsRateLimit`, so the sell retry and the order
//     re-arm never fired either.
//   * A Cloudflare 403 challenge, which is an HTML page saying "prove you
//     are a browser", read as "your key is rejected": the host was banned
//     for fifteen minutes and the user told to replace a key that works.
//     The EVM rail already solves this (evm/client.ts peekIsChallenge).

const RATE_LIMIT_PHRASE =
  /too many requests|rate.?limit(?:ed|ing|s)?|slow down|request rate exceeded|quota exceeded|exceeded (?:your|the|its) (?:request|rate|call)/i;

/** Does this text say "you are asking too often", in any of the wordings a
 *  Solana RPC front end uses? Bare "429" counts only alongside a word that
 *  makes it a limit, so "behind by 429 slots" can never park a host. */
function looksRateLimited(text: string): boolean {
  const t = text ?? '';
  if (RATE_LIMIT_PHRASE.test(t)) return true;
  return /(?:^|\D)429(?:\D|$)/.test(t) && /limit|too many|request|throttl/i.test(t);
}

/** The server naming ONE method ("Too many requests for a specific RPC
 *  call") — the difference between parking a method and blinding a host. */
const methodScopedText = (text: string): boolean =>
  /for a specific rpc call|specific method|per[- ]method|this method|method limit/i.test(text ?? '');

const CHALLENGE_MARK = 'served a bot challenge page';

function challengeMessage(httpUrl: string): string {
  return (
    `RPC HTTP 403 — ${safeHost(httpUrl)} ${CHALLENGE_MARK} instead of an answer. ` +
    'That is the front door refusing the connection, not the endpoint refusing a key.'
  );
}

const isChallengeMessage = (message: string): boolean => (message ?? '').includes(CHALLENGE_MARK);

/**
 * The file's own view of a failure: everything `classifyRpcFailure` knows,
 * plus the two shapes above. Used everywhere in this file so a polite
 * refusal reaches the same park, failover and retry as an honest 429.
 */
function classify(message: string): ReturnType<typeof classifyRpcFailure> {
  const base = classifyRpcFailure(message);
  if (base !== 'other') return base;
  if (isChallengeMessage(message)) return 'transient';
  if (looksRateLimited(message)) return 'rate-limited';
  return 'other';
}

/** First 600 bytes of a refusal's body, on a clone where there is one, so
 *  nothing the caller still needs is consumed. Never throws. */
async function peekBody(res: {
  clone?: () => { text?: () => Promise<string> };
  text?: () => Promise<string>;
}): Promise<string> {
  try {
    const src = typeof res.clone === 'function' ? res.clone() : res;
    const t = typeof src?.text === 'function' ? await src.text() : '';
    return typeof t === 'string' ? t.slice(0, 600) : '';
  } catch {
    return '';
  }
}

/** A 403 that is an HTML bot challenge rather than a JSON "no". */
function isChallenge(res: { headers?: { get?: (n: string) => string | null } }, body: string): boolean {
  const t = (body ?? '').toLowerCase();
  if (t.includes('<!doctype html') || t.includes('<html') || t.includes('cf_chl') || t.includes('just a moment')) return true;
  if (t.includes('cf-browser-verification') || t.includes('attention required') || t.includes('enable javascript and cookies')) return true;
  try {
    const mitigated = res.headers?.get?.('cf-mitigated');
    if (mitigated && /challenge/i.test(mitigated)) return true;
    const ctype = res.headers?.get?.('content-type');
    if (ctype && /text\/html/i.test(ctype)) return true;
  } catch {
    /* a stubbed response with no headers is not a challenge */
  }
  return false;
}

/**
 * For the other rails that read a status code straight off a `fetch` (the
 * send lanes in broadcast.ts): is this 401/403 a bot challenge rather than a
 * rejected key? Reads a clone, so the caller's body is untouched, and never
 * throws.
 */
export async function isChallengeResponse(res: {
  headers?: { get?: (n: string) => string | null };
  clone?: () => { text?: () => Promise<string> };
  text?: () => Promise<string>;
}): Promise<boolean> {
  return isChallenge(res, await peekBody(res));
}

async function callOnce<T>(httpUrl: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
  await acquire(httpUrl, method);
  billIfHelius(httpUrl);
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    noteRateLimitHeaders(httpUrl, method, res);
    if (!res.ok) {
      if (res.status === 429) {
        // Method-scoped when the server says so — either by publishing a
        // limit of 0 for this method or by naming the method in the body.
        const body = await peekBody(res);
        const scoped = headerNumber(res, 'x-ratelimit-method-limit') === 0 || methodScopedText(body);
        noteRateLimit(httpUrl, retryAfterOf(res), scoped ? method : null);
        return { ok: false, message: 'RPC HTTP 429' };
      }
      if (res.status === 403) {
        const body = await peekBody(res);
        if (isChallenge(res, body)) {
          // Not a credentials problem: never remember the key as rejected.
          // Park the host so every other caller uses the other endpoint
          // while the front door is closed.
          noteRateLimit(httpUrl, retryAfterOf(res), null);
          return { ok: false, message: challengeMessage(httpUrl) };
        }
      }
      return { ok: false, message: `RPC HTTP ${res.status}` };
    }
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) {
      const raw = body.error.message ?? 'RPC error';
      if (looksRateLimited(raw)) {
        noteRateLimit(httpUrl, retryAfterOf(res), methodScopedText(raw) ? method : null);
        // Kept verbatim behind a phrase every downstream reader already
        // recognises (`mentionsRateLimit`, and onchain's holder note).
        return { ok: false, message: `RPC rate limited: ${raw}` };
      }
      return { ok: false, message: raw };
    }
    return { ok: true, message: 'ok', data: body.result };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'RPC request failed' };
  }
}

function noteFallback(httpUrl: string, method: string, why: string, viaAlt: { ok: boolean; message: string }): void {
  if (Date.now() - lastFallbackNoteAt <= 60_000) return;
  lastFallbackNoteAt = Date.now();
  fallbackLog?.(`RPC ${safeHost(httpUrl)} ${why} — ${method} answered by the fallback endpoint${viaAlt.ok ? '' : `, which also failed (${viaAlt.message})`}`);
}

async function call<T>(httpUrl: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
  const otherEndpoint = (): string => {
    const alt = fallbackHttpUrl?.();
    return alt && alt !== httpUrl ? alt : '';
  };

  // A key we already know is refused: go straight to the public endpoint
  // rather than spending a round trip on a certain 401 first.
  if (isRejectedNow(httpUrl)) {
    const alt = otherEndpoint();
    if (alt) return callOnce<T>(alt, method, params);
  }

  // A method this endpoint does not serve at all (the public endpoint
  // publishes `x-ratelimit-method-limit: 0` for getTokenLargestAccounts).
  // Ask the other endpoint if there is one; otherwise refuse locally rather
  // than spend a request on a guaranteed 429 — which is what used to park
  // the whole host and blind every other read.
  if (methodIsClosed(httpUrl, method)) {
    const alt = otherEndpoint();
    if (alt && !methodIsClosed(alt, method)) return callOnce<T>(alt, method, params);
    return { ok: false, message: closedMethodMessage(httpUrl, method) };
  }

  // A host that just said 429: use the other endpoint while the park lasts;
  // with no other endpoint, wait it out rather than fire into it. The park
  // is consulted per method, so one refused method never diverts the rest.
  if (rpcParkRemainingMs(httpUrl, method) > 0) {
    const alt = otherEndpoint();
    if (alt && rpcParkRemainingMs(alt, method) === 0) {
      const viaAlt = await callOnce<T>(alt, method, params);
      if (viaAlt.ok || !isTransportFailure(viaAlt)) return viaAlt;
    } else {
      await awaitPark(httpUrl, method);
    }
  }

  let r = await callOnce<T>(httpUrl, method, params);

  // Bad credentials: retrying cannot help, so fail over immediately, and if
  // there is nowhere to fail over to, at least say what is wrong. A
  // Cloudflare challenge is deliberately NOT in here — `classify` calls it
  // transient, so it is retried and failed over like the outage it is.
  if (classify(r.message) === 'unauthorized' && !r.ok) {
    const code = r.message.endsWith('403') ? 403 : 401;
    noteRpcRejection(httpUrl, code);
    const spoken = credentialsMessage(safeHost(httpUrl), String(code) as '401' | '403');
    const alt = otherEndpoint();
    if (!alt) return { ok: false, message: spoken };
    const viaAlt = await callOnce<T>(alt, method, params);
    return viaAlt.ok ? viaAlt : { ok: false, message: `${spoken} The public endpoint also failed (${viaAlt.message}).` };
  }

  if (!isTransportFailure(r)) return r;

  if (isRateLimited(r)) {
    // The host just refused us. The other endpoint answers now if it can;
    // this one is asked again only once its park has passed.
    const alt = otherEndpoint();
    if (alt && rpcParkRemainingMs(alt, method) === 0 && !methodIsClosed(alt, method)) {
      const viaAlt = await callOnce<T>(alt, method, params);
      if (viaAlt.ok) {
        noteFallback(httpUrl, method, 'is rate limited (HTTP 429)', viaAlt);
        return viaAlt;
      }
    }
    // If that refusal closed the method here, a second attempt is pointless.
    if (methodIsClosed(httpUrl, method)) return { ok: false, message: closedMethodMessage(httpUrl, method) };
    await awaitPark(httpUrl, method);
    return callOnce<T>(httpUrl, method, params);
  }

  // A 5xx or a dropped connection: one quick retry, then the other endpoint.
  await sleep(RETRY_PAUSE_MS);
  r = await callOnce<T>(httpUrl, method, params);
  if (!isTransportFailure(r)) return r;
  const alt = otherEndpoint();
  if (!alt) return r;
  const viaAlt = await callOnce<T>(alt, method, params);
  noteFallback(httpUrl, method, `failed twice (${r.message})`, viaAlt);
  return viaAlt.ok ? viaAlt : r;
}

/** Any JSON-RPC method through the same park, bucket, retry and failover as
 *  the typed helpers — for the few callers that used to fetch on their own
 *  and so never noticed a 429 (the fee estimator). */
export function rpcCall<T>(httpUrl: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
  return call<T>(httpUrl, method, params);
}

export async function getAccountInfo(httpUrl: string, pubkey: string): Promise<RpcResult<AccountInfo | null>> {
  const r = await call<{ value: { owner: string; data: [string, string]; lamports: number } | null }>(
    httpUrl,
    'getAccountInfo',
    [pubkey, { encoding: 'base64', commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  if (!r.data?.value) return { ok: true, message: 'not found', data: null };
  const v = r.data.value;
  return {
    ok: true,
    message: 'ok',
    data: { owner: v.owner, data: Buffer.from(v.data[0], 'base64'), lamports: v.lamports },
  };
}

/**
 * Several accounts in ONE round trip, owner included. The local builder
 * needs the mint (for its token program), the bonding curve and, when its
 * cache is cold, pump's Global — three sequential reads before this existed,
 * each a full RPC round trip on the order's critical path.
 */
export async function getMultipleAccountInfo(
  httpUrl: string,
  addresses: string[],
  /**
   * Default `confirmed`, which is what every caller had before this
   * existed. The local trade builder passes `processed`: it is quoting
   * against live curve reserves and sizing a sell from a balance that may
   * be one slot old, and `getTokenAccountBalance` — the call this batch
   * replaced there — already read at `processed`. Reading the balance a
   * commitment staler than before would make a sell placed straight after
   * a buy see zero tokens and refuse.
   */
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
): Promise<RpcResult<Array<AccountInfo | null>>> {
  if (addresses.length === 0) return { ok: true, message: 'ok', data: [] };
  const r = await call<{ value: Array<{ owner: string; data: [string, string]; lamports: number } | null> }>(
    httpUrl,
    'getMultipleAccounts',
    [addresses, { encoding: 'base64', commitment }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const values = r.data?.value ?? [];
  return {
    ok: true,
    message: 'ok',
    data: addresses.map((_, i) => {
      const v = values[i];
      return v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64'), lamports: v.lamports } : null;
    }),
  };
}

export async function getSlot(httpUrl: string): Promise<RpcResult<number>> {
  return call<number>(httpUrl, 'getSlot', [{ commitment: 'processed' }]);
}

/** Balance in lamports for a base58 address. */
export async function getBalance(httpUrl: string, pubkey: string, commitment: 'processed' | 'confirmed' = 'confirmed'): Promise<RpcResult<number>> {
  const r = await call<{ value: number }>(httpUrl, 'getBalance', [pubkey, { commitment }]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data?.value ?? 0 };
}

export interface SignatureStatus {
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  err: unknown;
}

/** Recent-status lookup (no history search) — used for fork-awareness:
 *  a signature that stays null never made the canonical chain. */
export async function getSignatureStatuses(
  httpUrl: string,
  signatures: string[],
  opts: { searchTransactionHistory?: boolean } = {},
): Promise<RpcResult<Array<SignatureStatus | null>>> {
  const r = await call<{ value: Array<SignatureStatus | null> }>(httpUrl, 'getSignatureStatuses', [
    signatures,
    // The recent cache covers ~150 blocks; a bridge asking about a signature
    // minutes old has to say so, or "not found" means nothing.
    { searchTransactionHistory: opts.searchTransactionHistory === true },
  ]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data?.value ?? [] };
}

/**
 * Can a transaction carrying this blockhash still land? False once the
 * hash has aged out (~60–90 s), after which the bytes can never be included
 * — broadcasting them returns a signature and nothing else.
 */
export async function isBlockhashValid(httpUrl: string, blockhash: string): Promise<RpcResult<boolean>> {
  const r = await call<{ value: boolean }>(httpUrl, 'isBlockhashValid', [blockhash, { commitment: 'processed' }]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data?.value === true };
}

export async function getHealth(httpUrl: string): Promise<RpcResult<string>> {
  return call<string>(httpUrl, 'getHealth', []);
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  /** Post-simulation lamports of each requested address (same order). */
  postLamports: Array<number | null>;
  /** Post-simulation base64 account data of each requested address. */
  postData: Array<string | null>;
}

/** Simulate a fully-signed, base64 transaction against current state, and
 *  return the post-simulation lamports of `watchAddrs` so the caller can
 *  bound the wallet's loss BEFORE broadcasting. */
export async function simulateTransaction(
  httpUrl: string,
  base64Tx: string,
  watchAddrs: string[],
): Promise<RpcResult<SimulationResult>> {
  const r = await call<{
    value: {
      err: unknown;
      logs: string[] | null;
      unitsConsumed?: number;
      accounts?: Array<{ lamports: number; data: [string, string] } | null>;
    };
  }>(httpUrl, 'simulateTransaction', [
    base64Tx,
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      encoding: 'base64',
      accounts: { addresses: watchAddrs, encoding: 'base64' },
    },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  const v = r.data.value;
  return {
    ok: true,
    message: 'ok',
    data: {
      err: v.err,
      logs: v.logs ?? [],
      unitsConsumed: v.unitsConsumed ?? null,
      postLamports: (v.accounts ?? []).map((a) => (a ? a.lamports : null)),
      postData: (v.accounts ?? []).map((a) => (a ? a.data[0] : null)),
    },
  };
}

/** Broadcast a base64 signed transaction. Preflight already done via
 *  simulate, so we skip it and run our own confirmation loop. */
export async function sendRawTransaction(httpUrl: string, base64Tx: string): Promise<RpcResult<string>> {
  return call<string>(httpUrl, 'sendTransaction', [
    base64Tx,
    { skipPreflight: true, maxRetries: 0, encoding: 'base64', preflightCommitment: 'processed' },
  ]);
}

// ── Local tx-builder support (template learning + assembly) ───────────

export interface ConfirmedSignatureInfo {
  signature: string;
  err: unknown;
  slot: number;
  /** Unix SECONDS, or null for a block the node has pruned the time for.
   *  Used to age a wallet (holder-graph "fresh" tagging). */
  blockTime?: number | null;
}

export async function getSignaturesForAddress(
  httpUrl: string,
  address: string,
  limit: number,
): Promise<RpcResult<ConfirmedSignatureInfo[]>> {
  return call<ConfirmedSignatureInfo[]>(httpUrl, 'getSignaturesForAddress', [
    address,
    { limit, commitment: 'confirmed' },
  ]);
}

export interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface RawTransaction {
  /** Unix SECONDS the block landed, or null when the node has pruned it.
   *  The only honest answer to "when did the leader actually trade?" — a
   *  copier that times a trade by when it READ it cannot tell a fresh sell
   *  from one it recovered forty minutes later (2026-09-15). */
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages?: string[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: Array<{ index: number; instructions: RawIx[] }>;
    /** Lamport balances by account index, before and after. The DIFFERENCE
     *  for our own wallet is the only honest way to know what a trade
     *  actually cost — it includes fees, rent, tips and slippage, none of
     *  which appear in the amount we requested. */
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
  transaction: {
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      instructions: RawIx[];
      /** v1 only: the compute budget moved out of instructions and into the
       *  message. `priorityFee` is TOTAL lamports, not micro-lamports per
       *  unit; `heapSize` is null when the default applies. */
      transactionConfig?: {
        computeUnitLimit?: number | null;
        heapSize?: number | null;
        loadedAccountsDataSizeLimit?: number | null;
        priorityFee?: number | null;
      } | null;
    };
    signatures?: string[];
  };
  /** 'legacy', 0 or 1. Absent on nodes that predate versioned replies. */
  version?: number | 'legacy';
}

/**
 * The COMPLETE account list for a transaction, in the order instruction
 * indexes refer to: static keys, then ALT-loaded writable, then ALT-loaded
 * readonly.
 *
 * This is not optional bookkeeping. `instruction.programIdIndex` and the
 * `preBalances`/`postBalances` arrays index into this combined list, not into
 * `message.accountKeys`. Verified on mainnet 2026-08-24: a Meteora DBC
 * transaction had 12 static keys and 5 ALT-loaded ones, with its own program
 * referenced at index 15 — reading only the static array silently yields
 * `undefined` and the instruction gets skipped. Any decoder that ignores this
 * appears to work (no error, no crash) while quietly missing every
 * transaction that uses a lookup table.
 */
export function resolveAccountKeys(tx: RawTransaction): string[] {
  const stat = tx.transaction?.message?.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return stat;
  return [...stat, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** A v1 transaction's first byte. Legacy and v0 start with the signature
 *  count (1..n, never 0x81 for any realistic count). */
const TX_V1_PREFIX = 0x81;

/**
 * Transaction v1 (SIMD-0385) on the wire — verified against a mainnet v1
 * transaction, byte for byte, on 2026-09-20 (test/fixtures/v1-wire.json):
 *
 *   0      0x81
 *   1..3   header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
 *   4..7   config mask (u32 LE) — which budget fields follow the keys
 *   8..39  recent blockhash
 *   40     number of instructions (u8 — v1 uses fixed-width counts)
 *   41     number of static account keys (u8; v1 has no lookup tables, every
 *          account travels inline, at most 64)
 *   42..   the keys, 32 bytes each
 *   ...    config values, instructions (headers grouped before payloads)
 *   tail   the signatures, 64 bytes each, signer order — LAST, which is what
 *          frees offset zero for the version byte
 *
 * Only the keys and the first signature are read here, exactly as for v0.
 */
function parseWireV1(buf: Buffer): { signature: string; accountKeys: string[] } | null {
  if (buf.length < 42) return null;
  const numRequiredSignatures = buf[1];
  const nKeys = buf[41];
  if (numRequiredSignatures < 1 || nKeys < 1) return null;
  const keysEnd = 42 + nKeys * 32;
  const sigStart = buf.length - numRequiredSignatures * 64;
  if (keysEnd > sigStart) return null;
  const accountKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) accountKeys.push(base58Encode(buf.subarray(42 + i * 32, 42 + (i + 1) * 32)));
  return { signature: base58Encode(buf.subarray(sigStart, sigStart + 64)), accountKeys };
}

/**
 * Static account keys + first signature straight off the wire bytes of a
 * transaction (what `encoding: 'base64'` hands back on blockSubscribe /
 * getBlock). Only the prefix is parsed — signatures, the version byte,
 * the header and the static key table — which is all a decoder needs to
 * turn `programIdIndex` into a program id once `loadedAddresses` is appended
 * (see resolveAccountKeys). Returns null on any malformed input; a bad tx in
 * a block must skip, never throw on the feed thread.
 */
export function parseWireTransaction(txBase64: string): { signature: string; accountKeys: string[] } | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(txBase64, 'base64');
  } catch {
    return null;
  }
  if (buf.length > 0 && buf[0] === TX_V1_PREFIX) return parseWireV1(buf);
  let off = 0;
  const compactU16 = (): number => {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 3; i++) {
      if (off >= buf.length) throw new Error('eof');
      const b = buf[off++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
    throw new Error('bad compact-u16');
  };
  try {
    const nSig = compactU16();
    if (nSig < 1 || off + nSig * 64 > buf.length) return null;
    const signature = base58Encode(buf.subarray(off, off + 64));
    off += nSig * 64;
    if (off >= buf.length) return null;
    if ((buf[off] & 0x80) !== 0) off += 1; // versioned message prefix (v0 = 0x80)
    off += 3; // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    const nKeys = compactU16();
    if (off + nKeys * 32 > buf.length) return null;
    const accountKeys: string[] = [];
    for (let i = 0; i < nKeys; i++) {
      accountKeys.push(base58Encode(buf.subarray(off, off + 32)));
      off += 32;
    }
    return { signature, accountKeys };
  } catch {
    return null;
  }
}

/**
 * The newest transaction format this client reads. Solana's transaction v1
 * (SIMD-0385) went live on mainnet at epoch 1035 on 2026-09-15: a node
 * answers a request for a v1 transaction with error -32015 unless the
 * request says it can take one, so with `0` here every v1 transaction a
 * followed wallet made was "not readable" and its copy did not fire (user
 * report 2026-09-20; leader 4vw54Bm…'s swaps were v1). The JSON shape is
 * the v0 shape plus `transactionConfig` on the message and `costUnits` in
 * meta, so every reader of `RawTransaction` keeps working; only the wire
 * bytes differ (see parseWireTransaction).
 */
export const MAX_SUPPORTED_TX_VERSION = 1;

export async function getTransaction(httpUrl: string, signature: string): Promise<RpcResult<RawTransaction | null>> {
  return call<RawTransaction | null>(httpUrl, 'getTransaction', [
    signature,
    { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION },
  ]);
}

/**
 * Several transactions in ONE JSON-RPC batch request. Helius counts each
 * element against the 10 rps cap, so callers keep batches small (≤10) and
 * spaced (≥100 ms) — this only saves round trips, not credits. Results are
 * returned in request order; an element that errored is null.
 */
export async function getTransactions(httpUrl: string, signatures: string[]): Promise<RpcResult<Array<RawTransaction | null>>> {
  if (signatures.length === 0) return { ok: true, message: 'ok', data: [] };
  const firstId = nextId;
  nextId += signatures.length;
  const body = signatures.map((sig, i) => ({
    jsonrpc: '2.0',
    id: firstId + i,
    method: 'getTransaction',
    params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION }],
  }));
  // Same park and bucket as a single call, at the batch's real cost.
  await awaitPark(httpUrl, 'getTransaction');
  await acquire(httpUrl, 'getTransaction', signatures.length);
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    noteRateLimitHeaders(httpUrl, 'getTransaction', res);
    if (!res.ok) {
      if (res.status === 429) {
        const text = await peekBody(res);
        const scoped = headerNumber(res, 'x-ratelimit-method-limit') === 0 || methodScopedText(text);
        noteRateLimit(httpUrl, retryAfterOf(res), scoped ? 'getTransaction' : null);
      }
      return { ok: false, message: `RPC HTTP ${res.status}` };
    }
    const replies = (await res.json()) as Array<{ id?: number; result?: RawTransaction | null; error?: unknown }>;
    if (!Array.isArray(replies)) return { ok: false, message: 'batch reply is not an array' };
    const out: Array<RawTransaction | null> = signatures.map(() => null);
    for (const r of replies) {
      const idx = typeof r?.id === 'number' ? r.id - firstId : -1;
      if (idx < 0 || idx >= out.length || r.error) continue;
      out[idx] = r.result ?? null;
    }
    return { ok: true, message: 'ok', data: out };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'RPC request failed' };
  }
}

export interface BlockhashInfo {
  blockhash: string;
  /** Last block height at which a tx using this blockhash can still land.
   *  Past it the tx is DEFINITIVELY dead — the only honest "expired". */
  lastValidBlockHeight: number;
}

export async function getLatestBlockhashInfo(httpUrl: string): Promise<RpcResult<BlockhashInfo>> {
  const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(httpUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: { blockhash: r.data.value.blockhash, lastValidBlockHeight: Number(r.data.value.lastValidBlockHeight) } };
}

export async function getLatestBlockhash(httpUrl: string): Promise<RpcResult<string>> {
  const r = await getLatestBlockhashInfo(httpUrl);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data.blockhash };
}

/** Current block height (confirmed) — compared against lastValidBlockHeight
 *  to decide whether an unconfirmed tx can still land. */
export async function getBlockHeight(httpUrl: string): Promise<RpcResult<number>> {
  const r = await call<number>(httpUrl, 'getBlockHeight', [{ commitment: 'confirmed' }]);
  if (!r.ok || typeof r.data !== 'number') return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data };
}

export interface TokenAccountHolding {
  mint: string;
  tokenAccount: string;
  amountRaw: string;
  uiAmount: number;
  decimals: number;
  /** Token program that owns the account (classic SPL or Token-2022). */
  programId: string;
}

/** Every SPL token account the owner holds, across both token programs.
 *  This is the chain's ground truth — positions left behind by a crashed
 *  or previous run show up here even when no session remembers them. */
export async function getTokenAccountsByOwner(
  httpUrl: string,
  owner: string,
): Promise<RpcResult<TokenAccountHolding[]>> {
  const TOKEN_PROGRAMS = [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ];
  interface ParsedTokenAccount {
    pubkey: string;
    account: {
      data: {
        parsed: {
          info: {
            mint: string;
            tokenAmount: { amount: string; uiAmount: number | null; decimals: number };
          };
        };
      };
    };
  }
  const out: TokenAccountHolding[] = [];
  // Both token programs at once: the two reads were sequential, so every
  // holdings refresh paid two RPC round trips end to end (2026-09-08). Still
  // through call() — its park fallback and 401/403 failover — not the batch.
  const results = await Promise.all(
    TOKEN_PROGRAMS.map((programId) =>
      call<{ value: ParsedTokenAccount[] }>(httpUrl, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).then((r) => ({ programId, r })),
    ),
  );
  for (const { programId, r } of results) {
    if (!r.ok) return { ok: false, message: r.message };
    for (const acc of r.data?.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      if (!info?.mint || !info.tokenAmount) continue;
      out.push({
        mint: info.mint,
        tokenAccount: acc.pubkey,
        amountRaw: info.tokenAmount.amount,
        uiAmount: info.tokenAmount.uiAmount ?? 0,
        decimals: info.tokenAmount.decimals,
        programId,
      });
    }
  }
  return { ok: true, message: 'ok', data: out };
}

/** Raw token amount held in a token account (0n if the account is missing). */
/** UI-unit balance of `owner` in `mint`, across both token programs, in ONE
 *  call (the RPC accepts a mint filter). Null = could not read (honest-null),
 *  0 only when the chain really says zero. */
export async function getTokenBalanceForMint(
  httpUrl: string,
  owner: string,
  mint: string,
): Promise<RpcResult<number>> {
  interface Row {
    account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null; uiAmountString?: string } } } } };
  }
  const r = await call<{ value: Row[] }>(httpUrl, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  let total = 0;
  for (const row of r.data.value) {
    const ta = row.account?.data?.parsed?.info?.tokenAmount;
    const v = ta?.uiAmount ?? (ta?.uiAmountString ? Number(ta.uiAmountString) : null);
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return { ok: true, message: 'ok', data: total };
}

/** RAW base units held for a mint across the owner's token accounts, plus
 *  decimals — what a Jupiter sell must be sized in. */
export async function getTokenBalanceRawForMint(
  httpUrl: string,
  owner: string,
  mint: string,
): Promise<RpcResult<{ raw: bigint; decimals: number | null }>> {
  interface Row {
    account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals?: number } } } } };
  }
  const r = await call<{ value: Row[] }>(httpUrl, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  let raw = 0n;
  let decimals: number | null = null;
  for (const row of r.data.value) {
    const ta = row.account?.data?.parsed?.info?.tokenAmount;
    if (!ta?.amount) continue;
    try {
      raw += BigInt(ta.amount);
    } catch {
      /* unparseable amount — skip rather than corrupt the total */
    }
    if (decimals === null && typeof ta.decimals === 'number') decimals = ta.decimals;
  }
  return { ok: true, message: 'ok', data: { raw, decimals } };
}

export async function getTokenBalanceRaw(httpUrl: string, tokenAccount: string): Promise<RpcResult<bigint>> {
  const r = await call<{ value: { amount: string } | null }>(httpUrl, 'getTokenAccountBalance', [
    tokenAccount,
    { commitment: 'processed' },
  ]);
  if (!r.ok) {
    // A missing account is "0 balance", not an error worth failing a sell for.
    if (/could not find|invalid param/i.test(r.message)) return { ok: true, message: 'no account', data: 0n };
    return { ok: false, message: r.message };
  }
  try {
    return { ok: true, message: 'ok', data: BigInt(r.data?.value?.amount ?? '0') };
  } catch {
    return { ok: false, message: 'unparseable token amount' };
  }
}

// ── Terminal additions (Krypto Bot, 2026-08-24) ───────────────────
//
// The terminal must answer "who holds this token" and "what is the supply"
// for mints this install never watched launch. Both are plain RPC reads, so
// they belong here rather than in a provider — they are authoritative and
// need no third party.

export interface TokenSupply {
  /** Raw base units as a decimal string (u64-safe). */
  amountRaw: string;
  uiAmount: number;
  decimals: number;
}

export async function getTokenSupply(httpUrl: string, mint: string): Promise<RpcResult<TokenSupply | null>> {
  const r = await call<{ value: { amount: string; uiAmount: number | null; decimals: number } | null }>(
    httpUrl,
    'getTokenSupply',
    [mint, { commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const v = r.data?.value;
  if (!v) return { ok: true, message: 'not found', data: null };
  return {
    ok: true,
    message: 'ok',
    data: { amountRaw: v.amount, uiAmount: v.uiAmount ?? 0, decimals: v.decimals },
  };
}

export interface LargestAccount {
  /** TOKEN ACCOUNT address — not the owner wallet. */
  address: string;
  amountRaw: string;
  uiAmount: number;
  decimals: number;
}

/** The 20 largest token accounts. This is a hard RPC cap, not our choice —
 *  a full holder list needs an indexer (Birdeye / Helius DAS). 20 rows is
 *  still enough to compute top-10 concentration honestly. */
export async function getTokenLargestAccounts(
  httpUrl: string,
  mint: string,
): Promise<RpcResult<LargestAccount[]>> {
  const r = await call<{ value: Array<{ address: string; amount: string; uiAmount: number | null; decimals: number }> }>(
    httpUrl,
    'getTokenLargestAccounts',
    [mint, { commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const rows = (r.data?.value ?? []).map((v) => ({
    address: v.address,
    amountRaw: v.amount,
    uiAmount: v.uiAmount ?? 0,
    decimals: v.decimals,
  }));
  return { ok: true, message: 'ok', data: rows };
}

/** Owner wallets for a batch of token accounts, via getMultipleAccounts. */
export async function getTokenAccountOwners(
  httpUrl: string,
  tokenAccounts: string[],
): Promise<RpcResult<Map<string, string>>> {
  const out = new Map<string, string>();
  interface Parsed {
    data?: { parsed?: { info?: { owner?: string } } };
  }
  for (let i = 0; i < tokenAccounts.length; i += 100) {
    const batch = tokenAccounts.slice(i, i + 100);
    const r = await call<{ value: Array<Parsed | null> }>(httpUrl, 'getMultipleAccounts', [
      batch,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, message: r.message };
    const values = r.data?.value ?? [];
    for (let k = 0; k < batch.length; k++) {
      const owner = values[k]?.data?.parsed?.info?.owner;
      if (typeof owner === 'string') out.set(batch[k], owner);
    }
  }
  return { ok: true, message: 'ok', data: out };
}

/** Raw account data for many addresses at once, base64. Batches of 100 —
 *  the RPC's hard limit for getMultipleAccounts. */
export async function getMultipleAccountsRaw(
  httpUrl: string,
  addresses: string[],
): Promise<RpcResult<Map<string, Buffer>>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const r = await call<{ value: Array<{ data: [string, string]; owner: string } | null> }>(
      httpUrl,
      'getMultipleAccounts',
      [batch, { encoding: 'base64', commitment: 'confirmed' }],
    );
    if (!r.ok) return { ok: false, message: r.message };
    const values = r.data?.value ?? [];
    for (let k = 0; k < batch.length; k++) {
      const v = values[k];
      if (!v?.data?.[0]) continue;
      out.set(batch[k], Buffer.from(v.data[0], 'base64'));
    }
  }
  return { ok: true, message: 'ok', data: out };
}
