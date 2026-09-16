// EVM market data — one token at a time, for Robinhood Chain and BNB Smart
// Chain.
//
// The row and detail shapes are the terminal's (shared/market.ts) so the
// same panels render every chain; `chain` tells them which unit to print.
// Facts come from, in order of authority: the chain (launchpad records,
// pool quotes), DexScreener (pools, socials, windowed stats — it indexes
// four.meme curves too), GeckoTerminal (candles, holders). Honest nulls
// throughout — a curve quoted in a tokenised stock has no USD price here
// and says so with a dash, not a guess.

import type { Address } from 'viem';
import * as gt from '../data/providers/geckoterminal';
import * as ds from '../data/providers/dexscreener';
import { cooldownRemainingMs, memo } from '../data/http';
import { nativeUsd } from './prices';
import { resolveVenue, type Venue } from './venue';
import { toShared as ponsToShared, spotPrice as ponsSpot, type CurveState } from './pons';
import * as fourmeme from './fourmeme';
import { quoteV4 } from './uniswap';
import { client } from './client';
import { CHAINS } from './chains';
import {
  emptySummary,
  normaliseCandles,
  type CandleInterval,
  type CandleSeries,
  type StatsWindow,
  type TokenPool,
  type TokenSummary,
  type WindowStats,
} from '@shared/market';
import { EVM_CHAIN_META, NATIVE_ADDRESS, USDG_ADDRESS, weiToEth, rawToAmount, type EvmChainKind, type EvmCurveState, type EvmTokenDetail, type EvmTokenState } from '@shared/evm';

const lower = (a: string): Address => a.toLowerCase() as Address;
const isNative = (a: string): boolean => a.toLowerCase() === NATIVE_ADDRESS;
const isUsdg = (a: string): boolean => a.toLowerCase() === USDG_ADDRESS.toLowerCase();
const isWrapped = (chain: EvmChainKind, a: string): boolean => a.toLowerCase() === EVM_CHAIN_META[chain].wrappedNative.toLowerCase();

const WINDOW_KEY: Record<string, StatsWindow> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };

function statsFromPair(p: ds.DsPairLite): Partial<Record<StatsWindow, WindowStats>> {
  const out: Partial<Record<StatsWindow, WindowStats>> = {};
  for (const [k, w] of Object.entries(WINDOW_KEY)) {
    const t = p.txns[k];
    const vol = p.volume[k];
    const chg = p.priceChange[k];
    if (t === undefined && vol === undefined && chg === undefined) continue;
    out[w] = { priceChangePct: typeof chg === 'number' ? chg : null, volumeUsd: typeof vol === 'number' ? vol : null, buys: t?.buys ?? null, sells: t?.sells ?? null, traders: null, organicVolumeUsd: null };
  }
  return out;
}

/** Price of a curve's token in native and USD, when the pair allows it. */
function curvePrices(s: EvmCurveState, usd: number | null): { priceNative: number | null; priceUsd: number | null; liquidityUsd: number | null } {
  if (s.isNativeQuote || isNative(s.pairToken)) {
    const priceNative = s.priceQuote;
    return { priceNative, priceUsd: priceNative !== null && usd !== null ? priceNative * usd : null, liquidityUsd: usd !== null ? weiToEth(s.realQuoteWei) * usd : null };
  }
  if (isUsdg(s.pairToken)) {
    const priceUsd = s.priceQuote === null ? null : s.priceQuote * 1e12; // 6-dec quote per 18-dec token
    return { priceNative: priceUsd !== null && usd ? priceUsd / usd : null, priceUsd, liquidityUsd: Number(BigInt(s.realQuoteWei)) / 1e6 };
  }
  return { priceNative: null, priceUsd: null, liquidityUsd: null };
}

/**
 * The Discover launch index, when it has seen this token: a fresh launch
 * has no DexScreener pair to date it by, but the index knows its block.
 * Registered by discover.ts (which imports this file).
 */
const launchLookups = new Map<EvmChainKind, (token: string) => { blockNumber: bigint; deployer?: string | null } | null>();
export function setLaunchLookup(chain: EvmChainKind, fn: (token: string) => { blockNumber: bigint; deployer?: string | null } | null): void {
  launchLookups.set(chain, fn);
}

