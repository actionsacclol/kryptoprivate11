// EVM chains — the shared contract between main and the renderer.
//
// Two EVM chains ride the same rail (electron/evm/): Robinhood Chain (4663)
// and BNB Smart Chain (56). Both use ordinary secp256k1 keys, so ONE wallet
// list serves both — the same address on each — while balances, arm state,
// fills and positions are kept PER CHAIN. Everything here is renderer-safe:
// no viem, no node, just types, constants and pure helpers. Chain facts were
// verified against the live chains on 2026-09-08/09 — see
// docs/robinhood-chain-2026-09-08.md and docs/bnb-chain-2026-09-09.md.
//
// `shared/types.ts` stays the Solana engine contract and `shared/market.ts`
// the market contract; both are reused across chains (a TokenSummary row
// carries `chain`), and this file holds what is EVM-specific.

import { DEFAULT_EVM_RUNNER_ALERTS } from './evmRunners';
import type { ClosedTrade } from './portfolio';
import { resolveEvmTreasury, type EvmFeeIntegrityResult } from './evmFeeIntegrity';
import type { Launchpad } from './market';

// The chain kinds live in a leaf (shared/chainKind.ts) so that modules which
// need only the type - evmRunners.ts, which this file imports a default from
// - can have it without importing this one and closing a cycle. Re-exported
// here because 38 modules already import them from `@shared/evm` and there is
// no reason for any of them to change.
import {
  CHAIN_KINDS,
  EVM_CHAINS,
  isEvmChain,
  isChainKind,
  type ChainKind,
  type EvmChainKind,
} from './chainKind';

export { CHAIN_KINDS, EVM_CHAINS, isEvmChain, isChainKind, type ChainKind, type EvmChainKind };

export interface EvmChainMeta {
  kind: EvmChainKind;
  id: number;
  name: string;
  shortName: string;
  nativeSymbol: string;
  explorer: string;
  publicRpc: string;
  /** Typical block interval, ms. */
  blockMs: number;
  /** The chain's pump.fun. */
  launchpad: Launchpad;
  launchpadLabel: string;
  /** Provider slugs. */
  geckoNetwork: string;
  dexscreenerChain: string;
  /** Wrapped native token. */
  wrappedNative: string;
}

