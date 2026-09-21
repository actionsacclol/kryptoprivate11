// Raydium rail — every new AMM v4 / CPMM pool as it is created, and a live
// tape for the Raydium pool of whichever token the terminal has open.
//
// ─── Creations: subscribe to the fee, not the program ─────────────────
//
// A program-wide `logsSubscribe` on CPMM is ~13 notifications a second
// (measured 2026-09-19, two minutes: 1,598 notifications, 1,087 of them
// swaps, 0 creations). Creations are rare — AMM v4 sees about two a day —
// so a firehose filtered for them is almost all waste. Both programs charge
// a pool-creation fee into ONE fixed wrapped-SOL account, and a subscription
// that mentions that account delivers creations and nothing else. Two
// subscriptions, on the primary socket only (this is a data asset, not a
// race), and the sockets stay idle between pools.
//
// Neither program's logs name the new pool's mints — AMM v4's InitLog names
// the OpenBook market, CPMM emits nothing on creation at all — so a creation
// costs one `getTransaction` for the instruction's account list and one
// `getMultipleAccounts` over those accounts, which yields the pool state and
// its two vaults in one reply. Two calls per creation, a few times an hour.
//
// ─── The tape: one subscription per open pool ─────────────────────────
//
// A CPMM SwapEvent names its pool, so it could be matched out of a
// program-wide stream; an AMM v4 `ray_log` does not, so it cannot. The
// uniform answer is the DBC watcher's: subscribe to the POOL (`mentions`),
// so every notification is known to touch it, and decode from the logs —
// no transaction fetch, because both programs write their swap to a log
// line. For v4 the logged reserves are checked against the pool's own
// before a line is trusted: a transaction can route through two v4 pools.
//
// What this cannot give: a trader. Logs carry no account list and neither
// event names the signer, so ticks have an empty wallet, as LaunchLab's do.

import { FeedManager, type LogNotification } from './feed';
import { getMultipleAccountInfo, getTransaction, resolveAccountKeys, type RawTransaction } from '../chain/rpcClient';
import {
  parsePool,
  parseReserves,
  priceSolFromReserves,
  readPool,
  readReserves,
  solInPool,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  type PoolReserves,
  type RaydiumPoolState,
} from '../data/raydiumAccounts';
import {
  ammV4CreationInLogs,
  cpmmCreationInLogs,
  cpmmEventsOf,
  executedPriceSol,
  rayLogsOf,
  sideAmmV4Swap,
  sideCpmmSwap,
  RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT,
  RAYDIUM_CPMM_CREATE_FEE_ACCOUNT,
  type RaySwapLog,
} from './raydiumDecoder';
import type { LiveAmmPool } from '@shared/raydium';

export { RAYDIUM_AMM_V4_PROGRAM, RAYDIUM_CPMM_PROGRAM };

/**
 * Pools taped at once. The tape allows 8 subscriptions; this is smaller
 * because each pool is a socket per endpoint, and the pubsub budget is ten
 * connections per IP shared with every other feed in the app.
 */
const MAX_POOLS = 2;
/** Creations remembered for the Migrated column. */
const RECENT_POOLS_CAP = 200;
/** Signatures remembered so a socket retry cannot resolve a creation twice. */
const SEEN_CAP = 500;
/** How far a v4 log's reserves may sit from the pool's own before the line
 *  is judged to belong to another pool in the same transaction. */
const RESERVE_TOLERANCE = 0.1;
const MAX_RESOLVES_IN_FLIGHT = 2;
/** A notification arrives at `processed`; getTransaction reads at
 *  `confirmed`, which lands a moment later. Three tries, spaced. */
const RESOLVE_ATTEMPTS = 3;
const RESOLVE_RETRY_MS = 1_500;

export interface RaydiumTick {
  mint: string;
  pool: string;
  /** ALWAYS empty for this rail — logs carry no account list. Not a bug. */
  wallet: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  at: number;
}

