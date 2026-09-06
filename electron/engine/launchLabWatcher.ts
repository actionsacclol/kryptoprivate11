// Live tape for Raydium LaunchLab (letsbonk.fun).
//
// ─── Why this is ONE subscription and dbcWatcher.ts is one per pool ───
//
// LaunchLab publishes its TradeEvent as a `Program data:` LOG line as well as
// an emit_cpi inner instruction (measured 2026-08-24 — see
// launchLabDecoder.ts). Logs are what `logsSubscribe` delivers, so a single
// program-wide subscription sees every LaunchLab trade for free. Meteora DBC
// emits only via emit_cpi, which is why that watcher has to subscribe per
// pool and fetch transactions.
//
// So this file is closer in spirit to the pump feed than to dbcWatcher, even
// though it borrows dbcWatcher's host interface.
//
// ─── What a log-only tape cannot give you ─────────────────────────────
//
// A log subscription delivers log lines and a signature — never an account
// list. The TradeEvent carries the POOL, not the trader. So ticks from this
// rail have amounts, price and direction, but NO wallet: `wallet` is empty
// and the UI must render it as unknown rather than inventing one. Recovering
// it would cost a getTransaction per trade, which is exactly the price this
// rail lets us avoid.
//
// ─── The pool is derivable, so watching costs nothing ─────────────────
//
// `PDA(["pool", baseMint, quoteMint])` — verified against a live pool. That
// means opening a token page needs no lookup at all: derive the pool, match
// incoming events against it.

import { FeedManager } from './feed';
import { launchLabPoolFor } from './addresses';
import { decodeLogs, LAUNCHLAB_PROGRAM, priceLamportsPerToken, curveProgressPct } from './launchLabDecoder';

const WSOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

export { LAUNCHLAB_PROGRAM };

export interface LaunchLabTick {
  mint: string;
  pool: string;
  /** ALWAYS empty for this rail — logs carry no account list. Not a bug. */
  wallet: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  curvePct: number | null;
  at: number;
}

export interface LaunchLabWatcherHost {
  wssUrls(): string[];
  commitment(): 'processed' | 'confirmed';
  onTick(tick: LaunchLabTick): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Watch {
  mint: string;
  pool: string;
  decimals: number;
}

/** Keyed by POOL, because that is what arrives in the event. */
const watches = new Map<string, Watch>();
let feed: FeedManager | null = null;
let host: LaunchLabWatcherHost | null = null;
let decoded = 0;

export function attach(h: LaunchLabWatcherHost): void {
  host = h;
}

/** The pool a LaunchLab mint trades in. Derived, never fetched. */
export function poolFor(mint: string, quoteMint: string = WSOL): string {
  return launchLabPoolFor(mint, quoteMint, LAUNCHLAB_PROGRAM);
}

export function watchedMints(): string[] {
  return [...watches.values()].map((w) => w.mint);
}

export function decodedCount(): number {
  return decoded;
}

/**
 * Start taping a LaunchLab mint.
 *
 * The subscription is shared: the first watch opens it, the last unwatch
 * closes it. A mint on another rail simply never matches an event, so a
 * wrong guess here costs nothing but the socket.
 */
export function watch(mint: string, decimals: number, knownPool?: string | null): void {
  if (!host) return;
  let pool: string;
  if (knownPool) {
    // A pool the providers already named beats a derived one: the derivation
    // assumes a SOL quote, and 3 of 10 sampled pools quoted in USDC/USDT —
    // for those the derived address is simply a different account that will
    // never match an event.
    pool = knownPool;
  } else {
    try {
      pool = poolFor(mint);
    } catch {
      return;
    }
  }
  if (watches.has(pool)) return;
  watches.set(pool, { mint, pool, decimals });
  start();
}

export function unwatch(mint: string): void {
  for (const [pool, w] of watches) if (w.mint === mint) watches.delete(pool);
  if (!watches.size) stopAll();
}

export function stopAll(): void {
  watches.clear();
  feed?.stop();
  feed = null;
}

function start(): void {
  if (feed || !host) return;
  const urls = host.wssUrls();
  if (!urls.length) return;
  feed = new FeedManager(
    urls,
    host.commitment(),
    {
      onLogs: (n) => {
        // A single program-wide stream carries every LaunchLab trade, most of
        // them for tokens nobody has open. Matching on the watched pool set
        // first keeps the hot path to a map lookup.
        if (!watches.size) return;
        const events = decodeLogs(n.logs ?? []);
        for (const ev of events) {
          const w = watches.get(ev.pool);
          if (!w) continue;
          const priceLamports = priceLamportsPerToken(ev, w.decimals);
          if (priceLamports === null) continue;
          decoded++;
          const lamports = ev.isBuy ? ev.amountIn : ev.amountOut;
          const baseUnits = ev.isBuy ? ev.amountOut : ev.amountIn;
          host?.onTick({
            mint: w.mint,
            pool: w.pool,
            // Empty on purpose — see the header. An invented wallet would
            // poison the trader scan and the copy-trade watchlist.
            wallet: '',
            isBuy: ev.isBuy,
            sol: Number(lamports) / LAMPORTS_PER_SOL,
            tokens: Number(baseUnits) / 10 ** w.decimals,
            priceSol: priceLamports / LAMPORTS_PER_SOL,
            curvePct: curveProgressPct(ev),
            at: Date.now(),
          });
        }
      },
      onState: () => undefined,
    },
    LAUNCHLAB_PROGRAM,
  );
  feed.start();
  host.log('info', `LaunchLab tape started (${watches.size} mint(s))`);
}
