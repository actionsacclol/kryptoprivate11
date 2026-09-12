// Where does this token trade, and can this version route it?
//
// One resolver shared by the market layer (to describe the token) and the
// trade layer (to build the transaction), so the two can never disagree
// about which pool a fill will hit. Every fact comes from the chain: the
// launchpad's own record, the curve's state, or a factory / quoter probe.
// Nothing here trusts a provider or the renderer for an address that money
// will be sent to.
//
//   Robinhood: Pons factory record → curve / v4 pool; else a v3 pool vs WETH.
//   BNB:       four.meme helper → curve / PancakeSwap v2 pair; else a v2
//              pair vs WBNB; else a v3 pool vs WBNB.

import type { Address } from 'viem';
import { memo } from '../data/http';
import { curveState, launchRecord, poolKeyFor, type CurveState, type PonsLaunchRecord } from './pons';
import { tokenMeta } from './erc20';
import * as fourmeme from './fourmeme';
import { bestV3Route, quoteV2, v2Pair } from './uniswap';
import { NATIVE_ADDRESS, USDG_ADDRESS, type EvmChainKind, type EvmPoolKey, type EvmVenue } from '@shared/evm';
import { ADDR_BSC } from './bsc';

/** BSC's USD1 stablecoin — the most common four.meme quote after BNB. */
const USD1_ADDRESS = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';

export interface Venue {
  chain: EvmChainKind;
  token: Address;
  venue: EvmVenue;
  /** Pons (Robinhood). */
  record: PonsLaunchRecord | null;
  curve: CurveState | null;
  key: EvmPoolKey | null;
  /** four.meme (BNB). */
  fourMeme: fourmeme.FourMemeInfo | null;
  /** A v2 pair (BNB) once graduated or simply listed. */
  v2: { pair: Address } | null;
  v3: { feeTier: number; pool: Address } | null;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** Why it cannot be traded here, or null. */
  untradable: string | null;
}

const PROBE_WEI = 10n ** 15n; // 0.001 native

/** Resolve, memoised 8 s: a curve's phase flips exactly once, and a pool
 *  does not move, but a token page polls this and the RPC is shared. */
export async function resolveVenue(chain: EvmChainKind, token: Address): Promise<Venue> {
  const key = `evm:venue:${chain}:${token.toLowerCase()}`;
  const hit = await memo<Venue>(key, 8_000, () => resolveNow(chain, token));
  return hit ?? (await resolveNow(chain, token));
}

async function resolveNow(chain: EvmChainKind, token: Address): Promise<Venue> {
  const metaMap = await tokenMeta(chain, [token]);
  const meta = metaMap.get(token.toLowerCase()) ?? { name: '', symbol: '', decimals: 18, totalSupply: 0n };
  const base: Venue = { chain, token, venue: 'unknown', record: null, curve: null, key: null, fourMeme: null, v2: null, v3: null, ...meta, untradable: null };
  return chain === 'robinhood' ? resolveRobinhood(base) : resolveBnb(base);
}

async function resolveRobinhood(base: Venue): Promise<Venue> {
  const record = await launchRecord(base.token);
  if (record) {
    // Pons allows any approved pair token: about half of all launches are
    // quoted in USDG or a tokenised stock, not ETH. This version settles ETH
    // and only ETH, so those are SHOWN and never traded — the BNB resolver
    // below has the same guard. The pair comes from the factory record (a
    // failed curve view defaults `isNativeQuote` to false, which would refuse
    // legitimate ETH curves).
    if (record.pairToken.toLowerCase() !== NATIVE_ADDRESS.toLowerCase()) {
      const curve = record.phase === 0 ? await curveState(record.curve).catch(() => null) : null;
      return {
        ...base,
        venue: 'unknown',
        record,
        curve,
        untradable: `This launch is quoted in ${record.pairToken.toLowerCase() === USDG_ADDRESS.toLowerCase() ? 'USDG' : 'a token other than ETH'}, not ETH — shown, not traded, in this version.`,
      };
    }
    if (record.phase === 0) {
      const curve = await curveState(record.curve);
      if (curve && !curve.graduated) return { ...base, venue: 'pons-curve', record, curve };
      if (curve?.graduated) return { ...base, venue: 'unknown', record, curve, untradable: 'Graduating right now — the Uniswap pool is being created. Try again in a moment.' };
      return { ...base, venue: 'unknown', record, untradable: 'Curve state unreadable' };
    }
    if (record.phase === 2) return { ...base, venue: 'pons-v4', record, key: poolKeyFor(record) };
    if (record.phase === 1) return { ...base, venue: 'unknown', record, untradable: 'Swept off the curve; the Uniswap pool is not created yet.' };
    return { ...base, venue: 'unknown', record, untradable: 'This launch went through Pons’ recovery path; not routable here.' };
  }
  const v3 = await bestV3Route('robinhood', base.token, 'buy', PROBE_WEI);
  if (v3) return { ...base, venue: 'uniswap-v3', v3: { feeTier: v3.feeTier, pool: v3.pool } };
  return {
    ...base,
    untradable: 'No Pons curve and no Uniswap v3 pool against WETH. Pools this version cannot route yet (other v4 hooks, USDG-quoted pairs) are shown but not traded.',
  };
}

