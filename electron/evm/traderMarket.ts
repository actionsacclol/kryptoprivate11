// What Krypto Trader needs to know about an EVM coin right now (stage 4,
// 2026-09-25): a price with its age, the venue, and the pool depth R in the
// chain's native coin — the number every size cap and the fit check stand on.
//
// Every figure is read from the chain, through the SAME venue resolver the
// trade path builds from (venue.ts), so the depth a session sizes against is
// the pool its fills will hit:
//
//   • Pons curve (Robinhood) — a constant-product curve with a phantom
//     reserve: R is its quote reserve, exactly; price is the curve's spot.
//   • four.meme curve (BNB) — Helper3's own `tryBuy` at two sizes; R is the
//     depth those two quotes imply (shared/botStrategy.ts impliedDepthWei);
//     price is the helper's `lastPrice`.
//   • PancakeSwap v2 / v3, Uniswap v3, the Pons v4 pool — the venue's own
//     quoter at two sizes, the same way; price is the small probe's fill.
//
// Only NATIVE-quoted venues are read. 78 % of four.meme curves are quoted in
// USDT / USD1 / tokenised stock (bnb-audit-2026-09-11) and about half of Pons
// launches in USDG; the resolver already refuses those, and so does this —
// their depth is not BNB or ETH, and a size cap in the wrong asset is a lie.
// An unknown depth is null — the session then buys nothing (honest-null).

import type { Address } from 'viem';
import { impliedDepthWei } from '@shared/botStrategy';
import { VENUE_LABEL, type EvmChainKind, type EvmVenue } from '@shared/evm';
import * as fourmeme from './fourmeme';
import { stateFromVenue } from './market';
import { spotPrice as ponsSpot, toShared as ponsShared } from './pons';
import { bestV3Route, quoteV2, quoteV4 } from './uniswap';
import { resolveVenue, type Venue } from './venue';

/** The two probe sizes, wei: 0.001 and 0.1 of the native coin. Big enough
 *  apart that a pool of a few ETH shows a clear impact; quotes are eth_calls,
 *  nothing is spent. */
const PROBE_SMALL = 10n ** 15n;
const PROBE_BIG = 10n ** 17n;
/** Depth is re-probed at most this often per token. */
const DEPTH_TTL_MS = 60_000;
/** A whole read is reused this long: the Trader tick is 5 s and the public
 *  RPCs are gated (Robinhood 5 rps). The price keeps its READ time as its
 *  age, so a reused read is never passed off as newer than it is. */
const READ_TTL_MS = 10_000;

export interface TraderEvmRead {
  priceNative: number | null;
  priceAt: number | null;
  venue: 'curve' | 'pool' | null;
  venueLabel: string | null;
  /** Why this coin cannot be traded here (not native-quoted, no route…). */
  untradable: string | null;
  curvePct: number | null;
  depthNative: number | null;
  depthAt: number | null;
  decimals: number | null;
  /** Token side, whole tokens, for dump impact (curves only); and supply. */
  tokenReserve: number | null;
  supply: number | null;
  /** The launch's deployer, when the chain or the launch index knows it. */
  deployer: string | null;
  createdAt: number | null;
}

const depthCache = new Map<string, { at: number; depth: number | null }>();
const readCache = new Map<string, { at: number; read: TraderEvmRead }>();

