// four.meme — BNB Smart Chain's pump.fun.
//
// Facts (four-flap-meme-sdk, the chain itself, 2026-09-09): `TokenManager2`
// creates a token with 1,000,000,000 supply and sells 800,000,000 of it on
// a curve; BNB-quoted launches graduate at 18 BNB (`maxFunds`) into a
// PancakeSwap v2 pair, after which `liquidityAdded` is true and the manager
// refuses trades; 1 % fee per fill (`tradingFeeRate` 100 of 10,000). Launches
// can be quoted in USDT or tokenised stocks instead of BNB — those need an
// ERC-20 approval to buy and are shown, not traded, in this version.
//
// Quotes come from the platform's own `TokenManagerHelper3` (`tryBuy`,
// `trySell`), so there is no curve formula to drift from; buys are also
// simulated with the exact calldata before signing (403k gas measured).
// Sells accept a third-party fee natively (`sellToken(origin, token, amount,
// minFunds, feeRate, feeRecipient)`), so a sell's platform fee is atomic
// without a router contract. Buys carry no such parameter, so a buy's fee
// follows as its own transfer until a BNB curve router is deployed.

import { encodeFunctionData, decodeEventLog, parseAbi, type Address, type Hex } from 'viem';

const ERC20_MIN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
import { ADDR_BSC, FOURMEME_CURVE_SUPPLY, FOURMEME_HELPER_ABI, FOURMEME_MANAGER_ABI, TOPIC_BSC } from './bsc';
import { client, logClient, simulateClient } from './client';
import { LOGS_MAX_RESULTS } from './chain';
import { MULTICALL_BYTES, shortError } from './pons';
import { curveProgressPct, NATIVE_ADDRESS, type EvmCurveState } from '@shared/evm';

