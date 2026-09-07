// Telling apart the RPC failures that mean "try again" from the ones that
// mean "your key is wrong".
//
// A 5xx, a 429 or a dropped socket is weather: retry, then use the other
// endpoint. A 401 or 403 is not — the endpoint is working perfectly and is
// telling you the credentials are bad. Retrying it cannot help, and until
// 2026-09-06 it did not even fail over: the call simply returned "RPC HTTP
// 401" and every read, chart and trade failed with that string until the
// user worked out what it meant.
//
// So a rejected key now does three things at once: stops being retried,
// starts being skipped in favour of the public endpoint so the app keeps
// working, and produces a sentence that names the fix.

export type RpcFailureKind = 'transient' | 'rate-limited' | 'unauthorized' | 'other';

export function classifyRpcFailure(message: string): RpcFailureKind {
  if (/^RPC HTTP 429$/.test(message)) return 'rate-limited';
  if (/^RPC HTTP (401|403)$/.test(message)) return 'unauthorized';
  if (/^RPC HTTP 5\d\d$/.test(message) || /^RPC HTTP 408$/.test(message)) return 'transient';
  if (/fetch failed|ECONN|EAI_AGAIN|socket|network|other side closed/i.test(message)) return 'transient';
  return 'other';
}

/** Worth retrying the SAME endpoint. A rate limit is, after a longer pause. */
export function isRetryable(message: string): boolean {
  const k = classifyRpcFailure(message);
  return k === 'transient' || k === 'rate-limited';
}

/** The endpoint refused the credentials: never retry, always fail over. */
export function isUnauthorized(message: string): boolean {
  return classifyRpcFailure(message) === 'unauthorized';
}

/**
 * What to tell the user, once, naming the host but NEVER the URL — a keyed
 * RPC URL carries the key in its query string, so it must not reach a log or
 * a toast.
 */
export function credentialsMessage(host: string, code: '401' | '403'): string {
  const why = code === '401' ? 'rejected your key' : 'refused access with that key';
  return (
    `${host} ${why} (HTTP ${code}). Krypto Bot has moved to the public endpoint, so trading still works, ` +
    'but speed-sensitive features are limited until it is fixed. Paste a working key in Settings, under Helius API key.'
  );
}

/** Host only, so a key in the query string can never be logged. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the RPC endpoint';
  }
}

/**
 * Did this failure text come from a rate limit — an RPC's "HTTP 429", or a
 * provider the HTTP layer parked ("rate limited")? Loose on purpose: the
 * message has usually been wrapped ("Simulation call failed: RPC HTTP 429")
 * by the time anyone asks, so the anchored classifier above cannot see it.
 */
export function mentionsRateLimit(message: string): boolean {
  return /RPC HTTP 429|rate limited|\(429\)/i.test(message ?? '');
}

/**
 * A failure of the TRANSPORT rather than of the transaction: a 429, a 5xx,
 * a dropped socket, a timeout. Used where a simulation failure would
 * otherwise be read as "the template is stale" — a host saying "slow down"
 * proves nothing about the transaction it never simulated.
 */
export function isTransportFailureMessage(message: string): boolean {
  const m = message ?? '';
  if (mentionsRateLimit(m)) return true;
  if (/RPC HTTP (5\d\d|408)/.test(m)) return true;
  return /fetch failed|ECONN|EAI_AGAIN|socket|network|other side closed|timed out|aborted/i.test(m);
}
