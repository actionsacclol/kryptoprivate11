import type { OddsReport } from '@shared/odds';
import { cls } from '../../utils/format';
import { ODDS_BUCKET_LABEL, ODDS_NOT_JUDGED, REGIME_LABEL, oddsTone } from '../../utils/odds';
import { SectionHeader } from '../common';

// Graduation odds, phase-1 style (docs/insight-swarm-2026-08-30.md §B): the
// bucket this launch fell in under the shipped model, and beneath it the
// OBSERVED rate for that bucket on the reference day — with n and the base
// rate — never a per-token probability. The lines come verbatim from the
// report (docs/runner-odds-2026-08-30.md §7 is the only allowed wording);
// this component only lays them out.
//
// Tone rules mirror the rug badges: no green anywhere, and the top buckets
// are gold/purple rather than a "buy" colour, because 15 in 100 graduating
// still means 85 in 100 did not.

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded border border-white/10 bg-white/5 px-1.5 py-px text-micro font-mono text-krypt-muted whitespace-nowrap"
    >
      {children}
    </span>
  );
}

export function OddsPanel({ odds }: { odds: OddsReport | null }) {
  if (odds === null) {
    return (
      <div className="space-y-2">
        <SectionHeader title="Graduation odds (measured)" />
        <p className="text-body text-krypt-muted/60 leading-relaxed">{ODDS_NOT_JUDGED}</p>
      </div>
    );
  }

  const g = odds.graduate;
  const windowLabel = odds.windowS === 120 ? '+120 s' : '+60 s';

  return (
    <div className="space-y-2">
      <SectionHeader
        title="Graduation odds (measured)"
        hint="Observed rates for launches in the same bucket on the reference day — not a prediction for this token"
      />

      {/* Row 1 — the bucket, and the observed line for it */}
      {g ? (
        <div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={cls('text-figure font-display font-semibold', oddsTone(g.bucket))}>
              {ODDS_BUCKET_LABEL[g.bucket]}
            </span>
            <Chip title="Features were read at this age after create; rates change materially between windows">
              {windowLabel}
            </Chip>
            <Chip title="Trades this judgement saw. The feed misses 10–20 % of trades.">
              from {odds.tradesSeen.toLocaleString('en-US')} trades seen
            </Chip>
          </div>
          <p className="mt-0.5 text-body leading-snug text-white/85">{g.line}</p>
        </div>
      ) : (
        <p className="text-body text-krypt-muted/60 leading-relaxed">
          Bucket not resolved — the inputs this judgement needs were not all read. Nothing is assumed in their place.
        </p>
      )}

      {/* Row 2 — the curve regime and the multiple lines */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Chip title="Which bonding-curve shape the launch traded on. Multiples differ by regime; graduation does not.">
          {REGIME_LABEL[odds.regime]}
        </Chip>
        {odds.mult3 && (
          <span className="text-label text-krypt-muted">
            <span className="uppercase tracking-label text-krypt-muted/60">3× </span>
            <span className="text-white/75">{odds.mult3.line}</span>
          </span>
        )}
        {odds.mult5 && (
          <span className="text-label text-krypt-muted">
            <span className="uppercase tracking-label text-krypt-muted/60">5× </span>
            <span className="text-white/75">{odds.mult5.line}</span>
          </span>
        )}
      </div>

      <p className="text-micro text-krypt-muted/50 leading-relaxed">{odds.footer}</p>
    </div>
  );
}
