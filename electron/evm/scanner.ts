// The EVM launch scanner — one per chain, and they never touch.
//
// The Solana Observatory reads the SniperEngine. Each EVM chain now has the
// same thing of its own: a cursor, a poll loop, its own counts, and its own
// launches. Two scanners run side by side and share nothing but this file's
// code, so a stall on BNB cannot make Robinhood look busy and a Robinhood
// number can never appear under a BNB heading.
//
// ─── What it measures, and what it refuses to ────────────────────────────
//
// Every launch is tracked for its first ~2 minutes and its trades counted:
// buys, sells, unique buyers, native in, whether the creator sold. Those are
// FACTS — things we watched happen.
//
// It does not score them. `shared/odds.ts` is pump's model, fit and validated
// on pump launches, and the number it produces is the observed graduation rate
// of pump launches that looked alike. Pons and four.meme are different curves
// with different fees and different traders (Pons taxes the launch block at
// 99% per recipient), so that number would describe a population these tokens
// are not in. Each chain earns a score when it has a corpus of its own; see
// shared/evmScan.ts.
//
// ─── Cost ────────────────────────────────────────────────────────────────
//
// Two getLogs per poll per chain, over the blocks since the last one. Poll
// intervals are set from block time, not from a wish: Robinhood mints every
// 100 ms and BNB every 450 ms, so a 4 s / 6 s cadence stays a block range a
// public endpoint will serve. A chain switched off in Settings polls nothing.

import fs from 'node:fs';
import path from 'node:path';
import type { Address } from 'viem';
import { EVM_CHAIN_META, curveProgressPct, type EvmChainKind } from '@shared/evm';
import {
  EVM_SCAN_LAUNCH_CAP,
  EVM_SCAN_TRACK_MS,
  emptyScanStatus,
  type EvmLaunchWindow,
  type EvmScanLaunch,
  type EvmScanStatus,
} from '@shared/evmScan';
import {
  BUYER_BUCKETS,
  DEFAULT_EVM_RUNNER_ALERTS,
  EVM_RUNNER_FLAG_CAP,
  OUTCOME_HORIZON_MS,
  bucketOf,
  emptyModel,
  evmRunnerNotification,
  evmRunnerVerdict,
  judge,
  type BuyerBucket,
  type EvmRunnerAlerts,
  type EvmRunnerFlag,
  type RunnerCall,
  type RunnerModel,
} from '@shared/evmRunners';
import { RunnerRateLimit } from '@shared/runners';
import { logger } from '../system/logger';
import * as copyTrade from '../engine/copyTrade';
import { balanceOf as erc20BalanceOf } from './erc20';
import { shortError } from './pons';
import * as scout from '../engine/walletScout';
import { tradeId } from '@shared/walletScout';
import * as recorder from '../engine/recorder';
import { headBlock } from './market';
import * as fourmeme from './fourmeme';
import {
  curveStates,
  fetchAllCurveTrades,
  fetchGraduations,
  fetchLaunches as fetchPonsLaunches,
  launchRecord as ponsLaunchRecord,
  tokenMeta as ponsMeta,
} from './pons';

/** Poll cadence per chain, from block time. */
const POLL_MS: Record<EvmChainKind, number> = { robinhood: 4_000, bnb: 6_000 };

/** Never ask for more than this many blocks in one go, however far behind. */
const MAX_BLOCK_SPAN: Record<EvmChainKind, bigint> = { robinhood: 2_000n, bnb: 400n };

const WINDOWS: Array<60 | 120> = [60, 120];

/** Failed polls on one range before stepping over it. */
const MAX_RANGE_RETRIES = 4;

/** Tokens whose ending we ask about in one multicall. */
const MAX_SETTLE_BATCH = 150;
/** Rounds a BNB launch may go unanswered before it is dropped as not-ours. */
const UNREADABLE_STRIKES = 30;

// ── Which asset a four.meme curve is quoted in ──────────────────────────
//
// Read once per token from the helper and memoised: the answer never
// changes for a token. Bounded, oldest-first, because the scanner sees a
// thousand launches an hour.
const quoteKind = new Map<string, 'native' | 'other'>();
const QUOTE_KIND_CAP = 8_000;

async function readQuoteKinds(tokens: string[]): Promise<void> {
  const ask = [...new Set(tokens.map((t) => t.toLowerCase()))].filter((t) => !quoteKind.has(t)).slice(0, MAX_SETTLE_BATCH);
  if (!ask.length) return;
  try {
    const infos = await fourmeme.infos(ask as Address[]);
    for (const t of ask) {
      const i = infos.get(t);
      if (!i) continue; // unknown stays unknown — asked again next time it is seen
      quoteKind.set(t, fourmeme.isNativeQuote(i) ? 'native' : 'other');
    }
    while (quoteKind.size > QUOTE_KIND_CAP) {
      const oldest = quoteKind.keys().next().value;
      if (oldest === undefined) break;
      quoteKind.delete(oldest);
    }
  } catch (e) {
    logger.warn(`evm scanner bnb: could not read quote assets — ${shortError(e)}`);
  }
}

export interface Tracked {
  launch: EvmScanLaunch;
  /** Lowercased curve address (Pons) or token (four.meme) — the trade key. */
  key: string;
  creator: string;
  buys: Array<{ trader: string; native: number; at: number }>;
  sells: Array<{ trader: string; native: number; at: number }>;
  /** Windows already closed and written to `launch.windows`. */
  done: Set<number>;
  curvePct: number | null;
  /** See `EvmScanLaunch.quote`. Undefined until read. */
  quote?: 'native' | 'other';
}

/** A launch whose first minute is measured, waiting to see how it ends. */
interface Pending {
  token: string;
  bucket: BuyerBucket;
  seenAt: number;
  graduated: boolean;
  /** The chain could not tell us how this one ended. Never counted. */
  unreadable?: boolean;
  /**
   * Rounds in a row four.meme's helper returned nothing for this token. A
   * token that is not the helper's (a different manager, a revert) would
   * otherwise be re-asked every round forever and, past 150 of them, starve
   * the settle. Dropped — uncounted, logged — after UNREADABLE_STRIKES.
   */
  strikes?: number;
  /**
   * This one survived a restart, so the live event feed cannot be trusted for
   * it: a graduation during the downtime was never seen. Settling it asks the
   * chain directly instead. See `settle`.
   */
  restored?: boolean;
}

