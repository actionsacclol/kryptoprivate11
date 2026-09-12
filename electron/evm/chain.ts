// Robinhood Chain — addresses, ABIs and event topics the rail depends on.
//
// Every address and topic here was read back from the live chain on
// 2026-09-08 (eth_getCode non-empty, logs decoded, quotes and swaps
// simulated with estimateGas) — see docs/robinhood-chain-2026-09-08.md.
// Sources: docs.robinhood.com/chain (RPC, explorer), Uniswap's deployment
// tables for chain 4663 (v3 + v4 + Universal Router), docs.ponsfamily.com/v2
// and the ponsdotdev/ponsfamily repo (Pons), Bags' integration notes (the
// Universal Router's extra `minHopPriceX36` swap-param field).
//
// This file is the ONLY place a contract address is written. A wrong
// character here sends a user's money to a stranger, so the addresses are
// pinned by test/evmchain.test.mjs against what the chain answered.

import { defineChain, parseAbi, type Address, type Hex } from 'viem';
import {
  NATIVE_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER,
  ROBINHOOD_PUBLIC_RPC,
  USDG_ADDRESS,
  WETH_ADDRESS,
} from '@shared/evm';

export const ADDR = {
  native: NATIVE_ADDRESS as Address,
  weth: WETH_ADDRESS as Address,
  usdg: USDG_ADDRESS as Address,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  /** Universal Router — v3 + v4 entrypoint. Bags reports it as a modified
   *  build whose v4 exact-in params carry a `minHopPriceX36` word; both the
   *  stock and the extended encodings simulated fine, and every trade is
   *  simulated before it is signed anyway. */
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as Address,
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address,
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address,
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
  v3QuoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address,
  v3SwapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Address,
  /** Pons V2 — live since 2026-08-04; every current launch goes through it. */
  ponsFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' as Address,
  ponsMemeHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' as Address,
  ponsLaunchRouter: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948' as Address,
  ponsLocker: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952' as Address,
  /** Pons V1 (superseded 2026-08-04): tokens launched straight into a 1 %
   *  Uniswap v3 pool against WETH. Traded like any v3 token. */
  ponsV1Factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' as Address,
  /**
   * Krypt's own curve router (contracts/KryptCurveRouter.sol): forwards a
   * Pons buy and pays the platform fee in the SAME transaction, which is
   * what lets the signer's fee interlock cover curve buys. Empty until it is
   * deployed (`npm run deploy:router -- --write` fills this in); while empty
   * the rail buys on the curve directly and bills with a follow-up transfer.
   */
  kryptRouter: '' as Address | '',
} as const;

export const KRYPT_ROUTER_ABI = parseAbi([
  'function buy(address curve, uint256 quoteIn, uint256 minTokensOut, uint256 feeWei, address referrer, uint256 referrerWei) payable returns (uint256 tokensOut, uint256 refundWei)',
  'function TREASURY() view returns (address)',
  'function MAX_FEE_BPS() view returns (uint256)',
  'error FeeTooHigh()',
  'error ReferrerShareTooHigh()',
  'error ValueMismatch()',
  'error NoBuyer()',
  'error TransferFailed()',
  'error Reentered()',
  'event CurveBuyRouted(address indexed buyer, address indexed curve, uint256 quoteIn, uint256 tokensOut, uint256 feeWei, address referrer, uint256 referrerWei, uint256 refundWei)',
]);

/** Router fee ceiling, mirrored from the contract: 2 % of the buy. */
export const KRYPT_ROUTER_MAX_FEE_BPS = 200n;

/** Uniswap v3 fee tiers to probe when a token's pool is unknown. */
export const V3_FEE_TIERS = [10_000, 3_000, 500, 100] as const;

export const ROBINHOOD = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_PUBLIC_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER } },
  contracts: { multicall3: { address: ADDR.multicall3 } },
});

// ── ABIs ──────────────────────────────────────────────────────────────

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const PONS_FACTORY_ABI = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function approvedPairTokens(address pairToken) view returns (bool)',
  'function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event LaunchSwept(address indexed token, uint256 sweptQuote, uint256 sweptTokens)',
]);

/**
 * Pons V2 launch router — `launchAndBuy`, selector 0xf85f8e41.
 *
 * Recovered from chain rather than a document: the selector was looked up in
 * the public signature database and then PROVEN by re-encoding a real launch
 * (tx 0x39ddbf1c…) and comparing byte for byte with what the sender actually
 * submitted. `test/ponslaunch.test.mjs` pins that comparison, so a change to
 * this shape fails a test rather than a user's transaction.
 *
 * Two fields deserve naming. `configId` was identical across every launch
 * sampled — it selects the launch configuration and is treated as a constant
 * until one is seen that differs. `salt` varies per launch and feeds the
 * token's CREATE2 address.
 */
