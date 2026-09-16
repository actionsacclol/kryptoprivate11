// viem clients, one set per EVM chain.
//
// URLs come from settings (BYO key or endpoint, else the public one) through
// `configure()`; nothing else in the rail knows a URL. Reads are JSON-RPC
// batched, which keeps a Discover column at a couple of round trips.
//
// ─── Rate limiting ────────────────────────────────────────────────────
//
// Public endpoints answer a burst with HTTP 429 — Robinhood's as a SINGLE
// JSON-RPC error object even for a batch, which viem cannot map back onto
// the requests in it (every caller in that batch then fails with "reading
// 'error'", measured 2026-09-08). So every fetch goes through a gate per
// host: a token bucket keeps the sustained rate under the limit, and a 429
// parks the host (Retry-After, else 1 s doubling to 8 s) and is retried once
// the park ends. Keyed endpoints get a wider bucket. `eth_getLogs` goes
// through an UNBATCHED client so a failing log query cannot take a batch of
// reads down with it.
//
// ─── One endpoint per capability ──────────────────────────────────────
//
// Neither chain has a single free endpoint that does everything (see
// EvmEndpointMap in chains.ts for the measured tables). `endpointFor()` is the
// ONE resolver every client goes through: a user's own endpoint wins, then the
// endpoint the chain config names for that capability, then the public one.
// `client()` (general reads), `logClient()`, `receiptClient()`,
// `stateClient()`, `simulateClient()` and `broadcastClient()` are all thin
// wrappers over it, so adding a capability is a config edit, not a code path.

import { createPublicClient, http, type PublicClient } from 'viem';
import { CHAINS } from './chains';
import { resolveEvmRpcUrl, type EvmChainKind, type EvmChainSettings, type EvmRpcCapability } from '@shared/evm';
import { logger } from '../system/logger';

type ChainSettingsGetter = (chain: EvmChainKind) => Pick<EvmChainSettings, 'rpcUrl' | 'apiKey'>;
let getChainSettings: ChainSettingsGetter = () => ({ rpcUrl: '', apiKey: '' });

const clients = new Map<string, PublicClient>();
const logClients = new Map<string, PublicClient>();
/** Per-capability clients, keyed `${chain}|${capability}|${url}`. */
const capClients = new Map<string, PublicClient>();

function forgetClientsFor(url: string): void {
  for (const k of [...clients.keys()]) if (k.endsWith(`|${url}`)) clients.delete(k);
  for (const k of [...logClients.keys()]) if (k.endsWith(`|${url}`)) logClients.delete(k);
  for (const k of [...capClients.keys()]) if (k.endsWith(`|${url}`)) capClients.delete(k);
}

/** Called once by the rail with a getter over the live settings. */
export function configure(get: ChainSettingsGetter): void {
  getChainSettings = get;
  clients.clear();
  logClients.clear();
  capClients.clear();
  capRejectedUntil.clear();
  proven.clear();
}

/**
 * Endpoints that answered 401/403 — a wrong, revoked or over-quota key. Kept
 * for 15 minutes and then retried, exactly like the Solana rail's rejected
 * hosts: silently hammering a dead endpoint reads to the user as "the chain
 * is down" when the truth is one bad key.
 */
const REJECT_FOR_MS = 15 * 60_000;
const rejectedUntil = new Map<string, number>();
/**
 * Endpoints that refused ONE capability, keyed `${url}|${capability}`.
 *
 * `bsc-mainnet.public.blastapi.io` answers `eth_simulateV1` with HTTP 401
 * "Only core evm requests are allowed." while serving receipts, archive
 * balances and estimateGas with overrides perfectly (probed 2026-09-09).
 * Treating that as a bad key took the whole endpoint down for 15 minutes over
 * an optional preview call. It now costs that endpoint one capability.
 */
const capRejectedUntil = new Map<string, number>();
/** Consecutive transport failures per URL — a dead custom endpoint answers
 *  nothing at all, so it never reaches the 401/403 branch below. A persistent
 *  HTTP 5xx counts too: four probed endpoints served Cloudflare 521/530 for a
 *  whole session, and an HTTP answer is a successful fetch(). */
