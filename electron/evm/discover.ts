// EVM Discover — the four columns per chain, built from the chain first.
//
//   New         — launchpad launches, newest first, with live curve state.
//   Graduating  — curves with recent buys, ranked by progress to graduation.
//   Migrated    — launches that graduated onto their DEX, newest first.
//   Trending    — GeckoTerminal's trending pools for the network.
//
// Each chain keeps a rolling in-memory index of its launchpad's launch
// events (Pons `TokenLaunched` on Robinhood, four.meme `TokenCreate` on BNB),
// filled in chunks on first use and then only for the blocks since the last
// look. Curve state is read by multicall and memoised a few seconds, so a
// Discover refresh costs a handful of RPC round trips rather than hundreds.

import type { Address } from 'viem';
import * as gt from '../data/providers/geckoterminal';
import { cooldownRemainingMs, memo } from '../data/http';
import { logClient, rpcRecentlyLimited } from './client';
import { PONS_CURVE_ABI } from './chain';
import { curveStates, fetchGraduations, fetchLaunches as fetchPonsLaunches, launchRecord, poolKeyFor, shortError, toShared as ponsToShared, tokenMeta as ponsMeta, type PonsLaunch } from './pons';
import * as fourmeme from './fourmeme';
import { ADDR_BSC } from './bsc';
import { tokenMeta } from './erc20';
import { quoteV4 } from './uniswap';
import { nativeUsd } from './prices';
import { curveRow, headBlock, poolRow, setLaunchLookup } from './market';
import { logger } from '../system/logger';
import { emptySummary, type DiscoverColumn, type TokenSummary } from '@shared/market';
import { EVM_CHAIN_META, NATIVE_ADDRESS, USDG_ADDRESS, rawToAmount, weiToEth, type EvmChainKind } from '@shared/evm';

/** The CurveBuy event, for the no-address activity scan on Robinhood. */
const CURVE_BUY_EVENT = PONS_CURVE_ABI.find((x) => x.type === 'event' && x.name === 'CurveBuy') as Extract<(typeof PONS_CURVE_ABI)[number], { type: 'event'; name: 'CurveBuy' }>;

interface Windows {
  indexWindow: bigint;
  indexFirst: bigint;
  gradLookback: bigint;
  migratedLookback: bigint;
}

/**
 * Block windows per chain, sized by block time. Robinhood: index ≈ 5.5 h
 * (first fill ≈ 1.7 h), activity ≈ 5 min, migrations ≈ 2.5 h. BNB: the free
 * publicnode endpoint answers `eth_getLogs` only for roughly the last
 * 10,000 blocks (~75 min) — older is "archive, needs a token" (measured
 * 2026-09-09) — so every BNB window stays inside 9,000 blocks (~67 min).
 * A user's own endpoint (Settings → EVM chains) lifts nothing here yet; the
 * windows are fixed, so the four.meme columns cover the last hour.
 */
const WINDOWS: Record<EvmChainKind, Windows> = {
  robinhood: { indexWindow: 200_000n, indexFirst: 60_000n, gradLookback: 3_000n, migratedLookback: 90_000n },
  // BNB's activity window is the whole reachable range, not five minutes:
  // four.meme launches ~20 a minute and almost all of them die at 0 %, so a
  // short lookback sees only newborns and the Graduating column comes back
  // empty while real climbers are trading (measured 2026-09-09: 700 blocks
  // → 0 rows, 9,000 blocks → 9 tokens at or above 3 %).
  //
  // The old 9,000 everywhere was NOT a property of the chain — it was
  // publicnode's archive wall, which 403s past roughly 9,000 blocks and so
  // capped the whole index at about 67 minutes. Logs now go through the
  // capability map to an archival endpoint (10,000 blocks per query,
  // inclusive), so the ceiling is gone. 40,000 blocks is about 5 hours at
  // 450 ms. `gradLookback` stays smaller on purpose: `fetchTrades` scans the
  // manager unfiltered and a single 3,000-block query already returns around
  // 10,000 logs, so widening that one buys rows at the cost of hitting the
  // result cap.
  bnb: { indexWindow: 40_000n, indexFirst: 20_000n, gradLookback: 20_000n, migratedLookback: 40_000n },
};
const NEW_POOL = 80;

