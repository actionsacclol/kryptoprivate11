// Wallet Scout — where a manual scan reads its trades from, per chain.
//
// Every chain already has a historical reader that names the trader, so this
// is wiring, not decoding:
//
//   Solana     swap-api.pump.fun's per-token trade pages, newest-first with a
//              cursor. There is no per-wallet or whole-chain route there, so
//              the scan is "the tokens people are trading right now", taken
//              from the Discover columns where round trips actually close
//              (Graduating, Migrated) and then New. pump.fun only — the other
//              rails have no keyless history route, and this says so.
//   Robinhood  CurveBuy/CurveSell logs across every Pons curve, by block range
//              — the same no-address topic scan the Observatory polls with.
//   BNB        four.meme's TokenPurchase/TokenSale logs from the manager, by
//              block range, filtered to BNB-quoted curves exactly as the live
//              path is: a trade in another quote asset is not BNB spent.
//
// Each source yields units (a token, a block chunk) with the calls it spent
// and anything it could not read. It never spends funds, and every call goes
// through the same provider queue as the rest of the app — a scan waits
// behind a chart, never the other way round.

import type { Address } from 'viem';
import * as market from '../data/market';
import * as pumpswap from '../data/providers/pumpswap';
import { headBlock } from '../evm/market';
import { fetchAllCurveTrades, shortError } from '../evm/pons';
import * as fourmeme from '../evm/fourmeme';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import { SOLANA_SCAN_MAX_PAGES, SOLANA_SCAN_MAX_TOKENS, tradeId, type ScoutChain } from '@shared/walletScout';
import type { ScanBatch, ScanSource } from './scoutScan';

/**
 * Tokens per Solana scan, and pages per token. At most 180 calls, paced by
 * the `pumpswap` provider gap in http.ts (2 s — swap-api.pump.fun blocks an
 * IP for ~35 s past roughly 22 requests in a short window, measured
 * 2026-09-21). Most tokens need one page, so a scan is usually two minutes;
 * the page says so. The constants live in shared/walletScout so the page
 * and this file cannot disagree about what a scan is.
 */
const SOLANA_MAX_TOKENS = SOLANA_SCAN_MAX_TOKENS;
const SOLANA_MAX_PAGES = SOLANA_SCAN_MAX_PAGES;

const solana: ScanSource = async function* (ctx) {
  let mints: string[] = [];
  try {
    // Graduating and Migrated first: a token that has been trading for a
    // while is where positions open AND close. New is seconds-old tokens,
    // mostly one buy per address, so it fills whatever room is left.
    const columns = await Promise.all([market.discover('graduating', 40), market.discover('migrated', 40), market.discover('new', 40)]);
    const seen = new Set<string>();
    for (const rows of columns) {
      for (const r of rows) {
        if (r.launchpad !== 'pumpfun' || !r.mint || seen.has(r.mint)) continue;
        seen.add(r.mint);
        mints.push(r.mint);
      }
    }
  } catch (e) {
    yield { trades: [], calls: 0, units: 0, note: `Could not list tokens to scan — ${(e as Error).message}` };
    return;
  }
  if (!mints.length) {
    yield { trades: [], calls: 0, units: 0, note: 'No pump.fun tokens to scan — Discover is empty (is network data on in Settings?).' };
    return;
  }
  mints = mints.slice(0, SOLANA_MAX_TOKENS);
  let first = true;
  for (const mint of mints) {
    if (ctx.cancelled()) return;
    const r = await pumpswap.recentTrades(mint, ctx.sinceMs, SOLANA_MAX_PAGES);
    const batch: ScanBatch = {
      trades: r.trades.map((t) => ({
        address: t.user,
        mint,
        isBuy: t.isBuy,
        native: t.sol,
        tokens: t.base,
        at: t.ts,
        tx: tradeId(t.tx, mint, t.user, t.isBuy),
      })),
      calls: r.calls,
    };
    if (first) {
      batch.units = mints.length;
      first = false;
    }
    if (!r.ok) batch.note = `pump.fun trade history: ${r.message}`;
    yield batch;
  }
};