export interface FourMemeLaunch {
  token: Address;
  creator: Address;
  name: string;
  symbol: string;
  totalSupply: bigint;
  launchTime: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

export interface FourMemeInfo {
  token: Address;
  version: bigint;
  tokenManager: Address;
  /** Quote asset; NATIVE_ADDRESS for BNB. */
  quote: Address;
  lastPrice: bigint;
  tradingFeeRate: bigint;
  minTradingFee: bigint;
  launchTime: bigint;
  /** Tokens still for sale on the curve (counts DOWN from 800 M). */
  offers: bigint;
  maxOffers: bigint;
  /** Quote raised so far, and the graduation line. */
  funds: bigint;
  maxFunds: bigint;
  liquidityAdded: boolean;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

export const isNativeQuote = (info: FourMemeInfo): boolean => info.quote === NATIVE_ADDRESS;
export const isFourMeme = (info: FourMemeInfo | null): info is FourMemeInfo => !!info && info.version > 0n && info.tokenManager !== NATIVE_ADDRESS;

// ── Launch discovery ──────────────────────────────────────────────────

/** TokenCreate events in [from, to]. ~20 a minute at 450 ms blocks, so a
 *  3,000-block window (~22 min) is ~450 logs; chunked to stay under both
 *  the 10,000-log cap and publicnode's 5,000-block range cap, and callers
 *  never ask past its ~10,000-block archive line (see discover.ts). */
export async function fetchLaunches(fromBlock: bigint, toBlock: bigint): Promise<FourMemeLaunch[]> {
  const c = logClient('bnb');
  const out: FourMemeLaunch[] = [];
  // 3,000 was sized for publicnode's range cap. Logs now resolve through the
  // capability map to an archival endpoint that allows 10,000 blocks per
  // query, inclusive. `TokenCreate` is a filtered event — 591 logs over 5,000
  // blocks, measured — so this stays far under LOGS_MAX_RESULTS and costs a
  // third of the calls. `fetchTrades` below keeps 3,000: it scans the manager
  // unfiltered and is the one that approaches the cap.
  const CHUNK = 10_000n;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
    const logs = await c.getLogs({ address: ADDR_BSC.fourMemeManager, event: FOURMEME_MANAGER_ABI[4], fromBlock: start, toBlock: end });
    if (logs.length >= LOGS_MAX_RESULTS) throw new Error(`four.meme launch scan hit the ${LOGS_MAX_RESULTS}-log cap on a ${CHUNK}-block window`);
    for (const l of logs) {
      const a = l.args;
      if (!a.token || !a.creator) continue;
      out.push({
        token: lower(a.token),
        creator: lower(a.creator),
        name: a.name ?? '',
        symbol: a.symbol ?? '',
        totalSupply: a.totalSupply ?? 0n,
        launchTime: a.launchTime ?? 0n,
        blockNumber: l.blockNumber ?? 0n,
        txHash: l.transactionHash ?? '0x',
      });
    }
  }
  return out;
}

// ── Reads ─────────────────────────────────────────────────────────────

function toInfo(token: Address, r: readonly [bigint, Address, Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean]): FourMemeInfo {
  return {
    token: lower(token),
    version: r[0],
    tokenManager: lower(r[1]),
    quote: lower(r[2]),
    lastPrice: r[3],
    tradingFeeRate: r[4],
    minTradingFee: r[5],
    launchTime: r[6],
    offers: r[7],
    maxOffers: r[8],
    funds: r[9],
    maxFunds: r[10],
    liquidityAdded: r[11],
  };
}

/** `getTokenInfo` for many tokens in one multicall. Tokens the helper does
 *  not know (not four.meme launches) come back with version 0. */
export async function infos(tokens: Address[]): Promise<Map<string, FourMemeInfo>> {
  const out = new Map<string, FourMemeInfo>();
  if (!tokens.length) return out;
  const res = await client('bnb').multicall({
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
    contracts: tokens.map((t) => ({ address: ADDR_BSC.fourMemeHelper, abi: FOURMEME_HELPER_ABI, functionName: 'getTokenInfo' as const, args: [t] as const })),
  });
  tokens.forEach((t, i) => {
    const r = res[i];
    if (r.status !== 'success') return;
    out.set(t.toLowerCase(), toInfo(t, r.result as never));
  });
  return out;
}

export async function info(token: Address): Promise<FourMemeInfo | null> {
  try {
    const r = await client('bnb').readContract({ address: ADDR_BSC.fourMemeHelper, abi: FOURMEME_HELPER_ABI, functionName: 'getTokenInfo', args: [token] });
    const i = toInfo(token, r as never);
    return isFourMeme(i) ? i : null;
  } catch (e) {
    throw new Error(`four.meme helper read failed: ${shortError(e)}`);
  }
}

/** The PancakeSwap v2 pair a graduated launch trades in, or null. */
export async function pancakePair(token: Address): Promise<Address | null> {
  try {
    const p = await client('bnb').readContract({ address: ADDR_BSC.fourMemeHelper, abi: FOURMEME_HELPER_ABI, functionName: 'getPancakePair', args: [token] });
    return p && p !== NATIVE_ADDRESS ? lower(p) : null;
  } catch {
    return null;
  }
}

/** Progress toward graduation, 0..100. */
export function progressPct(i: FourMemeInfo): number {
  return curveProgressPct(i.funds, i.maxFunds, i.liquidityAdded);
}

/** Marginal price in quote units per whole token. `lastPrice` is the
 *  helper's price scaled by 1e18 per token... measured: 5739795918 for a
 *  fresh BNB curve ≈ 5.7e-9 BNB per token, which matches tryBuy. */
export function spotPrice(i: FourMemeInfo): number | null {
  if (i.lastPrice <= 0n) return null;
  return Number(i.lastPrice) / 1e18;
}

export function toShared(i: FourMemeInfo): EvmCurveState {
  return {
    address: i.tokenManager,
    realQuoteWei: i.funds.toString(),
    thresholdWei: i.maxFunds.toString(),
    progressPct: progressPct(i),
    graduated: i.liquidityAdded,
    // Sold out counts as ready: the last buy leaves `funds` a hair under
    // `maxFunds` (1.88e9 wei measured) while `offers` hits 0.
    readyToGraduate: !i.liquidityAdded && (i.funds >= i.maxFunds || i.offers === 0n),
    feeBps: Number(i.tradingFeeRate),
    creatorTaxBps: 0,
    pairToken: i.quote,
    isNativeQuote: isNativeQuote(i),
    priceQuote: spotPrice(i),
    sellableTokens: i.offers.toString(),
    tokenReserve: FOURMEME_CURVE_SUPPLY.toString(),
    quoteReserve: i.funds.toString(),
  };
}

// ── Quotes (the platform's own helper) ────────────────────────────────

export async function quoteBuy(token: Address, fundsWei: bigint): Promise<{ tokensOut: bigint; cost: bigint; fee: bigint; msgValue: bigint } | { error: string }> {
  try {
    const r = await client('bnb').readContract({ address: ADDR_BSC.fourMemeHelper, abi: FOURMEME_HELPER_ABI, functionName: 'tryBuy', args: [token, 0n, fundsWei] });
    return { tokensOut: r[2], cost: r[3], fee: r[4], msgValue: r[5] };
  } catch (e) {
    return { error: shortError(e) };
  }
}

export async function quoteSell(token: Address, tokensIn: bigint): Promise<{ quoteOut: bigint; fee: bigint } | { error: string }> {
  try {
    const r = await client('bnb').readContract({ address: ADDR_BSC.fourMemeHelper, abi: FOURMEME_HELPER_ABI, functionName: 'trySell', args: [token, tokensIn] });
    return { quoteOut: r[2], fee: r[3] };
  } catch (e) {
    return { error: shortError(e) };
  }
}

// ── Calldata ──────────────────────────────────────────────────────────

/** Buy as much as `funds` (msg.value) buys, at least `minAmount` tokens. */
export function encodeBuy(token: Address, funds: bigint, minAmount: bigint): Hex {
  return encodeFunctionData({ abi: FOURMEME_MANAGER_ABI, functionName: 'buyTokenAMAP', args: [token, funds, minAmount] });
}

/** Sell with the platform's own third-party fee: `feeRate` bps of the
 *  proceeds to `feeRecipient`, atomically. Zero fee ⇒ the plain overload. */
export function encodeSell(token: Address, amount: bigint, minFunds: bigint, feeRate: bigint, feeRecipient: Address | null): Hex {
  if (feeRate > 0n && feeRecipient) {
    return encodeFunctionData({ abi: FOURMEME_MANAGER_ABI, functionName: 'sellToken', args: [0n, token, amount, minFunds, feeRate, feeRecipient] });
  }
  return encodeFunctionData({ abi: FOURMEME_MANAGER_ABI, functionName: 'sellToken', args: [token, amount, minFunds] });
}

/** eth_call the exact buy from `from`. With `override` the caller's balance
 *  is pretended (paper / unfunded wallet). */
/**
 * Simulate the EXACT buy that will be signed, minimum included.
 *
 * `minAmount` matters: the helper's `tryBuy` over-estimates a fresh curve's
 * fill by up to 9 % (measured 2026-09-09 across the New column), so a
 * simulation run with a minimum of 0 always passes while the transaction the
 * rail actually builds reverts `Slippage`. Simulating the real minimum is the
 * whole point of simulating.
 */
export async function simulateBuy(token: Address, from: Address, funds: bigint, minAmount: bigint, override: boolean): Promise<{ gas: bigint; tokensOut: bigint | null } | { error: string }> {
  const c = client('bnb');
  const data = encodeBuy(token, funds, minAmount);
  const stateOverride = override ? [{ address: from, balance: funds * 4n + 10n ** 16n }] : undefined;
  // The fill first, from a real simulation: many four.meme tokens levy a
  // per-token CREATOR BUY TAX that the platform's own `tryBuy` does not model
  // (measured 1 %, 2 %, 3 % and 10 % tiers, up to a 9.8 % shortfall), so a
  // minimum derived from `tryBuy` reverts `Slippage` on the real transaction.
  // Roughly half of brand-new curves were failing at the default 5 % because
  // of it.
  const fill = await simulatedFill(token, from, funds, override);
  try {
    const gas = await c.estimateGas({ account: from, to: ADDR_BSC.fourMemeManager, data, value: funds, stateOverride });
    return { gas, tokensOut: fill };
  } catch (e) {
    return { error: shortError(e) };
  }
}

const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

/** The tokens a buy of `funds` actually delivers, or null when the node will
 *  not simulate. Balance before and after, around the buy, in one call. */
async function simulatedFill(token: Address, from: Address, funds: bigint, override: boolean): Promise<bigint | null> {
  const balData = encodeFunctionData({ abi: ERC20_MIN_ABI, functionName: 'balanceOf', args: [from] });
  try {
    // The simulate capability, not the general read client: a per-method 401
    // now disqualifies one capability instead of blacklisting the endpoint
    // whole, and that only works when the call arrives on the right client.
    const res = (await simulateClient('bnb').request({
      method: 'eth_simulateV1',
      params: [
        {
          blockStateCalls: [
            {
              stateOverrides: override ? { [from]: { balance: hex(funds * 4n + 10n ** 16n) } } : {},
              calls: [
                { from, to: token, data: balData },
                { from, to: ADDR_BSC.fourMemeManager, value: hex(funds), data: encodeBuy(token, funds, 0n) },
                { from, to: token, data: balData },
              ],
            },
          ],
          validation: false,
          traceTransfers: false,
        },
        'latest',
      ],
    } as never)) as Array<{ calls?: Array<{ status?: string; returnData?: string }> }>;
    const calls = res?.[0]?.calls;
    if (!calls || calls.length < 3) return null;
    if (calls[1]?.status !== '0x1') return null;
    const before = BigInt(calls[0]?.returnData || '0x0');
    const after = BigInt(calls[2]?.returnData || '0x0');
    const delta = after - before;
    return delta > 0n ? delta : null;
  } catch {
    return null;
  }
}

// ── Trade events (the tape) ───────────────────────────────────────────

export interface FourMemeTrade {
  token: Address;
  isBuy: boolean;
  trader: Address;
  quoteWei: bigint;
  tokensRaw: bigint;
  feeWei: bigint;
  /** Curve state after the fill. */
  offers: bigint;
  funds: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

/** TokenPurchase / TokenSale across EVERY four.meme token in [from, to]
 *  (no per-token filter: the manager emits them all). */
export async function fetchTrades(fromBlock: bigint, toBlock: bigint): Promise<FourMemeTrade[]> {
  // Chunked and capped like fetchLaunches. One 9,000-block query already
  // returns ~10,000 logs (7.9 MB); past publicnode's result ceiling it fails
  // outright, and the caller's fallback silently guts the Graduating column.
  // Only the two trade topics are asked for — the manager emits several others.
  const c = logClient('bnb');
  const CHUNK = 3_000n;
  const logs: Awaited<ReturnType<typeof c.getLogs>> = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
    const part = await c.getLogs({ address: ADDR_BSC.fourMemeManager, fromBlock: start, toBlock: end });
    if (part.length >= LOGS_MAX_RESULTS) throw new Error(`four.meme trade scan hit the ${LOGS_MAX_RESULTS}-log cap on a ${CHUNK}-block window`);
    logs.push(...part);
  }
  const out: FourMemeTrade[] = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 !== TOPIC_BSC.tokenPurchase && t0 !== TOPIC_BSC.tokenSale) continue;
    try {
      const d = decodeEventLog({ abi: FOURMEME_MANAGER_ABI, data: l.data, topics: l.topics });
      if (d.eventName !== 'TokenPurchase' && d.eventName !== 'TokenSale') continue;
      out.push({
        token: lower(d.args.token),
        isBuy: d.eventName === 'TokenPurchase',
        trader: lower(d.args.account),
        quoteWei: d.args.cost,
        tokensRaw: d.args.amount,
        feeWei: d.args.fee,
        offers: d.args.offers,
        funds: d.args.funds,
        blockNumber: l.blockNumber ?? 0n,
        txHash: l.transactionHash ?? '0x',
        logIndex: l.logIndex ?? 0,
      });
    } catch {
      /* a log this ABI does not describe */
    }
  }
  return out;
}

