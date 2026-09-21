// Execution — what gets flagged as a potential runner, the live fee and tip
// telemetry, and the lanes the trades YOU place go out on.
//
// Until 2026-09-20 this page also listed "paper send plans": what a live buy
// would have submitted for each paper entry, a leftover from when the
// scanner bought on its own (it has not since 2026-08-16, and paper entries
// have been an opt-in research switch since 09-02). The runner-alert
// controls lived on the Strategy page beside the paper-entry gates, which
// read as if the gates decided the flags. They do not: the flag is the
// odds model's call plus the filters below, and nothing here buys.

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Flame, Fuel, ShieldCheck, Zap } from 'lucide-react';
import { Badge, Card, NumberInput, Page, Section, Switch } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import type { ExecutionSnapshot, FeeUrgency } from '@shared/types';
import { DEFAULT_RUNNER_ALERTS, RUNNER_BUCKET_LABEL, RUNNER_WINDOWS_LABEL, describeRunnerFilters } from '@shared/runners';
import type { RunnerAlertSettings, RunnerBucketFloor, RunnerWindows } from '@shared/runners';
import { cls } from '../utils/format';

const LAMPORTS = 1e9;
const solFrom = (l: number): string => `${(l / LAMPORTS).toFixed(6)} SOL`;

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

const SELECT_CLASS = 'rounded-md border border-white/10 bg-black/30 px-2 py-1 text-note text-white';

function FeeLadder({ snap }: { snap: ExecutionSnapshot }) {
  const fe = snap.feeEstimate;
  if (!fe) return <div className="text-xs text-krypt-muted">Waiting for fee samples…</div>;
  const rows: Array<[string, number, FeeUrgency]> = [
    ['Normal (p50)', fe.p50, 'normal'],
    ['Competitive (p75)', fe.p75, 'competitive'],
    ['High (p90)', fe.p90, 'high'],
    ['Emergency (p95)', fe.p95, 'emergency'],
  ];
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const { settings } = useAppState();
  return (
    <div className="space-y-2">
      {rows.map(([label, v, urgency]) => {
        const active = settings.execution.feeUrgency === urgency;
        return (
          <div key={label} className="flex items-center gap-3">
            <div className="w-32 text-xs text-krypt-muted">{label}</div>
            <div className="flex-1 h-5 rounded-md bg-black/30 overflow-hidden relative">
              <motion.div
                className={cls('h-full rounded-md', active ? 'bg-krypt-gradient' : 'bg-krypt-purple/40')}
                initial={{ width: 0 }}
                animate={{ width: `${(v / max) * 100}%` }}
                transition={{ duration: 0.4 }}
              />
              <span className="absolute inset-0 flex items-center px-2 font-mono text-body text-white/90">
                {v.toLocaleString()} µlamports/CU
              </span>
            </div>
            {active && <Badge tone="gradient">active</Badge>}
          </div>
        );
      })}
      <div className="text-body text-krypt-muted/70 pt-1">
        Source: <span className="font-mono text-krypt-muted">{fe.source}</span> · scoped to the bonding curve + creator vault (local fee markets)
      </div>
    </div>
  );
}

/**
 * The runner-alert controls. The bucket floor is the odds model's call; the
 * rest are the user's own filters on top of it, and each applies only when
 * the fact is known — an unmeasured launch is never hidden by a filter.
 */
