// Wallet list — your Solana wallets, at most fifteen including the main one
// (cap raised from 10 on 2026-09-23).
//
// This page used to be "Group Wallets": make a group, fill it, and have the
// group follow your trades. Groups were removed on the owner's call —
// "grouping feels like bundling" — and so, the same day, was having other
// wallets automatically copy the main one. What is left is a flat list where
// each wallet stands on its own: it can be made the main (active) wallet and
// it can have its own pump.fun account. Trading from several wallets is now
// only something a script does, one named wallet per call, behind the
// acknowledgement on the Scripts page.
//
// Fifteen wallets is also fifteen pump.fun accounts at most. Existing
// pump.fun accounts (including ones made on pump.fun with email/Google) are
// brought in with Import, which signs into the account the key belongs to.
//
// Nothing here moves SOL. Funding is on the Funder page. Back up every key
// from the Wallet page — nobody can recover one.

import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, LogIn, RefreshCw, Trash2, UserCheck } from 'lucide-react';
import { sessionForWallet, type PumpAuthStatus } from '@shared/pumpAuth';
import { REFERRAL_NOTICE } from '@shared/pumpReferral';
import { Badge, Card, Empty, GhostButton, NumberInput, Page, PrimaryButton, Section } from '../../components/common';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { cls, shortAddr } from '../../utils/format';
import { inputCls, useLabData } from './shared';
import { SwitchToPaper } from '../../components/SwitchToPaper';
import { loadPumpStatus } from '../../state/pumpStatus';

/** Fifteen in all, the main wallet included. Mirrors walletStore MAX_WALLETS. */
const MAX_WALLETS = 15;


