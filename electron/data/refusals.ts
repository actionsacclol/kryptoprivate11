// Recognising a refusal that arrives dressed as a success.
//
// WHY THIS FILE EXISTS (API swarm 2026-09-09 §1). Everything the 2026-09-06
// rate-limit swarm built — the escalating park, the honoured `Retry-After`,
// the strike decay, the fail-fast at the front of the queue — hangs off one
// question: did the provider say no? `http.ts` used to answer that with
// `res.ok` alone, so a provider that refuses POLITELY evaded all of it:
//
//   • GeckoTerminal answers a throttle with HTTP 200 and a JSON error body.
//   • Some RPC endpoints put a JSON-RPC `error` object inside an HTTP 200.
//   • Ankr (EVM) returns an HTTP 200 auth error.
//
// Worse than "no park": the success path ran `blockedUntil.delete(id)`, so a
// polite refusal UN-PARKED a provider an honest 429 had correctly parked.
//
// So the body is now read and classified BEFORE the call is declared a
// success. Three verdicts:
//
//   'ok'      — a normal response. Nothing changes.
//   'refused' — the provider is throttling us. `http.ts` routes this into the
//               SAME park() a 429 takes: same escalation, same Retry-After
//               clamp, same strike decay.
//   'error'   — the provider answered, but not with data (an RPC error, a
//               non-429 API error). The call fails, no park is created, and
//               crucially no existing park is cleared.
//
// THE BIAS IS DELIBERATE. A false positive parks a provider that works, which
// is worse than the bug being fixed. So:
//
//   • only small bodies are inspected (a refusal is terse; a page of Discover
//     rows is 90 KB and is waved through untouched);
//   • only JSON is inspected, and only through named container shapes —
//     a JSON-RPC envelope, CoinGecko's `status.error_message`, JSON:API's
//     `errors[]`, or a top-level `error`/`message`;
//   • the loose shape (a top-level `error`/`message`, which could in
//     principle appear in real data) can ONLY ever produce 'refused', and
//     only when the text explicitly names rate limiting. It can never
//     produce 'error', so it can never break a working data path.
//
// No network, no state, no imports: pure functions, so the whole table is
// pinned offline by test/http.test.mjs.

/** What a body turned out to be. See the header for the contract. */
export type BodyVerdict = 'ok' | 'refused' | 'error';

/** Just enough of `Headers` to read a content type — the test stubs pass a
 *  plain object with a `get`, and no caller should need a real Headers. */
export interface HeaderBag {
  get(name: string): string | null;
}

/** A provider's own words about why this is not data. */
export interface RefusalSignal {
  /** Numeric code the provider attached (HTTP-ish or JSON-RPC), or null. */
  code: number | null;
  /** The provider's message. Empty when it only sent a code. */
  message: string;
}

/**
 * `strict` shapes cannot occur in a successful response, so a signal from one
 * means "this is not data" — rate limiting parks, anything else fails the
 * call. `phrase` shapes could in principle appear in real data, so a signal
 * from one is acted on ONLY when it names rate limiting.
 */
export interface RefusalRule {
  id: string;
  kind: 'strict' | 'phrase';
  extract: (body: unknown) => RefusalSignal | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function asStatusCode(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,6}$/.test(v)) return Number(v);
  return null;
}

// ── The shapes ────────────────────────────────────────────────────────

/**
 * A JSON-RPC envelope carrying an `error` object. `jsonrpc` must be present,
 * so this cannot fire on an ordinary payload that happens to have an `error`
 * field. Batched calls answer with an array; one refused member refuses the
 * batch (rpcClient re-sends the whole thing).
 */
const jsonRpc: RefusalRule = {
  id: 'jsonrpc',
  kind: 'strict',
  extract(body) {
    const one = (v: unknown): RefusalSignal | null => {
      if (!isObj(v) || typeof v.jsonrpc !== 'string') return null;
      const e = v.error;
      if (!isObj(e)) return null;
      const code = typeof e.code === 'number' ? e.code : null;
      const message = typeof e.message === 'string' ? e.message : '';
      if (code === null && !message) return null;
      return { code, message };
    };
    if (Array.isArray(body)) {
      for (const item of body) {
        const sig = one(item);
        if (sig) return sig;
      }
      return null;
    }
    return one(body);
  },
};

/**
 * CoinGecko's throttle shape, which GeckoTerminal's public API inherits:
 * `{"status":{"error_code":429,"error_message":"You've exceeded the Rate
 * Limit…"}}` — served with HTTP 200. A successful GeckoTerminal document has
 * no `status.error_*`, so this cannot fire on data.
 */
const coinGeckoStatus: RefusalRule = {
  id: 'coingecko-status',
  kind: 'strict',
  extract(body) {
    if (!isObj(body)) return null;
    const st = body.status;
    if (!isObj(st)) return null;
    const code = asStatusCode(st.error_code);
    const message = typeof st.error_message === 'string' ? st.error_message : '';
    if (code === null && !message) return null;
    return { code, message };
  },
};

/**
 * JSON:API's error document — GeckoTerminal's other refusal form,
 * `{"errors":[{"status":"429","title":"Rate limit exceeded"}]}`. The spec
 * forbids `data` and `errors` in the same document, so a body carrying
 * `data` is left alone regardless.
 */
const jsonApiErrors: RefusalRule = {
  id: 'jsonapi-errors',
  kind: 'strict',
  extract(body) {
    if (!isObj(body) || 'data' in body) return null;
    const errs = body.errors;
    if (!Array.isArray(errs) || errs.length === 0) return null;
    const first = errs.find(isObj);
    if (!first) return null;
    const code = asStatusCode(first.status);
    const message = [first.title, first.detail].filter((v): v is string => typeof v === 'string').join(': ');
    if (code === null && !message) return null;
    return { code, message };
  },
};

