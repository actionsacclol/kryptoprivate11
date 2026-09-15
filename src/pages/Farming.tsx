// Farming — volume farming on an established pair.
//
// Rebuilt 2026-09-14 after two measurements moved the answer by orders of
// magnitude (see shared/farming.ts for both). The short version: this page
// used to price a memecoin round trip with guessed fees and got the cost wrong
// by ~200x in the flattering direction. It no longer guesses anything. You
// pick a pair, it MEASURES the friction with two Jupiter quotes, and every
// number below stays null until that has happened.
//
// It answers one question — would a programme paying R% of volume leave you
// ahead — and it answers it for whoever is actually paying the app's fee.

import { useMemo, useState } from 'react';
import { Activity, Sprout, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_VOLUME_FARM,
  FARM_FEE_PCT_PER_SIDE,
  FULL_FEE_PCT_PER_SIDE,
  eligibilityNote,
  netPctOfVolume,
  ownerNote,
  presetProblems,
  projectFarming,
  requiredRewardPct,
  type FarmPayer,
  type VolumeFarmPreset,
} from '@shared/farming';
import { Card, Field, GhostButton, Page, Section, Stat } from '../components/common';
import { cls } from '../utils/format';
import { useToast } from '../state/ToastProvider';

/** Mirrors electron/engine/farmProbe.ts SUGGESTED_PAIRS. Starting points for
 *  the picker, never a substitute for probing the pair you will trade. */