interface ChainState {
  status: EvmScanStatus;
  /** Observed graduation rates, per buyer bucket. Persisted. */
  model: RunnerModel;
  /** Launches measured but not yet settled — see OUTCOME_HORIZON_MS. */
  pending: Map<string, Pending>;
  cursor: bigint | null;
  /** Consecutive failed polls on the SAME range. See the skip in `poll`. */
  failures: number;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  /** The settle in flight, if one is. See `settle` — they never overlap. */
  settling: Promise<void> | null;
  tracked: Map<string, Tracked>;
  /** Trade key → token, so a chain-wide trade log finds its launch. */
  byKey: Map<string, string>;
  launches: EvmScanLaunch[];
  /** Flagged runner calls, newest first, kept for the session — the launches
   *  behind them are purged at 130 s. See EvmRunnerFlag. */
  flagged: EvmRunnerFlag[];
  /** Rolling-hour cap on notifications. Per chain, like everything else. */
  limiter: RunnerRateLimit;
}

export interface ScannerHost {
  /** Is this chain switched on in Settings? */
  enabled(chain: EvmChainKind): boolean;
  emit(chain: EvmChainKind): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  /**
   * This chain's runner filter. Read per call rather than cached, so a user
   * changing the floor in Settings changes the next call, not the next
   * restart.
   */
  runnerAlerts?(chain: EvmChainKind): EvmRunnerAlerts;
  /**
   * A measurement window just closed on a tracked launch — this chain's
   * equivalent of Solana's `launchUpdate`, and the event user scripts on this
   * chain react to. Fired AFTER the 60 s runner call is attached, so a script
   * sees the call on the same launch the flag was made on.
   */
  onLaunchWindow?(chain: EvmChainKind, launch: EvmScanLaunch): void;
  /** Desktop notification, through the engine's own switch and chat push.
   *  `target` says what it is ABOUT: the click opens that token, and a
   *  Discord webhook for the chain links to it. */
  notify?(title: string, body: string, target?: { mint: string; chain: EvmChainKind }): void;
}

let host: ScannerHost | null = null;
const state: Record<EvmChainKind, ChainState> = {
  robinhood: fresh('robinhood'),
  bnb: fresh('bnb'),
};

function fresh(chain: EvmChainKind): ChainState {
  return {
    status: emptyScanStatus(chain),
    model: emptyModel(chain),
    pending: new Map(),
    cursor: null,
    failures: 0,
    timer: null,
    polling: false,
    settling: null,
    tracked: new Map(),
    byKey: new Map(),
    launches: [],
    flagged: [],
    limiter: new RunnerRateLimit(),
  };
}

export function attach(h: ScannerHost): void {
  host = h;
}

export function status(chain: EvmChainKind): EvmScanStatus {
  return { ...state[chain].status, enabled: host?.enabled(chain) ?? false, tracking: state[chain].tracked.size };
}

/** Runner calls this chain flagged this session, newest first. */
export function flagged(chain: EvmChainKind): EvmRunnerFlag[] {
  return state[chain].flagged;
}

export function launches(chain: EvmChainKind): EvmScanLaunch[] {
  return state[chain].launches.map((l) => ({ ...l, windows: [...l.windows] }));
}

export function start(chain: EvmChainKind): { ok: boolean; message: string } {
  const meta = EVM_CHAIN_META[chain];
  if (!host?.enabled(chain)) return { ok: false, message: `${meta.name} is turned off in Settings` };
  const st = state[chain];
  if (st.timer) return { ok: true, message: `Already watching ${meta.name}` };
  // The session counters restart; the MODEL does not. It is months of
  // observed outcomes, and a Stop/Start would otherwise throw it away.
  st.status = { ...emptyScanStatus(chain), running: true, enabled: true, startedAt: Date.now() };
  st.cursor = null;
  st.timer = setInterval(() => void poll(chain), POLL_MS[chain]);
  void poll(chain);
  recorder.record('evm_scan_start', { chain, launchpad: meta.launchpadLabel, chainId: meta.id, receivedAt: Date.now() });
  host.log('info', `evm scanner ${chain}: watching ${meta.launchpadLabel} launches`);
  host.emit(chain);
  return { ok: true, message: `Watching ${meta.name}` };
}

export function stop(chain: EvmChainKind): { ok: boolean; message: string } {
  const st = state[chain];
  if (st.timer) clearInterval(st.timer);
  st.timer = null;
  st.status = { ...st.status, running: false };
  recorder.record('evm_scan_stop', { chain, receivedAt: Date.now() });
  host?.log('info', `evm scanner ${chain}: stopped`);
  host?.emit(chain);
  return { ok: true, message: `Stopped watching ${EVM_CHAIN_META[chain].name}` };
}

export function stopAll(): void {
  for (const c of Object.keys(state) as EvmChainKind[]) if (state[c].timer) stop(c);
}

/** Test seam: forget everything, as if the app had just started. */
export function _reset(): void {
  stopAll();
  state.robinhood = fresh('robinhood');
  state.bnb = fresh('bnb');
}

/** Test seam: the launches this chain is still waiting on an outcome for. */
export function _pending(chain: EvmChainKind): Array<{ token: string; bucket: BuyerBucket; seenAt: number; graduated: boolean; restored?: boolean }> {
  return [...state[chain].pending.values()].map((p) => ({ ...p }));
}

/** Test seam: put a launch into the pending set, as a closed 60 s window does. */
export function _addPending(chain: EvmChainKind, p: { token: string; bucket: BuyerBucket; seenAt: number; graduated: boolean }): void {
  state[chain].pending.set(p.token.toLowerCase(), { ...p, token: p.token.toLowerCase() });
}

async function poll(chain: EvmChainKind): Promise<void> {
  const st = state[chain];
  // Never let two polls overlap: the second would re-ingest the first's
  // blocks and double every count on the page.
  if (st.polling || !st.timer) return;
  await pollOnce(chain);
}