interface Launch {
  token: Address;
  /** Pons: the curve contract. four.meme: the manager (one for all). */
  curve: Address;
  /** null when the launch predates the index — unknown, never the zero address. */
  deployer: Address | null;
  pairToken: Address;
  blockNumber: bigint;
  name?: string;
  symbol?: string;
}

interface Index {
  launches: Launch[];
  byCurve: Map<string, Launch>;
  byToken: Map<string, Launch>;
  scannedTo: bigint;
}

const indexes = new Map<EvmChainKind, Index>();
const indexing = new Map<EvmChainKind, Promise<Index>>();

async function scan(chain: EvmChainKind, from: bigint, to: bigint): Promise<Launch[]> {
  if (chain === 'robinhood') {
    return (await fetchPonsLaunches(from, to)).map((l: PonsLaunch) => ({ token: l.token, curve: l.curve, deployer: l.deployer, pairToken: l.pairToken, blockNumber: l.blockNumber }));
  }
  return (await fourmeme.fetchLaunches(from, to)).map((l) => ({ token: l.token, curve: l.token, deployer: l.creator, pairToken: NATIVE_ADDRESS as Address, blockNumber: l.blockNumber, name: l.name, symbol: l.symbol }));
}

async function ensureIndex(chain: EvmChainKind, head: bigint): Promise<Index> {
  const running = indexing.get(chain);
  if (running) return running;
  const w = WINDOWS[chain];
  const p = (async () => {
    try {
      let idx = indexes.get(chain);
      // A long idle would otherwise ask for every block since the last scan.
      // BNB's public endpoint refuses logs older than ~10k blocks, so a
      // catch-up that starts below reach throws forever and the columns stay
      // dead until a restart. Past the window, start over from a fresh fill.
      if (idx && head - idx.scannedTo > w.indexWindow) {
        logger.info(`evm discover ${chain}: index is ${Number(head - idx.scannedTo)} blocks behind — refilling`);
        indexes.delete(chain);
        idx = undefined;
      }
      if (!idx) {
        const from = head > w.indexFirst ? head - w.indexFirst : 0n;
        const launches = await scan(chain, from, head);
        idx = { launches, byCurve: new Map(), byToken: new Map(), scannedTo: head };
        for (const l of launches) {
          idx.byCurve.set(l.curve, l);
          idx.byToken.set(l.token, l);
        }
        indexes.set(chain, idx);
        logger.info(`evm discover ${chain}: indexed ${launches.length} launches from ${Number(head - from)} blocks`);
        return idx;
      }
      if (head > idx.scannedTo) {
        const floor = head > w.indexWindow ? head - w.indexWindow : 0n;
        const from = idx.scannedTo + 1n > floor ? idx.scannedTo + 1n : floor;
        const fresh = await scan(chain, from, head);
        for (const l of fresh) {
          if (idx.byToken.has(l.token)) continue;
          idx.launches.push(l);
          idx.byCurve.set(l.curve, l);
          idx.byToken.set(l.token, l);
        }
        idx.scannedTo = head;
        const cutoff = head - w.indexWindow;
        if (idx.launches.length && idx.launches[0].blockNumber < cutoff) {
          idx.launches = idx.launches.filter((l) => l.blockNumber >= cutoff);
          idx.byCurve = new Map(idx.launches.map((l) => [l.curve, l]));
          idx.byToken = new Map(idx.launches.map((l) => [l.token, l]));
        }
      }
      return idx;
    } finally {
      indexing.delete(chain);
    }
  })();
  indexing.set(chain, p);
  return p;
}

const tradeable = (l: Launch): boolean => l.pairToken === NATIVE_ADDRESS || l.pairToken === USDG_ADDRESS.toLowerCase();

async function metaFor(chain: EvmChainKind, tokens: Address[]) {
  const key = `evm:meta:${chain}:${tokens.map((t) => t.slice(2, 10)).sort().join(',')}`;
  const hit = await memo(key, 300_000, () => (chain === 'robinhood' ? ponsMeta(tokens) : tokenMeta(chain, tokens)));
  return hit ?? new Map<string, { name: string; symbol: string; decimals: number; totalSupply: bigint }>();
}

// ── Robinhood (Pons) ──────────────────────────────────────────────────

async function ponsStates(curves: Address[]) {
  const key = `evm:states:robinhood:${curves.map((c) => c.slice(2, 10)).sort().join(',')}`;
  const hit = await memo(key, 3_000, () => curveStates(curves));
  return hit ?? new Map<string, Awaited<ReturnType<typeof curveStates>> extends Map<string, infer V> ? V : never>();
}

