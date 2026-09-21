import { useCallback, useEffect, useState } from 'react';
import { EVM_CHAIN_META, nativeSymbolOf, type ChainKind } from '@shared/evm';
import { ArrowRight, FlaskConical, Pause, Play, Trash2, Zap } from 'lucide-react';
import {
  SIMPLE_MAX_SOL,
  SIMPLE_SIZES,
  chainForAddress,
  chainOf,
  directionOf,
  simpleConfig,
  validateConfig,
  winRate,
  type CopyConfig,
  type CopySnapshot,
} from '@shared/copytrade';
import { Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useModal } from '../state/ModalProvider';
import { cls, shortAddr, toneFor } from '../utils/format';

// Copy Simple (2026-09-20). The user asked for "a really easy way to copy"
// beside the full page: three answers — whose wallet, how much per trade,
// which chain when the address does not say — and one button, "Follow on
// paper". Every other setting is derived (shared/copytrade.ts simpleConfig)
// and the same store, the same `copy:save` handler and the same engine do
// the work, so a follow made here is the same config Copy Trading shows,
// where every control is.
//
// Paper first is not a preference here, it is the only first button: the
// research in this repo says following leaders loses money on average, so
// the simple path ends at the paper record, and Live is a switch on the
// card that runs the same arm confirmation as the full page.

const box =
  'w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-note font-mono text-white outline-none focus:border-krypt-purple/50';

const chainName = (c: ChainKind): string => (c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name);

