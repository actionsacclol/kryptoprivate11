// Reward-rate arithmetic, shared by the main-process provider and the page.
//
// Kept here rather than in the provider because the renderer needs it too,
// and a renderer importing from `electron/` would drag main-process code into
// the browser bundle.

/**
 * What a published reward rate becomes once YOUR money is in the pool.
 *
 * Merkl's `apr` is exactly `dailyRewards × 365 ÷ tvl`, so this is division,
 * not a model: adding `addUsd` to the denominator is the whole calculation.
 * A 292.9% headline becomes 149.0% with $100k added — and the headline, the
 * rate BEFORE you arrive, is what every tool in this category displays.
 *
 * **This is the PESSIMISTIC bound and must be labelled as one.** It assumes a
 * fixed pot shared among depositors. Many campaigns are instead rate-TARGETED
 * — `MAX_APR`, `SOFR_SPREAD_RATCHET`, observed on chain 4663 on 2026-09-09 —
 * where the sponsor pins the APR and their daily spend floats to whatever
 * holding it costs; there, your arrival does not dilute you at all. The
 * distribution method lives on Merkl's `/v4/campaigns`, which the provider
 * does not fetch, so the honest thing is to show the bound and say which one
 * it is rather than assert a single number.
 *
 * Null in, null out — never a zero. An unknown TVL means an unknown rate.
 */
export function dilutedAprPct(dailyRewardsUsd: number | null, tvlUsd: number | null, addUsd: number): number | null {
  if (dailyRewardsUsd === null || tvlUsd === null) return null;
  if (!Number.isFinite(dailyRewardsUsd) || !Number.isFinite(tvlUsd) || !Number.isFinite(addUsd)) return null;
  if (addUsd < 0) return null;
  const denom = tvlUsd + addUsd;
  if (!(denom > 0)) return null;
  return ((dailyRewardsUsd * 365) / denom) * 100;
}
