// Which chain a panel is showing.
//
// Three rails now produce launches, runners, positions and balances, and a
// panel that silently meant "Solana" was lying by omission on two thirds of
// the app. Each chain-aware panel carries its own filter, because the whole
// point of a custom layout is putting Solana launches next to BNB ones rather
// than choosing between them.
//
// The choice is PER PANEL and per machine: it is a view preference, like the
// grid arrangement beside it, and it lives in the same localStorage the rest
// of this folder uses. Every access is wrapped — losing a filter is an
// annoyance, a panel that will not render is not.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ChainKind } from '@shared/evm';

/** `all` is a real choice, not the absence of one. */
export type ChainFilterValue = 'all' | ChainKind;

export const CHAIN_FILTER_OPTIONS: Array<{ value: ChainFilterValue; label: string }> = [
  { value: 'all', label: 'All chains' },
  { value: 'solana', label: 'Solana' },
  { value: 'robinhood', label: 'Robinhood' },
  { value: 'bnb', label: 'BNB' },
];

const KEY = 'krypt.panels.chainFilter.v1';

function load(): Record<string, ChainFilterValue> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, ChainFilterValue>) : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, ChainFilterValue>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* a filter that cannot be remembered still works for this session */
  }
}

const valid = (v: unknown): v is ChainFilterValue =>
  v === 'all' || v === 'solana' || v === 'robinhood' || v === 'bnb';

export function loadChainFilter(panelId: string): ChainFilterValue {
  const v = load()[panelId];
  return valid(v) ? v : 'all';
}

export function storeChainFilter(panelId: string, value: ChainFilterValue): void {
  const map = load();
  map[panelId] = value;
  save(map);
}

/**
 * What the panel currently shows. Defaults to `all` so a panel rendered
 * outside a provider — a preview, a test — shows everything rather than
 * nothing, which is the safer way to be wrong.
 */
export const PanelChainContext = createContext<ChainFilterValue>('all');

export function usePanelChain(): ChainFilterValue {
  return useContext(PanelChainContext);
}

/** True when a row on `chain` belongs in a panel filtered to `filter`. */
export function chainMatches(filter: ChainFilterValue, chain: ChainKind): boolean {
  return filter === 'all' || filter === chain;
}

/** Panel-scoped filter state, kept in sync with storage. */
export function useChainFilter(panelId: string): [ChainFilterValue, (v: ChainFilterValue) => void] {
  const [value, setValue] = useState<ChainFilterValue>(() => loadChainFilter(panelId));
  // A panel's id can change under the same component when the grid reorders,
  // so the stored value is re-read rather than assumed from the first mount.
  useEffect(() => {
    setValue(loadChainFilter(panelId));
  }, [panelId]);
  const set = useCallback(
    (v: ChainFilterValue) => {
      setValue(v);
      storeChainFilter(panelId, v);
    },
    [panelId],
  );
  return [value, set];
}

/**
 * The control itself: a small select, deliberately not a row of buttons —
 * four chains would eat a header that also has to hold a title and two icons,
 * and this sits in panels as narrow as three grid columns.
 */
export function ChainFilter({
  value,
  onChange,
  title,
}: {
  value: ChainFilterValue;
  onChange: (v: ChainFilterValue) => void;
  title?: string;
}) {
  return (
    <select
      // Two different drag systems have to be told to leave this alone, and
      // they are not the same mechanism:
      //   `panel-action` — react-grid-layout's draggableCancel, so opening the
      //     menu does not drag the panel inside the grid;
      //   `no-drag` — the OS app-region, so it does not drag the WINDOW when
      //     the panel is popped out.
      // The class goes on the control itself, never on a wrapper: a `no-drag`
      // wrapper spanning the header takes the whole strip out of the window's
      // drag region, which is exactly how the frameless window stopped being
      // movable.
      className="panel-action no-drag max-w-[7.5rem] cursor-pointer rounded border border-white/10 bg-black/30 px-1 py-0.5 text-micro text-krypt-muted outline-none transition hover:text-white focus:border-krypt-purple/50"
      value={value}
      onChange={(e) => onChange(e.target.value as ChainFilterValue)}
      onPointerDown={(e) => e.stopPropagation()}
      title={title ?? 'Which chain this panel shows'}
      aria-label="Chain"
    >
      {CHAIN_FILTER_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