export interface RaydiumWatcherHost {
  wssUrls(): string[];
  httpUrl(): string;
  commitment(): 'processed' | 'confirmed';
  onTick(tick: RaydiumTick): void;
  onPool(pool: LiveAmmPool): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Watch {
  mint: string;
  state: RaydiumPoolState;
  feed: FeedManager;
  startedAt: number;
  /** v4 only: the reserves the next logged swap should report. Null until
   *  read, or seeded from the first unambiguous swap. */
  expected: PoolReserves | null;
}

const watches = new Map<string, Watch>();
let host: RaydiumWatcherHost | null = null;
let creationFeeds: FeedManager[] = [];
let recent: LiveAmmPool[] = [];
const seen = new Set<string>();
const seenOrder: string[] = [];
let resolvesInFlight = 0;
let layoutErrors = 0;
let decoded = 0;
let creationsSeen = 0;

export function attach(h: RaydiumWatcherHost): void {
  host = h;
}

export function watchedMints(): string[] {
  return [...watches.keys()];
}

export function layoutErrorCount(): number {
  return layoutErrors;
}

export function decodedCount(): number {
  return decoded;
}

/** Newest first, at most `limit`. Empty while the creation feeds are off. */
export function recentPools(limit: number): LiveAmmPool[] {
  return recent.slice(0, Math.max(0, limit));
}

export function creationsRunning(): boolean {
  return creationFeeds.length > 0;
}

function remember(sig: string): boolean {
  if (seen.has(sig)) return false;
  seen.add(sig);
  seenOrder.push(sig);
  while (seenOrder.length > SEEN_CAP) {
    const old = seenOrder.shift();
    if (old) seen.delete(old);
  }
  return true;
}

// ── Creations ─────────────────────────────────────────────────────────

/** Open the two creation subscriptions. Idempotent. */
export function startCreations(): void {
  const h = host;
  if (!h || creationFeeds.length) return;
  const primary = h.wssUrls()[0];
  if (!primary) return;
  const open = (feeAccount: string, program: string, label: string): FeedManager => {
    const feed = new FeedManager(
      [primary],
      h.commitment(),
      {
        onLogs: (n) => onCreationLogs(n, program),
        onState: () => undefined,
        onSubscribeError: (sockHost, message) => h.log('warn', `Raydium ${label}: ${sockHost} rejected the creation subscription: ${message} (retrying)`),
      },
      feeAccount,
    );
    feed.start();
    return feed;
  };
  creationFeeds = [
    open(RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT, RAYDIUM_AMM_V4_PROGRAM, 'v4'),
    open(RAYDIUM_CPMM_CREATE_FEE_ACCOUNT, RAYDIUM_CPMM_PROGRAM, 'CPMM'),
  ];
  h.log('info', 'Raydium: watching for new AMM v4 and CPMM pools');
}

export function stopCreations(): void {
  for (const f of creationFeeds) {
    try {
      f.stop();
    } catch {
      /* a dead socket must not throw into the caller */
    }
  }
  creationFeeds = [];
}

function onCreationLogs(n: LogNotification, program: string): void {
  // The fee account is touched by creations and, in principle, by anything
  // that sends it SOL. The logs say which: v4 writes an InitLog, CPMM logs
  // an Initialize* instruction.
  const isCreation = program === RAYDIUM_AMM_V4_PROGRAM ? ammV4CreationInLogs(n.logs) !== null : cpmmCreationInLogs(n.logs);
  if (!isCreation) return;
  if (!remember(n.signature)) return;
  if (resolvesInFlight >= MAX_RESOLVES_IN_FLIGHT) return;
  resolvesInFlight += 1;
  void resolveCreation(n.signature, program, n.receivedAt).finally(() => {
    resolvesInFlight -= 1;
  });
}

/** Every account an instruction of `program` touched, top-level or inner. */
function accountsTouchedBy(tx: RawTransaction, program: string): string[] {
  const keys = resolveAccountKeys(tx);
  const out = new Set<string>();
  const take = (ix: { programIdIndex: number; accounts: number[] }): void => {
    if (keys[ix.programIdIndex] !== program) return;
    for (const i of ix.accounts) {
      const k = keys[i];
      if (k) out.add(k);
    }
  };
  for (const ix of tx.transaction?.message?.instructions ?? []) take(ix);
  for (const group of tx.meta?.innerInstructions ?? []) for (const ix of group.instructions) take(ix);
  return [...out];
}

/**
 * Turn a creation signature into a pool row.
 *
 * The pool is found by OWNER among the accounts the creating instruction
 * touched, not by position: CPMM creates through more than one instruction
 * (`initialize`, `initialize_with_permission` from a LaunchLab migration)
 * and their account orders differ. The vaults are in the same batch, so the
 * reserves — and with them the opening price — come from the same reply.
 */
async function resolveCreation(signature: string, program: string, at: number): Promise<void> {
  const h = host;
  if (!h) return;
  let tx: RawTransaction | null = null;
  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS && !tx; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RESOLVE_RETRY_MS));
    const res = await getTransaction(h.httpUrl(), signature);
    if (res.ok && res.data) tx = res.data;
  }
  if (!tx || tx.meta?.err) return;
  const touched = accountsTouchedBy(tx, program).slice(0, 100);
  if (!touched.length) return;
  const infos = await getMultipleAccountInfo(h.httpUrl(), touched, 'processed');
  if (!infos.ok || !infos.data) return;
  const byAddr = new Map<string, { owner: string; data: Buffer } | null>();
  touched.forEach((a, i) => byAddr.set(a, infos.data?.[i] ?? null));

  let state: RaydiumPoolState | null = null;
  for (const [addr, info] of byAddr) {
    if (!info || info.owner !== program) continue;
    state = parsePool(addr, info.owner, info.data);
    if (state) break;
  }
  if (!state) return;
  let reserves = parseReserves(byAddr.get(state.vaultA)?.data ?? null, byAddr.get(state.vaultB)?.data ?? null);
  if (!reserves) reserves = await readReserves(h.httpUrl(), state);

  // Which side is the token? With SOL on one side it is the other. With a
  // stablecoin on one side, likewise — unpriced in SOL, but the right mint.
  // With neither (a LaunchLab curve can be quoted in an arbitrary token, and
  // graduates in it) there is no honest answer, and a row under the wrong
  // mint would advertise the QUOTE as a new coin — so no row at all.
  const side = baseSide(state);
  if (side === null) {
    h.log('info', `Raydium: new ${state.kind} pool ${state.pool.slice(0, 8)}… has no recognisable quote side — not listed`);
    return;
  }
  const solQuoted = state.solSide !== null;
  const pool: LiveAmmPool = {
    kind: state.kind,
    pool: state.pool,
    mint: side === 'A' ? state.mintA : state.mintB,
    decimals: side === 'A' ? state.decimalsA : state.decimalsB,
    quoteMint: side === 'A' ? state.mintB : state.mintA,
    solQuoted,
    priceSol: reserves ? priceSolFromReserves(state, reserves) : null,
    solInPool: reserves ? solInPool(state, reserves) : null,
    detectedAt: at,
    signature,
  };
  recent.unshift(pool);
  if (recent.length > RECENT_POOLS_CAP) recent.length = RECENT_POOLS_CAP;
  creationsSeen += 1;
  h.log(
    'info',
    `Raydium: new ${state.kind === 'cpmm' ? 'CPMM' : 'AMM v4'} pool ${state.pool.slice(0, 8)}… for ${pool.mint.slice(0, 8)}…` +
      (pool.solInPool !== null ? ` with ${pool.solInPool.toFixed(2)} SOL` : ' (not SOL-quoted)'),
  );
  h.onPool(pool);
}

