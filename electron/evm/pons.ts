// Pons V2 — Robinhood Chain's pump.fun.
//
// Mechanics (docs.ponsfamily.com/v2, verified on chain 2026-09-08): a launch
// mints 1,000,000,000 tokens into its own constant-product bonding curve
// with a phantom quote reserve; buys and sells go straight to the curve
// (`buy(quoteIn, minOut, recipient)` payable, `sell(tokensIn, minOut,
// recipient)`); 1 % fee + a creator tax on every fill; a snipe tax that
// starts at 99 % and decays to zero in the first seconds; at 4.2 ETH of
// real quote the curve sweeps into a full-range Uniswap v4 pool with the
// Pons hook and the position is locked forever. ~400 launches an hour and
// ~10 graduations an hour measured.
//
// Quotes: the documented formula runs a few percent above what the curve
// actually returns (57,313 vs 59,423 tokens on a 0.001 ETH buy, 2026-09-08),
// so the formula is the ESTIMATE and an eth_call of the real calldata is
// the QUOTE. Every trade is simulated with the exact bytes before signing.

import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, type Address, type Hex } from 'viem';
import { ADDR, ERC20_ABI, KRYPT_ROUTER_ABI, PONS_CURVE_ABI, PONS_FACTORY_ABI, PONS_LAUNCH_ABI, PONS_LAUNCH_CONFIG_ID, PONS_LAUNCH_FEE_WEI, REVERT_ERRORS_ABI, TOPIC, PONS_SUPPLY, LOGS_MAX_RESULTS } from './chain';
import { client, logClient } from './client';
import { logger } from '../system/logger';
import { curveProgressPct, NATIVE_ADDRESS, type EvmCurveState, type EvmPoolKey } from '@shared/evm';

export interface PonsLaunch {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  blockNumber: bigint;
  txHash: Hex;
  /** Filled from the block header when known. */
  at: number | null;
}

export interface PonsLaunchRecord {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** 0 on curve · 1 swept · 2 pool created · 3 rescued. */
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
}

export interface CurveState {
  address: Address;
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  sellableTokens: bigint;
  reservedTokens: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  graduationThreshold: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  isNativeQuote: boolean;
  pairToken: Address;
}

const lower = (a: string): Address => a.toLowerCase() as Address;

// ── Launch discovery ──────────────────────────────────────────────────

/**
 * TokenLaunched events in [from, to]. The factory emits ~7 a minute, so a
 * 20k-block window (~33 min) is ~400 logs — well under the node's 10,000-log
 * cap. Wider asks are chunked so a quiet endpoint never sees one huge query.
 */
export async function fetchLaunches(fromBlock: bigint, toBlock: bigint): Promise<PonsLaunch[]> {
  const c = logClient('robinhood');
  const out: PonsLaunch[] = [];
  const CHUNK = 20_000n;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n < toBlock ? start + CHUNK - 1n : toBlock;
    const logs = await c.getLogs({
      address: ADDR.ponsFactory,
      event: PONS_FACTORY_ABI[3],
      fromBlock: start,
      toBlock: end,
    });
    if (logs.length >= LOGS_MAX_RESULTS) {
      // Should not happen at 20k blocks; if the chain ever gets that hot the
      // caller shrinks its window rather than silently dropping launches.
      throw new Error(`launch scan hit the ${LOGS_MAX_RESULTS}-log cap on a ${CHUNK}-block window`);
    }
    for (const l of logs) {
      const a = l.args;
      if (!a.token || !a.curve || !a.deployer || !a.pairToken) continue;
      out.push({
        token: lower(a.token),
        curve: lower(a.curve),
        deployer: lower(a.deployer),
        pairToken: lower(a.pairToken),
        launchConfigId: a.launchConfigId ?? 0n,
        graduationThreshold: a.graduationThreshold ?? 0n,
        blockNumber: l.blockNumber ?? 0n,
        txHash: l.transactionHash ?? '0x',
        at: null,
      });
    }
  }
  return out;
}