/**
 * The wallet's full address, click to copy. A new wallet is empty until it is
 * funded, so the address has to be readable and copyable without a detour.
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
      title="Copy address"
      className="group flex max-w-full items-center gap-1.5 text-left font-mono text-label text-krypt-muted hover:text-white"
    >
      <span className="select-all break-all">{value}</span>
      {copied ? <Check className="h-3 w-3 flex-shrink-0 text-emerald-300" /> : <Copy className="h-3 w-3 flex-shrink-0 opacity-60 group-hover:opacity-100" />}
    </button>
  );
}

export function CreatorPage({ onOpenToken: _onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const data = useLabData();
  const { wallets, armed, active, busy, setBusy, setWallets, reload, refreshBalances } = data;

  // ── pump.fun accounts, one per wallet ────────────────────────────────
  const [pump, setPump] = useState<PumpAuthStatus | null>(null);
  const refreshPump = (): void => {
    void window.krypt.pump.status().then((r) => r.ok && r.data && setPump(r.data));
  };
  // Re-reads while a name main is filling in is still missing.
  useEffect(() => loadPumpStatus(setPump), []);
  const pumpSignIn = async (walletId: string): Promise<void> => {
    setBusy(`pump:${walletId}`);
    try {
      const r = await window.krypt.pump.signIn(walletId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      refreshPump();
      // The display name arrives a moment after the token.
      window.setTimeout(refreshPump, 1500);
    } finally {
      setBusy(null);
    }
  };

  // ── Make wallets ─────────────────────────────────────────────────────
  const room = Math.max(0, MAX_WALLETS - wallets.length);
  const [createCount, setCreateCount] = useState(1);
  const [createPrefix, setCreatePrefix] = useState('');
  const n = Math.max(1, Math.min(room, Math.round(createCount)));
  const createMany = async (): Promise<void> => {
    if (room === 0) return void toast.error(`You have ${wallets.length} wallets — ${MAX_WALLETS} is the most, your main one included`);
    setBusy('create');
    try {
      const r = await window.krypt.lab.generateMany(n, createPrefix.trim());
      if (r.ok && r.data) {
        setWallets(r.data);
        toast.success(`${r.message} — back them up from the Wallet page`);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  // ── Import an existing wallet ────────────────────────────────────────
  const [importKey, setImportKey] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const importOne = async (): Promise<void> => {
    if (room === 0) return void toast.error(`You are at ${MAX_WALLETS} wallets — remove one before importing another`);
    setBusy('import');
    try {
      // pump.importAccount imports the key AND signs into its pump account if
      // one exists (the same call as "Bring an existing account").
      const r = await window.krypt.pump.importAccount(importKey.trim(), importLabel.trim());
      if (r.ok && r.data) {
        setImportKey('');
        setImportLabel('');
        toast.success(r.message);
        await reload();
        refreshPump();
        window.setTimeout(refreshPump, 1500);
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  // ── Rows ─────────────────────────────────────────────────────────────
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const modal = useModal();
  // Remove a wallet's encrypted key from this machine. Not the main wallet
  // (switch main first) and not while live is armed, the same guards as the
  // Sol Wallet page. A pump.fun session on it goes too — see wallet.remove.
  const removeWallet = async (w: (typeof wallets)[number]): Promise<void> => {
    const yes = await modal.confirm({
      title: `Remove ${w.label || 'this wallet'}?`,
      message: `This deletes the encrypted key for ${w.publicKey.slice(0, 8)}… from this machine. If you have not backed it up, anything in it is gone for good.`,
      confirmLabel: 'Remove wallet',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.wallet.remove(w.id);
    if (r.ok) {
      toast.success('Wallet removed');
      await reload();
    } else toast.error(r.message);
  };
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
    if (r.ok) await reload();
    else toast.error(r.message);
  };
  return (
    <Page
      title="Wallet list"
      subtitle={`${wallets.length} of ${MAX_WALLETS} wallets · main: ${active?.label ?? '—'}`}
      actions={
        <GhostButton onClick={() => void refreshBalances()} disabled={busy === 'refresh'}>
          <RefreshCw className={cls('h-3.5 w-3.5', busy === 'refresh' && 'animate-spin')} /> Refresh balances
        </GhostButton>
      }
    >
      {/* ── Make wallets ── */}
      <Section
        title="Make wallets"
        description={`At most ${MAX_WALLETS} wallets, your main one included — so at most ${MAX_WALLETS} pump.fun accounts too. New wallets are generated here and encrypted by your OS; the first one ever made becomes the main wallet.`}
      >
        <Card>
          {wallets.length > MAX_WALLETS && (
            <p className="mb-2 text-body text-arc-gold">
              You have {wallets.length} wallets from before the limit. Every one is kept; new ones can be made once you are under {MAX_WALLETS}.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-krypt-muted">make</span>
            <NumberInput value={Math.min(createCount, Math.max(1, room))} min={1} max={Math.max(1, room)} onChange={setCreateCount} className="w-16" />
            <input
              value={createPrefix}
              onChange={(e) => setCreatePrefix(e.target.value)}
              placeholder="label prefix (optional)"
              maxLength={24}
              className={cls(inputCls, 'w-44')}
            />
            <PrimaryButton onClick={() => void createMany()} disabled={room === 0 || busy === 'create'} className="!py-1.5">
              <KeyRound className="h-3.5 w-3.5" /> {room === 0 ? 'At the limit' : `Make ${n} wallet${n === 1 ? '' : 's'}`}
            </PrimaryButton>
            <span className="text-label text-krypt-muted">{room} left</span>
          </div>

          {/* Import an existing wallet's key (2026-09-23). The same call as
              "Bring an existing account" on the pump.fun accounts page: it
              imports the key AND signs into its pump.fun account if one
              exists — the route for an account made on pump.fun (email or a
              social login) once its key is exported there. */}
          <div className="mt-3 border-t border-white/8 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                placeholder="Import a private key (base58 or JSON array)"
                spellCheck={false}
                autoComplete="off"
                className={cls(inputCls, 'w-72 font-mono')}
              />
              <input
                value={importLabel}
                onChange={(e) => setImportLabel(e.target.value)}
                placeholder="label (optional)"
                maxLength={24}
                className={cls(inputCls, 'w-40')}
              />
              <PrimaryButton onClick={() => void importOne()} disabled={room === 0 || busy === 'import' || !importKey.trim()} className="!py-1.5">
                {busy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} Import
              </PrimaryButton>
            </div>
            <p className="mt-1.5 text-label leading-relaxed text-krypt-muted/70">
              Signs into its pump.fun account if it has one — how an account made on pump.fun with email or Google comes in: export its key on pump.fun (profile → View Wallet → Export Wallet), paste it here. Stored encrypted; never leaves this machine. Counts toward your {MAX_WALLETS} wallets.
            </p>
          </div>
        </Card>
      </Section>

      {/* ── The list ── */}
      <Section
        title="Your wallets"
        description="Each one on its own: make it the main wallet, or give it a pump.fun account. A script can trade from any of them by address (see the Scripts page)."
      >
        <Card>
          <p className="mb-2 text-label leading-relaxed text-krypt-muted/80">{REFERRAL_NOTICE}</p>
          {wallets.length === 0 ? (
            <Empty title="No wallets yet" message="Make one above, or import a key on the Wallet page." />
          ) : (
            <div className="space-y-1.5">
              {wallets.map((w) => {
                const session = pump ? sessionForWallet(pump, w.id) : null;
                return (
                  <div
                    key={w.id}
                    className={cls('rounded-lg border px-3 py-2 transition', w.active ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/8 bg-white/[0.02]')}
                  >
                    <div className="flex flex-wrap items-center gap-3">
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

                      <div className="w-24 text-right font-mono text-note text-white/85">{w.balanceSol != null ? `${w.balanceSol.toFixed(4)} SOL` : '—'}</div>

                      {/* pump.fun: one account per wallet. */}
                      {session ? (
                        <span className="inline-flex items-center gap-1 text-body text-emerald-300" title="Signed in to pump.fun">
                          <UserCheck className="h-3.5 w-3.5" />
                          {session.username || shortAddr(session.address)}
                        </span>
                      ) : (
                        <GhostButton onClick={() => void pumpSignIn(w.id)} disabled={busy !== null || !pump?.ready}>
                          {busy === `pump:${w.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                          pump.fun account
                        </GhostButton>
                      )}

                      {w.active ? (
                        <Badge tone="gradient">main</Badge>
                      ) : (
                        <GhostButton onClick={() => void makeActive(w.id)} disabled={armed}>
                          Make main
                        </GhostButton>
                      )}
                      {/* The main wallet cannot be removed here — switch main
                          to another first. Blocked while armed, like Make main. */}
                      {!w.active && (
                        <GhostButton destructive onClick={() => void removeWallet(w)} disabled={armed}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </GhostButton>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {armed && (
            <div className="mt-2">
              <SwitchToPaper reason="Live execution is armed — the main wallet cannot change while it is." />
            </div>
          )}
        </Card>
      </Section>
    </Page>
  );
}
