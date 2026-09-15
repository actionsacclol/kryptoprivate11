// The token the chart panel is showing.
//
// A chart panel needs a subject, and the useful one is "whatever I just
// opened" — click a runner, watch its chart. So opening a token anywhere in
// the app writes it here and the panel follows.
//
// It has to cross WINDOWS, because a chart is the panel most worth popping
// out. localStorage is shared between same-origin BrowserWindows and the
// `storage` event fires in the OTHER windows when one writes, which is exactly
// the shape needed and costs no IPC. The same-window case gets its own
// CustomEvent, because `storage` deliberately does not fire in the window that
// wrote it.
//
// No imports: this is read by App on every token open, and a leaf cannot
// create the kind of cycle src/panels/windowId.ts exists to avoid.

export interface ChartToken {
  mint: string;
  /** 'solana' | 'robinhood' | 'bnb' — kept as a string so this stays a leaf. */
  chain: string;
  symbol?: string;
}

const KEY = 'krypt.panels.chartToken.v1';
const EVENT = 'krypt:chart-token';

export function loadChartToken(): ChartToken | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const t = v as Partial<ChartToken>;
    if (typeof t.mint !== 'string' || !t.mint || typeof t.chain !== 'string') return null;
    return { mint: t.mint, chain: t.chain, symbol: typeof t.symbol === 'string' ? t.symbol : undefined };
  } catch {
    return null;
  }
}

export function setChartToken(t: ChartToken): void {
  try {
    const prev = loadChartToken();
    if (prev && prev.mint === t.mint && prev.chain === t.chain) return;
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* a chart that cannot remember its token still charts this one */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* same-window notification only; other windows hear `storage` */
  }
}

/** Fires on a change from THIS window (CustomEvent) or another (storage). */
export function subscribeChartToken(fn: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key === KEY) fn();
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', onStorage);
  };
}