async function ponsRows(launches: Launch[], head: bigint, usd: number | null): Promise<Array<{ row: TokenSummary; progress: number }>> {
  const [states, meta] = await Promise.all([ponsStates(launches.map((l) => l.curve)), metaFor('robinhood', launches.map((l) => l.token))]);
  const out: Array<{ row: TokenSummary; progress: number }> = [];
  for (const l of launches) {
    const s = states.get(l.curve);
    const m = meta.get(l.token);
    if (!s || !m || s.graduated) continue;
    const shared = ponsToShared(s);
    out.push({ row: curveRow('robinhood', l, shared, m, usd, head), progress: shared.progressPct });
  }
  return out;
}

async function ponsActive(idx: Index, head: bigint): Promise<Set<string>> {
  let lookback = WINDOWS.robinhood.gradLookback;
  const active = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const from = head > lookback ? head - lookback : 0n;
    try {
      const logs = await logClient('robinhood').getLogs({ event: CURVE_BUY_EVENT, fromBlock: from, toBlock: head });
      for (const l of logs) active.add(l.address.toLowerCase());
      return active;
    } catch (e) {
      const msg = shortError(e);
      if (/exceeds limit/i.test(msg) && lookback > 500n) {
        lookback /= 2n;
        continue;
      }
      logger.warn(`evm discover robinhood: curve activity scan failed — ${msg}`);
      break;
    }
  }
  for (const l of idx.launches.slice(-200)) active.add(l.curve);
  return active;
}

/** Run `fn` over `items` a few at a time. The public RPC's bucket is small:
 *  a burst of one call per row 429s the host and the whole column comes back
 *  empty, which reads as "nothing graduated". */
async function pooled<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function ponsMigrated(n: number, idx: Index, head: bigint, usd: number | null): Promise<TokenSummary[]> {
  const from = head > WINDOWS.robinhood.migratedLookback ? head - WINDOWS.robinhood.migratedLookback : 0n;
  // Read a few more than asked: the non-ETH-paired pools are dropped below.
  const all = (await fetchGraduations(from, head)).reverse().slice(0, n * 2);
  if (!all.length) return [];
  const allRecords = await pooled(all, 4, (g) => launchRecord(g.token).catch(() => null));
  // Pons lets a launch pair against USDG or a tokenised stock, and roughly
  // half do. The probe below is denominated in the pool's OTHER currency, so
  // pricing one of those as ETH overstates it by whatever that token is
  // worth — a 20× market cap on an NVDA-paired pool. Only native-ETH pools
  // are listed here; the rest are shown on their token page, not priced.
  const keep: Array<{ g: (typeof all)[number]; r: NonNullable<(typeof allRecords)[number]> }> = [];
  for (let i = 0; i < all.length && keep.length < n; i++) {
    const r = allRecords[i];
    if (r && r.phase === 2 && r.pairToken.toLowerCase() === NATIVE_ADDRESS) keep.push({ g: all[i], r });
  }
  if (!keep.length) return [];
  const grads = keep.map((k) => k.g);
  const records = keep.map((k) => k.r);
  const tokens = grads.map((g) => g.token);
  const meta = await metaFor('robinhood', tokens);
  const probe = 10n ** 15n;
  const quotes = await pooled(records, 4, (r) => quoteV4(poolKeyFor(r), poolKeyFor(r).currency0.toLowerCase() !== r.token, probe));
  const now = Date.now();
  return grads.map((g, i) => {
    const m = meta.get(g.token);
    const r = records[i];
    const q = quotes[i];
    const row = emptySummary(g.token);
    row.chain = 'robinhood';
    row.name = m?.name ?? '';
    row.symbol = m?.symbol ?? '';
    row.decimals = m?.decimals ?? 18;
    row.launchpad = 'pons';
    row.creator = r?.deployer ?? null;
    const launch = idx.byToken.get(g.token);
    row.createdAt = now - Number(head - (launch?.blockNumber ?? g.blockNumber)) * EVM_CHAIN_META.robinhood.blockMs;
    const supply = m ? rawToAmount(m.totalSupply, m.decimals) : 1_000_000_000;
    row.totalSupply = supply;
    row.circSupply = supply;
    if (q && !('error' in q) && q.amountOut > 0n && m) {
      const priceNative = weiToEth(probe) / rawToAmount(q.amountOut, m.decimals);
      row.priceSol = priceNative;
      row.priceUsd = usd !== null ? priceNative * usd : null;
      row.marketCapUsd = row.priceUsd !== null ? row.priceUsd * supply : null;
      row.fdvUsd = row.marketCapUsd;
      row.sources = { price: 'onchain', marketCap: 'derived' };
    }
    // What the graduation swept, doubled — the pool's size AT GRADUATION,
    // not now. Tagged 'derived' so the card says where it came from instead
    // of implying a live reading.
    row.liquidityUsd = usd !== null ? weiToEth(g.sweptQuote) * usd * 2 : null;
    if (row.liquidityUsd !== null) row.sources = { ...row.sources, liquidity: 'derived' };
    row.dexId = 'uniswap-v4';
    row.fetchedAt = now;
    return row;
  });
}

