// The $KRYPTO card on the Hub — see shared/krypto.ts for the rules.
//
// "Buy" opens the token page, not a one-click order: the buy there runs
// through the same Paper/Live gate, arm state, slippage and security panel
// as any other token. A one-tap buy of the maker's own coin on the first
// screen would be the one place this app pressures instead of informs.

import { useEffect, useState } from 'react';
import { Coins, ExternalLink } from 'lucide-react';
import { KRYPTO_TOKEN, kryptoDisclosure, kryptoPumpUrl, kryptoTokenLive } from '@shared/krypto';
import type { TokenSummary } from '@shared/market';

/** Unknown is an em dash. Never 0. */
const usd = (v: number | null): string => (v === null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const price = (v: number | null): string => (v === null ? '—' : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`);
const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`);
const count = (v: number | null): string => (v === null ? '—' : v.toLocaleString());

export function KryptoCard({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const mint = kryptoTokenLive() ? (KRYPTO_TOKEN.mint as string) : null;
  const [row, setRow] = useState<TokenSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mint) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await window.krypt.market.summary(mint);
        if (!alive) return;
        if (r.ok && r.data) {
          setRow(r.data);
          setFailed(false);
        } else setFailed(true);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint]);

  if (!mint) return null;

  const stat = (label: string, value: string) => (
    <div className="min-w-[84px]">
      <div className="text-[9px] uppercase tracking-[0.18em] text-krypt-muted/60">{label}</div>
      <div className="font-mono text-[13px] text-white/90">{value}</div>
    </div>
  );

  return (
    <section className="mt-10 rounded-xl border border-krypt-purple/30 bg-krypt-panel p-5 shadow-krypt-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="rounded-lg border border-krypt-purple/30 bg-krypt-purple/10 p-2 text-krypt-pink">
            <Coins className="h-5 w-5" />
          </span>
          <div>
            <div className="text-[15px] font-semibold text-white">
              ${KRYPTO_TOKEN.symbol} <span className="font-normal text-krypt-muted">· {KRYPTO_TOKEN.name}</span>
            </div>
            <div className="text-[12px] text-krypt-muted">Krypt's own token, on pump.fun.</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-5">
          {stat('Price', price(row?.priceUsd ?? null))}
          {stat('Market cap', usd(row?.marketCapUsd ?? null))}
          {stat('Curve', row && row.bondingCurvePct === null && row.marketCapUsd !== null ? 'graduated' : pct(row?.bondingCurvePct ?? null))}
          {stat('Holders', count(row?.holders ?? null))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenToken(mint)}
            className="rounded-lg bg-krypt-gradient px-4 py-2 text-[12px] font-semibold text-white transition hover:opacity-90"
            title="Open the token page — the buy there uses your Paper/Live setting, arm state and slippage like any other token"
          >
            Buy ${KRYPTO_TOKEN.symbol}
          </button>
          <button
            onClick={() => void window.krypt.app.openExternal(kryptoPumpUrl(mint))}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-krypt-muted transition hover:text-white"
            title="Open on pump.fun in your browser"
          >
            <ExternalLink className="h-3.5 w-3.5" /> pump.fun
          </button>
        </div>
      </div>
      {failed && <p className="mt-2 text-[11px] text-amber-300/90">Could not read the market for it right now — the numbers above are the last known, or unknown.</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-krypt-muted/80">{kryptoDisclosure()}</p>
    </section>
  );
}
