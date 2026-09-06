// Per-pool Meteora DBC watcher.
//
// ─── Why this exists instead of a program-wide firehose ───────────────
//
// DBC emits its events through `emit_cpi!`, so the bytes live in a
// transaction's inner instructions and never appear in `logsSubscribe`
// output (see dbcDecoder.ts). Decoding every DBC trade would therefore mean
// one `getTransaction` per trade across the whole program — thousands a
// minute, which rate-limits a free public RPC immediately and would burn a
// Helius free tier in hours.
//
// So this watches ONE POOL AT A TIME: `logsSubscribe` accepts a `mentions`
// filter, so we subscribe to the pool address of the token the user has
// open. Every notification is then already known to be relevant, and we
// fetch only those transactions. For a single hot token that is a few calls
// a second at most, which the free endpoints handle comfortably.
//
// The honest limit, stated in the UI: this gives live tape, 1s charts and
// Trader Scan for the token you are LOOKING AT. It cannot give
// launch-time bundle analysis or copy trading for DBC, because both need to
// see every trade of every token.

import { FeedManager, type LogNotification } from './feed';
export { DBC_PROGRAM_ID, decodeDbcEventB58 } from './dbcDecoder';
import { DBC_PROGRAM_ID, decodeDbcEventB58, executedPriceSol, swapSol, swapTokens, type DbcSwapEvent } from './dbcDecoder';
import { getSignaturesForAddress, getTransaction, resolveAccountKeys } from './rpcClient';

/** How many pools may be watched at once. The tape allows 8 subscriptions;
 *  this is deliberately smaller because each pool costs RPC calls. */
const MAX_POOLS = 3;

/** Ignore a transaction we have already fetched (sockets race and dedupe
 *  upstream, but a retry or a reorg can still repeat one). */
const SEEN_CAP = 500;

export interface DbcTick {
  mint: string;
  pool: string;
  wallet: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  curvePct: number | null;
  at: number;
}

