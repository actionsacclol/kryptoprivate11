// The pump.fun Cloudflare wall — one gate for every pump.fun host.
//
// MEASURED 2026-10-22: after a day of the app's creator lookups striking out
// on 429s (strike 5, parked over and over) while a second install scanned
// from the same IP, every pump.fun host — frontend-api-v3, swap-api,
// advanced-api, the site itself — started answering 403 with
// `cf-mitigated: challenge` and Cloudflare's "Just a moment..." page. It is
// not an answer from pump: the request never reached them. Sign-in read as
// "pump.fun refused the sign-in (403)", which says the wallet is wrong; it was
// not.
//
// What the app did next is the part this file fixes. The challenge counted as
// an ordinary failure per route, so every route had to fail ten times before
// it stood down, and the account, social and callout code — which calls fetch
// directly — never stood down at all. A challenge earned by volume is kept up
// by volume. So one challenge anywhere stops EVERY pump.fun call, app-wide,
// for fifteen minutes, doubling to two hours while it persists; when that
// runs out exactly one call goes through to see whether the check is gone.
//
// That wall is the BACKSTOP. The first line of defence (same day) is the
// transport: the Electron app sends pump.fun requests through Chromium's own
// network stack (system/pumpTransport.ts), which Cloudflare lets through where
// Node's fetch is challenged, and sign-in/registration can fall back to a
// request sent from inside a hidden pump.fun page (system/pumpBrowser.ts).
// Only a challenge that survives both raises the wall. See fixpump.md.

import { humanWait } from '@shared/market';

const WALL_FIRST_MS = 15 * 60_000;
const WALL_MAX_MS = 2 * 60 * 60_000;

/**
 * How a request leaves the process. Node's fetch by default — tests and any
 * non-Electron caller — and replaced at startup by Chromium's network stack
 * (system/pumpTransport.ts). Injected, not imported, so this module never
 * imports `electron`: tests bundle it without.
 */
type Transport = (url: string | URL, init?: RequestInit) => Promise<Response>;
let transport: Transport = (url, init) => fetch(url, init);
let pageTransport: Transport | null = null;
export function setTransport(main: Transport, page?: Transport): void {
  transport = main;
  pageTransport = page ?? null;
}

let wallUntil = 0;
/** The length of the current wall, 0 when there is none. Doubles per repeat. */
let wallMs = 0;
/** After the wall lapses, the one call allowed through to look. */
let probing = false;

type WallLog = (level: 'info' | 'warn', line: string) => void;
let log: WallLog = () => {};
export function attachLog(fn: WallLog): void {
  log = fn;
}

/** pump.fun or any of its subdomains — the hosts behind one Cloudflare zone. */
export function isPumpHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'pump.fun' || h.endsWith('.pump.fun');
}

/**
 * Cloudflare's own marker for "this response is a challenge, not the site".
 * Documented by Cloudflare and present on every challenged reply observed on
 * 2026-10-22, whatever the status; a plain 403 from pump does not carry it.
 */
export function isChallenge(headers: Headers): boolean {
  return (headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge';
}

/** Milliseconds until pump.fun calls go out again, or 0. */
export function wallRemainingMs(now = Date.now()): number {
  return Math.max(0, wallUntil - now);
}

/** True while a challenge has been seen and not yet cleared by an answer. */
export function wallUp(): boolean {
  return wallMs > 0;
}

/** What to tell the user. Names the cause so nobody goes looking at their key. */
export function wallMessage(now = Date.now()): string {
  const left = wallRemainingMs(now);
  return `pump.fun is putting this app's connections through a Cloudflare browser check, so its replies are blocked — your wallet and account are fine. The app has stopped asking pump.fun ${left > 0 ? `for ${humanWait(left)}` : 'until the check clears'} so it can lift.`;
}

/** Record a challenge. Extends the wall, never shortens it. */
export function noteWall(now = Date.now()): number {
  probing = false;
  const first = wallMs === 0;
  wallMs = first ? WALL_FIRST_MS : Math.min(wallMs * 2, WALL_MAX_MS);
  wallUntil = Math.max(wallUntil, now + wallMs);
  log('warn', `pump.fun: Cloudflare browser check on app connections${first ? '' : ' again'} — every pump.fun call paused ${humanWait(wallMs)}. Trading is unaffected (pump trades are built locally).`);
  return wallMs;
}

/** Any reply that is not a challenge means the wall is down. */
export function noteAnswer(): void {
  probing = false;
  if (wallMs === 0) return;
  wallMs = 0;
  wallUntil = 0;
  log('info', 'pump.fun: answering again — the Cloudflare check has cleared.');
}

/**
 * Whether a call may go out now. While the wall stands, none. Once it lapses,
 * exactly one — the probe — until that call reports back through `noteWall`,
 * `noteAnswer` or `release`.
 */
export function take(now = Date.now()): boolean {
  if (now < wallUntil) return false;
  if (wallMs === 0) return true;
  if (probing) return false;
  probing = true;
  return true;
}

/** The probe failed without an answer (timeout, network): let another look. */
export function release(): void {
  probing = false;
}

export class PumpWallError extends Error {
  readonly pumpWall = true;
}

/**
 * fetch, for a pump.fun URL. Throws `PumpWallError` instead of sending while
 * the wall stands, and instead of returning a challenge page — so a caller's
 * existing `catch` reports the real cause rather than "refused (403)".
 */
export async function pumpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return renewing(url, init, false);
}

