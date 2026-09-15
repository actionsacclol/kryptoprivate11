import { useCallback, useEffect, useState } from 'react';
import { Layers, Loader2, Plus, Trash2, Users, Zap } from 'lucide-react';
import type { WalletGroupView, WalletSummary } from '@shared/types';
import { Card, GhostButton, PrimaryButton, Section } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { cls } from '../../utils/format';

// Fan-out: several wallets buy the same token at once.
//
// Two independent things live here because they belong together in the user's
// head: MANAGING groups, and FIRING a fan-out buy. Sizing is the user's choice
// per buy — "same amount each" or "a total split across the group", the latter
// optionally randomised so the buys are not identical round numbers.
//
// Every buy still runs the full per-wallet pipeline in the engine (sign,
// simulate, loss-guard, fee, interlock). This panel only gathers intent.

function GroupEditor({
  group,
  wallets,
  onToggle,
  onRename,
  onDelete,
}: {
  group: WalletGroupView;
  wallets: WalletSummary[];
  onToggle: (walletId: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(group.name);
  const memberIds = new Set(group.members.map((m) => m.id));
  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== group.name && onRename(name.trim())}
          className="flex-1 min-w-0 rounded bg-black/40 border border-white/15 px-2 py-1 text-note font-semibold text-white outline-none focus:border-krypt-purple/60"
        />
        <span className="text-label text-krypt-muted">{group.members.length} wallet(s)</span>
        <GhostButton destructive onClick={onDelete} className="!px-2 !py-1">
          <Trash2 className="h-3.5 w-3.5" />
        </GhostButton>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {wallets.map((w) => {
          const on = memberIds.has(w.id);
          return (
            <button
              key={w.id}
              onClick={() => onToggle(w.id)}
              className={cls(
                'rounded-md border px-2 py-1 text-label font-medium transition',
                on
                  ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white'
                  : 'border-white/10 bg-black/25 text-krypt-muted hover:text-white',
              )}
            >
              {w.label}
            </button>
          );
        })}
        {wallets.length === 0 && <span className="text-label text-krypt-muted">Add wallets first.</span>}
      </div>
    </Card>
  );
}