/**
 * Test seam: one poll, and then whatever settle it started, both awaited.
 *
 * The scanner's real loop is a timer that fires-and-forgets; a test that
 * pins what a poll DOES needs to know when it has finished doing it.
 */
export async function _poll(chain: EvmChainKind): Promise<void> {
  const st = state[chain];
  if (!st.polling) await pollOnce(chain);
  await st.settling;
}

async function pollOnce(chain: EvmChainKind): Promise<void> {
  const st = state[chain];
  st.polling = true;
  try {
    // Throws when the endpoint will not answer; the catch below records it as
    // lastError rather than letting the interval die silently.
    const head = await headBlock(chain);
    // First poll starts AT the head: a scanner exists to watch what happens
    // from now, and back-filling would report old launches as new ones.
    if (st.cursor === null) st.cursor = head;
    if (head <= st.cursor) {
      st.status = { ...st.status, lastBlock: Number(st.cursor), behind: 0, lastPollAt: Date.now(), lastError: null };
      closeWindows(chain);
      host?.emit(chain);
      return;
    }
    const from = st.cursor + 1n;
    const span = head - from + 1n;
    const to = span > MAX_BLOCK_SPAN[chain] ? from + MAX_BLOCK_SPAN[chain] - 1n : head;

    await ingestLaunches(chain, from, to);
    await ingestTrades(chain, from, to);
    if (chain === 'robinhood') await ingestGraduations(from, to);

    st.cursor = to;
    st.failures = 0;
    st.status = {
      ...st.status,
      lastBlock: Number(to),
      behind: Number(head - to),
      lastPollAt: Date.now(),
      lastError: null,
    };
    closeWindows(chain);
    host?.emit(chain);
  } catch (e) {
    // viem's message embeds the endpoint URL (and with it a configured key);
    // the short form names the failure without it. Found by audit 2026-09-11.
    const why = shortError(e);
    st.failures += 1;
    // The cursor is only advanced on success, which is right — a failed poll
    // must not skip blocks. But it means ONE range the endpoint will never
    // serve wedges the scanner forever, retrying it every few seconds. After
    // a few tries, step past it and say so: losing a window of launches is
    // recoverable, a permanently stuck scanner is not.
    if (st.failures >= MAX_RANGE_RETRIES && st.cursor !== null) {
      const skipped = MAX_BLOCK_SPAN[chain];
      st.cursor += skipped;
      st.failures = 0;
      host?.log('warn', `evm scanner ${chain}: skipped ${skipped} block(s) after ${MAX_RANGE_RETRIES} failed polls — ${why}`);
    }
    st.status = { ...st.status, lastError: why.slice(0, 160), lastPollAt: Date.now() };
    logger.warn(`evm scanner ${chain}: poll failed — ${why}`);
    host?.emit(chain);
  } finally {
    st.polling = false;
  }
}

async function ingestLaunches(chain: EvmChainKind, from: bigint, to: bigint): Promise<void> {
  const st = state[chain];
  const now = Date.now();
  if (chain === 'robinhood') {
    const rows = await fetchPonsLaunches(from, to);
    if (!rows.length) return;
    const meta = await ponsMeta(rows.map((r) => r.token));
    for (const r of rows) {
      const m = meta.get(r.token.toLowerCase());
      rememberCurve(r.curve.toLowerCase(), r.token.toLowerCase());
      track(chain, {
        chain,
        token: r.token.toLowerCase(),
        name: m?.name ?? '',
        symbol: m?.symbol ?? '',
        creator: r.deployer.toLowerCase(),
        seenAt: now,
        blockNumber: Number(r.blockNumber),
        windows: [],
        graduatedAt: null,
        quote: 'native',
      }, r.curve.toLowerCase());
    }
  } else {
    const rows = await fourmeme.fetchLaunches(from, to);
    for (const r of rows) {
      track(chain, {
        chain,
        token: r.token.toLowerCase(),
        name: r.name,
        symbol: r.symbol,
        creator: r.creator.toLowerCase(),
        seenAt: now,
        blockNumber: Number(r.blockNumber),
        windows: [],
        graduatedAt: null,
        quote: null,
      }, r.token.toLowerCase());
    }
    // One multicall for the poll's new launches: which asset each is quoted
    // in decides whether its money columns mean anything.
    if (rows.length) {
      await readQuoteKinds(rows.map((r) => r.token));
      for (const r of rows) stampQuote(chain, r.token.toLowerCase());
    }
  }
}

function stampQuote(chain: EvmChainKind, token: string): void {
  const kind = quoteKind.get(token);
  if (!kind) return;
  const st = state[chain];
  const tr = st.tracked.get(token);
  if (tr) {
    tr.quote = kind;
    tr.launch.quote = kind;
  } else {
    const l = st.launches.find((x) => x.token === token);
    if (l) l.quote = kind;
  }
}

function track(chain: EvmChainKind, launch: EvmScanLaunch, key: string): void {
  const st = state[chain];
  if (st.tracked.has(launch.token)) return;
  // Recorded in the SAME shape as the Solana tape — `tape_create` with a
  // `chain` field — so one corpus covers all three chains, the recorder's
  // 30-minute launch window applies unchanged, and analysis written for the
  // pump day-files reads these with a filter rather than a rewrite.
  recorder.record('tape_create', {
    chain,
    mint: launch.token,
    name: launch.name,
    symbol: launch.symbol,
    creator: launch.creator,
    curve: key,
    slot: launch.blockNumber,
    receivedAt: launch.seenAt,
  });
  st.tracked.set(launch.token, {
    launch,
    key,
    creator: launch.creator,
    buys: [],
    sells: [],
    done: new Set(),
    curvePct: null,
  });
  st.byKey.set(key, launch.token);
  st.launches.unshift(launch);
  if (st.launches.length > EVM_SCAN_LAUNCH_CAP) st.launches.length = EVM_SCAN_LAUNCH_CAP;
  st.status = { ...st.status, launchesSeen: st.status.launchesSeen + 1 };
}

