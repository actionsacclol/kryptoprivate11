import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Star } from 'lucide-react';
import type { TokenSummary } from '@shared/market';
import { Empty, Page } from '../components/common';
import { TokenCard } from '../components/terminal/TokenCard';
import { useTerminal } from '../state/TerminalProvider';

// Watchlist — the pinned tokens from term.txt section 19.
//
// Rows are loaded through market:summaries rather than the Discover feeds,
// because a pinned token is usually not in any of the four columns any
// more. One round trip for the whole list (the Jupiter half is a single
// batched call main-side); it refreshes on a slower cadence than Discover
// does, and not at all while the window is hidden.

export function WatchlistPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const term = useTerminal();
  const [rows, setRows] = useState<Record<string, TokenSummary>>({});
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!term.watchlist.length) {
      setRows({});
      return;
    }
    setLoading(true);
    try {
      const r = await window.krypt.market.summaries(term.watchlist);
      if (r.ok && r.data) {
        // A parked provider leaves the previous rows on screen with a note.
        setRows((prev) => ({ ...prev, ...r.data }));
        setNote(r.message !== 'ok' ? r.message : null);
      } else {
        setNote(r.message);
      }
    } finally {
      setLoading(false);
    }
  }, [term.watchlist]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 20_000);
    const onVisible = (): void => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return (
    <Page
      title="Watchlist"
      subtitle="Tokens you pinned. Stored locally — nothing about this list leaves your machine."
      actions={
        <button
          onClick={() => void load()}
          className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          title="Refresh"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      }
    >
      {term.watchlist.length === 0 ? (
        <Empty
          title="Nothing pinned yet"
          message="Click the star on any token in Discover, or on a token page, to keep an eye on it here."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
          {note && (
            <div className="col-span-full rounded-md border border-arc-gold/25 bg-arc-gold/10 px-3 py-2">
              <p className="text-[10px] text-arc-gold/90 leading-relaxed">{note}</p>
            </div>
          )}
          {term.watchlist.map((mint) => {
            const t = rows[mint];
            if (!t) {
              return (
                <div key={mint} className="plate rounded-lg px-3 py-6 flex items-center justify-center gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" /> : <span className="text-[10px] text-krypt-muted">no data yet</span>}
                  <span className="text-[11px] font-mono text-krypt-muted">{mint.slice(0, 10)}…</span>
                  <button
                    onClick={() => term.toggleWatch(mint)}
                    className="ml-2 text-krypt-muted/50 hover:text-arc-gold"
                    title="Unpin"
                  >
                    <Star className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                </div>
              );
            }
            return (
              <TokenCard
                key={mint}
                token={t}
                window={term.filters.window}
                onOpen={() => onOpenToken(mint)}
                onQuickBuy={() => onOpenToken(mint)}
                quickBuySol={0.1}
                watched
                onToggleWatch={() => term.toggleWatch(mint)}
                canQuickBuy={false}
              />
            );
          })}
        </div>
      )}
    </Page>
  );
}