/** Tokens that graduated (LaunchSwept) in [from, to], newest last. */
export async function fetchGraduations(fromBlock: bigint, toBlock: bigint): Promise<Array<{ token: Address; blockNumber: bigint; sweptQuote: bigint; txHash: Hex }>> {
  const c = logClient('robinhood');
  const logs = await c.getLogs({
    address: ADDR.ponsFactory,
    event: PONS_FACTORY_ABI[4],
    fromBlock,
    toBlock,
  });
  return logs
    .filter((l) => l.topics[0] === TOPIC.launchSwept && l.args.token)
    .map((l) => ({
      token: lower(l.args.token as string),
      blockNumber: l.blockNumber ?? 0n,
      sweptQuote: l.args.sweptQuote ?? 0n,
      txHash: l.transactionHash ?? '0x',
    }));
}

// ── Reads ─────────────────────────────────────────────────────────────

/** The factory's record for a token, or null when it is NOT a Pons launch.
 *  An RPC failure throws — "not a Pons token" and "could not ask" must never
 *  look the same, or a rate-limited moment reads as "cannot route". */
export async function launchRecord(token: Address): Promise<PonsLaunchRecord | null> {
  let r: Awaited<ReturnType<typeof readLaunch>>;
  try {
    r = await readLaunch(token);
  } catch (e) {
    throw new Error(`Pons factory read failed: ${shortError(e)}`);
  }
  if (!r.exists) return null;
  return {
      token: lower(r.token),
      curve: lower(r.curve),
      deployer: lower(r.deployer),
      creatorFeeRecipient: lower(r.creatorFeeRecipient),
      pairToken: lower(r.pairToken),
      graduationThreshold: r.graduationThreshold,
      poolFee: Number(r.poolFee),
      tickSpacing: Number(r.tickSpacing),
      creatorTaxBps: Number(r.creatorTaxBps),
      buybackEnabled: r.buybackEnabled,
      phase: Number(r.phase),
      sweptQuote: r.sweptQuote,
      sweptTokens: r.sweptTokens,
      sweptAt: r.sweptAt,
      exists: true,
    };
}

function readLaunch(token: Address) {
  return client('robinhood').readContract({
    address: ADDR.ponsFactory,
    abi: PONS_FACTORY_ABI,
    functionName: 'getLaunchedToken',
    args: [token],
  });
}

/** Bytes of calldata per Multicall3 chunk. viem's default (1,024) turned a
 *  440-view read into ~30 eth_calls; 32 KB keeps it to one or two, and the
 *  node's eth_call gas allowance covers it (measured). */
export const MULTICALL_BYTES = 32_768;

/** The v4 pool a graduated launch trades in. Currencies sort by address;
 *  native ETH is address(0) and therefore always currency0. */
export function poolKeyFor(record: PonsLaunchRecord): EvmPoolKey {
  const token = record.token.toLowerCase();
  const pair = record.pairToken.toLowerCase();
  const [c0, c1] = BigInt(token) < BigInt(pair) ? [token, pair] : [pair, token];
  return { currency0: c0, currency1: c1, fee: record.poolFee, tickSpacing: record.tickSpacing, hooks: ADDR.ponsMemeHook.toLowerCase() };
}

const CURVE_VIEWS = [
  'getReserves',
  'realQuoteReserve',
  'sellableTokens',
  'reservedTokens',
  'graduated',
  'readyToGraduate',
  'graduationThreshold',
  'feeBps',
  'creatorTaxBps',
  'isNativeQuote',
  'pairToken',
] as const;