/** A Discover row for a launchpad curve, from facts already in hand (no I/O). */
export function curveRow(
  chain: EvmChainKind,
  l: { token: Address; deployer: Address | null; blockNumber: bigint },
  s: EvmCurveState,
  meta: { name: string; symbol: string; decimals: number; totalSupply: bigint },
  usd: number | null,
  head: bigint,
  now = Date.now(),
): TokenSummary {
  const meta_ = EVM_CHAIN_META[chain];
  const row = emptySummary(l.token);
  row.chain = chain;
  row.name = meta.name;
  row.symbol = meta.symbol;
  row.decimals = meta.decimals;
  // A launch we did not index (block 0) has an unknown age — an em dash, not
  // a fabricated one. The honest-null rule applies to age like everything else.
  row.createdAt = head > 0n && l.blockNumber > 0n ? now - Number(head - l.blockNumber) * meta_.blockMs : null;
  row.launchpad = meta_.launchpad;
  const px = curvePrices(s, usd);
  row.priceSol = px.priceNative;
  row.priceUsd = px.priceUsd;
  const supply = meta.totalSupply > 0n ? rawToAmount(meta.totalSupply, meta.decimals) : 1_000_000_000;
  row.totalSupply = supply;
  row.circSupply = supply;
  row.marketCapUsd = px.priceUsd !== null ? px.priceUsd * supply : null;
  row.fdvUsd = row.marketCapUsd;
  row.liquidityUsd = px.liquidityUsd;
  row.bondingCurvePct = s.progressPct;
  row.poolAddress = s.address;
  row.dexId = chain === 'robinhood' ? 'pons-v2' : 'fourmeme';
  row.creator = l.deployer ?? null;
  row.sources = { price: 'onchain', marketCap: 'derived', liquidity: 'onchain' };
  row.fetchedAt = now;
  return row;
}

/** A Discover row from a GeckoTerminal pool listing (trending, dex pages). */
export function poolRow(chain: EvmChainKind, p: gt.NewPool, now = Date.now()): TokenSummary | null {
  if (!p.baseMint) return null;
  const meta = EVM_CHAIN_META[chain];
  const row = emptySummary(lower(p.baseMint));
  row.chain = chain;
  const [sym] = p.name.split(' / ');
  row.symbol = (sym ?? '').trim();
  row.name = row.symbol;
  row.decimals = 18;
  row.createdAt = p.createdAt;
  const dex = p.dexId.toLowerCase();
  row.launchpad = dex.startsWith('pons') ? 'pons' : dex.includes('four') ? 'fourmeme' : chain === 'robinhood' ? 'robinhood' : 'bnb';
  row.priceUsd = p.priceUsd;
  // `||` not `??`: GeckoTerminal sends 0 for an unknown market cap, and a
  // zero market cap shown as fact is the honest-null rule broken.
  row.marketCapUsd = p.marketCapUsd || p.fdvUsd;
  row.fdvUsd = p.fdvUsd;
  row.liquidityUsd = p.reserveUsd;
  row.stats = {
    '24h': { priceChangePct: null, volumeUsd: p.volume24hUsd, buys: null, sells: null, traders: null, organicVolumeUsd: null },
    '5m': { priceChangePct: null, volumeUsd: null, buys: p.buys5m, sells: p.sells5m, traders: null, organicVolumeUsd: null },
  };
  row.poolAddress = p.address;
  row.dexId = p.dexId;
  row.sources = { price: 'geckoterminal', marketCap: 'geckoterminal', liquidity: 'geckoterminal' };
  row.fetchedAt = now;
  void meta;
  return row;
}

// ── One token ─────────────────────────────────────────────────────────

export async function summary(chain: EvmChainKind, address: string, opts: { holders?: boolean } = {}): Promise<TokenSummary> {
  const token = lower(address);
  const key = `evm:summary:${chain}:${token}:${opts.holders ? 'h' : 'n'}`;
  const hit = await memo<TokenSummary>(key, 6_000, () => buildSummary(chain, token, opts));
  return hit ?? (await buildSummary(chain, token, opts));
}

/**
 * Summaries for several tokens on one chain, with the shared work done once.
 *
 * The watchlist asked for each pinned EVM token separately — one IPC hop,
 * one venue resolution and one DexScreener round trip each, every twenty
 * seconds. The Solana half has been batched since 2026-09-08; this is the
 * other half (2026-09-15).
 *
 * Batching is a PRE-WARM, not a second code path: the DexScreener pairs for
 * the whole list are fetched in one request and written under the very keys
 * `buildSummary` reads, and then each summary is built exactly as it always
 * was. That matters because a divergent batch path is how two views of the
 * same token start disagreeing.
 *
 * A token that fails is simply absent from the map — the caller says so
 * rather than being handed a row that means "we could not read it".
 */