/** Quote mints a row can be sided by without a price: the two dollar coins. */
const KNOWN_QUOTES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * The token side of a pool: opposite SOL, else opposite a known dollar
 * coin, else unknown. Exported for tests.
 */
export function baseSide(state: RaydiumPoolState): 'A' | 'B' | null {
  if (state.solSide === 'A') return 'B';
  if (state.solSide === 'B') return 'A';
  const aQuote = KNOWN_QUOTES.has(state.mintA);
  const bQuote = KNOWN_QUOTES.has(state.mintB);
  if (aQuote === bQuote) return null;
  return aQuote ? 'B' : 'A';
}

// ── Per-pool tape ─────────────────────────────────────────────────────

/**
 * Tape a token's Raydium pool, once the chain confirms that is what it is.
 *
 * ONE account read decides it — the pool's owner is a Raydium pool program
 * or it is not — and the same read yields the mints, decimals and vaults,
 * so no provider label is trusted for anything. A pool with no SOL side
 * gets no tape: every price on it would be in the wrong currency, and that
 * price would feed the chart and every trigger.
 *
 * `stillWanted` is asked after the read: the user may have closed the page
 * while it was in flight, and a socket nobody asked for would never close.
 */
export async function watchPool(mint: string, poolHint: string, stillWanted: () => boolean): Promise<RaydiumPoolState | null> {
  const h = host;
  if (!h) return null;
  const existing = watches.get(mint);
  if (existing && existing.state.pool === poolHint) return existing.state;
  const state = await readPool(h.httpUrl(), poolHint);
  if (!state) return null;
  if (state.solSide === null) {
    h.log('info', `Raydium: ${mint.slice(0, 8)}… trades in a pool with no SOL side — no live tape for it`);
    return null;
  }
  if (!stillWanted() || !host) return state;
  if (existing) unwatch(mint);
  const urls = h.wssUrls();
  if (!urls.length) return state;
  if (watches.size >= MAX_POOLS) {
    const oldest = [...watches.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) unwatch(oldest.mint);
  }
  const feed = new FeedManager(
    urls,
    h.commitment(),
    {
      onLogs: (n) => onPoolLogs(mint, n),
      onState: () => undefined,
      onSubscribeError: (sockHost, message) => h.log('warn', `Raydium: ${sockHost} rejected the subscription for pool ${state.pool.slice(0, 8)}…: ${message} (retrying)`),
    },
    state.pool,
  );
  feed.start();
  const w: Watch = { mint, state, feed, startedAt: Date.now(), expected: null };
  watches.set(mint, w);
  h.log('info', `Raydium: taping ${state.kind === 'cpmm' ? 'CPMM' : 'AMM v4'} pool ${state.pool.slice(0, 8)}… for ${mint.slice(0, 8)}…`);
  if (state.kind === 'amm-v4') {
    // The reserves are what tells a v4 log for OUR pool from one for another
    // pool in the same transaction. Read in the background; until they land,
    // only an unambiguous notification (a single swap) is trusted.
    void readReserves(h.httpUrl(), state).then((r) => {
      const cur = watches.get(mint);
      if (r && cur === w && cur.expected === null) cur.expected = r;
    });
  }
  return state;
}