export function FanoutPanel({ wallets, armed }: { wallets: WalletSummary[]; armed: boolean }) {
  const toast = useToast();
  const modal = useModal();
  const [groups, setGroups] = useState<WalletGroupView[]>([]);
  const [newGroup, setNewGroup] = useState('');

  // Fan-out buy form
  const [mint, setMint] = useState('');
  const [targetGroup, setTargetGroup] = useState<string>(''); // group id, or '' = ad-hoc
  const [adhoc, setAdhoc] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'same' | 'total'>('same');
  const [amount, setAmount] = useState('0.05');
  const [jitter, setJitter] = useState(30); // percent, total mode only
  const [stagger, setStagger] = useState(true);
  const [busy, setBusy] = useState(false);
  // The engine caps the fan-out TOTAL at the per-trade cap; checked here so
  // the "REAL SOL" confirm is never followed by a refusal.
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    void window.krypt.settings.get().then((r) => {
      if (r.ok && r.data) setCap(r.data.execution.maxLiveSol);
    });
  }, []);

  const loadGroups = useCallback(async () => {
    const r = await window.krypt.wallet.groups();
    if (r.ok && r.data) setGroups(r.data);
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const apply = (r: { ok: boolean; message: string; data?: WalletGroupView[] }): void => {
    if (r.ok && r.data) setGroups(r.data);
    else if (!r.ok) toast.error(r.message);
  };

  const createGroup = async (): Promise<void> => {
    const n = newGroup.trim();
    if (!n) return;
    apply(await window.krypt.wallet.createGroup(n));
    setNewGroup('');
  };

  const toggleMember = async (groupId: string, walletId: string): Promise<void> => {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    const ids = new Set(g.members.map((m) => m.id));
    ids.has(walletId) ? ids.delete(walletId) : ids.add(walletId);
    apply(await window.krypt.wallet.setGroupMembers(groupId, [...ids]));
  };

  // The wallet ids the current buy will fan out to.
  const targetIds = (): string[] => {
    if (targetGroup) return groups.find((g) => g.id === targetGroup)?.members.map((m) => m.id) ?? [];
    return [...adhoc];
  };

  const fanoutBuy = async (): Promise<void> => {
    const ids = targetIds();
    if (mint.trim().length < 32) return toast.error('Enter a valid token mint');
    if (ids.length === 0) return toast.error('Pick a group or select wallets');
    const amt = Number(amount);
    if (!(amt > 0)) return toast.error('Amount must be positive');

    const total = mode === 'same' ? amt * ids.length : amt;
    if (cap !== null && total > cap) {
      toast.error(`Fan-out total ${total.toFixed(3)} SOL is above your ${cap} SOL per-trade cap — lower the amount, or raise the cap on the Wallet page.`);
      return;
    }
    const totalNote =
      mode === 'same' ? `${amt} SOL × ${ids.length} = ${(amt * ids.length).toFixed(4)} SOL total` : `${amt} SOL split across ${ids.length}`;
    const yes = await modal.confirm({
      title: 'Fan-out buy',
      message: `${ids.length} wallet(s) will buy this token with REAL SOL — ${totalNote}. This cannot be undone.`,
      confirmLabel: 'Buy from all',
      destructive: true,
    });
    if (!yes) return;

    setBusy(true);
    const r = await window.krypt.live.fanoutBuy(
      mint.trim(),
      ids,
      { mode, amountSol: amt, jitter: mode === 'total' ? jitter / 100 : 0 },
      { staggerMaxMs: stagger ? 600 : 0 },
    );
    setBusy(false);
    if (r.ok && r.data) {
      const landed = r.data.results.filter((x) => x.ok).length;
      toast[landed === r.data.results.length ? 'success' : 'warn'](`${landed}/${r.data.results.length} buys landed`);
    } else {
      toast.error(r.message);
    }
  };

  return (
    <>
      <Section
        title="Wallet groups"
        description="Name a set of wallets so a fan-out buy can hit them all at once."
      >
        <Card className="flex items-center gap-2">
          <input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createGroup()}
            placeholder="New group name"
            maxLength={32}
            className="flex-1 rounded bg-black/40 border border-white/15 px-2 py-1.5 text-note text-white outline-none focus:border-krypt-purple/60"
          />
          <PrimaryButton onClick={() => void createGroup()} disabled={!newGroup.trim()} className="!py-1.5">
            <Plus className="h-3.5 w-3.5" /> Create
          </PrimaryButton>
        </Card>
        {groups.length > 0 && (
          <div className="mt-2 space-y-2">
            {groups.map((g) => (
              <GroupEditor
                key={g.id}
                group={g}
                wallets={wallets}
                onToggle={(wid) => void toggleMember(g.id, wid)}
                onRename={(name) => void window.krypt.wallet.renameGroup(g.id, name).then(apply)}
                onDelete={() => void window.krypt.wallet.deleteGroup(g.id).then(apply)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Fan-out buy"
        description="Several wallets buy the same token at once. Each buy is signed, simulated and loss-bounded on its own."
      >
        <Card className="space-y-3">
          <input
            value={mint}
            onChange={(e) => setMint(e.target.value)}
            spellCheck={false}
            placeholder="Token mint address"
            className="w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-body text-white outline-none focus:border-krypt-purple/60"
          />

          {/* Target: a group, or ad-hoc wallets */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-label uppercase tracking-wider text-krypt-muted">Buy from</span>
            <button
              onClick={() => setTargetGroup('')}
              className={cls('rounded-md border px-2 py-1 text-label font-medium', !targetGroup ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white' : 'border-white/10 bg-black/25 text-krypt-muted')}
            >
              <Users className="inline h-3 w-3 mr-1" /> Pick wallets
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setTargetGroup(g.id)}
                className={cls('rounded-md border px-2 py-1 text-label font-medium', targetGroup === g.id ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white' : 'border-white/10 bg-black/25 text-krypt-muted')}
              >
                <Layers className="inline h-3 w-3 mr-1" /> {g.name}
              </button>
            ))}
          </div>

          {!targetGroup && (
            <div className="flex flex-wrap gap-1.5">
              {wallets.map((w) => {
                const on = adhoc.has(w.id);
                return (
                  <button
                    key={w.id}
                    onClick={() =>
                      setAdhoc((prev) => {
                        const next = new Set(prev);
                        next.has(w.id) ? next.delete(w.id) : next.add(w.id);
                        return next;
                      })
                    }
                    className={cls('rounded-md border px-2 py-1 text-label font-medium', on ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white' : 'border-white/10 bg-black/25 text-krypt-muted hover:text-white')}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Sizing */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-md border border-white/10 overflow-hidden">
              <button onClick={() => setMode('same')} className={cls('px-2.5 py-1 text-label font-semibold', mode === 'same' ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted')}>
                Same each
              </button>
              <button onClick={() => setMode('total')} className={cls('px-2.5 py-1 text-label font-semibold', mode === 'total' ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted')}>
                Split a total
              </button>
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="w-24 rounded bg-black/40 border border-white/15 px-2 py-1 font-mono text-body text-white outline-none focus:border-krypt-purple/60"
            />
            <span className="text-label text-krypt-muted">{mode === 'same' ? 'SOL per wallet' : 'SOL total'}</span>
          </div>

          {mode === 'total' && (
            <div className="flex items-center gap-2">
              <span className="text-label uppercase tracking-wider text-krypt-muted w-16">Randomise</span>
              <input type="range" min={0} max={80} value={jitter} onChange={(e) => setJitter(Number(e.target.value))} className="flex-1 accent-krypt-purple" />
              <span className="text-label font-mono text-white/80 w-10 text-right">{jitter}%</span>
            </div>
          )}

          <label className="flex items-center gap-2 text-body text-krypt-muted cursor-pointer">
            <input type="checkbox" checked={stagger} onChange={(e) => setStagger(e.target.checked)} className="h-3.5 w-3.5 accent-krypt-purple" />
            Stagger the buys by a small random delay (less obviously coordinated on-chain)
          </label>

          <div className="flex items-center gap-2 pt-1">
            {!armed && <span className="text-label text-arc-gold/80">Arm live execution above to fan out.</span>}
            <div className="flex-1" />
            <PrimaryButton onClick={() => void fanoutBuy()} disabled={busy || !armed}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Fan-out buy
            </PrimaryButton>
          </div>
        </Card>
      </Section>
    </>
  );
}
