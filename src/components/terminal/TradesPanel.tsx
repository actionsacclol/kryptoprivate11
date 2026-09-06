import type { TradeRow, TraderScanRow } from '@shared/market';
import { cls, fmtDur, fmtUsd, shortAddr, toneFor } from '../../utils/format';

// Live trades and Trader Scan (term.txt sections 8 and 5).
//
// Both read from the app's own tape by default. That is a real limitation
// and it is stated on screen rather than hidden: the window starts when you
// open the token, so a coin you just found shows a few seconds of history,
// not its whole life. A Birdeye key backfills it.

function clock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return '—';
  }
}

export function LiveTrades({
  rows,
  note,
  source,
}: {
  rows: TradeRow[];
  note: string | null;
  source: string;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-md border border-dashed border-white/10 bg-black/20 px-3 py-6 text-center">
        <p className="text-[11px] text-krypt-muted leading-relaxed">{note ?? 'No trades yet.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-krypt-muted/60 px-2">
        <span className="w-14">Time</span>
        <span className="w-10">Side</span>
        <span className="w-20">SOL</span>
        <span className="flex-1">Wallet</span>
        <span className="w-24 text-right">Market cap</span>
      </div>
      <div className="max-h-[300px] overflow-y-auto pr-1 space-y-0.5">
        {rows.map((t, i) => (
          <div
            key={`${t.at}-${t.wallet}-${i}`}
            className="flex items-center gap-2 rounded px-2 py-1 text-[11px] font-mono hover:bg-white/[0.04] transition"
          >
            <span className="w-14 text-krypt-muted/70">{clock(t.at)}</span>
            <span className={cls('w-10 font-bold', t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400')}>
              {t.side === 'buy' ? 'BUY' : 'SELL'}
            </span>
            <span className="w-20 text-white/90">{t.solAmount.toFixed(3)}</span>
            {/* Raydium LaunchLab trades arrive over a LOG subscription, which
                carries no account list — so those ticks genuinely have no
                trader. Render the unknown as an em dash and drop the link,
                rather than shipping a button to solscan/account/<nothing>. */}
            {t.wallet ? (
              <button
                onClick={() => void window.krypt.app.openExternal(`https://solscan.io/account/${t.wallet}`)}
                className="flex-1 text-left text-white/70 hover:text-krypt-purple truncate"
                title={t.wallet}
              >
                {t.label ? <span className="text-arc-gold">{t.label}</span> : shortAddr(t.wallet, 4)}
              </button>
            ) : (
              <span
                className="flex-1 text-left text-krypt-muted/50"
                title="This launchpad publishes trades as logs, which carry no trader address"
              >
                —
              </span>
            )}
            <span className="w-24 text-right text-krypt-muted">{fmtUsd(t.marketCapUsd)}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-krypt-muted/50 px-2">
        {note ?? `Source: ${source}`}
      </p>
    </div>
  );
}

export function TraderScan({ rows, note }: { rows: TraderScanRow[]; note: string | null }) {
  if (!rows.length) {
    return (
      <div className="rounded-md border border-dashed border-white/10 bg-black/20 px-3 py-6 text-center">
        <p className="text-[11px] text-krypt-muted leading-relaxed">{note ?? 'No trader data.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-krypt-muted/60 px-2">
        <span className="flex-1">Wallet</span>
        <span className="w-16 text-right">Bought</span>
        <span className="w-16 text-right">Sold</span>
        <span className="w-16 text-right">Holding</span>
        <span className="w-20 text-right">Realized</span>
        <span className="w-16 text-right">Held</span>
      </div>
      <div className="max-h-[300px] overflow-y-auto pr-1 space-y-0.5">
        {rows.map((r) => (
          <div
            key={r.wallet}
            className="flex items-center gap-2 rounded px-2 py-1 text-[11px] font-mono hover:bg-white/[0.04] transition"
          >
            <button
              onClick={() => void window.krypt.app.openExternal(`https://solscan.io/account/${r.wallet}`)}
              className="flex-1 text-left text-white/75 hover:text-krypt-purple truncate"
              title={r.wallet}
            >
              {r.label ? <span className="text-arc-gold">{r.label}</span> : shortAddr(r.wallet, 5)}
            </button>
            <span className="w-16 text-right text-emerald-400/85">{r.boughtSol.toFixed(2)}</span>
            <span className="w-16 text-right text-rose-400/85">{r.soldSol.toFixed(2)}</span>
            {/* Holding is null when the wallet's balance could not be read
                or priced — an em dash, never a zero the user would read as
                "fully exited". */}
            <span className={cls('w-16 text-right', r.holdingSol === null ? 'text-krypt-muted/60' : 'text-white/85')}>
              {r.holdingSol === null || r.holdingSol === undefined || !Number.isFinite(r.holdingSol)
                ? '—'
                : r.holdingSol.toFixed(2)}
            </span>
            <span className={cls('w-20 text-right', toneFor(r.realizedPnlSol))}>
              {r.realizedPnlSol >= 0 ? '+' : ''}{r.realizedPnlSol.toFixed(3)}
            </span>
            <span className="w-16 text-right text-krypt-muted">{r.holdMs === null ? '—' : fmtDur(r.holdMs)}</span>
          </div>
        ))}
      </div>
      {note && <p className="text-[10px] text-krypt-muted/50 px-2 leading-relaxed">{note}</p>}
      <p className="text-[10px] text-krypt-muted/40 px-2">
        Amounts in SOL. Realized PnL covers only the window this app has taped.
      </p>
    </div>
  );
}
