// pump.fun callout rewards (2026-09-23) — on the pump.fun accounts page.
//
// Two halves:
//   1. What pump says each account has been paid, and whether it has
//      accepted the terms rewards are paid under. An account that has not
//      accepted them may never be paid, so that is the first thing shown.
//   2. The USDC sitting in each wallet — rewards land in the account's own
//      wallet — with two ways out: swap it to SOL where it is, or send it to
//      that wallet's CONFIRMED withdrawal address. Nowhere else: the signer
//      refuses any other destination (signPolicy 'withdraw-token').

import { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, BadgeCheck, ExternalLink, Loader2, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { CALLOUT_REWARD_TERMS_URL, payoutStatusLabel, type PumpRewards } from '@shared/pumpRewards';
import { Card, GhostButton, Section } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { cls, shortAddr } from '../../utils/format';

type WalletUsdc = { walletId: string; address: string; label: string; usdcRaw: string | null; homeAddress: string | null };

const usd = (n: number | null): string => (n === null ? '—' : `$${n.toFixed(2)}`);
const usdcOf = (raw: string | null): number | null => (raw === null ? null : Number(raw) / 1e6);

export function CalloutRewards() {
  const toast = useToast();
  const modal = useModal();
  const [accounts, setAccounts] = useState<PumpRewards[] | null>(null);
  const [wallets, setWallets] = useState<WalletUsdc[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.krypt.calloutRewards.list();
      if (r.ok && r.data) {
        setAccounts(r.data.accounts);
        setWallets(r.data.wallets);
      } else toast.error(r.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setBusy(key);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      if (r.ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const accept = async (a: PumpRewards): Promise<void> => {
    const yes = await modal.confirm({
      title: `Accept pump.fun's reward terms for ${a.username ?? shortAddr(a.address)}?`,
      message: `pump.fun pays callout rewards only to accounts that accept its callout-reward terms. Read them first at ${CALLOUT_REWARD_TERMS_URL}. This records your acceptance with pump.fun for this one account.`,
      confirmLabel: 'Accept the terms',
    });
    if (yes) await act(`tos:${a.walletId}`, () => window.krypt.calloutRewards.acceptTerms(a.walletId));
  };

  const swapToSol = async (w: WalletUsdc): Promise<void> => {
    const amount = usdcOf(w.usdcRaw) ?? 0;
    const yes = await modal.confirm({
      title: `Swap ${amount.toFixed(2)} USDC to SOL?`,
      message: `In ${w.label || shortAddr(w.address)}, through the app's normal swap (Jupiter), with the usual 0.5% fee. The SOL stays in that wallet — use Collect on the Wallet list to move it to your main one.`,
      confirmLabel: 'Swap to SOL',
    });
    if (yes) await act(`swap:${w.walletId}`, () => window.krypt.calloutRewards.swapUsdc(w.walletId));
  };

  const withdraw = async (w: WalletUsdc): Promise<void> => {
    if (!w.homeAddress) return;
    const amount = usdcOf(w.usdcRaw) ?? 0;
    const yes = await modal.confirm({
      title: `Send ${amount.toFixed(2)} USDC to your withdrawal address?`,
      message: `All of it, to ${w.homeAddress} — the withdrawal address you confirmed for ${w.label || shortAddr(w.address)}. USDC can go nowhere else from this app. If that address has no USDC account yet, about 0.002 SOL of rent opens one.`,
      confirmLabel: 'Send USDC',
      destructive: true,
    });
    if (yes) await act(`wd:${w.walletId}`, () => window.krypt.calloutRewards.withdrawUsdc(w.walletId, 'max'));
  };

  const withUsdc = wallets.filter((w) => (usdcOf(w.usdcRaw) ?? 0) > 0);
  const unreadable = wallets.filter((w) => w.usdcRaw === null).length;

  return (
    <Section
      title="Callout rewards"
      description="pump.fun pays callout rewards in USDC to each account's own wallet. What pump says it has paid, whether each account has accepted the reward terms, and the USDC your wallets hold."
    >
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <a
            onClick={(e) => {
              e.preventDefault();
              void window.krypt.app.openExternal(CALLOUT_REWARD_TERMS_URL);
            }}
            href={CALLOUT_REWARD_TERMS_URL}
            className="inline-flex items-center gap-1 text-label text-krypt-purple hover:text-white"
          >
            pump.fun callout-reward terms <ExternalLink className="h-3 w-3" />
          </a>
          <div className="flex-1" />
          <GhostButton onClick={() => void load()} disabled={loading} className="!py-1.5 !px-2.5 text-body">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </GhostButton>
        </div>

        {accounts === null ? (
          <p className="text-body text-krypt-muted">{loading ? 'Asking pump.fun…' : '—'}</p>
        ) : accounts.length === 0 ? (
          <p className="text-body text-krypt-muted">No pump.fun account is signed in.</p>
        ) : (
          <div className="space-y-1.5">
            {accounts.map((a) => {
              const latest = a.recent[0];
              return (
                <div key={a.walletId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                  <span className="w-36 truncate text-note font-medium text-white/90">{a.username ?? shortAddr(a.address)}</span>
                  <span className="text-body">
                    <span className="text-krypt-muted">Paid </span>
                    <span className="font-mono text-white">{usd(a.rewardsPaidUsdc)}</span>
                    {a.referralPaidUsdc !== null && a.referralPaidUsdc > 0 && (
                      <span className="text-krypt-muted"> · referrals <span className="font-mono text-white">{usd(a.referralPaidUsdc)}</span></span>
                    )}
                  </span>
                  {latest && (
                    <span className="text-label text-krypt-muted">
                      latest {usd(latest.amountUsdc)} · {payoutStatusLabel(latest.status)}
                    </span>
                  )}
                  <div className="flex-1" />
                  {a.termsAccepted === true ? (
                    <span className="inline-flex items-center gap-1 text-label text-emerald-300" title={a.termsAcceptedAt ?? undefined}>
                      <BadgeCheck className="h-3.5 w-3.5" /> terms accepted
                    </span>
                  ) : a.termsAccepted === false ? (
                    <GhostButton onClick={() => void accept(a)} disabled={busy !== null} className="!py-1 !px-2 text-body">
                      {busy === `tos:${a.walletId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TriangleAlert className="h-3.5 w-3.5 text-arc-gold" />}
                      Not accepted — accept terms
                    </GhostButton>
                  ) : (
                    <span className="text-label text-krypt-muted/60">terms: unknown</span>
                  )}
                  {a.problem && <p className="w-full text-label text-rose-300/90">{a.problem}</p>}
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t border-white/8 pt-3">
          <p className="mb-2 text-label text-krypt-muted">
            USDC in your wallets
            {unreadable > 0 && <span className="text-krypt-muted/60"> · {unreadable} could not be read</span>}
          </p>
          {withUsdc.length === 0 ? (
            <p className="text-body text-krypt-muted/80">None of your wallets holds USDC right now.</p>
          ) : (
            <div className="space-y-1.5">
              {withUsdc.map((w) => (
                <div key={w.walletId} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                  <span className="w-36 truncate text-note text-white/90">{w.label || shortAddr(w.address)}</span>
                  <span className="font-mono text-note text-white">{(usdcOf(w.usdcRaw) ?? 0).toFixed(2)} USDC</span>
                  <div className="flex-1" />
                  <GhostButton onClick={() => void swapToSol(w)} disabled={busy !== null} className="!py-1 !px-2 text-body">
                    {busy === `swap:${w.walletId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                    Swap to SOL
                  </GhostButton>
                  <GhostButton
                    onClick={() => void withdraw(w)}
                    disabled={busy !== null || !w.homeAddress}
                    className={cls('!py-1 !px-2 text-body', !w.homeAddress && 'opacity-60')}
                  >
                    {busy === `wd:${w.walletId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {w.homeAddress ? `Send to ${shortAddr(w.homeAddress)}` : 'Set a withdrawal address first'}
                  </GhostButton>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-label leading-relaxed text-krypt-muted/70">
            Swap to SOL needs live armed. Sending goes only to the withdrawal address you confirmed for that wallet on the Sol Wallet page — the app will not send USDC anywhere else.
          </p>
        </div>
      </Card>
    </Section>
  );
}