/** Read every curve's state in one multicall (11 views per curve). */
export async function curveStates(curves: Address[]): Promise<Map<string, CurveState>> {
  const out = new Map<string, CurveState>();
  if (!curves.length) return out;
  const c = client('robinhood');
  const BATCH = 40; // 440 calls per multicall
  for (let i = 0; i < curves.length; i += BATCH) {
    const slice = curves.slice(i, i + BATCH);
    const res = await c.multicall({
      allowFailure: true,
      batchSize: MULTICALL_BYTES,
      contracts: slice.flatMap((address) => CURVE_VIEWS.map((fn) => ({ address, abi: PONS_CURVE_ABI, functionName: fn }))),
    });
    slice.forEach((address, j) => {
      const at = (k: number) => res[j * CURVE_VIEWS.length + k];
      const reserves = at(0);
      if (reserves.status !== 'success' || !Array.isArray(reserves.result)) return;
      const [quoteReserve, tokenReserve] = reserves.result as readonly [bigint, bigint];
      const big = (k: number, d = 0n): bigint => (at(k).status === 'success' ? (at(k).result as bigint) : d);
      const bool = (k: number): boolean => at(k).status === 'success' && at(k).result === true;
      const pair = at(10).status === 'success' ? lower(at(10).result as string) : (NATIVE_ADDRESS as Address);
      out.set(address.toLowerCase(), {
        address: lower(address),
        quoteReserve,
        tokenReserve,
        realQuoteReserve: big(1),
        sellableTokens: big(2),
        reservedTokens: big(3),
        graduated: bool(4),
        readyToGraduate: bool(5),
        graduationThreshold: big(6),
        feeBps: big(7, 100n),
        creatorTaxBps: big(8),
        isNativeQuote: bool(9),
        pairToken: pair,
      });
    });
  }
  return out;
}

export async function curveState(curve: Address): Promise<CurveState | null> {
  const m = await curveStates([curve]);
  return m.get(curve.toLowerCase()) ?? null;
}

/** ERC-20 facts for many tokens in one multicall. */
export async function tokenMeta(tokens: Address[]): Promise<Map<string, { name: string; symbol: string; decimals: number; totalSupply: bigint }>> {
  const out = new Map<string, { name: string; symbol: string; decimals: number; totalSupply: bigint }>();
  if (!tokens.length) return out;
  const res = await client('robinhood').multicall({
    allowFailure: true,
    batchSize: MULTICALL_BYTES,
    contracts: tokens.flatMap((address) => [
      { address, abi: ERC20_ABI, functionName: 'name' as const },
      { address, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address, abi: ERC20_ABI, functionName: 'decimals' as const },
      { address, abi: ERC20_ABI, functionName: 'totalSupply' as const },
    ]),
  });
  tokens.forEach((address, i) => {
    const name = res[i * 4], symbol = res[i * 4 + 1], dec = res[i * 4 + 2], supply = res[i * 4 + 3];
    out.set(address.toLowerCase(), {
      name: name.status === 'success' ? String(name.result) : '',
      symbol: symbol.status === 'success' ? String(symbol.result) : '',
      decimals: dec.status === 'success' ? Number(dec.result) : 18,
      totalSupply: supply.status === 'success' ? (supply.result as bigint) : 0n,
    });
  });
  return out;
}

// ── Arithmetic (estimates) ────────────────────────────────────────────

const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint =>
  reserveIn + amountIn === 0n ? 0n : (amountIn * reserveOut) / (reserveIn + amountIn);

/** Documented buy formula. An ESTIMATE — see the header. */
export function estimateBuy(s: CurveState, quoteIn: bigint, snipeTaxBps = 0n): bigint {
  const fee = (quoteIn * s.feeBps) / 10_000n;
  const tax = (quoteIn * s.creatorTaxBps) / 10_000n;
  const snipe = (quoteIn * snipeTaxBps) / 10_000n;
  const net = quoteIn - fee - tax - snipe;
  if (net <= 0n) return 0n;
  const out = amountOut(net, s.quoteReserve, s.tokenReserve);
  return out > s.sellableTokens ? s.sellableTokens : out;
}

/** Documented sell formula: gross from the curve, then fee and tax off the
 *  quote side. No snipe tax on sells. */
export function estimateSell(s: CurveState, tokensIn: bigint): bigint {
  const gross = amountOut(tokensIn, s.tokenReserve, s.quoteReserve);
  const fee = (gross * s.feeBps) / 10_000n;
  const tax = (gross * s.creatorTaxBps) / 10_000n;
  const net = gross - fee - tax;
  return net > 0n ? net : 0n;
}

