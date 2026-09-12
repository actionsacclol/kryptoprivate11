// Swapping one token for another, from Wallet Utilities.
//
// The app has always swapped — every buy and every sell is a Jupiter route
// across whatever DEX has the liquidity. What it could not do was swap
// without SOL on one side, so cashing a bag out to USDC meant two trades and
// two fees: token to SOL, then SOL to USDC.
//
// This is the same routing with both mints free. It is deliberately NOT a
// trade: it books no position, it has no PnL, and it does not touch the
// strategy or the ledger's cost basis. It moves what you hold from one thing
// to another, which is what a wallet utility is for.
//
// ─── Why it needs no new signing rule ────────────────────────────────────
//
// To the signing policy a swap IS a sell of the input mint. The input leaves
// our token account — permitted on a sell of the traded mint, into an
// account the route itself names — and the output merely arrives, which
// needs no permission because nothing of ours moves out. Every existing
// refusal stays exactly as strict as it was, which is the reason this could
// be built without widening the one file that decides whether money moves.

import { EVM_CHAIN_META, NATIVE_ADDRESS, type EvmChainKind } from './evm';

/** Wrapped SOL. Native SOL is wrapped and unwrapped by the route itself. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Every chain the swapper works on. */
export type SwapChain = 'solana' | EvmChainKind;

export const SWAP_CHAINS: SwapChain[] = ['solana', 'robinhood', 'bnb'];

/**
 * What each chain's swapper can actually route — and this differs, so the
 * page says so rather than offering a control that fails.
 *
 * SOLANA is 'any': Jupiter routes any mint to any other, so a bag goes
 * straight to a stablecoin in one transaction.
 *
 * The EVM chains are 'native-pair': their rail builds native-to-token and
 * token-to-native calls and nothing else (`buildV3Buy` / `buildV3Sell` and
 * their v2 and v4 siblings all take ONE token and assume the native coin on
 * the other side). Routing USDT straight to some other BEP-20 would mean a
 * new multi-hop path builder on each venue — real work, and work that cannot
 * be verified without funds on those chains. So one side is the native coin,
 * which covers cashing a bag out and buying in, and the page is honest about
 * the rest rather than pretending.
 */
export type SwapAbility = 'any' | 'native-pair';

export const SWAP_ABILITY: Record<SwapChain, SwapAbility> = {
  solana: 'any',
  robinhood: 'native-pair',
  bnb: 'native-pair',
};

/**
 * Tokens offered by name in the picker.
 *
 * A short, hardcoded list of things people actually swap to, so the common
 * case is two clicks. Anything else is reachable by pasting a mint — the list
 * is a convenience, never a restriction, and never a recommendation.
 */
