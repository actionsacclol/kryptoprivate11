// BNB Smart Chain — addresses, ABIs and event topics the rail depends on.
//
// Every address here was read back from the live chain on 2026-09-09
// (eth_getCode non-empty; four.meme buys and PancakeSwap quotes simulated).
// Sources: the four-flap-meme-sdk address table (four.meme, Helper3),
// PancakeSwap's developer docs (v2, v3, Universal Router 2, its own Permit2),
// and the chain itself for event topics. A wrong character here sends a
// user's money to a stranger, so `test/evmbsc.test.mjs` pins every entry.
//
// four.meme in one paragraph: `TokenManager2` (a proxy) creates tokens and
// runs their bonding curves; 1,000,000,000 supply of which 800,000,000 are
// sold on the curve; BNB-quoted launches graduate at 18 BNB (`maxFunds`) into
// a PancakeSwap v2 pair; a 1 % trading fee (`tradingFeeRate` 100) per fill.
// Many launches are quoted in other tokens (USDT, tokenised stocks) — the
// rail trades the BNB-quoted ones and shows the rest. `TokenManagerHelper3`
// answers quotes on chain (`tryBuy` / `trySell` / `getTokenInfo`), which is
// why there is no curve formula in this file. Sells accept a third-party
// fee natively (`sellToken(..., feeRate, feeRecipient)`); buys do not, so a
// buy's platform fee follows as its own transfer until a BNB curve router
// is deployed. ~20 launches a minute measured.

import { defineChain, parseAbi, type Address, type Hex } from 'viem';
import { EVM_CHAIN_META, NATIVE_ADDRESS, WBNB_ADDRESS } from '@shared/evm';

export const ADDR_BSC = {
  native: NATIVE_ADDRESS as Address,
  wbnb: WBNB_ADDRESS as Address,
  usdt: '0x55d398326f99059fF775485246999027B3197955' as Address,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address,
  /** PancakeSwap's OWN Permit2 — Universal Router 2 pulls through it, not
   *  through Uniswap's canonical deployment (which also exists here). */
  permit2: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768' as Address,
  /** Universal Router 2 (Infinity): v2 + v3 + stable + Infinity. Same command
   *  bytes as Uniswap's router for everything this rail uses. */
  universalRouter: '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB' as Address,
  v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as Address,
  v2Factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as Address,
  v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address,
  v3QuoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address,
  v3SmartRouter: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as Address,
  /** four.meme TokenManager2 proxy — creates tokens, runs the curves, emits
   *  every trade event. */
  fourMemeManager: '0x5c952063c7fc8610FFDB798152D69F0B9550762b' as Address,
  /** four.meme TokenManagerHelper3 — on-chain quotes and token info. */
  fourMemeHelper: '0xF251F83e40a78868FcfA3FA4599Dad6494E46034' as Address,
  /** Krypt's curve router for four.meme buys — not deployed yet. */
  kryptRouter: '' as Address | '',
} as const;

/** PancakeSwap v3 fee tiers to probe when a token's pool is unknown. */
export const PANCAKE_V3_FEE_TIERS = [10_000, 2_500, 500, 100] as const;

export const BSC = defineChain({
  id: EVM_CHAIN_META.bnb.id,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [EVM_CHAIN_META.bnb.publicRpc] } },
  blockExplorers: { default: { name: 'BscScan', url: EVM_CHAIN_META.bnb.explorer } },
  contracts: { multicall3: { address: ADDR_BSC.multicall3 } },
});

// ── four.meme ABIs ────────────────────────────────────────────────────

export const FOURMEME_MANAGER_ABI = parseAbi([
  // Buy "as much as possible" with `funds` of the quote (msg.value for BNB).
  'function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable',
  'function buyTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
  'function sellToken(address token, uint256 amount, uint256 minFunds)',
  // Third-party fee on a sell: `feeRate` in bps of 10,000, paid to `feeRecipient`.
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)',
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
  'event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
  'event TokenSale(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds)',
]);

export const FOURMEME_HELPER_ABI = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
  'function getPancakePair(address token) view returns (address)',
]);

export const PANCAKE_V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

export const PANCAKE_V2_FACTORY_ABI = parseAbi(['function getPair(address tokenA, address tokenB) view returns (address pair)']);

export const PANCAKE_V2_PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/** four.meme launch supply, 18 decimals; 800,000,000 of it sold on the curve. */
export const FOURMEME_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const FOURMEME_CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

// ── Event topics, as read from the chain (2026-09-09) ────────────────

export const TOPIC_BSC = {
  tokenCreate: '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20' as Hex,
  tokenPurchase: '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942' as Hex,
  tokenSale: '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19' as Hex,
} as const;

/** Function selectors the signing policy allows on BNB targets. */
export const SELECTOR_BSC = {
  fourMemeBuy: '0x87f27655' as Hex, // buyTokenAMAP(address,uint256,uint256)
  fourMemeBuyTo: '0x5e56c39a' as Hex, // buyTokenAMAP(uint256,address,address,uint256,uint256)
  fourMemeSell: '0x3e11741f' as Hex, // sellToken(address,uint256,uint256)
  fourMemeSellWithFee: '0x06e7b98f' as Hex, // sellToken(uint256,address,uint256,uint256,uint256,address)
} as const;
