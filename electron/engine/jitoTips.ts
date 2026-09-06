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

export async function refresh(): Promise<TipFloor> {
  try {
    const res = await fetch(TIP_FLOOR_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return cached;
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