// ── Copy trading on EVM ─────────────────────────────────────────────────
//
// A followed wallet's curve trades come through here, every poll: the
// scanner already decodes every Pons and four.meme trade with its trader.
// A leader is copied while a token is on its curve — the pool trades after
// graduation are not ingested here. A sell is mirrored by the SHARE they
// sold, which needs their remaining balance: one gated read, only for a
// followed wallet.

/** Curve → token, kept past the 130 s tracking window so an older token's trades still resolve. */
const curveToToken = new Map<string, string>();
const CURVE_MAP_CAP = 8_000;
let curveLookup: ((chain: EvmChainKind, curve: string) => string | null) | null = null;
/** Main wires the Discover index in, so a curve the scanner never saw launch still resolves. */
export function setCurveLookup(fn: (chain: EvmChainKind, curve: string) => string | null): void {
  curveLookup = fn;
}
function rememberCurve(curve: string, token: string): void {
  curveToToken.set(curve, token);
  while (curveToToken.size > CURVE_MAP_CAP) {
    const oldest = curveToToken.keys().next().value;
    if (oldest === undefined) break;
    curveToToken.delete(oldest);
  }
}

/** Last price the feed saw, native per token, by `${chain}:${token}`. */
const lastPrice = new Map<string, { price: number; at: number }>();
const LAST_PRICE_CAP = 8_000;
export function lastPriceNative(chain: EvmChainKind, token: string): number | null {
  return lastPrice.get(`${chain}:${token.toLowerCase()}`)?.price ?? null;
}
function notePrice(chain: EvmChainKind, token: string, quoteWei: bigint, tokensRaw: bigint, now: number): number | null {
  if (tokensRaw <= 0n || quoteWei <= 0n) return null;
  // Both sides carry 18 decimals on these curves, so the ratio is the price.
  const price = Number(quoteWei) / Number(tokensRaw);
  if (!Number.isFinite(price) || price <= 0) return null;
  lastPrice.set(`${chain}:${token}`, { price, at: now });
  while (lastPrice.size > LAST_PRICE_CAP) {
    const oldest = lastPrice.keys().next().value;
    if (oldest === undefined) break;
    lastPrice.delete(oldest);
  }
  return price;
}

async function forwardCopy(
  chain: EvmChainKind,
  token: string,
  symbol: string,
  trader: string,
  isBuy: boolean,
  native: number,
  tokensRaw: bigint,
  txHash: string,
  price: number | null,
  now: number,
): Promise<void> {
  try {
    let soldFraction: number | null = null;
    if (!isBuy) {
      // Their remaining balance decides the share; unreadable stays null,
      // which the copy engine records as a skipped exit rather than guessing.
      const remaining = await erc20BalanceOf(chain, token as Address, trader as Address);
      const sold = tokensRaw < 0n ? -tokensRaw : tokensRaw;
      const total = sold + remaining;
      soldFraction = total > 0n ? Number((sold * 10_000n) / total) / 10_000 : null;
    }
    copyTrade.onWalletTrade({
      chain,
      wallet: trader.toLowerCase(),
      mint: token,
      symbol,
      isBuy,
      sol: native,
      priceSol: price ?? 0,
      at: now,
      signature: txHash,
      soldFraction,
      tokens: Number(tokensRaw < 0n ? -tokensRaw : tokensRaw) / 1e18,
    });
  } catch (e) {
    logger.warn(`evm scanner ${chain}: could not forward a followed wallet's trade — ${shortError(e)}`);
  }
}

async function ingestTrades(chain: EvmChainKind, from: bigint, to: bigint): Promise<void> {
  const st = state[chain];
  // This used to return early when no launch was being measured. It cannot
  // any more: the Wallet Scout is built from this same feed, and a leaderboard
  // that only sees trades while a fresh launch happens to be in its window
  // would describe snipers and nobody else. The cost is one getLogs per poll,
  // and the scanner only runs while the user has it open.
  const now = Date.now();
  let seen = 0;
  const followed = copyTrade.activeWallets(chain);
  const openCopies = new Set(copyTrade.openMints(chain));
  const symbolOf = (token: string): string => st.tracked.get(token)?.launch.symbol ?? st.launches.find((l) => l.token === token)?.symbol ?? '';

  if (chain === 'robinhood') {
    for (const t of await fetchAllCurveTrades(from, to)) {
      seen += 1;
      // Every trade on the chain feeds the Wallet Scout, not just the ones on
      // launches we happen to be measuring — a leaderboard built only from
      // brand-new tokens would describe snipers and nobody else.
      const curve = t.curve.toLowerCase();
      const rhToken = st.byKey.get(curve);
      // The copy path and the marks need the token behind a curve the
      // scanner may no longer be tracking (or never saw launch).
      const copyToken = rhToken ?? curveToToken.get(curve) ?? curveLookup?.(chain, curve) ?? null;
      if (copyToken) {
        const price = notePrice(chain, copyToken, t.quoteWei, t.tokensRaw, now);
        if (price !== null && openCopies.has(copyToken)) copyTrade.markToMarket(copyToken, price, chain);
        if (followed.size && followed.has(t.trader.toLowerCase())) {
          void forwardCopy(chain, copyToken, symbolOf(copyToken), t.trader, t.isBuy, Number(t.quoteWei) / 1e18, t.tokensRaw, t.txHash, price, now);
        }
      }
      scout.note('robinhood', t.trader, curve, t.isBuy, Number(t.quoteWei) / 1e18, Number(t.tokensRaw), now, tradeId(`${t.txHash}:${t.logIndex}`, curve, t.trader, t.isBuy));
      recorder.record('tape_trade', {
        chain: 'robinhood',
        mint: rhToken ?? t.curve.toLowerCase(),
        curve: t.curve.toLowerCase(),
        user: t.trader.toLowerCase(),
        isBuy: t.isBuy,
        sol: Number(t.quoteWei) / 1e18,
        tokens: Number(t.tokensRaw),
        fee: Number(t.feeWei) / 1e18,
        tax: Number(t.taxWei) / 1e18,
        slot: Number(t.blockNumber),
        sig: t.txHash,
        receivedAt: now,
      });
      const token = rhToken;
      const tr = token ? st.tracked.get(token) : undefined;
      if (!tr) continue;
      const native = Number(t.quoteWei) / 1e18;
      (t.isBuy ? tr.buys : tr.sells).push({ trader: t.trader.toLowerCase(), native, at: now });
    }
  } else {
    const trades = await fourmeme.fetchTrades(from, to);
    // `cost` on a four.meme trade is in the curve's QUOTE asset. The Wallet
    // Scout ranks wallets by native spent, so a trade in another asset is
    // not noted at all — a wallet is not "big" for moving 9,000 of a token
    // that is not BNB. Unknown (the helper did not answer) is skipped too.
    if (trades.length) await readQuoteKinds(trades.map((t) => t.token));
    for (const t of trades) {
      seen += 1;
      const token = t.token.toLowerCase();
      const kind = quoteKind.get(token);
      const amount = Number(t.quoteWei) / 1e18;
      if (kind === 'native') scout.note('bnb', t.trader, token, t.isBuy, amount, Number(t.tokensRaw), now, tradeId(`${t.txHash}:${t.logIndex}`, token, t.trader, t.isBuy));
      // Copies and marks only on a BNB-quoted curve: a USDT price is not a BNB price.
      if (kind === 'native') {
        const price = notePrice(chain, token, t.quoteWei, t.tokensRaw, now);
        if (price !== null && openCopies.has(token)) copyTrade.markToMarket(token, price, chain);
        if (followed.size && followed.has(t.trader.toLowerCase())) {
          void forwardCopy(chain, token, symbolOf(token), t.trader, t.isBuy, amount, t.tokensRaw, t.txHash, price, now);
        }
      }
      recorder.record('tape_trade', {
        chain: 'bnb',
        mint: token,
        user: t.trader.toLowerCase(),
        isBuy: t.isBuy,
        // In the curve's quote asset — see `quoteNative`; BNB only when true.
        sol: amount,
        quoteNative: kind === 'native' ? true : kind === 'other' ? false : null,
        tokens: Number(t.tokensRaw),
        fee: Number(t.feeWei) / 1e18,
        offers: t.offers.toString(),
        funds: t.funds.toString(),
        slot: Number(t.blockNumber),
        sig: t.txHash,
        receivedAt: now,
      });
      const tr = st.tracked.get(token);
      if (!tr) continue;
      if (tr.quote === undefined && kind) {
        tr.quote = kind;
        tr.launch.quote = kind;
      }
      (t.isBuy ? tr.buys : tr.sells).push({ trader: t.trader.toLowerCase(), native: amount, at: now });
    }
  }
  if (seen) st.status = { ...st.status, tradesSeen: st.status.tradesSeen + seen };
}