/** Marginal price: quote per whole token (both 18 decimals when native). */
export function spotPrice(s: CurveState, quoteDecimals = 18): number | null {
  if (s.tokenReserve <= 0n) return null;
  const SCALE = 10n ** 18n;
  const q = Number((s.quoteReserve * SCALE) / s.tokenReserve) / 1e18; // quote units per token unit
  return q * 10 ** (18 - quoteDecimals);
}

export function toShared(s: CurveState): EvmCurveState {
  return {
    address: s.address,
    realQuoteWei: s.realQuoteReserve.toString(),
    thresholdWei: s.graduationThreshold.toString(),
    progressPct: curveProgressPct(s.realQuoteReserve, s.graduationThreshold, s.graduated),
    graduated: s.graduated,
    readyToGraduate: s.readyToGraduate,
    feeBps: Number(s.feeBps),
    creatorTaxBps: Number(s.creatorTaxBps),
    pairToken: s.pairToken,
    isNativeQuote: s.isNativeQuote,
    priceQuote: spotPrice(s),
    sellableTokens: s.sellableTokens.toString(),
    tokenReserve: s.tokenReserve.toString(),
    quoteReserve: s.quoteReserve.toString(),
  };
}

export { PONS_SUPPLY };

// ── Calldata ──────────────────────────────────────────────────────────

export function encodeBuy(quoteIn: bigint, minTokensOut: bigint, recipient: Address): Hex {
  return encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'buy', args: [quoteIn, minTokensOut, recipient] });
}

export function encodeSell(tokensIn: bigint, minQuoteOut: bigint, recipient: Address): Hex {
  return encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'sell', args: [tokensIn, minQuoteOut, recipient] });
}

/**
 * The real answer: eth_call the exact buy from `from`. With `override` the
 * caller's balance is pretended (simulation for an unfunded or paper wallet);
 * without it the call runs against the wallet's true state.
 */
export async function simulateBuy(curve: Address, from: Address, quoteIn: bigint, override: boolean): Promise<{ tokensOut: bigint; gas: bigint } | { error: string }> {
  const c = client('robinhood');
  const data = encodeBuy(quoteIn, 0n, from);
  const stateOverride = override ? [{ address: from, balance: quoteIn * 4n + 10n ** 16n }] : undefined;
  try {
    const [res, gas] = await Promise.all([
      c.call({ account: from, to: curve, data, value: quoteIn, stateOverride }),
      c.estimateGas({ account: from, to: curve, data, value: quoteIn, stateOverride }),
    ]);
    if (!res.data) return { error: 'curve returned no data' };
    const tokensOut = decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName: 'buy', data: res.data });
    return { tokensOut, gas };
  } catch (e) {
    return { error: shortError(e) };
  }
}

/**
 * The same buy, through Krypt's curve router (the fee lands in the same
 * transaction). `refundWei` is what the curve handed back on a partial fill
 * and the router forwarded to the buyer.
 */
export async function simulateRouterBuy(
  router: Address,
  curve: Address,
  from: Address,
  quoteIn: bigint,
  feeWei: bigint,
  referrer: Address | null,
  referrerWei: bigint,
  override: boolean,
): Promise<{ tokensOut: bigint; refundWei: bigint; gas: bigint } | { error: string }> {
  const c = client('robinhood');
  const data = encodeRouterBuy(curve, quoteIn, 0n, feeWei, referrer, referrerWei);
  const value = quoteIn + feeWei;
  const stateOverride = override ? [{ address: from, balance: value * 4n + 10n ** 16n }] : undefined;
  try {
    const [res, gas] = await Promise.all([
      c.call({ account: from, to: router, data, value, stateOverride }),
      c.estimateGas({ account: from, to: router, data, value, stateOverride }),
    ]);
    if (!res.data) return { error: 'router returned no data' };
    const [tokensOut, refundWei] = decodeFunctionResult({ abi: KRYPT_ROUTER_ABI, functionName: 'buy', data: res.data });
    return { tokensOut, refundWei, gas };
  } catch (e) {
    return { error: shortError(e) };
  }
}

