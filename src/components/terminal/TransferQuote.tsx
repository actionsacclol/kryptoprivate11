// One transfer quote, said the same way everywhere it is shown — the Bridge
// page and the All-in-One wallet's "Move between chains". What arrives, what
// it costs (Krypt's share named on its own line), how long, and — said
// plainly — what this app can and cannot prove about where it ends up.
import { useEffect, useState } from 'react';
import { QUOTE_LIFE_MS, QUOTE_UI_MARGIN_MS, costPct, nativeSymbolOf, sizeWarning, type BridgeQuote } from '@shared/bridge';

/**
 * Seconds this quote can still be sent, counted from when it was QUOTED —
 * the same life main enforces, less a margin for the round trip. Zero once
 * it is spent: the page must then offer a new quote, never a send that main
 * would refuse as expired.
 */
export function useQuoteClock(quote: BridgeQuote | null, quotedAt: number | null): { expired: boolean; secondsLeft: number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!quote || quotedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [quote, quotedAt]);
  if (!quote || quotedAt === null) return { expired: false, secondsLeft: 0 };
  const life = QUOTE_LIFE_MS[quote.rail ?? 'lifi'] - QUOTE_UI_MARGIN_MS;
  const left = Math.max(0, quotedAt + life - now);
  return { expired: left <= 0, secondsLeft: Math.ceil(left / 1000) };
}

function fromRaw(raw: string, decimals: number): number | null {
  try {
    const n = Number(BigInt(raw)) / 10 ** decimals;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function TransferQuote({ quote }: { quote: BridgeQuote }) {
  const out = fromRaw(quote.toAmountRaw, quote.toDecimals);
  const outMin = fromRaw(quote.toAmountMinRaw, quote.toDecimals);
  const pct = costPct(quote);
  const warning = sizeWarning(quote);
  return (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-body leading-relaxed">
      <div className="text-white/90">
        You receive about <span className="font-mono">{out === null ? '—' : out.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>{' '}
        {nativeSymbolOf(quote.to)}
        {outMin !== null && <span className="text-krypt-muted"> · at least {outMin.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>}
      </div>
      <div className="text-krypt-muted">
        via <span className="text-white/70">{quote.tool}</span>
        {quote.durationSec !== null && <> · usually about {quote.durationSec}s</>}
        {pct !== null && <> · costs {pct.toFixed(2)}% in all</>}
      </div>
      {quote.kryptFeeNote && (
        <div className="text-krypt-muted">
          {quote.kryptFeeNote}
          {typeof quote.kryptFeeUsd === 'number' && <> · about ${quote.kryptFeeUsd.toFixed(quote.kryptFeeUsd < 1 ? 3 : 2)}</>}
          {' '}— included in the cost above.
        </div>
      )}
      {/* The asymmetry, said plainly. Never a tick that means less on one
          rail than the other. */}
      <div className={quote.assurance === 'verified' ? 'text-emerald-300/90' : 'text-amber-200/80'}>
        {quote.assurance === 'verified'
          ? quote.rail === 'relay'
            ? 'Checked: this transaction commits to an order paying your own address on the far side, at no less than the minimum shown. That Relay delivers it is still Relay’s promise.'
            : 'Checked: this transaction names your own address on the far side.'
          : quote.rail === 'relay'
            ? 'Not checkable in the transaction: it carries only a commitment to where it ends up, so the destination is Relay’s promise. The app checks how much leaves and where it goes on this chain, and afterwards that Relay’s record names this deposit.'
            : 'Not checkable: a Solana transfer carries no record of where it ends up. The destination is this bridge’s promise, not something we can prove.'}
      </div>
      {warning && <div className="text-amber-200/80">{warning}</div>}
    </div>
  );
}