async function ingestGraduations(from: bigint, to: bigint): Promise<void> {
  const st = state.robinhood;
  const rows = await fetchGraduations(from, to);
  if (!rows.length) return;
  const now = Date.now();
  let n = 0;
  for (const g of rows) {
    const token = g.token.toLowerCase();
    // The pending entry is looked up on its OWN, not through `tracked`.
    //
    // Found by audit 2026-09-11: this loop skipped any token no longer in
    // `tracked`, which `closeWindows` purges at 130 s — so a graduation
    // after that never reached the pending entry, and the launch settled
    // six hours later as a failure. The 6 h horizon was a fiction for every
    // live launch; only restored ones (asked directly) could ever graduate.
    // Every rate on the page was a lower bound of unknown tightness.
    const tr = st.tracked.get(token);
    const p = st.pending.get(token);
    const launch = tr?.launch ?? st.launches.find((l) => l.token === token) ?? null;
    if (!launch && !p) continue; // launched before we were watching
    if ((launch?.graduatedAt ?? null) !== null || p?.graduated) continue; // seen already
    if (p) p.graduated = true;
    markGraduated('robinhood', token, now, { sweptQuote: Number(g.sweptQuote) / 1e18, slot: Number(g.blockNumber), sig: g.txHash });
    n += 1;
  }
}

/**
 * A launch we saw has graduated: the row on the page, the count in the
 * status bar and the tape all learn it here, whichever chain and whichever
 * path (Robinhood's event feed, BNB's settle-time read) found out.
 */
function markGraduated(chain: EvmChainKind, token: string, now: number, ev: { sweptQuote: number; slot: number; sig: string } | null): void {
  const st = state[chain];
  const launch = st.tracked.get(token)?.launch ?? st.launches.find((l) => l.token === token) ?? null;
  if (launch && launch.graduatedAt === null) launch.graduatedAt = now;
  st.status = { ...st.status, graduationsSeen: st.status.graduationsSeen + 1 };
  recorder.record('tape_complete', {
    chain,
    mint: token,
    sweptQuote: ev?.sweptQuote ?? null,
    slot: ev?.slot ?? null,
    sig: ev?.sig ?? null,
    receivedAt: now,
  });
}

/**
 * Close any window whose time has come, and retire launches past the last one.
 *
 * A window is written once and never revised: it is a record of what happened
 * in those seconds, so a late-arriving log does not get to rewrite history.
 */