export const EVM_CHAIN_META: Record<EvmChainKind, EvmChainMeta> = {
  robinhood: {
    kind: 'robinhood',
    id: 4663,
    name: 'Robinhood Chain',
    shortName: 'Robinhood',
    nativeSymbol: 'ETH',
    explorer: 'https://robinhoodchain.blockscout.com',
    publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
    blockMs: 100,
    launchpad: 'pons',
    launchpadLabel: 'Pons',
    geckoNetwork: 'robinhood',
    dexscreenerChain: 'robinhood',
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  },
  bnb: {
    kind: 'bnb',
    id: 56,
    name: 'BNB Smart Chain',
    shortName: 'BNB',
    nativeSymbol: 'BNB',
    explorer: 'https://bscscan.com',
    publicRpc: 'https://bsc-rpc.publicnode.com',
    blockMs: 450,
    launchpad: 'fourmeme',
    launchpadLabel: 'four.meme',
    geckoNetwork: 'bsc',
    dexscreenerChain: 'bsc',
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
};

/**
 * The things the rail asks an endpoint to do. Named here (renderer-safe, no
 * URLs — the URLs live in electron/evm/chains.ts and never cross IPC) because
 * neither EVM chain has one free endpoint that does all six: on BNB the
 * dataseeds serve receipts but no logs, publicnode serves logs but no receipts,
 * and the archival endpoint serves both but no simulation. See
 * docs/api-swarm-2026-09-09.md §2.
 *
 *   receipts  — eth_getTransactionReceipt, polled after a broadcast
 *   state     — eth_getBalance / eth_call AT A PAST BLOCK (what prices a fill)
 *   logs      — eth_getLogs, the launch index and the trade scan
 *   simulate  — eth_simulateV1, the four.meme fill preview (optional: a
 *               refusal degrades the quote, it must never take an endpoint down)
 *   broadcast — eth_sendRawTransaction, never gated and never delayed
 *   ws        — eth_subscribe over WSS; '' where no endpoint offers one
 */
export type EvmRpcCapability = 'receipts' | 'state' | 'logs' | 'simulate' | 'broadcast' | 'ws';
export const EVM_RPC_CAPABILITIES: EvmRpcCapability[] = ['receipts', 'state', 'logs', 'simulate', 'broadcast', 'ws'];

export function nativeSymbolOf(chain: ChainKind): string {
  return chain === 'solana' ? 'SOL' : EVM_CHAIN_META[chain].nativeSymbol;
}

// Kept for the Robinhood-only callers written on 2026-09-08.
export const ROBINHOOD_CHAIN_ID = EVM_CHAIN_META.robinhood.id;
export const ROBINHOOD_NATIVE_SYMBOL = 'ETH';
export const ROBINHOOD_EXPLORER = EVM_CHAIN_META.robinhood.explorer;
export const ROBINHOOD_PUBLIC_RPC = EVM_CHAIN_META.robinhood.publicRpc;
export const BNB_CHAIN_ID = EVM_CHAIN_META.bnb.id;

/** Canonical assets. */
export const WETH_ADDRESS = EVM_CHAIN_META.robinhood.wrappedNative;
export const WBNB_ADDRESS = EVM_CHAIN_META.bnb.wrappedNative;
/** USDG on Robinhood Chain, 6 decimals. */
export const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
/** Native as a Uniswap v4 currency / Pons pair token / four.meme quote. */
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** True for a 20-byte hex address. A Solana mint is base58 and never
 *  matches. NOTE: an EVM address does not say WHICH EVM chain — the row or
 *  the selected chain does. */
export function isEvmAddress(s: unknown): s is string {
  return typeof s === 'string' && EVM_ADDRESS_RE.test(s);
}

/** Solana or "some EVM chain": the address alone cannot tell Robinhood from
 *  BNB, so callers pass the chain the row came from. */
export function chainOfAddress(s: string, evmDefault: EvmChainKind = 'robinhood'): ChainKind {
  return isEvmAddress(s) ? evmDefault : 'solana';
}

export function explorerTx(chain: EvmChainKind, hash: string): string {
  return `${EVM_CHAIN_META[chain].explorer}/tx/${hash}`;
}

export function explorerAddress(chain: EvmChainKind, addr: string): string {
  return `${EVM_CHAIN_META[chain].explorer}/address/${addr}`;
}

export function explorerToken(chain: EvmChainKind, addr: string): string {
  return `${EVM_CHAIN_META[chain].explorer}/token/${addr}`;
}

// ── Settings ──────────────────────────────────────────────────────────

export interface EvmChainSettings {
  /** Show this chain in the terminal at all. */
  enabled: boolean;
  /** Your own JSON-RPC endpoint. Empty = the public endpoint, or the keyed
   *  one when a key is set. Must be https. */
  rpcUrl: string;
  /** Provider key. Robinhood: an Alchemy key (free at alchemy.com), resolved
   *  to Alchemy's endpoint at the engine boundary. BNB: unused today — its
   *  public endpoints are generous; paste a full URL into rpcUrl instead. */
  apiKey: string;
  /**
   * Which of this chain's runner calls are worth a notification.
   *
   * Per chain, because the chains are not alike and are not meant to be: the
   * model behind these calls is each chain's own observed record, and a floor
   * that is right for Robinhood's traffic is not right for BNB's. Keeping
   * them separate is the same isolation the Observatory pages already have.
   */
  runnerAlerts: import('./evmRunners').EvmRunnerAlerts;
}

export interface EvmSettings {
  /** Slippage cap for a manual trade, percent (both EVM chains). */
  slippagePct: number;
  /** EVM address of whoever referred this user — the same address is the
   *  referrer on every EVM chain. Empty = nobody. */
  referrer: string;
  robinhood: EvmChainSettings;
  bnb: EvmChainSettings;
}

export const DEFAULT_EVM_SETTINGS: EvmSettings = {
  slippagePct: 5,
  referrer: '',
  robinhood: { enabled: true, rpcUrl: '', apiKey: '', runnerAlerts: { ...DEFAULT_EVM_RUNNER_ALERTS } },
  bnb: { enabled: true, rpcUrl: '', apiKey: '', runnerAlerts: { ...DEFAULT_EVM_RUNNER_ALERTS } },
};

/** Where the engine should actually connect for a chain. Key wins over URL
 *  wins over the public endpoint. Pure. */
export function resolveEvmRpcUrl(chain: EvmChainKind, cs: Pick<EvmChainSettings, 'rpcUrl' | 'apiKey'>): string {
  const key = (cs.apiKey ?? '').trim();
  if (key && chain === 'robinhood') return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  const url = (cs.rpcUrl ?? '').trim();
  if (/^https:\/\/[^\s/]+/.test(url)) return url;
  return EVM_CHAIN_META[chain].publicRpc;
}

/** Problems with an RPC URL a user typed, or null. */
export function evmRpcUrlProblem(url: string): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  if (!/^https:\/\//.test(u)) return 'RPC URL must start with https://';
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) return 'Put the key in the URL path or query, not as user:pass';
    return null;
  } catch {
    return 'Not a valid URL';
  }
}

