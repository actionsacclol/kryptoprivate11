// Which ERC-20 tokens a wallet holds, found from the chain (2026-10-03).
//
// An EVM node has no "what does this address hold" call, so the app listed
// only tokens a wallet had traded through it. A token SENT to a wallet — from
// another wallet, an exchange, a bridge — never appeared anywhere (live: 2.459
// CAKE in the user's main BNB wallet showed on no page at all).
//
// Found two ways, both read-only:
//   · a short list of each chain's major tokens, checked on every read;
//   · every ERC-20 Transfer whose recipient is the wallet, scanned through the
//     chain's logs endpoint — new blocks first, then back through history to
//     BACKFILL_DAYS. Progress is kept on disk, so a restart resumes.
//
// The scan needs an endpoint that answers a log query with NO contract
// address. Measured 2026-10-03:
//   · Robinhood's official RPC does, 30,000 blocks per query (≈50 min), and
//     answered 201 of them (a week) in 63 s before a 429 — so the backfill
//     goes one window a second and stops at the first refusal;
//   · on BNB no free endpoint does: publicnode demands an address, drpc's
//     free plan refuses the range, 1rpc allows 50 blocks, blockrazor 25, and
//     blockmachine (the scanner's archival logs) spends its whole 60 CU/minute
//     on one such query — scanning there would starve the four.meme index.
//     BNB scans only on the user's OWN endpoint (Settings → EVM chains); with
//     the public ones it is the majors list plus what was traded here.
// A token found here is only a CANDIDATE: holdingsOf reads the balance and
// drops zeros, so a token that was sent in and later moved out shows nothing.
//
// The scan is a cache. An unreadable file loses nothing but time: it is set
// aside (never overwritten) and the scan starts again.

import fs from 'node:fs';
import path from 'node:path';
import type { Hex } from 'viem';
import { client, hasOwnEndpoint, logClient } from './client';
import { TOPIC } from './chain';
import { logger } from '../system/logger';
import type { EvmChainKind } from '@shared/evm';

/** How far back a wallet's incoming transfers are searched. */
const BACKFILL_DAYS: Record<EvmChainKind, number> = { bnb: 3, robinhood: 7 };
/** Measured block times (chains.ts): BNB ~450 ms, Robinhood ~100 ms. */
const BLOCK_MS: Record<EvmChainKind, number> = { bnb: 450, robinhood: 100 };
/** One eth_getLogs window, INCLUSIVE. Robinhood: 30,000 for an address-less
 *  query (measured). BNB: the user's own endpoint, whose limit is unknown — a
 *  window most paid providers accept. */
const CHUNK: Record<EvmChainKind, bigint> = { bnb: 4_999n, robinhood: 29_999n };
/** Windows per run, then the run yields and schedules the next. */
const CHUNKS_PER_RUN: Record<EvmChainKind, number> = { bnb: 20, robinhood: 30 };
/** A gap between windows, so a backfill never crowds the scanner's budget. */
const GAP_MS = 1_000;
/** At most one run per wallet per this long. */
const RUN_EVERY_MS = 30_000;
/** After an endpoint refusal (a 429, a range error), wait this long. */
const BACKOFF_MS = 3 * 60_000;
/** Kept per wallet, newest last; a spam-airdropped wallet stays bounded. */
const MAX_TOKENS = 300;

/**
 * Major tokens, checked on every read. Each address was read on chain
 * (symbol + decimals) on 2026-10-03 before it was listed here.
 */
export const MAJOR_TOKENS: Record<EvmChainKind, readonly string[]> = {
  bnb: [
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', // CAKE
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // ETH (Binance-peg)
    '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', // FDUSD
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
    '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', // XRP
    '0xba2ae424d960c26247dd6c32edc70b295c744c43', // DOGE
    '0x4b0f1812e5df2a09796481ff14017e6005508003', // TWT
    '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd', // LINK
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
  ],
  robinhood: [
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
  ],
};

interface WalletScan {
  /** Highest block scanned (inclusive); null before the first window. */
  hi: string | null;
  /** Lowest block scanned (inclusive). */
  lo: string | null;
  /** Where the backfill stops — set once, at the first run. */
  floor: string | null;
  tokens: string[];
  at: number;
}
interface DiscoveryFile {
  version: 1;
  wallets: Record<string, WalletScan>;
}

