// Krypto Trader — the fit check card (design §4, critic #7/#10/#13).
//
// Mechanics of the coin at the size picked, computed in main
// (kryptoTrader:fit). Every unknown is an em dash, never 0 — a depth or an
// activity figure of "0" would read as "empty", which is a claim the app has
// not made. It never shows a probability of climbing: the no-forecast line
// sits on top and the pinned forward line at the bottom.

import { Loader2 } from 'lucide-react';
import type { TraderFit } from '@shared/kryptoTrader';
import { cls } from '../../utils/format';

const DASH = '—';
const n = (v: number | null | undefined, dp = 2, unit = ''): string => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(dp)}${unit}` : DASH);
/** Money in the fit's chain coin (SOL, ETH on Robinhood, BNB). */
const money = (unit: string) => (v: number | null | undefined, dp = 3): string => n(v, dp, ` ${unit}`);
const pct = (v: number | null | undefined, dp = 1): string => n(v, dp, '%');
const mult = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? `price × ${v.toFixed(2)}` : DASH);

function age(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return DASH;
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86_400).toFixed(1)} days`;
}

function venue(f: TraderFit): string {
  if (f.chain !== 'solana') {
    if (f.venue === 'curve') return `${f.venueLabel ?? 'Launch curve'} · ${pct(f.curvePct, 0)} to graduation`;
    if (f.venue === 'pool') return `${f.venueLabel ?? 'Pool'} · ${f.native}-quoted`;
    return `${DASH} (this build trades ${f.native}-quoted launch curves and ${f.native} pools the app can route)`;
  }
  if (f.venue === 'curve') return `pump.fun curve · ${pct(f.curvePct, 0)} sold · ${f.regime === 'classic' ? 'classic' : f.regime === 'mixed' ? 'mixed' : DASH}`;
  if (f.venue === 'pumpswap') return 'Graduated · PumpSwap pool';
  return `${DASH} (this build trades pump.fun curves and PumpSwap pools only)`;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-3 text-body">
        <span className="text-krypt-muted/80">{label}</span>
        <span className="text-right font-mono tabular-nums text-white/90">{value}</span>
      </div>
      {hint && <div className="text-label leading-relaxed text-krypt-muted/70">{hint}</div>}
    </div>
  );
}

export function FitCheck({ fit, loading, error, budgetSol }: { fit: TraderFit | null; loading: boolean; error: string | null; budgetSol: number }) {
  if (!fit && !loading && !error) {
    return <div className="rounded-lg border border-dashed border-white/10 bg-black/20 p-3 text-body text-krypt-muted">Paste a coin address to check how it fits.</div>;
  }
  if (!fit) {
    return (
      <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-body">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-krypt-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the coin…
          </span>
        ) : (
          <span className="text-rose-300">{error}</span>
        )}
      </div>
    );
  }
  const sol = money(fit.native);
  const clipped = fit.clippedBudgetSol !== null && fit.clippedBudgetSol < budgetSol;
  const past = fit.ageSec !== null && fit.ageSec > 120;
  const thin = fit.tradesPerHour !== null && fit.tradesPerHour < 30;
  return (
    <div data-fitcheck className={cls('rounded-lg border bg-black/20 p-3', fit.refusals.length ? 'border-rose-400/30' : 'border-white/10')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-label font-semibold uppercase tracking-label text-krypt-muted">Fit check</span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-krypt-muted" />}
      </div>
      <p className="mt-1 text-label leading-relaxed text-white/80">{fit.noForecastLine}</p>

      {fit.refusals.length > 0 && (
        <div className="mt-2 space-y-1 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-body text-rose-200">
          <div className="font-semibold">This coin can’t run a session:</div>
          {fit.refusals.map((r) => (
            <div key={r}>· {r}</div>
          ))}
        </div>
      )}

      <div className="mt-2 divide-y divide-white/5">
        <Row label="Venue" value={venue(fit)} hint={fit.graduationNote} />
        <Row
          label="Pool depth"
          value={sol(fit.depthSol, 2)}
          hint={
            fit.depthSol === null
              ? 'Unknown — no buy can be sized while it is.'
              : `Budget = ${pct(fit.budgetPctOfDepth)} of depth · a full exit moves price −${pct(fit.fullExitMovePct)} · largest single trade at a 2% move: ${sol(fit.maxTradeAt2PctSol)}`
          }
        />
        <Row
          label="Budget cap (10% exit move)"
          value={sol(fit.budgetCapSol)}
          hint={clipped ? `Clipped to ${sol(fit.clippedBudgetSol)}: a full exit would move price more than 10%.` : null}
        />
        <Row label="Age" value={age(fit.ageSec)} hint={past ? 'Graduation odds only exist at +60/+120 s; this coin is past that.' : null} />
        <Row
          label="If holders sold into the pool"
          value=""
          hint={`dev ${mult(fit.dumpImpact.dev)} · top 10 ${mult(fit.dumpImpact.top10)} · snipers ${mult(fit.dumpImpact.sniper)} · bundled ${mult(fit.dumpImpact.bundled)}. An impact, not a score.`}
        />
        <Row
          label="Activity"
          value={fit.tradesPerHour === null ? DASH : `${Math.round(fit.tradesPerHour)} trades/h`}
          hint={`Volume ${fit.volumeTrend ?? DASH} (1 h vs the 6 h and 24 h pace — a description, not a forecast) · organic ${pct(fit.organicSharePct, 0)}${thin ? ' · Your orders would be most of the market.' : ''}`}
        />
        <Row
          label="Creator"
          value={`${fit.creator.launches ?? DASH} launches · ${fit.creator.graduations ?? DASH} graduated`}
          hint="The one separator seen in our tests, on n=19 — anecdotal."
        />
        <Row label="Safety (Krypt score)" value={fit.kryptScore === null ? DASH : `${fit.kryptScore}/100`} hint="Safety checks only; not a forecast." />
        <Row
          label="Round trip costs about"
          value={pct(fit.roundTripCostPct)}
          hint={`Krypt 0.5%/side + pool fee + your own price impact. Smallest price move between opposite trades for this coin: ${pct(fit.d7FloorPct)}.`}
        />
        <Row label={fit.chain === 'solana' ? 'Per-trade cap (Execution settings)' : 'Per-trade cap'} value={fit.chain === 'solana' ? sol(fit.maxLiveSol) : fit.maxLiveSol === null ? `none on ${fit.native}` : sol(fit.maxLiveSol)} hint={fit.entryBuys !== null ? `The entry takes ${fit.entryBuys} buy${fit.entryBuys === 1 ? '' : 's'} at these settings.` : null} />
      </div>

      {fit.liveRefusals.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/[0.07] p-2 text-label leading-relaxed text-amber-100/85">
          Paper is allowed; going live would be refused: {fit.liveRefusals.join(' ')}
        </div>
      )}
      {fit.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-label leading-relaxed text-krypt-muted">
          {fit.notes.map((x) => (
            <li key={x}>· {x}</li>
          ))}
        </ul>
      )}
      <p data-forward className="mt-2 border-t border-white/5 pt-2 text-label leading-relaxed text-krypt-muted/80">
        {fit.forwardLine}
      </p>
    </div>
  );
}