export interface KnownMint {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * The tokens each chain offers by name.
 *
 * Every EVM entry was read off its own chain on 2026-09-11 — symbol and
 * decimals from the contract, not from memory. That check earned its keep
 * immediately: BSC's USDT and USDC are EIGHTEEN decimals, not the six they
 * are on most chains, and assuming six would have sized every swap a
 * trillion times wrong.
 */
export const KNOWN_MINTS: Record<SwapChain, KnownMint[]> = {
  solana: [
    { mint: WSOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9 },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether', decimals: 6 },
  ],
  robinhood: [
    { mint: NATIVE_ADDRESS, symbol: 'ETH', name: 'Ether', decimals: 18 },
    { mint: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  ],
  bnb: [
    { mint: NATIVE_ADDRESS, symbol: 'BNB', name: 'BNB', decimals: 18 },
    { mint: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether', decimals: 18 },
    { mint: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
  ],
};

/** The coin that pays for gas, and the one side an EVM swap must include. */
export function nativeOf(chain: SwapChain): string {
  return chain === 'solana' ? WSOL_MINT : NATIVE_ADDRESS;
}

export function nativeSymbol(chain: SwapChain): string {
  return chain === 'solana' ? 'SOL' : EVM_CHAIN_META[chain].nativeSymbol;
}

export const isKnownMint = (chain: SwapChain, mint: string): KnownMint | null =>
  KNOWN_MINTS[chain].find((m) => m.mint.toLowerCase() === mint.toLowerCase()) ?? null;

/** Solana mints are base58; EVM tokens are 0x + 40 hex. Shape only. */
export function looksLikeMint(chain: SwapChain, v: string): boolean {
  const t = (v ?? '').trim();
  return chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) : /^0x[0-9a-fA-F]{40}$/.test(t);
}

/**
 * Slippage bounds for a swap.
 *
 * Wider at the top than a trade's default because a swapper is used on
 * illiquid bags a trade panel would never touch — and tighter at the bottom
 * than zero, because a 0 % swap is a swap that never lands.
 */
export const MIN_SLIPPAGE_PCT = 0.1;
export const MAX_SLIPPAGE_PCT = 50;
export const DEFAULT_SLIPPAGE_PCT = 1;

/**
 * How hard to push the transaction through.
 *
 * ─── What this does and does NOT change ─────────────────────────────────
 *
 * It buys BLOCK POSITION, nothing else. A faster preset does not get a
 * better price, a better route or less slippage; it makes the transaction
 * more likely to land promptly when the network is busy. On a quiet chain
 * all three behave identically and the cheapest one is simply correct.
 *
 * The numbers behind them are MEASURED, not invented: each maps to a
 * percentile of what other transactions are actually paying right now
 * (feeEstimator reads p50/p75/p90 from Helius or the RPC), so "fast" means
 * "above 90 % of current bids", not a number somebody liked the look of.
 */
export type SwapSpeed = 'cheap' | 'normal' | 'fast';

export const SWAP_SPEEDS: SwapSpeed[] = ['cheap', 'normal', 'fast'];

export const SPEED_LABEL: Record<SwapSpeed, string> = {
  cheap: 'Cheapest',
  normal: 'Normal',
  fast: 'Fast',
};

export const SPEED_BLURB: Record<SwapSpeed, string> = {
  cheap: 'Pays what half the network pays. Fine when nothing is congested; may sit for a while when it is.',
  normal: 'Above three quarters of current bids. The sensible default.',
  fast: 'Above nine tenths of current bids. Costs more and lands sooner when the chain is busy — it does not get you a better price.',
};

/**
 * The percentile each preset buys, as the fee estimator names them.
 *
 * `emergency` (p95) is deliberately absent: it exists for getting OUT of a
 * position under pressure, and a swap from a wallet page is not that.
 */
export const SPEED_URGENCY: Record<SwapSpeed, 'normal' | 'competitive' | 'high'> = {
  cheap: 'normal',
  normal: 'competitive',
  fast: 'high',
};

/**
 * Compute units a Jupiter route is budgeted at for the priority CEILING.
 *
 * Jupiter sets the real limit itself (`dynamicComputeUnitLimit`); this only
 * turns a measured price-per-unit into the lamport cap we hand it, and the
 * cap is a ceiling rather than a charge — unconsumed units are not paid for.
 * 300k is the order of magnitude of a multi-hop route; a single hop uses far
 * less and therefore costs far less than the number shown.
 */
export const SWAP_CU_BUDGET = 300_000;

/** Lamport ceiling for a preset, from a measured micro-lamports-per-CU. */
export function priorityCapLamports(microLamportsPerCu: number): number {
  if (!Number.isFinite(microLamportsPerCu) || microLamportsPerCu <= 0) return 0;
  return Math.round((microLamportsPerCu * SWAP_CU_BUDGET) / 1e6);
}

export interface SwapDraft {
  chain: SwapChain;
  inputMint: string;
  outputMint: string;
  /** Human units of the INPUT token, as typed. */
  amount: number;
  slippagePct: number;
  speed: SwapSpeed;
}

export function emptyDraft(chain: SwapChain = 'solana'): SwapDraft {
  const known = KNOWN_MINTS[chain];
  return {
    chain,
    inputMint: nativeOf(chain),
    outputMint: known[1]?.mint ?? '',
    amount: 0,
    slippagePct: DEFAULT_SLIPPAGE_PCT,
    speed: 'normal',
  };
}

/**
 * Everything wrong with this swap, in the order a person would fix it.
 *
 * Used on BOTH sides of the IPC boundary: the card greys out its button with
 * this, and the main process refuses with the same function, so "the button
 * was enabled" can never mean something different from "main will accept it".
 */
export function swapProblems(d: SwapDraft, heldAmount: number | null): string[] {
  const out: string[] = [];
  if (!SWAP_CHAINS.includes(d.chain)) return ['Pick a chain.'];
  const native = nativeOf(d.chain);
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (!looksLikeMint(d.chain, d.inputMint)) out.push('Choose what to swap from.');
  if (!looksLikeMint(d.chain, d.outputMint)) out.push('Choose what to swap to.');
  if (d.inputMint && same(d.inputMint, d.outputMint)) out.push('Pick two different tokens.');
  // The EVM rail builds native-to-token and token-to-native calls and nothing
  // else. Refusing here is the honest thing: the alternative is a control
  // that looks available and fails at the router.
  else if (
    SWAP_ABILITY[d.chain] === 'native-pair' &&
    d.inputMint &&
    d.outputMint &&
    !same(d.inputMint, native) &&
    !same(d.outputMint, native)
  ) {
    out.push(`On ${nativeSymbol(d.chain)} one side has to be ${nativeSymbol(d.chain)} itself — token-to-token is not routed on this chain yet.`);
  }
  if (!Number.isFinite(d.amount) || d.amount <= 0) out.push('Enter an amount.');
  // A null balance is UNKNOWN, not zero: an unreadable balance must never be
  // reported as "you do not hold that", and the chain refuses a swap it
  // cannot cover anyway.
  else if (heldAmount !== null && d.amount > heldAmount) out.push('That is more than you hold.');
  if (!Number.isFinite(d.slippagePct) || d.slippagePct < MIN_SLIPPAGE_PCT || d.slippagePct > MAX_SLIPPAGE_PCT) {
    out.push(`Slippage must be between ${MIN_SLIPPAGE_PCT}% and ${MAX_SLIPPAGE_PCT}%.`);
  }
  if (!SWAP_SPEEDS.includes(d.speed)) out.push('Pick a speed.');
  return out;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  /** Base units in and out, as strings — these are u64s. */
  inAmountRaw: string;
  outAmountRaw: string;
  inDecimals: number;
  /** Null when the output token's precision could not be established. The
   *  card then shows a dash — never a number off by a power of ten. */
  outDecimals: number | null;
  /** DEX labels on the route. */
  route: string[];
  /** Percent, when the quote reported one. Null is unknown, never 0. */
  priceImpactPct: number | null;
  /**
   * What the platform fee will be, in lamports, and what it was charged on.
   *
   * `basis` says where the number came from rather than leaving the user to
   * assume: 'sol-leg' when SOL is one side of the swap, 'quoted' when neither
   * side is SOL and the input had to be priced in SOL separately, and
   * 'unpriced' when it could not be priced at all — in which case the fee is
   * zero, because a fee this app cannot justify is one it does not charge.
   */
  feeLamports: number;
  /**
   * 'inside' is the EVM rail: it charges its own 0.5 % within the trade, on
   * the native leg, so there is no separate number to show — but "none"
   * would be a lie, and that is what the card said until 2026-09-11.
   */
  feeBasis: 'sol-leg' | 'quoted' | 'unpriced' | 'inside' | 'on-top' | 'follows';
  /** The fee in the chain's own coin, when the rail priced it (EVM). */
  feeNative: number | null;
  /**
   * The slippage the transaction will CARRY, which can be wider than what
   * was typed: EVM sells never go under SELL_SLIPPAGE_FLOOR_PCT. The card
   * says so when the two differ, rather than sending something it did not show.
   */
  appliedSlippagePct: number;
  /**
   * Priority ceiling for the chosen speed, and what every speed would cost,
   * so the picker can show real numbers instead of three adjectives.
   *
   * These are network fees paid to validators — not to us. `source` says
   * whether they came from a live read or from the estimator's fallback,
   * because a fallback number is a guess and should not be dressed as a
   * measurement.
   */
  priorityLamports: number;
  priorityBySpeed: Record<SwapSpeed, number>;
  prioritySource: 'helius' | 'rpc' | 'fallback';
}

/** Human units from base units, without going through a float exponent. */
export function fromRaw(raw: string, decimals: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

/**
 * Base units from human units. Rounds DOWN — never spend more than typed.
 *
 * Two float traps, and the fix has to clear both:
 *
 *  · a plain multiply overshoots — `0.1 * 1e9` is 100000000.00000001, and a
 *    swap that asks for one lamport MORE than the user typed fails at the
 *    worst possible moment, on a max-balance swap;
 *  · but plain truncation undershoots for the same reason — 8.7 is stored as
 *    8.69999999999999964, which truncates to 8.699999999.
 *
 * So: round at a few digits BEYOND the token's precision, which absorbs the
 * representation error, then truncate to the precision itself. 8.7 becomes
 * exactly 8.700000000 and 1.9999999999 becomes 1.999999, both right.
 */
export function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  // Snap to the 15 significant digits a double actually carries, THEN
  // truncate. Rounding at a fixed offset from `decimals` cannot work: for
  // 8.7 it has to round (the stored value is below), and for 1.9999999999 it
  // must not (rounding at the 9th place would carry it to 2). Fifteen
  // significant digits is the line between representation error and a digit
  // the user actually typed.
  const intDigits = Math.max(1, Math.floor(Math.log10(amount)) + 1);
  const places = Math.max(decimals, Math.min(20, 15 - intDigits));
  const [whole, frac = ''] = amount.toFixed(places).split('.');
  const kept = frac.slice(0, decimals);
  return BigInt(`${whole}${kept.padEnd(decimals, '0')}` || '0');
}
