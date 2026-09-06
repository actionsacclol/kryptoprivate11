// Token Divination — the right-side inspection drawer. Opened by clicking a
// spark on the scrying orb (or a row elsewhere). Every gauge and seal here
// maps to real engine data; nothing is decorative-only.

import { AnimatePresence, motion } from 'framer-motion';
import { Ban, X } from 'lucide-react';
import type { LaunchRow } from '@shared/types';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { Badge } from './common';
import { Sparkline } from './viz/Sparkline';
import { cls, fmtAgo, fmtPrice, shortAddr } from '../utils/format';

function Field({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'gold' }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-2.5 py-2">
      <div className="text-[9px] font-display uppercase tracking-[0.22em] text-krypt-muted/80">{label}</div>
      <div className={cls(
        'mt-0.5 text-xs font-mono tabular-nums',
        tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'gold' ? 'text-arc-gold' : 'text-white/90',
      )}>{value}</div>
    </div>
  );
}

/** Circular seal gauge — share of a whole (0..1), crimson past the danger mark. */
function SealGauge({ label, share, dangerAt }: { label: string; share: number; dangerAt: number }) {
  const pct = Math.max(0, Math.min(1, share));
  const danger = pct >= dangerAt;
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-md border border-white/10 bg-black/25 px-2 py-2.5">
      <svg viewBox="0 0 44 44" className="h-11 w-11 -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(240,237,226,0.08)" strokeWidth="3" />
        <circle
          cx="22" cy="22" r={r} fill="none"
          stroke={danger ? '#E5484D' : '#8B7CE8'}
          strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
        />
      </svg>
      <div className={cls('-mt-9 mb-3 text-[10px] font-mono font-semibold', danger ? 'text-rose-300' : 'text-white/90')}>
        {Math.round(pct * 100)}%
      </div>
      <div className="text-[8px] font-display uppercase tracking-[0.18em] text-krypt-muted/80 text-center leading-tight">{label}</div>
    </div>
  );
}

