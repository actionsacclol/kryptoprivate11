// The multi-wallet acknowledgement — a script trading from one of your OTHER
// wallets (bot.buy / bot.sell with an address) is refused until it is given.
//
// It used to sit with the Copier on the Wallet list. The Copier was removed on
// 2026-09-22, which left scripts as the only multi-wallet path, so it lives on
// the Scripts page now, next to the only thing that uses it.
//
// The words shown are the shared constant (never re-typed here, so what is
// accepted is what the code describes), and accepting goes through its own
// handler: main stamps the wording version, so a renderer cannot claim consent
// to words the user never saw.

import { useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { MULTI_WALLET_CONSENT_TEXT, consentValid } from '@shared/multiWallet';
import { Card, GhostButton, PrimaryButton, Section } from './common';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAgo } from '../utils/format';

export function MultiWalletConsent() {
  const toast = useToast();
  const { settings, refreshSettings } = useAppState();
  const accepted = consentValid(settings.multiWallet);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const setAccepted = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.multiwallet.accept(on);
      if (r.ok) {
        await refreshSettings();
        toast.success(r.message);
      } else toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Trading from your other wallets"
      description="A script can buy or sell from any of your own wallets by passing its address to bot.buy / bot.sell. That is refused until you have read and accepted this."
    >
      <Card className="space-y-3">
        {accepted ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2">
            <ShieldCheck className="h-4 w-4 flex-shrink-0 text-emerald-300" />
            <span className="text-body text-emerald-300">
              Allowed — accepted {settings.multiWallet.acceptedAt ? fmtAgo(settings.multiWallet.acceptedAt) : ''}
            </span>
            <div className="flex-1" />
            <GhostButton onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'What I accepted'}</GhostButton>
            <GhostButton onClick={() => void setAccepted(false)} disabled={busy}>
              Turn off
            </GhostButton>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-arc-gold" />
            <p className="text-body leading-relaxed text-arc-gold/90">
              Off. Scripts trade from your main wallet only until you accept below.
            </p>
          </div>
        )}
        {(!accepted || open) && (
          <div className="space-y-2 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-3">
            {MULTI_WALLET_CONSENT_TEXT.map((line, i) => (
              <p key={i} className={cls('text-body leading-relaxed', i === 0 ? 'text-white' : 'text-krypt-muted')}>
                {line}
              </p>
            ))}
          </div>
        )}
        {!accepted && (
          <PrimaryButton onClick={() => void setAccepted(true)} disabled={busy}>
            I have read this — allow it
          </PrimaryButton>
        )}
      </Card>
    </Section>
  );
}