/** What a BNB quote asset is called, for a refusal a user can act on. */
function bnbQuoteName(quote: string): string {
  const q = quote.toLowerCase();
  if (q === ADDR_BSC.usdt.toLowerCase()) return 'USDT';
  if (q === USD1_ADDRESS) return 'USD1';
  return 'a token other than BNB';
}

/**
 * Pick the PancakeSwap venue by what it will actually PAY, never by whether a
 * pair address exists. On BSC a v2 pair contract lives forever once created,
 * so a token whose real market is a v3 pool usually also has an abandoned,
 * near-empty v2 pair. Taking that pair on its address alone routed real buys
 * into dust: measured 2026-09-09, a 0.1 BNB buy that should have returned
 * 172.73 tokens returned 0.02543 — and it FILLS, it does not revert, because
 * the quote comes from the same dead pair the swap uses.
 */
async function bestPancakeVenue(base: Venue, fm: fourmeme.FourMemeInfo | null): Promise<Venue> {
  const token = base.token;
  const [pair, v3] = await Promise.all([v2Pair(token), bestV3Route('bnb', token, 'buy', PROBE_WEI)]);
  let v2Out = 0n;
  if (pair) {
    const q = await quoteV2(token, 'buy', PROBE_WEI);
    if (!('error' in q)) v2Out = q.amountOut;
  }
  const v3Out = v3?.amountOut ?? 0n;
  if (v2Out > 0n && v2Out >= v3Out) return { ...base, venue: 'pancake-v2', fourMeme: fm, v2: { pair: pair as Address } };
  if (v3 && v3Out > 0n) return { ...base, venue: 'pancake-v3', fourMeme: fm, v3: { feeTier: v3.feeTier, pool: v3.pool } };
  return {
    ...base,
    venue: 'unknown',
    fourMeme: fm,
    untradable: fm
      ? 'Graduated from four.meme, but neither its PancakeSwap v2 pair nor a v3 pool against WBNB has any liquidity to quote.'
      : 'No four.meme curve and no PancakeSwap pair or pool against WBNB with liquidity. Other launchpads (Flap, GraFun) and USDT-quoted pairs are shown but not traded in this version.',
  };
}

async function resolveBnb(base: Venue): Promise<Venue> {
  const fm = await fourmeme.info(base.token);
  if (fm) {
    // The quote guard runs FIRST, exactly as it does on Robinhood: about 85 %
    // of four.meme launches are quoted in USD1, USDT or a tokenised stock, and
    // a graduated one is no more tradeable in BNB than a live one.
    if (fm.quote !== NATIVE_ADDRESS) {
      return { ...base, venue: 'unknown', fourMeme: fm, untradable: `This four.meme launch is quoted in ${bnbQuoteName(fm.quote)}, not BNB — shown, not traded, in this version.` };
    }
    if (fm.liquidityAdded) return bestPancakeVenue(base, fm);
    // The sold-out window: the curve has no tokens left but four.meme's keeper
    // has not created the pool yet, so the manager reverts `Disabled` on every
    // buy AND every sell while the helper still quotes a price. Pons names both
    // of its equivalent states; this one was silently "tradeable".
    if (fm.offers === 0n) {
      return { ...base, venue: 'unknown', fourMeme: fm, untradable: 'The curve is sold out — four.meme is creating the PancakeSwap pool. Try again in a moment.' };
    }
    return { ...base, venue: 'fourmeme-curve', fourMeme: fm };
  }
  return bestPancakeVenue(base, null);
}
