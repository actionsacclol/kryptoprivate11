// fetch() for frontend-api-v3.pump.fun, sent through Chromium's network stack.
//
// OBSERVED 2026-10-22: Cloudflare now answers POSTs from Node's fetch (undici)
// with a 403 "Just a moment..." challenge page — register and login never reach
// pump's API, so no account could be made. The same requests sent through
// Electron's own network stack (Chromium: a real browser TLS fingerprint) are
// let through and answered by pump itself, so this is the whole fix: no hidden
// window, no cookie harvesting. See fixpump.md.
//
// Cookies are omitted on purpose. pump's register sets an `auth_token` cookie,
// and a shared cookie jar would send wallet A's session on wallet B's calls;
// every authenticated call here carries its own bearer token instead.

import electron from 'electron';
import { logger } from './logger';
import { browserFetch } from './pumpBrowser';

/**
 * Whether a response is Cloudflare's bot challenge rather than pump's own
 * answer. Cloudflare marks a challenge with `cf-mitigated: challenge`; the
 * HTML content type on a 403/429/503 covers a block page without the header.
 * pump's API only ever answers JSON, so HTML here is never pump.
 */
export function isCloudflareChallenge(res: Response): boolean {
  if (res.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return true;
  if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false;
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/** Same check for a body already read as text (callers that keep only the text). */
export function isChallengeBody(text: string): boolean {
  return /<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(text);
}

/** What to tell the user when pump.fun's bot protection blocks the app. */
export const CHALLENGE_MESSAGE =
  "pump.fun's bot protection (Cloudflare) blocked this request. Try again in a minute; if it keeps happening, the app needs an update.";

let challengeLoggedAt = 0;

/**
 * OBSERVED 2026-10-22, hours after the fix above first worked: pump's hosts
 * began requesting a TLS client certificate during the handshake. A real page
 * answers that (no certificate, carry on); Electron's `net` cannot, and fails
 * with ERR_SSL_CLIENT_AUTH_CERT_NEEDED — for every pump.fun host, even GET
 * https://pump.fun/. Everything else (dexscreener, jup, cloudflare.com) still
 * works through `net`, so it is pump-specific, and the hidden pump.fun page
 * (pumpBrowser.ts) still gets through. A `select-client-certificate` handler
 * does not help: `net` never asks it.
 */
const NET_CERT_ERROR = /ERR_SSL_CLIENT_AUTH_CERT_NEEDED/;
/** After `net` has failed that way, go straight to the page for a while. */
const NET_DOWN_MS = 10 * 60_000;
let netDownUntil = 0;

const urlText = (url: string | URL | Request): string => (typeof url === 'object' && 'url' in url ? url.url : url.toString());

function viaPage(url: string | URL | Request, init: RequestInit): Promise<Response | null> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  return browserFetch(urlText(url), {
    method: init.method,
    headers,
    body: typeof init.body === 'string' ? init.body : undefined,
  }).catch((err: Error) => {
    logger.warn(`pump.fun: the hidden-page request failed — ${err.message}`);
    return null;
  });
}

/**
 * Send a request to pump.fun. Chromium's network stack first; if that is met
 * with a Cloudflare challenge, or cannot connect because of the client-
 * certificate demand, the same request is sent from inside a hidden pump.fun
 * page (pumpBrowser.ts), which carries a session token as the cookie pump's own
 * site uses. If the page cannot answer either, the original answer (or error)
 * is what the caller gets, so the message is still the real reason.
 */
export async function pumpFetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (Date.now() >= netDownUntil) {
    // `net` is absent outside Electron (offline tests); the plain fetch is the
    // right thing there.
    const net = (electron as { net?: { fetch: typeof fetch } } | undefined)?.net;
    const send = net?.fetch ? net.fetch.bind(net) : fetch;
    let res: Response;
    try {
      res = await send(url, { credentials: 'omit', ...init });
    } catch (err) {
      if (!NET_CERT_ERROR.test((err as Error).message)) throw err;
      netDownUntil = Date.now() + NET_DOWN_MS;
      logger.warn(`pump.fun: Chromium's network stack was asked for a client certificate (${(err as Error).message}); using the hidden pump.fun page for ${NET_DOWN_MS / 60_000} min`);
      const viaPageRes = await viaPage(url, init);
      if (viaPageRes) return viaPageRes;
      throw err;
    }
    if (!isCloudflareChallenge(res)) return res;
    if (Date.now() - challengeLoggedAt > 60_000) {
      challengeLoggedAt = Date.now();
      logger.warn(`pump.fun: Cloudflare challenged ${new URL(urlText(url)).pathname} (${res.status}) through Chromium; trying the hidden page — see fixpump.md`);
    }
    const viaPageRes = await viaPage(url, init);
    return viaPageRes && !isCloudflareChallenge(viaPageRes) ? viaPageRes : res;
  }
  const viaPageRes = await viaPage(url, init);
  if (viaPageRes) return viaPageRes;
  netDownUntil = 0; // the page could not run either; let the next call try `net` again
  throw new Error('pump.fun could not be reached (no hidden page available)');
}

/** Sign-in and registration use the same path as everything else now; the name stays for callers and tests. */
export const pumpAuthFetch = pumpFetch;

/** Tests: forget that `net` was marked down. */
export function _resetTransport(): void {
  netDownUntil = 0;
}