function closeWindows(chain: EvmChainKind): void {
  const st = state[chain];
  const now = Date.now();
  for (const [token, tr] of st.tracked) {
    const age = now - tr.launch.seenAt;
    for (const w of WINDOWS) {
      if (tr.done.has(w) || age < w * 1000) continue;
      tr.done.add(w);
      const measured = _measure(tr, w);
      tr.launch.windows.push(measured);
      recorder.record('evm_window', { chain, mint: token, ...measured, receivedAt: now });
      // The 60 s window is the one the runner call is made on: enter the
      // launch into the outcome set, and judge it against what this chain has
      // already shown us.
      if (w === 60) {
        // Entered with what is already known: a launch that graduated INSIDE
        // its first minute (0.1 s blocks make that real) has its outcome.
        st.pending.set(token, {
          token,
          bucket: bucketOf(measured.uniqueBuyers),
          seenAt: tr.launch.seenAt,
          graduated: tr.launch.graduatedAt !== null,
        });
        // Save on ENTRY, not only when something settles.
        //
        // Found by running the packaged build 2026-09-11: persisting only on
        // a model change meant nothing reached disk until the first launch
        // settled, which is six hours away on a fresh model — so a restart
        // inside that window still lost everything, which is the exact bug
        // the pending file was added to fix. The write is debounced by 30 s,
        // so a busy chain writes twice a minute, not once a launch.
        schedulePersist();
        const call = judge(st.model, measured.uniqueBuyers);
        tr.launch.call = call;
        if (call.flag) {
          st.status = { ...st.status, callsFlagged: st.status.callsFlagged + 1 };
          host?.log('info', `${chain} runner call: ${tr.launch.symbol || token.slice(0, 8)} — ${call.detail}`);
          // Kept for the session so the Runner alerts panel can list it
          // beside Solana's. The launch itself is purged at 130 s.
          st.flagged.unshift({
            chain,
            token,
            symbol: tr.launch.symbol ?? '',
            name: tr.launch.name ?? '',
            flaggedAt: now,
            uniqueBuyers: measured.uniqueBuyers,
            ratePct: call.ratePct,
            otherRatePct: call.otherRatePct,
            lowerPct: call.lowerPct,
            samples: call.samples,
            detail: call.detail,
          });
          if (st.flagged.length > EVM_RUNNER_FLAG_CAP) st.flagged.length = EVM_RUNNER_FLAG_CAP;
        }
        // The FILTER is a second, separate question from the measurement
        // above: the call is recorded either way, and only the notification
        // is gated. Turning a knob here can never change a number a user is
        // reading on the Observatory.
        const cfg = host?.runnerAlerts?.(chain) ?? DEFAULT_EVM_RUNNER_ALERTS;
        const verdict = evmRunnerVerdict(call, cfg);
        if (verdict.alert && host?.notify && st.limiter.allow(now, cfg.maxPerHour)) {
          const { title, body } = evmRunnerNotification(EVM_CHAIN_META[chain].name, tr.launch.symbol, token, call);
          host.notify(title, body, { mint: token, chain });
        }
      }
      // Scripts on this chain hear the window, whatever it measured. Wrapped
      // because a throwing script host must never stop the scanner: the
      // measurement and its record are the chain's, the fan-out is a consumer.
      try {
        host?.onLaunchWindow?.(chain, tr.launch);
      } catch (e) {
        host?.log('warn', `${chain} scanner: script fan-out failed — ${(e as Error)?.message ?? e}`);
      }
    }
    if (age > EVM_SCAN_TRACK_MS) {
      st.tracked.delete(token);
      st.byKey.delete(tr.key);
    }
  }
  void settle(chain, now);
}

/**
 * Move launches past the horizon out of `pending` and into the model.
 *
 * A launch still inside the horizon is neither a success nor a failure.
 * Counting it as a failure the moment its window closed would drag every rate
 * toward zero and make the newest, best-sampled buckets look worst.
 */
function settle(chain: EvmChainKind, now: number): Promise<void> {
  const st = state[chain];
  // One at a time. `closeWindows` starts this every poll without awaiting
  // it, and a settle still asking the chain (150 restored launches at the
  // gate's 5 rps is ~30 s) was being joined by the next poll's, asking the
  // same tokens over again — up to ~7 deep after a long downtime, ~1,000
  // calls for 150 answers, with the poll's own reads queued behind them.
  // Found by audit 2026-09-11.
  if (st.settling) return st.settling;
  st.settling = settleOnce(chain, now)
    .catch((e) => logger.warn(`evm scanner ${chain}: settle failed — ${shortError(e)}`))
    .finally(() => {
      st.settling = null;
    });
  return st.settling;
}

async function settleOnce(chain: EvmChainKind, now: number): Promise<void> {
  const st = state[chain];
  const due = [...st.pending.values()].filter((p) => p.graduated || now - p.seenAt >= OUTCOME_HORIZON_MS);
  if (!due.length) return;
  // Launches whose "did not graduate" has actually been CHECKED this round.
  // A negative is only ever recorded from this set — see the final loop.
  const verified = new Set<string>();

  // ── four.meme has no graduation EVENT to scan ──────────────────────
  //
  // Pons emits one, so Robinhood's outcomes come from the log feed. four.meme
  // does not: graduation shows up as `liquidityAdded` on the token's info.
  // Until 2026-09-10 this branch did not exist at all, so every BNB launch
  // settled as a failure — 1,387 of them, base rate 0%, and no bucket could
  // ever beat 0%. A model quietly recording false negatives is worse than no
  // model, because it looks like an answer.
  //
  // Asked in one multicall, and only for launches actually settling now.
  if (chain === 'bnb') {
    const ask = due.filter((p) => !p.graduated).slice(0, MAX_SETTLE_BATCH);
    let dropped = 0;
    if (ask.length) {
      try {
        const infos = await fourmeme.infos(ask.map((p) => p.token as Address));
        for (const p of ask) {
          const i = infos.get(p.token);
          // A token the helper could not answer for is left PENDING rather
          // than settled as a failure: unknown is not "did not graduate".
          if (!i) {
            p.unreadable = true;
            p.strikes = (p.strikes ?? 0) + 1;
            if (p.strikes >= UNREADABLE_STRIKES) {
              st.pending.delete(p.token);
              dropped += 1;
            }
            continue;
          }
          p.unreadable = false;
          p.strikes = 0;
          verified.add(p.token);
          if (i.liquidityAdded) {
            p.graduated = true;
            // The page pill, the "Graduated (of seen)" count and the tape
            // were Robinhood-only paths until 2026-09-11; a BNB graduation
            // is only ever learned here, at settle.
            markGraduated('bnb', p.token, now, null);
          }
        }
      } catch (e) {
        // Could not ask at all — settle nothing this round and try again.
        logger.warn(`evm scanner bnb: could not read graduation state — ${shortError(e)}`);
        return;
      }
    }
    if (dropped) logger.warn(`evm scanner bnb: dropped ${dropped} launch(es) four.meme's helper never answered for in ${UNREADABLE_STRIKES} rounds — not counted`);
  }

  // ── A restored launch is verified, never assumed ───────────────────
  //
  // Robinhood's graduations come off the live log feed, so a launch that was
  // pending across a restart has a hole in its evidence exactly the size of
  // the downtime. Settling it on the feed alone would record a false
  // negative — the same class of mistake that made BNB's whole model read
  // 0 %. So each one is asked directly: Pons's factory record carries the
  // phase, and phase 0 is the only one that means "still on the curve".
  if (chain === 'robinhood') {
    // A live launch's negative is the feed's word: it was watched for the
    // whole horizon and no graduation event named it.
    for (const p of due) if (!p.restored) verified.add(p.token);
    const ask = due.filter((p) => p.restored && !p.graduated).slice(0, MAX_SETTLE_BATCH);
    for (const p of ask) {
      try {
        const rec = await ponsLaunchRecord(p.token as Address);
        // Not a Pons token at all: nothing to verify, and nothing to record —
        // so it LEAVES, rather than being tallied as a launch that failed.
        // (Until 2026-09-11 it was kept and counted as a failure; a factory
        // or ABI change would have turned every restored launch into one.)
        if (!rec) {
          st.pending.delete(p.token);
          continue;
        }
        p.unreadable = false;
        p.restored = false;
        verified.add(p.token);
        if (rec.phase >= 1) p.graduated = true;
      } catch {
        // Unknown is not "did not graduate". Leave it pending and ask again.
        p.unreadable = true;
      }
    }
  }

  let changed = false;
  for (const [token, p] of st.pending) {
    if (!p.graduated && now - p.seenAt < OUTCOME_HORIZON_MS) continue;
    // See above: a launch we could not read is not evidence of failure.
    if (p.unreadable) continue;
    // Nor is a launch nobody asked about. The per-round batch cap bounded
    // the ASKING but not the SETTLING, so after a long downtime everything
    // past the first 150 settled as a failure, unasked — an overnight
    // restart would have written ~2,800 false negatives in one poll. Found
    // by audit 2026-09-11. The rest wait for the next round.
    if (!p.graduated && !verified.has(token)) continue;
    const t = st.model.tallies.find((x) => x.bucket === p.bucket);
    if (t) {
      t.settled += 1;
      if (p.graduated) t.graduated += 1;
    }
    st.model.totalSettled += 1;
    if (p.graduated) st.model.totalGraduated += 1;
    st.pending.delete(token);
    changed = true;
  }
  if (changed) schedulePersist();
}

