import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import type { CreatorHistory, EarlyWallet, LaunchCohort, LaunchIntelReport } from '@shared/launchintel';
import { creatorVerdict } from '@shared/launchintel';
import { cls, fmtAgo, fmtNum, fmtPctOrDash, fmtSol, fmtUsd, shortAddr } from '../../utils/format';

// Who bought the first block, and are they still holding.
//
// This panel is the answer to the question every competing terminal charges
// for and every free one fakes. Two rules keep it honest:
//
//   1. Bought and still-held are ALWAYS shown together. A 40% bundle that has
//      fully exited is a historical curiosity; a 40% bundle still sitting on
//      it is the reason not to buy, and one number cannot say which.
//   2. When the launch window could not be isolated, this panel shows the
//      reason and NO cohorts. There is no "approximately" mode.

const COHORT_TONE: Record<string, string> = {
  dev: 'text-arc-gold border-arc-gold/30 bg-arc-gold/10',
  bundle: 'text-rose-300 border-rose-400/30 bg-rose-400/10',
  sniper: 'text-sky-300 border-sky-400/30 bg-sky-400/10',
  early: 'text-krypt-muted border-white/10 bg-white/[0.03]',
};

function CohortCard({
  title,
  blurb,
  cohort,
  danger,
}: {
  title: string;
  blurb: string;
  cohort: LaunchCohort;
  danger: number;
}) {
  const bought = cohort.boughtPct;
  const held = cohort.heldPct;
  const tone = (v: number | null) =>
    v === null ? 'text-krypt-muted' : v >= danger ? 'text-rose-400' : v >= danger * 0.6 ? 'text-arc-gold' : 'text-emerald-400';

  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-krypt-muted">{title}</h4>
        <span className="text-[10px] font-mono text-krypt-muted">
          {cohort.wallets} {cohort.wallets === 1 ? 'wallet' : 'wallets'}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className={cls('font-mono text-xl', tone(bought))}>{fmtPctOrDash(bought, 2)}</span>
        <span className="text-[10px] text-krypt-muted">of supply bought</span>
      </div>

      <div className="space-y-1 pt-1 border-t border-white/5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-krypt-muted">Still holds</span>
          <span className={cls('font-mono', tone(held))}>{fmtPctOrDash(held, 2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-krypt-muted">Of what they bought</span>
          <span className="font-mono text-white/85">
            {cohort.retainedPct === null ? '—' : `${cohort.retainedPct.toFixed(0)}% kept`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-krypt-muted">Wallets still in</span>
          <span className="font-mono text-white/85">
            {cohort.stillHolding === null ? '—' : `${cohort.stillHolding}/${cohort.wallets}`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-krypt-muted">Spent</span>
          <span className="font-mono text-white/85">{cohort.sol > 0 ? `${fmtSol(cohort.sol, 2)} SOL` : '—'}</span>
        </div>
      </div>

      <p className="text-[9px] leading-relaxed text-krypt-muted/55">{blurb}</p>
    </div>
  );
}

function WalletRow({ w, creator }: { w: EarlyWallet; creator: string | null }) {
  const open = () => void window.krypt.app.openExternal(`https://solscan.io/account/${w.address}`);
  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.03] transition">
      <td className="py-1.5 pr-2">
        <button onClick={open} className="group flex items-center gap-1.5 font-mono text-[11px] text-white/85">
          {shortAddr(w.address, 4)}
          <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60" />
        </button>
      </td>
      <td className="py-1.5 pr-2">
        <span className={cls('rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider', COHORT_TONE[w.cohort])}>
          {w.address === creator ? 'dev' : w.cohort}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11px] text-krypt-muted">
        {w.slotOffset === 0 ? 'launch' : `+${w.slotOffset}`}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11px] text-white/85">{fmtPctOrDash(w.boughtPct, 2)}</td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11px]">
        {w.heldPct === null ? (
          <span className="text-krypt-muted">—</span>
        ) : (
          <span className={w.heldPct > 0 ? 'text-emerald-400' : 'text-krypt-muted/60'}>{fmtPctOrDash(w.heldPct, 2)}</span>
        )}
      </td>
      <td className="py-1.5 text-right font-mono text-[10px] text-krypt-muted">{fmtSol(w.sol, 2)}</td>
    </tr>
  );
}