const PAIRS = [
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'JitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

const num = (v: number | null, digits = 4, suffix = ''): string =>
  v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${suffix}`;

function NumField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-sm font-mono text-white outline-none focus:border-krypt-purple/60"
      />
    </Field>
  );
}

export function FarmingPage() {
  const toast = useToast();
  const [p, setP] = useState<VolumeFarmPreset>({ ...DEFAULT_VOLUME_FARM });
  const [probing, setProbing] = useState(false);
  const [route, setRoute] = useState('');
  const [rewardPct, setRewardPct] = useState(0.25);

  const set = <K extends keyof VolumeFarmPreset>(k: K, v: VolumeFarmPreset[K]): void =>
    setP((cur) => ({ ...cur, [k]: v }));

  // Changing the pair or the size invalidates the measurement — friction is a
  // property of BOTH, and showing a 10 SOL number beside a 100 SOL plan is the
  // same class of lie the guessed fee was.
  const pick = (symbol: string, mint: string): void => {
    setP((cur) => ({ ...cur, symbol, mint, frictionPctPerRoundTrip: null }));
    setRoute('');
  };

  const proj = useMemo(() => projectFarming(p), [p]);
  const required = requiredRewardPct(proj);
  const net = netPctOfVolume(proj, rewardPct);
  const problems = presetProblems(p);

  const probe = async (): Promise<void> => {
    if (!p.mint) {
      toast.error('Pick a pair first.');
      return;
    }
    setProbing(true);
    try {
      const r = await window.krypt.farming.probe(p.mint, p.tradeSol);
      if (r.ok && r.data && r.data.frictionPct !== null) {
        set('frictionPctPerRoundTrip', r.data.frictionPct);
        setRoute(r.data.route);
        toast.success(r.message);
      } else {
        set('frictionPctPerRoundTrip', null);
        setRoute('');
        toast.error(r.message);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setProbing(false);
    }
  };

  return (
    <Page
      title="Farming"
      subtitle="Generate volume on a deep pair to qualify for a programme that pays on activity. Nothing here trades yet — it measures what a run would cost."
    >
      <Section
        title="1 · Pick a pair, and measure it"
        description="Depth is the whole point: on SOL/USDC a round trip costs about nothing, on a fresh memecoin pool it costs over 3%. Nothing below is calculated until a real quote pair has been measured — this page does not guess its own costs."
      >
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {PAIRS.map((x) => (
              <button
                key={x.mint}
                onClick={() => pick(x.symbol, x.mint)}
                className={cls(
                  'rounded-md border px-2.5 py-1.5 text-body font-semibold transition',
                  p.mint === x.mint
                    ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white'
                    : 'border-white/10 text-krypt-muted hover:text-white',
                )}
              >
                SOL / {x.symbol}
              </button>
            ))}
            <span className="flex-1" />
            <GhostButton onClick={() => void probe()} disabled={probing || !p.mint}>
              <Activity className="h-3.5 w-3.5" />
              {probing ? 'Measuring…' : 'Measure friction'}
            </GhostButton>
          </div>

          {p.frictionPctPerRoundTrip !== null ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat
                label={`Round-trip friction at ${p.tradeSol} SOL`}
                value={num(p.frictionPctPerRoundTrip, 4, ' %')}
                size="figure"
                tone={p.frictionPctPerRoundTrip < 0.1 ? 'text-emerald-300' : 'text-amber-300'}
              />
              <Stat label="Route" value={route || '—'} hint="RFQ makers quote tight; a quote is not a fill." />
              <Stat label="Measured against" value={`SOL / ${p.symbol}`} hint="Re-measure after changing pair or size." />
            </div>
          ) : (
            <p className="text-note text-krypt-muted">
              No measurement yet. Two quotes, no wallet, nothing spent — the result is the entire friction of one round
              trip: spread, both impacts and both LP fees in a single number.
            </p>
          )}
        </Card>
      </Section>

      <Section
        title="2 · The run"
        description="Gas is a fixed cost per transaction, so size is the most important field here: at 1 SOL a round trip gas alone is ~0.6% of volume, at 100 SOL it is ~0.006%. Few large round trips, not many small ones."
      >
        <Card className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumField
              label="Trade size (SOL)"
              value={p.tradeSol}
              onChange={(v) => {
                setP((cur) => ({ ...cur, tradeSol: v, frictionPctPerRoundTrip: null }));
                setRoute('');
              }}
              hint="Bigger is cheaper. Re-measure after changing."
            />
            <NumField label="Hold (sec)" value={p.holdSec} onChange={(v) => set('holdSec', v)} hint="Buy to sell." />
            <NumField label="Gap (sec)" value={p.gapSec} onChange={(v) => set('gapSec', v)} hint="Sell to next buy." />
            <NumField label="Budget (SOL)" value={p.budgetSol} onChange={(v) => set('budgetSol', v)} hint="What you will spend." />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-krypt-muted">Who pays the app fee:</span>
            {(['user', 'owner'] as FarmPayer[]).map((who) => (
              <button
                key={who}
                onClick={() => set('payer', who)}
                className={cls(
                  'rounded-md border px-2.5 py-1.5 text-body font-semibold transition',
                  p.payer === who
                    ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white'
                    : 'border-white/10 text-krypt-muted hover:text-white',
                )}
              >
                {who === 'user' ? `A user · ${FARM_FEE_PCT_PER_SIDE}%/side` : 'You · own treasury'}
              </button>
            ))}
          </div>

          {p.payer === 'owner' && <p className="text-note leading-relaxed text-amber-200/90">{ownerNote}</p>}

          {problems.length > 0 && (
            <ul className="space-y-1 text-body text-amber-200/90">
              {problems.map((t) => (
                <li key={t}>• {t}</li>
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <Section
        title="3 · Does it pay?"
        description="Everything here is null until the friction has been measured. An unmeasured cost renders as an em dash, never as a zero — a zero would read as free, which is the most expensive thing this page could imply."
      >
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Round trips / hour" value={proj.tripsPerHour.toFixed(0)} />
            <Stat label="Fills / hour" value={proj.fillsPerHour.toFixed(0)} hint="What a programme counting trades counts." />
            <Stat label="Volume / hour" value={`${proj.volumeSolPerHour.toFixed(1)} SOL`} hint="Both legs." />
            <Stat label="Cost / hour" value={num(proj.costSolPerHour, 4, ' SOL')} tone="text-rose-300" />
          </div>

          <div className="rounded-lg border border-white/10 bg-black/25 p-3">
            <div className="text-label uppercase tracking-label text-krypt-muted/60">Where the cost goes, per hour</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <Stat
                label={p.payer === 'owner' ? 'App fee (a wash for you)' : `App fee (${FARM_FEE_PCT_PER_SIDE}%/side)`}
                value={`${proj.appFeeSolPerHour.toFixed(4)} SOL`}
                tone={p.payer === 'owner' ? 'text-krypt-muted' : 'text-rose-300/90'}
              />
              <Stat label="Market friction" value={num(proj.frictionSolPerHour, 4, ' SOL')} hint="Measured, not modelled." />
              <Stat label="Gas" value={`${proj.gasSolPerHour.toFixed(4)} SOL`} hint="Fixed per tx — size it away." />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Cost as % of volume" value={num(proj.costPctOfVolume, 4, ' %')} tone="text-rose-300" size="figure" />
            <Stat
              label="Programme must pay over"
              value={num(required, 4, ' % of volume')}
              tone="text-arc-gold"
              size="figure"
              hint="Below this, the run loses money however well it executes."
            />
            <Stat
              label="Budget buys"
              value={proj.volumeSolForBudget === null ? '—' : `${Math.round(proj.volumeSolForBudget).toLocaleString()} SOL`}
              hint={proj.budgetHours === null ? 'Measure first.' : `over about ${proj.budgetHours.toFixed(1)} h`}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-white/10 bg-black/25 p-3">
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-56">
                <NumField
                  label="A programme pays (% of volume)"
                  value={rewardPct}
                  onChange={setRewardPct}
                  hint="Enter its published rate."
                />
              </div>
              <Stat
                label="You net"
                value={num(net, 4, ' % of volume')}
                size="figure"
                tone={net === null ? undefined : net > 0 ? 'text-emerald-300' : 'text-rose-300'}
              />
            </div>
            <p className="text-label leading-relaxed text-krypt-muted/70">
              At the ordinary trading fee ({FULL_FEE_PCT_PER_SIDE}%/side — {(FULL_FEE_PCT_PER_SIDE * 2).toFixed(2)}% a
              round trip) a programme would have to pay more than that just to break even, and none does. That is why
              farming runs at the reduced rate above, and why nothing else in the app does.
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/25 bg-amber-500/[0.06] p-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <p className="text-note leading-relaxed text-amber-100/90">{eligibilityNote}</p>
          </div>
        </Card>
      </Section>

      <Section
        title="Not built yet"
        description="There is no switch on this page and nothing is scheduled. The runner would reuse the Wallet Lab's Warmer machinery — sized trades, randomised cadence, a hard budget — pointed at one deep pair."
      >
        <Card>
          <div className="flex items-start gap-3">
            <span className="rounded-lg border border-white/10 bg-white/5 p-2 text-krypt-pink">
              <Sprout className="h-5 w-5" />
            </span>
            <p className="text-note leading-relaxed text-krypt-muted">
              Two caveats belong on the numbers above. A quote is not a fill — much of this routes to RFQ market makers
              who quote tight and may fill wider. And the probe is instantaneous, so it carries no directional risk: a
              run that holds for twenty seconds takes a price move that is zero-mean on a deep pair but not
              zero-variance. Neither changes the order of magnitude, and the order of magnitude is the whole answer.
            </p>
          </div>
        </Card>
      </Section>
    </Page>
  );
}
