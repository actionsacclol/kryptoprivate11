// EVM manual trades — quote, build, simulate, sign, send, confirm, record —
// for Robinhood Chain and BNB Smart Chain. The counterpart of
// engine/liveSigner.ts.
//
// The order is the same as on Solana and for the same reasons: the exact
// calldata is simulated (eth_call + estimateGas) before anything is signed,
// the signer's policy is re-checked on the raw fields as the last gate, and
// the fill is reconciled from the receipt rather than from what was asked
// for. Per venue:
//   • Pons curve (Robinhood): direct `buy`/`sell`, or Krypt's curve router
//     when deployed (fee in the same tx + interlock); else the buy's fee
//     follows as its own transfer that never blocks the fill.
//   • four.meme curve (BNB): direct `buyTokenAMAP` (fee follows) and
//     `sellToken(…, feeRate, feeRecipient)` — the platform pays the fee to
//     the treasury atomically on sells (no referrer split there).
//   • Uniswap v3/v4, PancakeSwap v2/v3: the chain's Universal Router with the
//     fee INSIDE the call (TRANSFER on buys, PAY_PORTION / TAKE_PORTION on
//     sells) and the buy-side interlock on the calldata. Sells first need
//     the chain's Permit2 approvals; four.meme sells need an approval to the
//     token manager. Each approval goes through the same policy.
// Paper mode is a SIMULATION of the real bytes with a pretend balance;
// nothing is broadcast and no paper position is kept.

import { keccak256, type Address, type Hex } from 'viem';
import { broadcastClient, client, feeFields, waitForReceipt } from './client';
import { ADDR, SELECTOR, TOPIC } from './chain';
import { ADDR_BSC, SELECTOR_BSC } from './bsc';
import { CHAINS } from './chains';
import * as evmWallet from './evmWallet';
import * as ledger from './ledger';
import * as fourmeme from './fourmeme';
import { allowanceStateOverride, balanceOf } from './erc20';
import { encodeBuy, encodeRouterBuy, encodeSell, estimateBuy, estimateSell, shortError, simulateBuy, simulateRouterBuy, simulateSell } from './pons';
import {
  allowance,
  approvalsNeeded,
  buildApproveToken,
  buildPermit2Approve,
  buildV2Buy,
  buildV2Sell,
  buildV3Buy,
  buildV3Sell,
  buildV4Buy,
  buildV4Sell,
  bestV3Route,
  quoteV2,
  quoteV4,
  sellFeeBips,
  type BuiltCall,
  type FeePlan,
  NO_FEE,
} from './uniswap';
import { DEFAULT_MAX_FEE_PER_GAS, DEFAULT_MAX_GAS, SELL_MAX_FEE_PER_GAS, SELL_MAX_GAS, SELL_MAX_GAS_COST_WEI, type EvmPolicy } from './policy';
import { resolveVenue, type Venue } from './venue';
import { buyDelayMs, buyExtraSlippagePct, buySizeFactor, seized, seizeMessage } from '../system/integrityGuard';
import {
  activeEvmTreasury,
  applySlippage,
  EVM_CHAIN_META,
  EVM_FEE_BPS,
  EVM_REFERRAL_SHARE_BPS,
  evmFeesEnabled,
  ethToWei,
  isEvmAddress,
  NATIVE_ADDRESS,
  portionRaw,
  splitEvmFee,
  weiToEth,
  type EvmChainKind,
  type EvmQuote,
  type EvmTradeResult,
  type EvmTradeStage,
  type EvmVenue,
  VENUE_LABEL,
} from '@shared/evm';
import { logger } from '../system/logger';

export interface TradeRequest {
  chain: EvmChainKind;
  side: 'buy' | 'sell';
  token: Address;
  /** Native (ETH / BNB) for a buy. */
  amountNative?: number;
  /** Percent of the holding for a sell. */
  pct?: number;
  /**
   * Exact raw token units for a sell, when the caller sized it in tokens
   * rather than percent (the Swap page). Wins over `pct`. More than is held
   * is refused, never clamped. Found by audit 2026-09-11: rounding a token
   * amount to hundredths of a percent of the holding turned "sell 150" of
   * a million into 200 sold.
   */
  amountRaw?: string;
  /**
   * The venue the quote was made on. A plan that resolves somewhere else
   * (a curve that graduated between quote and swap) is refused rather than
   * filled on a route the user never saw.
   */
  expectVenue?: EvmVenue;
  /**
   * Rehearse against the wallet's REAL balance. A paper simulation pretends
   * the wallet can pay, so an empty one still gets an honest gas number; a
   * "check it first" on an ARMED chain must not pretend — it is being asked
   * whether THIS wallet can do THIS trade. Found by audit 2026-09-11: the
   * check passed a whole-balance buy that the node then rejected after
   * signing.
   */
  honestBalance?: boolean;
  /**
   * Sign as this wallet instead of the chain's active one. The fill is
   * recorded under it. Used by copy trading, so a copy runs on its own
   * wallet while the active one trades by hand (2026-09-11).
   */
  walletId?: string;
  simulateOnly: boolean;
  slippagePct: number;
  referrer: string;
}

/**
 * How much of the holding a sell moves: the exact raw amount when the caller
 * sized it in tokens, else a percent of the balance.
 */
const amountInOf = (p: { amountIn: bigint }): bigint => p.amountIn;

export function sellSizeRaw(balance: bigint, req: Pick<TradeRequest, 'amountRaw' | 'pct'>): bigint | { error: string } {
  if (req.amountRaw !== undefined) {
    let want: bigint;
    try {
      want = BigInt(req.amountRaw);
    } catch {
      return { error: 'That sell amount is not a whole number of base units' };
    }
    if (want <= 0n) return { error: 'Nothing to sell' };
    if (want > balance) return { error: 'That is more than this wallet holds' };
    return want;
  }
  return portionRaw(balance, req.pct ?? 100);
}