/** Exported for the test: this is the arithmetic the page renders. */
export function _measure(tr: Tracked, windowS: 60 | 120): EvmLaunchWindow {
  const cut = tr.launch.seenAt + windowS * 1000;
  const buys = tr.buys.filter((b) => b.at <= cut);
  const sells = tr.sells.filter((s) => s.at <= cut);
  const inNative = buys.reduce((a, b) => a + b.native, 0);
  const outNative = sells.reduce((a, s) => a + s.native, 0);
  // A Robinhood curve is ETH by construction; a BNB curve is whatever the
  // helper said, and unknown is not BNB.
  const native = tr.quote === 'native' || (tr.quote === undefined && tr.launch.chain === 'robinhood');
  return {
    windowS,
    buys: buys.length,
    sells: sells.length,
    uniqueBuyers: new Set(buys.map((b) => b.trader)).size,
    netNative: native ? inNative - outNative : null,
    volumeNative: native ? inNative : null,
    // Read on demand elsewhere; unknown here rather than guessed from reserves
    // we did not fetch.
    curvePct: tr.curvePct,
    creatorSold: sells.some((s) => s.trader === tr.creator),
  };
}

/**
 * Fill in curve progress for the launches still being measured.
 *
 * Separate from the poll because it is a multicall against the curves rather
 * than a log scan, and it is the one number here that has to be READ rather
 * than counted. Robinhood only — four.meme's progress comes from its own
 * `infos` call, which the token page already makes.
 */
export async function refreshCurveProgress(): Promise<void> {
  const st = state.robinhood;
  const live = [...st.tracked.values()].filter((t) => t.launch.graduatedAt === null);
  if (!live.length) return;
  try {
    const states = await curveStates(live.map((t) => t.key as Address));
    for (const t of live) {
      const s = states.get(t.key);
      t.curvePct = s ? curveProgressPct(s.realQuoteReserve, s.graduationThreshold, s.graduated) : null;
    }
  } catch {
    /* progress is a nice-to-have; a failed read leaves it unknown, not 0 */
  }
}

// ── The model on disk ─────────────────────────────────────────────────
//
// A runner call is worth nothing on a fresh install and everything after a
// month, so the tallies outlive the session.
//
// ─── Pending launches are saved too, and here is why they have to be ────
//
// They were not, originally, and the reasoning was that restoring them would
// re-settle launches whose graduation we never saw. The reasoning was sound
// and the consequence was fatal: a launch is only settled six hours after it
// is seen, so ANY restart inside that window threw away every launch still in
// flight. Measured 2026-09-10 — BNB had settled exactly zero launches in the
// nine hours since its detector was fixed, because the app had restarted
// repeatedly and `pending` lived only in memory. A model that can only learn
// from uninterrupted six-hour stretches does not learn.
//
// The original objection is answered rather than ignored: a restored launch
// carries `restored: true`, and `settle` will not take the event feed's word
// for it. BNB already asked the chain directly at settle time; Robinhood now
// does the same for restored launches, via Pons's own factory record. So the
// outcome comes from the chain either way, and the downtime hole is closed
// instead of being recorded as a failure.

const MODEL_FILE = 'evm-runners.json';

/**
 * How each chain's graduations are detected, stamped into the saved model.
 *
 * A tally is only comparable with one gathered the same way. BNB's outcomes
 * were recorded with NO detector at all until 2026-09-10 — every launch a
 * false negative — so a stored model whose stamp does not match what this
 * build uses is discarded rather than added to. Robinhood's stamp is
 * unchanged, so its records survive.
 */
