// Group Wallets — make a group, then fill it with wallets (2026-09-03).
// Nothing here moves SOL; it creates keys and groupings. Back up every key
// from the Wallet page — nobody can recover one.

import { useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import type { WalletGroupView } from '@shared/types';
import { Badge, Card, Empty, GhostButton, NumberInput, Page, PrimaryButton, Section } from '../../components/common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';
import { groupBalance, inputCls, selectCls, useLabData } from './shared';
import { SwitchToPaper } from '../../components/SwitchToPaper';

/**
 * The wallet's full address, click to copy.
 *
 * It used to be truncated to six characters at each end, which is fine for
 * recognising a wallet and useless for the thing people actually do here: send
 * it money. A group wallet is empty until someone funds it from outside the
 * app, so the address has to be readable and copyable without a detour through
 * a details panel.
 *
 * `select-all` means a drag selects the whole thing rather than a word, for
 * anyone who prefers selecting to clicking.
 */
function WalletAddress({ value }: { value: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            toast.success('Address copied');
            setTimeout(() => setCopied(false), 1200);
          },
          () => toast.error('Could not copy — select the address and copy it by hand'),
        );
      }}
      title="Copy this wallet's address"
      className="group/addr mt-0.5 flex w-full items-center gap-1.5 text-left"
    >
      <span className="select-all truncate font-mono text-label text-krypt-muted group-hover/addr:text-white/70">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 text-krypt-muted/50 group-hover/addr:text-krypt-purple" />
      )}
    </button>
  );
}

