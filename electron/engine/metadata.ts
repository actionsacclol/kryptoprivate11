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

const TIMEOUT_MS = 4_000;
const MAX_BYTES = 64 * 1024;
const MAX_CONCURRENT = 4;
const CACHE_CAP = 20_000;
// Public IPFS gateways, tried in order. HTTPS only — anything else is rejected.
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
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

const cache = new Map<string, TokenSocials>();
let inFlight = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
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

async function fetchOne(url: string): Promise<TokenSocials | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    // Cap the body: read as text with a hard byte ceiling.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const text = new TextDecoder().decode(buf);
    const json = JSON.parse(text) as Record<string, unknown>;
    if (!json || typeof json !== 'object') return null;
    return extractSocials(json);
  } catch {
    return null;
  }
}

/**
 * Resolve a token's social fingerprint from its metadata URI. Never throws;
 * returns UNRESOLVED on any failure. Cached per URI. Callers should
 * fire-and-forget this from the create path — never await it in a decision.
 */
export async function fetchSocials(uri: string): Promise<TokenSocials> {
  const cached = cache.get(uri);
  if (cached) return cached;
  const urls = candidateUrls(uri);
  if (urls.length === 0) return UNRESOLVED;

  await acquire();
  try {
    for (const url of urls) {
      const r = await fetchOne(url);
      if (r) {
        if (cache.size >= CACHE_CAP) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(uri, r);
        return r;
      }
    }
  } finally {
    release();
  }
  // Cache the miss too — a dead URI shouldn't be retried all window.
  if (cache.size < CACHE_CAP) cache.set(uri, UNRESOLVED);
  return UNRESOLVED;
}

export function clearCache(): void {
  cache.clear();
}

/** Test-only: exposes the pure parser without the network fetch. */
export function extractSocialsForTest(json: Record<string, unknown>): TokenSocials {
  return extractSocials(json);
}

/** Test-only: exposes the fetch allowlist without the network fetch. Every
 *  URL this returns is a URL the app will request from a creator-supplied
 *  string, so it is worth pinning. */
export function candidateUrlsForTest(uri: string): string[] {
  return candidateUrls(uri);
}
