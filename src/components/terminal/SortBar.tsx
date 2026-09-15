// Per-column sort for Discover — the metric labels from each row (6H, MC,
// LIQ, VOL, B/S, HOLD, TOP10, CURVE, SCORE) as clickable headers at the top
// of the column. Click once for lowest → highest, again for highest → lowest,
// a third time to go back to the provider's order.
//
// Honest null: a row whose value is unknown sorts LAST in both directions —
// an em dash is never treated as zero (see the honest-null rule).

import { ArrowDown, ArrowUp } from 'lucide-react';
import type { StatsWindow, TokenSummary } from '@shared/market';
import { cls } from '../../utils/format';

export type SortKey = 'change' | 'mc' | 'liq' | 'vol' | 'bs' | 'hold' | 'top10' | 'curve' | 'score';
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

const KEYS: Array<{ key: SortKey; label: (win: StatsWindow) => string; title: string }> = [
  { key: 'change', label: (w) => w.toUpperCase(), title: 'Price change over the selected window' },
  { key: 'mc', label: () => 'MC', title: 'Market cap' },
  { key: 'liq', label: () => 'LIQ', title: 'Liquidity' },
  { key: 'vol', label: () => 'VOL', title: 'Volume over the selected window' },
  { key: 'bs', label: () => 'B/S', title: 'Buys per sell over the selected window' },
  { key: 'hold', label: () => 'HOLD', title: 'Holders' },
  { key: 'top10', label: () => 'TOP10', title: 'Top-10 holder share' },
  { key: 'curve', label: () => 'CURVE', title: 'Bonding-curve progress' },
  { key: 'score', label: () => 'SCORE', title: 'Krypt score' },
];

function valueOf(t: TokenSummary, key: SortKey, win: StatsWindow): number | null {
  const s = t.stats[win];
  switch (key) {
    case 'change':
      return s?.priceChangePct ?? null;
    case 'mc':
      return t.marketCapUsd;
    case 'liq':
      return t.liquidityUsd;
    case 'vol':
      return s?.volumeUsd ?? null;
    case 'bs': {
      const b = s?.buys ?? null;
      const sl = s?.sells ?? null;
      if (b === null && sl === null) return null;
      return (b ?? 0) / Math.max(1, sl ?? 0);
    }
    case 'hold':
      return t.holders;
    case 'top10':
      return t.top10Pct;
    case 'curve':
      return t.bondingCurvePct;
    case 'score':
      return t.kryptScore;
  }
}

/** Stable sort; unknowns last either way. No state = the provider's order. */
export function sortRows(rows: TokenSummary[], state: SortState | null | undefined, win: StatsWindow): TokenSummary[] {
  if (!state) return rows;
  const sign = state.dir === 'asc' ? 1 : -1;
  return rows
    .map((t, i) => ({ t, i, v: valueOf(t, state.key, win) }))
    .sort((a, b) => {
      const av = a.v !== null && Number.isFinite(a.v) ? a.v : null;
      const bv = b.v !== null && Number.isFinite(b.v) ? b.v : null;
      if (av === null && bv === null) return a.i - b.i;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return a.i - b.i;
      return (av - bv) * sign;
    })
    .map((x) => x.t);
}

/** none → asc → desc → none. */
export function nextSort(current: SortState | null | undefined, key: SortKey): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

export function SortBar({
  state,
  win,
  onChange,
}: {
  state: SortState | null | undefined;
  win: StatsWindow;
  onChange: (next: SortState | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-white/8 bg-black/15" role="group" aria-label="Sort column">
      {KEYS.map((k) => {
        const active = state?.key === k.key;
        return (
          <button
            key={k.key}
            onClick={() => onChange(nextSort(state, k.key))}
            title={`${k.title} — click to sort lowest → highest, again for highest → lowest, again to clear`}
            className={cls(
              'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-micro font-display tracking-label uppercase transition',
              active ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted/70 hover:text-white hover:bg-white/5',
            )}
          >
            {k.label(win)}
            {active && (state?.dir === 'asc' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />)}
          </button>
        );
      })}
    </div>
  );
}