export function CreatorPage({ onOpenToken: _onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const modal = useModal();
  const data = useLabData();
  const { wallets, groups, armed, active, balanceOf, busy, setBusy, setWallets, applyGroups, reload, refreshBalances, runs } = data;

  // ── Groups ───────────────────────────────────────────────────────────
  const [newGroup, setNewGroup] = useState('');
  const [groupRenaming, setGroupRenaming] = useState<string | null>(null);
  const [groupRenameText, setGroupRenameText] = useState('');

  const createGroup = async (): Promise<void> => {
    const n = newGroup.trim();
    if (!n) return;
    const before = new Set(groups.map((g) => g.id));
    const r = await window.krypt.wallet.createGroup(n);
    applyGroups(r);
    if (r.ok && r.data) {
      setNewGroup('');
      // The new group is the id that was not there before — never a name
      // match, which a duplicate or normalised name would get wrong.
      const made = r.data.find((g) => !before.has(g.id)) ?? r.data[r.data.length - 1];
      if (made) setTargetGroup(made.id);
    }
  };
  const deleteGroup = async (g: WalletGroupView): Promise<void> => {
    if (runs.some((r) => r.groupId === g.id && r.running)) return toast.error('Stop this group’s warmer run first');
    // A run is only ever rendered THROUGH its group, and every run comes back
    // from a restart not running — so deleting the group of a stopped run with
    // open bags hides those bags for good. They keep selling on their timers
    // with nowhere to report it.
    const openBags = runs.filter((r) => r.groupId === g.id).flatMap((r) => r.open);
    if (openBags.length) {
      return toast.error(
        `This group’s warmer still holds ${openBags.length} bag(s): ${openBags
          .map((o) => o.symbol || o.mint.slice(0, 6))
          .slice(0, 4)
          .join(', ')}${openBags.length > 4 ? '…' : ''}. Sell them first — deleting the group would hide them.`,
      );
    }
    const yes = await modal.confirm({
      title: `Delete group “${g.name}”`,
      message: 'The wallets stay; only the grouping and its follow / warmer settings are removed.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!yes) return;
    applyGroups(await window.krypt.wallet.deleteGroup(g.id));
  };
  const toggleMember = async (g: WalletGroupView, walletId: string): Promise<void> => {
    const ids = new Set(g.members.map((m) => m.id));
    ids.has(walletId) ? ids.delete(walletId) : ids.add(walletId);
    applyGroups(await window.krypt.wallet.setGroupMembers(g.id, [...ids]));
  };

  // ── Create wallets INTO a group ──────────────────────────────────────
  const [targetGroup, setTargetGroup] = useState<string>('');
  const [createCount, setCreateCount] = useState(3);
  const [createPrefix, setCreatePrefix] = useState('');
  const target = groups.find((g) => g.id === targetGroup) ?? null;

  const createMany = async (): Promise<void> => {
    if (!target) return toast.error('Create a group first, then choose it');
    const n = Math.max(1, Math.min(20, Math.round(createCount)));
    setBusy('create');
    try {
      const r = await window.krypt.lab.generateMany(n, createPrefix.trim(), target.id);
      if (r.ok && r.data) {
        setWallets(r.data);
        await reload();
        // The store's own count: it stops early at the wallet limit.
        toast.success(`${r.message} in “${target.name}” — back them up from the Wallet page`);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  // ── Wallet list ──────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const makeActive = async (id: string): Promise<void> => {
    const r = await window.krypt.wallet.select(id);
    if (r.ok) {
      toast.success(r.message);
      await reload();
    } else toast.error(r.message);
  };
  const doRename = async (id: string): Promise<void> => {
    const label = renameText.trim();
    setRenaming(null);
    if (!label) return;
    const r = await window.krypt.wallet.rename(id, label);
    if (r.ok) {
      const l = await window.krypt.wallet.list();
      if (l.ok && l.data) setWallets(l.data);
    } else toast.error(r.message);
  };

  return (
    <Page
      title="Group Wallets"
      subtitle={`${groups.length} group${groups.length === 1 ? '' : 's'} · ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} · active: ${active?.label ?? '—'}`}
      actions={
        <GhostButton onClick={() => void refreshBalances()} disabled={busy === 'refresh'}>
          <RefreshCw className={cls('h-3.5 w-3.5', busy === 'refresh' && 'animate-spin')} /> Refresh balances
        </GhostButton>
      }
    >
      {/* ── 1. Groups ── */}
      <Section
        title="1 · Groups"
        description="A group is what the other pages act on: Funder funds it, Warmer trades it, Copier makes it follow the active wallet. Create one first."
      >
        <Card>
          <div className="flex items-center gap-2">
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createGroup()}
              placeholder="New group name"
              maxLength={32}
              className={cls(inputCls, 'w-56')}
            />
            <PrimaryButton onClick={() => void createGroup()} disabled={!newGroup.trim()} className="!py-1.5">
              Create group
            </PrimaryButton>
          </div>
          {groups.length === 0 ? (
            <div className="mt-3 text-body text-krypt-muted">No groups yet — create one above, then fill it below.</div>
          ) : (
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {groups.map((g) => {
                const bal = groupBalance(g, balanceOf);
                const memberIds = new Set(g.members.map((m) => m.id));
                return (
                  <div key={g.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center gap-2">
                      {groupRenaming === g.id ? (
                        <input
                          autoFocus
                          value={groupRenameText}
                          onChange={(e) => setGroupRenameText(e.target.value)}
                          onBlur={() => {
                            setGroupRenaming(null);
                            const n = groupRenameText.trim();
                            if (n && n !== g.name) void window.krypt.wallet.renameGroup(g.id, n).then(applyGroups);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            if (e.key === 'Escape') setGroupRenaming(null);
                          }}
                          className={cls(inputCls, 'w-40 py-0.5')}
                        />
                      ) : (
                        <button
                          onClick={() => {
                            setGroupRenaming(g.id);
                            setGroupRenameText(g.name);
                          }}
                          title="Rename group"
                          className="text-value font-semibold text-white hover:text-krypt-pink"
                        >
                          {g.name}
                        </button>
                      )}
                      <span className="text-label font-mono text-krypt-muted">
                        {g.members.length} wallet{g.members.length === 1 ? '' : 's'} · {bal === null ? '—' : `${bal.toFixed(4)} SOL`}
                      </span>
                      <div className="flex-1" />
                      <GhostButton onClick={() => void deleteGroup(g)} destructive>
                        <Trash2 className="h-3.5 w-3.5" />
                      </GhostButton>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {wallets.length === 0 ? (
                        <span className="text-body text-krypt-muted">No wallets yet.</span>
                      ) : (
                        wallets.map((w) => (
                          <label
                            key={w.id}
                            className={cls(
                              'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-body cursor-pointer transition',
                              memberIds.has(w.id) ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                            )}
                          >
                            <input type="checkbox" className="accent-krypt-purple" checked={memberIds.has(w.id)} onChange={() => void toggleMember(g, w.id)} />
                            {w.label}
                            {w.active && <span className="text-micro text-arc-gold">active</span>}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </Section>

      {/* ── 2. Create wallets ── */}
      <Section
        title="2 · Create wallets"
        description="New wallets are generated here, encrypted by your OS, and added to the chosen group straight away. The first wallet ever created becomes the active signer."
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <select value={targetGroup} onChange={(e) => setTargetGroup(e.target.value)} className={selectCls}>
              <option value="">— choose a group —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <span className="text-body text-krypt-muted">count</span>
            <NumberInput value={createCount} min={1} max={20} onChange={setCreateCount} className="w-16" />
            <input
              value={createPrefix}
              onChange={(e) => setCreatePrefix(e.target.value)}
              placeholder="label prefix (optional)"
              maxLength={24}
              className={cls(inputCls, 'w-44')}
            />
            <PrimaryButton onClick={() => void createMany()} disabled={!target || busy === 'create'} className="!py-1.5">
              <KeyRound className="h-3.5 w-3.5" /> Create {Math.max(1, Math.min(20, Math.round(createCount)))} wallet{createCount === 1 ? '' : 's'}
            </PrimaryButton>
          </div>
          {!target && <div className="mt-2 text-body text-arc-gold">Create a group first, then choose it here.</div>}
        </Card>
      </Section>

      {/* ── 3. All wallets ── */}
      <Section title="3 · Wallets" description="One wallet signs at a time (the active one). Switching is blocked while live execution is armed.">
        <Card>
          {wallets.length === 0 ? (
            <Empty title="No wallets yet" message="Create a group above, then create wallets into it." />
          ) : (
            <div className="space-y-1.5">
              {wallets.map((w) => (
                <div
                  key={w.id}
                  className={cls(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 transition',
                    w.active ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/8 bg-white/[0.02]',
                  )}
                >
                  {/* basis gives the address room to render in full before
                      anything else claims width; a 44-character key at 10px is
                      about 17rem. */}
                  <div className="min-w-0 flex-1 basis-[17rem]">
                    {renaming === w.id ? (
                      <input
                        autoFocus
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onBlur={() => void doRename(w.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void doRename(w.id);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        className={cls(inputCls, 'w-44 py-0.5')}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setRenaming(w.id);
                          setRenameText(w.label);
                        }}
                        title="Rename"
                        className="text-note font-medium text-white/90 hover:text-white"
                      >
                        {w.label}
                      </button>
                    )}
                    <WalletAddress value={w.publicKey} />
                  </div>
                  <span className="min-w-0 shrink truncate text-label text-krypt-muted/70">
                    {groups.filter((g) => g.members.some((m) => m.id === w.id)).map((g) => g.name).join(', ') || 'no group'}
                  </span>
                  {w.active && <Badge tone="gradient">active</Badge>}
                  <div className="font-mono text-note text-white/85 w-24 text-right">
                    {w.balanceSol != null ? `${w.balanceSol.toFixed(4)} SOL` : '—'}
                  </div>
                  {!w.active && (
                    <GhostButton onClick={() => void makeActive(w.id)} disabled={armed}>
                      Make active
                    </GhostButton>
                  )}
                </div>
              ))}
            </div>
          )}
          {armed && (
            <div className="mt-2">
              <SwitchToPaper reason="Live execution is armed — the active wallet cannot change while it is." />
            </div>
          )}
        </Card>
      </Section>
    </Page>
  );
}
