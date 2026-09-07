// Token images, served through a custom protocol instead of loosening the CSP.
//
// THE PROBLEM. A token's icon URL is chosen by whoever created the token. The
// renderer's CSP is `img-src 'self' data: blob:` and that is correct: opening
// `img-src https:` would let any memecoin creator point a mint at their own
// server and collect the IP and timestamp of every install that scrolls past
// it — the same census attack the metadata fetcher shipped in 2026-08
// (product swarm §8.3). But a memecoin terminal with no token icons is not a
// memecoin terminal, so "just don't show images" is not a real answer either.
//
// THE FIX. `krypt-img://` is handled in the MAIN process. The renderer only
// ever asks for `krypt-img://i/<base64url of the https url>`; main decodes it
// and applies every check the renderer cannot:
//
//   • https only, and never an IP literal;
//   • the resolved address must not be loopback, link-local or private —
//     this is the DNS-rebinding / SSRF-to-localhost guard, done by resolving
//     the name ourselves before the request goes out;
//   • redirects refused outright;
//   • Content-Type must actually be an image;
//   • hard byte cap applied WHILE streaming, not after buffering;
//   • short timeout, and an in-memory LRU so scrolling the same rows twice
//     does not re-hit the host.
//
// It is still the user's IP that reaches the image host — that is unavoidable
// for a local-first app with no proxy server, and it is disclosed in the
// privacy panel with a switch to turn images off entirely.

import { protocol } from 'electron';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { IMAGE_SCHEME, decodeTarget, isPrivateAddress, isRenderableImageType } from './imageUrl';

export { IMAGE_SCHEME } from './imageUrl';

/** Registered before app-ready so the scheme behaves like a normal https
 *  image source (no opaque origin, works under a strict CSP). */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false },
    },
  ]);
}

const MAX_BYTES = 1_500_000; // 1.5 MB — generous for an icon, cheap to cap
const TIMEOUT_MS = 6_000;
const CACHE_CAP = 400;

interface Cached {
  body: Buffer;
  type: string;
  at: number;
  /** A refusal (4xx/5xx, timeout, wrong type) remembered until this time.
   *  Without it a dead or rate-limited icon was re-fetched on every mount —
   *  Discover remounts 160 cards per visit, nearly all on one CDN, and a
   *  429 there was replayed in full every time the user came back
   *  (rate-limit swarm, 2026-09-06). */
  until?: number;
}

const NEGATIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_TRANSIENT_MS = 2 * 60_000;

const cache = new Map<string, Cached>();
/** Loads in progress, so forty cards asking for the same icon share ONE
 *  request instead of sixteen parallel ones and a queue behind them. */
const inflight = new Map<string, Promise<Cached | null>>();
let enabled = true;

/** Wired to `settings.data.loadTokenImages`. Off = nothing is ever fetched. */
export function setEnabled(on: boolean): void {
  enabled = on;
  if (!on) cache.clear();
}

/** Resolve the hostname ourselves and refuse anything internal. */
async function hostIsPublic(hostname: string): Promise<boolean> {
  // An IP literal in the URL is never a legitimate token icon host, and it
  // is the simplest way to point us at something internal.
  if (isIP(hostname) !== 0) return false;
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) return false;
    return records.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

async function readCapped(res: Response): Promise<Buffer | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function put(key: string, entry: Cached): void {
  if (cache.size >= CACHE_CAP) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, CACHE_CAP / 4);
    for (const [k] of oldest) cache.delete(k);
  }
  cache.set(key, entry);
}

/** A 1x1 transparent PNG. Returned for every refusal so a blocked icon looks
 *  like an empty slot rather than a broken-image glyph. */
const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const blankResponse = (): Response =>
  new Response(BLANK, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });

export function registerImageProtocol(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    if (!enabled) return blankResponse();

    const target = decodeTarget(request.url);
    if (!target) return blankResponse();

    const hit = cache.get(target);
    if (hit) {
      if (hit.until !== undefined) {
        // A remembered refusal: blank until it ages out, no request.
        if (Date.now() < hit.until) return blankResponse();
        cache.delete(target);
      } else {
        return new Response(new Uint8Array(hit.body), {
          status: 200,
          headers: { 'content-type': hit.type, 'cache-control': 'private, max-age=3600' },
        });
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return blankResponse();
    }
    if (parsed.protocol !== 'https:') return blankResponse();
    if (!(await hostIsPublic(parsed.hostname))) return blankResponse();

    let load = inflight.get(target);
    if (!load) {
      load = fetchIcon(target, parsed).finally(() => inflight.delete(target));
      inflight.set(target, load);
    }
    const entry = await load;
    if (!entry) return blankResponse();
    return new Response(new Uint8Array(entry.body), {
      status: 200,
      headers: { 'content-type': entry.type, 'cache-control': 'private, max-age=3600' },
    });
  });
}

/** Remember that this icon could not be had, for `ms`. */
function refuse(target: string, ms: number): null {
  put(target, { body: BLANK, type: 'image/png', at: Date.now(), until: Date.now() + ms });
  return null;
}

async function fetchIcon(target: string, parsed: URL): Promise<Cached | null> {
  try {
    const res = await fetch(parsed, {
      // A 30x is how an image host pivots us somewhere we already refused.
      redirect: 'error',
      headers: {
        accept: 'image/*',
        // Do not tell the host which token page the user is on.
        'user-agent': 'KryptTerminal',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // A 429 says how long; a 404 is permanent enough for ten minutes.
      void res.body?.cancel().catch(() => undefined);
      const retryAfter = Number(res.headers.get('retry-after'));
      const ms = res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(NEGATIVE_TTL_MS, Math.max(5_000, retryAfter * 1000))
        : res.status >= 500 ? NEGATIVE_TTL_TRANSIENT_MS : NEGATIVE_TTL_MS;
      return refuse(target, ms);
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!isRenderableImageType(type)) return refuse(target, NEGATIVE_TTL_MS);

    const body = await readCapped(res);
    if (!body || body.length === 0) return refuse(target, NEGATIVE_TTL_MS);

    const entry = { body, type, at: Date.now() };
    put(target, entry);
    return entry;
  } catch {
    // Timeout or connection failure: try again in a couple of minutes.
    return refuse(target, NEGATIVE_TTL_TRANSIENT_MS);
  }
}

export function clearImageCache(): void {
  cache.clear();
}