export async function summaryMany(
  chain: EvmChainKind,
  addresses: string[],
  opts: { holders?: boolean } = {},
): Promise<Map<string, TokenSummary>> {
  const out = new Map<string, TokenSummary>();
  const unique = [...new Set(addresses.filter(Boolean).map(lower))];
  if (!unique.length) return out;
  const meta = EVM_CHAIN_META[chain];
  // One request for every token's pairs; `summary` below then finds them
  // cached. Failure here is silent on purpose — it only costs the saving.
  await ds.tokenPairsOnMany(meta.dexscreenerChain, unique, { priority: true }).catch(() => undefined);
  // `nativeUsd` is memoised per chain, so asking once ahead of the fan-out
  // keeps the first summary from being the only one that pays for it.
  await nativeUsd(chain).catch(() => undefined);
  await Promise.all(
    unique.map(async (token) => {
      try {
        out.set(token, await summary(chain, token, opts));
      } catch {
        /* an unreadable token is absent, never a row of zeroes */
      }
    }),
  );
  return out;
}

function curveOf(v: Venue): EvmCurveState | null {
  if (v.curve) return ponsToShared(v.curve);
  if (v.fourMeme) return fourmeme.toShared(v.fourMeme);
  return null;
}

async function buildSummary(chain: EvmChainKind, token: Address, opts: { holders?: boolean }): Promise<TokenSummary> {
  const meta = EVM_CHAIN_META[chain];
  const [v, usd, pairs, info] = await Promise.all([
    resolveVenue(chain, token),
    nativeUsd(chain),
    ds.tokenPairsOn(meta.dexscreenerChain, token, { priority: true }),
    opts.holders ? gt.tokenInfoOn(meta.geckoNetwork as gt.GtNetwork, token, { priority: true }) : Promise.resolve(null),
  ]);
  const now = Date.now();
  const row = emptySummary(token);
  row.chain = chain;
  row.name = v.name || info?.name || pairs[0]?.baseToken.name || '';
  row.symbol = v.symbol || info?.symbol || pairs[0]?.baseToken.symbol || '';
  row.decimals = v.decimals;
  row.launchpad = v.record ? 'pons' : v.fourMeme ? 'fourmeme' : chain === 'robinhood' ? 'robinhood' : 'bnb';
  row.creator = v.record?.deployer ?? null;
  const supply = v.totalSupply > 0n ? rawToAmount(v.totalSupply, v.decimals) : null;
  row.totalSupply = supply;
  row.circSupply = supply;

  // DexScreener lists four.meme curves as pairs too; a curve token's own
  // state stays the authority for price, the pair gives socials and stats.
  const best = pairs[0] ?? null;
  const created = pairs.map((p) => p.pairCreatedAt).filter((n): n is number => n !== null);
  row.createdAt = created.length ? Math.min(...created) : null;
  if (row.createdAt === null && (v.record || v.fourMeme)) {
    const seen = launchLookups.get(chain)?.(token) ?? null;
    if (seen) {
      const head = await headBlock(chain);
      row.createdAt = now - Number(head - seen.blockNumber) * meta.blockMs;
    }
  }

  const curve = v.venue === 'pons-curve' || v.venue === 'fourmeme-curve' ? curveOf(v) : null;
  if (curve) {
    const px = curvePrices(curve, usd);
    row.priceSol = px.priceNative;
    row.priceUsd = px.priceUsd;
    row.liquidityUsd = px.liquidityUsd;
    row.bondingCurvePct = curve.progressPct;
    row.poolAddress = curve.address;
    row.dexId = chain === 'robinhood' ? 'pons-v2' : 'fourmeme';
    row.sources.price = 'onchain';
    row.sources.liquidity = 'onchain';
    if (best) row.stats = statsFromPair(best);
  } else if (best) {
    row.priceUsd = best.priceUsd;
    const quoteIsNative = isWrapped(chain, best.quoteToken.address) || best.quoteToken.symbol.toUpperCase() === meta.nativeSymbol;
    row.priceSol = quoteIsNative ? best.priceNative : best.priceUsd !== null && usd ? best.priceUsd / usd : null;
    row.liquidityUsd = best.liquidityUsd;
    row.poolAddress = best.pairAddress;
    row.dexId = v.venue === 'pons-v4' ? 'uniswap-v4' : best.dexId;
    row.stats = statsFromPair(best);
    row.sources.price = 'dexscreener';
    row.sources.liquidity = 'dexscreener';
  } else if (v.venue === 'pons-v4' && v.key) {
    // The probe is denominated in the pool's OTHER currency. Reading it as
    // ETH is only true for a native-paired pool; a USDG or tokenised-stock
    // pair would price the token in that asset and call it ETH, so those
    // stay unpriced (an em dash) until there is a pair-aware quote.
    const pairIsNative = v.record?.pairToken.toLowerCase() === NATIVE_ADDRESS;
    if (pairIsNative) {
      const probe = 10n ** 15n;
      const zeroForOne = v.key.currency0.toLowerCase() !== token;
      const q = await quoteV4(v.key, zeroForOne, probe);
      if (!('error' in q) && q.amountOut > 0n) {
        const priceNative = weiToEth(probe) / rawToAmount(q.amountOut, v.decimals);
        row.priceSol = priceNative;
        row.priceUsd = usd !== null ? priceNative * usd : null;
        row.sources.price = 'onchain';
      }
    }
    row.dexId = 'uniswap-v4';
  } else if (v.v3) {
    row.poolAddress = v.v3.pool;
    row.dexId = chain === 'robinhood' ? 'uniswap-v3' : 'pancake-v3';
  } else if (v.v2) {
    row.poolAddress = v.v2.pair;
    row.dexId = 'pancake-v2';
  }
  if (row.marketCapUsd === null && row.priceUsd !== null && supply !== null) {
    row.marketCapUsd = row.priceUsd * supply;
    row.fdvUsd = best?.fdv ?? row.marketCapUsd;
    row.sources.marketCap = 'derived';
  } else if (best) {
    // `||` not `??`: a provider's 0 is an unknown, not a fact (poolRow does the same).
  row.marketCapUsd = best.marketCap || best.fdv;
    row.fdvUsd = best.fdv;
    row.sources.marketCap = 'dexscreener';
  }

  row.imageUrl = best?.imageUrl ?? info?.imageUrl ?? null;
  const socials = best?.socials ?? null;
  row.socials = { twitter: socials?.twitter ?? info?.twitter ?? null, telegram: socials?.telegram ?? info?.telegram ?? null, website: socials?.website ?? info?.website ?? null, dexPaid: socials?.dexPaid ?? false };
  if (best || info) row.sources.socials = best ? 'dexscreener' : 'geckoterminal';
  if (info) {
    row.holders = info.holders;
    row.top10Pct = info.top10Pct;
    row.sources.holders = 'geckoterminal';
    row.sources.concentration = 'geckoterminal';
  }
  row.fetchedAt = now;
  return row;
}