export function unwatch(mint: string): void {
  const w = watches.get(mint);
  if (!w) return;
  try {
    w.feed.stop();
  } catch {
    /* stopping a dead socket must not throw into the caller */
  }
  watches.delete(mint);
  host?.log('info', `Raydium: stopped taping ${mint.slice(0, 8)}…`);
}

export function stopAll(): void {
  for (const mint of [...watches.keys()]) unwatch(mint);
  stopCreations();
}

function onPoolLogs(mint: string, n: LogNotification): void {
  const h = host;
  const w = watches.get(mint);
  if (!h || !w) return;
  if (w.state.kind === 'cpmm') {
    const { events, layoutErrors: errs } = cpmmEventsOf(n.logs);
    if (errs) noteDrift(errs);
    for (const ev of events) {
      // A transaction can touch several pools; only ours counts, and the
      // event says which — no reserve check needed here.
      if (ev.pool !== w.state.pool) continue;
      const sided = sideCpmmSwap(ev);
      if (!sided) continue;
      emitTick(w, sided.isBuy, sided.lamports, sided.baseUnits, n.receivedAt);
    }
    return;
  }
  const swaps = rayLogsOf(n.logs).filter((e): e is RaySwapLog => e.kind === 'ray_swap');
  if (!swaps.length) return;
  if (w.expected === null) {
    // No reserves yet: a lone swap can only be ours (the socket is on this
    // pool); two could be ours and another pool's, in either order.
    if (swaps.length !== 1) return;
    const ev = swaps[0];
    w.expected = reservesAfter(ev);
    acceptV4(w, ev, n.receivedAt);
    return;
  }
  for (const ev of swaps) {
    if (!near(ev.poolCoin, w.expected.reserveA) || !near(ev.poolPc, w.expected.reserveB)) continue;
    w.expected = reservesAfter(ev);
    acceptV4(w, ev, n.receivedAt);
  }
}