// ── BNB (four.meme) ───────────────────────────────────────────────────

async function fourInfos(tokens: Address[]) {
  const key = `evm:states:bnb:${tokens.map((t) => t.slice(2, 10)).sort().join(',')}`;
  const hit = await memo(key, 3_000, () => fourmeme.infos(tokens));
  return hit ?? new Map<string, fourmeme.FourMemeInfo>();
}

async function fourRows(launches: Launch[], head: bigint, usd: number | null, opts: { includeGraduated?: boolean } = {}): Promise<Array<{ row: TokenSummary; progress: number; info: fourmeme.FourMemeInfo }>> {
  const [infos, meta] = await Promise.all([fourInfos(launches.map((l) => l.token)), metaFor('bnb', launches.map((l) => l.token))]);
  const out: Array<{ row: TokenSummary; progress: number; info: fourmeme.FourMemeInfo }> = [];
  for (const l of launches) {
    const i = infos.get(l.token);
    const m = meta.get(l.token) ?? (l.name || l.symbol ? { name: l.name ?? '', symbol: l.symbol ?? '', decimals: 18, totalSupply: 0n } : null);
    if (!i || !fourmeme.isFourMeme(i) || !m) continue;
    if (i.liquidityAdded && !opts.includeGraduated) continue;
    if (!fourmeme.isNativeQuote(i)) continue;
    const shared = fourmeme.toShared(i);
    out.push({ row: curveRow('bnb', l, shared, m, usd, head), progress: shared.progressPct, info: i });
  }
  return out;
}

async function fourActive(idx: Index, head: bigint): Promise<{ tokens: Set<string>; degraded: string | null }> {
  const from = head > WINDOWS.bnb.gradLookback ? head - WINDOWS.bnb.gradLookback : 0n;
  const tokens = new Set<string>();
  try {
    for (const t of await fourmeme.fetchTrades(from, head)) tokens.add(t.token);
    return { tokens, degraded: null };
  } catch (e) {
    // The fallback is the newest launches, which are all at 0 % and are then
    // removed by the progress filter — so the column would come back empty
    // while claiming 'ok'. Say what happened instead.
    const why = shortError(e);
    logger.warn(`evm discover bnb: activity scan failed — ${why}`);
    for (const l of idx.launches.slice(-200)) tokens.add(l.token);
    return { tokens, degraded: `BNB RPC could not read the trade window (${why.slice(0, 60)}) — showing recent launches only.` };
  }
}

// ── Columns ───────────────────────────────────────────────────────────

async function newColumn(chain: EvmChainKind, n: number, head: bigint, usd: number | null): Promise<TokenSummary[]> {
  const idx = await ensureIndex(chain, head);
  // On BNB `tradeable` cannot pre-filter: four.meme's TokenCreate does not
  // carry the quote asset, so every launch is indexed as native and only the
  // helper knows the truth. About 16 % are actually BNB-quoted (measured over
  // 1,448 launches), so slicing 80 candidates before that filter capped the
  // column at ~12 rows however many were asked for. Take a proportional pool.
  const pool = chain === 'bnb' ? Math.min(600, Math.max(NEW_POOL, Math.ceil(n / 0.16))) : NEW_POOL;
  const newest = [...idx.launches].filter(tradeable).slice(-pool).reverse();
  const rows = chain === 'robinhood' ? await ponsRows(newest, head, usd) : await fourRows(newest, head, usd);
  return rows.slice(0, n).map((r) => r.row);
}