// ── Fees ──────────────────────────────────────────────────────────────
//
// Same policy as Solana (shared/fees.ts): 0.5 % of every trade, both sides,
// 20 % of that to a referrer, paid in the same transaction wherever the
// venue lets us. One treasury address serves every EVM chain — an address is
// a key, not a chain.

export const EVM_FEE_BPS = 50;
export const EVM_REFERRAL_SHARE_BPS = 2000;
/** Below this the fee is skipped: dust costs more gas than it is worth. */
export const EVM_MIN_FEE_WEI = 1_000_000_000_000n; // 0.000001 native
/**
 * Krypt's EVM treasury (every EVM chain). Set 2026-09-08 (Krypt's call): a
 * plain key-controlled account with a valid EIP-55 checksum, verified on
 * Ethereum mainnet and Robinhood Chain. One wrong character here pays a
 * stranger forever, so `test/evmshared.test.mjs` pins this exact string.
 * Empty would disable fees entirely.
 */
export const EVM_TREASURY_ADDRESS = '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a';

export interface EvmFeeSplit {
  totalWei: bigint;
  treasuryWei: bigint;
  referrerWei: bigint;
}

export const ZERO_EVM_SPLIT: EvmFeeSplit = { totalWei: 0n, treasuryWei: 0n, referrerWei: 0n };

/**
 * The address the fee actually goes to — resolved through the integrity
 * layer, never the raw constant. Editing EVM_TREASURY_ADDRESS in a cracked
 * build does not change this; the canonical encoded copy wins. A corrupt
 * blob yields '' and fees switch off rather than paying an unverifiable
 * address. See evmFeeIntegrity.ts.
 */
export function activeEvmTreasury(): string {
  return resolveEvmTreasury(EVM_TREASURY_ADDRESS).treasury;
}

/** Tamper state, for logging and the buy-side interlock. */
export function evmTreasuryIntegrity(): EvmFeeIntegrityResult {
  return resolveEvmTreasury(EVM_TREASURY_ADDRESS);
}

export function evmFeesEnabled(): boolean {
  return isEvmAddress(activeEvmTreasury());
}

/** Split the fee on a trade of `basisWei` (native in for a buy, native out
 *  for a sell). The referrer's cut comes out of Krypt's share. `bps` is the
 *  rate: the ordinary one unless the caller says otherwise (a $KRYPTO holder
 *  pays half — shared/krypto.ts), and never MORE than the ordinary one. */
export function splitEvmFee(basisWei: bigint, hasReferrer: boolean, bps: number = EVM_FEE_BPS): EvmFeeSplit {
  if (!evmFeesEnabled() || basisWei <= 0n) return ZERO_EVM_SPLIT;
  const rate = Number.isFinite(bps) && bps > 0 && bps <= EVM_FEE_BPS ? Math.floor(bps) : EVM_FEE_BPS;
  const total = (basisWei * BigInt(rate)) / 10_000n;
  if (total < EVM_MIN_FEE_WEI) return ZERO_EVM_SPLIT;
  const referrer = hasReferrer ? (total * BigInt(EVM_REFERRAL_SHARE_BPS)) / 10_000n : 0n;
  return { totalWei: total, treasuryWei: total - referrer, referrerWei: referrer };
}

