// Jito tip-floor feed — research action #2/#3. The Jito block engine's
// tip floor moves with demand; a launch snipe needs a p75–p95 tip to land.
// We poll the public tip_floor REST endpoint and cache it. Tips are SOL
// floats from Jito (converted to integer lamports for the sender).

const TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface TipFloor {
  p50Lamports: number;
  p75Lamports: number;
  p95Lamports: number;
  fetchedAt: number;
  ok: boolean;
}

let cached: TipFloor = { p50Lamports: 10_000, p75Lamports: 100_000, p95Lamports: 1_000_000, fetchedAt: 0, ok: false };

const toLamports = (sol: number): number => Math.max(1_000, Math.round(sol * LAMPORTS_PER_SOL));

/** Jito allows 1 request/s per IP across ALL its endpoints, tip_floor
 *  included. The 8 s execution poll, the 30 s prewarm heartbeat and the
 *  per-order refresh added up to ~570 GETs an hour for a number that barely
 *  moves — and a 429 cannot even be told from a stale cache. Fresh enough
 *  is served from memory; one request is in flight at a time; a refusal
 *  holds the next attempt off for a minute. */
const TIP_FRESH_MS = 30_000;
const TIP_REFUSED_HOLD_MS = 60_000;
let inflightRefresh: Promise<TipFloor> | null = null;
let nextAllowedAt = 0;

export async function refresh(): Promise<TipFloor> {
  const now = Date.now();
  if (now - cached.fetchedAt < TIP_FRESH_MS || now < nextAllowedAt) return cached;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = fetchFloor().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function fetchFloor(): Promise<TipFloor> {
  try {
    const res = await fetch(TIP_FLOOR_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      nextAllowedAt = Date.now() + TIP_REFUSED_HOLD_MS;
      return cached;
    }
    const body = (await res.json()) as Array<{
      landed_tips_50th_percentile?: number;
      landed_tips_75th_percentile?: number;
      landed_tips_95th_percentile?: number;
    }>;
    const row = body[0];
    if (!row) return cached;
    cached = {
      p50Lamports: toLamports(row.landed_tips_50th_percentile ?? 0.00001),
      p75Lamports: toLamports(row.landed_tips_75th_percentile ?? 0.0001),
      p95Lamports: toLamports(row.landed_tips_95th_percentile ?? 0.001),
      fetchedAt: Date.now(),
      ok: true,
    };
    return cached;
  } catch {
    return cached;
  }
}

export function current(): TipFloor {
  return cached;
}