async function graduatingColumn(chain: EvmChainKind, n: number, head: bigint, usd: number | null): Promise<{ rows: TokenSummary[]; degraded: string | null }> {
  const idx = await ensureIndex(chain, head);
  const scan = chain === 'robinhood' ? { tokens: await ponsActive(idx, head), degraded: null } : await fourActive(idx, head);
  const active = scan.tokens;
  const byKey = chain === 'robinhood' ? idx.byCurve : idx.byToken;
  const candidates = [...active].map((k) => byKey.get(k)).filter((l): l is Launch => !!l && tradeable(l));
  // BNB's public endpoint only serves logs ~10k blocks back, so the launch
  // index reaches about an hour — and a four.meme token that has climbed
  // toward graduation is usually OLDER than that. Dropping it for want of an
  // index entry empties the column exactly when it matters, so a token that
  // is trading right now is a candidate on its own; its state comes from the
  // platform's helper and its age renders as unknown.
  if (chain === 'bnb') {
    for (const token of active) {
      if (byKey.has(token)) continue;
      candidates.push({ token: token as Address, curve: ADDR_BSC.fourMemeManager, deployer: null, pairToken: NATIVE_ADDRESS, blockNumber: 0n });
    }
  }
  for (const l of idx.launches.slice(-40)) if (tradeable(l) && !candidates.includes(l)) candidates.push(l);
  const capped = candidates.slice(0, 400);
  const rows = chain === 'robinhood' ? await ponsRows(capped, head, usd) : await fourRows(capped, head, usd);
  return {
    rows: rows
    .filter((r) => r.progress >= 3)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, n)
      .map((r) => r.row),
    degraded: scan.degraded,
  };
}

async function migratedColumn(chain: EvmChainKind, n: number, head: bigint, usd: number | null): Promise<TokenSummary[]> {
  const idx = await ensureIndex(chain, head);
  if (chain === 'robinhood') return ponsMigrated(n, idx, head, usd);
  // four.meme graduates are found from the DEX side, never from the launch
  // index. A curve needs 18 BNB to graduate and the index only reaches ~67
  // minutes (publicnode refuses older logs), so a token that launches AND
  // graduates inside that window essentially never exists — the column was
  // structurally empty, the same defect the Graduating column had. Measured
  // 2026-09-09: 0 graduates among 1,448 indexed launches, while GeckoTerminal's
  // PancakeSwap v2 listing held live four.meme graduates.
  const pools: gt.NewPool[] = [];
  try {
    pools.push(...(await gt.poolsForDexOn('bsc', 'pancakeswap_v2', 1)));
    pools.push(...(await gt.newPoolsOn('bsc', 1)));
  } catch (e) {
    logger.warn(`evm discover bnb: graduated-pool listing failed — ${shortError(e)}`);
  }
  const byToken = new Map<string, gt.NewPool>();
  for (const p of pools) {
    const t = p.baseMint?.toLowerCase();
    if (t && !byToken.has(t)) byToken.set(t, p);
  }
  // Also consider anything the index saw graduate inside its own window.
  const indexed = [...idx.launches].filter(tradeable).slice(-200).reverse();
  const infos = await fourInfos([...byToken.keys(), ...indexed.map((l) => l.token)].slice(0, 240) as Address[]);
  const out: TokenSummary[] = [];
  for (const [token, info] of infos) {
    if (!fourmeme.isFourMeme(info) || !info.liquidityAdded || !fourmeme.isNativeQuote(info)) continue;
    // Price a GRADUATED token from its live pool, never from the curve: the
    // curve's last price and raised funds are frozen at the graduation fill,
    // so every graduate would otherwise show the same market cap and the same
    // "liquidity" (the 18 BNB it raised).
    const pool = byToken.get(token);
    const row = pool ? poolRow('bnb', pool) : null;
    if (!row) continue;
    row.launchpad = 'fourmeme';
    row.bondingCurvePct = null;
    out.push(row);
    if (out.length >= n) break;
  }
  return out;
}

async function trendingColumn(chain: EvmChainKind, n: number): Promise<TokenSummary[]> {
  const meta = EVM_CHAIN_META[chain];
  const pools = await gt.trendingPoolsOn(meta.geckoNetwork as gt.GtNetwork, 1);
  const rows: TokenSummary[] = [];
  const seen = new Set<string>();
  const skip = new Set([meta.wrappedNative.toLowerCase(), USDG_ADDRESS.toLowerCase(), '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d']);
  for (const p of pools) {
    const row = poolRow(chain, p);
    if (!row || seen.has(row.mint) || skip.has(row.mint)) continue;
    seen.add(row.mint);
    rows.push(row);
    if (rows.length >= n) break;
  }
  return rows;
}