export function encodeRouterBuy(curve: Address, quoteIn: bigint, minTokensOut: bigint, feeWei: bigint, referrer: Address | null, referrerWei: bigint): Hex {
  return encodeFunctionData({
    abi: KRYPT_ROUTER_ABI,
    functionName: 'buy',
    args: [curve, quoteIn, minTokensOut, feeWei, referrer ?? (NATIVE_ADDRESS as Address), referrerWei],
  });
}

/** An ERC-20 allowance forced on for a simulation only (built by
 *  erc20.allowanceStateOverride — passed in, not imported, because erc20.ts
 *  imports this module). */
export interface AllowanceOverride {
  address: Address;
  stateDiff: Array<{ slot: Hex; value: Hex }>;
}

/**
 * eth_call the exact sell from the holder. The tokens must really be in the
 * wallet — only the true state can say that — but the curve pulls them with
 * `transferFrom`, so a wallet that has not approved the curve yet can only
 * be quoted with the allowance overridden. `allowance` carries that override;
 * the approval itself is a real transaction the plan sends first.
 */
export async function simulateSell(curve: Address, from: Address, tokensIn: bigint, allowance?: AllowanceOverride): Promise<{ quoteOut: bigint; gas: bigint } | { error: string }> {
  const c = client('robinhood');
  const data = encodeSell(tokensIn, 0n, from);
  const stateOverride = allowance ? [allowance] : undefined;
  try {
    const [res, gas] = await Promise.all([
      c.call({ account: from, to: curve, data, stateOverride }),
      c.estimateGas({ account: from, to: curve, data, stateOverride }),
    ]);
    if (!res.data) return { error: 'curve returned no data' };
    const quoteOut = decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName: 'sell', data: res.data });
    return { quoteOut, gas };
  } catch (e) {
    return { error: shortError(e) };
  }
}

/** Walk an error chain for the revert payload the node returned. */
function revertData(e: unknown): Hex | null {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let i = 0; i < 12 && cur && typeof cur === 'object'; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const o = cur as { data?: unknown; cause?: unknown };
    const d = o.data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex;
    if (d && typeof d === 'object') {
      const inner = (d as { data?: unknown }).data;
      if (typeof inner === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex;
    }
    cur = o.cause;
  }
  return null;
}

// Chain-neutral: this decoder is shared, and printing ETH on the BNB rail
// would tell a PancakeSwap seller the pool would pay N ETH.
const wei = (v: unknown): string => (typeof v === 'bigint' ? `${(Number(v) / 1e18).toFixed(6)}` : String(v));

/** Turn a decoded custom error into a sentence a trader can act on. */
function sayRevert(name: string, args: readonly unknown[]): string {
  switch (name) {
    case 'SlippageExceeded':
      return `Slippage: the curve would pay ${wei(args[0])}, the floor was ${wei(args[1])}. Raise slippage or trade a smaller size.`;
    case 'V4TooLittleReceived':
    case 'V3TooLittleReceived':
    case 'V2TooLittleReceived':
      return `Slippage: the pool would pay ${wei(args[1])}, the floor was ${wei(args[0])}. Raise slippage or trade a smaller size.`;
    case 'ERC20InsufficientAllowance':
      return 'The token is not approved for this contract yet — the approval transaction goes first.';
    case 'ERC20InsufficientBalance':
      return 'The wallet does not hold that many tokens any more.';
    case 'ReferrerShareTooHigh':
      return 'The router refused the referral split — clear the referrer in Settings.';
    case 'TransactionDeadlinePassed':
      return 'The quote expired before the transaction landed — try again.';
    case 'Error': {
      // four.meme reverts with a bare string; give the two a trader meets a
      // sentence instead of a two-word code.
      const r = String(args[0] ?? 'reverted');
      if (/^disabled$/i.test(r)) return 'The curve is closed — it has sold out and the PancakeSwap pool is being created. Try again in a moment.';
      if (/^slippage$/i.test(r)) return 'Slippage: the curve would fill less than your minimum. Raise slippage or trade a smaller size.';
      if (/^gw$/i.test(r)) return 'four.meme refused this size on its curve. Try a different amount, or sell the whole position.';
      return r;
    }
    default:
      return `${name}${args.length ? `(${args.map((a) => String(a)).join(', ')})` : '()'}`;
  }
}

