// Off-chain token-metadata fetcher — social-link signal capture.
//
// Each pump create event carries a `uri` pointing at a metadata JSON (usually
// IPFS). The research swarm found social links in that metadata give an
// 8.9–17.4x graduation lift (RED-PUMP-2026) — a far stronger signal per byte
// than raw trade volume. This module resolves that JSON off the hot path and
// extracts a compact social fingerprint for the recorder, so a collection run
// captures WHICH launches had real socials.
//
// Discipline: fire-and-forget (never awaited in a decision), bounded
// concurrency, short timeout, response size cap, guarded JSON parse, LRU
// dedupe so the same URI isn't fetched twice. A dead/slow gateway degrades to
// "unresolved", never blocks or crashes ingestion.
//
// 2026-09-20: the same file is also where a token's LINKS come from. The
// metadata JSON is the record pump.fun's own `twitter`/`website` fields are
// copied from, and it exists the moment the coin does — where pump.fun's
// record still says null for the first minutes and no index has the coin at
// all. So `fetchMetadataLinks` returns the URLs themselves (the fingerprint
// above stays as it was, for the recorder and the runner model), the summary
// merges them last (data/market.ts), and a person's lookup takes the lane
// ahead of the create-time queue.

const TIMEOUT_MS = 4_000;
const MAX_BYTES = 64 * 1024;
const MAX_CONCURRENT = 4;
const CACHE_CAP = 20_000;
/** A miss is retried after this long. A coin seconds old is often not on a
 *  public gateway yet, and a gateway that answered 429 is not a fact about
 *  the file; a permanent miss here was why a runner flagged at +60 s could
 *  never show its X. Unfetchable URIs (no CID, bad scheme) stay permanent. */
const MISS_TTL_MS = 60_000;
/** A gateway that answers 429 or 5xx is left alone for this long, and the
 *  others carry the fetch. Measured 2026-09-20 from the dev machine with the
 *  scanner running: ipfs.io 429 on every ask, dweb.link the same (shared
 *  limits), gateway.pinata.cloud 4–7 s, ipfs.4everland.io 0.7 s,
 *  ipfs.filebase.io 0.9 s; cloudflare-ipfs.com no longer resolves at all. */
const GATEWAY_PARK_MS = 60_000;
/** Create-time fetches waiting for a lane, beyond which the newest is
 *  answered "unresolved" (uncached) rather than queued behind a stalled
 *  gateway. A person's lookup (`fetchMetadataLinks`) never waits here. */
const QUEUE_CAP = 256;
// Public IPFS gateways, tried in order. HTTPS only — anything else is rejected.
// pump.fun's own URIs point at ipfs.io, which is asked first while it answers;
// the other two are the fallback when it is throttling this IP. Every host
// here is named in the privacy policy (shared/legal/documents.ts) and pinned
// by test/legal.test.mjs — add one there too, or the test fails.
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://ipfs.4everland.io/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
];

// SECURITY (2026-08-16 product swarm, §8): the `uri` on a create event is
// chosen by the token's creator, and this module used to fetch it verbatim.
// That handed any launcher the IP address and a precise timestamp for every
// install watching the tape — a deanonymization oracle for the whole user
// base — plus an SSRF surface against localhost and LAN addresses.
//
// Fetches are now restricted to this fixed host allowlist. A URI that is not
// on it is only fetched if a CID can be extracted and re-pointed at an
// allowlisted gateway; otherwise it is dropped as unresolved. Because the
// host set is fixed and public, private-range and DNS-rebinding targets are
// unreachable by construction.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  IPFS_GATEWAYS.map((g) => new URL(g).hostname),
);

export interface TokenSocials {
  /** The metadata JSON resolved at all. */
  resolved: boolean;
  hasImage: boolean;
  hasDescription: boolean;
  twitter: boolean;
  telegram: boolean;
  website: boolean;
  /** Count of distinct social channels present (0..3). */
  socialCount: number;
}

const UNRESOLVED: TokenSocials = {
  resolved: false,
  hasImage: false,
  hasDescription: false,
  twitter: false,
  telegram: false,
  website: false,
  socialCount: 0,
};

/**
 * The links a token's creator published in its metadata JSON, as the strings
 * they wrote — `http(s)://…` or null, nothing normalised or guessed. What the
 * app may SHOW of them is decided downstream by `tokenLinks` (https only, a
 * real host); this is the one place the values are read off the file.
 */
export interface MetadataLinks {
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  image: string | null;
  /** The $Krypto Mode bot wallet the description declares, or null. */
  kryptoBot: string | null;
}

/** One resolved metadata file: the fingerprint and the links, from one fetch.
 *  `links` is null when the file could never be fetched (bad URI). */
interface Resolved {
  socials: TokenSocials;
  links: MetadataLinks | null;
}

const UNFETCHABLE: Resolved = { socials: UNRESOLVED, links: null };