async function probeBuy(v: Venue, wei: bigint): Promise<{ inWei: bigint; out: bigint } | null> {
  try {
    switch (v.venue) {
      case 'fourmeme-curve': {
        const q = await fourmeme.quoteBuy(v.token, wei);
        if ('error' in q || q.tokensOut <= 0n) return null;
        return { inWei: q.cost > 0n ? q.cost : wei, out: q.tokensOut };
      }
      case 'pancake-v2': {
        const q = await quoteV2(v.token, 'buy', wei);
        return 'error' in q || q.amountOut <= 0n ? null : { inWei: wei, out: q.amountOut };
      }
      case 'pancake-v3':
      case 'uniswap-v3': {
        const q = await bestV3Route(v.chain, v.token, 'buy', wei);
        return q && q.amountOut > 0n ? { inWei: wei, out: q.amountOut } : null;
      }
      case 'pons-v4': {
        if (!v.key) return null;
        const zeroForOne = v.key.currency0.toLowerCase() !== v.token.toLowerCase();
        const q = await quoteV4(v.key, zeroForOne, wei);
        return 'error' in q || q.amountOut <= 0n ? null : { inWei: wei, out: q.amountOut };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function depthOf(v: Venue, now: number): Promise<{ depth: number | null; at: number | null; small: { inWei: bigint; out: bigint } | null }> {
  if (v.venue === 'pons-curve' && v.curve) {
    return { depth: v.curve.quoteReserve > 0n ? Number(v.curve.quoteReserve) / 1e18 : null, at: now, small: null };
  }
  // Keyed by venue too (review #16): at graduation the pool's depth is not
  // the curve's, and a fresh curve figure must never stand in for it.
  const key = `${v.chain}:${v.token.toLowerCase()}:${v.venue}`;
  const small = await probeBuy(v, PROBE_SMALL);
  const hit = depthCache.get(key);
  if (hit && now - hit.at < DEPTH_TTL_MS) return { depth: hit.depth, at: hit.at, small };
  const bigQ = small ? await probeBuy(v, PROBE_BIG) : null;
  const R = small && bigQ ? impliedDepthWei(small.inWei, small.out, bigQ.inWei, bigQ.out) : null;
  const depth = R !== null ? Number(R) / 1e18 : null;
  depthCache.set(key, { at: now, depth });
  return { depth, at: now, small };
}

/** One coin, read now (or within the last 10 s). Never throws: an
 *  unreadable coin comes back all null. */
export async function readTraderMarket(chain: EvmChainKind, token: string, now = Date.now()): Promise<TraderEvmRead> {
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = readCache.get(key);
  if (hit && now - hit.at < READ_TTL_MS) return hit.read;
  const read = await readNow(chain, token, now);
  readCache.set(key, { at: now, read });
  if (readCache.size > 200) readCache.delete(readCache.keys().next().value as string);
  return read;
}

async function readNow(chain: EvmChainKind, token: string, now: number): Promise<TraderEvmRead> {
  const empty: TraderEvmRead = { priceNative: null, priceAt: null, venue: null, venueLabel: null, untradable: null, curvePct: null, depthNative: null, depthAt: null, decimals: null, tokenReserve: null, supply: null, deployer: null, createdAt: null };
  let v: Venue;
  try {
    v = await resolveVenue(chain, token.toLowerCase() as Address);
  } catch (e) {
    return { ...empty, untradable: `the ${chain === 'bnb' ? 'BNB' : 'Robinhood'} chain could not be read (${(e as Error).message})` };
  }
  const st = stateFromVenue(v);
  const base: TraderEvmRead = {
    ...empty,
    venueLabel: v.venue === 'unknown' ? null : VENUE_LABEL[v.venue as EvmVenue],
    untradable: v.untradable,
    decimals: Number.isFinite(v.decimals) ? v.decimals : null,
    supply: v.totalSupply > 0n ? Number(v.totalSupply) / 10 ** v.decimals : null,
    deployer: st.launch?.deployer ?? null,
    createdAt: st.launch?.launchedAt ?? null,
  };
  if (v.venue === 'unknown' || v.untradable) return base;
  const onCurve = v.venue === 'pons-curve' || v.venue === 'fourmeme-curve';
  const d = await depthOf(v, now);
  let price: number | null = null;
  let curvePct: number | null = null;
  let tokenReserve: number | null = null;
  if (v.venue === 'pons-curve' && v.curve) {
    price = ponsSpot(v.curve);
    curvePct = ponsShared(v.curve).progressPct;
    tokenReserve = Number(v.curve.tokenReserve) / 10 ** v.decimals;
  } else if (v.venue === 'fourmeme-curve' && v.fourMeme) {
    price = fourmeme.spotPrice(v.fourMeme);
    curvePct = fourmeme.progressPct(v.fourMeme);
  } else if (d.small) {
    // A pool's price is what the small probe fills at — spot plus the pool
    // fee (0.25–1 %), a slightly dear mark, never a flattering one.
    const tokens = Number(d.small.out) / 10 ** v.decimals;
    price = tokens > 0 ? Number(d.small.inWei) / 1e18 / tokens : null;
  }
  return {
    ...base,
    priceNative: price !== null && Number.isFinite(price) && price > 0 ? price : null,
    priceAt: price !== null && price > 0 ? now : null,
    venue: onCurve ? 'curve' : 'pool',
    curvePct,
    depthNative: d.depth,
    depthAt: d.at,
    tokenReserve,
  };
}

/** For the tests. */
export function _resetDepthCache(): void {
  depthCache.clear();
  readCache.clear();
}
