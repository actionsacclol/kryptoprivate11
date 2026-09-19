// The Callouts rail — a tab on the far right edge, and the panel behind it.
//
// pump.fun's callouts are the one live social signal this app had no view of:
// someone calls a coin, their followers get a push, and the coin moves before
// any of the app's own measurements have anything to say about it. This is a
// READER for that. There is no buy button on a row, no "auto-buy callouts"
// setting and no script trigger, and that is a decision rather than an
// omission — a caller is paid out of the volume their call brings in, so
// wiring a trade to one would be building a shill-follower. The app shows you
// the call, who made it, and whether they are holding what they called.
//
// The rail collapses to a vertical tab so it costs nothing when it is shut:
// the feed only polls while the panel is open (`useCallouts(open)`), so a
// closed rail makes no requests at all.

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Megaphone, RefreshCw, X } from 'lucide-react';
import type { ChainKind } from '@shared/evm';
import { newestFirst, type Callout } from '@shared/callouts';
import { refreshCallouts, useCallouts, useCoinCallouts } from '../state/callouts';
import { CalloutRow } from './CalloutRow';
import { cls, fmtAgo } from '../utils/format';

const OPEN_KEY = 'krypt.callouts.open.v1';

type Filter = 'all' | ChainKind;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'solana', label: 'SOL' },
  { id: 'bnb', label: 'BNB' },
  { id: 'robinhood', label: 'RBH' },
];

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    // Site data blocked is not a reason to fail to render a panel.
    return false;
  }
}