export function CopySimplePage({ onOpenAdvanced, onOpenScout }: { onOpenAdvanced: () => void; onOpenScout: () => void }) {
  const toast = useToast();
  const modal = useModal();
  const { chain: termChain } = useTerminal();
  const [snap, setSnap] = useState<CopySnapshot | null>(null);
  const [addr, setAddr] = useState('');
  const [label, setLabel] = useState('');
  const [size, setSize] = useState<number>(SIMPLE_SIZES[1]);
  const [custom, setCustom] = useState('');
  const [evmChain, setEvmChain] = useState<'robinhood' | 'bnb'>(termChain === 'bnb' ? 'bnb' : 'robinhood');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await window.krypt.copy.list();
    if (r.ok && r.data) setSnap(r.data);
  }, []);
  useEffect(() => {
    void load();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'copy') setSnap(ev.snapshot);
    });
    return off;
  }, [load]);

  const kind = chainForAddress(addr);
  const chain: ChainKind = kind === 'evm' ? evmChain : 'solana';
  const sym = nativeSymbolOf(chain);
  const cfg = simpleConfig(addr, label, chain, size);
  const validity = kind === null ? { ok: false, message: addr.trim() ? 'That is not a Solana or 0x wallet address' : 'Paste a wallet address' } : validateConfig(cfg);

  const follow = async (): Promise<void> => {
    if (!validity.ok) return;
    setBusy(true);
    try {
      const r = await window.krypt.copy.save(cfg as Partial<CopyConfig>);
      if (r.ok) {
        toast.success(`Following ${label.trim() || shortAddr(addr.trim(), 6)} on paper`);
        setAddr('');
        setLabel('');
        setCustom('');
        if (r.data) setSnap(r.data);
      } else toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (c: CopyConfig): Promise<void> => {
    const r = await window.krypt.copy.save(c as Partial<CopyConfig>);
    if (r.ok) {
      if (r.data) setSnap(r.data);
    } else toast.error(r.message);
  };

  // The same arm confirmation as Copy Trading, word for word where it matters.
  const toggle = async (c: CopyConfig): Promise<void> => {
    if (!c.enabled && c.mode === 'live') {
      const yes = await modal.confirm({
        title: 'Arm LIVE copy trading',
        message:
          `Every ${directionOf(c) === 'reverse' ? 'SELL' : 'buy'} by ${c.label || shortAddr(c.wallet)} will spend real ${nativeSymbolOf(chainOf(c))} on ${chainName(chainOf(c))}, up to ${c.maxTradeSol} per trade, ` +
          `until you hit your ${c.dailyLossLimitSol} ${nativeSymbolOf(chainOf(c))} daily loss limit. ` +
          `Six months of research in this repo failed to find a profitable automated memecoin strategy — run it on paper first if you have not.`,
        confirmLabel: 'Arm live copying',
        destructive: true,
      });
      if (!yes) return;
    }
    await save({ ...c, enabled: !c.enabled });
  };

  const setMode = async (c: CopyConfig, mode: 'paper' | 'live'): Promise<void> => {
    // Switching to live always disarms first — the user then arms it
    // deliberately, having seen the confirmation.
    await save({ ...c, mode, enabled: mode === 'live' ? false : c.enabled });
  };

  const remove = async (c: CopyConfig): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Stop following',
      message: `Remove ${c.label || shortAddr(c.wallet, 6)} and its paper record?`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.remove(c.id);
    if (r.ok && r.data) setSnap(r.data);
  };

  const pickSize = (v: number): void => {
    setSize(v);
    setCustom('');
  };
  const onCustom = (raw: string): void => {
    setCustom(raw);
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && n > 0) setSize(n);
  };

  return (
    <Page
      title="Copy Simple"
      subtitle="Paste a trader's wallet, pick how much per trade, follow on paper. Everything else is set for you."
      actions={
        <GhostButton onClick={onOpenAdvanced} className="!py-2 !px-3 text-xs">
          Every control
          <ArrowRight className="h-3.5 w-3.5" />
        </GhostButton>
      }
    >
      <Card className="space-y-4 border-krypt-purple/25">
        <div>
          <div className="text-label uppercase tracking-label text-krypt-muted">Whose wallet</div>
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value.trim())}
            spellCheck={false}
            placeholder="Paste a Solana or 0x wallet address"
            className={cls(box, 'mt-1')}
            data-testid="copysimple-address"
          />
          <div className="mt-1 text-micro text-krypt-muted/60">
            {kind === 'solana' ? 'Solana wallet' : kind === 'evm' ? 'An EVM wallet — which chain do they trade on?' : 'Not sure who to follow?'}{' '}
            {kind === null && (
              <button onClick={onOpenScout} className="text-krypt-purple hover:underline">
                The Wallet Scout ranks wallets by Copy score.
              </button>
            )}
          </div>
          {kind === 'evm' && (
            <div className="mt-2 flex rounded-md border border-white/10 overflow-hidden w-fit">
              {(['robinhood', 'bnb'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setEvmChain(c)}
                  className={cls('px-3 py-1.5 text-body font-semibold transition', evmChain === c ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
                >
                  {EVM_CHAIN_META[c].name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-label uppercase tracking-label text-krypt-muted">Name (optional)</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Whale 1" className={cls(box, 'mt-1')} />
          </div>
          <div>
            <div className="text-label uppercase tracking-label text-krypt-muted">{sym} per trade</div>
            <div className="mt-1 flex items-center gap-1.5">
              {SIMPLE_SIZES.map((v) => (
                <button
                  key={v}
                  onClick={() => pickSize(v)}
                  className={cls(
                    'rounded-md border px-2.5 py-1.5 text-body font-mono font-semibold transition',
                    size === v && custom === '' ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                  )}
                >
                  {v}
                </button>
              ))}
              <input type="number" value={custom} onChange={(e) => onCustom(e.target.value)} placeholder="other" className={cls(box, 'w-20 px-2 py-1.5')} />
            </div>
          </div>
        </div>

        <p className="text-label leading-relaxed text-krypt-muted">
          The app will spend {cfg.sizeValue} {sym} each time they buy, mirror their sells, and stop for the day after losing {cfg.dailyLossLimitSol}{' '}
          {sym}. On paper it simulates every trade with the fees included, so the record is what following them would have cost or made. Nothing is
          spent until you switch a card below to Live. Most wallets lose money to follow; the record shows you before you pay.
        </p>

        {!validity.ok && addr.trim() !== '' && <p className="text-body text-rose-300">{validity.message}</p>}
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={() => void follow()} disabled={!validity.ok || busy} className="!py-2 !px-4">
            <FlaskConical className="h-3.5 w-3.5" />
            Follow on paper
          </PrimaryButton>
          <span className="text-micro text-krypt-muted/60">Up to {SIMPLE_MAX_SOL} {sym} per trade here; higher amounts need the full page.</span>
        </div>
      </Card>

      <Section title="Your follows" description="Paper and live records, per wallet. Switch a card to Live only after its paper record earned it.">
        {snap && snap.configs.length > 0 ? (
          <div className="space-y-2">
            {snap.configs.map((c) => {
              const st = snap.stats[c.id];
              const wr = st ? winRate(st) : null;
              const dir = directionOf(c);
              return (
                <Card key={c.id} className="flex flex-wrap items-center gap-3">
                  <span
                    className={cls(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider',
                      c.mode === 'paper' ? 'border-white/15 bg-white/5 text-krypt-muted' : 'border-rose-400/40 bg-rose-500/15 text-rose-300',
                    )}
                  >
                    {c.mode === 'paper' ? <FlaskConical className="h-2.5 w-2.5" /> : <Zap className="h-2.5 w-2.5" />}
                    {c.mode}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-value font-semibold text-white truncate">
                      {c.label || (dir === 'fomo' ? 'Crowd' : shortAddr(c.wallet, 6))}
                      {dir !== 'copy' && <span className="ml-2 text-micro uppercase tracking-wider text-amber-300">{dir}</span>}
                    </div>
                    <div className="text-label text-krypt-muted">
                      {chainName(chainOf(c))} · {c.sizing === 'fixed' ? `${c.sizeValue} ${nativeSymbolOf(chainOf(c))} per trade` : `${c.sizeValue}% of their size`} ·{' '}
                      {c.enabled ? 'following' : 'paused'}
                    </div>
                  </div>
                  <div className="text-right">
                    {st && st.trades > 0 ? (
                      <>
                        <div className={cls('text-value font-mono font-semibold', toneFor(st.realizedPnlSol))}>
                          {st.realizedPnlSol >= 0 ? '+' : ''}
                          {st.realizedPnlSol.toFixed(4)} {nativeSymbolOf(chainOf(c))}
                        </div>
                        <div className="text-micro text-krypt-muted/70">
                          {st.trades} trade{st.trades === 1 ? '' : 's'}
                          {wr !== null ? ` · ${Math.round(wr * 100)}% won` : ''}
                          {st.openCount > 0 ? ` · ${st.openCount} open` : ''}
                        </div>
                      </>
                    ) : (
                      <div className="text-label text-krypt-muted/60">No trades yet</div>
                    )}
                  </div>
                  <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                    {(['paper', 'live'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => void setMode(c, m)}
                        className={cls(
                          'px-2.5 py-1 text-label font-semibold transition',
                          c.mode === m ? (m === 'live' ? 'bg-rose-500/25 text-rose-200' : 'bg-white/10 text-white') : 'text-krypt-muted hover:text-white',
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => void toggle(c)}
                    className={cls(
                      'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-body font-bold uppercase tracking-wider transition',
                      c.enabled ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300' : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                    )}
                  >
                    {c.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    {c.enabled ? 'Following' : 'Paused'}
                  </button>
                  <GhostButton onClick={onOpenAdvanced} className="!py-1.5 !px-2.5 text-xs">
                    Edit
                  </GhostButton>
                  <button onClick={() => void remove(c)} className="rounded-md p-1.5 text-krypt-muted hover:text-rose-300" title="Stop following">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty title="Nobody followed yet" message="Paste a wallet above. Following starts on paper, so there is nothing to lose by trying one." />
        )}
      </Section>
    </Page>
  );
}
