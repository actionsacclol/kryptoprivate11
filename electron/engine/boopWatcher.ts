// Live tape for Boop (boop.fun).
//
// One program-wide `logsSubscribe`, like launchLabWatcher.ts — Boop's events
// are log lines, so the whole rail costs a single socket.
//
// The difference from LaunchLab is what the events contain. Boop names the
// MINT and the TRADER, so:
//   • no pool→mint mapping is needed — events are matched on mint directly;
//   • ticks carry a real wallet, which means trader scan and copy trading
//     work on this rail. LaunchLab ticks cannot, and never will without
//     paying for a getTransaction per trade.

import { FeedManager } from './feed';
import { decodeLogs, priceLamportsPerToken, BOOP_PROGRAM } from './boopDecoder';

const LAMPORTS_PER_SOL = 1_000_000_000;

export { BOOP_PROGRAM };

export interface BoopTick {
  mint: string;
  /** A real trader — Boop puts it in the event. */
  wallet: string;
  isBuy: boolean;
  sol: number;
  tokens: number;
  priceSol: number;
  at: number;
}

export interface BoopWatcherHost {
  wssUrls(): string[];
  commitment(): 'processed' | 'confirmed';
  onTick(tick: BoopTick): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Watch {
  mint: string;
  decimals: number;
}

const watches = new Map<string, Watch>();
let feed: FeedManager | null = null;
let host: BoopWatcherHost | null = null;
let decoded = 0;

export function attach(h: BoopWatcherHost): void {
  host = h;
}

export function watchedMints(): string[] {
  return [...watches.keys()];
}

export function decodedCount(): number {
  return decoded;
}

/** Start taping a Boop mint. The subscription is shared across all watches. */
export function watch(mint: string, decimals: number): void {
  if (!host || !mint) return;
  if (watches.has(mint)) return;
  watches.set(mint, { mint, decimals });
  start();
}

export function unwatch(mint: string): void {
  watches.delete(mint);
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
        if (!watches.size) return;
        for (const ev of decodeLogs(n.logs ?? [])) {
          // Matched on MINT — the event carries it, so there is no pool map
          // to keep and nothing to resolve when a token page opens.
          const w = watches.get(ev.mint);
          if (!w) continue;
          const priceLamports = priceLamportsPerToken(ev, w.decimals);
          if (priceLamports === null) continue;
          decoded++;
          // The fee is part of what a buyer spent, so it belongs in the SOL
          // figure the tape shows — otherwise the tape disagrees with the
          // wallet's own balance change.
          const lamports = ev.isBuy ? ev.amountIn + ev.fee : ev.amountOut;
          const baseUnits = ev.isBuy ? ev.amountOut : ev.amountIn;
          host?.onTick({
            mint: ev.mint,
            wallet: ev.trader,
            isBuy: ev.isBuy,
            sol: Number(lamports) / LAMPORTS_PER_SOL,
            tokens: Number(baseUnits) / 10 ** w.decimals,
            priceSol: priceLamports / LAMPORTS_PER_SOL,
            at: Date.now(),
          });
        }
      },
      onState: () => undefined,
    },
    BOOP_PROGRAM,
  );
  feed.start();
  host.log('info', `Boop tape started (${watches.size} mint(s))`);
}