export function shortError(e: unknown): string {
  const data = revertData(e);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: REVERT_ERRORS_ABI, data });
      return sayRevert(d.errorName, (d.args ?? []) as readonly unknown[]).slice(0, 200);
    } catch {
      // Unknown custom error: the 4-byte selector still names it uniquely.
      return `reverted (${data.slice(0, 10)})`;
    }
  }
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const s = err?.details || err?.shortMessage || err?.message || 'call failed';
  // Never let a keyed RPC URL out of an error message (the key is in the path).
  return String(s)
    .replace(/https?:\/\/\S+/g, (u) => {
      try {
        return new URL(u).host;
      } catch {
        return 'the RPC endpoint';
      }
    })
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

// ── Trade events (the tape) ───────────────────────────────────────────

export interface CurveTrade {
  curve: Address;
  isBuy: boolean;
  trader: Address;
  quoteWei: bigint;
  tokensRaw: bigint;
  feeWei: bigint;
  taxWei: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

const CURVE_BUY_EVENT = PONS_CURVE_ABI.find((x) => x.type === 'event' && x.name === 'CurveBuy') as Extract<
  (typeof PONS_CURVE_ABI)[number],
  { type: 'event'; name: 'CurveBuy' }
>;
const CURVE_SELL_EVENT = PONS_CURVE_ABI.find((x) => x.type === 'event' && x.name === 'CurveSell') as Extract<
  (typeof PONS_CURVE_ABI)[number],
  { type: 'event'; name: 'CurveSell' }
>;

/**
 * CurveBuy / CurveSell across EVERY Pons curve in [from, to].
 *
 * The per-curve reader below is right for a token page; a scanner watching
 * every launch on the chain cannot make one request per curve. Pons emits
 * these from the curve contract itself, so the log's own address IS the curve
 * and no address filter is needed — the same no-address scan Discover already
 * uses for its activity check.
 */
export async function fetchAllCurveTrades(fromBlock: bigint, toBlock: bigint): Promise<CurveTrade[]> {
  // FILTER BY TOPIC, always. Asking for every log in the range and sorting it
  // out here is what a no-address scan looks like if you forget that "no
  // address" does not mean "no filter": over 300 blocks it returned the whole
  // chain's logs and died with "HTTP response body exceeded the size limit"
  // (measured 2026-09-10). The same range with these two topics is ~15 logs.
  const logs = await logClient('robinhood').getLogs({
    events: [CURVE_BUY_EVENT, CURVE_SELL_EVENT],
    fromBlock,
    toBlock,
  });
  const out: CurveTrade[] = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell) continue;
    try {
      const d = decodeEventLog({ abi: PONS_CURVE_ABI, data: l.data, topics: l.topics });
      const common = {
        curve: lower(l.address) as Address,
        trader: lower(d.args.recipient),
        feeWei: d.args.fee,
        taxWei: d.args.tax,
        blockNumber: l.blockNumber ?? 0n,
        txHash: l.transactionHash ?? ('0x' as Hex),
        logIndex: l.logIndex ?? 0,
      };
      if (d.eventName === 'CurveBuy') {
        out.push({ ...common, isBuy: true, quoteWei: d.args.quoteIn, tokensRaw: d.args.tokensOut });
      } else if (d.eventName === 'CurveSell') {
        out.push({ ...common, isBuy: false, quoteWei: d.args.quoteOut, tokensRaw: d.args.tokensIn });
      }
    } catch {
      // topic0 already proved this ABI describes the signature, so a throw
      // here is drift or a malformed log — not "a log we do not know".
      logger.warn(`pons: a CurveBuy/CurveSell log did not decode (${l.transactionHash ?? 'no tx'})`);
    }
  }
  return out;
}

/** CurveBuy / CurveSell logs for one curve. `buyer` on a launchAndBuy is the
 *  Pons router, so the RECIPIENT is the trader. */