function CreatorBlock({ history }: { history: CreatorHistory }) {
  // A first launch is the ABSENCE of a record, not a pass: nothing has been
  // observed about this wallet, so nothing is coloured green for it.
  const firstLaunch = history.launches <= 1;
  const v = firstLaunch
    ? { verdict: null, detail: 'First launch from this wallet on pump.fun — no record.' }
    : creatorVerdict(history);
  const tone =
    v.verdict === 'fail' ? 'text-rose-400' : v.verdict === 'warn' ? 'text-arc-gold' : v.verdict === 'pass' ? 'text-emerald-400' : 'text-krypt-muted';
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3 space-y-2">
      <div className="flex items-center gap-3">
        <h4 className="font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-krypt-muted whitespace-nowrap">
          Creator track record
        </h4>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      </div>

      <p className={cls('text-[12px]', tone)}>{v.detail}</p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60">Launches</div>
          <div className="font-mono text-white/85">
            {history.launches}
            {history.truncated ? '+' : ''}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60">Graduated</div>
          <div className="font-mono text-white/85">
            {history.graduated} <span className="text-krypt-muted">({fmtPctOrDash(history.graduationRate, 0)})</span>
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60">Busiest day</div>
          <div className={cls('font-mono', history.launchesInBusiestDay >= 10 ? 'text-rose-400' : 'text-white/85')}>
            {history.launchesInBusiestDay}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60">Median peak</div>
          <div className="font-mono text-white/85">{fmtUsd(history.medianAthUsd)}</div>
        </div>
      </div>

      {history.recent.length > 1 && (
        <div className="space-y-1 pt-1">
          <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60">Recent launches</div>
          <div className="flex flex-wrap gap-1">
            {history.recent.map((l) => (
              <button
                key={l.mint}
                onClick={() => void window.krypt.app.openExternal(`https://solscan.io/token/${l.mint}`)}
                title={`${l.name ?? l.symbol ?? l.mint}\n${new Date(l.createdAt).toLocaleString()}\n${
                  l.graduated ? 'graduated' : 'never graduated'
                }${l.athUsd ? `\npeak ${fmtUsd(l.athUsd)}` : ''}`}
                className={cls(
                  'rounded px-1.5 py-0.5 text-[9px] font-mono border transition hover:border-white/25',
                  l.graduated
                    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                    : 'border-white/8 bg-white/[0.03] text-krypt-muted',
                )}
              >
                {l.symbol ?? shortAddr(l.mint, 3)}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-[9px] leading-relaxed text-krypt-muted/50">
        pump.fun launches only{history.truncated ? ', capped at 200' : ''} — launches on other platforms are invisible
        to this, so treat a small number as "nothing found here", not "clean".
      </p>
    </div>
  );
}

export function LaunchPanel({
  report,
  history,
  loading,
}: {
  report: LaunchIntelReport | null;
  history: CreatorHistory | null;
  loading: boolean;
}) {
  if (loading && !report) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
        <p className="text-[11px] text-krypt-muted max-w-sm leading-relaxed">
          Seeking this token's first block of trades, then reading what those wallets hold now.
        </p>
      </div>
    );
  }
  if (!report) return <p className="py-8 text-center text-[11px] text-krypt-muted">No launch data.</p>;

  const a = report.analysis;
  const measured = a.complete && a.tradesScanned > 0;

  return (
    <div className="space-y-3">
      {!measured && (
        <div className="flex items-start gap-2.5 rounded-lg border border-arc-gold/25 bg-arc-gold/[0.06] px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-arc-gold mt-0.5" />
          <div className="space-y-1">
            <p className="text-[12px] text-white/85">Launch cohorts not measured</p>
            <p className="text-[11px] leading-relaxed text-krypt-muted">{report.note ?? 'No launch window available.'}</p>
          </div>
        </div>
      )}

      {measured && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-krypt-muted">
            <span>
              Launch slot <span className="font-mono text-white/80">{fmtNum(a.launchSlot)}</span>
            </span>
            {a.launchTs !== null && <span>{fmtAgo(a.launchTs)}</span>}
            <span>
              <span className="font-mono text-white/80">{a.tradesScanned}</span> trades scanned
            </span>
            <span>
              <span className="font-mono text-white/80">{a.wallets.length}</span> buyers
            </span>
            {report.balancesNote && <span className="text-arc-gold/80">{report.balancesNote}</span>}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <CohortCard
              title="Dev"
              blurb="The creator's own wallet, buying its own launch."
              cohort={a.dev}
              danger={10}
            />
            <CohortCard
              title="Bundle"
              blurb="Wallets that bought in the SAME slot as the first trade. Nobody reacts that fast — same-slot buys were arranged in advance."
              cohort={a.bundle}
              danger={20}
            />
            <CohortCard
              title="Snipers"
              blurb={`Wallets whose first buy landed within ${report.sniperWindowSlots} slots (~${Math.round(
                report.sniperWindowSlots * 0.4,
              )}s) after the launch slot. Fast, but reactive.`}
              cohort={a.snipers}
              danger={25}
            />
          </div>

          {a.wallets.length > 0 && (
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
              <div className="flex items-center gap-3 mb-1.5">
                <h4 className="font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-krypt-muted whitespace-nowrap">
                  Launch buyers
                </h4>
                <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
              </div>
              <div className="max-h-72 overflow-y-auto pr-1">
                <table className="w-full">
                  <thead className="sticky top-0 bg-krypt-bg/95 backdrop-blur">
                    <tr className="text-[9px] uppercase tracking-wider text-krypt-muted/60">
                      <th className="pb-1 text-left font-medium">Wallet</th>
                      <th className="pb-1 text-left font-medium">Cohort</th>
                      <th className="pb-1 text-right font-medium">Slot</th>
                      <th className="pb-1 text-right font-medium">Bought</th>
                      <th className="pb-1 text-right font-medium">Holds now</th>
                      <th className="pb-1 text-right font-medium">SOL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.wallets.map((w) => (
                      <WalletRow key={w.address} w={w} creator={report.creator} />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="pt-1.5 text-[9px] leading-relaxed text-krypt-muted/50">
                "Holds now" is the wallet's current balance in its associated token account, read from your RPC. A
                wallet holding elsewhere reads as zero, so this is a floor.
              </p>
            </div>
          )}
        </>
      )}

      {history ? (
        <CreatorBlock history={history} />
      ) : (
        report.creator && (
          <p className="text-[11px] text-krypt-muted/60">
            No wider record for {shortAddr(report.creator, 6)} — pump.fun lists no other launches from this wallet.
          </p>
        )
      )}
    </div>
  );
}
