// The Runners page for an EVM chain: the launches this chain's Observatory
// flagged — the ones whose first-minute buyer bucket clears every other
// launch's graduation rate, on this chain's own record.
//
// Until 2026-09-11 the Runners page showed Solana flags whatever chain was
// active, and Robinhood's flags lived only on the Observatory table. Same
// rule as the Solana page: a flag is what happened to launches like this,
// never a verdict, and nothing is bought for you.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { EVM_CHAIN_META, type ChainKind, type EvmChainKind } from '@shared/evm';
import type { EvmScanLaunch, EvmScanStatus } from '@shared/evmScan';
import { Card, Empty, IconButton, Section } from '../common';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export function EvmRunnersSection({ chain, onOpenToken }: { chain: EvmChainKind; onOpenToken: (address: string, chain: ChainKind) => void }) {
  const meta = EVM_CHAIN_META[chain];
  const toast = useToast();
  const [launches, setLaunches] = useState<EvmScanLaunch[] | null>(null);
  const [status, setStatus] = useState<EvmScanStatus | null>(null);
  const [armed, setArmed] = useState(false);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [size, setSize] = useState('0.005');
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const [l, s, st, h] = await Promise.all([
      window.krypt.evm.scan.launches(chain),
      window.krypt.evm.scan.status(chain),
      window.krypt.evm.state(chain),
      window.krypt.evm.holdings(chain),
    ]);
    if (l.ok && l.data) setLaunches(l.data);
    if (s.ok && s.data) setStatus(s.data);
    if (st.ok && st.data) setArmed(st.data.live.armed);
    if (h.ok && h.data) setHeld(new Set(h.data.filter((x) => x.amount > 0).map((x) => x.token.toLowerCase())));
  }, [chain]);

  useEffect(() => {
    setLaunches(null);
    void load();
    const id = setInterval(() => {
      void load();
      setTick((t) => t + 1);
    }, 10_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmScan' && ev.status.chain === chain) void load();
      if (ev.kind === 'evmFill' && ev.fill.chain === chain) void load();
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [chain, load]);

  // Flagged first, newest first; the rest of the measured launches are a
  // count, not a list — a page called Runners lists runners.
  const flagged = useMemo(() => (launches ?? []).filter((l) => l.call?.flag).sort((a, b) => b.seenAt - a.seenAt), [launches, tick]);
  const judged = useMemo(() => (launches ?? []).filter((l) => l.call).length, [launches]);

  const quickBuy = async (l: EvmScanLaunch) => {
    const amount = Number(size);
    if (!(amount > 0)) return toast.error('Pick a size first');
    setBusy(l.token);
    try {
      const r = await window.krypt.evm.buy(chain, l.token, amount, !armed);
      (r.ok ? toast.success : toast.error)(r.message);
      void load();
    } finally {
      setBusy(null);
    }
  };
  const quickSell = async (l: EvmScanLaunch) => {
    setBusy(l.token);
    try {
      const r = await window.krypt.evm.sell(chain, l.token, 100, !armed);
      (r.ok ? toast.success : toast.error)(r.message);
      void load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={`${meta.name} runners`}
      description={`Every launch the ${meta.name} Observatory sees is judged at +60 s against this chain's own record: which first-minute buyer bucket it landed in, and how often launches in that bucket have graduated here. The ones whose bucket clears every other launch's rate — with room to spare, not on a handful of graduations — land here, newest first. Most still do not graduate. ${armed ? 'Buy and Sell act the moment you click them, at the size beside the refresh button.' : `${meta.name} is in Paper: Buy and Sell simulate.`} Nothing is ever bought for you.`}
      actions={
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-krypt-muted">
            size
            <input
              type="text"
              inputMode="decimal"
              value={size}
              onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setSize(e.target.value)}
              className="w-16 rounded-md border border-white/15 bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
            />
            {meta.nativeSymbol}
          </label>
          <IconButton onClick={() => void load()} title="Re-read the Observatory">
            <RefreshCw className="h-4 w-4" />
          </IconButton>
        </div>
      }
    >
      {status && !status.running && (
        <div className="mb-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          The {meta.name} scanner is stopped, so nothing new is being judged. Start it from the Observatory or the automation bar.
        </div>
      )}
      <Card>
        {launches === null ? (
          <div className="px-3 py-6 text-center text-[12px] text-krypt-muted">Reading the Observatory…</div>
        ) : flagged.length === 0 ? (
          <Empty
            title={`No ${meta.name} runners right now`}
            message={
              judged
                ? `${judged} launch${judged === 1 ? '' : 'es'} judged in the last while; none of them landed in a bucket that beats this chain's record. The Observatory shows every one.`
                : `The scanner has not judged a launch yet — a flag needs a bucket with at least 100 settled launches behind it, and this chain's record is still filling.`
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-krypt-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Token</th>
                  <th className="px-3 py-2 text-right font-medium">Age</th>
                  <th className="px-3 py-2 text-right font-medium">Buyers 60s</th>
                  <th className="px-3 py-2 text-left font-medium">Graduated, launches like this</th>
                  <th className="px-3 py-2 text-right font-medium">Curve</th>
                  <th className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((l) => {
                  const w60 = l.windows.find((w) => w.windowS === 60);
                  const call = l.call!;
                  const isHeld = held.has(l.token.toLowerCase());
                  return (
                    <tr key={l.token} className="border-t border-white/5">
                      <td className="px-3 py-1.5">
                        <button onClick={() => onOpenToken(l.token, chain)} className="font-medium text-white/90 hover:text-white">
                          {l.symbol || `${l.token.slice(0, 8)}…`}
                        </button>
                        {l.graduatedAt !== null && (
                          <span className="ml-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 text-[9px] text-emerald-300">graduated</span>
                        )}
                        <a
                          href={`${meta.explorer}/token/${l.token}`}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-2 inline-flex align-middle text-krypt-muted/60 hover:text-white"
                          title="Open on the explorer"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{ago(l.seenAt)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{w60 ? w60.uniqueBuyers : '—'}</td>
                      <td className="px-3 py-1.5" title={call.detail}>
                        <span className="rounded-full border border-arc-gold/40 bg-arc-gold/10 px-1.5 py-0.5 text-[10px] text-arc-gold">
                          {call.ratePct?.toFixed(1)}% of {call.samples}
                        </span>
                        <span className="ml-1.5 text-[10px] text-krypt-muted">
                          vs {(call.otherRatePct ?? call.baseRatePct)?.toFixed(1)}% for every other launch
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{w60 && w60.curvePct !== null ? `${w60.curvePct.toFixed(0)}%` : '—'}</td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => void quickBuy(l)}
                            disabled={busy !== null}
                            className={cls('rounded-md border px-2 py-0.5 text-[10px] transition disabled:opacity-40', armed ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20' : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10')}
                            title={armed ? `Buy ${size} ${meta.nativeSymbol} now` : 'Paper — simulates the buy'}
                          >
                            {busy === l.token ? '…' : 'Buy'}
                          </button>
                          {isHeld && (
                            <button
                              onClick={() => void quickSell(l)}
                              disabled={busy !== null}
                              className="rounded-md border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-40"
                              title="Sell everything you hold of it"
                            >
                              Sell
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Section>
  );
}