export async function fetchCurveTrades(curve: Address, fromBlock: bigint, toBlock: bigint): Promise<CurveTrade[]> {
  const logs = await logClient('robinhood').getLogs({ address: curve, fromBlock, toBlock });
  const out: CurveTrade[] = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell) continue;
    try {
      const d = decodeEventLog({ abi: PONS_CURVE_ABI, data: l.data, topics: l.topics });
      if (d.eventName === 'CurveBuy') {
        out.push({
          curve,
          isBuy: true,
          trader: lower(d.args.recipient),
          quoteWei: d.args.quoteIn,
          tokensRaw: d.args.tokensOut,
          feeWei: d.args.fee,
          taxWei: d.args.tax,
          blockNumber: l.blockNumber ?? 0n,
          txHash: l.transactionHash ?? '0x',
          logIndex: l.logIndex ?? 0,
        });
      } else if (d.eventName === 'CurveSell') {
        out.push({
          curve,
          isBuy: false,
          trader: lower(d.args.recipient),
          quoteWei: d.args.quoteOut,
          tokensRaw: d.args.tokensIn,
          feeWei: d.args.fee,
          taxWei: d.args.tax,
          blockNumber: l.blockNumber ?? 0n,
          txHash: l.transactionHash ?? '0x',
          logIndex: l.logIndex ?? 0,
        });
      }
    } catch {
      /* a log this ABI does not describe */
    }
  }
  return out;
}


// ── Launching ─────────────────────────────────────────────────────────

export interface PonsLaunchRequest {
  name: string;
  symbol: string;
  /** Image URL. Stored on chain as a constructor argument — we host nothing. */
  image: string;
  website: string;
  twitter: string;
  telegram: string;
  /** Native to spend on the creator's own first buy. May be 0n. */
  quoteIn: bigint;
  minTokensOut: bigint;
  /** Creator fee, basis points. Pons pays this to the address below. */
  creatorTaxBps: number;
  creator: Address;
  /** 32 bytes of randomness; feeds the token's CREATE2 address. */
  salt: Hex;
}

export interface PonsLaunchCall {
  to: Address;
  data: Hex;
  /** quoteIn + the router's flat launch fee. */
  value: bigint;
}

/**
 * Build a `launchAndBuy` call.
 *
 * Pure: it reads nothing and signs nothing, so it can be unit-tested against a
 * real transaction — which is exactly what test/ponslaunch.test.mjs does. The
 * two fields with no user meaning (`unused0`, `unused1`) were zero on every
 * launch sampled and are sent as zero.
 */
export function buildLaunch(req: PonsLaunchRequest): PonsLaunchCall {
  const data = encodeFunctionData({
    abi: PONS_LAUNCH_ABI,
    functionName: 'launchAndBuy',
    args: [
      {
        name: req.name,
        symbol: req.symbol,
        image: req.image,
        website: req.website,
        socials: { twitter: req.twitter, telegram: req.telegram, extra1: '', extra2: '', extra3: '' },
        creatorFeeRecipient: req.creator,
        creatorTaxBps: req.creatorTaxBps,
        buyback: false,
        configId: PONS_LAUNCH_CONFIG_ID,
        salt: req.salt,
      },
      0n,
      '0x0000000000000000000000000000000000000000',
      req.quoteIn,
      req.minTokensOut,
      req.creator,
      [],
    ],
  });
  return { to: ADDR.ponsLaunchRouter as Address, data, value: req.quoteIn + PONS_LAUNCH_FEE_WEI };
}

/**
 * Ask the chain whether this launch would work, without signing anything.
 *
 * The app never builds a transaction it has not simulated, and a launch is the
 * least reversible thing it can do — a token exists forever. Returns the gas
 * the chain quoted, or the reason it refused, in its own words.
 */
export async function simulateLaunch(req: PonsLaunchRequest): Promise<{ gas: bigint } | { error: string }> {
  const call = buildLaunch(req);
  try {
    const gas = await client('robinhood').estimateGas({
      account: req.creator,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    return { gas };
  } catch (e) {
    return { error: shortError(e) };
  }
}
