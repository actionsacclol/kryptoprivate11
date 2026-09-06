import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Globe, HelpCircle, Send, Twitter, XCircle } from 'lucide-react';
import type { CheckVerdict, SecurityCheck, SecurityReport } from '@shared/market';
import {
  NO_EDGE_NOTE,
  RUG_RULES,
  RUG_RULES_POPULATION,
  VOLATILITY_POPULATION,
  type RugFlag,
  type RugReport,
  type VolatilityNote,
} from '@shared/rugrules';
import { cls, fmtPctOrDash, fmtUsd, scoreTone, shortAddr } from '../../utils/format';

// The rug panel from term.txt section 6, with one deliberate difference from
// every competitor: an UNKNOWN is rendered as an unknown.
//
// Competing scanners collapse "we could not check this" into a pass, which
// is how a token with an unread mint account gets a green 90. Here the score
// is an average over the checks that RESOLVED, the header states how many
// did, and unresolved checks sit in the list in grey saying why.
//
// Since 2026-08-30 the panel is ordered by what was actually MEASURED
// (docs/rug-filter-2026-08-30.md §9):
//   1. rug rules with their observed rates — the only hide criteria;
//   2. concentration as VOLATILITY, both directions, never red;
//   3. the weighted gates (authorities, LP, sellability …);
//   4. supply shares as plain facts — on the held-out day every share
//      threshold had lift below 1, so they get no verdict colour;
//   5. creator record; 6. descriptive signals with no measured edge.

const ICON: Record<CheckVerdict, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  unknown: HelpCircle,
};

const TONE: Record<CheckVerdict, string> = {
  pass: 'text-emerald-400',
  warn: 'text-arc-gold',
  fail: 'text-rose-400',
  unknown: 'text-krypt-muted/50',
};

const SOURCE_LABEL: Record<string, string> = {
  onchain: 'Read from the chain by this app',
  engine: 'Measured from this app’s own live feed',
  jupiter: 'Jupiter',
  dexscreener: 'DexScreener',
  pumpfun: 'pump.fun',
  geckoterminal: 'GeckoTerminal',
  pumpswap: 'pump.fun swap API',
  birdeye: 'Birdeye',
  helius: 'Helius',
  derived: 'Computed locally',
  none: 'No source answered',
};

const SCORE_TOOLTIP =
  'Weighted gates only — measured rug rules and volatility are shown separately. No hit rate is claimed for this number.';

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3" title={hint}>
      <h3 className="font-display text-[10px] font-semibold uppercase tracking-[0.28em] text-krypt-muted whitespace-nowrap">
        {title}
      </h3>
      <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
    </div>
  );
}

/**
 * One distribution row, drawn as a PROPORTION and nothing more. It used to
 * turn red past a "danger" share; on the held-out day every such threshold
 * had lift below 1 for "dead or dumped", so the colour was a verdict the
 * data did not support. `held` — where known — is the solid bar inside the
 * hollow "bought" bar. A null `held` draws nothing: unknown is not zero.
 */
function ConcentrationRow({ label, pct, held = null }: { label: string; pct: number | null; held?: number | null }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-[10px] uppercase tracking-[0.12em] text-krypt-muted">{label}</span>
      <div className="relative flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
        {pct !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-krypt-purple/35"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        )}
        {held !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-krypt-purple/80"
            style={{ width: `${Math.max(0, Math.min(100, held))}%` }}
          />
        )}
      </div>
      <span
        className="w-24 text-right text-[11px] font-mono text-white/85"
        title={held !== null ? 'bought at launch → still held now' : undefined}
      >
        {fmtPctOrDash(pct)}
        {held !== null && <span className="text-krypt-muted"> → {fmtPctOrDash(held)}</span>}
      </span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="text-krypt-muted">
      {label}: <span className={cls('font-mono', tone ?? 'text-white/90')}>{value}</span>
    </span>
  );
}

const numOrDash = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US');

// ── Rug rules ──────────────────────────────────────────────────────────