export const PONS_LAUNCH_ABI = [
  {
    type: 'function',
    name: 'launchAndBuy',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'string', name: 'name' },
          { type: 'string', name: 'symbol' },
          { type: 'string', name: 'image' },
          { type: 'string', name: 'website' },
          {
            type: 'tuple',
            name: 'socials',
            components: [
              { type: 'string', name: 'twitter' },
              { type: 'string', name: 'telegram' },
              { type: 'string', name: 'extra1' },
              { type: 'string', name: 'extra2' },
              { type: 'string', name: 'extra3' },
            ],
          },
          { type: 'address', name: 'creatorFeeRecipient' },
          { type: 'uint16', name: 'creatorTaxBps' },
          { type: 'bool', name: 'buyback' },
          { type: 'bytes32', name: 'configId' },
          { type: 'bytes32', name: 'salt' },
        ],
      },
      { type: 'uint256', name: 'unused0' },
      { type: 'address', name: 'unused1' },
      { type: 'uint256', name: 'quoteIn' },
      { type: 'uint256', name: 'minTokensOut' },
      { type: 'address', name: 'recipient' },
      { type: 'address[]', name: 'extra' },
    ],
    outputs: [],
  },
] as const;

/** Observed on every sampled launch. See PONS_LAUNCH_ABI. */
export const PONS_LAUNCH_CONFIG_ID = '0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7' as const;

/**
 * Flat fee the router takes on a launch, on top of the buy.
 *
 * Measured across three launches on 2026-09-10: `value` was exactly
 * `quoteIn + 0.0005 ETH` in every one.
 */
export const PONS_LAUNCH_FEE_WEI = 500_000_000_000_000n;

export const PONS_CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);

/**
 * Custom errors the contracts on this rail revert with. Decoding ONLY — never
 * used to encode a call. Without these every refusal reads "execution
 * reverted", which is the EVM twin of the Anchor error codes the Solana
 * signer surfaces (a slippage refusal and a missing allowance must not look
 * the same to the user).
 */
export const REVERT_ERRORS_ABI = parseAbi([
  'error SlippageExceeded(uint256 out, uint256 min)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ReferrerShareTooHigh()',
  'error FeeTooHigh()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V3TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V2TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error SliceOutOfBounds()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error InvalidEthSender()',
  'error Error(string reason)',
]);

export const V4_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const V3_FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)']);

export const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

export const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

// ── Universal Router / v4 router constants ───────────────────────────

/** Universal Router command bytes (Commands.sol). */
export const UR_COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_TRANSFER_FROM: 0x02,
  V2_SWAP_EXACT_IN: 0x08,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

/** v4 router action bytes (Actions.sol). */
export const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
} as const;

/** Recipient sentinels shared by the Universal Router and the v4 actions. */
export const UR_ADDR = {
  ETH: NATIVE_ADDRESS as Address,
  MSG_SENDER: '0x0000000000000000000000000000000000000001' as Address,
  ADDRESS_THIS: '0x0000000000000000000000000000000000000002' as Address,
} as const;

// ── Event topics, as read from the chain ──────────────────────────────

export const TOPIC = {
  tokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607' as Hex,
  launchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4' as Hex,
  poolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259' as Hex,
  graduationLocked: '0xa0a18f5bf205becee8b268d7cf69addab8548ae8ef361791464cf0e0e17c1361' as Hex,
  curveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455' as Hex,
  curveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df' as Hex,
  snipeTaxCharged: '0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934' as Hex,
  curveBuyRefunded: '0xa69e8258ccc7b9bbb70ab953fc2d1062b4ee28b8ca827534097e1732e87b0262' as Hex,
  erc20Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex,
  curveBuyRouted: '0x222766db213af7b86839b8ecdd289e576d295a73c0cffb7df34c8322ddb945d8' as Hex,
} as const;

/** Function selectors the signing policy allows, per target. */
export const SELECTOR = {
  curveBuy: '0x59a87bc1' as Hex, // buy(uint256,uint256,address)
  curveSell: '0xd04c6983' as Hex, // sell(uint256,uint256,address)
  execute: '0x3593564c' as Hex, // execute(bytes,bytes[],uint256)
  approve: '0x095ea7b3' as Hex, // approve(address,uint256)
  permit2Approve: '0x87517c45' as Hex, // approve(address,address,uint160,uint48)
  kryptRouterBuy: '0xf26c91bb' as Hex, // buy(address,uint256,uint256,uint256,address,uint256)
} as const;

/** Chain facts worth stating in one place. ~100 ms blocks, first-come
 *  sequencer; deadlines use timestamps, never block numbers. */
export const BLOCK_MS = 100;
/** Pons V2 launches mint exactly this many whole tokens at 18 decimals. */
export const PONS_SUPPLY = 1_000_000_000n * 10n ** 18n;
/** Log queries are capped at 10,000 results per call (measured); a hot
 *  contract needs narrow windows. */
export const LOGS_MAX_RESULTS = 10_000;
