# Robinhood Chain — research and rail design (2026-09-08)

Everything the Robinhood rail (`electron/evm/`, `shared/evm.ts`) relies on, with
how each fact was verified. Re-run the live check with `npm run test:evm`.

## 1. The chain

| Fact | Value | How verified |
|---|---|---|
| Chain id | 4663 (`0x1237`) | `eth_chainId` on the public RPC |
| Client | Arbitrum Nitro `v3.11.4-rc.3` | `web3_clientVersion` |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | answered a 25-call burst, JSON-RPC batches (100 entries), 50k-block `eth_getLogs`, `eth_call` with state overrides — but a Discover-sized burst gets **HTTP 429 with a single `{"error":{"code":429}}` object even for a batch**, which viem cannot map back onto the batch; `client.ts` gates every fetch (5 rps, burst 8, park on 429) and keeps log scans unbatched |
| Log cap | 10,000 results per `eth_getLogs` | error text `logs matched by query exceeds limit of 10000` on a busy hook contract |
| Keyed RPC | Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/{key}` (docs.robinhood.com/chain/connecting) | not exercised — BYO key in Settings |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | connected; `{version:1, messages:[{sequenceNumber, message:{message:{header:{kind:3,…}, l2Msg:<base64 batch of signed txs>}}}]}` at 40–60 msgs/s |
| Explorer | `https://robinhoodchain.blockscout.com` | UI only — its API sits behind a Cloudflare JS challenge from a plain client, so it is NOT a data source |
| Block time | ~100 ms | consecutive block timestamps; deadlines are timestamps, never block numbers |
| Gas | base fee ~0.22 gwei, priority fee 0, `eth_feeHistory` rewards all 0 | 90-day gas subsidy ends **2026-09-29**; re-check after |
| Mainnet launch | 2026-07-01 | press + robinhood.com |

Canonical contracts (all `eth_getCode` non-empty):

| Contract | Address |
|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (6 dec) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v3 Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| v3 QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| v3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| 1inch Router | `0x5A705DE8982235a7fa45bB83dCaCf03a211389C7` (not used) |

Uniswap addresses come from developers.uniswap.org's v3 and v4 deployment
tables for chain 4663. Bags' integration notes say the Universal Router here is
a modified build whose v4 `ExactInputSingleParams` carries an extra
`minHopPriceX36` word; BOTH the stock and the extended encodings passed
`estimateGas` (154,249 / 154,216 gas). The rail uses the extended one and
simulates every call before signing, so a wrong layout fails closed.

## 2. Pons V2 — the chain's pump.fun

Contracts (docs.ponsfamily.com/v2, github.com/ponsdotdev/ponsfamily, all on chain):