const transportFails = new Map<string, number>();
const UNREACHABLE_AFTER = 3;
/** URLs that have answered at least one request with a body that was NOT an
 *  authentication refusal. See the HTTP-200 auth peek in gatedFetchFor. */
const proven = new Set<string>();

function isUnreachable(url: string): boolean {
  return (transportFails.get(url) ?? 0) >= UNREACHABLE_AFTER;
}

function isRejected(url: string): boolean {
  const until = rejectedUntil.get(url) ?? 0;
  if (until <= Date.now()) {
    if (until) rejectedUntil.delete(url);
    return false;
  }
  return true;
}

function isCapRejected(url: string, cap: EvmRpcCapability): boolean {
  const k = `${url}|${cap}`;
  const until = capRejectedUntil.get(k) ?? 0;
  if (until <= Date.now()) {
    if (until) capRejectedUntil.delete(k);
    return false;
  }
  return true;
}

/** Called when the user edits the key or the URL — a new one deserves a try. */
export function clearRpcRejection(chain: EvmChainKind): void {
  rejectedUntil.clear();
  capRejectedUntil.clear();
  transportFails.clear();
  proven.clear();
  clients.clear();
  logClients.clear();
  capClients.clear();
  void chain;
}

function urlFor(chain: EvmChainKind): string {
  const wanted = resolveEvmRpcUrl(chain, getChainSettings(chain));
  // A rejected or unreachable custom endpoint falls back to the public one so
  // the chain keeps working (slower) instead of going dark.
  return isRejected(wanted) || isUnreachable(wanted) ? CHAINS[chain].meta.publicRpc : wanted;
}

/**
 * The ONE resolver: which URL serves `cap` on `chain` right now.
 *
 * User's own endpoint (they configured it, so it is assumed to serve what its
 * own chain needs) → the endpoint the chain config names for this capability →
 * the public endpoint. A user endpoint that is rejected, unreachable, or
 * refused THIS capability drops to the named one rather than straight to
 * public, because the named one was picked for being able to do the job.
 *
 * 'ws' is the exception: there is no https fallback for a socket, so an empty
 * entry means "this chain has no WSS" and callers must handle that.
 */
export function endpointFor(chain: EvmChainKind, cap: EvmRpcCapability): string {
  const cfg = CHAINS[chain];
  if (cap === 'ws') return cfg.endpoints.ws;
  const wanted = resolveEvmRpcUrl(chain, getChainSettings(chain));
  const custom = wanted !== cfg.meta.publicRpc;
  if (custom && !isRejected(wanted) && !isUnreachable(wanted) && !isCapRejected(wanted, cap)) return wanted;
  return cfg.endpoints[cap] || cfg.meta.publicRpc;
}

/** The chain's WSS endpoint, or '' when no endpoint on it offers one. */
export function wsEndpoint(chain: EvmChainKind): string {
  return endpointFor(chain, 'ws');
}

/** How the chain's endpoint is behaving, for the settings card. */
export function rpcStatus(chain: EvmChainKind): 'ok' | 'rate-limited' | 'rejected' | 'unreachable' {
  const wanted = resolveEvmRpcUrl(chain, getChainSettings(chain));
  if (isRejected(wanted)) return 'rejected';
  // Declared since the card was written and never once returned: a custom
  // endpoint that answers nothing (or 5xx forever) is on the public fallback,
  // and saying 'ok' about it is the opposite of the truth.
  if (isUnreachable(wanted)) return 'unreachable';
  return rpcRecentlyLimited(chain) ? 'rate-limited' : 'ok';
}

/** Every URL the chain config itself names — public endpoint included. These
 *  are OUR choices, not the user's key, so they get the public bucket. */
function isChainOwnUrl(chain: EvmChainKind, url: string): boolean {
  const cfg = CHAINS[chain];
  if (url === cfg.meta.publicRpc) return true;
  for (const u of Object.values(cfg.endpoints)) if (u && u === url) return true;
  return false;
}