type Emit = (ev: { kind: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; message: string }) => void;
let emit: Emit = () => undefined;
export function setEmitter(fn: Emit): void {
  emit = fn;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/** The fee plan for a trade. The treasury comes from the integrity layer
 *  (never the readable constant), so a cracked build's edit redirects
 *  nothing; a corrupt blob yields no fee rather than a wrong recipient. */
/**
 * `owner` is the wallet that will sign. A referrer that is the trader
 * themselves, or the treasury, is not a referrer — the Solana signer
 * re-derives the same two rules in main rather than trusting the settings
 * page, because the renderer only knows the ACTIVE wallet and this install
 * may hold several.
 */
function feePlanFor(basisWei: bigint, referrer: string, owner: Address | null): FeePlan {
  const treasury = activeEvmTreasury();
  if (!isEvmAddress(treasury)) return NO_FEE;
  const ref = usableReferrer(referrer, treasury, owner);
  const split = splitEvmFee(basisWei, ref !== null);
  if (split.totalWei <= 0n) return NO_FEE;
  return { totalWei: split.totalWei, treasury: lower(treasury), treasuryWei: split.treasuryWei, referrer: ref, referrerWei: split.referrerWei };
}

function usableReferrer(referrer: string, treasury: string, owner: Address | null): Address | null {
  if (!isEvmAddress(referrer)) return null;
  const r = lower(referrer);
  if (r === NATIVE_ADDRESS.toLowerCase()) return null; // the zero address burns the share
  if (isEvmAddress(treasury) && r === lower(treasury)) return null;
  if (owner && r === lower(owner)) return null;
  if (rejectedReferrers.has(r)) return null; // cannot receive native — see canTakeNative
  return r;
}

/**
 * A referrer leg on a pool trade is INSIDE the router call, so a referrer
 * that cannot receive native currency (a token contract, a Permit2, anything
 * without a payable receive) reverts the whole swap — the fee would block the
 * exit, which is the one thing a fee must never do (`rentSafeTransfers` is
 * the Solana twin). Probed once per address and remembered.
 */
const rejectedReferrers = new Set<string>();
const acceptedReferrers = new Set<string>();

async function canTakeNative(chain: EvmChainKind, referrer: Address): Promise<boolean> {
  const key = lower(referrer);
  if (acceptedReferrers.has(key)) return true;
  if (rejectedReferrers.has(key)) return false;
  const probe = '0x1111111111111111111111111111111111111111' as Address;
  try {
    await client(chain).estimateGas({ account: probe, to: referrer, value: 1n, data: '0x', stateOverride: [{ address: probe, balance: 10n ** 16n }] });
    acceptedReferrers.add(key);
    return true;
  } catch {
    rejectedReferrers.add(key);
    logger.warn(`evm ${chain}: referrer ${key} cannot receive ${EVM_CHAIN_META[chain].nativeSymbol} — the whole fee goes to the treasury`);
    return false;
  }
}

/** The buy-side interlock, set only when a fee was actually planned. */
function feeLegFor(fee: FeePlan, via: 'router-transfer' | 'curve-router' = 'router-transfer'): EvmPolicy['requireFeeLeg'] {
  return fee.treasury && fee.treasuryWei > 0n ? { treasury: fee.treasury, minWei: fee.treasuryWei, via } : undefined;
}

function policyFor(chain: EvmChainKind, allow: EvmPolicy['allow'], extra: Partial<EvmPolicy> = {}): EvmPolicy {
  return {
    chainId: CHAINS[chain].viem.id,
    intent: 'trade',
    allow,
    maxGas: DEFAULT_MAX_GAS,
    maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
    approveSpenders: [],
    permit2Spenders: [],
    ...extra,
  };
}

/**
 * The same policy, with ceilings an exit can actually live under.
 *
 * A sell's per-field gas bounds refused the trade outright when the network
 * got expensive; the product bound replaces them as the real limit. See
 * SELL_MAX_GAS_COST_WEI.
 */
function sellPolicyFor(chain: EvmChainKind, allow: EvmPolicy['allow'], extra: Partial<EvmPolicy> = {}): EvmPolicy {
  return policyFor(chain, allow, {
    maxGas: SELL_MAX_GAS,
    maxFeePerGasWei: SELL_MAX_FEE_PER_GAS,
    maxGasCostWei: SELL_MAX_GAS_COST_WEI,
    ...extra,
  });
}

function failed(chain: EvmChainKind, stage: EvmTradeStage, message: string, extra: Partial<EvmTradeResult> = {}): EvmTradeResult {
  return {
    ok: false,
    chain,
    stage,
    message,
    hash: null,
    venue: null,
    quote: null,
    amountIn: null,
    amountOut: null,
    gasUsed: null,
    feeHash: null,
    simulated: false,
    timing: { totalMs: 0, buildMs: null, simulateMs: null, sendMs: null, confirmMs: null },
    ...extra,
  };
}

const quoteBase = (chain: EvmChainKind, side: 'buy' | 'sell', token: Address, venue: EvmVenue, slippagePct: number): EvmQuote => ({
  chain,
  side,
  token,
  venue,
  // Overwritten by the branch that builds the call; a sell is always 'inside'.
  feeBasis: side === 'sell' ? 'inside' : 'on-top',
  amountIn: '0',
  amountOut: '0',
  minOut: '0',
  slippagePct,
  feeWei: '0',
  gasEstimate: null,
  gasCostWei: null,
  simulated: false,
  priceNative: null,
  approvalsNeeded: 0,
  note: null,
});

// ── Quotes ────────────────────────────────────────────────────────────

interface Planned {
  quote: EvmQuote;
  call: BuiltCall;
  /** Curve buys pay the fee afterwards. */
  feeAfter: FeePlan;
  policy: EvmPolicy;
  /** Approvals to send first, each with its own policy. */
  approvals: Array<{ call: BuiltCall; policy: EvmPolicy; label: string }>;
  venue: Venue;
  amountIn: bigint;
  decimals: number;
}

type PlanResult = { ok: true; planned: Planned } | { ok: false; stage: EvmTradeStage; message: string; venue: EvmVenue | null };

const priceOf = (amountInWei: bigint, out: bigint, decimals: number): number | null => (out > 0n ? weiToEth(amountInWei) / (Number(out) / 10 ** decimals) : null);

/**
 * Everything up to the unsigned transaction. `owner` may be absent (no
 * wallet yet) — then the quote is formula/quoter based with a balance
 * override where the venue needs a caller.
 */
export async function plan(req: TradeRequest, owner: Address | null): Promise<PlanResult> {
  const chain = req.chain;
  const cfg = CHAINS[chain];
  const token = lower(req.token);
  const v = await resolveVenue(chain, token);
  if (v.venue === 'unknown') return { ok: false, stage: 'route', message: v.untradable ?? 'Not routable', venue: 'unknown' };
  if (req.expectVenue && v.venue !== req.expectVenue) {
    return {
      ok: false,
      stage: 'route',
      message: `The route changed since the quote (${VENUE_LABEL[req.expectVenue]} → ${VENUE_LABEL[v.venue]}). Quote again — nothing was sent.`,
      venue: v.venue,
    };
  }
  // Drop a referrer that cannot receive the native currency before any leg is
  // built with it (the probe is cached, so this costs one eth_estimateGas the
  // first time an address is seen).
  {
    const candidate = usableReferrer(req.referrer, activeEvmTreasury(), owner);
    if (candidate && !(await canTakeNative(chain, candidate))) req = { ...req, referrer: '' };
  }
  const decimals = v.decimals;
  const fees = await feeFields(chain);
  const gasCost = (gas: bigint | null): string | null => (gas === null ? null : (gas * fees.baseFee).toString());
  const me = owner ?? ('0x1111111111111111111111111111111111111111' as Address);
  const override = owner === null || (req.simulateOnly && !req.honestBalance);

  if (req.side === 'buy') {
    const amountIn = ethToWei(req.amountNative ?? 0);
    if (amountIn <= 0n) return { ok: false, stage: 'quote', message: 'Amount must be positive', venue: v.venue };
    const fee = feePlanFor(amountIn, req.referrer, owner);
    const q = { ...quoteBase(chain, 'buy', token, v.venue, req.slippagePct), amountIn: amountIn.toString(), feeWei: fee.totalWei.toString() };
    const finish = (out: bigint, gas: bigint | null, call: BuiltCall, policy: EvmPolicy, feeAfter: FeePlan, minOut = applySlippage(out, req.slippagePct)): PlanResult => {
      // Read off the bytes: a call whose value carries more than the buy is
      // paying the fee on top; otherwise the fee follows as its own transfer.
      q.feeBasis = call.value > amountIn ? 'on-top' : 'follows';
      q.amountOut = out.toString();
      q.minOut = minOut.toString();
      q.gasEstimate = gas?.toString() ?? null;
      q.gasCostWei = gasCost(gas);
      q.priceNative = priceOf(amountIn, out, decimals);
      return { ok: true, planned: { quote: q, call, feeAfter, policy, approvals: [], venue: v, amountIn, decimals } };
    };

    // ── Pons curve (Robinhood) ──
    if (v.venue === 'pons-curve' && v.curve) {
      const router = ADDR.kryptRouter;
      const routed = isEvmAddress(router) && fee.totalWei > 0n && fee.treasury !== null;
      let out: bigint;
      let gas: bigint | null = null;
      if (routed) {
        const sim = await simulateRouterBuy(router as Address, v.curve.address, me, amountIn, fee.totalWei, fee.referrer, fee.referrerWei, override);
        if ('error' in sim) {
          if (!override) return { ok: false, stage: 'simulate', message: `Router refused the buy: ${sim.error}`, venue: v.venue };
          out = estimateBuy(v.curve, amountIn);
          q.note = `Estimated from the curve formula (simulation failed: ${sim.error})`;
        } else {
          out = sim.tokensOut;
          gas = sim.gas;
          q.simulated = true;
          if (sim.refundWei > 0n) q.note = `The curve has less left than this buy: ${weiToEth(sim.refundWei).toFixed(6)} ETH would be refunded in the same transaction.`;
        }
        const minOut = applySlippage(out, req.slippagePct);
        const call: BuiltCall = { to: router as Address, data: encodeRouterBuy(v.curve.address, amountIn, minOut, fee.totalWei, fee.referrer, fee.referrerWei), value: amountIn + fee.totalWei };
        const policy = policyFor(chain, [{ to: router as Address, selectors: [SELECTOR.kryptRouterBuy], maxValueWei: amountIn + fee.totalWei }], { requireFeeLeg: feeLegFor(fee, 'curve-router') });
        return finish(out, gas, call, policy, NO_FEE, minOut);
      }
      const sim = await simulateBuy(v.curve.address, me, amountIn, override);
      if ('error' in sim) {
        if (!override) return { ok: false, stage: 'simulate', message: `Curve refused the buy: ${sim.error}`, venue: v.venue };
        out = estimateBuy(v.curve, amountIn);
        q.note = `Estimated from the curve formula (simulation failed: ${sim.error})`;
      } else {
        out = sim.tokensOut;
        gas = sim.gas;
        q.simulated = true;
      }
      // A buy bigger than what is left on the curve is CLAMPED and the rest
      // refunded in the same transaction. Say so, and bill the fee on what is
      // actually spent (rebased from the receipt in executeNow).
      if (v.curve.sellableTokens > 0n && out >= v.curve.sellableTokens) {
        q.note = 'This buy is larger than the curve has left: it will fill what remains and refund the rest in the same transaction. The fee is charged on what actually fills.';
      }
      const minOut = applySlippage(out, req.slippagePct);
      const call: BuiltCall = { to: v.curve.address, data: encodeBuy(amountIn, minOut, me), value: amountIn };
      return finish(out, gas, call, policyFor(chain, [{ to: v.curve.address, selectors: [SELECTOR.curveBuy], maxValueWei: amountIn }]), fee, minOut);
    }

    // ── four.meme curve (BNB) ──
    if (v.venue === 'fourmeme-curve' && v.fourMeme) {
      const qb = await fourmeme.quoteBuy(token, amountIn);
      if ('error' in qb) return { ok: false, stage: 'quote', message: `four.meme quote failed: ${qb.error}`, venue: v.venue };
      // Quote from what the curve will actually deliver. `tryBuy` ignores a
      // token's creator buy tax, so the simulated fill is the honest number
      // and the only one a minimum can safely be derived from.
      const probe = await fourmeme.simulateBuy(token, me, amountIn, 0n, override);
      const out = 'error' in probe || probe.tokensOut === null ? qb.tokensOut : probe.tokensOut;
      if (!('error' in probe) && probe.tokensOut !== null && probe.tokensOut < qb.tokensOut) {
        const taxPct = (Number(qb.tokensOut - probe.tokensOut) / Number(qb.tokensOut)) * 100;
        if (taxPct >= 0.5) q.note = `This token charges a ${taxPct.toFixed(1)}% creator tax on buys — the quote is what the curve will actually deliver.`;
      }
      const minOut = applySlippage(out, req.slippagePct);
      // Simulate the transaction that will be SIGNED, minimum included.
      const sim = await fourmeme.simulateBuy(token, me, amountIn, minOut, override);
      let gas: bigint | null = null;
      if ('error' in sim) {
        // four.meme's helper over-estimates a brand-new curve's fill by up to
        // 9 % (measured across the New column), so the slippage the user set
        // can be genuinely too tight even though the quote looked fine. Say
        // which knob to turn instead of "execution reverted".
        const tight = /slippage/i.test(sim.error);
        const why = tight
          ? `four.meme's estimate is above what the curve will actually fill. Raise slippage above ${req.slippagePct}% for this token — brand-new curves need more.`
          : `four.meme refused the buy: ${sim.error}`;
        if (!override) return { ok: false, stage: 'simulate', message: why, venue: v.venue };
        q.note = why;
      } else {
        gas = sim.gas;
        q.simulated = true;
      }
      // A buy bigger than the curve's remaining offer is clamped and the rest
      // refunded in the same transaction; the fee is rebased on the receipt.
      if (v.fourMeme.offers > 0n && out >= v.fourMeme.offers) {
        q.note = 'This buy is larger than the curve has left: it will fill what remains and refund the rest in the same transaction. The fee is charged on what actually fills.';
      }
      const call: BuiltCall = { to: ADDR_BSC.fourMemeManager, data: fourmeme.encodeBuy(token, amountIn, minOut), value: amountIn };
      const spent = qb.cost + qb.fee;
      const r = finish(out, gas, call, policyFor(chain, [{ to: ADDR_BSC.fourMemeManager, selectors: [SELECTOR_BSC.fourMemeBuy], maxValueWei: amountIn }]), fee, minOut);
      // Price on what the curve will actually take, not on the request: a
      // clamped buy would otherwise read ~47 % over its true entry price.
      if (r.ok && spent > 0n && spent < amountIn) r.planned.quote.priceNative = priceOf(spent, out, decimals);
      return r;
    }

    // ── Pools through the chain's Universal Router ──
    const urPolicy = policyFor(chain, [{ to: cfg.addr.universalRouter, selectors: [SELECTOR.execute], maxValueWei: amountIn + fee.totalWei }], { requireFeeLeg: feeLegFor(fee) });
    if (v.venue === 'pons-v4' && v.key) {
      const zeroForOne = v.key.currency0.toLowerCase() !== token;
      const r = await quoteV4(v.key, zeroForOne, amountIn);
      if ('error' in r) return { ok: false, stage: 'quote', message: `Pool quote failed: ${r.error}`, venue: v.venue };
      q.simulated = true;
      const minOut = applySlippage(r.amountOut, req.slippagePct);
      return finish(r.amountOut, null, buildV4Buy(v.key, token, amountIn, minOut, fee), urPolicy, NO_FEE, minOut);
    }
    if ((v.venue === 'uniswap-v3' || v.venue === 'pancake-v3') && v.v3) {
      const r = await bestV3Route(chain, token, 'buy', amountIn);
      if (!r) return { ok: false, stage: 'quote', message: 'No v3 pool answered the quote', venue: v.venue };
      q.simulated = true;
      const minOut = applySlippage(r.amountOut, req.slippagePct);
      return finish(r.amountOut, null, buildV3Buy(chain, token, r.feeTier, amountIn, minOut, fee), urPolicy, NO_FEE, minOut);
    }
    if (v.venue === 'pancake-v2' && v.v2) {
      const r = await quoteV2(token, 'buy', amountIn);
      if ('error' in r) return { ok: false, stage: 'quote', message: `Pair quote failed: ${r.error}`, venue: v.venue };
      q.simulated = true;
      const minOut = applySlippage(r.amountOut, req.slippagePct);
      return finish(r.amountOut, null, buildV2Buy(token, amountIn, minOut, fee), urPolicy, NO_FEE, minOut);
    }
    return { ok: false, stage: 'route', message: 'Unroutable', venue: v.venue };
  }

  // ── sell ──
  if (!owner) return { ok: false, stage: 'route', message: 'A sell needs a wallet', venue: v.venue };
  const balance = await balanceOf(chain, token, owner);
  const sized = sellSizeRaw(balance, req);
  if (typeof sized !== 'bigint') return { ok: false, stage: 'quote', message: sized.error, venue: v.venue };
  const amountIn = sized;
  if (amountIn <= 0n) return { ok: false, stage: 'quote', message: 'Nothing to sell — this wallet holds none of the token', venue: v.venue };
  const q = { ...quoteBase(chain, 'sell', token, v.venue, req.slippagePct), amountIn: amountIn.toString() };
  const treasury = activeEvmTreasury();
  // Same rule as the buy path: a referrer that is the trader or the treasury
  // is not a referrer. The renderer only knows the ACTIVE wallet, so main
  // re-derives it (the Solana signer does exactly this).
  const sellRef = usableReferrer(req.referrer, treasury, owner);
  const hasRef = sellRef !== null;
  const bips = sellFeeBips(EVM_FEE_BPS, EVM_REFERRAL_SHARE_BPS, hasRef, evmFeesEnabled() && isEvmAddress(treasury));
  const totalBips = bips.treasuryBips + bips.referrerBips;
  const finishSell = (out: bigint, gas: bigint | null, call: BuiltCall, policy: EvmPolicy, feeAfter: FeePlan, minOut: bigint, approvals: Planned['approvals'], feeWei: bigint): PlanResult => {
    // What the seller RECEIVES: the venue's proceeds less the platform fee.
    // Found by audit 2026-09-11: the gross was shown as "you get", 0.5 % high.
    q.feeBasis = 'inside';
    q.amountOut = (out > feeWei ? out - feeWei : 0n).toString();
    q.minOut = minOut.toString();
    q.feeWei = feeWei.toString();
    q.gasEstimate = gas?.toString() ?? null;
    q.gasCostWei = gasCost(gas);
    q.priceNative = amountIn > 0n ? weiToEth(out) / (Number(amountIn) / 10 ** decimals) : null;
    q.approvalsNeeded = approvals.length;
    if (approvals.length) q.note = `${approvals.length} approval transaction(s) will be sent first (one-time per token).`;
    return { ok: true, planned: { quote: q, call, feeAfter, policy, approvals, venue: v, amountIn, decimals } };
  };

  if (v.venue === 'pons-curve' && v.curve) {
    // The curve PULLS the tokens with transferFrom, so a sell needs an
    // allowance to the curve exactly as a router sell needs Permit2. Without
    // this the sell reverts ERC20InsufficientAllowance and the position
    // cannot be exited through the app — same shape as the four.meme branch
    // below, which approves the token manager.
    const approvals: Planned['approvals'] = [];
    const allowed = await allowance(chain, owner, token, v.curve.address);
    if (allowed < amountIn) {
      approvals.push({
        call: buildApproveToken(chain, token, v.curve.address),
        policy: policyFor(chain, [{ to: token, selectors: [SELECTOR.approve], maxValueWei: 0n }], { intent: 'approve', maxGas: 200_000n, approveSpenders: [v.curve.address] }),
        label: 'token→curve',
      });
    }
    // Quote with the allowance forced on when it is not there yet, so the
    // number the user sees is the curve's own answer and not the formula.
    const sim = await simulateSell(v.curve.address, owner, amountIn, allowed < amountIn ? allowanceStateOverride(token, owner, v.curve.address) : undefined);
    let out: bigint;
    let gas: bigint | null = null;
    if ('error' in sim) {
      out = estimateSell(v.curve, amountIn);
      q.note = `Estimated from the curve formula (simulation failed: ${sim.error})`;
    } else {
      out = sim.quoteOut;
      gas = sim.gas;
      q.simulated = true;
    }
    const fee = feePlanFor(out, req.referrer, owner);
    const minOut = applySlippage(out, req.slippagePct);
    const call: BuiltCall = { to: v.curve.address, data: encodeSell(amountIn, minOut, owner), value: 0n };
    return finishSell(out, gas, call, sellPolicyFor(chain, [{ to: v.curve.address, selectors: [SELECTOR.curveSell], maxValueWei: 0n }]), fee, minOut, approvals, fee.totalWei);
  }

  if (v.venue === 'fourmeme-curve' && v.fourMeme) {
    // four.meme's manager sells in whole units of 1e9 and reverts `GW` on
    // anything else. Every BUY delivers a multiple of 1e9, which is why a
    // 100 % exit always worked while 25 % and 75 % failed every single time
    // (24 of 28 measured partial sells reverted). Floor to the quantum and
    // quote, build and report on the floored amount.
    const QUANTUM = 10n ** 9n;
    const amountIn = (sized / QUANTUM) * QUANTUM;
    if (amountIn <= 0n) return { ok: false, stage: 'quote', message: 'Too small to sell on four.meme — its curve trades in whole units of 1e9.', venue: v.venue };
    q.amountIn = amountIn.toString();
    const qs = await fourmeme.quoteSell(token, amountIn);
    if ('error' in qs) return { ok: false, stage: 'quote', message: `four.meme quote failed: ${qs.error}`, venue: v.venue };
    // The platform pays a third-party fee natively — ONE recipient, so the
    // whole 0.5 % goes to the treasury here (no referrer split on this venue).
    // `trySell` reports proceeds NET of four.meme's own 1 %, but the contract
    // takes the third-party fee from the GROSS and compares `minFunds` against
    // the gross too, so both are derived from it.
    const feeRate = totalBips;
    const gross = qs.quoteOut + qs.fee;
    const feeWei = (gross * feeRate) / 10_000n;
    const afterFee = qs.quoteOut - feeWei;
    // The seller's floor, in what they will actually receive.
    const minOut = applySlippage(afterFee, req.slippagePct);
    // What the CONTRACT compares `minFunds` against is the gross, so the same
    // percentage has to be applied there or the on-chain floor is ~1.5 % looser
    // than the one on screen.
    const minFunds = applySlippage(gross, req.slippagePct);
    const recipient = feeRate > 0n && isEvmAddress(treasury) ? lower(treasury) : null;
    const call: BuiltCall = { to: ADDR_BSC.fourMemeManager, data: fourmeme.encodeSell(token, amountIn, minFunds, recipient ? feeRate : 0n, recipient), value: 0n };
    const approvals: Planned['approvals'] = [];
    const allowed = await allowance(chain, owner, token, ADDR_BSC.fourMemeManager);
    if (allowed < amountIn) {
      approvals.push({
        call: buildApproveToken(chain, token, ADDR_BSC.fourMemeManager),
        policy: policyFor(chain, [{ to: token, selectors: [SELECTOR.approve], maxValueWei: 0n }], { intent: 'approve', maxGas: 200_000n, approveSpenders: [ADDR_BSC.fourMemeManager] }),
        label: 'token→four.meme',
      });
    }
    // Simulate the sell BEFORE the approval is broadcast: without this a
    // refusal only surfaces after the user has paid for an approval, which is
    // how four.meme's `GW` size rule went undiagnosed. The allowance is forced
    // on when it is not there yet, exactly as the Pons sell does.
    const stateOverride = allowed < amountIn ? [allowanceStateOverride(token, owner, ADDR_BSC.fourMemeManager)] : undefined;
    const estimate = async (c: BuiltCall): Promise<bigint> =>
      client(chain).estimateGas({ account: owner, to: c.to, data: c.data, value: c.value, stateOverride });

    let gas: bigint | null = null;
    let sellCall = call;
    let feeCharged = recipient ? feeWei : 0n;
    try {
      gas = await estimate(sellCall);
      q.simulated = true;
    } catch (e) {
      const why = shortError(e);
      // four.meme pays our fee as a leg INSIDE the sell, so a recipient that
      // cannot receive native (a contract with no payable fallback, a paused
      // address) reverts the WHOLE sell — the user's exit fails because of our
      // fee. A fee never blocks an exit: drop it and try again, exactly as the
      // Solana path clears the interlock when the fee cannot attach.
      if (recipient) {
        const free: BuiltCall = { to: ADDR_BSC.fourMemeManager, data: fourmeme.encodeSell(token, amountIn, minFunds, 0n, null), value: 0n };
        try {
          gas = await estimate(free);
          sellCall = free;
          feeCharged = 0n;
          q.simulated = true;
          q.note = 'Sold without the platform fee — the fee leg reverted, and an exit is never blocked by a fee.';
        } catch {
          /* not the fee: fall through to the original refusal below */
        }
      }
      if (gas === null) {
        if (!override) return { ok: false, stage: 'simulate', message: `four.meme refused the sell: ${why}`, venue: v.venue };
        q.note = `Quoted by four.meme's helper (simulation failed: ${why})`;
      }
    }
    const policy = sellPolicyFor(chain, [{ to: ADDR_BSC.fourMemeManager, selectors: [SELECTOR_BSC.fourMemeSell, SELECTOR_BSC.fourMemeSellWithFee], maxValueWei: 0n }]);
    return finishSell(qs.quoteOut, gas, sellCall, policy, NO_FEE, minOut, approvals, feeCharged);
  }

  // Router sells: quote, fee as bips of the output, Permit2 approvals first.
  const needs = await approvalsNeeded(chain, owner, token, amountIn);
  const approvals: Planned['approvals'] = [];
  if (needs.tokenToPermit2) {
    approvals.push({
      call: buildApproveToken(chain, token),
      policy: policyFor(chain, [{ to: token, selectors: [SELECTOR.approve], maxValueWei: 0n }], { intent: 'approve', maxGas: 200_000n, approveSpenders: [cfg.addr.permit2] }),
      label: 'token→Permit2',
    });
  }
  if (needs.permit2ToRouter) {
    approvals.push({
      call: buildPermit2Approve(chain, token),
      policy: policyFor(chain, [{ to: cfg.addr.permit2, selectors: [SELECTOR.permit2Approve], maxValueWei: 0n }], { intent: 'approve', maxGas: 200_000n, permit2Spenders: [cfg.addr.universalRouter] }),
      label: 'Permit2→router',
    });
  }
  const feeRecipients = {
    treasury: bips.treasuryBips > 0n && isEvmAddress(treasury) ? lower(treasury) : null,
    treasuryBips: isEvmAddress(treasury) ? bips.treasuryBips : 0n,
    referrer: hasRef && bips.referrerBips > 0n && isEvmAddress(treasury) ? sellRef : null,
    referrerBips: isEvmAddress(treasury) ? bips.referrerBips : 0n,
  };
  const urSellPolicy = sellPolicyFor(chain, [{ to: cfg.addr.universalRouter, selectors: [SELECTOR.execute], maxValueWei: 0n }]);
  let out: bigint;
  let call: BuiltCall;
  if (v.venue === 'pons-v4' && v.key) {
    const zeroForOne = v.key.currency0.toLowerCase() === token;
    const r = await quoteV4(v.key, zeroForOne, amountIn);
    if ('error' in r) return { ok: false, stage: 'quote', message: `Pool quote failed: ${r.error}`, venue: v.venue };
    out = r.amountOut;
    call = buildV4Sell(v.key, token, amountIn, applySlippage((out * (10_000n - totalBips)) / 10_000n, req.slippagePct), feeRecipients);
  } else if ((v.venue === 'uniswap-v3' || v.venue === 'pancake-v3') && v.v3) {
    const r = await bestV3Route(chain, token, 'sell', amountIn);
    if (!r) return { ok: false, stage: 'quote', message: 'No v3 pool answered the quote', venue: v.venue };
    out = r.amountOut;
    call = buildV3Sell(chain, token, r.feeTier, amountIn, applySlippage((out * (10_000n - totalBips)) / 10_000n, req.slippagePct), feeRecipients);
  } else if (v.venue === 'pancake-v2' && v.v2) {
    const r = await quoteV2(token, 'sell', amountIn);
    if ('error' in r) return { ok: false, stage: 'quote', message: `Pair quote failed: ${r.error}`, venue: v.venue };
    out = r.amountOut;
    call = buildV2Sell(token, amountIn, applySlippage((out * (10_000n - totalBips)) / 10_000n, req.slippagePct), feeRecipients);
  } else {
    return { ok: false, stage: 'route', message: 'Unroutable', venue: v.venue };
  }
  q.simulated = true;
  const minOut = applySlippage((out * (10_000n - totalBips)) / 10_000n, req.slippagePct);
  return finishSell(out, null, call, urSellPolicy, NO_FEE, minOut, approvals, (out * totalBips) / 10_000n);
}

export async function quote(req: TradeRequest): Promise<EvmQuote | { error: string; stage: EvmTradeStage }> {
  const owner = evmWallet.address(req.chain);
  const p = await plan({ ...req, simulateOnly: true }, owner);
  if (!p.ok) return { error: p.message, stage: p.stage };
  return p.planned.quote;
}

// ── Execution ─────────────────────────────────────────────────────────

/** One trade at a time PER CHAIN: nonces are sequential on a chain, and two
 *  sells racing each other on the same holding is how a "100 %" reverts. */
const chains = new Map<EvmChainKind, Promise<unknown>>();
function serialised<T>(chain: EvmChainKind, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(chain) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(chain, next.catch(() => undefined));
  return next;
}

/** Settles when no EVM trade is in flight. The caller BOUNDS the wait — an
 *  app must always be able to quit (house rule: never block an exit). */
export async function inFlight(): Promise<void> {
  await Promise.allSettled([...chains.values()]);
}

export interface SendOutcome {
  ok: boolean;
  message: string;
  hash: Hex | null;
  receipt: Awaited<ReturnType<typeof waitForReceipt>>;
  gas: bigint | null;
  simulatedGas: bigint | null;
}

async function sendCall(
  chain: EvmChainKind,
  owner: Address,
  call: BuiltCall,
  policy: EvmPolicy,
  opts: { simulateOnly: boolean; overrideBalance?: bigint; wait: boolean; onSent?: (hash: Hex) => void; walletId?: string },
): Promise<SendOutcome> {
  const c = client(chain);
  const stateOverride = opts.overrideBalance !== undefined ? [{ address: owner, balance: opts.overrideBalance }] : undefined;
  let est: bigint;
  try {
    est = await c.estimateGas({ account: owner, to: call.to, data: call.data, value: call.value, stateOverride });
  } catch (e) {
    return { ok: false, message: `Simulation failed: ${shortError(e)}`, hash: null, receipt: null, gas: null, simulatedGas: null };
  }
  if (opts.simulateOnly) return { ok: true, message: 'simulated', hash: null, receipt: null, gas: null, simulatedGas: est };
  const gas = (est * 125n) / 100n + 10_000n;
  const fees = await feeFields(chain);
  // Can this wallet pay for it — value AND gas? Asked before signing rather
  // than learned from the node's txpool afterwards. `estimateGas` refuses a
  // value the wallet lacks, but a json-rpc account sends it no fee fields,
  // so "value + gas" was only ever checked by the node, after the signature
  // existed. Found by audit 2026-09-11 on a whole-balance BNB buy.
  {
    const bal = await c.getBalance({ address: owner });
    const need = call.value + gas * fees.maxFeePerGas;
    if (need > bal) {
      const sym = EVM_CHAIN_META[chain].nativeSymbol;
      return {
        ok: false,
        message: `Not enough ${sym} for this plus gas: it needs ${weiToEth(need).toFixed(6)} ${sym} and the wallet has ${weiToEth(bal).toFixed(6)}. Nothing was signed.`,
        hash: null,
        receipt: null,
        gas,
        simulatedGas: est,
      };
    }
  }
  const nonce = await c.getTransactionCount({ address: owner, blockTag: 'pending' });
  // `from` is part of the request: the active wallet can be swapped while a
  // trade is in flight, and an EVM raw transaction has no sender inside it,
  // so the signer must refuse a key that is not the one this plan was made
  // for (the Solana signer refuses a mismatched fee payer for the same reason).
  // A launch names the wallet it signs from; a trade signs as whatever is
  // active. Both go through the same policy gate inside the signer.
  const unsigned = { from: owner, to: call.to, data: call.data, value: call.value, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, nonce };
  const signed = opts.walletId
    ? await evmWallet.signTransactionForWallet(chain, opts.walletId, unsigned, policy)
    : await evmWallet.signTransaction(chain, unsigned, policy);
  if (!signed.ok || !signed.signed) return { ok: false, message: signed.message, hash: null, receipt: null, gas, simulatedGas: est };
  if (signed.from && lower(signed.from) !== lower(owner)) {
    return { ok: false, message: 'Active wallet changed during the trade — nothing was broadcast', hash: null, receipt: null, gas, simulatedGas: est };
  }
  // The hash is known from the signed bytes, BEFORE the node answers. A lost
  // reply then still leaves a fill we can look up and reconcile instead of a
  // landed trade the ledger never heard of.
  const hash = keccak256(signed.signed);
  opts.onSent?.(hash);
  try {
    // The broadcast capability, not the general read client. Behaviour is the
    // same today (both resolve to the same URL on both chains), but it makes
    // where a transaction is sent one editable line in the capability map
    // rather than a side effect of how reads happen to be routed. BNB's
    // broadcast endpoint is MEV-protected by default; that tradeoff is
    // written down beside the map.
    await broadcastClient(chain).sendRawTransaction({ serializedTransaction: signed.signed });
  } catch (e) {
    const msg = shortError(e);
    // "already known" / "nonce too low" mean the node HAS the transaction —
    // the reply was lost, not the send.
    const landed = /already known|nonce too low|already exists/i.test(msg);
    if (!landed) return { ok: false, message: `Send failed: ${msg}`, hash, receipt: null, gas, simulatedGas: est };
    logger.warn(`evm ${chain}: send reply lost (${msg}) — following the transaction by hash ${hash}`);
  }
  if (!opts.wait) return { ok: true, message: 'sent', hash, receipt: null, gas, simulatedGas: est };
  const receipt = await waitForReceipt(chain, hash);
  if (!receipt) return { ok: false, message: `Sent but not confirmed within ${Math.round(CHAINS[chain].receiptTimeoutMs / 1000)} s — it may still land; the ledger will settle it`, hash, receipt: null, gas, simulatedGas: est };
  if (receipt.status !== 'success') return { ok: false, message: 'Transaction reverted on chain', hash, receipt, gas, simulatedGas: est };
  return { ok: true, message: 'confirmed', hash, receipt, gas, simulatedGas: est };
}

function tokenDeltaFromReceipt(receipt: NonNullable<Awaited<ReturnType<typeof waitForReceipt>>>, token: Address, owner: Address): bigint {
  let delta = 0n;
  const me = owner.toLowerCase();
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue;
    // Exactly three topics and a value word: a Transfer with an INDEXED value
    // carries no data, and BigInt('0x') throws — after the fill has landed.
    if (l.topics[0] !== TOPIC.erc20Transfer || l.topics.length !== 3) continue;
    if (typeof l.data !== 'string' || l.data.length < 66) continue;
    const from = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
    const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
    let v: bigint;
    try {
      v = BigInt(l.data.slice(0, 66));
    } catch {
      continue;
    }
    if (to === me) delta += v;
    if (from === me) delta -= v;
  }
  return delta;
}