/** Block chunk per getLogs. Robinhood's topic-filtered curve scan returns
 *  ~15 logs per 300 blocks, so 5,000 is a few hundred; four.meme's manager
 *  is far busier and its reader caps itself at 3,000. */
const CHUNK: Record<EvmChainKind, bigint> = { robinhood: 5_000n, bnb: 3_000n };
const MIN_CHUNK = 250n;

/** Quote asset per four.meme token, read once per scan — see the BNB note. */
async function bnbNativeOnly(tokens: string[], cache: Map<string, boolean>): Promise<number> {
  const ask = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !cache.has(t));
  let calls = 0;
  for (let i = 0; i < ask.length; i += 150) {
    const slice = ask.slice(i, i + 150) as Address[];
    calls += 1;
    try {
      const infos = await fourmeme.infos(slice);
      for (const t of slice) {
        const info = infos.get(t);
        // Unknown stays unknown and is skipped below — a guess about the
        // quote asset would price BNB against USDT.
        if (info) cache.set(t, fourmeme.isNativeQuote(info));
      }
    } catch {
      /* the whole slice stays unknown */
    }
  }
  return calls;
}

const evm = (chain: EvmChainKind): ScanSource =>
  async function* (ctx) {
    const meta = EVM_CHAIN_META[chain];
    let head: bigint;
    try {
      head = await headBlock(chain);
    } catch (e) {
      yield { trades: [], calls: 1, units: 0, note: `${meta.name} RPC: ${shortError(e)}` };
      return;
    }
    const span = BigInt(Math.ceil((ctx.hours * 3_600_000) / meta.blockMs));
    const from = head > span ? head - span : 0n;
    let chunk = CHUNK[chain];
    const quoteCache = new Map<string, boolean>();
    let done = 0;
    // Units are re-stated on every batch: a halved chunk changes how many are
    // left, and a denominator fixed at the start would show 40 of 20.
    const unitsLeft = (start: bigint): number => done + Number((head - start) / chunk) + 1;
    const atOf = (block: bigint): number => ctx.now - Number(head - block) * meta.blockMs;
    let start = from;
    while (start <= head) {
      if (ctx.cancelled()) return;
      const end = start + chunk - 1n < head ? start + chunk - 1n : head;
      const batch: ScanBatch = { trades: [], calls: 1, units: unitsLeft(start) };
      try {
        if (chain === 'robinhood') {
          for (const t of await fetchAllCurveTrades(start, end)) {
            const curve = t.curve.toLowerCase();
            batch.trades.push({
              address: t.trader,
              mint: curve,
              isBuy: t.isBuy,
              native: Number(t.quoteWei) / 1e18,
              tokens: Number(t.tokensRaw),
              at: atOf(t.blockNumber),
              tx: tradeId(`${t.txHash}:${t.logIndex}`, curve, t.trader, t.isBuy),
            });
          }
        } else {
          const trades = await fourmeme.fetchTrades(start, end);
          batch.calls += await bnbNativeOnly(trades.map((t) => t.token), quoteCache);
          for (const t of trades) {
            const token = t.token.toLowerCase();
            if (quoteCache.get(token) !== true) continue;
            batch.trades.push({
              address: t.trader,
              mint: token,
              isBuy: t.isBuy,
              native: Number(t.quoteWei) / 1e18,
              tokens: Number(t.tokensRaw),
              at: atOf(t.blockNumber),
              tx: tradeId(`${t.txHash}:${t.logIndex}`, token, t.trader, t.isBuy),
            });
          }
        }
      } catch (e) {
        const why = shortError(e);
        // A range the endpoint will not serve in one go: halve and retry the
        // SAME start, the way Discover's activity scan does. Anything else is
        // one chunk lost, said in the status rather than swallowed.
        if (/exceeds limit|too many|response size|log cap|size limit/i.test(why) && chunk > MIN_CHUNK) {
          chunk /= 2n;
          continue;
        }
        batch.note = `Blocks ${start}–${end} could not be read (${why.slice(0, 80)})`;
      }
      yield batch;
      done += 1;
      start = end + 1n;
    }
  };

export function sourceFor(chain: ScoutChain): ScanSource {
  return chain === 'solana' ? solana : evm(chain);
}