/** Why an EVM referrer address is unusable, or null when fine. */
export function evmReferralProblem(addr: string, ctx: { self: string | null }): string | null {
  const a = (addr ?? '').trim();
  if (!a) return null;
  if (!isEvmAddress(a)) return 'Not an EVM address (expect 0x + 40 hex characters)';
  if (ctx.self && a.toLowerCase() === ctx.self.toLowerCase()) return 'You cannot refer yourself';
  if (evmFeesEnabled() && a.toLowerCase() === activeEvmTreasury().toLowerCase()) return 'That is the treasury address';
  return null;
}

// ── Wallet ────────────────────────────────────────────────────────────

/** The active EVM wallet as seen from ONE chain: the address is shared, the
 *  balance is that chain's. */
export interface EvmWalletInfo {
  chain: EvmChainKind;
  nativeSymbol: string;
  exists: boolean;
  /** Checksummed 0x address — the same on every EVM chain. */
  address: string | null;
  balanceNative: number | null;
  balanceCheckedAt: number | null;
  encryptionAvailable: boolean;
  createdAt: number | null;
  id: string | null;
  label: string | null;
  walletCount: number;
  /** Set when evm-wallets.json exists but could not be read this session:
   *  the store then serves nothing and refuses every write (fail closed), and
   *  the UI must say so instead of "no wallet". */
  failure: string | null;
}

export interface EvmWalletSummary {
  id: string;
  label: string;
  address: string;
  active: boolean;
  /** Balance on the chain the list was asked for. */
  balanceNative: number | null;
  balanceCheckedAt: number | null;
  createdAt: number;
  /**
   * The chain this wallet was made for — the page that made it. Null for a
   * wallet from before the chains were split (2026-09-11), which belongs to
   * both: it was used on both and may hold funds on both.
   */
  createdFor: EvmChainKind | null;
}

/**
 * Which wallets a chain's page lists: the ones made for it, the pre-split
 * ones, and whatever signs on it right now (so a chain can never be signing
 * with a wallet its own page does not show). A wallet made for the OTHER
 * chain stays on that chain's page — same address on both, but the user
 * made it for one of them, and "BNB Wallet shows my Robinhood wallets" was
 * the complaint this answers.
 */
export function walletVisibleOn(w: Pick<EvmWalletSummary, 'active' | 'createdFor'>, chain: EvmChainKind): boolean {
  return w.active || w.createdFor === null || w.createdFor === chain;
}

/** Arm state is PER CHAIN: going live on BNB does not go live on Robinhood. */
export interface EvmLiveState {
  chain: EvmChainKind;
  armed: boolean;
  armedAt: number | null;
  lastDisarmReason: 'user' | 'no_wallet' | 'wallet_removed' | 'restart' | 'kill_switch' | 'chain_disabled' | null;
}

// ── Venues and quotes ─────────────────────────────────────────────────

/** Where a token's liquidity is, as far as this version can route it. */
export type EvmVenue =
  | 'pons-curve'     // Robinhood · Pons V2 curve, pre-graduation — direct buy/sell
  | 'pons-v4'        // Robinhood · graduated Pons launch: Uniswap v4 pool + Pons hook
  | 'uniswap-v3'     // Robinhood · a v3 pool against WETH
  | 'fourmeme-curve' // BNB · four.meme curve, pre-graduation — TokenManager2 buy/sell
  | 'pancake-v2'     // BNB · PancakeSwap v2 pair against WBNB (where four.meme graduates)
  | 'pancake-v3'     // BNB · PancakeSwap v3 pool against WBNB
  | 'unknown';       // listed somewhere this version cannot route

/**
 * The least slippage an EVM SELL is ever sent with, whatever was typed.
 *
 * Same rule as Solana's exits: a sell refused over a tight cap is the trap
 * the order engine exists to avoid, so the wider of the setting and this
 * floor is what the transaction carries. Named here so the Swap page can
 * say so next to the field instead of quietly sending something else.
 */
export const SELL_SLIPPAGE_FLOOR_PCT = 15;

export const VENUE_LABEL: Record<EvmVenue, string> = {
  'pons-curve': 'Pons curve',
  'pons-v4': 'Uniswap v4 (Pons pool)',
  'uniswap-v3': 'Uniswap v3',
  'fourmeme-curve': 'four.meme curve',
  'pancake-v2': 'PancakeSwap v2',
  'pancake-v3': 'PancakeSwap v3',
  unknown: 'not routable',
};