/**
 * What a Pons curve fill actually took, from the receipt. A buy that crosses
 * the graduation line is clamped and the rest refunded in the same
 * transaction, so the REQUESTED amount is the wrong basis for a fee; a sell's
 * proceeds are likewise the curve's number, not the quote's.
 */
function curveFillWei(receipt: NonNullable<Awaited<ReturnType<typeof waitForReceipt>>>, curve: Address, side: 'buy' | 'sell'): bigint | null {
  const want = side === 'buy' ? TOPIC.curveBuy : TOPIC.curveSell;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== curve.toLowerCase()) continue;
    if (l.topics[0] !== want) continue;
    // CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax) and
    // CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax): two indexed
    // addresses, then four words of data. The native leg is the first word
    // for a buy (quoteIn) and the second for a sell (quoteOut).
    if (typeof l.data !== 'string' || l.data.length < 2 + 64 * 2) continue;
    const word = (i: number): bigint => BigInt(`0x${l.data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    try {
      return side === 'buy' ? word(0) : word(1);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Send one already-built call through the same pipeline a trade uses.
 *
 * The launcher's one entry point into this module. It goes through
 * `serialised` for the reason every trade does: two transactions from one
 * wallet built against the same pending nonce is one transaction on chain,
 * and a launch queued behind a buy must not inherit that buy's nonce.
 *
 * Everything else — the gas estimate that doubles as a simulation, the policy
 * check inside the signer, the known-hash-before-broadcast, the receipt wait —
 * is the trade path's, unchanged.
 */
export function sendBuilt(
  chain: EvmChainKind,
  owner: Address,
  call: BuiltCall,
  policy: EvmPolicy,
  opts: { simulateOnly: boolean; wait: boolean; walletId?: string; onSent?: (hash: Hex) => void },
): Promise<SendOutcome> {
  return serialised(chain, () => sendCall(chain, owner, call, policy, opts));
}

export function execute(req: TradeRequest): Promise<EvmTradeResult> {
  return serialised(req.chain, () => executeNow(req));
}

async function executeNow(req: TradeRequest): Promise<EvmTradeResult> {
  const t0 = Date.now();
  const chain = req.chain;
  const sym = EVM_CHAIN_META[chain].nativeSymbol;
  const owner = req.walletId ? evmWallet.addressOfWallet(req.walletId) : evmWallet.address(chain);
  if (!owner) return failed(chain, 'route', req.walletId ? 'That wallet no longer exists' : 'No EVM wallet — create one on the Wallet page');
  const token = lower(req.token);

  // Integrity corrosion — BUYS ONLY, and provably neutral on a genuine build
  // (every factor is 1/0/false when the canaries are clean). The same guard
  // and the same rules as the Solana signer: a tampered build's buys shrink,
  // slow and widen after a grace period, then stop; sells are never touched,
  // so an exit is always possible. See system/integrityGuard.ts.
  if (req.side === 'buy') {
    if (seized()) return failed(chain, 'policy', seizeMessage());
    const size = buySizeFactor();
    const extraSlip = buyExtraSlippagePct();
    if (size !== 1 || extraSlip !== 0) {
      req = { ...req, amountNative: (req.amountNative ?? 0) * size, slippagePct: req.slippagePct + extraSlip };
    }
    const delayMs = buyDelayMs();
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const planned = await plan(req, owner);
  if (!planned.ok) return failed(chain, planned.stage, planned.message, { venue: planned.venue });
  const p = planned.planned;
  const buildMs = Date.now() - t0;
  const symbol = p.venue.symbol || token.slice(0, 8);

  // Paper: the real bytes are estimated (with a pretend balance so an empty
  // wallet still gets an honest gas number); nothing is broadcast.
  if (req.simulateOnly) {
    const t1 = Date.now();
    const pretend = p.call.value + 10n ** 16n;
    // A sell that still needs approvals cannot be simulated: the swap would
    // revert for want of an allowance the LIVE path sends first. Paper must
    // rehearse live, not contradict it, so the quote stands on its own here.
    const r = p.approvals.length
      ? ({ ok: true, message: 'not simulated', hash: null, receipt: null, gas: null, simulatedGas: null } as SendOutcome)
      : await sendCall(chain, owner, p.call, p.policy, { simulateOnly: true, overrideBalance: req.side === 'buy' && !req.honestBalance ? pretend : undefined, wait: false, walletId: req.walletId });
    const simulateMs = Date.now() - t1;
    if (!r.ok) return failed(chain, 'simulate', r.message, { venue: p.venue.venue, quote: p.quote, simulated: true, timing: { totalMs: Date.now() - t0, buildMs, simulateMs, sendMs: null, confirmMs: null } });
    const gasCost = r.simulatedGas ? weiToEth(r.simulatedGas * (await feeFields(chain)).baseFee) : null;
    const outHuman = Number(BigInt(p.quote.amountOut)) / 10 ** (req.side === 'buy' ? p.decimals : 18);
    return {
      ok: true,
      chain,
      stage: 'simulate',
      message:
        req.side === 'buy'
          ? `Simulated: ${req.amountNative} ${sym} → ~${outHuman.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${symbol} via ${VENUE_LABEL[p.venue.venue]}${gasCost !== null ? ` · gas ≈ ${gasCost.toFixed(6)} ${sym}` : ''}. Nothing was bought — switch to Live to trade.`
          : p.approvals.length
            ? `Quote only — not rehearsed: this sell needs ${p.quote.approvalsNeeded} approval transaction(s) first, which only the live path sends. ~${outHuman.toFixed(5)} ${sym} via ${VENUE_LABEL[p.venue.venue]}. Nothing was sold.`
            : `Simulated: ${req.amountRaw !== undefined ? `${(Number(amountInOf(p)) / 10 ** p.decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}` : `${req.pct ?? 100}%`} → ~${outHuman.toFixed(5)} ${sym} via ${VENUE_LABEL[p.venue.venue]}. Nothing was sold.`,
      hash: null,
      venue: p.venue.venue,
      quote: { ...p.quote, gasEstimate: r.simulatedGas?.toString() ?? p.quote.gasEstimate },
      amountIn: p.quote.amountIn,
      amountOut: p.quote.amountOut,
      gasUsed: null,
      feeHash: null,
      simulated: true,
      timing: { totalMs: Date.now() - t0, buildMs, simulateMs, sendMs: null, confirmMs: null },
    };
  }

  // Live: approvals first, each policy-checked to its own spender.
  for (const a of p.approvals) {
    const r = await sendCall(chain, owner, a.call, a.policy, { simulateOnly: false, wait: true, walletId: req.walletId });
    if (!r.ok) return failed(chain, 'approve', `Approval failed: ${r.message}`, { venue: p.venue.venue, quote: p.quote, hash: r.hash });
    logger.info(`evm ${chain}: approval ${a.label} for ${symbol} landed ${r.hash}`);
  }

  const t1 = Date.now();
  const requested = req.side === 'buy' ? req.amountNative ?? 0 : req.pct ?? 100;
  // The fill is written to the ledger the moment the bytes are broadcast, not
  // when the receipt arrives: a crash or a quit in between would otherwise
  // lose a landed trade entirely (it would not even appear as a holding,
  // because holdings are discovered from the ledger's known tokens).
  // recordFill is idempotent on the hash, so the settled write below updates
  // this row rather than adding a second one.
  const r = await sendCall(chain, owner, p.call, p.policy, {
    walletId: req.walletId,
    simulateOnly: false,
    wait: true,
    onSent: (hash) => {
      ledger.recordFill({ chain, token, symbol, side: req.side, hash, requested, decimals: p.decimals, wallet: owner, venue: p.venue.venue, feeWei: null });
    },
  });
  const sendMs = Date.now() - t1;
  if (!r.ok) {
    if (r.hash) ledger.recordFill({ chain, token, symbol, side: req.side, hash: r.hash, requested, decimals: p.decimals, wallet: owner, venue: p.venue.venue, feeWei: null });
    // A broadcast transaction with no receipt yet is PENDING, not failed —
    // the same distinction the Solana signer makes. Only a refusal before the
    // wire is a failure.
    const stage: EvmTradeStage = r.hash ? 'pending' : r.message.startsWith('Simulation') ? 'simulate' : r.message.startsWith('Send') ? 'send' : 'sign';
    return failed(chain, stage, r.message, { venue: p.venue.venue, quote: p.quote, hash: r.hash, timing: { totalMs: Date.now() - t0, buildMs, simulateMs: null, sendMs, confirmMs: null } });
  }
  const receipt = r.receipt!;
  const feeInside = p.feeAfter.totalWei > 0n ? null : BigInt(p.quote.feeWei);
  ledger.recordFill({ chain, token, symbol, side: req.side, hash: r.hash!, requested, decimals: p.decimals, wallet: owner, venue: p.venue.venue, feeWei: feeInside });
  const tokenDelta = tokenDeltaFromReceipt(receipt, token, owner);

  // Curve venues bill afterwards, on what the curve ACTUALLY took: a buy that
  // crosses the graduation line is clamped and the rest refunded in the same
  // transaction, so the requested amount would over-charge; a sell's proceeds
  // are the curve's number, not the quote's.
  let feeHash: Hex | null = null;
  let feeAfter = p.feeAfter;
  if (feeAfter.totalWei > 0n && feeAfter.treasury) {
    const curve = p.venue.venue === 'pons-curve' ? p.venue.curve?.address ?? null : null;
    const actual = curve
      ? curveFillWei(receipt, curve, req.side)
      : p.venue.venue === 'fourmeme-curve'
        ? fourmeme.fillWeiFromReceipt(receipt, token, owner, req.side)
        : null;
    if (actual !== null && actual > 0n) {
      const rebased = feePlanFor(actual, req.referrer, owner);
      if (rebased.totalWei !== feeAfter.totalWei) {
        logger.info(`evm ${chain}: fee rebased on the actual fill — ${weiToEth(feeAfter.totalWei).toFixed(6)} → ${weiToEth(rebased.totalWei).toFixed(6)} ${sym}`);
      }
      feeAfter = rebased;
    }
    if (feeAfter.totalWei > 0n && feeAfter.treasury) feeHash = await sendFee(chain, owner, feeAfter, token, symbol, req.side, p.decimals, p.venue.venue, req.walletId);
  }

  void evmWallet.refreshBalance(chain);
  const outHuman = req.side === 'buy' ? Number(tokenDelta) / 10 ** p.decimals : null;
  // Where the time went, on every fill: "feels slow" is a measurement
  // waiting to be taken. Build is the reads before signing (venue, balance,
  // allowance, gas, fees, nonce — each one through the endpoint's rate
  // gate); send+confirm is the broadcast and the receipt wait. Measured
  // live 2026-09-11 after a Pons round trip that felt slow and left no number.
  const totalMs = Date.now() - t0;
  const took = ` · ${(totalMs / 1000).toFixed(1)}s (build ${(buildMs / 1000).toFixed(1)}s, send+confirm ${((sendMs ?? 0) / 1000).toFixed(1)}s)`;
  const message =
    req.side === 'buy'
      ? `Bought ${outHuman !== null ? outHuman.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '?'} ${symbol} for ${req.amountNative} ${sym} (${VENUE_LABEL[p.venue.venue]})${took}`
      : `Sold ${req.amountRaw !== undefined ? `${(Number(-tokenDelta) / 10 ** p.decimals).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : `${req.pct ?? 100}% of`} ${symbol} (${VENUE_LABEL[p.venue.venue]}) — proceeds settle on the ledger in a moment${took}`;
  emit({ kind: 'toast', level: 'success', message });
  logger.info(`evm ${chain}: ${message} hash=${r.hash}`);
  return {
    ok: true,
    chain,
    stage: 'done',
    message,
    hash: r.hash,
    venue: p.venue.venue,
    quote: p.quote,
    amountIn: req.side === 'buy' ? p.amountIn.toString() : (-tokenDelta).toString(),
    amountOut: req.side === 'buy' ? tokenDelta.toString() : null,
    gasUsed: receipt.gasUsed.toString(),
    feeHash,
    simulated: false,
    timing: { totalMs: Date.now() - t0, buildMs, simulateMs: null, sendMs, confirmMs: null },
  };
}

/**
 * Charge the platform fee on a launch's creator buy.
 *
 * A Pons launch buys through `launchAndBuy`, one atomic call that nobody can
 * buy in front of — and no room inside it for a fee leg. So the fee is a plain
 * native transfer afterwards, on the same basis every other buy is charged on:
 * what the creator actually spent on their own coin.
 *
 * It is sent AFTER the launch has confirmed, and a failure here is logged, not
 * raised. The token exists either way, and failing a launch that already
 * happened because a 0.5 % transfer did not go through would be the worst
 * possible way to be right about a fee.
 */
export async function chargeLaunchFee(
  chain: EvmChainKind,
  walletId: string,
  owner: Address,
  spentWei: bigint,
  referrer: string,
): Promise<Hex | null> {
  if (spentWei <= 0n) return null;
  const plan = feePlanFor(spentWei, referrer, owner);
  if (plan.totalWei <= 0n || !plan.treasury) return null;
  const legs: Array<{ to: Address; wei: bigint }> = [];
  if (plan.treasury && plan.treasuryWei > 0n) legs.push({ to: plan.treasury, wei: plan.treasuryWei });
  if (plan.referrer && plan.referrerWei > 0n) legs.push({ to: plan.referrer, wei: plan.referrerWei });
  let last: Hex | null = null;
  for (const leg of legs) {
    const policy = policyFor(chain, [{ to: leg.to, selectors: 'transfer', maxValueWei: leg.wei }], { intent: 'fee', maxGas: 60_000n });
    try {
      const r = await sendBuilt(chain, owner, { to: leg.to, data: '0x', value: leg.wei }, policy, { simulateOnly: false, wait: false, walletId });
      if (r.ok && r.hash) last = r.hash;
      else logger.warn(`evm ${chain}: launch fee transfer skipped — ${r.message}`);
    } catch (e) {
      logger.warn(`evm ${chain}: launch fee transfer failed — ${shortError(e)}`);
    }
  }
  return last;
}

async function sendFee(chain: EvmChainKind, owner: Address, fee: FeePlan, token: Address, symbol: string, side: 'buy' | 'sell', decimals: number, venue: EvmVenue, walletId?: string): Promise<Hex | null> {
  const legs: Array<{ to: Address; wei: bigint }> = [];
  if (fee.treasury && fee.treasuryWei > 0n) legs.push({ to: fee.treasury, wei: fee.treasuryWei });
  if (fee.referrer && fee.referrerWei > 0n) legs.push({ to: fee.referrer, wei: fee.referrerWei });
  let last: Hex | null = null;
  for (const leg of legs) {
    const policy = policyFor(chain, [{ to: leg.to, selectors: 'transfer', maxValueWei: leg.wei }], { intent: 'fee', maxGas: 60_000n });
    try {
      const r = await sendCall(chain, owner, { to: leg.to, data: '0x', value: leg.wei }, policy, { simulateOnly: false, wait: false, walletId });
      if (r.ok && r.hash) {
        last = r.hash;
        ledger.recordFill({ chain, token, symbol, side, hash: r.hash, requested: 0, decimals, wallet: owner, venue, feeWei: leg.wei });
      } else logger.warn(`evm ${chain}: fee transfer skipped — ${r.message}`);
    } catch (e) {
      logger.warn(`evm ${chain}: fee transfer failed — ${shortError(e)}`);
    }
  }
  return last;
}