function isPublicUrl(chain: EvmChainKind, url: string): boolean {
  return url === CHAINS[chain].meta.publicRpc;
}

// ── Gate, per host ────────────────────────────────────────────────────

interface Gate {
  tokens: number;
  last: number;
  parkedUntil: number;
  strikes: number;
  lastLimitAt: number;
  rate: number;
  burst: number;
}

const gates = new Map<string, Gate>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gateFor(chain: EvmChainKind, url: string): Gate {
  let host = 'invalid';
  try {
    host = new URL(url).host;
  } catch {
    /* fall through */
  }
  let g = gates.get(host);
  if (!g) {
    // Any endpoint the chain config names is a public endpoint we picked, not
    // a paid one the user brought: it gets the public bucket. (Before the
    // capability map this was decided by `=== publicRpc` alone, so the BNB
    // receipt endpoint quietly ran on the 25 rps "keyed" bucket.)
    const pub = isChainOwnUrl(chain, url);
    const spec = pub ? CHAINS[chain].publicRate : { rate: 25, burst: 40 };
    g = { tokens: spec.burst, last: Date.now(), parkedUntil: 0, strikes: 0, lastLimitAt: 0, rate: spec.rate, burst: spec.burst };
    gates.set(host, g);
  }
  return g;
}

async function acquire(g: Gate): Promise<void> {
  for (;;) {
    const now = Date.now();
    g.tokens = Math.min(g.burst, g.tokens + ((now - g.last) / 1000) * g.rate);
    g.last = now;
    if (g.tokens >= 1) {
      g.tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - g.tokens) / g.rate) * 1000));
  }
}

function parkFor(g: Gate, retryAfter: string | null): number {
  const now = Date.now();
  if (now - g.lastLimitAt > 60_000) g.strikes = 0;
  g.lastLimitAt = now;
  let ms = Math.min(8_000, 1_000 * 2 ** g.strikes);
  g.strikes += 1;
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) ms = Math.max(500, Math.min(10_000, Number(retryAfter) * 1000));
  g.parkedUntil = Math.max(g.parkedUntil, now + ms);
  return ms;
}

/** True when a 403 is a bot challenge (an HTML page) rather than "your key is
 *  not welcome" (a JSON-RPC answer). Reads a clone, so the caller's body is
 *  untouched. */
async function peekIsChallenge(res: Response): Promise<boolean> {
  try {
    const text = (await res.clone().text()).slice(0, 600).toLowerCase();
    return text.includes('<!doctype html') || text.includes('cf_chl') || text.includes('just a moment');
  } catch {
    return false;
  }
}

function isSend(init: RequestInit | undefined): boolean {
  const b = init?.body;
  return typeof b === 'string' && b.includes('eth_sendRawTransaction');
}

/**
 * Methods that ENHANCE a result and never carry it. `simulatedFill()` already
 * returns null when `eth_simulateV1` fails, so an endpoint refusing it is
 * missing a feature, not refusing our key — and must not be blacklisted whole.
 */
const OPTIONAL_METHODS = new Set(['eth_simulateV1']);

function methodsOf(init: RequestInit | undefined): string[] {
  const b = init?.body;
  if (typeof b !== 'string') return [];
  const out: string[] = [];
  const re = /"method"\s*:\s*"([^"]+)"/g;
  for (let m = re.exec(b); m; m = re.exec(b)) out.push(m[1]!);
  return out;
}

/** True when every method in the request is an optional enhancement. */
function isOptionalOnly(init: RequestInit | undefined): boolean {
  const ms = methodsOf(init);
  return ms.length > 0 && ms.every((m) => OPTIONAL_METHODS.has(m));
}

/**
 * True when an HTTP **200** is really an authentication refusal.
 * `rpc.ankr.com/bsc` answers 200 with `-32000 "Unauthorized: You must
 * authenticate your request with an API key."` — invisible to a rejection
 * check that branches on status alone, so an Ankr URL in Settings would read
 * `ok` forever while every call failed. Reads a clone; the caller's body is
 * untouched.
 */