export interface EvmCurveState {
  address: string;
  /** Real quote in the curve, wei of the pair token. */
  realQuoteWei: string;
  thresholdWei: string;
  /** 0..100 toward graduation. 100 once graduated. */
  progressPct: number;
  graduated: boolean;
  readyToGraduate: boolean;
  feeBps: number;
  creatorTaxBps: number;
  /** Pair / quote token address; NATIVE_ADDRESS for the chain's native coin. */
  pairToken: string;
  isNativeQuote: boolean;
  /** Marginal price in pair-token units per whole token. */
  priceQuote: number | null;
  sellableTokens: string;
  tokenReserve: string;
  quoteReserve: string;
}

export interface EvmPoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface EvmTokenState {
  chain: EvmChainKind;
  address: string;
  venue: EvmVenue;
  /** Present for launchpad tokens (Pons V2, four.meme), whichever phase. */
  curve: EvmCurveState | null;
  /** Present once routable on a pool. */
  pool: { address: string | null; dexId: string; key: EvmPoolKey | null; feeTier: number | null } | null;
  launch: { deployer: string | null; phase: number; launchedAt: number | null } | null;
  decimals: number;
  totalSupply: string | null;
  /** Why the token cannot be traded here, if it cannot. */
  untradable: string | null;
}

export interface EvmTokenDetail {
  summary: import('./market').TokenSummary;
  state: EvmTokenState;
  pools: import('./market').TokenPool[];
  holders: { count: number | null; top10Pct: number | null } | null;
  warnings: string[];
}

export interface EvmQuote {
  chain: EvmChainKind;
  side: 'buy' | 'sell';
  token: string;
  venue: EvmVenue;
  /** Wei of native in (buy) or raw token units in (sell). */
  amountIn: string;
  /** Raw token units out (buy) or wei out (sell), before slippage. */
  amountOut: string;
  minOut: string;
  slippagePct: number;
  /** Krypt fee on this trade, wei. */
  feeWei: string;
  /**
   * Where that fee is taken, because "0.5 %" alone left the user to guess:
   * 'on-top'  — added to the value of the buy (1 BNB typed spends 1.005);
   * 'follows' — sent as a second transaction after the buy lands (four.meme);
   * 'inside'  — taken out of a sell's proceeds, so `amountOut` is already net.
   * Found by audit 2026-09-11: every EVM swap said "inside", which was true
   * of none of the buys.
   */
  feeBasis: 'on-top' | 'follows' | 'inside';
  gasEstimate: string | null;
  gasCostWei: string | null;
  /** True when the number came from an eth_call of the real calldata (or the
   *  launchpad's own quoting contract), not a formula. */
  simulated: boolean;
  /** Effective price, native per whole token. */
  priceNative: number | null;
  /** Approvals a sell still needs before it can go (0, 1 or 2 transactions). */
  approvalsNeeded: number;
  note: string | null;
}

/** 'pending' = broadcast but no receipt within the wait — recorded on the
 *  ledger as pending and reconciled later, NOT a failure (the Solana signer's
 *  'pending' stage, same meaning). */
export type EvmTradeStage = 'route' | 'quote' | 'build' | 'policy' | 'simulate' | 'approve' | 'sign' | 'send' | 'confirm' | 'pending' | 'fee' | 'done';

export interface EvmTradeResult {
  ok: boolean;
  chain: EvmChainKind;
  stage: EvmTradeStage;
  message: string;
  hash: string | null;
  venue: EvmVenue | null;
  quote: EvmQuote | null;
  amountIn: string | null;
  amountOut: string | null;
  gasUsed: string | null;
  /** The separate fee transfer for curve trades, when one was sent. */
  feeHash: string | null;
  simulated: boolean;
  timing: { totalMs: number; buildMs: number | null; simulateMs: number | null; sendMs: number | null; confirmMs: number | null };
}

// ── Ledger and portfolio ──────────────────────────────────────────────

