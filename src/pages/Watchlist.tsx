import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Star } from 'lucide-react';
import type { TokenSummary } from '@shared/market';
import { isEvmChain, type ChainKind } from '@shared/evm';
import { Empty, Page } from '../components/common';
import { TokenCard } from '../components/terminal/TokenCard';
import { parsePin, useTerminal } from '../state/TerminalProvider';
import { lastRows, rememberRows } from '../state/routeCache';

// Watchlist — the pinned tokens from term.txt section 19.
//
// Rows are loaded through market:summaries rather than the Discover feeds,
// because a pinned token is usually not in any of the four columns any
// more. One round trip for the whole Solana list (the Jupiter half is a
// single batched call main-side); each EVM pin is asked of its own chain's
// rail, because an 0x address alone does not say which chain it is on. It
// refreshes on a slower cadence than Discover does, and not at all while
// the window is hidden.

export function WatchlistPage({ onOpenToken }: { onOpenToken: (mint: string, chain?: ChainKind) => void }) {
  const term = useTerminal();
  // Paint the last rows this session saw for each pin — the previous visit,
  // or Discover's own feed — on the first frame; the batch below refreshes
  // them in place. Rows started empty on every mount and the page showed
  // spinner plates for 1–2 s under a rate limit (measured 2026-09-08).
  const [rows, setRows] = useState<Record<string, TokenSummary>>(() => {
    const out: Record<string, TokenSummary> = {};
    for (const pin of term.watchlist) {
      const { mint } = parsePin(pin);
      let hit: TokenSummary | null = lastRows.get(mint) ?? null;
      if (!hit) for (const c of Object.values(term.columns)) hit = hit ?? c.rows.find((r) => r.mint === mint) ?? null;
      if (hit) out[pin] = hit;
    }
    return out;
  });
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!term.watchlist.length) {
      setRows({});
      return;
    }
    setLoading(true);
    try {
      const pins = term.watchlist.map((pin) => ({ pin, ...parsePin(pin) }));
      const solana = pins.filter((p) => p.chain === 'solana');
      const evm = pins.filter((p) => isEvmChain(p.chain));
      // The first EVM failure is kept: the Solana stub's 'ok' must never be
      // the banner, and an EVM rail that did not answer must be said.
      let evmProblem: string | null = null;
      const [r, evmRows] = await Promise.all([
        solana.length
          ? window.krypt.market.summaries(solana.map((p) => p.mint))
          : Promise.resolve({ ok: true, message: 'ok', data: {} as Record<string, TokenSummary> }),
        Promise.all(
          evm.map((p) =>
            window.krypt.evm
              .summary(p.chain as 'robinhood' | 'bnb', p.mint)
              .then((x) => {
                if (x.ok && x.data) return { pin: p.pin, row: x.data };
                evmProblem ??= x.message || 'The EVM rail did not answer for a pinned token';
                return null;
              })
              .catch((e: unknown) => {
                evmProblem ??= (e as Error)?.message || 'The EVM rail did not answer for a pinned token';
                return null;
              }),
          ),
        ),
      ]);
      const merged: Record<string, TokenSummary> = {};
      if (r.ok && r.data) for (const p of solana) if (r.data[p.mint]) merged[p.pin] = r.data[p.mint];
      for (const hit of evmRows) if (hit) merged[hit.pin] = hit.row;
      const solanaNote = r.message !== 'ok' ? r.message : null;
      if (Object.keys(merged).length || (r.ok && !evm.length)) {
        // A parked provider leaves the previous rows on screen with a note.
        rememberRows(Object.values(merged));
        setRows((prev) => ({ ...prev, ...merged }));
        setNote(solanaNote ?? evmProblem);
      } else {
        setNote(solanaNote ?? evmProblem ?? 'Nothing answered for the pinned tokens — retrying');
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
      subtitle="Tokens you pinned, on every chain. Stored locally — nothing about this list leaves your machine."
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
          {term.watchlist.map((pin) => {
            const { mint, chain } = parsePin(pin);
            const t = rows[pin];
            if (!t) {
              return (
                <div key={pin} className="plate rounded-lg px-3 py-6 flex items-center justify-center gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" /> : <span className="text-[10px] text-krypt-muted">no data yet</span>}
                  <span className="text-[11px] font-mono text-krypt-muted">{mint.slice(0, 10)}…</span>
                  {chain !== 'solana' && <span className="text-[9px] uppercase tracking-wider text-krypt-muted/60">{chain}</span>}
                  <button
                    onClick={() => term.toggleWatch(mint, chain)}
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
                key={pin}
                token={t}
                window={term.filters.window}
                onOpen={() => onOpenToken(mint, chain)}
                onQuickBuy={() => onOpenToken(mint, chain)}
                quickBuySol={0.1}
                watched
                onToggleWatch={() => term.toggleWatch(mint, chain)}
                canQuickBuy={false}
              />
            );
          })}
        </div>
      )}
    </Page>
  );
}
