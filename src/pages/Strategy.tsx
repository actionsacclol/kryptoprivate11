// The Spellbook — the strategy editor set as two facing pages with a gilded
// spine. Presets are spell cards that inscribe a known configuration; every
// gate below remains a precise, ordinary form control.

import { NumberInput, Page, Section, Switch, Card } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { StrategySettings } from '@shared/types';
import { cls } from '../utils/format';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-white/10 bg-black/20 px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        {hint && <div className="text-xs text-krypt-muted mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

interface SpellPreset {
  name: string;
  glyph: string;
  line: string;
  tone: 'violet' | 'gold' | 'crimson';
  patch: Partial<StrategySettings>;
}

const PRESETS: SpellPreset[] = [
  {
    name: 'Warded',
    glyph: '◈',
    line: 'Every protection raised. Fewer entries, smaller stakes, tight stops.',
    tone: 'violet',
    patch: {
      minScore: 70,
      maxSellsInWindow: 0,
      maxSellVolumeSol: 0.2,
      positionSizeSol: 0.05,
      maxOpenPositions: 2,
      stopLossPct: 0.25,
      maxSessionLossSol: 0.3,
      maxConsecutiveLosses: 3,
    },
  },
  {
    name: 'Balanced',
    glyph: '✦',
    line: 'The data-refit defaults — clean book, early curve, capped crowd.',
    tone: 'gold',
    patch: { ...DEFAULT_SETTINGS.strategy },
  },
  {
    name: 'Reckless',
    glyph: '⟁',
    line: 'Looser wards, larger stakes, wider stops. You were warned.',
    tone: 'crimson',
    patch: {
      minScore: 45,
      maxSellsInWindow: 2,
      maxSellVolumeSol: 1.0,
      positionSizeSol: 0.2,
      maxOpenPositions: 5,
      stopLossPct: 0.45,
      takeProfit1Pct: 1.0,
      maxSessionLossSol: 1.0,
      maxConsecutiveLosses: 6,
    },
  },
];

const PRESET_TONE = {
  violet: { glyph: 'text-krypt-purple', ring: 'hover:border-krypt-purple/50 hover:shadow-krypt-glow' },
  gold: { glyph: 'text-arc-gold', ring: 'hover:border-arc-gold/50 hover:shadow-gold-glow' },
  crimson: { glyph: 'text-rose-400', ring: 'hover:border-rose-500/50 hover:shadow-crimson-glow' },
} as const;

function Spine() {
  return (
    <div className="hidden xl:flex flex-col items-center gap-3 px-1 py-6" aria-hidden="true">
      <span className="h-1.5 w-1.5 rotate-45 bg-arc-gold/50" />
      <div className="w-px flex-1 bg-gradient-to-b from-transparent via-white/15 to-transparent" />
      <span className="h-1.5 w-1.5 rotate-45 bg-arc-gold/50" />
    </div>
  );
}

export function Strategy() {
  const { settings, updateSettings } = useAppState();
  const s = settings.strategy;

  const patch = (p: Partial<StrategySettings>): void => {
    void updateSettings({ strategy: { ...s, ...p } });
  };

  return (
    <Page
      title="Spellbook"
      subtitle="Strategy — filtered early momentum. Pay a slightly later entry for substantially better evidence."
    >
      <Section title="Inscriptions" description="Apply a known configuration, then tune the gates below.">
        <div className="grid md:grid-cols-3 gap-3">
          {PRESETS.map((p) => {
            const tone = PRESET_TONE[p.tone];
            return (
              <button
                key={p.name}
                onClick={() => patch(p.patch)}
                className={cls(
                  'plate rounded-lg px-4 py-4 text-left transition group',
                  p.tone === 'gold' && 'plate-gold',
                  p.tone === 'crimson' && 'plate-crimson',
                  tone.ring,
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cls('font-display text-sm font-semibold tracking-[0.14em] text-white')}>
                    <span className={cls('mr-2', tone.glyph)}>{p.glyph}</span>
                    {p.name}
                  </span>
                  <span className="text-[9px] font-display uppercase tracking-[0.2em] text-krypt-muted/70 opacity-0 group-hover:opacity-100 transition">
                    Inscribe
                  </span>
                </div>
                <p className="mt-2 text-xs text-krypt-muted leading-relaxed">{p.line}</p>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Runner alerts"
        description="What the scanner is for: every launch is judged with the graduation-odds model (measured on 73,890 launches) at +60 s and +120 s; the top buckets are flagged and you are notified. Nothing is bought for you."
      >
        <div className="grid gap-3">
          <Switch
            checked={s.runnerAlerts?.enabled ?? true}
            onChange={(v) => patch({ runnerAlerts: { ...(s.runnerAlerts ?? { minBucket: 'top1_5', maxPerHour: 12 }), enabled: v } })}
            label="Flag potential runners"
            description="Desktop notification, paired chat bots, and the list on the Launches page"
          />
          <Row label="Flag from bucket" hint="Top 1 % ≈ 1 in 4 graduated on the measured day; top 5 % ≈ 1 in 6; top 10 % ≈ 1 in 8">
            <select
              value={s.runnerAlerts?.minBucket ?? 'top1_5'}
              onChange={(e) => patch({ runnerAlerts: { ...(s.runnerAlerts ?? { enabled: true, maxPerHour: 12 }), minBucket: e.target.value as 'top1' | 'top1_5' | 'top5_10' } })}
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[12px] text-white"
            >
              <option value="top1">Top 1 % only</option>
              <option value="top1_5">Top 5 %</option>
              <option value="top5_10">Top 10 %</option>
            </select>
          </Row>
          <Row label="Max alerts per hour" hint="Flags past the cap still show on the Launches page">
            <NumberInput value={s.runnerAlerts?.maxPerHour ?? 12} min={1} max={120} onChange={(v) => patch({ runnerAlerts: { ...(s.runnerAlerts ?? { enabled: true, minBucket: 'top1_5' }), maxPerHour: v } })} />
          </Row>
          <Switch
            checked={s.paperEntries ?? false}
            onChange={(v) => patch({ paperEntries: v })}
            label="Paper entries (research)"
            description="Open simulated positions on qualifying launches. Off by default: the measured record is negative even with perfect landing (docs/strat-swarm-2026-07-24.md)."
          />
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_auto_1fr] gap-x-4">
        {/* ── Left page: what may enter ── */}
        <div>
          <Section title="Entry wards" description="Every gate must pass inside the evaluation window; failures are shown on the launch row.">
            <div className="grid gap-3">
              <Row label="Evaluation window" hint="Seconds of live flow before deciding">
                <NumberInput value={s.evalWindowSec} min={5} max={60} onChange={(v) => patch({ evalWindowSec: v })} suffix="s" />
              </Row>
              <Row label="Min opportunity score" hint="Composite 0–100, see launch details">
                <NumberInput value={s.minScore} min={0} max={100} onChange={(v) => patch({ minScore: v })} />
              </Row>
              <Row label="Min unique buyers" hint="At least this many distinct buyers">
                <NumberInput value={s.minUniqueBuyers} min={1} max={100} onChange={(v) => patch({ minUniqueBuyers: v })} />
              </Row>
              <Row label="Max unique buyers" hint="Reject over-hyped tops (data: crowds lose)">
                <NumberInput value={s.maxUniqueBuyers} min={5} max={200} onChange={(v) => patch({ maxUniqueBuyers: v })} />
              </Row>
              <Row label="Min net inflow" hint="Buys minus sells, in SOL">
                <NumberInput value={s.minNetInflowSol} min={0} max={100} step={0.5} onChange={(v) => patch({ minNetInflowSol: v })} suffix="SOL" />
              </Row>
              <Row label="Max net inflow" hint="Reject frothy inflow (hype top)">
                <NumberInput value={s.maxNetInflowSol} min={2} max={200} step={0.5} onChange={(v) => patch({ maxNetInflowSol: v })} suffix="SOL" />
              </Row>
            </div>
          </Section>

          <Section title="Contrarian gates" description="From our recorded trades: clean books and early curve entry win; sells and late entry lose.">
            <div className="grid gap-3">
              <Row label="Max sells in window" hint="Winners averaged 0.75 sells, losers 1.65">
                <NumberInput value={s.maxSellsInWindow} min={0} max={20} onChange={(v) => patch({ maxSellsInWindow: v })} />
              </Row>
              <Row label="Max sell volume" hint="Strongest loss signal in the data">
                <NumberInput value={s.maxSellVolumeSol} min={0} max={20} step={0.1} onChange={(v) => patch({ maxSellVolumeSol: v })} suffix="SOL" />
              </Row>
              <Row label="Curve entry min" hint="Too early = thin exits">
                <NumberInput value={s.entryCurveMinPct} min={0} max={50} onChange={(v) => patch({ entryCurveMinPct: v })} suffix="%" />
              </Row>
              <Row label="Curve entry max" hint="Too late = already pumped (winners ~18%)">
                <NumberInput value={s.entryCurveMaxPct} min={5} max={90} onChange={(v) => patch({ entryCurveMaxPct: v })} suffix="%" />
              </Row>
              <Row label="Max top-holder share" hint="Token-weighted, not SOL-weighted">
                <NumberInput value={Math.round(s.maxTopHolderShare * 100)} min={5} max={90} onChange={(v) => patch({ maxTopHolderShare: v / 100 })} suffix="%" />
              </Row>
              <Row label="Max bundle share" hint="Wallets buying in the first 2s">
                <NumberInput value={Math.round(s.maxEarlyBuyerShare * 100)} min={5} max={95} onChange={(v) => patch({ maxEarlyBuyerShare: v / 100 })} suffix="%" />
              </Row>
            </div>
          </Section>
        </div>

        <Spine />

        {/* ── Right page: what happens after entry ── */}
        <div>
          <Section title="Position sizing">
            <div className="grid gap-3">
              <Row label="Position size" hint="Paper SOL per entry">
                <NumberInput value={s.positionSizeSol} min={0.01} max={10} step={0.05} onChange={(v) => patch({ positionSizeSol: v })} suffix="SOL" />
              </Row>
              <Row label="Max open positions">
                <NumberInput value={s.maxOpenPositions} min={1} max={20} onChange={(v) => patch({ maxOpenPositions: v })} />
              </Row>
            </div>
          </Section>

          <Section title="Rites of exit" description="Independent triggers — first one to fire wins.">
            <div className="grid gap-3">
              <Row label="Stop loss" hint="Hard stop below entry">
                <NumberInput value={Math.round(s.stopLossPct * 100)} min={5} max={95} onChange={(v) => patch({ stopLossPct: v / 100 })} suffix="%" />
              </Row>
              <Row label="Take profit 1" hint="Sell 50% at this gain">
                <NumberInput value={Math.round(s.takeProfit1Pct * 100)} min={10} max={1000} onChange={(v) => patch({ takeProfit1Pct: v / 100 })} suffix="%" />
              </Row>
              <Row label="Take profit 2" hint="Sell 50% of remainder, then trail">
                <NumberInput value={Math.round(s.takeProfit2Pct * 100)} min={20} max={5000} onChange={(v) => patch({ takeProfit2Pct: v / 100 })} suffix="%" />
              </Row>
              <Row label="Trailing stop" hint="From peak, after TP1">
                <NumberInput value={Math.round(s.trailingPct * 100)} min={5} max={90} onChange={(v) => patch({ trailingPct: v / 100 })} suffix="%" />
              </Row>
              <Row label="Time stop" hint="Exit flat positions after">
                <NumberInput value={s.timeStopSec} min={15} max={600} onChange={(v) => patch({ timeStopSec: v })} suffix="s" />
              </Row>
              <Row label="Session loss limit" hint="Pause new entries after losing this much">
                <NumberInput value={s.maxSessionLossSol} min={0.05} max={100} step={0.1} onChange={(v) => patch({ maxSessionLossSol: v })} suffix="SOL" />
              </Row>
              <Row label="Max consecutive losses" hint="Cool down for 5 min after this many in a row">
                <NumberInput value={s.maxConsecutiveLosses} min={1} max={20} onChange={(v) => patch({ maxConsecutiveLosses: v })} />
              </Row>
              <Switch
                checked={s.exitOnCreatorSell}
                onChange={(v) => patch({ exitOnCreatorSell: v })}
                label="Exit on creator sell"
                description="The single strongest rug signal — recommended on"
              />
              <Switch
                checked={s.exitOnFlowReversal}
                onChange={(v) => patch({ exitOnFlowReversal: v })}
                label="Exit on flow reversal"
                description="Sell volume overwhelms buys in the last 5 seconds"
              />
            </div>
          </Section>

          <Section title="Honesty box">
            <Card>
              <p className="text-sm text-krypt-muted leading-relaxed">
                These defaults are starting points, not alpha. The recorder captures every event and
                decision precisely so you can re-fit these numbers from your own replay data. Past
                simulated performance — especially paper fills — does not predict live results.
              </p>
            </Card>
          </Section>
        </div>
      </div>
    </Page>
  );
}
