// One chain's Observatory. Two instances, and they share nothing.
//
// The Solana Observatory watches the SniperEngine; this watches one EVM
// chain's own scanner. The `chain` prop is the whole isolation story — every
// call takes it, every event is filtered on it, and a status for another chain
// is dropped rather than merged. A number under a BNB heading is a BNB number.
//
// What it shows is MEASURED, not scored: launches seen, trades seen, and for
// each launch what actually happened in its first 60 and 120 seconds. There is
// no odds column, and that is deliberate — see shared/evmScan.ts. pump's model
// describes pump's launches; printing its graduation rates over a Pons token
// would be a confident number with nothing behind it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Telescope } from 'lucide-react';
import { EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';
import { emptyScanStatus, type EvmScanLaunch, type EvmScanStatus } from '@shared/evmScan';
import {
  BUYER_BUCKETS,
  BUYER_BUCKET_LABEL,
  MIN_BUCKET_SAMPLES,
  baseRatePct,
  emptyModel,
  type BuyerBucket,
  type RunnerModel,
} from '@shared/evmRunners';
import { useAppState } from '../state/AppStateProvider';

/** Unknown is an em dash. Never 0. */
const n = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—');

const ago = (t: number | null): string => {
  if (t === null) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'muted' }) {
  return (
    <div className="rounded-lg border border-white/10 bg-krypt-panel px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.18em] text-krypt-muted/70">{label}</div>
      <div
        className={`mt-0.5 font-mono text-base font-semibold ${
          tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'muted' ? 'text-krypt-muted' : 'text-white'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function EvmObservatory({ chain }: { chain: EvmChainKind }) {
  const meta = EVM_CHAIN_META[chain];
  const { settings, updateSettings } = useAppState();
  const alerts = settings.evm[chain].runnerAlerts;
  const [status, setStatus] = useState<EvmScanStatus>(() => emptyScanStatus(chain));
  const [launches, setLaunches] = useState<EvmScanLaunch[]>([]);
  const [model, setModel] = useState<RunnerModel>(() => emptyModel(chain));

  // Remount cleanly when the route switches between the two chains: without
  // resetting here, BNB would paint with Robinhood's numbers for one frame.
  useEffect(() => {
    setStatus(emptyScanStatus(chain));
    setLaunches([]);
    setModel(emptyModel(chain));
  }, [chain]);

  const refresh = useCallback(async () => {
    const [s, l, m] = await Promise.all([
      window.krypt.evm.scan.status(chain),
      window.krypt.evm.scan.launches(chain),
      window.krypt.evm.scan.model(chain),
    ]);
    if (s.ok && s.data) setStatus(s.data);
    if (l.ok && Array.isArray(l.data)) setLaunches(l.data);
    if (m.ok && m.data) setModel(m.data);
  }, [chain]);

  useEffect(() => {
    void refresh();
    // The scanner pushes a status on every poll; the launch list is pulled
    // alongside it rather than duplicated into the event.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'evmScan') return;
      // Isolation, enforced at the receiver as well as the sender.
      if (ev.status.chain !== chain) return;
      setStatus(ev.status);
      void window.krypt.evm.scan.launches(chain).then((r) => {
        if (r.ok && Array.isArray(r.data)) setLaunches(r.data);
      });
    });
    return off;
  }, [chain, refresh]);

  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const watched = useMemo(
    // The filter hides ROWS; it never touches the model or the counters
    // above, which are the chain's whole record either way.
    () => (flaggedOnly ? launches.filter((l) => l.call?.flag) : launches).slice(0, 60),
    [launches, flaggedOnly],
  );

  const setAlerts = useCallback(
    (next: Partial<typeof alerts>) => {
      // The whole `evm` block is sent, as every other EVM settings write
      // does: `Partial<AppSettings>` is shallow, so a bare `{ [chain]: … }`
      // would be a type lie even though the store merges deeply.
      void updateSettings({
        evm: { ...settings.evm, [chain]: { ...settings.evm[chain], runnerAlerts: { ...alerts, ...next } } },
      });
    },
    [chain, alerts, settings.evm, updateSettings],
  );

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Telescope className="h-4 w-4 text-krypt-pink" />
            {meta.name} Observatory
          </h1>
          <p className="text-[12px] text-krypt-muted">
            Watching {meta.launchpadLabel} launches on chain {meta.id}. Measured facts only — no odds on this chain yet.
          </p>
        </div>
        {/* No Start button here on purpose. The Scanners row in the bar
            directly above names all three and controls each — two buttons for
            one scanner, one of them ambiguous about WHICH, was the problem
            that row exists to fix. */}
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] ${
            status.running ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/5 text-krypt-muted'
          }`}
        >
          {status.running ? 'Watching' : 'Stopped'}
        </span>
      </div>

      {!status.enabled && (
        <p className="mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-krypt-muted">
          {meta.name} is turned off in Settings, so nothing is polled and nothing is shown.
        </p>
      )}
      {status.lastError && (
        <p className="mb-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">
          Last poll: {status.lastError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Scanner" value={status.running ? 'Watching' : 'Stopped'} tone={status.running ? 'good' : 'muted'} />
        <Stat label="Launches seen" value={n(status.launchesSeen)} />
        <Stat label="Trades seen" value={n(status.tradesSeen)} />
        <Stat label="Measuring" value={n(status.tracking)} />
        {/* Graduations among the launches THIS scanner saw launch — not the
            chain's total. A number under that shorter label read as chain-wide.
            On BNB a graduation is only learned when the launch settles, six
            hours on, so the count lags the chain by that much. */}
        <Stat label="Graduated (of seen)" value={n(status.graduationsSeen)} />
        <Stat label="Calls" value={n(status.callsFlagged)} tone={status.callsFlagged > 0 ? 'good' : undefined} />
        <Stat label="Last block" value={n(status.lastBlock)} tone={status.behind !== null && status.behind > 50 ? 'warn' : undefined} />
      </div>
      <p className="mt-2 text-[11px] text-krypt-muted">
        {status.behind === null ? 'Head not read yet.' : `${n(status.behind)} block(s) behind the head.`}
        {status.lastPollAt !== null && ` Last poll ${ago(status.lastPollAt)} ago.`}
        {status.startedAt !== null && status.running && ` Watching for ${ago(status.startedAt)}.`}
      </p>

      {/* ── the filter ─────────────────────────────────────────────────
          What gets a notification, and nothing else. The measurement above
          is made on every launch whatever these say; changing a floor here
          cannot change a number on this page. */}
      <div className="mt-5 rounded-xl border border-white/10 bg-krypt-panel p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={() => setAlerts({ enabled: !alerts.enabled })}
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
              alerts.enabled
                ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:bg-white/10'
            }`}
          >
            {alerts.enabled ? 'Runner alerts on' : 'Runner alerts off'}
          </button>

          <label className="flex items-center gap-1.5 text-[11px] text-krypt-muted">
            Tell me from
            <select
              value={alerts.minBucket}
              onChange={(e) => setAlerts({ minBucket: Number(e.target.value) as BuyerBucket })}
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white focus:outline-none"
            >
              {BUYER_BUCKETS.filter((b) => b > 0).map((b) => (
                <option key={b} value={b}>{BUYER_BUCKET_LABEL[b]}</option>
              ))}
            </select>
            upwards
          </label>

          <label className="flex items-center gap-1.5 text-[11px] text-krypt-muted">
            At most
            <input
              type="number"
              min={1}
              max={120}
              value={alerts.maxPerHour}
              onChange={(e) => setAlerts({ maxPerHour: Math.round(Number(e.target.value)) })}
              className="w-14 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-right font-mono text-[11px] text-white focus:outline-none"
            />
            an hour
          </label>

          <button
            onClick={() => setAlerts({ requireBeatsBase: !alerts.requireBeatsBase })}
            title="A bucket can be well sampled and still be no better than picking at random."
            className="flex items-center gap-1.5 text-[11px] text-krypt-muted transition hover:text-white/80"
          >
            <span className={`h-3 w-3 rounded border ${alerts.requireBeatsBase ? 'border-krypt-purple bg-krypt-purple/40' : 'border-white/20'}`} />
            only when it beats this chain's base rate
          </button>

          <button
            onClick={() => setFlaggedOnly((v) => !v)}
            className="ml-auto flex items-center gap-1.5 text-[11px] text-krypt-muted transition hover:text-white/80"
          >
            <span className={`h-3 w-3 rounded border ${flaggedOnly ? 'border-arc-gold bg-arc-gold/40' : 'border-white/20'}`} />
            show flagged only
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-krypt-muted/80">
          This decides what interrupts you. Every launch is still measured and still listed — the buckets below are {meta.name}'s
          whole record, whatever is set here.
        </p>
      </div>

      <h2 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.18em] text-krypt-muted/70">Launches, newest first</h2>
      {watched.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 bg-krypt-panel/40 py-12 text-center">
          <p className="text-[13px] text-white/80">{status.running ? 'Nothing yet.' : 'Not watching.'}</p>
          <p className="mt-1 text-[12px] text-krypt-muted">
            {status.running
              ? 'Launches appear here as they happen — the scanner starts at the head, so nothing older is back-filled.'
              : `Use the Scanners row above — ${meta.shortName} — to follow launches from now on.`}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-krypt-muted/70">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Token</th>
                <th className="px-3 py-2 text-right font-medium">Age</th>
                <th className="px-3 py-2 text-right font-medium">Buys 60s</th>
                <th className="px-3 py-2 text-right font-medium">Buyers 60s</th>
                <th className="px-3 py-2 text-right font-medium">Net {meta.nativeSymbol} 60s</th>
                <th className="px-3 py-2 text-right font-medium">Buys 120s</th>
                <th className="px-3 py-2 text-left font-medium">Creator</th>
                <th className="px-3 py-2 text-left font-medium">Call</th>
              </tr>
            </thead>
            <tbody>
              {watched.map((l) => {
                const w60 = l.windows.find((w) => w.windowS === 60);
                const w120 = l.windows.find((w) => w.windowS === 120);
                return (
                  <tr key={l.token} className="border-t border-white/5">
                    <td className="px-3 py-1.5">
                      <span className="font-medium text-white/90">{l.symbol || `${l.token.slice(0, 8)}…`}</span>
                      {l.graduatedAt !== null && (
                        <span className="ml-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 text-[9px] text-emerald-300">graduated</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{ago(l.seenAt)}</td>
                    {/* A window that has not closed yet is an em dash, not a 0:
                        "no buys" and "we have not finished counting" are
                        different facts and must not look the same. */}
                    <td className="px-3 py-1.5 text-right font-mono">{w60 ? n(w60.buys) : '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{w60 ? n(w60.uniqueBuyers) : '—'}</td>
                    {/* A curve quoted in another asset has no BNB number: a
                        dash with the reason, never its USDT read as BNB. */}
                    <td
                      className={`px-3 py-1.5 text-right font-mono ${w60 && w60.netNative !== null && w60.netNative < 0 ? 'text-rose-300' : ''}`}
                      title={w60 && w60.netNative === null ? `Quoted in another asset, not ${meta.nativeSymbol}` : undefined}
                    >
                      {w60 && w60.netNative !== null ? w60.netNative.toFixed(4) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{w120 ? n(w120.buys) : '—'}</td>
                    <td className="px-3 py-1.5 text-left">
                      {w60?.creatorSold ? <span className="text-rose-300">sold in 60s</span> : <span className="text-krypt-muted">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-left">
                      {/* Never the word "runner" alone. The observed rate and
                          the base rate travel together or not at all. */}
                      {!l.call ? (
                        <span className="text-krypt-muted">—</span>
                      ) : l.call.flag ? (
                        <span className="rounded-full border border-arc-gold/40 bg-arc-gold/10 px-1.5 py-0.5 text-[10px] text-arc-gold" title={l.call.detail}>
                          {l.call.ratePct?.toFixed(1)}% vs {(l.call.otherRatePct ?? l.call.baseRatePct)?.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-[10px] text-krypt-muted" title={l.call.detail}>
                          {l.call.ratePct === null
                            ? 'not enough data'
                            : l.call.ratePct === 0 && l.call.baseRatePct === 0
                              ? 'none graduated yet'
                              : l.call.otherRatePct !== null && l.call.otherRatePct !== undefined && l.call.ratePct > l.call.otherRatePct
                                ? 'above base, inside noise'
                                : 'no better than base'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 space-y-2 text-[11px] leading-relaxed text-krypt-muted">
        <p>
          <span className="text-white/80">Runner calls on {meta.name} are built from this chain's own records</span>, never from
          the Solana model — that one was fitted on pump.fun launches and its numbers describe that population.{' '}
          {model.totalSettled === 0
            ? `Nothing has been recorded yet: a launch counts once we have seen how it ended, so the first calls are hours away.`
            : `${model.totalGraduated.toLocaleString()} of ${model.totalSettled.toLocaleString()} launches watched to a conclusion so far${
                baseRatePct(model) === null ? '' : ` — ${baseRatePct(model)?.toFixed(2)}% graduated`
              }.`}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {model.tallies.map((t) => {
            const enough = t.settled >= MIN_BUCKET_SAMPLES;
            return (
              <span key={t.bucket} className={enough ? 'text-white/70' : ''}>
                {BUYER_BUCKET_LABEL[t.bucket]}:{' '}
                {enough ? (
                  <span className="font-mono">{((t.graduated / t.settled) * 100).toFixed(1)}%</span>
                ) : (
                  <span className="font-mono">{t.settled}/{MIN_BUCKET_SAMPLES}</span>
                )}
              </span>
            );
          })}
        </div>
        <p>
          A bucket says nothing until {MIN_BUCKET_SAMPLES} launches have ended in it, and a call is only flagged when its measured
          rate beats this chain's own base rate. Both numbers are always shown together — a rate without the base rate beside it is
          a claim, not a measurement.
        </p>
      </div>
    </div>
  );
}
