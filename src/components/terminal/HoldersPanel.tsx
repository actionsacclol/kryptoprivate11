import type { HolderReport, HolderTag } from '@shared/market';
import { cls, fmtNum, fmtPctOrDash, shortAddr } from '../../utils/format';

const TAG_STYLE: Record<HolderTag, string> = {
  dev: 'bg-rose-500/15 text-rose-300 border-rose-400/30',
  insider: 'bg-orange-500/15 text-orange-300 border-orange-400/30',
  sniper: 'bg-amber-500/15 text-amber-300 border-amber-400/30',
  bundle: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/30',
  smart: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  fresh: 'bg-sky-500/15 text-sky-300 border-sky-400/30',
  whale: 'bg-krypt-purple/20 text-krypt-pink border-krypt-purple/40',
  lp: 'bg-white/8 text-krypt-muted border-white/15',
  unknown: 'bg-white/5 text-krypt-muted border-white/10',
};

const TAG_LABEL: Record<HolderTag, string> = {
  dev: 'DEV',
  insider: 'INSIDER',
  sniper: 'SNIPER',
  bundle: 'BUNDLE',
  smart: 'SMART',
  fresh: 'FRESH',
  whale: 'WHALE',
  lp: 'LP',
  unknown: '',
};

export function HoldersPanel({ report }: { report: HolderReport }) {
  const openSolscan = (addr: string) => () => {
    void window.krypt.app.openExternal(`https://solscan.io/account/${addr}`);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-4 text-body">
        <span className="text-krypt-muted">
          Holders: <span className="text-white/90 font-mono">{fmtNum(report.holderCount)}</span>
        </span>
        <span className="text-krypt-muted">
          Supply: <span className="text-white/90 font-mono">{fmtNum(report.totalSupply)}</span>
        </span>
        <span className="ml-auto text-label text-krypt-muted/50 uppercase tracking-label">
          via {report.source}
        </span>
      </div>

      {report.rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 bg-black/20 px-3 py-6 text-center">
          <p className="text-body text-krypt-muted">{report.note ?? 'No holder data available.'}</p>
        </div>
      ) : (
        <>
          <div className="space-y-0.5 max-h-[340px] overflow-y-auto pr-1">
            {report.rows.map((r, i) => (
              <div
                key={r.address}
                className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-white/[0.04] transition group"
              >
                <span className="w-5 text-label font-mono text-krypt-muted/50 text-right">{i + 1}</span>
                <button
                  onClick={openSolscan(r.owner ?? r.address)}
                  className="font-mono text-body text-white/85 hover:text-krypt-purple transition"
                  title={r.owner ? `Owner ${r.owner}` : `Token account ${r.address}`}
                >
                  {shortAddr(r.owner ?? r.address, 5)}
                </button>
                {r.label && <span className="text-label text-arc-gold truncate max-w-[90px]">{r.label}</span>}
                <div className="flex items-center gap-1">
                  {r.tags.filter((t) => TAG_LABEL[t]).map((t) => (
                    <span
                      key={t}
                      className={cls('rounded border px-1 text-nano font-bold tracking-wider', TAG_STYLE[t])}
                    >
                      {TAG_LABEL[t]}
                    </span>
                  ))}
                </div>
                {/* A share nobody could compute (no supply to divide by, or
                    the provider sent null) is an unknown: empty bar, em dash.
                    `pct === 0` with no total supply is the same unknown that
                    older providers encoded as zero. */}
                {(() => {
                  const pct: number | null =
                    r.pct === null || r.pct === undefined || !Number.isFinite(r.pct)
                      ? null
                      : r.pct === 0 && report.totalSupply === null
                        ? null
                        : r.pct;
                  return (
                    <>
                      <div className="flex-1 h-1 rounded-full bg-white/6 overflow-hidden min-w-[24px]">
                        {pct !== null && (
                          <div
                            className={cls('h-full rounded-full', pct >= 10 ? 'bg-rose-400/70' : 'bg-krypt-purple/60')}
                            style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
                          />
                        )}
                      </div>
                      <span
                        className={cls('w-14 text-right text-body font-mono', pct === null ? 'text-krypt-muted/60' : 'text-white/85')}
                        title={pct === null ? 'Share of supply not known — the total supply was not read' : undefined}
                      >
                        {fmtPctOrDash(pct, 2)}
                      </span>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
          {report.note && <p className="text-label text-krypt-muted/55 leading-relaxed pt-1">{report.note}</p>}
        </>
      )}
    </div>
  );
}