/** Within RESERVE_TOLERANCE of each other. Zero matches only zero. Exported for tests. */
export function near(a: bigint, b: bigint): boolean {
  if (a === b) return true;
  if (a <= 0n || b <= 0n) return false;
  const diff = a > b ? a - b : b - a;
  return Number(diff) / Number(b) <= RESERVE_TOLERANCE;
}

/** The pool's reserves once this swap has applied to the ones it logged. Exported for tests. */
export function reservesAfter(ev: RaySwapLog): PoolReserves {
  // direction 2 = coin in, pc out; 1 = pc in, coin out.
  if (ev.direction === 2) return { reserveA: ev.poolCoin + ev.amountIn, reserveB: ev.poolPc - ev.amountOut };
  return { reserveA: ev.poolCoin - ev.amountOut, reserveB: ev.poolPc + ev.amountIn };
}

function acceptV4(w: Watch, ev: RaySwapLog, at: number): void {
  const sided = sideAmmV4Swap(ev, w.state.solSide);
  if (!sided) return;
  emitTick(w, sided.isBuy, sided.lamports, sided.baseUnits, at);
}

function emitTick(w: Watch, isBuy: boolean, lamports: bigint, baseUnits: bigint, at: number): void {
  const decimals = w.state.baseDecimals;
  if (decimals === null) return;
  const priceSol = executedPriceSol({ isBuy, lamports, baseUnits }, decimals);
  if (priceSol === null) return;
  decoded += 1;
  host?.onTick({
    mint: w.mint,
    pool: w.state.pool,
    // Empty on purpose — see the header. An invented wallet would poison
    // the trader scan and the copy-trade watchlist.
    wallet: '',
    isBuy,
    sol: Number(lamports) / 1e9,
    tokens: Number(baseUnits) / 10 ** decimals,
    priceSol,
    // Local arrival time, not the block's second — the tape's value is that
    // it records when WE saw it.
    at,
  });
}

function noteDrift(errs: number): void {
  layoutErrors += errs;
  // Drift must be LOUD: a known CPMM event whose size changed means Raydium
  // redeployed with a different layout, and every price from here on is
  // suspect. Same rule as the DBC watcher.
  if (layoutErrors === errs || layoutErrors % 25 < errs) {
    host?.log(
      'error',
      `Raydium CPMM decoder drift: ${layoutErrors} event(s) failed to parse — Raydium may have changed the layout. ` +
        'Live tape for CPMM pools is not trustworthy until this is investigated.',
    );
  }
}

/** Test seam. */
export function _reset(): void {
  stopAll();
  recent = [];
  seen.clear();
  seenOrder.length = 0;
  resolvesInFlight = 0;
  layoutErrors = 0;
  decoded = 0;
  creationsSeen = 0;
  host = null;
}

export function creationCount(): number {
  return creationsSeen;
}