// Robinhood's stamp changed 2026-09-11 ('events' → 'events-horizon'): the
// outcomes recorded under 'events' heard graduations for only the first
// 130 s of each live launch, so every negative among them is a lower bound,
// not a fact. The 2,330 tallied on the author's machine that day are
// discarded on first start and rebuilt; the pending launches are kept, since
// each is verified against the chain before it is counted.
//
// BNB's stamp changed the same day ('infos-liquidityAdded' → 'infos-verified'):
// the unasked-past-the-cap bug lived in the final loop both chains share, so
// its 598 tallies were no better. Same treatment, same reason.
const GRAD_SOURCE: Record<EvmChainKind, string> = { robinhood: 'events-horizon', bnb: 'infos-verified' };
let modelPath = '';
let modelTimer: NodeJS.Timeout | null = null;
let modelFailure: string | null = null;

export function modelOf(chain: EvmChainKind): RunnerModel {
  return { ...state[chain].model, tallies: state[chain].model.tallies.map((t) => ({ ...t })) };
}

export function initModels(userDataDir: string): void {
  modelPath = path.join(userDataDir, MODEL_FILE);
  modelFailure = null;
  let text: string;
  try {
    text = fs.readFileSync(modelPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') modelFailure = (e as Error).message;
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // An unreadable record is not an empty one: fail closed, keep the file.
    modelFailure = `not valid JSON (${(e as Error).message})`;
    return;
  }
  const obj = raw as { chains?: Record<string, RunnerModel>; pending?: Record<string, Pending[]> };
  if (!obj || typeof obj !== 'object' || !obj.chains) {
    modelFailure = 'not a runner-model file this version understands';
    return;
  }
  for (const chain of Object.keys(state) as EvmChainKind[]) {
    const m = obj.chains[chain] as (RunnerModel & { gradSource?: string }) | undefined;
    if (!m || !Array.isArray(m.tallies)) continue;
    // A file older than the stamp is assumed to have used the ORIGINAL
    // detector, which is right for Robinhood and wrong for BNB — which is
    // exactly the distinction that lets one chain's history survive.
    const stamp = m.gradSource ?? 'events';
    const stale = stamp !== GRAD_SOURCE[chain];
    if (stale) {
      logger.warn(
        `evm scanner ${chain}: discarding ${m.totalSettled ?? 0} stored outcome(s) — they were recorded with "${stamp}" and this build uses "${GRAD_SOURCE[chain]}"`,
      );
    }
    const fresh = emptyModel(chain);
    if (!stale) {
      for (const t of m.tallies) {
        const hit = fresh.tallies.find((x) => x.bucket === t.bucket);
        if (!hit || typeof t.settled !== 'number' || typeof t.graduated !== 'number') continue;
        hit.settled = Math.max(0, t.settled);
        hit.graduated = Math.max(0, Math.min(t.settled, t.graduated));
      }
      fresh.totalSettled = fresh.tallies.reduce((a, t) => a + t.settled, 0);
      fresh.totalGraduated = fresh.tallies.reduce((a, t) => a + t.graduated, 0);
    }
    state[chain].model = fresh;

    // Launches still awaiting an outcome. Restored EVEN when the tallies were
    // discarded: every one is asked the chain directly before it is counted,
    // so the detector that entered it does not matter — only its first-minute
    // bucket does, and that was measured the same way on every build. (Until
    // 2026-09-11 they went with the tallies; the re-stamp that day would have
    // thrown away 2,911 chain-verifiable launches on the author's machine.)
    const saved = obj.pending?.[chain];
    if (!Array.isArray(saved)) continue;
    let restored = 0;
    for (const q of saved) {
      if (typeof q?.token !== 'string' || typeof q.seenAt !== 'number' || typeof q.bucket !== 'number') continue;
      if (!BUYER_BUCKETS.includes(q.bucket as BuyerBucket)) continue;
      if (state[chain].pending.size >= MAX_SAVED_PENDING) break;
      state[chain].pending.set(q.token.toLowerCase(), {
        token: q.token.toLowerCase(),
        bucket: q.bucket as BuyerBucket,
        seenAt: q.seenAt,
        // The feed's verdict from last session is not carried over as a
        // negative: `restored` sends every one of these to the chain for a
        // direct answer before it is counted.
        graduated: q.graduated === true,
        restored: true,
      });
      restored += 1;
    }
    if (restored) {
      logger.info(`evm scanner ${chain}: ${restored} launch(es) still awaiting an outcome, restored and re-verified against the chain`);
    }
  }
}

function schedulePersist(): void {
  if (!modelPath || modelFailure || modelTimer) return;
  modelTimer = setTimeout(() => {
    modelTimer = null;
    persistModels();
  }, 30_000);
}

/**
 * Pendings written per chain. Bounded so a scanner left running through a
 * very busy day cannot grow the file without limit; the oldest are dropped
 * first, because the newest are the ones still inside their horizon.
 */
const MAX_SAVED_PENDING = 5_000;
const capWarned: Record<EvmChainKind, boolean> = { robinhood: false, bnb: false };

export function persistModels(): void {
  if (!modelPath || modelFailure) return;
  const chains: Record<string, RunnerModel> = {};
  const pending: Record<string, Pending[]> = {};
  for (const chain of Object.keys(state) as EvmChainKind[]) {
    chains[chain] = { ...state[chain].model, gradSource: GRAD_SOURCE[chain] } as RunnerModel;
    const all = [...state[chain].pending.values()].sort((a, b) => b.seenAt - a.seenAt);
    // Not counted is honest; not counted SILENTLY is not — but once per
    // crossing, not every 30 s write for as long as it lasts.
    const over = all.length > MAX_SAVED_PENDING;
    if (over && !capWarned[chain]) {
      logger.warn(`evm scanner ${chain}: ${all.length - MAX_SAVED_PENDING} oldest pending launches not saved (cap ${MAX_SAVED_PENDING})`);
    }
    capWarned[chain] = over;
    pending[chain] = all
      .slice(0, MAX_SAVED_PENDING)
      .map((p) => ({ token: p.token, bucket: p.bucket, seenAt: p.seenAt, graduated: p.graduated }));
  }
  try {
    const tmp = `${modelPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chains, pending }), 'utf8');
    fs.renameSync(tmp, modelPath);
  } catch {
    /* losing a tally costs accuracy later, never a trade now */
  }
}

export function flushModels(): void {
  if (modelTimer) {
    clearTimeout(modelTimer);
    modelTimer = null;
  }
  persistModels();
}