export function CalloutsRail({
  onOpenToken,
  openMint = null,
  openChain = null,
  openSymbol = null,
}: {
  onOpenToken: (mint: string, chain: ChainKind) => void;
  /** The token on screen, when there is one. Its own calls pin to the top
   *  of the panel: the feed only carries what pump is surfacing right now,
   *  so a coin called an hour ago is absent from it, and absent is not the
   *  same as uncalled. */
  openMint?: string | null;
  openChain?: ChainKind | null;
  /** What the workspace calls the open token. pump's per-coin route serves
   *  no symbol, so without this every pinned row reads as a raw address. */
  openSymbol?: string | null;
}) {
  const [open, setOpen] = useState(readOpen);
  const [filter, setFilter] = useState<Filter>('all');
  const { rows, answered, error, lastCheckedAt, loading } = useCallouts(open);
  const coin = useCoinCallouts(openMint, openChain, open, openSymbol);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* a rail that cannot remember it was open still opens */
    }
  }, [open]);

  // The open coin's calls are pinned above, so the feed list drops them:
  // a coin pump is surfacing WHILE you are looking at it would otherwise
  // appear twice, which reads as two people calling it.
  const pinnedIds = useMemo(() => new Set(coin.rows.map((c) => c.id)), [coin.rows]);
  const shown = useMemo(() => {
    const sorted = newestFirst(rows).filter((c) => !pinnedIds.has(c.id));
    return filter === 'all' ? sorted : sorted.filter((c) => c.chain === filter);
  }, [rows, filter, pinnedIds]);

  // Per-chain counts for the filter buttons, so an empty tab is visibly empty
  // rather than looking like a failed load.
  const counts = useMemo(() => {
    const out: Record<string, number> = { all: rows.length };
    for (const c of rows) if (c.chain) out[c.chain] = (out[c.chain] ?? 0) + 1;
    return out;
  }, [rows]);

  return (
    // A COLUMN of its own, not an overlay. It used to be positioned over the
    // page, which meant opening it hid the right-hand side of whatever you
    // were reading - including the top bar and the token tabs (user report,
    // 2026-09-18). As a flex item it takes its own width and the content
    // beside it reflows, so nothing is ever covered but the tab itself.
    <div className={cls('relative shrink-0 transition-[width] duration-150', open ? 'w-[340px] max-w-[85vw]' : 'w-0')}>
      {/* The tab. Always mounted, `right-full` so it rides the panel's left
          edge when open and the content's right edge when shut. It is the
          only thing the feature costs when nobody is using it. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide callouts' : 'pump.fun callouts'}
        className={cls(
          'absolute right-full top-1/2 z-20 -translate-y-1/2 rounded-l-lg border border-r-0 border-white/10 px-1.5 py-3 transition',
          open ? 'bg-krypt-purple/20 text-white' : 'bg-black/40 text-krypt-muted hover:bg-white/[0.06] hover:text-white/90',
        )}
      >
        <span className="flex flex-col items-center gap-2">
          <Megaphone className="h-3.5 w-3.5" />
          <span className="font-display text-label uppercase tracking-heading" style={{ writingMode: 'vertical-rl' }}>
            Callouts
          </span>
          {answered && rows.length > 0 && (
            <span className="rounded bg-krypt-purple/30 px-1 py-px text-nano font-mono text-white/90">{rows.length}</span>
          )}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute inset-0 z-20 flex flex-col border-l border-white/10 bg-krypt-panel/95"
          >
            <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
              <Megaphone className="h-3.5 w-3.5 text-krypt-pink" />
              <span className="font-display text-label uppercase tracking-heading text-white/90">Callouts</span>
              <span className="text-nano text-krypt-muted">pump.fun</span>
              <button
                type="button"
                onClick={() => refreshCallouts()}
                title="Check now"
                className="ml-auto rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-white/90"
              >
                <RefreshCw className={cls('h-3 w-3', loading && 'animate-spin')} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                className="rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-white/90"
              >
                <X className="h-3 w-3" />
              </button>
            </header>

            <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cls(
                    'rounded px-1.5 py-0.5 text-nano font-display uppercase tracking-label transition',
                    filter === f.id ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white/90',
                  )}
                >
                  {f.label}
                  {counts[f.id] ? <span className="ml-1 font-mono text-krypt-muted/80">{counts[f.id]}</span> : null}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
              {/* The coin you are looking at, asked about directly. Shown
                  only when it HAS calls: a "no calls" block on every chart
                  would be noise on the 99% of coins nobody has called. */}
              {openMint && coin.answered && coin.rows.length > 0 && (
                <section className="mb-2 space-y-1.5">
                  <div className="px-0.5 font-display text-nano uppercase tracking-label text-krypt-muted">
                    This coin · {coin.rows.length} call{coin.rows.length === 1 ? '' : 's'}
                  </div>
                  {coin.rows.map((c) => (
                    <CalloutRow key={`coin-${c.id}`} c={c} onOpen={onOpenToken} />
                  ))}
                  <div className="border-b border-white/10 pt-1" />
                </section>
              )}
              {/* Four states, and they are deliberately different sentences:
                  never asked, asked and nothing came back, asked and there are
                  none, and asked and the feed is down but these are the last
                  calls we saw. */}
              {!answered && loading && <div className="px-1 py-3 text-xs text-krypt-muted">Reading pump.fun…</div>}
              {!answered && !loading && error && (
                <div className="rounded-md border border-amber-400/25 bg-amber-500/[0.06] px-2.5 py-2 text-xs text-amber-200/90">
                  {error}
                </div>
              )}
              {answered && error && (
                <div className="rounded-md border border-amber-400/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-nano text-amber-200/90">
                  Feed unreachable — showing the last calls it served.
                </div>
              )}
              {answered && shown.length === 0 && (
                <div className="px-1 py-3 text-xs text-krypt-muted">
                  {rows.length === 0 ? 'No callouts right now.' : 'No callouts on this chain right now.'}
                </div>
              )}
              {shown.map((c: Callout) => (
                <CalloutRow key={c.id} c={c} onOpen={onOpenToken} />
              ))}
            </div>

            <footer className="border-t border-white/10 px-3 py-1.5 text-nano text-krypt-muted">
              {lastCheckedAt ? `checked ${fmtAgo(lastCheckedAt)}` : 'not checked yet'} · intel only, nothing here trades
            </footer>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
