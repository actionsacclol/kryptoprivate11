// Multi-lane sender — research action #3, running in SHADOW MODE.
//
// This builds the exact send plan a live buy would use — lane selection,
// dynamic Jito tip from the live tip floor, compute-unit price from the
// fee estimator, prewarmed accounts, modeled all-in cost — and records
// what it WOULD submit. It never constructs a signed transaction, never
// holds a key, never touches the network to send. It is the rehearsal the
// live signer will step into once Phase-2 gates pass.
//
// Landing strategy encoded here (from the research swarm):
//  - Free default: Helius Sender swqosOnly, ~5000-lamport tip, near-zero cost.
//  - Paid: Jito bundle (revert-protected — a reverting bundle is not
//    included, so a failed trade costs no tip) with a tip_floor-driven tip.
//    It is sent ALONGSIDE the RPC lane, not instead of it: broadcast.ts
//    always includes 'rpc' (planTips, and the rebuild in liveSigner). An
//    earlier note here claimed the bundle was exclusive; it never was, and
//    the difference matters — a publicly broadcast transaction is visible
//    to anyone watching the mempool.
//  - One signature fanned to N lanes; the runtime dedupes, so fanout is safe.
//  - maxRetries=0, skipPreflight, own retry loop keyed on lastValidBlockHeight
//    (~151 blocks / ~60s); on expiry, re-price and rebuild — never replay stale.

import type { ExecutionSettings, ShadowSendPlan, SendLanePlan } from '@shared/types';
import type { FeeEstimate } from './feeEstimator';
import { priceFor } from './feeEstimator';
import type { TipFloor } from './jitoTips';
import type { PrewarmedAddresses } from '../chain/addresses';

const BASE_FEE_LAMPORTS = 5_000; // 1 signature
const UVA_RENT_LAMPORTS = 1_844_400; // one-time user_volume_accumulator rent on first buy
const HELIUS_SWQOS_TIP = 5_000;

export interface BuildPlanInput {
  mint: string;
  symbol: string;
  owner: string; // the (hypothetical) trading wallet
  quoteLamports: bigint;
  exec: ExecutionSettings;
  fee: FeeEstimate;
  tips: TipFloor;
  addr: PrewarmedAddresses;
  /** True only for the wallet's first-ever buy (UVA rent applies once). */
  firstBuy: boolean;
}

function tipFromFloor(tips: TipFloor, pct: 50 | 75 | 95): number {
  return pct === 50 ? tips.p50Lamports : pct === 75 ? tips.p75Lamports : tips.p95Lamports;
}

/** Construct the shadow send plan. Pure — no I/O, no signing. */
export function buildShadowPlan(input: BuildPlanInput): ShadowSendPlan {
  const { exec, fee, tips, addr } = input;
  const cuPrice = priceFor(fee, exec.feeUrgency);
  // Priority fee (lamports) = ceil(cuPrice(µlamports/CU) × CU limit / 1e6).
  const priorityFee = Math.ceil((cuPrice * exec.computeUnitLimit) / 1_000_000);

  // The shadow plan must describe what the LIVE path actually does, or the
  // rehearsal is a different trade from the performance. broadcast.ts always
  // sends to 'rpc' and adds the paid lanes beside it, so this does the same.
  const lanes: SendLanePlan[] = [];
  let tip = 0;
  if (exec.useHeliusSender) {
    tip += HELIUS_SWQOS_TIP;
    lanes.push({ lane: 'helius-sender', detail: 'swqosOnly staked landing (free on all plans)', tipLamports: HELIUS_SWQOS_TIP });
  }
  if (exec.useJito) {
    const jitoTip = tipFromFloor(tips, exec.jitoTipPercentile);
    tip += jitoTip;
    lanes.push({
      lane: 'jito-bundle',
      detail: `revert-protected bundle, tip p${exec.jitoTipPercentile} of live floor — sent alongside RPC, not instead of it`,
      tipLamports: jitoTip,
    });
  }
  lanes.push({ lane: 'rpc-fallback', detail: 'primary RPC, skipPreflight, maxRetries=0 — always sent', tipLamports: 0 });

  const rent = input.firstBuy ? UVA_RENT_LAMPORTS : 0;
  const estCost = BASE_FEE_LAMPORTS + priorityFee + tip + rent;

  return {
    mint: input.mint,
    symbol: input.symbol,
    builtAt: Date.now(),
    bondingCurve: addr.bondingCurve,
    creatorVault: addr.creatorVault,
    associatedTokenAccount: addr.associatedTokenAccount(input.owner),
    computeUnitPrice: cuPrice,
    computeUnitLimit: exec.computeUnitLimit,
    feeSource: fee.source,
    lanes,
    estCostLamports: estCost,
    shadow: true,
  };
}