function FlagRow({ flag }: { flag: RugFlag }) {
  const hide = flag.severity === 'hide';
  return (
    <div
      className={cls(
        'rounded-md border px-2.5 py-2',
        hide ? 'border-rose-400/30 bg-rose-500/10' : 'border-arc-gold/30 bg-arc-gold/[0.07]',
      )}
    >
      <div className="flex items-center gap-2">
        {hide ? (
          <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-arc-gold" />
        )}
        <span className={cls('text-[12px] font-medium', hide ? 'text-rose-200' : 'text-arc-gold')}>{flag.label}</span>
        <span className="text-[9px] uppercase tracking-[0.12em] text-krypt-muted/60">
          {hide ? 'hidden from Discover by default' : 'shown only'}
        </span>
      </div>
      <p className={cls('mt-1 text-[11px] leading-snug', hide ? 'text-rose-100/80' : 'text-white/75')}>{flag.detail}</p>
    </div>
  );
}

function RugRulesSection({ rug }: { rug: RugReport | null }) {
  if (!rug) {
    return (
      <div className="space-y-2">
        <SectionHeader title="Rug rules (measured)" />
        <p className="text-[11px] text-krypt-muted/60 leading-relaxed">
          Not judged — the first trades of this token have not been read yet. Nothing is assumed in their place.
        </p>
      </div>
    );
  }
  const judged = RUG_RULES.filter((r) => rug.states[r.id] !== 'unknown');
  const notJudged = RUG_RULES.filter((r) => rug.states[r.id] === 'unknown');
  const window = rug.windowS === 60 ? '+60 s' : `+${rug.windowS} s (rates were measured at +60 s)`;

  return (
    <div className="space-y-2">
      <SectionHeader title="Rug rules (measured)" hint="Observed rates on a named population, not predictions" />
      {rug.flags.length > 0 ? (
        <div className="space-y-1.5">
          {rug.flags.map((f) => (
            <FlagRow key={f.id} flag={f} />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-white/80">
          No measured rug rule fired —{' '}
          <span className="font-mono">{judged.length}</span> of {RUG_RULES.length} rules judged.
        </p>
      )}
      {notJudged.length > 0 && (
        <div className="space-y-0.5">
          {notJudged.map((r) => (
            <p key={r.id} className="text-[11px] text-krypt-muted/60">
              — not judged: {r.label}
            </p>
          ))}
        </div>
      )}
      <p className="text-[9px] text-krypt-muted/50 leading-relaxed">
        Rates: {RUG_RULES_POPULATION}. This judgement is from{' '}
        <span className="font-mono text-krypt-muted/80">{rug.tradesSeen.toLocaleString('en-US')}</span> trades seen at{' '}
        <span className="font-mono text-krypt-muted/80">{window}</span>. A rule that did not fire is not a pass —
        launches with no flag were still ~77 % dead or dumped.
      </p>
    </div>
  );
}

// ── Volatility ─────────────────────────────────────────────────────────

function VolatilitySection({ notes }: { notes: VolatilityNote[] }) {
  return (
    <div className="pt-3 border-t border-white/5 space-y-2">
      <SectionHeader title="Volatility — both directions" hint={VOLATILITY_POPULATION} />
      {notes.length === 0 ? (
        <p className="text-[11px] text-krypt-muted/60">No concentration note — or the shares are not measured yet.</p>
      ) : (
        <div className="space-y-1.5">
          {notes.map((n) => (
            <div key={n.id} className="rounded-md border border-arc-gold/20 bg-white/[0.02] px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-[12px] font-medium text-arc-gold">{n.label}</span>
                <span className="text-[10px] font-mono text-krypt-muted">
                  <span className="text-white/80">{fmtPctOrDash(n.dumpedPct, 0)}</span> dumped ·{' '}
                  <span className="text-white/80">{fmtPctOrDash(n.gradPct, n.gradPct < 1 ? 1 : 0)}</span> graduated · n ={' '}
                  {n.n.toLocaleString('en-US')}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-white/70">{n.detail}</p>
            </div>
          ))}
        </div>
      )}
      <p className="text-[9px] text-krypt-muted/50 leading-relaxed">
        Concentration moves the price both ways; it is never a hide criterion. Population: {VOLATILITY_POPULATION}.
      </p>
    </div>
  );
}

// ── Gates and facts ────────────────────────────────────────────────────

function GateRow({ c }: { c: SecurityCheck }) {
  const Icon = ICON[c.verdict];
  return (
    <div
      className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.03] transition"
      title={SOURCE_LABEL[c.source] ?? c.source}
    >
      <Icon className={cls('h-3.5 w-3.5 mt-0.5 flex-shrink-0', TONE[c.verdict])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-medium text-white/90">{c.label}</span>
          <span className="text-[9px] uppercase tracking-[0.12em] text-krypt-muted/50">
            {SOURCE_LABEL[c.source] ?? c.source}
          </span>
        </div>
        <div className={cls('text-[11px] mt-0.5 leading-snug', c.verdict === 'unknown' ? 'text-krypt-muted/60' : 'text-krypt-muted')}>
          {c.detail}
        </div>
      </div>
    </div>
  );
}

/** A fact row: the number, the source, no icon and no verdict colour. */
function FactRow({ c }: { c: SecurityCheck }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1 hover:bg-white/[0.03] transition" title={SOURCE_LABEL[c.source] ?? c.source}>
      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-white/20" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-white/80">{c.label}</span>
          <span className="text-[9px] uppercase tracking-[0.12em] text-krypt-muted/50">{SOURCE_LABEL[c.source] ?? c.source}</span>
        </div>
        <div className="text-[11px] mt-0.5 leading-snug text-krypt-muted">{c.detail}</div>
      </div>
    </div>
  );
}

// ── Descriptive ────────────────────────────────────────────────────────

function triState(v: boolean | null): string {
  return v === null ? '—' : v ? 'yes' : 'no';
}

function DescriptiveSection({ d }: { d: SecurityReport['descriptive'] }) {
  const [open, setOpen] = useState(false);
  const paidAt = d.dexPaid.paidAt !== null ? new Date(d.dexPaid.paidAt).toLocaleDateString() : null;
  const icons = [
    { on: d.socials.twitter, Icon: Twitter, label: 'X / Twitter' },
    { on: d.socials.telegram, Icon: Send, label: 'Telegram' },
    { on: d.socials.website, Icon: Globe, label: 'Website' },
  ];
  return (
    <div className="pt-3 border-t border-white/5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 text-left"
        title={NO_EDGE_NOTE}
      >
        <h3 className="font-display text-[10px] font-semibold uppercase tracking-[0.28em] text-krypt-muted whitespace-nowrap">
          Descriptive — no measured edge
        </h3>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        <span className="flex items-center gap-1.5 text-krypt-muted/60">
          {icons.map(({ on, Icon, label }) => (
            <Icon
              key={label}
              className={cls('h-3 w-3', on === true ? 'text-white/70' : on === false ? 'text-krypt-muted/25' : 'text-krypt-muted/10')}
              aria-label={`${label}: ${triState(on)}`}
            />
          ))}
        </span>
        <ChevronDown className={cls('h-3 w-3 text-krypt-muted transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 space-y-2 animate-ink">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <Stat label="Socials" value={triState(d.socials.hasAny)} />
            <Stat label="X" value={triState(d.socials.twitter)} />
            <Stat label="Telegram" value={triState(d.socials.telegram)} />
            <Stat label="Website" value={triState(d.socials.website)} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" title={SOURCE_LABEL[d.dexPaid.source] ?? d.dexPaid.source}>
            <Stat label="DEX paid" value={d.dexPaid.paid === null ? '—' : d.dexPaid.paid ? `yes${paidAt ? ` (${paidAt})` : ''}` : 'no'} />
            <Stat label="Boosts" value={numOrDash(d.dexPaid.boosts)} />
            <Stat label="Community takeover" value={triState(d.dexPaid.communityTakeover)} />
          </div>
          {d.note && <p className="text-[10px] text-krypt-muted/60 leading-relaxed">{d.note}</p>}
          <p className="text-[9px] text-krypt-muted/50 leading-relaxed">{NO_EDGE_NOTE}</p>
        </div>
      )}
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────

export function SecurityPanel({ report }: { report: SecurityReport }) {
  const { score, checksResolved, checksTotal } = report;
  const ring = score === null ? 0 : score;
  // Facts carry weight 0 and are never a verdict. Split them out so the
  // gates list and any client-side tally only ever see the weighted checks.
  const gates = report.checks.filter((c) => c.kind !== 'fact');
  const facts = report.checks.filter((c) => c.kind === 'fact');
  const rec = report.creatorRecord;

  return (
    <div className="space-y-4">
      {/* Rug rules first: the only measured hide criteria. */}
      <RugRulesSection rug={report.rug} />

      <VolatilitySection notes={report.volatility ?? []} />

      {/* Score header — weighted gates only. */}
      <div className="pt-3 border-t border-white/5 flex items-center gap-4" title={SCORE_TOOLTIP}>
        <div className="relative h-20 w-20 flex-shrink-0">
          <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(240,237,226,0.08)" strokeWidth="3" />
            {score !== null && (
              <circle
                cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" strokeLinecap="round"
                stroke={score >= 75 ? '#34d399' : score >= 50 ? '#D9B45B' : '#f43f5e'}
                strokeDasharray={`${(ring / 100) * 97.4} 97.4`}
              />
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cls('font-display text-xl font-bold leading-none', scoreTone(score))}>
              {score === null ? '—' : score}
            </span>
            <span className="text-[8px] uppercase tracking-[0.18em] text-krypt-muted mt-0.5">/100</span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="font-display text-[11px] uppercase tracking-[0.28em] text-arc-gold/80">Krypt Score</div>
          <p className="text-[11px] text-krypt-muted mt-1 leading-relaxed">
            {score === null ? (
              <>
                Not scored. Only <span className="text-white">{checksResolved}</span> of {checksTotal} gates
                returned an answer — too few to average honestly.
              </>
            ) : (
              <>
                Averaged over the <span className="text-white">{checksResolved}</span> of {checksTotal} gates that
                resolved. Unknown gates are excluded, not counted as passes.
              </>
            )}
          </p>
          <p className="text-[9px] text-krypt-muted/50 mt-1 leading-relaxed">{SCORE_TOOLTIP}</p>
        </div>
      </div>

      {/* Gates */}
      <div className="space-y-1">
        {gates.map((c) => (
          <GateRow key={c.id} c={c} />
        ))}
      </div>

      {/* Supply shares — facts, no verdict */}
      <div className="pt-3 border-t border-white/5 space-y-2">
        <SectionHeader
          title="Supply distribution — facts"
          hint="Shares of supply. On the measured day no share threshold predicted dying better than the base rate, so none is coloured as a verdict."
        />
        <ConcentrationRow label="Dev" pct={report.concentration.devPct} />
        <ConcentrationRow label="Top 10" pct={report.concentration.top10Pct} />
        <ConcentrationRow label="Top 20" pct={report.concentration.top20Pct} />
        <ConcentrationRow label="Snipers" pct={report.concentration.sniperPct} held={report.concentration.sniperHeldPct} />
        <ConcentrationRow label="Insiders" pct={report.concentration.insiderPct} />
        <ConcentrationRow label="Bundled" pct={report.concentration.bundledPct} held={report.concentration.bundledHeldPct} />
        {facts.length > 0 && (
          <div className="space-y-0.5 pt-1">
            {facts.map((c) => (
              <FactRow key={c.id} c={c} />
            ))}
          </div>
        )}
        {(report.concentration.bundledHeldPct !== null || report.concentration.sniperHeldPct !== null) && (
          <p className="text-[10px] text-krypt-muted/55 leading-relaxed pt-1">
            Solid bar is what those wallets <span className="text-white/70">still hold</span>; the faint bar is what
            they bought at launch. See the launch panel for the wallets behind these numbers.
          </p>
        )}
        {report.concentration.bundledPct === null && (
          <p className="text-[10px] text-krypt-muted/55 leading-relaxed pt-1">
            Bundle and sniper shares could not be measured for this token — the launch panel says why. Nothing is
            guessed in their place.
          </p>
        )}
      </div>

      {/* Creator record */}
      <div className="pt-3 border-t border-white/5 space-y-2">
        <SectionHeader title="Creator record" />
        {rec && (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]"
            title={SOURCE_LABEL[rec.source] ?? rec.source}
          >
            <Stat label="Launches" value={numOrDash(rec.launches)} />
            <Stat label="Graduated" value={numOrDash(rec.graduated)} />
            <Stat label="Dev mints" value={numOrDash(rec.devMints)} />
            <Stat label="Dev migrations" value={numOrDash(rec.devMigrations)} />
            <Stat
              label="RugCheck creator rugs"
              value={triState(rec.rugcheckCreatorRugs)}
              tone={rec.rugcheckCreatorRugs === true ? 'text-rose-400' : undefined}
            />
          </div>
        )}
        {report.creator.address ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span className="font-mono text-white/80">{shortAddr(report.creator.address, 6)}</span>
              <span className="text-krypt-muted">
                Seen by this app: <span className="text-white/90">{report.creator.priorLaunches ?? '—'}</span> launches,{' '}
                <span className={report.creator.priorRugs ? 'text-rose-400' : 'text-white/90'}>
                  {report.creator.priorRugs ?? '—'}
                </span>{' '}
                dumped
              </span>
            </div>

            {/* The wide record: pump.fun's own launch list, which is the only
                one that answers for a token found cold. Scope is stated —
                a creator's launches on other launchpads are invisible here. */}
            {report.creator.history ? (
              <div className="rounded-md border border-white/8 bg-white/[0.02] px-2.5 py-2 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <Stat label="Launches" value={String(report.creator.history.launches)} />
                  <Stat
                    label="Graduated"
                    value={`${report.creator.history.graduated} (${fmtPctOrDash(report.creator.history.graduationRate, 0)})`}
                  />
                  <Stat
                    label="Busiest day"
                    value={`${report.creator.history.launchesInBusiestDay} launches`}
                    tone={report.creator.history.launchesInBusiestDay >= 10 ? 'text-rose-400' : undefined}
                  />
                  <Stat label="Median peak" value={fmtUsd(report.creator.history.medianAthUsd)} />
                  <Stat label="Best peak" value={fmtUsd(report.creator.history.bestAthUsd)} />
                </div>
                {report.creator.history.recent.length > 1 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {report.creator.history.recent.slice(0, 10).map((l) => (
                      <span
                        key={l.mint}
                        title={`${l.name ?? l.symbol ?? l.mint} · ${new Date(l.createdAt).toLocaleDateString()} · ${
                          l.graduated ? 'graduated' : 'never graduated'
                        }`}
                        className={cls(
                          'rounded px-1.5 py-0.5 text-[9px] font-mono border',
                          l.graduated
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                            : 'border-white/8 bg-white/[0.03] text-krypt-muted',
                        )}
                      >
                        {l.symbol ?? shortAddr(l.mint, 3)}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[9px] text-krypt-muted/50 leading-relaxed">
                  pump.fun launches only{report.creator.history.truncated ? ', capped at 200' : ''}. Launches on other
                  platforms are not counted.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-krypt-muted/60">
                No wider creator record — pump.fun lists no other launches from this wallet.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-krypt-muted/60">No creator address available for this token.</p>
        )}
      </div>

      {report.descriptive && <DescriptiveSection d={report.descriptive} />}
    </div>
  );
}