async function peekIsAuthError(res: Response): Promise<boolean> {
  try {
    const text = (await res.clone().text()).slice(0, 800);
    if (!/"error"/.test(text)) return false;
    return /unauthorized|must authenticate|api key|apikey|invalid key/i.test(text);
  } catch {
    return false;
  }
}

function gatedFetchFor(chain: EvmChainKind, url: string, cap: EvmRpcCapability | 'read'): typeof fetch {
  const g = gateFor(chain, url);
  const dropEndpoint = (status: number | string): void => {
    rejectedUntil.set(url, Date.now() + REJECT_FOR_MS);
    forgetClientsFor(url);
    logger.warn(`evm ${chain}: the configured RPC endpoint answered ${status} — falling back to the public endpoint for 15 minutes (check your key in Settings)`);
  };
  return async (input, init) => {
    // A send is NEVER delayed by the gate — the same rule as the Solana rail:
    // a late broadcast is worse than a refused one, and the bucket exists to
    // protect polling, not the one transaction the user is waiting on.
    if (isSend(init)) return fetch(input, init);
    for (let attempt = 0; ; attempt++) {
      // Reads wait out the whole park: firing into a still-limited endpoint
      // just earns another 429. Only the send path skips the gate (above).
      const wait = Math.max(0, g.parkedUntil - Date.now());
      if (wait > 0) await sleep(wait);
      await acquire(g);
      let res: Response;
      const noteUnreachable = (): void => {
        const n = (transportFails.get(url) ?? 0) + 1;
        transportFails.set(url, n);
        if (n === UNREACHABLE_AFTER && !isPublicUrl(chain, url)) {
          forgetClientsFor(url);
          logger.warn(`evm ${chain}: the configured RPC endpoint is not answering — falling back to the public endpoint (check the URL in Settings)`);
        }
      };
      try {
        res = await fetch(input, init);
      } catch (e) {
        // Not an HTTP answer at all: a wrong host, DNS failure, a dead
        // endpoint. After a few in a row, fall back to the public one and say
        // so, rather than letting the chain look simply "down".
        noteUnreachable();
        throw e;
      }
      // An HTTP 5xx IS a successful fetch(), so the counter used to be reset by
      // the very responses that prove the endpoint is broken: four probed hosts
      // served Cloudflare 521/530 with `retry-after: 120` for an entire session
      // and never once reached the unreachable fallback.
      if (res.status >= 500) {
        noteUnreachable();
        return res;
      }
      transportFails.delete(url);
      // A rejected key must not look like an outage: mark it, and let urlFor
      // fall back to the public endpoint on the next client build. A bot
      // challenge is NOT a rejected key — Robinhood's public endpoint answers
      // a hot IP with a Cloudflare 403 page (seen 2026-09-09) — so that is
      // parked and retried like a rate limit instead.
      if (res.status === 401 || res.status === 403) {
        const challenge = res.status === 403 && (await peekIsChallenge(res));
        if (challenge) {
          const ms = parkFor(g, res.headers.get('retry-after'));
          if (attempt < 2) {
            await sleep(ms);
            continue;
          }
          return res;
        }
        if (!isPublicUrl(chain, url)) {
          if (cap !== 'read' && isOptionalOnly(init)) {
            // A per-METHOD refusal, not a bad key: blastapi 401s
            // `eth_simulateV1` alone and serves everything else. Cost it this
            // capability, keep the endpoint.
            capRejectedUntil.set(`${url}|${cap}`, Date.now() + REJECT_FOR_MS);
            capClients.delete(`${chain}|${cap}|${url}`);
            logger.warn(`evm ${chain}: the configured RPC endpoint answered ${res.status} to ${methodsOf(init).join(', ')} — using it for everything except ${cap}`);
          } else {
            dropEndpoint(res.status);
          }
        }
        return res;
      }
      if (res.status === 200 && !proven.has(url) && !isPublicUrl(chain, url)) {
        // Peek ONLY until an endpoint has answered once without an auth error:
        // a refusing endpoint is caught on its first call, a working one pays
        // for one body clone in the session and never again.
        if (await peekIsAuthError(res)) {
          dropEndpoint('200 with an authentication error');
          return res;
        }
        proven.add(url);
      }
      if (res.status !== 429) return res;
      const ms = parkFor(g, res.headers.get('retry-after'));
      if (attempt >= 2) return res;
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to release */
      }
      await sleep(ms);
    }
  };
}

