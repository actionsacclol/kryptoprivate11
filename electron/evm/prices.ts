// Native/USD per EVM chain — from DexScreener's wrapped-native pairs on the
// chain itself (WETH/USDG on Robinhood, WBNB/USDT on BNB), memoised a
// minute, with GeckoTerminal's token price as the fallback. Both hosts are
// in data/http.ts's closed list; this file names paths only.

import { getJson, memo } from '../data/http';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';

interface DsPair {
  chainId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface GtToken {
  data?: { attributes?: { price_usd?: string } };
}

export async function nativeUsd(chain: EvmChainKind): Promise<number | null> {
  const meta = EVM_CHAIN_META[chain];
  return memo<number>(`evm:nativeusd:${chain}`, 60_000, async () => {
    const ds = await getJson<DsPair[]>('dexscreener', `/tokens/v1/${meta.dexscreenerChain}/${meta.wrappedNative}`);
    if (ds.ok && Array.isArray(ds.data)) {
      const pairs = ds.data.filter((p) => p?.chainId === meta.dexscreenerChain && Number(p.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = pairs[0];
      if (best) return Number(best.priceUsd);
    }
    const gt = await getJson<GtToken>('geckoterminal', `/api/v2/networks/${meta.geckoNetwork}/tokens/${meta.wrappedNative.toLowerCase()}`);
    const p = Number(gt.data?.data?.attributes?.price_usd);
    return gt.ok && Number.isFinite(p) && p > 0 ? p : null;
  });
}

/** Kept for the Robinhood-only callers written on 2026-09-08. */
export const ethUsd = (): Promise<number | null> => nativeUsd('robinhood');