let file = '';
let state: DiscoveryFile = { version: 1, wallets: {} };
const running = new Set<string>();
const lastRun = new Map<string, number>();
let onFound: ((chain: EvmChainKind, owner: string) => void) | null = null;
/** A wrapped-coin address per chain, also a major (set by init's caller). */
const extraMajors: Record<EvmChainKind, string[]> = { bnb: [], robinhood: [] };

const key = (chain: EvmChainKind, owner: string): string => `${chain}:${owner.toLowerCase()}`;

/** The chain reads, swappable in tests. */
interface Io {
  head(chain: EvmChainKind): Promise<bigint>;
  logs(chain: EvmChainKind, from: bigint, to: bigint, ownerTopic: Hex): Promise<Array<{ address: string; topics: string[] }>>;
  scans(chain: EvmChainKind): boolean;
  gapMs: number;
  /** Override the backfill depth in blocks (tests); null = BACKFILL_DAYS. */
  backBlocks: bigint | null;
}
const defaultIo: Io = {
  head: (chain) => client(chain).getBlockNumber(),
  logs: async (chain, from, to, ownerTopic) =>
    (await logClient(chain).request({
      method: 'eth_getLogs',
      params: [{ fromBlock: `0x${from.toString(16)}` as Hex, toBlock: `0x${to.toString(16)}` as Hex, topics: [TOPIC.erc20Transfer, null, ownerTopic] }],
    })) as Array<{ address: string; topics: string[] }>,
  scans: (chain) => chain === 'robinhood' || hasOwnEndpoint(chain),
  gapMs: GAP_MS,
  backBlocks: null,
};
let io: Io = { ...defaultIo };
export function _setIo(over: Partial<Io>): void {
  io = { ...defaultIo, ...over };
}

export function init(userDataDir: string, opts?: { onFound?: (chain: EvmChainKind, owner: string) => void; wrapped?: Partial<Record<EvmChainKind, string>> }): void {
  file = path.join(userDataDir, 'evm-token-discovery.json');
  onFound = opts?.onFound ?? null;
  for (const [c, a] of Object.entries(opts?.wrapped ?? {})) if (a) extraMajors[c as EvmChainKind] = [a.toLowerCase()];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryFile;
    state = raw && raw.version === 1 && raw.wallets && typeof raw.wallets === 'object' ? raw : { version: 1, wallets: {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Set aside, never overwritten: it is only a cache, but nobody's file is
      // destroyed by a reader that could not parse it.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* nothing more to do */
      }
      logger.warn(`evm token discovery: ${file} unreadable (${(e as Error).message}) — set aside, scanning again`);
    }
    state = { version: 1, wallets: {} };
  }
}

let persistTimer: NodeJS.Timeout | null = null;
function persist(): void {
  if (!file || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      logger.warn(`evm token discovery: could not save (${(e as Error).message})`);
    }
  }, 2_000);
}

/** Every token worth a balance read for this wallet: found + majors. */
export function candidates(chain: EvmChainKind, owner: string): string[] {
  const found = state.wallets[key(chain, owner)]?.tokens ?? [];
  return [...new Set([...MAJOR_TOKENS[chain], ...extraMajors[chain], ...found])];
}

/** The tokens the scan itself found (tests, diagnostics). */
export function found(chain: EvmChainKind, owner: string): string[] {
  return [...(state.wallets[key(chain, owner)]?.tokens ?? [])];
}