/** Milliseconds the chain's host is parked after a 429, or 0. */
export function rpcParkRemainingMs(chain: EvmChainKind): number {
  const g = gateFor(chain, urlFor(chain));
  return Math.max(0, g.parkedUntil - Date.now());
}

/** True when the chain's endpoint rate-limited us in the last minute. */
export function rpcRecentlyLimited(chain: EvmChainKind): boolean {
  const g = gateFor(chain, urlFor(chain));
  return Date.now() - g.lastLimitAt < 60_000;
}

// ── Clients ───────────────────────────────────────────────────────────

export function client(chain: EvmChainKind): PublicClient {
  const url = urlFor(chain);
  const key = `${chain}|${url}`;
  const hit = clients.get(key);
  if (hit) return hit;
  const debug = process.env.KRYPT_EVM_DEBUG === '1';
  const c = createPublicClient({
    chain: CHAINS[chain].viem,
    transport: http(url, {
      fetchFn: gatedFetchFor(chain, url, 'read'),
      batch: { batchSize: 50, wait: 10 },
      timeout: 12_000,
      retryCount: 1,
      retryDelay: 200,
      ...(debug
        ? {
            onFetchRequest: async (req: Request) => {
              try {
                const body = (await req.clone().json()) as unknown;
                const list = Array.isArray(body) ? body : [body];
                console.log(`[evm ${chain} →] ${list.map((b) => `${(b as { id: number }).id}:${(b as { method: string }).method}`).join(' ')}`);
              } catch {
                /* debug only */
              }
            },
            onFetchResponse: async (res: Response) => {
              try {
                const text = await res.clone().text();
                console.log(`[evm ${chain} ←] ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
              } catch {
                /* debug only */
              }
            },
          }
        : {}),
    }),
  });
  clients.set(key, c);
  return c;
}

/**
 * The client for one capability. Built on whatever `endpointFor` resolves, so
 * the whole per-capability story is the config plus that one function.
 * `eth_getLogs` gets an UNBATCHED transport and a longer timeout (see header).
 */
function capClient(chain: EvmChainKind, cap: EvmRpcCapability): PublicClient {
  const url = endpointFor(chain, cap);
  // NOTE: never short-circuit to `client(chain)` when the URL happens to match.
  // The capability is carried by the client's own gated fetch, and a shared
  // client is built with cap 'read' — reusing it is how a per-method refusal
  // would go back to blacklisting the whole endpoint.
  if (cap === 'logs') {
    const lkey = `${chain}|${url}`;
    const lhit = logClients.get(lkey);
    if (lhit) return lhit;
    const lc = createPublicClient({
      chain: CHAINS[chain].viem,
      transport: http(url, { fetchFn: gatedFetchFor(chain, url, cap), batch: false, timeout: 20_000, retryCount: 1, retryDelay: 200 }),
    });
    logClients.set(lkey, lc);
    return lc;
  }
  const key = `${chain}|${cap}|${url}`;
  const hit = capClients.get(key);
  if (hit) return hit;
  // A broadcast is never batched: viem's batch wait would hold the one
  // transaction the user is waiting on behind a 10 ms coalescing window, and
  // the ungated-send rule exists precisely so nothing delays it.
  const batch = cap === 'broadcast' ? (false as const) : ({ batchSize: 20, wait: 10 } as const);
  const c = createPublicClient({
    chain: CHAINS[chain].viem,
    transport: http(url, { fetchFn: gatedFetchFor(chain, url, cap), batch, timeout: 12_000, retryCount: 1, retryDelay: 200 }),
  });
  capClients.set(key, c);
  return c;
}

/** An UNBATCHED client for `eth_getLogs` (see the header). On BNB this is an
 *  ARCHIVAL endpoint: the dataseeds serve no logs at all and publicnode serves
 *  none past ~9,000 blocks, which is what capped the launch index at an hour. */
export function logClient(chain: EvmChainKind): PublicClient {
  return capClient(chain, 'logs');
}

/**
 * The client that reads receipts.
 *
 * BNB's default public RPC refuses `eth_getTransactionReceipt` at every depth
 * ("Archive requests require a personal token"), so without a second endpoint
 * no BNB trade could ever confirm. A user's own endpoint is always preferred:
 * if they configured one, it is assumed to serve what its own chain needs.
 */
export function receiptClient(chain: EvmChainKind): PublicClient {
  return capClient(chain, 'receipts');
}

/**
 * The client for reads AT A PAST BLOCK — the balances that price a fill.
 *
 * Separate from `receiptClient` because a receipt and the state around it are
 * not the same capability: BNB's receipt endpoint (a dataseed) keeps only
 * geth's 128-block trie, bisected to 110–119 blocks ≈ 50 s, against a 60 s
 * receipt timeout. A fill confirmed near the timeout was priced from state that
 * endpoint had already dropped. This one points at an archival endpoint.
 */
export function stateClient(chain: EvmChainKind): PublicClient {
  return capClient(chain, 'state');
}

/** The client for `eth_simulateV1` — an enhancement, so a refusal here costs
 *  the endpoint this capability only, never the whole endpoint. */
export function simulateClient(chain: EvmChainKind): PublicClient {
  return capClient(chain, 'simulate');
}

/**
 * The client that broadcasts. `eth_sendRawTransaction` is never gated or
 * delayed (see `isSend` in gatedFetchFor) — that contract is unchanged.
 * Which endpoint it is, and that BNB's default is MEV-protected, is now a
 * stated choice in chains.ts rather than a side effect of read routing.
 */
export function broadcastClient(chain: EvmChainKind): PublicClient {
  return capClient(chain, 'broadcast');
}

/**
 * True when an endpoint refused the read outright rather than not having it
 * yet — worth saying, and not worth retrying for a minute.
 *
 * Beyond the auth/archive shapes, this covers the PERMANENT capability limits
 * observed across 28 endpoints on 2026-09-09: `eth_getLogs` disabled on the BNB
 * dataseeds (`-32005 limit exceeded`, for a single block), the various maximum
 * block ranges, a result cap that needs a narrower window rather than a retry,
 * and pruned state (`missing trie node`, `metadata is not found`). Every one of
 * those used to be retried as if it were transient.
 */
export function isRpcRefusal(e: unknown): boolean {
  const m = String((e as { details?: string; shortMessage?: string; message?: string })?.details ?? (e as Error)?.message ?? '');
  if (/archive|personal token|forbidden|missing trie node|method not (found|supported)/i.test(m)) return true;
  return /limit exceeded|not available|exceeds? maximum block range|block range exceeds|limited to \d+ ?- ?\d+ blocks|must not exceed \d+ blocks|logs matched by query exceeds|metadata is not found/i.test(m);
}

/** True when the failure is specifically "that block's state is gone here" —
 *  a fill priced from a pruned block is priced wrong, not late. */
export function isPrunedStateError(e: unknown): boolean {
  const m = String((e as { details?: string; shortMessage?: string; message?: string })?.details ?? (e as Error)?.message ?? '');
  return /missing trie node|metadata is not found|header not found|state (is )?not available|not supported/i.test(m);
}

/** Host only — never the key. For the settings page and logs. */
export function rpcHost(chain: EvmChainKind): string {
  try {
    return new URL(urlFor(chain)).host;
  } catch {
    return 'invalid';
  }
}

export function usingKeyedRpc(chain: EvmChainKind): boolean {
  return !isPublicUrl(chain, urlFor(chain));
}

/**
 * Wait for a receipt by polling. Blocks are 100–450 ms on these chains: a
 * sent tx is usually in the next one or two, and viem's default poll (4 s)
 * would spend many blocks waiting for something that already landed.
 */
export async function waitForReceipt(chain: EvmChainKind, hash: `0x${string}`, timeoutMs = CHAINS[chain].receiptTimeoutMs) {
  const c = receiptClient(chain);
  const started = Date.now();
  let delay = Math.max(150, CHAINS[chain].meta.blockMs);
  for (;;) {
    try {
      const r = await c.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not indexed yet */
    }
    if (Date.now() - started > timeoutMs) return null;
    await sleep(delay);
    delay = Math.min(1_000, Math.round(delay * 1.4));
  }
}

/** Head block, or null when the endpoint is unreachable. */
export async function head(chain: EvmChainKind): Promise<{ block: number; at: number } | null> {
  try {
    const n = await client(chain).getBlockNumber({ cacheTime: 500 });
    return { block: Number(n), at: Date.now() };
  } catch {
    return null;
  }
}

// ── Block times ───────────────────────────────────────────────────────
//
// WHEN a trade happened, as opposed to when the scanner got round to reading
// it. The scanner polls block ranges and resumes from its cursor, so a stall
// or a restart hands `ingestTrades` a backlog — and every trade in it used to
// be stamped with the poll's own clock. Copy trading then read a leader buy
// from twenty minutes ago as brand new and entered on it (2026-09-15).
//
// One `getBlock` per block, cached, and only ever asked for a block that
// contains a FOLLOWED wallet's trade — which is rare, so in steady state this
// costs nothing. The in-flight promise is cached too: several trades in one
// block share a single request.

const blockTimes = new Map<string, Promise<number | null>>();
/** Bounded: a long session must not hold every block it ever dated. */
const BLOCK_TIME_CACHE = 500;

/**
 * When a block landed, ms, or null when it cannot be read.
 *
 * Null is "unknown" and every caller treats it as such — never as now, and
 * never as old. A chain whose endpoint will not serve `getBlock` keeps
 * behaving exactly as it did before block times existed.
 */
export async function blockTimeMs(chain: EvmChainKind, blockNumber: bigint): Promise<number | null> {
  const key = `${chain}:${blockNumber}`;
  const hit = blockTimes.get(key);
  if (hit) return hit;
  const p = client(chain)
    .getBlock({ blockNumber })
    .then((b) => (typeof b.timestamp === 'bigint' && b.timestamp > 0n ? Number(b.timestamp) * 1_000 : null))
    .catch(() => null);
  blockTimes.set(key, p);
  if (blockTimes.size > BLOCK_TIME_CACHE) {
    const oldest = blockTimes.keys().next().value;
    if (oldest !== undefined && oldest !== key) blockTimes.delete(oldest);
  }
  // A failed read must not be cached as a permanent "unknown" for that block.
  void p.then((v) => {
    if (v === null) blockTimes.delete(key);
  });
  return p;
}

/** EIP-1559 fee fields under the chain's rule (see EvmChainConfig.feeRule). */
export async function feeFields(chain: EvmChainKind): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFee: bigint }> {
  const cfg = CHAINS[chain];
  const c = client(chain);
  if (cfg.feeRule === 'gasPrice') {
    const gp = await c.getGasPrice();
    const price = gp > cfg.minFeePerGas ? gp : cfg.minFeePerGas;
    return { maxFeePerGas: (price * 12n) / 10n, maxPriorityFeePerGas: price, baseFee: price };
  }
  const block = await c.getBlock({ blockTag: 'latest' });
  const base = block.baseFeePerGas ?? 100_000_000n;
  const maxFee = base * 2n > cfg.minFeePerGas ? base * 2n : cfg.minFeePerGas;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n, baseFee: base };
}
