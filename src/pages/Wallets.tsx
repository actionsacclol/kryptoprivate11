import { useCallback, useEffect, useState } from 'react';
import { Copy, FlaskConical, Plus, Trash2, TriangleAlert, Zap } from 'lucide-react';
import {
  copySize,
  defaultConfig,
  validateConfig,
  winRate,
  type CopyConfig,
  type CopySnapshot,
} from '@shared/copytrade';
import type { WatchedWallet } from '@shared/types';
import { Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { cls, fmtAgo, shortAddr, toneFor } from '../utils/format';

// Wallet tracking + copy trading (term.txt §9 and §11).
//
// The layout puts the PAPER SCORECARD next to the live switch on purpose.
// Deciding to copy a wallet with real money is the highest-variance choice
// this app offers, and the only useful input to it is the record of what
// following that wallet would actually have done — including the trades the
// filters skipped and the latency you configured.

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.16em] text-krypt-muted/70 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-krypt-muted/50 mt-0.5">{hint}</div>}
    </div>
  );
}

const numBox =
  'w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] font-mono text-white outline-none focus:border-krypt-purple/50';

function ConfigEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string };
  onSave: (c: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState(initial);
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K]): void => setC((p) => ({ ...p, [k]: v }));
  const validity = validateConfig(c);
  const optNum = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));

  return (
    <Card className="space-y-3 border-krypt-purple/25">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Wallet address">
          <input
            value={c.wallet}
            onChange={(e) => set('wallet', e.target.value.trim())}
            spellCheck={false}
            placeholder="7jA…8K"
            className={numBox}
          />
        </Field>
        <Field label="Label">
          <input
            value={c.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Good Pump Trader"
            className={numBox}
          />
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Sizing">
          <div className="flex rounded-md border border-white/10 overflow-hidden">
            {(['fixed', 'proportional'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set('sizing', m)}
                className={cls(
                  'flex-1 px-2 py-1.5 text-[10px] font-semibold transition',
                  c.sizing === m ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                )}
              >
                {m === 'fixed' ? 'Fixed' : '% of theirs'}
              </button>
            ))}
          </div>
        </Field>
        <Field label={c.sizing === 'fixed' ? 'SOL per trade' : '% of their size'}>
          <input type="number" value={c.sizeValue} onChange={(e) => set('sizeValue', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Max per trade" hint="SOL">
          <input type="number" value={c.maxTradeSol} onChange={(e) => set('maxTradeSol', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Delay" hint="ms after their trade">
          <input type="number" value={c.delayMs} onChange={(e) => set('delayMs', Number(e.target.value))} className={numBox} />
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Min liquidity" hint="USD · blank = any">
          <input
            type="number"
            value={c.minLiquidityUsd ?? ''}
            onChange={(e) => set('minLiquidityUsd', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Max market cap" hint="USD · blank = any">
          <input
            type="number"
            value={c.maxMarketCapUsd ?? ''}
            onChange={(e) => set('maxMarketCapUsd', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Min Krypt score" hint="blank = any">
          <input
            type="number"
            value={c.minKryptScore ?? ''}
            onChange={(e) => set('minKryptScore', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Max slippage" hint="%">
          <input type="number" value={c.maxSlippagePct} onChange={(e) => set('maxSlippagePct', Number(e.target.value))} className={numBox} />
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Daily loss limit" hint="SOL">
          <input type="number" value={c.dailyLossLimitSol} onChange={(e) => set('dailyLossLimitSol', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Daily trade limit">
          <input type="number" value={c.dailyTradeLimit} onChange={(e) => set('dailyTradeLimit', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Copy their sells">
          <button
            onClick={() => set('copySells', !c.copySells)}
            className={cls(
              'w-full rounded-md border px-2 py-1.5 text-[10px] font-semibold transition',
              c.copySells ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-krypt-muted',
            )}
          >
            {c.copySells ? 'Yes' : 'No'}
          </button>
        </Field>
        <Field label="Pump.fun only">
          <button
            onClick={() => set('onlyPumpfun', !c.onlyPumpfun)}
            className={cls(
              'w-full rounded-md border px-2 py-1.5 text-[10px] font-semibold transition',
              c.onlyPumpfun ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-krypt-muted',
            )}
          >
            {c.onlyPumpfun ? 'Yes' : 'Any launchpad'}
          </button>
        </Field>
      </div>

      {!validity.ok && <p className="text-[11px] text-rose-300">{validity.message}</p>}

      <div className="flex items-center gap-2">
        <PrimaryButton onClick={() => onSave(c)} disabled={!validity.ok} className="!py-2 !px-4 text-xs">
          Save
        </PrimaryButton>
        <GhostButton onClick={onCancel} className="!py-2 !px-4 text-xs">
          Cancel
        </GhostButton>
        <span className="text-[10px] text-krypt-muted/60 ml-2">
          A trade of 1 SOL by them would copy as{' '}
          <span className="font-mono text-white/80">{copySize(c as CopyConfig, 1).toFixed(3)} SOL</span>.
        </span>
      </div>
    </Card>
  );
}

export function WalletsPage() {
  const toast = useToast();
  const modal = useModal();
  const [snap, setSnap] = useState<CopySnapshot | null>(null);
  const [tracked, setTracked] = useState<WatchedWallet[]>([]);
  const [editing, setEditing] = useState<(Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }) | null>(null);
  const [newAddr, setNewAddr] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = useCallback(async () => {
    const [c, w] = await Promise.all([window.krypt.copy.list(), window.krypt.watchlist.get()]);
    if (c.ok && c.data) setSnap(c.data);
    if (w.ok && w.data) setTracked(w.data);
  }, []);

  useEffect(() => {
    void load();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'copy') setSnap(ev.snapshot);
    });
    // Copy configs arrive by push; only the tracked-wallet list has no event,
    // and it changes on this page's own buttons, so a slow backstop is plenty.
    const id = setInterval(() => {
      void window.krypt.watchlist.get().then((w) => {
        if (w.ok && w.data) setTracked(w.data);
      });
    }, 60_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [load]);

  const addTracked = async (): Promise<void> => {
    const r = await window.krypt.watchlist.add(newAddr.trim(), newLabel.trim());
    if (r.ok) {
      toast.success('Wallet tracked');
      setNewAddr('');
      setNewLabel('');
      void load();
    } else {
      toast.error(r.message);
    }
  };

  const save = async (c: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }): Promise<void> => {
    const r = await window.krypt.copy.save(c as Partial<CopyConfig>);
    if (r.ok) {
      toast.success(r.message);
      setEditing(null);
      if (r.data) setSnap(r.data);
    } else {
      toast.error(r.message);
    }
  };

  const toggle = async (c: CopyConfig): Promise<void> => {
    if (!c.enabled && c.mode === 'live') {
      const yes = await modal.confirm({
        title: 'Arm LIVE copy trading',
        message:
          `Every buy by ${c.label || shortAddr(c.wallet)} will spend real SOL, up to ${c.maxTradeSol} per trade, ` +
          `until you hit your ${c.dailyLossLimitSol} SOL daily loss limit. Six months of research in this repo ` +
          `failed to find a profitable automated memecoin strategy — run it on paper first if you have not.`,
        confirmLabel: 'Arm live copying',
        destructive: true,
      });
      if (!yes) return;
    }
    await save({ ...c, enabled: !c.enabled });
  };

  const setMode = async (c: CopyConfig, mode: 'paper' | 'live'): Promise<void> => {
    // Switching to live always disarms first — the user then has to arm it
    // deliberately, having seen the confirmation.
    await save({ ...c, mode, enabled: mode === 'live' ? false : c.enabled });
  };

  const remove = async (id: string): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Stop following',
      message: 'Remove this config and its paper record?',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.remove(id);
    if (r.ok && r.data) setSnap(r.data);
  };

  return (
    <Page
      title="Copy Trading"
      subtitle="Track other traders' wallets, and follow them on paper before you follow them with money. Your own keys live under Wallet."
      actions={
        <PrimaryButton
          onClick={() => setEditing(defaultConfig('', ''))}
          className="!py-2 !px-3 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          Follow a wallet
        </PrimaryButton>
      }
    >
      {editing && (
        <Section title={editing.id ? 'Edit config' : 'New copy config'}>
          <ConfigEditor initial={editing} onSave={(c) => void save(c)} onCancel={() => setEditing(null)} />
        </Section>
      )}

      <Section
        title="Followed wallets"
        description="Paper mode simulates the fills — including your configured delay and the 1%/side protocol fee — so the record is one a real execution could have produced."
      >
        {snap && snap.configs.length > 0 ? (
          <div className="space-y-2">
            {snap.configs.map((c) => {
              const st = snap.stats[c.id];
              const wr = st ? winRate(st) : null;
              return (
                <Card key={c.id} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={cls(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                        c.mode === 'paper'
                          ? 'border-white/15 bg-white/5 text-krypt-muted'
                          : 'border-rose-400/40 bg-rose-500/15 text-rose-300',
                      )}
                    >
                      {c.mode === 'paper' ? <FlaskConical className="h-2.5 w-2.5" /> : <Zap className="h-2.5 w-2.5" />}
                      {c.mode}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-white truncate">
                        {c.label || shortAddr(c.wallet, 6)}
                      </div>
                      <div className="text-[10px] font-mono text-krypt-muted">{shortAddr(c.wallet, 6)}</div>
                    </div>

                    <div className="flex-1" />

                    <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                      {(['paper', 'live'] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => void setMode(c, m)}
                          className={cls(
                            'px-2.5 py-1 text-[10px] font-semibold transition',
                            c.mode === m
                              ? m === 'live'
                                ? 'bg-rose-500/25 text-rose-200'
                                : 'bg-white/10 text-white'
                              : 'text-krypt-muted hover:text-white',
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => void toggle(c)}
                      className={cls(
                        'rounded-md border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition',
                        c.enabled
                          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                          : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                      )}
                    >
                      {c.enabled ? 'Following' : 'Paused'}
                    </button>

                    <GhostButton onClick={() => setEditing(c)} className="!py-1.5 !px-2.5 text-[11px]">
                      Edit
                    </GhostButton>
                    <button
                      onClick={() => void remove(c.id)}
                      className="text-krypt-muted/60 hover:text-rose-300 transition"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Scorecard */}
                  {st && (
                    <div className="grid grid-cols-3 md:grid-cols-7 gap-3 pt-2 border-t border-white/8">
                      {[
                        ['Copies', String(st.trades)],
                        ['Open', String(st.openCount)],
                        ['Win rate', wr === null ? '—' : `${wr.toFixed(0)}%`],
                        ['W / L', `${st.wins}/${st.losses}`],
                        ['Realized', st.wins + st.losses === 0 ? '—' : `${st.realizedPnlSol >= 0 ? '+' : ''}${st.realizedPnlSol.toFixed(3)}`],
                        ['Filtered out', String(st.skipped)],
                        ['Limit-blocked', String(st.blocked)],
                      ].map(([label, value], i) => (
                        <div key={label}>
                          <div className="text-[9px] uppercase tracking-[0.14em] text-krypt-muted/60">{label}</div>
                          <div
                            className={cls(
                              'text-[13px] font-mono font-semibold mt-0.5',
                              i === 4 && st.wins + st.losses > 0 ? toneFor(st.realizedPnlSol) : 'text-white',
                            )}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* How the wallet is being watched. Every followed wallet
                      has its own subscription on the live socket, on any DEX;
                      this line is what turns silence into an explanation. */}
                  {c.enabled && (() => {
                    const w = snap?.watch?.[c.wallet];
                    if (!w) return null;
                    if (w.state === 'over-cap') {
                      return (
                        <p className="text-[10px] text-arc-gold/90">
                          Not watched: the free public socket allows 10 followed wallets. Add a Helius key in Settings to
                          follow more.
                        </p>
                      );
                    }
                    if (w.state === 'off') {
                      return <p className="text-[10px] text-rose-300/80">Not watched — no websocket endpoint is configured.</p>;
                    }
                    if (w.state === 'connecting') {
                      return <p className="text-[10px] text-krypt-muted/60">Connecting to the live socket…</p>;
                    }
                    return (
                      <p className="text-[10px] text-krypt-muted/60">
                        Watching on the live socket, any DEX · {w.seen} transaction{w.seen === 1 ? '' : 's'} seen
                        {w.lastSeenAt ? `, last ${fmtAgo(w.lastSeenAt)} ago` : ' so far'} · {w.swaps} swap{w.swaps === 1 ? '' : 's'}
                        {w.lastSwapAt ? ` (last ${fmtAgo(w.lastSwapAt)} ago)` : ''}
                      </p>
                    );
                  })()}
                  {st && st.trades === 0 && c.enabled && (
                    <p className="text-[10px] text-krypt-muted/60">
                      Nothing copied yet. Every trade this wallet signs is read from the live socket, whatever DEX it
                      used; buys that pass your filters appear here, and skipped ones say why.
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty
            title="Not following anyone"
            message="Add a wallet to paper-trade it. The app records what following it would have done, filters and latency included, so you can decide with evidence."
          />
        )}

        {snap && !snap.liveExecutable && snap.configs.some((c) => c.mode === 'live' && c.enabled) && (
          <div className="mt-3 rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2 flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 text-arc-gold flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-arc-gold/90">
              Live copying is armed but cannot execute — {snap.liveBlockedReason}.
            </p>
          </div>
        )}
      </Section>

      {/* Recent copies */}
      {snap && snap.recent.length > 0 && (
        <Section title="Recent copies" description="Including the ones your filters rejected — a scorecard that hides the skips is measuring the wrong thing.">
          <div className="space-y-1">
            {snap.recent.slice(0, 30).map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-md px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.04] transition"
              >
                <span className="text-krypt-muted/60 w-14">{fmtAgo(t.at)}</span>
                <span className={cls('w-16 font-bold', t.state === 'skipped' ? 'text-krypt-muted/50' : t.state === 'open' ? 'text-krypt-pink' : 'text-white/80')}>
                  {t.kind === 'exit' ? (t.state === 'skipped' ? 'no sell' : 'sold') : t.state}
                </span>
                <span className="w-24 truncate text-white/85">{t.symbol || shortAddr(t.mint, 4)}</span>
                <span className="w-24 text-krypt-muted">they {t.theirSol.toFixed(2)}</span>
                <span className="w-24 text-white/85">us {t.ourSol.toFixed(3)}</span>
                <span className={cls('w-20 text-right', toneFor(t.pnlSol ?? t.realizedSol ?? null))}>
                  {(() => {
                    const v = t.pnlSol ?? t.realizedSol ?? null;
                    return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
                  })()}
                </span>
                <span className="flex-1 text-krypt-muted/55 truncate text-right">
                  {t.reason ??
                    (t.kind === 'exit'
                      ? `sold ${t.soldPct ?? 100}% with them${t.signature ? '' : t.mode === 'live' ? '' : ' (paper)'}`
                      : t.state === 'open' && t.remainingPct !== undefined && t.remainingPct < 100
                        ? `${Math.round(t.remainingPct)}% still held`
                        : '')}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tracker */}
      <Section
        title="Tracked wallets"
        description="Labelled wallets show up on token pages, in the trade tape, and can raise alerts. Tracking alone never trades."
      >
        <Card className="space-y-3">
          <div className="flex gap-2">
            <input
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              placeholder="Wallet address"
              spellCheck={false}
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white outline-none focus:border-krypt-purple/50"
            />
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label"
              className="w-48 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/50"
            />
            <GhostButton onClick={() => void addTracked()} disabled={newAddr.trim().length < 32}>
              Track
            </GhostButton>
          </div>

          {tracked.length === 0 ? (
            <p className="text-[11px] text-krypt-muted/60">No tracked wallets yet.</p>
          ) : (
            <div className="space-y-1">
              {tracked.map((w) => (
                <div key={w.address} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.04] transition">
                  <span className="text-[12px] text-arc-gold w-40 truncate">{w.label || '—'}</span>
                  <button
                    onClick={() => void window.krypt.app.openExternal(`https://solscan.io/account/${w.address}`)}
                    className="font-mono text-[11px] text-white/80 hover:text-krypt-purple"
                  >
                    {shortAddr(w.address, 6)}
                  </button>
                  <div className="flex-1" />
                  <GhostButton
                    onClick={() => setEditing({ ...defaultConfig(w.address, w.label) })}
                    className="!py-1 !px-2 text-[10px]"
                  >
                    <Copy className="h-3 w-3" />
                    Paper-copy
                  </GhostButton>
                  <button
                    onClick={() => {
                      void window.krypt.watchlist.remove(w.address).then(() => load());
                    }}
                    className="text-krypt-muted/60 hover:text-rose-300 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    </Page>
  );
}