| Contract | Address |
|---|---|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Meme hook (v4) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| Launch-and-buy router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| Launch locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` |
| V1 factory (superseded) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |

Mechanics: 1,000,000,000 tokens (18 dec) minted into a constant-product curve
with a phantom quote reserve; `buy(quoteIn, minTokensOut, recipient)` payable,
`sell(tokensIn, minQuoteOut, recipient)`; 100 bps fee + creator tax (200–300 bps
seen) per fill; snipe tax 99 % decaying to 0 within seconds; graduation at 4.2 ETH
of real quote (`0x3a4965bf58a40000`) sweeps into a full-range v4 pool
(currency0 = native ETH `0x0`, currency1 = token, fee 0, tickSpacing 200,
hooks = meme hook) whose position is locked in the locker. Custom pair tokens
(USDG, tokenised stocks) are allowed; the rail trades only ETH- and USDG-quoted
launches and shows the rest.

Measured 2026-09-08: **386–414 launches per 20,000 blocks (~33 min)**, about
half ETH-quoted; **12 graduations per 40,000 blocks**.

Event topics as read from the chain (not derived):

| Event | topic0 |
|---|---|
| `TokenLaunched(token,curve,deployer indexed; pairToken, launchConfigId, graduationThreshold)` | `0x8d4aad49…a89607` |
| `LaunchSwept(token indexed; sweptQuote, sweptTokens)` | `0xcdb72f15…c4b6b4` |
| `PoolGraduated(token indexed; …3 words)` | `0x0a44ef75…8c259` |
| `GraduationTokensPermanentlyLocked` | `0xa0a18f5b…c1361` |
| `CurveBuy(buyer, recipient indexed; quoteIn, tokensOut, fee, tax)` | `0xec36bf57…fc455` |
| `CurveSell(seller, recipient indexed; tokensIn, quoteOut, fee, tax)` | `0x8113d738…f59df` |
| `SnipeTaxCharged` | `0x3bc39a55…a9934` |
| `CurveBuyRefunded` | `0xa69e8258…b0262` |

On a `launchAndBuy` the `buyer` is the Pons router; the trader is `recipient`.

Selectors: `buy` `0x59a87bc1`, `sell` `0xd04c6983`, `execute(bytes,bytes[],uint256)`
`0x3593564c`, ERC-20 `approve` `0x095ea7b3`, Permit2 `approve` `0x87517c45`.

**The documented formula over-estimates buys.** Curve `0xec8DAA33…` with
reserves (5.209 ETH phantom-inclusive, 322.5 M tokens), fee 100, tax 300:
formula 59,423 tokens for 0.001 ETH, the curve returned **57,313** (ratio
1.037). So the rail quotes by `eth_call` of the exact calldata and uses the
formula only as a labelled estimate. `estimateGas` for the buy: 105,564.

## 3. Uniswap execution, verified by simulation

| Call | Result |
|---|---|
| v4 Quoter `quoteExactInputSingle` on a graduated Pons pool, 0.001 ETH | 420,528 tokens, gas 79,575 |
| Universal Router `execute` with `V4_SWAP` [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL] | gas 154k |
| Same with a `TRANSFER(ETH, treasury, fee)` command first and `value = amountIn + fee` | gas 164k — **the fee rides inside the router call on pool trades** |

Sell path (not simulated without holdings): `SETTLE_ALL(token)` pulls through
Permit2, so a sell needs `token.approve(Permit2)` and `Permit2.approve(token,
router, …)` once per token; the fee is `TAKE_PORTION(ETH, treasury, bips)` on the
output delta (v4) or `UNWRAP_WETH → PAY_PORTION → SWEEP` (v3). Router constants:
`MSG_SENDER = address(1)`, `ADDRESS_THIS = address(2)`.

Curve trades call the curve directly; an EOA cannot batch, so the fee follows as
its own transfer after the fill and never blocks it (Multicall3 was rejected:
partial-fill refunds would go to Multicall3 and be lost).

## 4. Data providers

| Provider | Route | Verified |
|---|---|---|
| GeckoTerminal | network slug `robinhood`; dex ids `pons-v2` (curves, pool address = curve address), `pons-v2-dex`, `uniswap-v4-robinhood`, `uniswap-v3-robinhood`, `uniswap-pools-trade`, `clanker-robinhood`, `bankr-robinhood`, … | `/networks`, `/networks/robinhood/dexes`, OHLCV on a v3 pool, token `/info` carries `holders.count` + top-10 share |
| DexScreener | `chainId: 'robinhood'`; `/token-pairs/v1/robinhood/{addr}`, `/tokens/v1/robinhood/{a,b}` | CASHCAT and DELTA pairs, WETH quote; **Pons curves are not indexed** (empty) |
| OpenOcean | `/v4/robinhood/tokenList` works; `/quote` and `/swap` return a Cloudflare challenge | not usable from an app |
| 1inch | Swap API supports 4663 but needs a key | future BYO-key route |
| Blockscout API | Cloudflare challenge | not usable |

ETH/USD comes from DexScreener's WETH pairs on the chain (WETH/USDG), memoised
a minute (`electron/evm/prices.ts`).

## 5. Design (what shipped)

- `shared/evm.ts` — contract: chain constants, `EvmSettings` (Alchemy key / own
  RPC / slippage / referrer), wallet + trade + ledger + portfolio types, fee
  split (`EVM_TREASURY_ADDRESS` was set 2026-09-08; a blank one is refused by
  scripts/gen-fee-integrity.mjs — the canaries read it as tampering).
- `electron/evm/chain.ts` — every address, ABI, topic and selector, pinned by
  `test/evmchain.test.mjs`.
- `evmWalletStore.ts` (pure) + `evmWallet.ts` (safeStorage, secp256k1 via viem,
  `evm-wallets.json`, one active signer, switching refused while armed).
- `policy.ts` (pure) — the last gate before a signature: chain id, target
  allowlist, selector allowlist, value ceiling, gas + fee caps, approval
  spenders restricted to Permit2 / the router.
- `pons.ts`, `uniswap.ts`, `venue.ts`, `trade.ts` — resolve venue → quote →
  build → estimateGas → policy → sign → send → receipt → ledger, one trade at a
  time. Paper = simulation of the real bytes with a pretend balance.
- `ledger.ts` — `evm-fills.json`; basis from the receipt block's balance diff
  and the receipt's own Transfer logs.
- `discover.ts` — rolling in-memory index of `TokenLaunched` (first fill 60k
  blocks, rolls to 200k), curve state by multicall (11 views × 40 curves per
  call), Graduating from curves with `CurveBuy` logs in the last 6k blocks,
  Migrated from `LaunchSwept`, Trending from GeckoTerminal.
- `market.ts` — summaries/details/candles in the terminal's own shapes with
  `chain: 'robinhood'`; candles from GeckoTerminal (1 m floor; sub-minute says
  so — no own feed yet).
- `rail.ts` + `ipc.ts` `evm:*` + `preload.evm` — the renderer's surface.

## 5b. The Krypt curve router (built 2026-09-08, verified, awaiting deployment)

`contracts/KryptCurveRouter.sol`: one function, `buy(curve, quoteIn, minOut,
feeWei, referrer, referrerWei)`. Forwards `quoteIn` to the Pons curve with the
buyer as recipient, pays `feeWei − referrerWei` to the constant treasury and
`referrerWei` to the referrer, forwards any partial-fill refund to the buyer,
and reverts rather than keep a wei. No owner, no storage, 2 % fee ceiling,
reentrancy lock. Compiled with solc 0.8.28, optimizer 200, evmVersion paris.

Verified against the live chain without deploying: the node accepts `code`
state overrides on `eth_call`/`eth_estimateGas` and serves `eth_simulateV1`
with `traceTransfers` (`debug_traceCall` is not available). Results on
2026-09-08: routed buy 187,950 gas with a referrer / 178,056 without; treasury
+4e12 wei and referrer +1e12 wei on a 0.001 ETH buy, curve +1e15; a 20 ETH buy
on the fullest curve (61.9 %) was clamped and 18.43 ETH came back to the buyer
with the router at zero. Deploy: `KRYPT_DEPLOYER_KEY=0x… npm run deploy:router
-- --write`.

## 6. Not built yet (in order of value)

1. **Own tape from the sequencer feed** — decode the L2 batch messages
   (`l2Msg` kind 3 = batch of kind-4 signed txs) for sub-second curve trades and
   1 s candles, the way the Solana tape works.
2. **Sell-side quote as position value** (`valueSource: 'quote'`), like the
   Solana portfolio.
3. Other v4 hook pools (Pools.trade, Bags, Clanker) and USDG-quoted execution.
4. BYO-key 1inch route as the aggregator fallback.
5. Stock-paired pools (LONG) — shown, not traded.
6. Anti-tamper for the EVM fee (integrity blob, canary, buy interlock); the
   treasury `0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a` was set later the same
   day after a checksum check, `eth_getCode` (plain account) and a simulated
   router buy with the fee leg to it (189,664 gas).