export function TokenDrawer({ launch, onClose }: { launch: LaunchRow | null; onClose: () => void }) {
  const modal = useModal();
  const { blacklistCreator, settings } = useAppState();
  const minScore = settings.strategy.minScore;

  const onBlacklist = async (l: LaunchRow): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Blacklist creator',
      message: `Hard-reject every future launch from ${shortAddr(l.creator, 6)}?`,
      confirmLabel: 'Blacklist',
      destructive: true,
    });
    if (yes) void blacklistCreator(l.creator);
  };

  return (
    <AnimatePresence>
      {launch && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            initial={{ x: 420 }}
            animate={{ x: 0 }}
            exit={{ x: 420 }}
            transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
            className="fixed right-0 top-0 bottom-0 z-50 w-[400px] border-l border-white/10 bg-krypt-panel/95 backdrop-blur-md shadow-krypt-card flex flex-col"
            role="dialog"
            aria-label="Token divination"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div>
                <div className="font-display text-[10px] uppercase tracking-[0.32em] text-arc-gold/80">Token Divination</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-white">{launch.symbol || '—'}</span>
                  <span className="text-xs text-krypt-muted truncate max-w-[180px]">{launch.name}</span>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="h-8 w-8 rounded-md border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted transition hover:text-white hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={
                  launch.phase === 'entered' ? 'success' :
                  // A flagged runner is the scanner's headline output; warn
                  // is the closest tone this badge has to the gold used for it.
                  launch.phase === 'flagged' ? 'warn' :
                  launch.phase === 'rejected' ? 'danger' :
                  launch.phase === 'evaluating' ? 'gradient' :
                  launch.phase === 'completed' ? 'warn' : 'neutral'
                }>{launch.phase === 'flagged' ? 'potential runner' : launch.phase}</Badge>
                <span className="text-xs font-mono text-krypt-muted">age {fmtAgo(launch.detectedAt)}</span>
              </div>

              <Sparkline data={launch.priceHistory} width={352} height={56} />

              <div className="grid grid-cols-3 gap-2">
                <Field label="Price" value={`${fmtPrice(launch.priceSol)}`} />
                <Field label="Curve" value={`${launch.flow.curveProgressPct.toFixed(1)}%`} />
                <Field label="Score" value={launch.score ? `${launch.score.total}/100` : '—'} tone={launch.score && launch.score.total >= minScore ? 'gold' : undefined} />
                <Field label="Net inflow" value={`${launch.flow.netInflowSol.toFixed(2)} SOL`} tone={launch.flow.netInflowSol >= 0 ? 'good' : 'bad'} />
                <Field label="Buys / Sells" value={`${launch.flow.buys} / ${launch.flow.sells}`} />
                <Field label="Buyers" value={String(launch.flow.uniqueBuyers)} />
                <Field label="Buy vol" value={`${launch.flow.buyVolumeSol.toFixed(2)} SOL`} tone="good" />
                <Field label="Sell vol" value={`${launch.flow.sellVolumeSol.toFixed(2)} SOL`} tone={launch.flow.sellVolumeSol > 0 ? 'bad' : undefined} />
                <Field label="Sellers" value={String(launch.flow.distinctSellers)} />
              </div>

              <div>
                <div className="font-display text-[10px] uppercase tracking-[0.28em] text-krypt-muted mb-2">Concentration wards</div>
                <div className="grid grid-cols-3 gap-2">
                  <SealGauge label="Top holder" share={launch.flow.topHolderTokenShare} dangerAt={0.25} />
                  <SealGauge label="Bundled supply" share={launch.flow.earlyBuyerShare ?? 0} dangerAt={0.45} />
                  <SealGauge label="Top buyer" share={launch.flow.topBuyerShare} dangerAt={0.4} />
                </div>
              </div>

              {launch.score && (
                <div>
                  <div className="font-display text-[10px] uppercase tracking-[0.28em] text-krypt-muted mb-2">Score breakdown</div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(
                      [
                        ['Safety', launch.score.safety, 20],
                        ['Creator', launch.score.creator, 18],
                        ['Sells', launch.score.sellPressure, 18],
                        ['Timing', launch.score.entryTiming, 12],
                        ['Crowd', launch.score.crowd, 8],
                        ['Concen', launch.score.concentration, 14],
                        ['Meta', launch.score.metadata, 10],
                        ['Penalty', -launch.score.penalties, 0],
                      ] as Array<[string, number, number]>
                    ).map(([label, v, max]) => (
                      <div key={label} className="rounded-md border border-white/10 bg-black/25 px-2 py-1.5">
                        <div className="text-[9px] uppercase tracking-wider text-krypt-muted">{label}</div>
                        <div className={cls('text-xs font-mono font-semibold', v < 0 ? 'text-rose-300' : 'text-white/90')}>
                          {v}{max > 0 && <span className="text-krypt-muted">/{max}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {launch.riskFlags.length > 0 && (
                <div>
                  <div className="font-display text-[10px] uppercase tracking-[0.28em] text-krypt-muted mb-2">Warnings</div>
                  <div className="flex flex-wrap gap-1.5">
                    {launch.riskFlags.map((f) => (
                      <Badge key={f.id} tone={f.hard ? 'danger' : 'warn'}>{f.label}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {launch.reason && (
                <div className="rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2.5 text-xs text-rose-200/90">
                  {launch.reason}
                </div>
              )}

              <div>
                <div className="font-display text-[10px] uppercase tracking-[0.28em] text-krypt-muted mb-2">Creator</div>
                <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2.5 space-y-1.5 text-xs font-mono">
                  <div className="text-white/90 break-all">{launch.creator}</div>
                  <div className="text-krypt-muted">
                    {launch.creatorPriorLaunches} prior launch{launch.creatorPriorLaunches === 1 ? '' : 'es'}
                    {launch.creatorPriorRugs > 0 && <span className="text-rose-300"> · {launch.creatorPriorRugs} dumps</span>}
                    {launch.flow.creatorSold && <span className="text-rose-300"> · CREATOR SOLD</span>}
                  </div>
                  {launch.smartBuyerCount > 0 && (
                    <div className="text-arc-gold">★ {launch.smartBuyerCount} smart buyer{launch.smartBuyerCount === 1 ? '' : 's'}{launch.smartEarly ? ' (early)' : ''}</div>
                  )}
                  <button
                    onClick={() => void onBlacklist(launch)}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 font-sans font-semibold text-rose-200 transition hover:bg-rose-500/20"
                  >
                    <Ban className="h-3 w-3" /> Blacklist creator
                  </button>
                </div>
              </div>

              <div>
                <div className="font-display text-[10px] uppercase tracking-[0.28em] text-krypt-muted mb-2">Mint</div>
                <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2.5 text-xs font-mono text-krypt-muted break-all">
                  {launch.mint}
                </div>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
