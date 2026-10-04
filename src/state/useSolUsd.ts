import { useEffect, useState } from 'react';

// SOL in USD from main's shared price provider (2026-10-03), for the wallet
// pages' dollar values. One module-level last value, so a page that mounts
// after another already read it paints a number at once instead of a dash.
let last: number | null = null;

/** SOL in USD, refreshed every minute while the window is visible. Null =
 *  unknown: the caller shows an em dash, never $0. */
export function useSolUsd(): number | null {
  const [v, setV] = useState<number | null>(last);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      if (document.hidden && last !== null) return;
      void window.krypt.market.solUsd().then((r) => {
        if (!alive || !r.ok || typeof r.data !== 'number' || !(r.data > 0)) return;
        last = r.data;
        setV(r.data);
      });
    };
    read();
    const t = window.setInterval(read, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return v;
}

/** "≈ $1.23" for an amount of a coin at a USD rate; '' when either is unknown. */
export function approxUsd(amount: number | null | undefined, usdPerUnit: number | null | undefined, fmt: (v: number) => string): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  if (usdPerUnit === null || usdPerUnit === undefined || !(usdPerUnit > 0)) return '';
  return `≈ ${fmt(amount * usdPerUnit)}`;
}
