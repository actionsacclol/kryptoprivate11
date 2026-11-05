// Withdraw SOL from the active wallet to its saved withdrawal address. One card
// for the Sol Wallet page and the wallet panel, so neither can drift from the
// other's refusals (2026-11-04: moved here from pages/Wallet.tsx, unchanged).

import { useState } from 'react';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import { Card, GhostButton, NumberInput, PrimaryButton } from '../common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import type { WalletInfo } from '@shared/types';

/** Mirrors electron/engine/sweep.ts — the rent-exempt minimum for a 0-data
 *  account plus fee headroom that stays behind on a max withdrawal. */
const RENT_EXEMPT_MIN_LAMPORTS = 890_880;
const WITHDRAW_FEE_HEADROOM_LAMPORTS = 10_000;
const LAMPORTS_PER_SOL = 1e9;

function maxWithdrawableSol(balanceSol: number | null): number | null {
  if (balanceSol == null || !Number.isFinite(balanceSol)) return null;
  const n = Math.floor(balanceSol * LAMPORTS_PER_SOL) - RENT_EXEMPT_MIN_LAMPORTS - WITHDRAW_FEE_HEADROOM_LAMPORTS;
  return Math.max(0, n) / LAMPORTS_PER_SOL;
}

/**
 * Withdraw SOL from the ACTIVE wallet to its confirmed withdrawal address.
 * Acts on the active wallet only — that is the one whose withdrawal address
 * the block above edits. The destination is read-only here on purpose: the
 * signer refuses any other address, so there is nothing else to offer.
 */
export function WithdrawPanel({
  info,
  onDone,
  onChangeAddress,
  unsavedHome,
  bare,
}: {
  info: WalletInfo;
  onDone: () => void;
  onChangeAddress: () => void;
  /** The withdrawal-address field holds an edit that was never saved. The
   *  withdraw would still go to the SAVED address, so it is refused until the
   *  edit is saved or undone (user report 2026-10-03). */
  unsavedHome: boolean;
  /** Inside another surface that names it already: no card, no heading. */
  bare?: boolean;
}) {
  const toast = useToast();
  const modal = useModal();
  const Shell = bare ? 'div' : Card;
  const [amount, setAmount] = useState(0);
  const [useMax, setUseMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ signature: string; lamports: number } | null>(null);

  const home = info.homeAddress;
  const balanceKnown = info.balanceSol != null;
  const max = maxWithdrawableSol(info.balanceSol);
  const effective = useMax ? (max ?? 0) : amount;

  const reason = unsavedHome
    ? `The withdrawal address above is not saved — press Save, or this would still go to ${home ? `${home.slice(0, 6)}…${home.slice(-4)}` : 'nowhere'}`
    : !home
    ? 'Set a withdrawal address first'
    : !balanceKnown
      ? 'Balance unknown — refresh and try again'
      : // Live being armed is the DEFAULT mode, so it is not a reason to
        // refuse: the engine queues a withdrawal behind any in-flight trade
        // (runLive chain), which is the race that actually matters.
        max !== null && max <= 0
          ? 'Nothing withdrawable — the balance is at the rent-exempt minimum'
          : !(effective > 0)
            ? 'Enter an amount'
            : max !== null && effective > max + 1e-12
              ? `Amount exceeds the ${max.toFixed(4)} SOL maximum`
              : null;

  const doWithdraw = async (): Promise<void> => {
    if (reason || !home) return;
    const lamports: number | 'max' = useMax ? 'max' : Math.floor(effective * LAMPORTS_PER_SOL);
    const shown = useMax ? `${(max ?? 0).toFixed(4)} SOL (max)` : `${effective.toFixed(4)} SOL`;
    const yes = await modal.confirm({
      title: 'Withdraw SOL',
      message: `Send ${shown} from the active trading wallet to:\n\n${home}\n\nThis is the confirmed withdrawal address. The transfer cannot be recalled.`,
      confirmLabel: 'Withdraw',
      destructive: true,
    });
    if (!yes) return;
    setBusy(true);
    const r = await window.krypt.wallet.withdraw({ lamports });
    setBusy(false);
    const d = r.data;
    if (r.ok && d?.ok) {
      if (d.signature) setLast({ signature: d.signature, lamports: d.lamports });
      toast.success(`Sent ${(d.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL${d.signature ? ` — ${d.signature.slice(0, 8)}…${d.signature.slice(-4)}` : ''} (${d.message})`);
      setAmount(0);
      setUseMax(false);
      onDone();
    } else {
      toast.error(d?.message ?? r.message);
      if (d?.signature) setLast({ signature: d.signature, lamports: d.lamports });
    }
  };

  return (
    <Shell className="space-y-2">
      {!bare && <div className="text-sm font-semibold text-white">Withdraw SOL</div>}
      <div className="text-xs text-krypt-muted">
        Send SOL from the active trading wallet to its withdrawal address. SOL only. To send a token, or to another address, use Send.
      </div>

      <div className="flex items-center gap-2 text-body">
        <span className="text-krypt-muted">To</span>
        <span className="font-mono text-white/85 truncate" title={home ?? undefined}>
          {home ?? '— no withdrawal address'}
        </span>
        <button onClick={onChangeAddress} className="text-krypt-purple hover:text-white text-label whitespace-nowrap">
          change
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NumberInput
          value={useMax ? (max ?? 0) : amount}
          min={0}
          max={max ?? undefined}
          suffix="SOL"
          className="w-36"
          onChange={(v) => { setUseMax(false); setAmount(v); }}
        />
        <span title={max === null ? 'Balance unknown' : `Max ${max.toFixed(4)} SOL`}>
          <GhostButton onClick={() => setUseMax(true)} disabled={max === null || max <= 0} className="!py-1.5 !px-3 text-xs">
            Max {max !== null ? max.toFixed(4) : '—'}
          </GhostButton>
        </span>
        <span title={reason ?? undefined}>
          <PrimaryButton onClick={() => void doWithdraw()} disabled={busy || reason !== null}>
            <ArrowUpRight className="h-3.5 w-3.5" /> {busy ? 'Sending…' : 'Withdraw'}
          </PrimaryButton>
        </span>
      </div>

      <div className="text-label text-krypt-muted/70">
        Balance {info.balanceSol != null ? `${info.balanceSol.toFixed(4)} SOL` : '—'}. Max leaves the
        {' '}{(RENT_EXEMPT_MIN_LAMPORTS / LAMPORTS_PER_SOL).toFixed(5)} SOL rent-exempt minimum plus
        {' '}{(WITHDRAW_FEE_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL).toFixed(5)} SOL fee headroom behind.
        {reason && <span className="ml-1 text-amber-300/90">{reason}.</span>}
      </div>

      {last && (
        <div className="flex items-center gap-2 text-body text-krypt-muted">
          <span>Last: {(last.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
          <span className="font-mono">{last.signature.slice(0, 8)}…{last.signature.slice(-4)}</span>
          <button
            onClick={() => void window.krypt.app.openExternal(`https://solscan.io/tx/${last.signature}`)}
            className="inline-flex items-center gap-1 text-krypt-purple hover:text-white"
          >
            <ExternalLink className="h-3 w-3" /> view on Solscan
          </button>
        </div>
      )}
    </Shell>
  );
}
