// "Armed — disarm to switch wallets", with the button that does it.
//
// The app blocked wallet changes while live execution was armed and told the
// user to "disarm" — a word that appears on no control anywhere in the
// interface. Disarming happens as a side effect of switching the top bar to
// Paper, which nobody could be expected to infer. That is a dead end with a
// correct-sounding sentence in it, which is worse than an error.
//
// So the sentence now names the real control AND carries it: one click,
// which is exactly what the Paper button in the top bar does.

import { useState } from 'react';
import { Loader2, ShieldOff } from 'lucide-react';
import { cls } from '../utils/format';
import { useToast } from '../state/ToastProvider';

export function SwitchToPaper({ reason, className }: { reason: string; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const go = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      // The same call the top bar's Paper button makes: it disarms live
      // execution and persists the mode, so the two can never disagree.
      const r = await window.krypt.live.setLive(false);
      if (r.ok) toast.success('Switched to Paper — live execution is disarmed, you can change wallets now');
      else toast.error(r.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={cls('inline-flex flex-wrap items-center gap-2', className)}>
      <span className="text-[10px] leading-relaxed text-arc-gold">{reason}</span>
      <button
        onClick={() => void go()}
        disabled={busy}
        title="Switches the top bar to Paper, which disarms live execution"
        className="inline-flex items-center gap-1 rounded-md border border-arc-gold/40 bg-arc-gold/10 px-2 py-1 text-[10px] font-semibold text-arc-gold transition hover:bg-arc-gold/20 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
        Switch to Paper
      </button>
    </span>
  );
}