function RunnerAlertsSection() {
  const { settings, updateSettings, status } = useAppState();
  const ra: RunnerAlertSettings = { ...DEFAULT_RUNNER_ALERTS, ...(settings.strategy.runnerAlerts ?? {}) };
  const patch = (p: Partial<RunnerAlertSettings>): void => {
    void updateSettings({ strategy: { ...settings.strategy, runnerAlerts: { ...ra, ...p } } });
  };
  const filters = describeRunnerFilters(ra);
  const mayhem = settings.strategy.mayhemFilter ?? 'all';

  return (
    <Section
      title="Runner alerts — what gets flagged"
      description="Every launch the scanner watches is judged with the graduation-odds model (measured on 73,890 launches) at +60 s and, if that did not flag, at +120 s. The bucket floor is the model's call; everything under it is your own filter on top. A launch the app cannot measure is never hidden by a filter. Flags land on the Runners tab, as a desktop notification, on paired chat bots, and on the Discord webhook set on the Runners tab. Nothing is bought for you."
    >
      <div className="grid gap-3">
        <Switch
          checked={ra.enabled}
          onChange={(v) => patch({ enabled: v })}
          label="Flag potential runners"
          description="Off = the scanner still runs and the Launches page still fills; nothing is flagged or pushed."
        />
        <Row label="Flag from bucket" hint="Top 1 % ≈ 1 in 4 graduated on the measured day; top 5 % ≈ 1 in 6; top 10 % ≈ 1 in 8">
          <select value={ra.minBucket} onChange={(e) => patch({ minBucket: e.target.value as RunnerBucketFloor })} className={SELECT_CLASS}>
            {(Object.keys(RUNNER_BUCKET_LABEL) as RunnerBucketFloor[]).map((k) => (
              <option key={k} value={k}>{RUNNER_BUCKET_LABEL[k]}</option>
            ))}
          </select>
        </Row>
        <Row label="Judge window" hint="+60 s flags earlier on thinner evidence; +120 s later on more. The default tries +120 s only when +60 s did not flag.">
          <select value={ra.windows ?? 'both'} onChange={(e) => patch({ windows: e.target.value as RunnerWindows })} className={SELECT_CLASS}>
            {(Object.keys(RUNNER_WINDOWS_LABEL) as RunnerWindows[]).map((k) => (
              <option key={k} value={k}>{RUNNER_WINDOWS_LABEL[k]}</option>
            ))}
          </select>
        </Row>
        <Row label="Min buyers at the judge" hint="Unique buyers so far. 0 = no floor.">
          <NumberInput value={ra.minBuyers ?? 0} min={0} max={1000} onChange={(v) => patch({ minBuyers: Math.max(0, Math.round(v)) })} />
        </Row>
        <Row label="Min net SOL at the judge" hint="Buys minus sells. 0 = no floor. A +400 % move on half a SOL is a move on half a SOL.">
          <NumberInput value={ra.minNetSol ?? 0} min={0} max={10_000} onChange={(v) => patch({ minNetSol: Math.max(0, v) })} suffix="SOL" />
        </Row>
        <Row label="Supply sold at the judge" hint="Percent of the supply the curve has sold. 0 to 100 = no bound; raise the low end to skip launches nobody has bought, lower the high end to skip ones already near graduation.">
          <div className="flex items-center gap-2">
            <NumberInput value={ra.minCurvePct ?? 0} min={0} max={100} onChange={(v) => patch({ minCurvePct: Math.min(100, Math.max(0, v)) })} suffix="%" className="w-24" />
            <span className="text-krypt-muted text-xs">to</span>
            <NumberInput value={ra.maxCurvePct ?? 100} min={0} max={100} onChange={(v) => patch({ maxCurvePct: Math.min(100, Math.max(0, v)) })} suffix="%" className="w-24" />
          </div>
        </Row>
        <Switch
          checked={ra.excludeMixed ?? false}
          onChange={(v) => patch({ excludeMixed: v })}
          label="Skip mixed curves"
          description="Curves whose reserves do not follow the constant product. On the measured day they graduated into pools seeded with about 0.16 SOL (a classic curve seeds 85) and held 0.008× of the flag price an hour later — their big percentage moves are moves on almost nothing. They were 91 % of live flags in September, so this leaves few alerts, but the ones left are the ones that were about break-even."
        />
        <Switch
          checked={ra.skipRepeatDumpers ?? false}
          onChange={(v) => patch({ skipRepeatDumpers: v })}
          label="Skip creators who dumped before"
          description="A creator sell inside an earlier launch's window, on this app's own record. Flags whose creator had not sold graduated 21.6 % on the held-out day, those whose creator had 4.7 %. A creator with no record is not skipped."
        />
        <Row label="Max alerts per hour" hint="Flags past the cap still land on the Runners tab; they just do not notify.">
          <NumberInput value={ra.maxPerHour} min={1} max={120} onChange={(v) => patch({ maxPerHour: Math.max(1, Math.round(v)) })} />
        </Row>

        {/* Which pump curve variants the scanner even looks at. A filtered
            launch never gets a mint check, an eval window, a scorer pass or a
            judge — so it sits with the flag filters, as the first of them. */}
        <div className="rounded-lg border border-white/10 bg-black/25 p-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-value font-semibold text-white">Mayhem coins</span>
            <span className="text-body text-krypt-muted">which pump curves the Solana scanner watches at all</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {(
              [
                ['all', 'All (default)', 'Every pump.fun launch, standard and mayhem alike. What the scanner has always done.'],
                ['standard', 'No mayhem', 'Standard curves only. A launch the app cannot classify still shows — hiding one for a reason it cannot state would hide a real launch.'],
                ['mayhem', 'Mayhem only', 'Only launches it can SEE are mayhem. An unclassified launch is not shown, because "mayhem only" that includes unknowns is not mayhem only.'],
              ] as const
            ).map(([mode, label, desc]) => (
              <button
                key={mode}
                onClick={() => void updateSettings({ strategy: { ...settings.strategy, mayhemFilter: mode } })}
                className={cls(
                  'rounded-md border px-3 py-2 text-left transition',
                  mayhem === mode ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-white/[0.02] hover:border-white/20',
                )}
              >
                <div className={cls('text-note font-semibold', mayhem === mode ? 'text-white' : 'text-krypt-muted')}>{label}</div>
                <div className="mt-0.5 text-label leading-relaxed text-krypt-muted/80">{desc}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-label leading-relaxed text-krypt-muted/70">
            A mayhem coin trades against inflated virtual reserves — hundreds of SOL rather than the standard 30 — so it
            can run to a six-figure market cap while still on the bonding curve. Read free from the launch event, so
            this costs no extra request.
            {mayhem !== 'all' && (status.launchesFiltered ?? 0) > 0 ? (
              <span className="text-krypt-muted"> {status.launchesFiltered} launch{status.launchesFiltered === 1 ? '' : 'es'} hidden this session.</span>
            ) : null}
            {' '}Solana only — the EVM launchpads have no equivalent; their runner alerts are on their own Observatory pages.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-white/10 bg-black/20 px-4 py-3">
          <Flame className="mt-0.5 h-4 w-4 flex-shrink-0 text-arc-gold" />
          <p className="text-xs text-krypt-muted leading-relaxed">
            <span className="font-semibold text-white">Right now:</span>{' '}
            {!ra.enabled
              ? 'runner alerts are off.'
              : `flags from ${RUNNER_BUCKET_LABEL[ra.minBucket].toLowerCase()}${filters.length ? ` · ${filters.join(' · ')}` : ' · no other filter'}${mayhem === 'standard' ? ' · no mayhem coins' : mayhem === 'mayhem' ? ' · mayhem coins only' : ''} · at most ${ra.maxPerHour} notification${ra.maxPerHour === 1 ? '' : 's'} an hour.`}
          </p>
        </div>
      </div>
    </Section>
  );
}

export function Execution() {
  const { settings, updateSettings } = useAppState();
  const [snap, setSnap] = useState<ExecutionSnapshot | null>(null);
  const e = settings.execution;

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void window.krypt.engine.execution().then((r) => {
        if (alive && r.ok && r.data) setSnap(r.data);
      });
    };
    refresh();
    // The engine refreshes these estimates every 8 s; polling faster than
    // that returned the same snapshot two times out of three.
    const t = setInterval(refresh, 8_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const tf = snap?.tipFloor;

  return (
    <Page
      title="Execution"
      subtitle="What gets flagged as a potential runner, live priority-fee and tip telemetry, and the lanes your trades go out on."
    >
      <div className="mb-6 rounded-xl border border-amber-400/25 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-amber-300 flex-shrink-0" />
        <p className="text-xs text-krypt-muted leading-relaxed">
          <span className="text-white font-semibold">Nothing on this page buys on its own.</span> The scanner only flags
          launches; every buy and sell is one you place. The lanes below are live for those: tip transfers are injected
          into the transaction before signing (so the simulation loss guard bounds them) and the signed transaction is
          fanned to every enabled lane — Helius Sender (staked, free), the Jito block engine, and plain RPC — with
          rebroadcast until it confirms. Sells always escalate to the p95 tip: exit landing protects funds.
        </p>
      </div>

      <RunnerAlertsSection />

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Priority fee ladder" description="getPriorityFeeEstimate / getRecentPrioritizationFees, scoped to the trade's writable accounts.">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Fuel className="h-4 w-4 text-krypt-purple" />
              <span className="text-sm font-semibold text-white">Compute-unit price</span>
            </div>
            {snap ? <FeeLadder snap={snap} /> : <div className="text-xs text-krypt-muted">Start the engine to sample fees.</div>}
          </Card>
        </Section>

        <Section title="Jito tip floor" description="Live landed-tip percentiles from bundles.jito.wtf.">
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-4 w-4 text-krypt-purple" />
              <span className="text-sm font-semibold text-white">Bundle tip</span>
              {tf && <Badge tone={tf.ok ? 'success' : 'neutral'}>{tf.ok ? 'live' : 'default'}</Badge>}
            </div>
            {tf ? (
              <div className="grid grid-cols-3 gap-2">
                {([['p50', tf.p50Lamports], ['p75', tf.p75Lamports], ['p95', tf.p95Lamports]] as Array<[string, number]>).map(([k, v]) => (
                  <div key={k} className={cls('rounded-lg border px-3 py-2', e.jitoTipPercentile === Number(k.slice(1)) ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/10 bg-black/20')}>
                    <div className="text-label uppercase tracking-wider text-krypt-muted">{k}</div>
                    <div className="font-mono text-sm text-white mt-0.5">{solFrom(v)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-krypt-muted">Enable Jito to sample the tip floor.</div>
            )}
          </Card>
        </Section>
      </div>

      <Section title="Landing configuration" description="How the trades you place are priced and sent.">
        <div className="grid lg:grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <div className="text-sm font-semibold text-white mb-2">Fee urgency</div>
            <div className="flex gap-1.5">
              {(['normal', 'competitive', 'high', 'emergency'] as FeeUrgency[]).map((u) => (
                <button
                  key={u}
                  onClick={() => void updateSettings({ execution: { ...e, feeUrgency: u } })}
                  className={cls(
                    'rounded-lg px-2.5 py-1.5 text-xs font-semibold capitalize transition',
                    e.feeUrgency === u ? 'bg-krypt-gradient text-white shadow-krypt-glow' : 'border border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <div className="text-sm font-semibold text-white mb-2">Jito tip percentile</div>
            <div className="flex gap-1.5">
              {([50, 75, 95] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => void updateSettings({ execution: { ...e, jitoTipPercentile: p } })}
                  disabled={!e.useJito}
                  className={cls(
                    'rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40',
                    e.jitoTipPercentile === p ? 'bg-krypt-gradient text-white shadow-krypt-glow' : 'border border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                  )}
                >
                  p{p}
                </button>
              ))}
            </div>
          </div>
          {/* The mode, above the lane switches it governs. Named for the
              thing traders search for, described by the ROUTE rather than a
              promise — we cannot measure how much sandwiching this avoids,
              so we do not claim a number. */}
          <div className="rounded-lg border border-white/10 bg-black/25 p-3 lg:col-span-2">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-value font-semibold text-white">Sandwich exposure (MEV)</span>
              <span className="text-body text-krypt-muted">how a BUY is routed</span>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {(
                [
                  ['off', 'Public only', 'One public RPC, no tips. Cheapest, and visible to anyone watching the mempool before it lands.'],
                  ['fast', 'Fast (default)', 'Public RPC plus the staked and bundle lanes, tipped. Best landing odds. The transaction is still public.'],
                  ['private', 'Private', 'The buy goes to the Jito bundle lane ALONE — never broadcast to a public RPC, so it cannot be read out of a mempool first. Costs a tip and can miss a block.'],
                ] as const
              ).map(([mode, label, desc]) => (
                <button
                  key={mode}
                  onClick={() => void updateSettings({ execution: { ...e, mevMode: mode } })}
                  className={cls(
                    'rounded-md border px-3 py-2 text-left transition',
                    (e.mevMode ?? 'fast') === mode
                      ? 'border-krypt-purple/60 bg-krypt-purple/15'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/20',
                  )}
                >
                  <div className={cls('text-note font-semibold', (e.mevMode ?? 'fast') === mode ? 'text-white' : 'text-krypt-muted')}>
                    {label}
                  </div>
                  <div className="mt-0.5 text-label leading-relaxed text-krypt-muted/80">{desc}</div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-label leading-relaxed text-krypt-muted/70">
              Selling always uses every lane, whatever this is set to — missing a block on the way out is worse than
              being seen. How much sandwiching Private actually avoids is <span className="text-krypt-muted">unmeasured</span>:
              nobody can measure the trade that did not happen, and a vendor showing you a protection score is
              guessing.
            </p>
          </div>

          <Switch
            checked={e.useJito}
            onChange={(v) => void updateSettings({ execution: { ...e, useJito: v } })}
            label="Jito bundles"
            description="Revert-protected: a bundle that reverts is not included, so a failed trade costs no tip. It is sent ALONGSIDE the public RPC lane, not instead of it — whichever lands first wins, and the transaction is public either way."
          />
          <Switch
            checked={e.useHeliusSender}
            onChange={(v) => void updateSettings({ execution: { ...e, useHeliusSender: v } })}
            label="Helius Sender (free)"
            description="swqosOnly staked landing, free on all plans — the free-tier fast lane"
          />
          <Switch
            checked={e.localTxBuild}
            onChange={(v) => void updateSettings({ execution: { ...e, localTxBuild: v } })}
            label="Local transaction builder"
            description="Build pump buys and sells locally from chain state — on the bonding curve and, since 2026-09-19, on PumpSwap after graduation — one batched account read instead of a service round trip, and no relayer fee. Every transaction is still simulated before signing; a build that fails falls back to Jupiter, then the relayer."
          />
        </div>
      </Section>
    </Page>
  );
}