export interface DbcWatcherHost {
  /** WS endpoints to subscribe on, and the HTTP endpoint for tx fetches. */
  wssUrls(): string[];
  httpUrl(): string;
  commitment(): 'processed' | 'confirmed';
  onTick(tick: DbcTick): void;
  onCurveComplete(mint: string, pool: string): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Watch {
  mint: string;
  pool: string;
  decimals: number;
  feed: FeedManager;
  startedAt: number;
}

const watches = new Map<string, Watch>();
const seen = new Set<string>();
const seenOrder: string[] = [];
let host: DbcWatcherHost | null = null;
let layoutErrors = 0;

export function attach(h: DbcWatcherHost): void {
  host = h;
}

export function layoutErrorCount(): number {
  return layoutErrors;
}

export function watchedMints(): string[] {
  return [...watches.keys()];
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

/**
 * Find a mint's Meteora DBC pool by OBSERVATION rather than derivation.
 *
 * Two things ruled out the obvious alternatives (both verified on mainnet
 * 2026-08-24):
 *
 *   • The program's own IDL declares no PDA seeds for the pool account, so
 *     there is nothing authoritative to derive from. Guessing seeds is
 *     exactly the kind of hardcoded-volatile-config mistake PHASE2 §A warns
 *     against.
 *   • A provider's `firstPool` is not it. Jupiter reports the MINT address
 *     as `firstPool` for letsbonk.fun tokens, and for a graduated `met-dbc`
 *     token it reports the Meteora DLMM pool (owner LBUZKhRx…), not the DBC
 *     curve. Feeding either to the watcher would subscribe to the wrong
 *     account and silently record nothing.
 *
 * So: read the mint's recent transactions and take the pool straight out of
 * a DBC event. `EvtInitializePool` with a matching `baseMint` is definitive;
 * a swap seen in a transaction that already mentions this mint is the
 * fallback. Costs a handful of RPC calls, once, when a token page opens.
 *
 * Returns null for anything that is not a DBC token — which is the correct
 * answer for pump.fun, Raydium LaunchLab and already-graduated tokens, and
 * means callers need no launchpad guesswork at all.
 */
export async function resolveDbcPool(mint: string, httpUrl: string, limit = 12): Promise<string | null> {
  const sigs = await getSignaturesForAddress(httpUrl, mint, limit);
  if (!sigs.ok || !sigs.data?.length) return null;

  let fallback: string | null = null;
  for (const s of sigs.data) {
    if (s.err) continue;
    const res = await getTransaction(httpUrl, s.signature);
    if (!res.ok || !res.data) continue;
    const tx = res.data;
    // MUST include ALT-loaded addresses — DBC transactions routinely
    // reference their own program through a lookup table.
    const keys = resolveAccountKeys(tx);
    if (!keys.includes(DBC_PROGRAM_ID)) continue;

    for (const group of tx.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        if (keys[ix.programIdIndex] !== DBC_PROGRAM_ID) continue;
        const { event } = decodeDbcEventB58(ix.data);
        if (!event) continue;
        // Definitive: the pool was created for THIS mint.
        if (event.kind === 'dbc_init_pool' && event.baseMint === mint) return event.pool;
        if (event.kind === 'dbc_swap' && fallback === null) fallback = event.pool;
      }
    }
    if (fallback) return fallback;
  }
  return fallback;
}

/**
 * Start following a DBC pool. Safe to call repeatedly for the same mint.
 * `decimals` matters: DBC pools are not all 6-decimal, and using the wrong
 * value scales every price by a factor of 1000.
 */
export function watch(mint: string, pool: string, decimals: number): void {
  const h = host;
  if (!h) return;
  const existing = watches.get(mint);
  if (existing) {
    if (existing.pool === pool) return;
    // The pool changed (a re-index, or we learned a better address) — restart.
    unwatch(mint);
  }

  const urls = h.wssUrls();
  if (!urls.length) return;

  if (watches.size >= MAX_POOLS) {
    // Drop the oldest watch. Each one costs RPC calls, so an unbounded set
    // would quietly turn into the firehose this design exists to avoid.
    const oldest = [...watches.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) unwatch(oldest.mint);
  }

  const feed = new FeedManager(
    urls,
    h.commitment(),
    {
      onLogs: (n: LogNotification) => void onNotification(mint, pool, decimals, n),
      onState: () => {
        /* per-pool socket state is not surfaced; the main feed owns the badge */
      },
      // A rejected subscribe ("Too many subscriptions" is the realistic one:
      // each watched pool costs a subscription on every endpoint) used to be
      // dropped silently — the pool looked watched and recorded nothing.
      // The feed reconnects with backoff on its own; we make it visible.
      onSubscribeError: (sockHost, message) =>
        h.log('warn', `DBC: ${sockHost} rejected the subscription for pool ${pool.slice(0, 8)}…: ${message} (retrying)`),
    },
    // `mentions` is the pool, not a program — this is the whole trick.
    pool,
  );
  feed.start();
  watches.set(mint, { mint, pool, decimals, feed, startedAt: Date.now() });
  h.log('info', `DBC: watching pool ${pool.slice(0, 8)}… for ${mint.slice(0, 8)}…`);
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
  host?.log('info', `DBC: stopped watching ${mint.slice(0, 8)}…`);
}

export function stopAll(): void {
  for (const mint of [...watches.keys()]) unwatch(mint);
}

/**
 * A transaction touched the watched pool. Fetch it and pull the DBC events
 * out of its inner instructions.
 *
 * Failures are silent by design: a dropped fetch costs one missing candle,
 * and logging every RPC hiccup from a hot pool would drown the console.
 */
async function onNotification(mint: string, pool: string, decimals: number, n: LogNotification): Promise<void> {
  const h = host;
  if (!h) return;
  if (!watches.has(mint)) return;
  if (!remember(n.signature)) return;

  const res = await getTransaction(h.httpUrl(), n.signature);
  if (!res.ok || !res.data) return;
  const tx = res.data;
  if (tx.meta?.err) return;

  const keys = resolveAccountKeys(tx);
  // The fee payer is index 0 of the STATIC keys, which is also index 0 here.
  const wallet = keys[0] ?? '';

  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== DBC_PROGRAM_ID) continue;
      const { event, layoutError } = decodeDbcEventB58(ix.data);
      if (layoutError) {
        // Drift must be LOUD. A known DBC event whose payload size changed
        // means Meteora redeployed with a different layout, and every price
        // this watcher produces from here on is suspect. The pump path has
        // the same rule (engine.ts trackDrift) — this one used to only
        // increment a counter nobody read.
        layoutErrors += 1;
        if (layoutErrors === 1 || layoutErrors % 25 === 0) {
          h.log(
            'error',
            `DBC decoder drift: ${layoutErrors} event(s) failed to parse — Meteora may have changed the layout. ` +
              'Live tape for DBC tokens is not trustworthy until this is investigated.',
          );
        }
        continue;
      }
      if (!event) continue;

      if (event.kind === 'dbc_curve_complete' && event.pool === pool) {
        h.onCurveComplete(mint, pool);
        continue;
      }
      if (event.kind !== 'dbc_swap') continue;
      // A transaction can touch several pools; only ours counts.
      if (event.pool !== pool) continue;

      const swap = event as DbcSwapEvent;
      const priceSol = executedPriceSol(swap, decimals);
      if (!(priceSol > 0)) continue;

      h.onTick({
        mint,
        pool,
        wallet,
        isBuy: swap.isBuy,
        sol: swapSol(swap),
        tokens: swapTokens(swap, decimals),
        priceSol,
        curvePct:
          swap.quoteReserve !== null && swap.migrationThreshold !== null && swap.migrationThreshold > 0n
            ? Math.max(0, Math.min(100, (Number(swap.quoteReserve) / Number(swap.migrationThreshold)) * 100))
            : null,
        // The LOCAL arrival time of the notification, not the program's
        // timestamp — the tape's whole value is that it records when WE saw
        // it, and the on-chain second is too coarse for a 1s chart anyway.
        at: n.receivedAt,
      });
    }
  }
}