/**
 * What the curve ACTUALLY took (buy) or paid (sell) in this receipt, in wei.
 *
 * `buyTokenAMAP` clamps a buy to what the curve has room for and refunds the
 * rest in the same transaction, so the requested amount is the wrong basis for
 * a fee — a 10 BNB buy into a curve with 6.76 BNB of room refunds 3.17 BNB and
 * would otherwise be billed on all 10. Both events carry every field
 * UNINDEXED, so the token and the trader are matched from the data words.
 * Buy basis is `cost + fee` (what left the wallet); sell basis is `cost` (the
 * gross the platform's own fee is taken from).
 */
export function fillWeiFromReceipt(receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] }, token: Address, owner: Address, side: 'buy' | 'sell'): bigint | null {
  const want = side === 'buy' ? TOPIC_BSC.tokenPurchase : TOPIC_BSC.tokenSale;
  const tok = token.toLowerCase();
  const me = owner.toLowerCase();
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== ADDR_BSC.fourMemeManager.toLowerCase()) continue;
    if (l.topics[0] !== want || l.topics.length !== 1) continue;
    if (typeof l.data !== 'string' || l.data.length < 2 + 64 * 6) continue;
    const word = (i: number): string => l.data.slice(2 + i * 64, 2 + (i + 1) * 64);
    try {
      if (`0x${word(0).slice(24)}`.toLowerCase() !== tok) continue;
      if (`0x${word(1).slice(24)}`.toLowerCase() !== me) continue;
      const cost = BigInt(`0x${word(4)}`);
      const fee = BigInt(`0x${word(5)}`);
      return side === 'buy' ? cost + fee : cost;
    } catch {
      return null;
    }
  }
  return null;
}