export interface EvmFill {
  id: string;
  chain: EvmChainKind;
  token: string;
  symbol: string;
  side: 'buy' | 'sell';
  at: number;
  hash: string;
  /** Native for a buy, percent for a sell. */
  requested: number;
  /** Net wei the wallet lost (buy) or gained (sell), gas included, from the
   *  chain. Negative means native left the wallet. Null until reconciled. */
  nativeDeltaWei: string | null;
  tokenDeltaRaw: string | null;
  decimals: number | null;
  gasWei: string | null;
  /** Krypt fee paid in this tx — the curve fee tx is its own row. */
  feeWei: string | null;
  state: 'pending' | 'reconciled' | 'unreconciled';
  note: string | null;
  wallet: string;
  venue: EvmVenue;
  attempts?: number;
}

export interface EvmHolding {
  chain: EvmChainKind;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  raw: string;
  amount: number;
  priceNative: number | null;
  valueNative: number | null;
  valueSource: 'quote' | 'spot' | null;
  venue: EvmVenue;
}

export interface EvmPosition extends EvmHolding {
  basisKnown: boolean;
  costNative: number | null;
  avgEntryPriceNative: number | null;
  unrealizedPnlNative: number | null;
  unrealizedPnlPct: number | null;
  realizedPnlNative: number | null;
  firstBuyAt: number | null;
  lastFillAt: number | null;
  unreconciledFills: number;
}

export interface EvmPortfolio {
  chain: EvmChainKind;
  nativeSymbol: string;
  address: string | null;
  nativeBalance: number | null;
  nativeUsd: number | null;
  positions: EvmPosition[];
  realizedPnlNative: number | null;
  unrealizedPnlNative: number | null;
  gasPaidNative: number | null;
  feesPaidNative: number | null;
  fills: number;
  unreconciled: number;
  generatedAt: number;
}

/** What the renderer asks the rail for, per chain. */
export interface EvmState {
  chain: EvmChainKind;
  nativeSymbol: string;
  enabled: boolean;
  wallet: EvmWalletInfo;
  live: EvmLiveState;
  rpcHost: string;
  usingKeyedRpc: boolean;
  /** 'rejected' = the keyed endpoint answered 401/403 and the rail is on
   *  the public endpoint for a while; 'rate-limited' = a 429 in the last
   *  minute. Rendered by the settings card so a bad key is never "unreachable". */
  rpcStatus: 'ok' | 'rate-limited' | 'rejected' | 'unreachable';
  feesEnabled: boolean;
  head: { block: number; at: number } | null;
  /** Native/USD when a provider answered. */
  nativeUsd: number | null;
}

// ── Formatting helpers (pure) ─────────────────────────────────────────

export const WEI = 1_000_000_000_000_000_000n;

export function weiToEth(wei: bigint | string): number {
  const w = typeof wei === 'string' ? BigInt(wei) : wei;
  const whole = w / WEI;
  const frac = w % WEI;
  return Number(whole) + Number(frac) / 1e18;
}

export function ethToWei(eth: number): bigint {
  if (!Number.isFinite(eth) || eth <= 0) return 0n;
  return BigInt(Math.round(eth * 1e12)) * 1_000_000n;
}

export function rawToAmount(raw: bigint | string, decimals: number): number {
  const r = typeof raw === 'string' ? BigInt(raw) : raw;
  const d = BigInt(Math.max(0, Math.min(36, decimals)));
  const unit = 10n ** d;
  return Number(r / unit) + Number(r % unit) / Number(unit);
}

/** Percent of `raw` as raw units, floored. 100 → all of it. */
export function portionRaw(raw: bigint, pct: number): bigint {
  const p = Math.max(0, Math.min(100, pct));
  if (p >= 100) return raw;
  return (raw * BigInt(Math.round(p * 100))) / 10_000n;
}

/** `amountOut × (1 − slippage)`, floored. */
export function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.round(Math.max(0, Math.min(100, slippagePct)) * 100));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/** Bonding-curve progress from real quote vs threshold, 0..100. */
export function curveProgressPct(realQuoteWei: bigint, thresholdWei: bigint, graduated: boolean): number {
  if (graduated) return 100;
  if (thresholdWei <= 0n) return 0;
  const pct = Number((realQuoteWei * 10_000n) / thresholdWei) / 100;
  return Math.max(0, Math.min(99.99, pct));
}