export function stateFromVenue(v: Venue): EvmTokenState {
  const pool =
    v.venue === 'pons-v4' && v.key
      ? { address: null, dexId: 'uniswap-v4', key: v.key, feeTier: null }
      : v.v3
        ? { address: v.v3.pool, dexId: v.chain === 'robinhood' ? 'uniswap-v3' : 'pancake-v3', key: null, feeTier: v.v3.feeTier }
        : v.v2
          ? { address: v.v2.pair, dexId: 'pancake-v2', key: null, feeTier: null }
          : null;
  // four.meme's helper does not carry the creator, so the deployer is UNKNOWN
  // there unless the launch index saw it — never the zero address, which reads
  // as "renounced". `phase` is Pons vocabulary; on four.meme it is simply
  // "on the curve" (0) or "graduated" (2).
  const indexedDeployer = launchLookups.get(v.chain)?.(v.token)?.deployer ?? null;
  const launch = v.record
    ? { deployer: v.record.deployer as string | null, phase: v.record.phase, launchedAt: null }
    : v.fourMeme
      ? { deployer: indexedDeployer, phase: v.fourMeme.liquidityAdded ? 2 : 0, launchedAt: v.fourMeme.launchTime > 0n ? Number(v.fourMeme.launchTime) * 1000 : null }
      : null;
  return {
    chain: v.chain,
    address: v.token,
    venue: v.venue,
    curve: curveOf(v),
    pool,
    launch,
    decimals: v.decimals,
    totalSupply: v.totalSupply > 0n ? v.totalSupply.toString() : null,
    untradable: v.untradable,
  };
}