/** How far the backfill has got, 0–1; null before the first run. */
export function progress(chain: EvmChainKind, owner: string): number | null {
  const w = state.wallets[key(chain, owner)];
  if (!w || w.hi === null || w.lo === null || w.floor === null) return null;
  const span = Number(BigInt(w.hi) - BigInt(w.floor));
  return span <= 0 ? 1 : Math.min(1, Number(BigInt(w.hi) - BigInt(w.lo)) / span);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The token contracts that sent this owner an ERC-20 transfer in [from, to]. */
async function scanWindow(chain: EvmChainKind, owner: string, from: bigint, to: bigint): Promise<string[]> {
  const ownerTopic = `0x${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex;
  const logs = await io.logs(chain, from, to, ownerTopic);
  // Three topics = ERC-20. ERC-721 shares the signature with the id indexed
  // as a fourth topic; an NFT is not a balance this page can show.
  return [...new Set(logs.filter((l) => Array.isArray(l.topics) && l.topics.length === 3).map((l) => l.address.toLowerCase()))];
}

/**
 * Scan more of this wallet's history in the background. Safe to call on
 * every read: it runs at most once per RUN_EVERY_MS per wallet, one run at a
 * time, and gives up quietly on an endpoint error (the next read retries).
 */
export function kick(chain: EvmChainKind, owner: string | null | undefined): void {
  if (!owner || !file || !scans(chain)) return;
  const k = key(chain, owner);
  if (running.has(k)) return;
  if (Date.now() - (lastRun.get(k) ?? 0) < RUN_EVERY_MS) return;
  lastRun.set(k, Date.now());
  running.add(k);
  void run(chain, owner.toLowerCase())
    .catch((e) => {
      // Refused or rate-limited: back off, and let the scanner have the budget.
      lastRun.set(k, Date.now() + BACKOFF_MS - RUN_EVERY_MS);
      logger.info(`evm token discovery ${chain} ${owner.slice(0, 10)}…: paused (${(e as Error).message.slice(0, 120)})`);
    })
    .finally(() => running.delete(k));
}

/** Whether this chain can be scanned at all right now (see the header). */
export function scans(chain: EvmChainKind): boolean {
  return io.scans(chain);
}

async function run(chain: EvmChainKind, owner: string): Promise<void> {
  const k = key(chain, owner);
  const head = await io.head(chain);
  const w: WalletScan = state.wallets[k] ?? { hi: null, lo: null, floor: null, tokens: [], at: 0 };
  const back = io.backBlocks ?? BigInt(Math.round((BACKFILL_DAYS[chain] * 86_400_000) / BLOCK_MS[chain]));
  if (w.floor === null) w.floor = (head > back ? head - back : 0n).toString();
  // Closed for longer than the backfill: catch up the last BACKFILL_DAYS only,
  // not every block since — the gap before that is what the majors list is for.
  if (w.hi !== null && head - BigInt(w.hi) > back) w.hi = (head - back).toString();
  state.wallets[k] = w;
  const before = w.tokens.length;
  const add = (ts: string[]) => {
    const set = new Set(w.tokens);
    for (const t of ts) set.add(t);
    w.tokens = [...set].slice(-MAX_TOKENS);
  };
  let budget = CHUNKS_PER_RUN[chain];
  // New blocks first, so a transfer that just arrived shows on the next read.
  while (budget > 0) {
    const from = w.hi === null ? (head > CHUNK[chain] ? head - CHUNK[chain] : 0n) : BigInt(w.hi) + 1n;
    if (from > head) break;
    const to = from + CHUNK[chain] > head ? head : from + CHUNK[chain];
    add(await scanWindow(chain, owner, from, to));
    w.hi = to.toString();
    if (w.lo === null) w.lo = from.toString();
    w.at = Date.now();
    persist();
    budget -= 1;
    if (budget > 0) await sleep(io.gapMs);
  }
  // Then back through history, down to the floor.
  const floor = BigInt(w.floor);
  while (budget > 0 && w.lo !== null && BigInt(w.lo) > floor) {
    const to = BigInt(w.lo) - 1n;
    const from = to - CHUNK[chain] < floor ? floor : to - CHUNK[chain];
    add(await scanWindow(chain, owner, from, to));
    w.lo = from.toString();
    w.at = Date.now();
    persist();
    budget -= 1;
    if (budget > 0) await sleep(io.gapMs);
  }
  if (w.tokens.length > before) {
    logger.info(`evm token discovery ${chain} ${owner.slice(0, 10)}…: ${w.tokens.length - before} new token(s) found`);
    try {
      onFound?.(chain, owner);
    } catch {
      /* a listener never breaks the scan */
    }
  }
  // Not done yet: carry on shortly, without waiting for a page to read again.
  if (BigInt(w.lo ?? '0') > floor) {
    lastRun.set(k, 0);
    setTimeout(() => kick(chain, owner), 2_000).unref?.();
  }
}

/** Flush a pending save now (tests, quit). */
export function flushSync(): void {
  if (!persistTimer || !file) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.warn(`evm token discovery: could not save (${(e as Error).message})`);
  }
}

/** True while a scan for this wallet is in flight (tests). */
export function _busy(chain: EvmChainKind, owner: string): boolean {
  return running.has(key(chain, owner));
}

export function _reset(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  state = { version: 1, wallets: {} };
  running.clear();
  lastRun.clear();
  file = '';
  io = { ...defaultIo };
}
