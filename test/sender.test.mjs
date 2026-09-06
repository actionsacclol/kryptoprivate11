// Shadow-sender + fee math tests. The sender must never emit anything but
// a shadow plan, tips/fees must be integers, and cost must add up.

import assert from 'node:assert/strict';
import { buildShadowPlan } from './.sender.mjs';

const baseAddr = {
  bondingCurve: 'BondingCurve1111111111111111111111111111111',
  creatorVault: 'CreatorVault1111111111111111111111111111111',
  sharingConfig: 'SharingConfig111111111111111111111111111111',
  associatedTokenAccount: () => 'Ata11111111111111111111111111111111111111',
  userVolumeAccumulator: () => 'Uva11111111111111111111111111111111111111',
  derivedAt: 0,
};

const fee = { p50: 50000, p75: 100000, p90: 250000, p95: 500000, source: 'rpc', scopedTo: [] };
const tips = { p50Lamports: 10000, p75Lamports: 100000, p95Lamports: 1000000, fetchedAt: 0, ok: true };

function plan(exec, firstBuy = false) {
  return buildShadowPlan({
    mint: 'Mint1111111111111111111111111111111111111',
    symbol: 'TEST',
    owner: '11111111111111111111111111111111',
    quoteLamports: 100000000n,
    exec,
    fee,
    tips,
    addr: baseAddr,
    firstBuy,
  });
}

// Every plan is flagged shadow, never anything else.
{
  const p = plan({ feeUrgency: 'competitive', useJito: true, jitoTipPercentile: 75, useHeliusSender: true, computeUnitLimit: 120000 });
  assert.equal(p.shadow, true);
  console.log('ok  plan is shadow');
}

// Jito path: the bundle lane is added BESIDE the others, not instead of
// them. This test used to assert the opposite ("jito is exclusive — one
// lane"), which is what the Execution page told users too — and neither
// matched broadcast.ts, where `lanes` always starts with 'rpc' and the paid
// lanes are appended. A rehearsal that describes a different trade from the
// performance is worse than no rehearsal.
{
  const p = plan({ feeUrgency: 'high', useJito: true, jitoTipPercentile: 95, useHeliusSender: true, computeUnitLimit: 120000 });
  const lanes = p.lanes.map((l) => l.lane);
  assert.ok(lanes.includes('jito-bundle'), 'the bundle lane is planned');
  assert.ok(lanes.includes('rpc-fallback'), 'and the public RPC lane goes out with it, as it does live');
  assert.ok(lanes.includes('helius-sender'), 'as does the staked lane when enabled');
  const jito = p.lanes.find((l) => l.lane === 'jito-bundle');
  assert.equal(jito.tipLamports, tips.p95Lamports, 'tip is the selected percentile');
  // The modelled cost must count every tip actually paid, not just one.
  assert.equal(p.estCostLamports >= tips.p95Lamports, true, 'the cost includes the bundle tip');
  console.log('ok  the jito bundle is planned alongside the public lane, as it is sent');
}

// Non-jito path: Helius Sender + RPC fallback fanout.
{
  const p = plan({ feeUrgency: 'normal', useJito: false, jitoTipPercentile: 75, useHeliusSender: true, computeUnitLimit: 120000 });
  const lanes = p.lanes.map((l) => l.lane);
  assert.ok(lanes.includes('helius-sender') && lanes.includes('rpc-fallback'));
  console.log('ok  helius + rpc fanout');
}

// Priority fee is integer and = ceil(cuPrice * cuLimit / 1e6). p90 = 250000 µlpt.
{
  const p = plan({ feeUrgency: 'high', useJito: false, jitoTipPercentile: 75, useHeliusSender: false, computeUnitLimit: 120000 });
  const priorityFee = Math.ceil((250000 * 120000) / 1e6); // 30000 lamports
  assert.equal(p.computeUnitPrice, 250000);
  // cost = base(5000) + priorityFee(30000) + tip(0, no helius/jito) + rent(0)
  assert.equal(p.estCostLamports, 5000 + priorityFee);
  assert.ok(Number.isInteger(p.estCostLamports));
  console.log('ok  integer cost math');
}

// First buy adds the one-time UVA rent; second buy does not.
{
  const first = plan({ feeUrgency: 'normal', useJito: false, jitoTipPercentile: 75, useHeliusSender: false, computeUnitLimit: 120000 }, true);
  const later = plan({ feeUrgency: 'normal', useJito: false, jitoTipPercentile: 75, useHeliusSender: false, computeUnitLimit: 120000 }, false);
  assert.ok(first.estCostLamports > later.estCostLamports, 'first buy pays UVA rent');
  console.log('ok  first-buy UVA rent');
}

console.log('sender tests passed');

// ── Private send mode ────────────────────────────────────────────────
// The one anti-sandwich lever available to a local app: send a BUY to the
// bundle lane alone, so it is never sitting in a public mempool.
{
  const { planTips } = await import('./.broadcast.mjs');
  const floor = { p50Lamports: 1000, p75Lamports: 5000, p95Lamports: 20000 };
  const base = { useJito: true, jitoTipPercentile: 75, useHeliusSender: true };

  const priv = planTips({ ...base, mevMode: 'private' }, 'buy', floor, 1);
  assert.deepEqual(priv.lanes, ['jito'], 'a private buy goes to the bundle lane ONLY');
  assert.equal(priv.private, true);
  assert.ok(priv.totalLamports > 0, 'and it pays for the bundle');

  // The rule that matters most: an EXIT is never private.
  const sell = planTips({ ...base, mevMode: 'private' }, 'sell', floor, 1);
  assert.ok(sell.lanes.includes('rpc'), 'a sell keeps the public lane');
  assert.equal(sell.private, false, 'a sell is never marked private');
  assert.equal(sell.tips.find((t) => t.lamports === floor.p95Lamports) !== undefined, true, 'and still tips at p95');

  // Private implies the bundle even if the toggle is off, or it would send
  // nothing at all.
  const forced = planTips({ ...base, useJito: false, mevMode: 'private' }, 'buy', floor, 1);
  assert.deepEqual(forced.lanes, ['jito'], 'private mode implies the bundle lane');

  // The other two modes.
  const off = planTips({ ...base, mevMode: 'off' }, 'buy', floor, 1);
  assert.deepEqual(off.lanes, ['rpc'], 'off is the public lane alone');
  assert.equal(off.totalLamports, 0, 'and pays nothing for placement');

  const fast = planTips({ ...base, mevMode: 'fast' }, 'buy', floor, 1);
  assert.ok(fast.lanes.includes('rpc') && fast.lanes.includes('jito') && fast.lanes.includes('helius-sender'));
  assert.equal(fast.private, false, 'fast is public — it must never claim otherwise');

  // An older caller with no mode behaves exactly as before.
  const legacy = planTips(base, 'buy', floor, 1);
  assert.deepEqual(legacy.lanes, fast.lanes, 'no mode set = fast');
  console.log('ok  private mode sends a buy to the bundle alone, and never an exit');
}