export async function detail(chain: EvmChainKind, address: string): Promise<EvmTokenDetail> {
  const token = lower(address);
  const meta = EVM_CHAIN_META[chain];
  const [s, v, pairs] = await Promise.all([summary(chain, token, { holders: true }), resolveVenue(chain, token), ds.tokenPairsOn(meta.dexscreenerChain, token)]);
  const pools: TokenPool[] = pairs.map((p) => ({
    address: p.pairAddress,
    dexId: `${p.dexId}${p.labels.length ? ` ${p.labels.join(' ')}` : ''}`,
    label: `${p.baseToken.symbol || '?'}/${p.quoteToken.symbol || '?'}`,
    liquidityUsd: p.liquidityUsd,
    quoteMint: p.quoteToken.address || null,
  }));
  const curve = curveOf(v);
  // On Pons the curve IS a per-token contract and doubles as the pair id.
  // On four.meme `curve.address` is the ONE shared TokenManager2, so it must
  // never be shown as this token's pool — dedupe on the token itself there.
  const curveKey = chain === 'robinhood' ? curve?.address.toLowerCase() : v.token.toLowerCase();
  if ((v.venue === 'pons-curve' || v.venue === 'fourmeme-curve') && curve && curveKey && !pools.some((p) => p.address.toLowerCase().startsWith(curveKey))) {
    pools.unshift({ address: chain === 'robinhood' ? curve.address : v.token, dexId: chain === 'robinhood' ? 'pons-v2' : 'fourmeme', label: `${s.symbol || '?'} curve`, liquidityUsd: s.liquidityUsd, quoteMint: null });
  }
  const warnings: string[] = [];
  if (v.untradable) warnings.push(v.untradable);
  if (s.priceUsd === null) warnings.push(`No USD price: the pair is not quoted in ${meta.nativeSymbol}${chain === 'robinhood' ? ' or USDG' : ''}, or no provider has indexed it yet.`);
  return {
    summary: s,
    state: stateFromVenue(v),
    pools,
    holders: s.holders !== null || s.top10Pct !== null ? { count: s.holders, top10Pct: s.top10Pct } : null,
    warnings,
  };
}

// ── Candles ───────────────────────────────────────────────────────────

const SUB_MINUTE = new Set<CandleInterval>(['1s', '5s', '15s']);

export async function candles(chain: EvmChainKind, address: string, interval: CandleInterval, limit = 500): Promise<CandleSeries> {
  const token = lower(address);
  const meta = EVM_CHAIN_META[chain];
  const network = meta.geckoNetwork as gt.GtNetwork;
  const [v, s] = await Promise.all([resolveVenue(chain, token), summary(chain, token)]);
  const base: CandleSeries = { mint: token, interval, unit: 'usd', candles: [], source: 'none', supplyForMcap: s.circSupply, note: null };
  let pool: string | null = null;
  if (v.venue === 'pons-curve' && v.curve) pool = v.curve.address;
  else if (v.venue === 'fourmeme-curve') pool = null; // GeckoTerminal has no pool for a four.meme curve; try its token pools below
  else if (s.poolAddress && !s.poolAddress.includes(':')) pool = s.poolAddress;
  if (!pool) {
    const pools = await gt.poolsForTokenOn(network, token, { priority: true });
    pool = pools[0]?.address ?? null;
  }
  if (!pool) return { ...base, note: v.venue === 'fourmeme-curve' ? 'No candle history yet — GeckoTerminal indexes a four.meme curve once it has traded for a while.' : 'No pool or curve to chart yet.' };
  const effective: CandleInterval = SUB_MINUTE.has(interval) ? '1m' : interval;
  let rows = await gt.ohlcvOn(network, pool, effective, limit, { priority: true });
  let note: string | null = null;
  // A pool minutes old has no candles yet, but the curve it graduated from
  // has the whole pre-graduation history. Show that rather than a blank chart.
  if (!rows?.length && v.record?.curve && v.record.curve.toLowerCase() !== pool.toLowerCase()) {
    const curveRows = await gt.ohlcvOn(network, v.record.curve, effective, limit, { priority: true });
    if (curveRows?.length) {
      rows = curveRows;
      note = 'Showing the launch curve’s history — the pool has no candles yet.';
    }
  }
  if (!rows?.length) {
    // An empty series while GeckoTerminal is parked is the park, not the
    // market: saying "no history yet" there would be a guess stated as fact.
    const cooling = cooldownRemainingMs('geckoterminal');
    if (cooling > 0) return { ...base, note: `GeckoTerminal is rate-limited (retrying in ${Math.ceil(cooling / 1000)}s).` };
    return { ...base, note: curveOf(v) ? 'No candles yet — GeckoTerminal indexes a launch curve a few minutes after its first trades.' : 'No candle history from GeckoTerminal for this pool yet.' };
  }
  return {
    ...base,
    candles: normaliseCandles(rows),
    source: 'geckoterminal',
    effectiveInterval: effective,
    note: SUB_MINUTE.has(interval) ? `Showing 1m candles — sub-minute bars need this app’s own ${meta.shortName} feed, which is not built yet.` : note,
  };
}

/** Head block, memoised half a second — every column asks. */
export async function headBlock(chain: EvmChainKind): Promise<bigint> {
  const n = await memo<string>(`evm:head:${chain}`, 500, async () => (await client(chain).getBlockNumber()).toString());
  return n ? BigInt(n) : await client(chain).getBlockNumber();
}

export { ponsSpot, CHAINS, type CurveState };