// ── Round trips from fills ─────────────────────────────────────────────────

/**
 * The rail's fills folded into closed round trips, in the SAME shape the
 * Solana ledger produces (`ClosedTrade`), so the Trades page's rows, share
 * card and candle replay work on Robinhood Chain and BNB unchanged — the
 * "Sol" fields carry the chain's own coin, and the page labels them so.
 *
 * A trip opens on the first buy of a token the wallet was flat in and closes
 * when the fills' token deltas bring it back to flat (within a dust of
 * 0.1 % of what was bought). The cost is the wallet's net native change on
 * the buys, gas included, and the proceeds the net change on the sells —
 * the chain's numbers, never the amounts asked for (house rule). A trip with
 * any fill the chain has not answered for yet is left OUT rather than
 * counted with a guessed leg; the fills table still lists it.
 */
export function evmClosedTrips(fills: EvmFill[]): ClosedTrade[] {
  const byToken = new Map<string, EvmFill[]>();
  for (const f of fills) {
    const k = f.token.toLowerCase();
    const arr = byToken.get(k) ?? [];
    arr.push(f);
    byToken.set(k, arr);
  }
  const out: ClosedTrade[] = [];
  for (const [token, list] of byToken) {
    list.sort((a, b) => a.at - b.at);
    let trip: {
      firstAt: number;
      lastAt: number;
      spent: number;
      received: number;
      bought: bigint;
      sold: bigint;
      held: bigint;
      buys: number;
      sells: number;
      decimals: number | null;
      symbol: string;
      unreadable: number;
    } | null = null;
    for (const f of list) {
      const tokenDelta = f.tokenDeltaRaw === null ? null : BigInt(f.tokenDeltaRaw);
      const native = f.nativeDeltaWei === null ? null : Number(BigInt(f.nativeDeltaWei)) / 1e18;
      if (f.side === 'buy' && trip === null) {
        trip = { firstAt: f.at, lastAt: f.at, spent: 0, received: 0, bought: 0n, sold: 0n, held: 0n, buys: 0, sells: 0, decimals: f.decimals, symbol: f.symbol, unreadable: 0 };
      }
      if (trip === null) continue; // a sell before any buy: a bag from elsewhere, not a trip
      trip.lastAt = f.at;
      if (f.symbol && !trip.symbol) trip.symbol = f.symbol;
      if (trip.decimals === null && f.decimals !== null) trip.decimals = f.decimals;
      if (tokenDelta === null || native === null || f.state !== 'reconciled') trip.unreadable += 1;
      if (f.side === 'buy') {
        trip.buys += 1;
        if (native !== null) trip.spent += Math.max(0, -native);
        if (tokenDelta !== null) {
          trip.bought += tokenDelta > 0n ? tokenDelta : 0n;
          trip.held += tokenDelta;
        }
      } else {
        trip.sells += 1;
        if (native !== null) trip.received += Math.max(0, native);
        if (tokenDelta !== null) {
          trip.sold += tokenDelta < 0n ? -tokenDelta : 0n;
          trip.held += tokenDelta;
        }
        const dust = trip.bought / 1000n;
        if (trip.held <= dust) {
          if (trip.unreadable === 0 && trip.spent > 0 && trip.decimals !== null) {
            const scale = 10 ** trip.decimals;
            const tokensBought = Number(trip.bought) / scale;
            const tokensSold = Number(trip.sold) / scale;
            const pnl = trip.received - trip.spent;
            out.push({
              mint: token,
              symbol: trip.symbol || token.slice(0, 8),
              openedAt: trip.firstAt,
              closedAt: trip.lastAt,
              costSol: trip.spent,
              proceedsSol: trip.received,
              pnlSol: pnl,
              pnlPct: (pnl / trip.spent) * 100,
              holdMs: trip.lastAt - trip.firstAt,
              tokensBought,
              tokensSold,
              entryPriceSol: tokensBought > 0 ? trip.spent / tokensBought : null,
              exitPriceSol: tokensSold > 0 ? trip.received / tokensSold : null,
              buys: trip.buys,
              sells: trip.sells,
            });
          }
          trip = null;
        }
      }
    }
  }
  out.sort((a, b) => b.closedAt - a.closedAt);
  return out;
}
