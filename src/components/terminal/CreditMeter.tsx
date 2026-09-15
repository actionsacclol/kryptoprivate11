import { useCallback, useEffect, useState } from 'react';
import { firehoseHoursFor, hoursRemaining, usedPct, type CreditUsage } from '@shared/credits';
import { cls } from '../../utils/format';

// Helius credit usage, counted rather than estimated.
//
// This panel exists because the estimate it replaces was wrong by a factor of
// twenty — a comment put the pump firehose at 33k pushes/hour when the
// measured rate was 780,000. An estimate that wrong makes an expensive switch
// look affordable, so the number is now counted and shown, and the app turns
// the socket off by itself at the ceiling.

export function CreditMeter({ limit, onLimit }: { limit: number; onLimit: (v: number) => void }) {
  const [usage, setUsage] = useState<CreditUsage | null>(null);
  const [draft, setDraft] = useState(String(limit));

  const refresh = useCallback(async () => {
    const r = await window.krypt.rpc.credits();
    if (r.ok && r.data) setUsage(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => setDraft(String(limit)), [limit]);

  const pct = usage ? usedPct(usage) : null;
  const left = usage ? hoursRemaining(usage, Date.now()) : null;
  const tone = pct === null ? 'text-krypt-muted' : pct > 90 ? 'text-rose-400' : pct > 60 ? 'text-arc-gold' : 'text-emerald-400';

  return (
    <div className="mb-2 rounded-md border border-white/10 bg-black/25 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-label uppercase tracking-label text-krypt-muted">Credits this month</span>
        <span className={cls('font-mono text-note', tone)}>
          {usage ? usage.used.toLocaleString() : '—'}
          {limit > 0 && <span className="text-krypt-muted"> / {limit.toLocaleString()}</span>}
        </span>
        {pct !== null && <span className="font-mono text-label text-krypt-muted">{pct.toFixed(1)}%</span>}
        {left !== null && (
          <span className="text-label text-krypt-muted">≈ {left < 1 ? `${Math.round(left * 60)} min` : `${left.toFixed(1)} h`} left at this rate</span>
        )}
      </div>

      {limit > 0 && (
        <div className="mt-1.5 h-1 rounded-full bg-white/8 overflow-hidden">
          <div
            className={cls('h-full rounded-full', pct !== null && pct > 90 ? 'bg-rose-400' : pct !== null && pct > 60 ? 'bg-arc-gold' : 'bg-emerald-400')}
            style={{ width: `${Math.min(100, pct ?? 0)}%` }}
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-label text-krypt-muted">Monthly ceiling</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => onLimit(Math.max(0, Number(draft) || 0))}
          className="w-28 rounded bg-black/40 border border-white/15 px-2 py-0.5 font-mono text-body text-white outline-none"
        />
        <span className="text-label text-krypt-muted/70">0 = no guard</span>
        <button
          onClick={async () => {
            await window.krypt.rpc.resetCredits();
            void refresh();
          }}
          className="rounded border border-white/10 px-1.5 py-0.5 text-label text-krypt-muted hover:text-white"
        >
          Reset counter
        </button>
      </div>

      {limit > 0 && (
        <p className="mt-1.5 text-label leading-relaxed text-krypt-muted/60">
          At the measured firehose rate (~780,000 pushes/hour, sampled 2026-08-24) this ceiling covers about{' '}
          <span className="text-white/80">{firehoseHoursFor(limit).toFixed(1)} hours</span> of feed-socket runtime. The
          socket switches itself off when the ceiling is reached.
        </p>
      )}
    </div>
  );
}
