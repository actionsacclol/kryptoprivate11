// Warmer — random autotrading on a group, or on one wallet of it
// (2026-09-03). Buys a random liquid token with a random size, holds a
// random while, sells, waits a random gap, repeats — under a hard stop at a
// REALISED-loss cap, an hourly cap and a per-wallet open cap. A utility that
// spends fees and slippage on purpose, not a strategy.

import { useState } from 'react';
import { DEFAULT_RANDOM, validateRandom, type RandomRunStatus, type RandomSettings } from '@shared/lab';
import type { WalletGroupView } from '@shared/types';
import { Badge, Card, Empty, GhostButton, NumberInput, Page, PrimaryButton, Section } from '../../components/common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls, fmtAgo, fmtSol, shortAddr } from '../../utils/format';
import { RealMoneyBanner, Row, countdown, selectCls, useLabData, useTick } from './shared';

export function WarmerPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const modal = useModal();
  const data = useLabData();
  const { groups, runs, armed, armedReason, active, labelOf, setRuns, applyGroups, busy, setBusy } = data;
  // The clock only runs while there is a countdown to move.
  useTick(runs.some((r) => r.running || r.open.length > 0) ? 1_000 : 0);

  const [draft, setDraft] = useState<Record<string, RandomSettings>>({});
  const [scope, setScope] = useState<Record<string, string>>({}); // groupId → '' (whole group) | walletId
  const settingsFor = (g: WalletGroupView): RandomSettings => draft[g.id] ?? g.lab?.random ?? { ...DEFAULT_RANDOM };
  const patch = (g: WalletGroupView, p: Partial<RandomSettings>): void =>
    setDraft((cur) => ({ ...cur, [g.id]: { ...(cur[g.id] ?? g.lab?.random ?? { ...DEFAULT_RANDOM }), ...p } }));

  const save = async (g: WalletGroupView): Promise<void> => {
    const cfg = settingsFor(g);
    const v = validateRandom(cfg);
    if (!v.ok) return toast.error(v.message);
    const r = await window.krypt.lab.setRandom(g.id, cfg);
    applyGroups(r);
    if (r.ok) {
      toast.success(`Warmer settings saved for ${g.name}`);
      setDraft((cur) => {
        const next = { ...cur };
        delete next[g.id];
        return next;
      });
    }
  };

  const start = async (g: WalletGroupView): Promise<void> => {
    if (busy) return;
    if (draft[g.id]) return toast.error('Save the settings first');
    setBusy('start');
    const cfg = g.lab?.random ?? DEFAULT_RANDOM;
    const walletId = scope[g.id] || '';
    const targets = walletId ? [walletId] : undefined;
    const who = walletId ? `wallet “${labelOf.get(walletId) ?? walletId}”` : `${g.members.filter((m) => m.id !== active?.id).length} wallet(s) of “${g.name}”`;
    const yes = await modal.confirm({
      title: `Start the warmer on ${walletId ? 'one wallet' : `“${g.name}”`}`,
      message: `${who} will buy random ${cfg.universe} tokens with ${cfg.tradeSolMin}–${cfg.tradeSolMax} SOL each (never above your per-trade cap), hold ${cfg.holdSecMin}–${cfg.holdSecMax} s, and sell — REAL SOL, on purpose losing fees and slippage. It stops by itself once closed trades have lost ${cfg.maxLossSol} SOL, or when you press Stop; bags still open keep selling on their timers either way.`,
      confirmLabel: 'Start',
      destructive: true,
    });
    if (!yes) {
      setBusy(null);
      return;
    }
    try {
      const r = await window.krypt.lab.randomStart(g.id, targets);
      if (r.ok && r.data) {
        setRuns((cur) => [r.data as RandomRunStatus, ...cur.filter((x) => x.groupId !== g.id)]);
        toast.warn(`Warmer started on ${g.name}`);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };
  const stop = async (g: WalletGroupView): Promise<void> => {
    if (busy) return;
    setBusy('stop');
    try {
      const r = await window.krypt.lab.randomStop(g.id);
      if (r.ok && r.data) {
        setRuns((cur) => [r.data as RandomRunStatus, ...cur.filter((x) => x.groupId !== g.id)]);
        // The engine's line says whether bags are still open and selling.
        toast.info(r.message || `Warmer stopped on ${g.name}`);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  const runningCount = runs.filter((r) => r.running).length;

  // A run whose group was deleted still holds bags, and the engine still sells
  // them on their timers — but this page renders runs THROUGH the group list,
  // so those bags would simply vanish from the UI. They get their own card
  // below instead, so nothing you still own goes invisible.
  const groupIds = new Set(groups.map((g) => g.id));
  const orphanRuns = runs.filter((r) => !groupIds.has(r.groupId) && r.open.length > 0);

  // The run file could not be read, so nothing is being written to it either.
  // Bags opened now would be forgotten by the next launch, which is exactly
  // the thing the user needs to know BEFORE they arm anything.
  const loadFailure = runs.find((r) => r.loadFailure)?.loadFailure ?? null;

  return (
    <Page
      title="Warmer"
      subtitle={`${groups.length} group${groups.length === 1 ? '' : 's'} · ${runningCount} run${runningCount === 1 ? '' : 's'} active`}
    >
      {loadFailure && (
        <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <div className="font-semibold">The warmer&rsquo;s record of open bags could not be read.</div>
          <div className="mt-1 font-mono text-body text-rose-300/90">{loadFailure}</div>
          <div className="mt-1">
            Nothing is being written to it this session, so the file is left intact — but a bag opened now is not remembered
            across a restart. Fix or move that file before arming.
          </div>
        </div>
      )}

      <RealMoneyBanner armed={armed} what="Nothing here is a strategy; the warmer is expected to lose fees and slippage. The loss cap is on realised cash of CLOSED trades — bags still held count at cost, so it stops when money has actually been lost, not for holding. Open bags survive a stop, a disarm and a restart, and keep selling on their timers." />

      {groups.length === 0 ? (
        <Empty title="No groups" message="Create a group and some wallets in Group Wallets first." />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {groups.map((g) => {
            const r = settingsFor(g);
            const dirty = !!draft[g.id];
            const run = runs.find((x) => x.groupId === g.id) ?? null;
            const running = run?.running === true;
            // A restored run has no realised figure it can honestly state and
            // its cap is resolved lazily, so the bar is drawn only when both
            // are real. Dividing by a 1e-9 floor used to pin it at 100 % next
            // to a "cap 0.0000 SOL" label.
            const capKnown = typeof run?.maxLossSol === 'number' && run.maxLossSol > 0;
            const realKnown = run != null && run.realizedSol !== null && Number.isFinite(run.realizedSol);
            const lossPct = run && capKnown && realKnown ? Math.min(100, Math.max(0, (-(run.realizedSol as number) / run.maxLossSol) * 100)) : null;
            const members = g.members.filter((m) => m.id !== active?.id);
            const scopeWallet = scope[g.id] || '';
            return (
              <Section key={g.id}>
                <Card>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-value font-semibold text-white">{g.name}</span>
                    <span className="text-label font-mono text-krypt-muted">{members.length} wallet{members.length === 1 ? '' : 's'}</span>
                    {running ? <Badge tone="danger">running</Badge> : run ? <Badge tone="neutral">stopped</Badge> : null}
                    <div className="flex-1" />
                    <PrimaryButton onClick={() => void save(g)} disabled={!dirty || running} className="!py-1">Save</PrimaryButton>
                  </div>

                  <div className="grid gap-2">
                    <Row label="Universe" hint="Discover column supplying candidates">
                      <select value={r.universe} onChange={(e) => patch(g, { universe: e.target.value as RandomSettings['universe'] })} className={selectCls} disabled={running}>
                        <option value="trending">Trending</option>
                        <option value="graduating">Graduating</option>
                        <option value="new">New</option>
                      </select>
                    </Row>
                    <Row label="Min liquidity" hint="USD">
                      <NumberInput value={r.minLiquidityUsd} min={0} max={1e9} onChange={(v) => patch(g, { minLiquidityUsd: v })} suffix="$" className="w-32" />
                    </Row>
                    <Row label="Trade size" hint="Random, SOL">
                      <div className="flex items-center gap-1.5">
                        <NumberInput value={r.tradeSolMin} min={0.001} max={5} onChange={(v) => patch(g, { tradeSolMin: v })} className="w-24" />
                        <span className="text-krypt-muted text-xs">to</span>
                        <NumberInput value={r.tradeSolMax} min={0.001} max={5} onChange={(v) => patch(g, { tradeSolMax: v })} className="w-24" />
                      </div>
                    </Row>
                    <Row label="Hold" hint="Random, seconds">
                      <div className="flex items-center gap-1.5">
                        <NumberInput value={r.holdSecMin} min={5} max={86400} onChange={(v) => patch(g, { holdSecMin: v })} className="w-24" />
                        <span className="text-krypt-muted text-xs">to</span>
                        <NumberInput value={r.holdSecMax} min={5} max={86400} onChange={(v) => patch(g, { holdSecMax: v })} className="w-24" />
                      </div>
                    </Row>
                    <Row label="Gap between trades" hint="Random, seconds">
                      <div className="flex items-center gap-1.5">
                        <NumberInput value={r.gapSecMin} min={5} max={86400} onChange={(v) => patch(g, { gapSecMin: v })} className="w-24" />
                        <span className="text-krypt-muted text-xs">to</span>
                        <NumberInput value={r.gapSecMax} min={5} max={86400} onChange={(v) => patch(g, { gapSecMax: v })} className="w-24" />
                      </div>
                    </Row>
                    <Row label="Max open per wallet">
                      <NumberInput value={r.maxOpenPerWallet} min={1} max={10} onChange={(v) => patch(g, { maxOpenPerWallet: v })} className="w-20" />
                    </Row>
                    <Row label="Max loss" hint="Stops when closed trades since start have lost this much (open bags count at cost)">
                      <NumberInput value={r.maxLossSol} min={0.001} max={100} onChange={(v) => patch(g, { maxLossSol: v })} suffix="SOL" className="w-28" />
                    </Row>
                    <Row label="Max trades per hour">
                      <NumberInput value={r.maxTradesPerHour} min={1} max={240} onChange={(v) => patch(g, { maxTradesPerHour: v })} className="w-20" />
                    </Row>
                  </div>

                  {/* Scope + start/stop */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                    <span className="text-body text-krypt-muted">Run on</span>
                    <select value={scopeWallet} onChange={(e) => setScope((cur) => ({ ...cur, [g.id]: e.target.value }))} className={selectCls} disabled={running}>
                      <option value="">Whole group ({members.length})</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>Single wallet: {m.label}</option>
                      ))}
                    </select>
                    <div className="flex-1" />
                    {running ? (
                      <GhostButton onClick={() => void stop(g)} destructive>Stop</GhostButton>
                    ) : (
                      <PrimaryButton onClick={() => void start(g)} disabled={!armed || dirty || members.length === 0 || busy !== null} className="!py-1.5">Start</PrimaryButton>
                    )}
                  </div>
                  {!armed && <div className="mt-2 text-body text-arc-gold">{armedReason}</div>}
                  {dirty && !running && <div className="mt-2 text-body text-arc-gold">Unsaved settings — save before starting.</div>}

                  {run && (
                    <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3 text-body">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-white">
                          {running ? 'Running' : 'Stopped'} · started {run.startedAt ? fmtAgo(run.startedAt) + ' ago' : '—'}
                          {run.stoppedAt ? ` · stopped ${fmtAgo(run.stoppedAt)} ago` : ''}
                        </span>
                        <span className="font-mono text-krypt-muted">
                          scope: {run.walletIds === null ? 'whole group' : run.walletIds.map((id) => labelOf.get(id) ?? id).join(', ')}
                        </span>
                        <span className="font-mono text-white/80">{run.buys} buys · {run.sells} sells · {run.failed} failed</span>
                        {running && <span className="font-mono text-krypt-muted">next action in {countdown(run.nextActionAt)}</span>}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        {realKnown ? (
                          <span className={cls('font-mono', (run.realizedSol as number) >= 0 ? 'text-emerald-300' : 'text-rose-300')} title="Closed trades only; open bags are carried at cost">
                            {(run.realizedSol as number) >= 0 ? '+' : ''}{fmtSol(run.realizedSol as number)} SOL realised on closed trades
                          </span>
                        ) : (
                          <span className="font-mono text-krypt-muted" title="Some of this run's fills have not been read back from the chain yet, so the realised figure is unknown">
                            — SOL realised on closed trades
                          </span>
                        )}
                        {lossPct !== null && (
                          <div className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden" title="Realised loss on closed trades against the cap">
                            <div className="h-full rounded-full bg-gradient-to-r from-arc-gold to-rose-400" style={{ width: `${lossPct}%` }} />
                          </div>
                        )}
                        <span className="font-mono text-krypt-muted">cap {capKnown ? `${fmtSol(run.maxLossSol)} SOL` : '—'}</span>
                      </div>
                      {run.open.length > 0 && (
                        <div className="mt-2 space-y-0.5">
                          {run.open.map((o) => (
                            <div key={`${o.walletId}:${o.mint}`} className="flex items-center gap-2">
                              <span className="text-krypt-muted">{labelOf.get(o.walletId) ?? o.walletId}</span>
                              <button onClick={() => onOpenToken(o.mint)} className="text-white hover:text-krypt-pink font-medium">
                                {o.symbol || shortAddr(o.mint)}
                              </button>
                              <span className="font-mono text-krypt-muted">
                                {o.costSol !== null ? `${fmtSol(o.costSol)} SOL · ` : ''}sells in {countdown(o.sellAt)}
                                {o.tries ? ` · retry ${o.tries + 1}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {run.lastLine && <div className="mt-2 font-mono text-krypt-muted/80 truncate" title={run.lastLine}>{run.lastLine}</div>}
                      {run.stopReason && <div className="mt-1 text-arc-gold">Stopped: {run.stopReason}</div>}
                    </div>
                  )}
                </Card>
              </Section>
            );
          })}
        </div>
      )}

      {/* A run is normally rendered through its group. If the group is gone
          the run is not — and its bags keep selling on their timers with
          nowhere to report a failure. Show them here so they stay visible. */}
      {orphanRuns.length > 0 && (
        <Section>
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-value font-semibold text-white">Bags from deleted groups</span>
              <Badge tone="warn">{orphanRuns.reduce((n, r) => n + r.open.length, 0)} held</Badge>
            </div>
            <div className="text-body text-krypt-muted mb-3">
              These runs belong to groups that no longer exist. Their bags still sell on their own timers; sell one by hand from its token page if you would rather not wait.
            </div>
            <div className="space-y-1 text-body">
              {orphanRuns.flatMap((r) =>
                r.open.map((o) => (
                  <div key={`${r.groupId}:${o.walletId}:${o.mint}`} className="flex items-center gap-2">
                    <span className="text-krypt-muted">{labelOf.get(o.walletId) ?? shortAddr(o.walletId)}</span>
                    <button onClick={() => onOpenToken(o.mint)} className="text-white hover:text-krypt-pink font-medium">
                      {o.symbol || shortAddr(o.mint)}
                    </button>
                    <span className="font-mono text-krypt-muted">
                      {o.costSol !== null ? `${fmtSol(o.costSol)} SOL · ` : ''}sells in {countdown(o.sellAt)}
                      {o.tries ? ` · retry ${o.tries + 1}` : ''}
                    </span>
                  </div>
                )),
              )}
            </div>
          </Card>
        </Section>
      )}
    </Page>
  );
}
