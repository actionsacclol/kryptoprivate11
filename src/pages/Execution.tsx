import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Fuel, Layers, ShieldCheck, Zap } from 'lucide-react';
import { Badge, Card, Empty, Page, Section, Switch } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import type { ExecutionSnapshot, FeeUrgency } from '@shared/types';
import { cls, fmtClock, shortAddr } from '../utils/format';

const LAMPORTS = 1e9;
const solFrom = (l: number): string => `${(l / LAMPORTS).toFixed(6)} SOL`;

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

export function Execution() {
  const { settings, updateSettings, status } = useAppState();
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
      title="Execution Lab"
      subtitle="Live priority-fee + Jito tip telemetry, and the send lanes real trades use."
    >
      <div className="mb-6 rounded-xl border border-amber-400/25 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-amber-300 flex-shrink-0" />
        <p className="text-xs text-krypt-muted leading-relaxed">
          These lanes are <span className="text-white font-semibold">live</span>: when real execution fires, tip
          transfers are injected into the transaction before signing (so the simulation loss-guard bounds them) and the
          signed transaction is fanned to every enabled lane — Helius Sender (staked, free), the Jito block engine, and
          plain RPC — with rebroadcast until it confirms. Sells always escalate to the p95 tip: exit landing protects
          funds. The paper plans below still show each would-be snipe priced off live fee and tip data.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Priority fee ladder" description="getPriorityFeeEstimate / getRecentPrioritizationFees, scoped to the snipe's writable accounts.">
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

      <Section title="Landing configuration">
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
          <div className="rounded-lg border border-white/10 bg-black/25 p-3">
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
            description="Build pump curve buys/sells locally — one account read instead of a relayer round trip, and no relayer fee. Every tx is still simulated before signing and falls back to the relayer if anything is off. Graduated tokens always use the relayer."
          />
        </div>
      </Section>

      <Section title="Paper send plans" description="What a live buy would submit for each paper entry — priced off the data above.">
        {!snap || snap.recentPlans.length === 0 ? (
          <Empty
            title="No send plans yet"
            message={status.running ? 'A plan is built each time a launch qualifies and a paper entry opens.' : 'Start the engine and let a launch qualify.'}
          />
        ) : (
          <div className="space-y-3">
            {snap.recentPlans.slice(0, 12).map((p) => (
              <motion.div key={`${p.mint}-${p.builtAt}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <Card padded={false}>
                  <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-krypt-purple" />
                      <span className="text-sm font-bold text-white">{p.symbol}</span>
                      <Badge tone="warn">paper</Badge>
                    </div>
                    <span className="text-xs text-krypt-muted font-mono">{fmtClock(p.builtAt)}</span>
                  </div>
                  <div className="px-5 py-3 grid lg:grid-cols-2 gap-x-8 gap-y-1.5 text-xs font-mono">
                    <div className="flex justify-between"><span className="text-krypt-muted">CU price</span><span className="text-white">{p.computeUnitPrice.toLocaleString()} µlpt ({p.feeSource})</span></div>
                    <div className="flex justify-between"><span className="text-krypt-muted">CU limit</span><span className="text-white">{p.computeUnitLimit.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-krypt-muted">bonding curve</span><span className="text-white">{shortAddr(p.bondingCurve, 5)}</span></div>
                    <div className="flex justify-between"><span className="text-krypt-muted">token ATA</span><span className="text-white">{shortAddr(p.associatedTokenAccount, 5)}</span></div>
                    <div className="flex justify-between lg:col-span-2 pt-1 border-t border-white/5 mt-1"><span className="text-krypt-muted">est. all-in cost</span><span className="text-krypt-purple font-semibold">{solFrom(p.estCostLamports)}</span></div>
                  </div>
                  <div className="px-5 pb-3 flex flex-wrap gap-1.5">
                    {p.lanes.map((l, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-body">
                        <span className="font-semibold text-white">{l.lane}</span>
                        <span className="text-krypt-muted">· {l.detail}</span>
                        {l.tipLamports > 0 && <span className="text-krypt-purple font-mono">tip {solFrom(l.tipLamports)}</span>}
                      </span>
                    ))}
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}
