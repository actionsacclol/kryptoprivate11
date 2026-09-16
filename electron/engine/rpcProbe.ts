// Measure the endpoints this install is actually configured to use.
//
// Custom RPC has been settable for a long time (`rpc.httpUrl`, `rpc.wssUrl`,
// `rpc.extraWssUrls`, a Helius key, and since 2026-09-15 `rpc.fastHttpUrl`
// for the execution lane). What was never possible was finding out whether
// any of it helped: someone pastes a paid endpoint, sees no number change,
// and has no way to tell a faster one from a slower one. This is that
// number.
//
// What it measures, deliberately:
//
//   • `getLatestBlockhash` round trip, several times, reporting the MEDIAN
//     and the best — a single sample on a shared network is noise, and the
//     median is what an order will actually meet.
//   • the slot each endpoint reports, so an endpoint that is FAST because it
//     is behind the chain is visible as behind rather than as good.
//   • whether it will serve `getTokenAccountsByOwner`, the method the free
//     public endpoints refuse and that holder and balance reads need.
//
// It is a diagnostic, so it goes through plain fetch rather than
// `rpcClient.call`: the client's parks, buckets, key billing and failover
// are exactly the machinery a measurement must not have between it and the
// wire. It is also why this cannot run itself — it is only ever a button.


export interface ProbeResult {
  /** What this endpoint is FOR, in the user's words. */
  label: string;
  /** Host only — a URL can carry an API key and this is rendered and logged. */
  host: string;
  ok: boolean;
  /** Median round trip over `samples`, ms. Null when nothing succeeded. */
  medianMs: number | null;
  bestMs: number | null;
  /** The slot it reported, and how far behind the best endpoint that is. */
  slot: number | null;
  behindSlots: number | null;
  /** Does it serve the method holder/balance reads need? Null = not asked. */
  servesTokenAccounts: boolean | null;
  /** Why it failed, in the endpoint's own words where there are any. */
  message: string;
}

const SAMPLES = 5;
const TIMEOUT_MS = 6_000;

/** Host only. A probe result is rendered, logged and copied into bug
 *  reports, and an endpoint URL routinely carries the key as a query
 *  parameter. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}

async function rpc(url: string, method: string, params: unknown[]): Promise<{ ms: number; result?: unknown; error?: string }> {
  const started = Date.now();
  try {
    // Plain fetch, so the global undici agent (netAgent.ts, 60 s keep-alive)
    // is in play — measuring a cold connection every time would report a
    // number no real order ever meets.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return { ms, error: `HTTP ${res.status}` };
    const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (body.error) return { ms, error: body.error.message ?? 'RPC error' };
    return { ms, result: body.result };
  } catch (e) {
    return { ms: Date.now() - started, error: (e as Error).message.slice(0, 120) };
  }
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Time one endpoint.
 *
 * Samples run one after another, not in parallel: concurrent requests to the
 * same host queue against each other and would measure our own pipelining
 * rather than the endpoint.
 */
export async function probeEndpoint(label: string, url: string, owner?: string): Promise<ProbeResult> {
  const out: ProbeResult = {
    label,
    host: hostOf(url),
    ok: false,
    medianMs: null,
    bestMs: null,
    slot: null,
    behindSlots: null,
    servesTokenAccounts: null,
    message: '',
  };
  const times: number[] = [];
  let lastError = '';
  for (let i = 0; i < SAMPLES; i += 1) {
    const r = await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (r.error) {
      lastError = r.error;
      continue;
    }
    times.push(r.ms);
    const ctx = (r.result as { context?: { slot?: number } } | undefined)?.context;
    if (typeof ctx?.slot === 'number') out.slot = ctx.slot;
  }
  out.medianMs = median(times);
  out.bestMs = times.length ? Math.min(...times) : null;
  out.ok = times.length > 0;
  out.message = out.ok
    ? times.length < SAMPLES
      ? `${times.length}/${SAMPLES} answered — ${lastError}`
      : 'ok'
    : lastError || 'no answer';

  // The method the free endpoints refuse. Only worth asking of an endpoint
  // that answered at all, and only when there is an address to ask about —
  // an install with no wallet gets a null, which renders as unknown.
  if (out.ok && owner) {
    const r = await rpc(url, 'getTokenAccountsByOwner', [
      owner,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    out.servesTokenAccounts = !r.error;
  }
  return out;
}

/**
 * Probe every endpoint this install would actually use, labelled by the job
 * each one does.
 *
 * `behindSlots` is filled afterwards against the highest slot any of them
 * reported — an endpoint that answers in 40 ms from 200 slots back is not a
 * fast endpoint, and a table of round trips alone would say it was.
 */
export async function probeAll(
  endpoints: Array<{ label: string; url: string }>,
  owner?: string,
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  // Serial across endpoints too: several at once share this machine's uplink
  // and would time each other's contention.
  for (const e of endpoints) {
    if (!e.url) continue;
    out.push(await probeEndpoint(e.label, e.url, owner));
  }
  const best = out.reduce<number | null>((a, r) => (r.slot !== null && (a === null || r.slot > a) ? r.slot : a), null);
  if (best !== null) {
    for (const r of out) if (r.slot !== null) r.behindSlots = best - r.slot;
  }
  return out;
}
