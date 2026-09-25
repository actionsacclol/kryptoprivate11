// "Reset paper trades" — one button, used where paper piles up: Portfolio
// (where paper rows sit with the real ones) and Scripts (where testing makes
// most of them). User ask, 2026-09-24: "it can get messy when testing scripts".
//
// Clears the paper book on every chain and starts every PAPER script over.
// Live trades, live scripts and copy trading's own paper record are not
// touched; copy trading has its own reset on its page.

import { Eraser } from 'lucide-react';
import { GhostButton } from './common';
import { useModal } from '../state/ModalProvider';
import { useToast } from '../state/ToastProvider';

export function ResetPaperButton({ onDone, className }: { onDone?: () => void; className?: string }) {
  const modal = useModal();
  const toast = useToast();
  const run = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Reset paper trades',
      message:
        'Clear every paper position and every closed paper trade, on every chain, and start each paper script over (its positions, buys today and loss today)?\n\n' +
        'Kept: live trades, live scripts, your settings, and copy trading’s paper record (it has its own reset). ' +
        'A copy of the old paper record is saved as paper-positions.backup.json in the app’s data folder.',
      confirmLabel: 'Reset paper trades',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.portfolio.resetPaper();
    if (r.ok) {
      toast.success(r.message);
      onDone?.();
    } else toast.error(r.message);
  };
  return (
    <GhostButton onClick={() => void run()} className={className ?? '!py-2 !px-3 text-xs'}>
      <Eraser className="h-3.5 w-3.5" />
      Reset paper trades
    </GhostButton>
  );
}
