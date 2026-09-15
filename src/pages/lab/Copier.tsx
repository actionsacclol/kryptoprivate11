// Copier — a group follows the main (active) wallet's manual trades, and
// manual orders placed on a whole group at once (2026-09-03). Every leg is
// a normal signed trade per wallet: simulation, loss guard, platform fee.

import { useEffect, useState } from 'react';
import { DEFAULT_FOLLOW, validateFollow, type FollowSettings } from '@shared/lab';
import type { WalletGroupView } from '@shared/types';
import { Badge, Card, Empty, GhostButton, NumberInput, Page, PrimaryButton, Section, Switch } from '../../components/common';
import { useModal } from '../../state/ModalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';
import { RealMoneyBanner, Row, inputCls, selectCls, tooMany, useLabData } from './shared';

type OrderResult = { walletId: string; ok: boolean; message: string; signature: string | null };

export function CopierPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const modal = useModal();
  const data = useLabData();
  const { groups, armed, armedReason, active, labelOf, busy, setBusy, applyGroups } = data;

  // ── Follow ───────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<Record<string, FollowSettings>>({});
  const followFor = (g: WalletGroupView): FollowSettings => draft[g.id] ?? g.lab?.follow ?? { ...DEFAULT_FOLLOW };
  // Built from the updater's argument, so two patches in one tick both land.
  const patch = (g: WalletGroupView, p: Partial<FollowSettings>): void =>
    setDraft((cur) => ({ ...cur, [g.id]: { ...(cur[g.id] ?? g.lab?.follow ?? { ...DEFAULT_FOLLOW }), ...p } }));
  const save = async (g: WalletGroupView): Promise<void> => {
    const cfg = followFor(g);
    const v = validateFollow(cfg);
    // The page shows the ratio as a percentage; say it in the same units.
    if (!v.ok) return toast.error(v.message.startsWith('ratio') ? 'Size must be between 1 % and 500 % of your trade' : v.message);
    const r = await window.krypt.lab.setFollow(g.id, cfg);
    applyGroups(r);
    if (r.ok) {
      toast.success(`Copier settings saved for ${g.name}`);
      setDraft((cur) => {
        const next = { ...cur };
        delete next[g.id];
        return next;
      });
    }
  };

  // ── Manual group orders ──────────────────────────────────────────────
  const [orderGroup, setOrderGroup] = useState<string>('');
  const [mint, setMint] = useState('');
  const [buyMode, setBuyMode] = useState<'same' | 'total'>('same');
  const [buySol, setBuySol] = useState(0.01);
  const [stagger, setStagger] = useState(500);
  const [results, setResults] = useState<{ kind: 'buy' | 'sell'; rows: OrderResult[] } | null>(null);
  // The engine caps the group TOTAL at the per-trade cap; checked before the
  // "REAL SOL" confirm rather than after it.
  const [cap, setCap] = useState<number | null>(null);
  useEffect(() => {
    void window.krypt.settings.get().then((r) => {
      if (r.ok && r.data) setCap(r.data.execution.maxLiveSol);
    });
  }, []);
  const og = groups.find((g) => g.id === orderGroup) ?? null;
  const orderWallets = (og?.members ?? []).filter((m) => m.id !== active?.id).map((m) => m.id);
  const mintOk = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint.trim());
  const orderTooMany = tooMany(orderWallets.length);

  const doBuy = async (): Promise<void> => {
    if (busy || !og || !mintOk) return;
    if (orderTooMany) return toast.error(orderTooMany);
    const total = buyMode === 'same' ? buySol * orderWallets.length : buySol;
    if (cap !== null && total > cap) {
      return toast.error(`Group total ${total.toFixed(3)} SOL is above your ${cap} SOL per-trade cap — lower the amount, or raise the cap on the Wallet page.`);
    }
    setBusy('buy');
    const yes = await modal.confirm({
      title: `Buy with “${og.name}”`,
      message: `${orderWallets.length} wallet${orderWallets.length === 1 ? '' : 's'} will buy ${mint.trim().slice(0, 8)}… — ${buyMode === 'same' ? `${buySol} SOL each` : `${buySol} SOL total, split evenly`} — REAL SOL, one signed trade per wallet with the platform fee.`,
      confirmLabel: 'Buy',
      destructive: true,
    });
    if (!yes) {
      setBusy(null);
      return;
    }
    setResults(null);
    try {
      const r = await window.krypt.live.fanoutBuy(mint.trim(), orderWallets, { mode: buyMode, amountSol: buySol }, { staggerMaxMs: stagger });
      const rows = (r.data?.results ?? []).map((x) => ({ walletId: x.walletId, ok: x.ok, message: x.message, signature: x.signature }));
      setResults({ kind: 'buy', rows });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  const doSell = async (): Promise<void> => {
    if (busy || !og || !mintOk) return;
    if (orderTooMany) return toast.error(orderTooMany);
    setBusy('sell');
    const yes = await modal.confirm({
      title: `Sell 100 % with “${og.name}”`,
      message: `${orderWallets.length} wallet${orderWallets.length === 1 ? '' : 's'} will each sell their whole bag of ${mint.trim().slice(0, 8)}… — one signed trade per wallet with the platform fee. A wallet that holds none simply reports nothing to sell.`,
      confirmLabel: 'Sell all',
      destructive: true,
    });
    if (!yes) {
      setBusy(null);
      return;
    }
    setResults(null);
    try {
      const r = await window.krypt.live.fanoutSell(mint.trim(), orderWallets, { staggerMaxMs: stagger });
      setResults({ kind: 'sell', rows: r.data?.results ?? [] });
      // Partial is not success: the rows say which wallet did not land.
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };

  const followingCount = groups.filter((g) => g.lab?.follow?.enabled).length;

  return (
    <Page
      title="Copier"
      subtitle={`main wallet: ${active?.label ?? '—'} · ${followingCount} group${followingCount === 1 ? '' : 's'} following`}
    >
      <RealMoneyBanner armed={armed} what="Following repeats your manual trades on other wallets; group orders place one trade per wallet." />

      <Section
        title="Follow the main wallet"
        description="When you place a manual buy or sell with the active wallet, every member of an enabled group (except the active wallet) repeats it after its own random delay — buys at a percentage of your size or an exact amount (never above your per-trade cap), sells the same share of its bag that you sold. A follower whose balance cannot cover the size sits out, and one toast reports how the legs went."
      >
        {groups.length === 0 ? (
          <Empty title="No groups" message="Create a group and some wallets in Group Wallets first." />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {groups.map((g) => {
              const f = followFor(g);
              const dirty = !!draft[g.id];
              const followers = g.members.filter((m) => m.id !== active?.id).length;
              return (
                <Card key={g.id}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-value font-semibold text-white">{g.name}</span>
                    <span className="text-label font-mono text-krypt-muted">{followers} follower{followers === 1 ? '' : 's'}</span>
                    {g.lab?.follow?.enabled && !dirty && <Badge tone="success">following</Badge>}
                    <div className="flex-1" />
                    <PrimaryButton onClick={() => void save(g)} disabled={!dirty} className="!py-1">Save</PrimaryButton>
                  </div>
                  <div className="grid gap-2">
                    <Switch checked={f.enabled} onChange={(v) => patch(g, { enabled: v })} label="Follow the main wallet" description="Buys and (optionally) sells" />
                    <Row label="Copy delay" hint="Random, milliseconds, per follower">
                      <div className="flex items-center gap-1.5">
                        <NumberInput value={f.delayMinMs} min={0} max={120000} onChange={(v) => patch(g, { delayMinMs: v })} className="w-24" />
                        <span className="text-krypt-muted text-xs">to</span>
                        <NumberInput value={f.delayMaxMs} min={0} max={120000} onChange={(v) => patch(g, { delayMaxMs: v })} className="w-24" />
                      </div>
                    </Row>
                    <Row label="Size" hint={f.sizeMode === 'ratio' ? 'Percentage of the main wallet’s trade size' : 'Exact SOL per follower'}>
                      <div className="flex items-center gap-1.5">
                        <select value={f.sizeMode} onChange={(e) => patch(g, { sizeMode: e.target.value as 'ratio' | 'fixed' })} className={selectCls}>
                          <option value="ratio">wallet % scale</option>
                          <option value="fixed">exact amount</option>
                        </select>
                        {f.sizeMode === 'ratio' ? (
                          <NumberInput value={Math.round(f.ratio * 100)} min={1} max={500} onChange={(v) => patch(g, { ratio: v / 100 })} suffix="%" className="w-24" />
                        ) : (
                          <NumberInput value={f.fixedSol} min={0.001} max={5} onChange={(v) => patch(g, { fixedSol: v })} suffix="SOL" className="w-28" />
                        )}
                      </div>
                    </Row>
                    <Row label="Max per follower buy" hint="Hard cap, SOL">
                      <NumberInput value={f.maxTradeSol} min={0.001} max={5} onChange={(v) => patch(g, { maxTradeSol: v })} suffix="SOL" className="w-28" />
                    </Row>
                    <Switch checked={f.followSells} onChange={(v) => patch(g, { followSells: v })} label="Copy sells" description="Followers sell the same share of their bag that you sell (25 % → 25 %)" />
                  </div>
                  {!armed && <div className="mt-2 text-body text-arc-gold">Following only fires while live execution is armed.</div>}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Manual orders with a group"
        description="Place one buy or one sell on every wallet of a group at once. Paste a mint; buys are sized per wallet or as a total split evenly; sells go at 100 % of each wallet's bag."
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <select value={orderGroup} onChange={(e) => setOrderGroup(e.target.value)} className={selectCls}>
              <option value="">— choose a group —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.members.filter((m) => m.id !== active?.id).length})
                </option>
              ))}
            </select>
            <input
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              placeholder="token mint address"
              spellCheck={false}
              className={cls(inputCls, 'w-[26rem] font-mono')}
            />
            {mintOk && (
              <GhostButton onClick={() => onOpenToken(mint.trim())}>Open token</GhostButton>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select value={buyMode} onChange={(e) => setBuyMode(e.target.value as 'same' | 'total')} className={selectCls}>
              <option value="same">SOL per wallet</option>
              <option value="total">Total, split evenly</option>
            </select>
            <NumberInput value={buySol} min={0.001} max={50} onChange={setBuySol} suffix="SOL" className="w-32" />
            <span className="text-body text-krypt-muted">stagger up to</span>
            <NumberInput value={stagger} min={0} max={3000} onChange={setStagger} suffix="ms" className="w-28" />
            <div className="flex-1" />
            <PrimaryButton onClick={() => void doBuy()} disabled={!armed || !og || !mintOk || !!orderTooMany || orderWallets.length === 0 || busy !== null} className="!py-1.5">
              Buy with {orderWallets.length} wallet{orderWallets.length === 1 ? '' : 's'}
            </PrimaryButton>
            <GhostButton onClick={() => void doSell()} disabled={!armed || !og || !mintOk || !!orderTooMany || orderWallets.length === 0 || busy !== null} destructive>
              Sell 100 % on {orderWallets.length}
            </GhostButton>
          </div>
          {armedReason && <div className="mt-2 text-body text-arc-gold">{armedReason}</div>}
          {orderTooMany && <div className="mt-2 text-body text-arc-gold">{orderTooMany}</div>}
          {mint.trim() && !mintOk && <div className="mt-2 text-body text-rose-300">That is not a mint address (32–44 base58 characters).</div>}
          {results && (
            <div className="mt-3 space-y-0.5 text-body font-mono">
              <div className="text-krypt-muted">{results.kind === 'buy' ? 'Buy' : 'Sell'} results</div>
              {results.rows.map((r) => (
                <div key={r.walletId} className={r.ok ? 'text-emerald-300/90' : 'text-rose-300/90'}>
                  {labelOf.get(r.walletId) ?? r.walletId}: {r.ok ? 'landed' : r.message.slice(0, 140)}
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