/** The last rows a column served. A 429 storm must not blank a column that
 *  was full a second ago — show what we had, with the reason. */
const lastGood = new Map<string, TokenSummary[]>();

export async function discover(chain: EvmChainKind, column: DiscoverColumn, limit: number): Promise<{ rows: TokenSummary[]; message: string }> {
  const n = Math.min(80, Math.max(5, limit || 40));
  const key = `evm:discover:${chain}:${column}:${n}`;
  const keep = (r: { rows: TokenSummary[]; message: string }): { rows: TokenSummary[]; message: string } => {
    if (r.rows.length) lastGood.set(key, r.rows);
    else if (r.message !== 'ok') {
      const prev = lastGood.get(key);
      if (prev?.length) return { rows: prev, message: r.message };
    }
    return r;
  };
  const hit = await memo<{ rows: TokenSummary[]; message: string }>(key, 4_000, async () => {
    try {
      const [head, usd] = await Promise.all([headBlock(chain), nativeUsd(chain)]);
      switch (column) {
        case 'new':
          return { rows: await newColumn(chain, n, head, usd), message: 'ok' };
        case 'graduating': {
          const g = await graduatingColumn(chain, n, head, usd);
          return { rows: g.rows, message: g.degraded ?? 'ok' };
        }
        case 'migrated': {
          const rows = await migratedColumn(chain, n, head, usd);
          // BNB's graduates are found through GeckoTerminal's pool listings
          // (the launch index reaches barely an hour and a curve takes far
          // longer to graduate), so a parked provider means "we could not
          // look", not "nothing graduated".
          const cooling = chain === 'bnb' ? cooldownRemainingMs('geckoterminal') : 0;
          return { rows, message: !rows.length && cooling > 0 ? `Rate limited by GeckoTerminal (retrying in ${Math.ceil(cooling / 1000)}s).` : 'ok' };
        }
        case 'trending': {
          const rows = await trendingColumn(chain, n);
          // An empty page while GeckoTerminal is parked is the park, not the
          // market — say so, and the renderer keeps the last good rows.
          const cooling = cooldownRemainingMs('geckoterminal');
          return { rows, message: !rows.length && cooling > 0 ? `Rate limited by GeckoTerminal (retrying in ${Math.ceil(cooling / 1000)}s).` : 'ok' };
        }
      }
    } catch (e) {
      // shortError, never `.message`: a viem transport error carries the
      // full RPC URL — with the user's Alchemy key in its path.
      const msg = shortError(e);
      logger.warn(`evm discover ${chain} ${column}: ${msg}`);
      if (rpcRecentlyLimited(chain) || /429|Too Many/i.test(msg)) {
        return { rows: [], message: `The public ${EVM_CHAIN_META[chain].name} RPC is rate-limiting this app — add your own endpoint in Settings → EVM chains for a steady feed.` };
      }
      return { rows: [], message: `${EVM_CHAIN_META[chain].name} RPC: ${msg.slice(0, 120)}` };
    }
  });
  return keep(hit ?? { rows: [], message: 'no data' });
}

/** A token's launch, when the chain's rolling index has it. */
export function launchFor(chain: EvmChainKind, token: string): { blockNumber: bigint; deployer?: string | null } | null {
  return indexes.get(chain)?.byToken.get(token.toLowerCase()) ?? null;
}

/** The token a Pons curve sells, when the rolling index has the launch. */
export function tokenForCurve(chain: EvmChainKind, curve: string): string | null {
  const idx = indexes.get(chain);
  if (!idx) return null;
  const hit = idx.byCurve.get(curve) ?? idx.byCurve.get(curve.toLowerCase());
  return hit ? hit.token.toLowerCase() : null;
}

for (const chain of ['robinhood', 'bnb'] as EvmChainKind[]) setLaunchLookup(chain, (t) => launchFor(chain, t));

/** Warm a chain's launch index so the first Discover paint has rows. */
export function prewarm(chain: EvmChainKind): void {
  void headBlock(chain)
    .then((h) => ensureIndex(chain, h))
    .catch(() => undefined);
}

export function indexSize(chain: EvmChainKind): number {
  return indexes.get(chain)?.launches.length ?? 0;
}