/**
 * pumpFetch for sign-in and registration, the two calls nothing can do without.
 * If the transport's answer is STILL a challenge, the same request is sent from
 * inside a hidden pump.fun page (a page that has passed the browser check)
 * before the wall goes up. Only for calls that need nothing but `content-type`:
 * a page cannot send a bearer header or cookie (pumpBrowser.ts).
 */
export async function pumpAuthFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return renewing(url, init, true);
}

// ─── A session that has lapsed renews itself ─────────────────────────────
//
// pump answers 401 once a session token has expired. system/pumpAuth.ts can
// sign the wallet in again without anyone being asked (the key is already
// held), so it registers a renewer here: a 401 on a call that carried a session
// token asks it for a fresh token and sends the same request once more with
// that token. One retry only — a second 401 is the caller's answer. The
// renewer is the one that limits how often a wallet is signed in again.

type SessionRenewer = (staleToken: string) => Promise<string | null>;
let renewer: SessionRenewer | null = null;

/** system/pumpAuth.ts: how a stale token becomes a fresh one (null when it cannot). */
export function setSessionRenewer(fn: SessionRenewer | null): void {
  renewer = fn;
}

function headerRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** The session token a request carries, from Authorization or the auth_token cookie. */
function sessionTokenOf(h: Record<string, string>): string | null {
  const a = h.authorization?.match(/^Bearer\s+(\S+)/i);
  if (a) return a[1];
  return h.cookie?.match(/(?:^|;\s*)auth_token=([^;\s]+)/)?.[1] ?? null;
}

async function renewing(url: string | URL, init: RequestInit | undefined, allowPage: boolean): Promise<Response> {
  const res = await gated(url, init, allowPage);
  if (res.status !== 401 || !renewer) return res;
  const headers = headerRecord(init?.headers);
  const stale = sessionTokenOf(headers);
  if (!stale) return res;
  const fresh = await renewer(stale).catch(() => null);
  if (!fresh || fresh === stale) return res;
  for (const k of ['authorization', 'cookie']) if (headers[k]) headers[k] = headers[k].split(stale).join(fresh);
  log('info', 'pump.fun: a call answered 401; retrying once with a renewed session');
  return gated(url, { ...init, headers, signal: AbortSignal.timeout(15_000) }, allowPage);
}

async function gated(url: string | URL, init: RequestInit | undefined, allowPage: boolean): Promise<Response> {
  if (!take()) throw new PumpWallError(wallMessage());
  let res: Response;
  try {
    res = await transport(url, init);
  } catch (err) {
    release();
    throw err;
  }
  if (allowPage && pageTransport && isChallenge(res.headers)) {
    void res.body?.cancel().catch(() => undefined);
    try {
      res = await pageTransport(url, init);
    } catch (err) {
      log('warn', `pump.fun: the hidden-page fallback could not run — ${(err as Error).message}`);
    }
  }
  if (isChallenge(res.headers)) {
    void res.body?.cancel().catch(() => undefined);
    noteWall();
    throw new PumpWallError(wallMessage());
  }
  noteAnswer();
  return res;
}

/** Test seam: forget any wall. */
export function _reset(): void {
  renewer = null;
  transport = (url, init) => fetch(url, init);
  pageTransport = null;
  wallUntil = 0;
  wallMs = 0;
  probing = false;
}