/**
 * The loose one: a top-level `error` / `message` / `msg`, as a string or as
 * an object with its own `message`. Birdeye's `{"success":false,"message":…}`
 * and most hand-rolled API errors land here.
 *
 * `kind: 'phrase'` — a real payload could carry a field with one of these
 * names, so a signal from this shape is acted on ONLY when the text names
 * rate limiting, and can only ever produce 'refused', never 'error'.
 */
const plainError: RefusalRule = {
  id: 'plain-error',
  kind: 'phrase',
  extract(body) {
    if (!isObj(body)) return null;
    const raw = body.error ?? body.message ?? body.msg;
    let message = '';
    let code: number | null = null;
    if (typeof raw === 'string') message = raw;
    else if (isObj(raw)) {
      if (typeof raw.message === 'string') message = raw.message;
      code = asStatusCode(raw.code);
    }
    if (!message) return null;
    return { code, message };
  },
};

// ── Is this signal a refusal? ─────────────────────────────────────────

/**
 * Specific, quoted wording only. Every alternative below names throttling
 * outright; none of them can be read out of a token name, a symbol or a
 * description, which is the data these bodies otherwise carry.
 */
const RATE_LIMIT_PHRASE =
  /(rate[\s_-]?limit|too many requests|quota (?:exceeded|exhausted|reached)|exceeded (?:the |your )?(?:rate |request |daily |monthly )?(?:limit|quota)|throttl|slow down)/i;

/**
 * Codes that mean throttling and cannot appear in data:
 *   429     — HTTP, echoed into a 200 body by CoinGecko and JSON:API errors.
 *   -32005  — JSON-RPC "limit exceeded" (the reserved server-error range).
 *   -32029  — the same thing at several EVM providers.
 */
const RATE_LIMIT_CODES = new Set([429, -32005, -32029]);

function isRateLimit(sig: RefusalSignal): boolean {
  if (sig.code !== null && RATE_LIMIT_CODES.has(sig.code)) return true;
  return sig.message.length > 0 && RATE_LIMIT_PHRASE.test(sig.message);
}

// ── The per-provider table ────────────────────────────────────────────

/** Applied to every provider. Both shapes are name-gated, so they cost one
 *  property read on a body that is not an error. */
export const DEFAULT_REFUSAL_RULES: readonly RefusalRule[] = [jsonRpc, plainError];

/**
 * Extra shapes a specific provider is known to use, checked before the
 * defaults. Keyed loosely (`string`, not `ProviderId`) so the same classifier
 * can serve the RPC and EVM rails, which are not market providers.
 */
export const PROVIDER_REFUSAL_RULES: Record<string, readonly RefusalRule[]> = {
  // Observed 2026-09-09: a throttle arrives as HTTP 200 with a JSON error
  // body, in either the CoinGecko or the JSON:API form.
  geckoterminal: [coinGeckoStatus, jsonApiErrors],
};

export function rulesFor(id: string): readonly RefusalRule[] {
  return [...(PROVIDER_REFUSAL_RULES[id] ?? []), ...DEFAULT_REFUSAL_RULES];
}

/**
 * Bodies larger than this are waved through unread. A refusal is terse — the
 * largest observed is a few hundred bytes — while real payloads run to
 * hundreds of KB, so the cap removes the false-positive surface AND the cost
 * of parsing a big document twice.
 */
export const MAX_INSPECT_BYTES = 16 * 1024;

/** The verdict plus the provider's own words, for the log line. */
export function describeBody(
  id: string,
  status: number,
  headers: HeaderBag | null,
  bodyText: string,
): { verdict: BodyVerdict; detail: string } {
  // A real 429 never reaches here (http.ts handles it on the !ok branch), but
  // the function must not disagree with it if it ever does.
  if (status === 429) return { verdict: 'refused', detail: '' };
  if (status < 200 || status >= 300) return { verdict: 'error', detail: '' };

  const trimmed = bodyText.trim();
  if (!trimmed || trimmed.length > MAX_INSPECT_BYTES) return { verdict: 'ok', detail: '' };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { verdict: 'ok', detail: '' };
  // Some providers answer errors as text/plain; anything that declares a
  // non-JSON, non-text type is not something to second-guess.
  let ct = '';
  try {
    ct = (headers?.get('content-type') ?? '').toLowerCase();
  } catch {
    ct = '';
  }
  if (ct && !ct.includes('json') && !ct.includes('text/plain')) return { verdict: 'ok', detail: '' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { verdict: 'ok', detail: '' };
  }

  for (const rule of rulesFor(id)) {
    const sig = rule.extract(parsed);
    if (!sig) continue;
    const detail = (sig.message || (sig.code === null ? '' : `code ${sig.code}`)).replace(/\s+/g, ' ').slice(0, 160);
    if (isRateLimit(sig)) return { verdict: 'refused', detail };
    // A loose shape that did not name rate limiting is not evidence of
    // anything — keep reading, and fall through to 'ok'.
    if (rule.kind === 'strict') return { verdict: 'error', detail };
  }
  return { verdict: 'ok', detail: '' };
}

/**
 * Does this response body mean the call actually succeeded?
 *
 * Called by `http.ts` before the `res.ok` branch decides. 'refused' takes the
 * park path; 'error' fails the call without touching the park either way.
 */
export function classifyBody(id: string, status: number, headers: HeaderBag | null, bodyText: string): BodyVerdict {
  return describeBody(id, status, headers, bodyText).verdict;
}