const cache = new Map<string, Resolved>();
/** uri → when its last fetch missed (gateway down, CID not reachable yet). */
const misses = new Map<string, number>();
/** uri → the fetch in progress, so the create path and a person's lookup
 *  seconds later share one request. */
const inflight = new Map<string, Promise<Resolved | null>>();
/** gateway host → until when it is left alone. */
const parkedUntil = new Map<string, number>();
let now: () => number = () => Date.now();
let inFlight = 0;
const queue: Array<() => void> = [];

/** A lane, or false when a background caller would only be queued behind
 *  more than QUEUE_CAP others. A priority caller goes to the FRONT. */
function acquire(priority: boolean): Promise<boolean> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve(true);
  }
  if (!priority && queue.length >= QUEUE_CAP) return Promise.resolve(false);
  return new Promise((resolve) => {
    const grant = (): void => resolve(true);
    if (priority) queue.unshift(grant);
    else queue.push(grant);
  });
}

function release(): void {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

function remember(uri: string, r: Resolved): void {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(uri, r);
  misses.delete(uri);
}

function rememberMiss(uri: string): void {
  if (misses.size >= CACHE_CAP) {
    const oldest = misses.keys().next().value;
    if (oldest !== undefined) misses.delete(oldest);
  }
  misses.set(uri, now());
}

function gatewayParked(url: string): boolean {
  const until = parkedUntil.get(new URL(url).hostname);
  return until !== undefined && until > now();
}

function parkGateway(url: string): void {
  parkedUntil.set(new URL(url).hostname, now() + GATEWAY_PARK_MS);
}

/** A CID is base58btc (Qm…) or base32 CIDv1 (baf…). Keep this strict: it is
 *  the only attacker-influenced string that survives into a fetched URL. */
function sanitizeCid(raw: string): string | null {
  const cid = raw.trim();
  return /^[A-Za-z0-9]{46,62}$/.test(cid) ? cid : null;
}

/**
 * Rewrite a metadata URI into the list of URLs we are willing to fetch.
 *
 * Only two things are ever fetched: an allowlisted gateway host, or an
 * allowlisted gateway carrying a CID extracted from the URI. Everything else
 * returns [] and the token resolves as UNRESOLVED — see the SECURITY note at
 * the top of this file. Never relax this to "return [u]" for an arbitrary
 * host; that is the deanonymization bug this replaced.
 */
function candidateUrls(uri: string): string[] {
  const u = uri.trim();

  if (u.startsWith('ipfs://')) {
    const cid = sanitizeCid(u.slice('ipfs://'.length).replace(/^ipfs\//, ''));
    return cid ? IPFS_GATEWAYS.map((g) => g + cid) : [];
  }

  if (!/^https?:\/\//i.test(u)) return [];

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return [];
  }

  // Extract a CID if the path looks like a gateway path, so a non-allowlisted
  // gateway can still be served from one we trust.
  const m = parsed.pathname.match(/\/ipfs\/([^/?#]+)/);
  const cid = m ? sanitizeCid(m[1]) : null;
  const viaGateways = cid ? IPFS_GATEWAYS.map((g) => g + cid) : [];

  // The origin itself is only fetched when the host is allowlisted AND the
  // scheme is https — an allowlisted host over plain http is still a downgrade.
  if (parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname)) {
    return [parsed.toString(), ...viaGateways.filter((x) => x !== parsed.toString())];
  }

  return viaGateways;
}

function looksLikeUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

function extractSocials(json: Record<string, unknown>): TokenSocials {
  // pump metadata puts socials at the top level (twitter/telegram/website) and
  // sometimes nested under `extensions`. Check both, tolerate missing.
  const ext = (json.extensions && typeof json.extensions === 'object' ? json.extensions : {}) as Record<string, unknown>;
  const pick = (k: string): unknown => json[k] ?? ext[k];
  const twitter = looksLikeUrl(pick('twitter')) || looksLikeUrl(pick('x'));
  const telegram = looksLikeUrl(pick('telegram'));
  const website = looksLikeUrl(pick('website'));
  const socialCount = (twitter ? 1 : 0) + (telegram ? 1 : 0) + (website ? 1 : 0);
  return {
    resolved: true,
    hasImage: looksLikeUrl(json.image),
    hasDescription: typeof json.description === 'string' && json.description.trim().length > 0,
    twitter,
    telegram,
    website,
    socialCount,
  };
}

/** The string as the creator wrote it when it is an http(s) URL of sane
 *  length, else null. No scheme is added and no host is guessed: a bare
 *  handle is not a link, and saying it is one would put a URL on screen the
 *  creator never published. */
function urlOrNull(v: unknown): string | null {
  if (!looksLikeUrl(v)) return null;
  const s = (v as string).trim();
  return s.length <= 2_048 ? s : null;
}

function extractLinks(json: Record<string, unknown>): MetadataLinks {
  const ext = (json.extensions && typeof json.extensions === 'object' ? json.extensions : {}) as Record<string, unknown>;
  const pick = (k: string): unknown => json[k] ?? ext[k];
  return {
    twitter: urlOrNull(pick('twitter')) ?? urlOrNull(pick('x')),
    telegram: urlOrNull(pick('telegram')),
    website: urlOrNull(pick('website')),
    image: urlOrNull(json.image),
    kryptoBot: parseKryptoDisclosure(json.description),
  };
}

/** One gateway asked once. `parked` when it said 429 or 5xx (and is now left
 *  alone for a while); null on any other failure. */
async function fetchOne(url: string): Promise<Resolved | 'parked' | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (res.status === 429 || res.status >= 500) {
      parkGateway(url);
      return 'parked';
    }
    if (!res.ok) return null;
    // Cap the body: read as text with a hard byte ceiling.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const text = new TextDecoder().decode(buf);
    const json = JSON.parse(text) as Record<string, unknown>;
    if (!json || typeof json !== 'object') return null;
    return { socials: extractSocials(json), links: extractLinks(json) };
  } catch {
    return null;
  }
}

/**
 * The metadata file behind a URI, from the cache, a fetch already running,
 * or the gateways in turn. Null means "not known right now": a transient
 * miss that will be asked again after MISS_TTL_MS, or a background caller
 * that found the queue full. A URI nothing may ever be fetched from is
 * remembered as UNFETCHABLE and returned as such (its `links` are null).
 */
function resolve(uri: string, priority: boolean): Promise<Resolved | null> {
  const hit = cache.get(uri);
  if (hit) return Promise.resolve(hit);
  const missedAt = misses.get(uri);
  if (missedAt !== undefined && now() - missedAt < MISS_TTL_MS) return Promise.resolve(null);
  const running = inflight.get(uri);
  if (running) return running;

  const urls = candidateUrls(uri);
  if (urls.length === 0) {
    remember(uri, UNFETCHABLE);
    return Promise.resolve(UNFETCHABLE);
  }

  const p = (async (): Promise<Resolved | null> => {
    const lane = await acquire(priority);
    if (!lane) return null;
    try {
      let asked = 0;
      for (const url of urls) {
        if (gatewayParked(url)) continue;
        asked++;
        const r = await fetchOne(url);
        if (r && r !== 'parked') {
          remember(uri, r);
          return r;
        }
      }
      // Every gateway parked, or every ask failed: a miss, retried later.
      if (asked > 0) rememberMiss(uri);
      return null;
    } finally {
      release();
    }
  })().finally(() => inflight.delete(uri));
  inflight.set(uri, p);
  return p;
}

/**
 * Resolve a token's social fingerprint from its metadata URI. Never throws;
 * returns UNRESOLVED on any failure. Cached per URI. Callers should
 * fire-and-forget this from the create path — never await it in a decision.
 */
export async function fetchSocials(uri: string): Promise<TokenSocials> {
  const r = await resolve(uri, false);
  return r ? r.socials : UNRESOLVED;
}

/**
 * The links a token's creator published, for a person looking at the token.
 * Takes the lane ahead of the create-time queue, shares a fetch already in
 * flight, and is null when the file is not known right now — the caller
 * shows nothing rather than a guess, and asks again on its next build.
 */
export async function fetchMetadataLinks(uri: string): Promise<MetadataLinks | null> {
  const r = await resolve(uri, true);
  return r ? r.links : null;
}

/** The links already resolved for a URI (the create path fetched them),
 *  without a network request — the batch paths' rule. */
export function metadataLinksIfCached(uri: string): MetadataLinks | null {
  return cache.get(uri)?.links ?? null;
}

export function clearCache(): void {
  cache.clear();
  misses.clear();
  parkedUntil.clear();
}

/** Test-only: exposes the pure parser without the network fetch. */
export function extractSocialsForTest(json: Record<string, unknown>): TokenSocials {
  return extractSocials(json);
}

/** Test-only: the link extraction, pure. */
export function extractLinksForTest(json: Record<string, unknown>): MetadataLinks {
  return extractLinks(json);
}

/** Test-only: the clock the miss and park windows are measured on. */
export function setClockForTest(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

/** Test-only: which gateway hosts are currently parked. */
export function parkedGatewaysForTest(): string[] {
  const t = now();
  return [...parkedUntil.entries()].filter(([, until]) => until > t).map(([host]) => host);
}

/** Test-only: exposes the fetch allowlist without the network fetch. Every
 *  URL this returns is a URL the app will request from a creator-supplied
 *  string, so it is worth pinning. */
export function candidateUrlsForTest(uri: string): string[] {
  return candidateUrls(uri);
}import { parseKryptoDisclosure } from '@shared/kryptoMode';

