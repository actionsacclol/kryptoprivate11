// Funder — SOL from the active wallet to your other wallets, by group or
// hand-picked, and back again (2026-09-03). Twelve transfers per transaction
// on the way out (a bigger set goes in batches, each counted only once it
// has confirmed); one transaction per wallet on the way back. The signer
// only ever sends to wallets this install holds.

import { useMemo, useState } from 'react';
import { planFund } from '@shared/lab';
import { Card, GhostButton, NumberInput, Page, PrimaryButton, Section } from '../../components/common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls, fmtSol } from '../../utils/format';
import { RealMoneyBanner, ScopePicker, selectCls, tooMany, useLabData, useScope } from './shared';

export function FunderPage({ onOpenToken: _onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const modal = useModal();
  const data = useLabData();
  const { wallets, armed, armedReason, active, labelOf, busy, setBusy, refreshBalances } = data;

  // ── Fund ─────────────────────────────────────────────────────────────
  const fundScope = useScope(data);
  const [fundMode, setFundMode] = useState<'each' | 'total'>('each');
  const [fundSol, setFundSol] = useState(0.01);
  const [fundResult, setFundResult] = useState<string | null>(null);
  const fundTargets = useMemo(
    () =>
      fundScope.walletIds
        .map((id) => wallets.find((w) => w.id === id))
        .filter((w): w is NonNullable<typeof w> => !!w)
        .map((w) => ({ walletId: w.id, publicKey: w.publicKey })),
    [fundScope.walletIds, wallets],
  );
  const fundPlan = useMemo(() => planFund(fundTargets, fundMode, fundSol, active?.balanceSol ?? null), [fundTargets, fundMode, fundSol, active]);

  const fundTooMany = tooMany(fundTargets.length);

  const doFund = async (): Promise<void> => {
    if (busy) return; // the confirm dialog must not stack a second send
    if (!fundPlan.ok) return toast.error(fundPlan.message);
    if (fundTooMany) return toast.error(fundTooMany);
    setBusy('fund');
    const yes = await modal.confirm({
      title: 'Fund wallets from the active wallet',
      message: `This sends REAL SOL: ${fundPlan.message}, ${fmtSol(fundPlan.totalLamports / 1e9)} SOL total from ${active?.label ?? 'the active wallet'}. Cannot be undone.`,
      confirmLabel: 'Send',
      destructive: true,
    });
    if (!yes) {
      setBusy(null);
      return;
    }
    setFundResult(null);
    try {
      const r = await window.krypt.lab.fund(fundPlan.targets.map((t) => ({ walletId: t.walletId, sol: t.sol })));
      if (r.ok && r.data) {
        setFundResult(`Sent ${fmtSol(r.data.sentSol)} SOL to ${r.data.count} wallet${r.data.count === 1 ? '' : 's'} · ${r.data.signature.slice(0, 16)}…`);
        toast.success(r.message);
      } else {
        // A partial outcome still says what DID leave, with its signature.
        const d = r.data;
        setFundResult(d && d.count > 0 ? `${r.message} — ${fmtSol(d.sentSol)} SOL reached ${d.count} wallet${d.count === 1 ? '' : 's'}${d.signature ? ` · ${d.signature.slice(0, 16)}…` : ''}` : r.message);
        toast.error(r.message);
      }
      await refreshBalances();
    } finally {
      setBusy(null);
    }
  };

  // ── Collect ──────────────────────────────────────────────────────────
  const collectScope = useScope(data);
  const [collectResults, setCollectResults] = useState<Array<{ walletId: string; ok: boolean; message: string; sol: number; signature: string | null }> | null>(null);

  const collectTooMany = tooMany(collectScope.walletIds.length);

  const doCollect = async (): Promise<void> => {
    if (busy) return;
    const ids = collectScope.walletIds;
    if (!ids.length) return toast.error('No wallets to collect from');
    if (collectTooMany) return toast.error(collectTooMany);
    setBusy('collect');
    const yes = await modal.confirm({
      title: 'Collect back to the active wallet',
      message: `${ids.length} wallet${ids.length === 1 ? '' : 's'} will each send their spare SOL (everything above rent and fee headroom) to ${active?.label ?? 'the active wallet'}. Tokens they hold are not touched. One transaction per wallet.`,
      confirmLabel: 'Collect',
      destructive: true,
    });
    if (!yes) {
      setBusy(null);
      return;
    }
    setCollectResults(null);
    try {
      const r = await window.krypt.lab.collect(ids);
      if (r.ok && r.data) {
        setCollectResults(r.data);
        const okN = r.data.filter((x) => x.ok).length;
        toast[okN === r.data.length ? 'success' : 'warn'](`${okN}/${r.data.length} wallets collected`);
        await refreshBalances();
      } else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page
      title="Funder"
      subtitle={`source: ${active?.label ?? '—'} · ${active?.balanceSol != null ? `${active.balanceSol.toFixed(4)} SOL` : 'balance unknown'}`}
      actions={
        <GhostButton onClick={() => void refreshBalances()} disabled={busy === 'refresh'}>
          Refresh balances
        </GhostButton>
      }
    >
      <RealMoneyBanner armed={armed} what="Funding and collecting are plain transfers to and from wallets this install holds — the signer refuses any other destination." />

      <Section
        title="Fund from the active wallet"
        description="Transfers from the active wallet to every selected wallet, twelve per transaction. Each target must end up rent-exempt (about 0.0009 SOL) or that transaction reverts; a batch counts only once it has confirmed on chain."
      >
        <Card>
          <ScopePicker data={data} scope={fundScope} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select value={fundMode} onChange={(e) => setFundMode(e.target.value as 'each' | 'total')} className={selectCls}>
              <option value="each">SOL to each wallet</option>
              <option value="total">Total, split evenly</option>
            </select>
            <NumberInput value={fundSol} min={0.001} max={100} onChange={setFundSol} suffix="SOL" className="w-32" />
            <PrimaryButton onClick={() => void doFund()} disabled={!armed || !fundPlan.ok || !!fundTooMany || busy !== null} className="!py-1.5">
              Fund {fundTargets.length} wallet{fundTargets.length === 1 ? '' : 's'}
            </PrimaryButton>
          </div>
          <div className={cls('mt-2 text-[11px]', fundPlan.ok ? 'text-krypt-muted' : 'text-rose-300')}>
            {fundPlan.ok
              ? `${fundPlan.message} = ${fmtSol(fundPlan.totalLamports / 1e9)} SOL total · source has ${active?.balanceSol != null ? `${active.balanceSol.toFixed(4)} SOL` : 'an unknown balance'}`
              : fundPlan.message}
            {armedReason && <span className="block text-arc-gold">{armedReason}</span>}
            {fundTooMany && <span className="block text-arc-gold">{fundTooMany}</span>}
          </div>
          {fundResult && <div className="mt-2 text-[11px] font-mono text-white/80">{fundResult}</div>}
        </Card>
      </Section>

      <Section
        title="Collect back to the active wallet"
        description="Each selected wallet sends everything above rent and fee headroom back to the active wallet. Tokens are not touched — sell them first from the Copier page or the token page."
      >
        <Card>
          <ScopePicker data={data} scope={collectScope} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <GhostButton onClick={() => void doCollect()} disabled={!armed || busy !== null || !!collectTooMany || collectScope.walletIds.length === 0}>
              Collect spare SOL from {collectScope.walletIds.length} wallet{collectScope.walletIds.length === 1 ? '' : 's'}
            </GhostButton>
            {armedReason && <span className="text-[11px] text-arc-gold">{armedReason}</span>}
            {collectTooMany && <span className="text-[11px] text-arc-gold">{collectTooMany}</span>}
          </div>
          {collectResults && (
            <div className="mt-2 space-y-0.5 text-[11px] font-mono">
              {collectResults.map((r) => (
                <div key={r.walletId} className={r.ok ? 'text-emerald-300/90' : 'text-rose-300/90'}>
                  {labelOf.get(r.walletId) ?? r.walletId}: {r.ok ? `sent ${fmtSol(r.sol)} SOL` : r.message}
                  {r.signature ? ` · ${r.signature.slice(0, 12)}…` : ''}
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    </Page>
  );
}
