import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, ExternalLink, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import { EVM_CHAIN_META, EVM_CHAINS, explorerTx, VENUE_LABEL, walletVisibleOn, type EvmChainKind, type EvmFill, type EvmHolding, type EvmState, type EvmWalletSummary } from '@shared/evm';
import { Card, Copyable, GhostButton, PrimaryButton, Section } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { useEvmState } from '../../state/useEvmState';
import { useAppState } from '../../state/AppStateProvider';
import { cls, fmtClock, shortAddr } from '../../utils/format';
import { fmtNative, fmtTokens, isPendingResult, PENDING_TOAST, weiToNumber } from '../../utils/evm';

// The EVM wallet, on the Wallet page beside the Solana one. ONE list of keys
// serves Robinhood Chain and BNB Smart Chain — the same key is the same
// address on every EVM chain — but every wallet is MADE FOR the chain whose
// page made it, signs there, and is listed there. A key from before the
// chains were split (2026-09-11) belongs to both and is listed on both until
// the user says where it goes. Balances, Paper/Live, holdings and fills are
// per chain.
//
// Two shapes:
//
//   * Without `only`: both chains' balances and modes sit at the top and a
//     small tab picks which chain's holdings and fills the lower half shows.
//   * With `only`: every PER-CHAIN surface is pinned to that one chain (its
//     strip, its arming, its holdings, its fills) and the tab picker is gone,
//     because a single tab is noise. The Wallet page uses this to give each
//     chain its own panel.
//
// `showWallet` is how two per-chain panels avoid claiming to own the same
// key: exactly ONE of them renders the shared key block (generate / import /
// select / rename / remove and the deposit address), and the other says so in
// one line rather than silently dropping it. Which one is the caller's call —
// the first ENABLED chain — because a chain switched off in Settings has no
// panel at all.

const DEPOSIT_NOTE: Record<EvmChainKind, string> = {
  robinhood: 'Only ETH on Robinhood Chain (chain id 4663). Bridge at robinhood.com/chain/bridging. Start small — 0.01–0.05 ETH is plenty to test with.',
  bnb: 'Only BNB on BNB Smart Chain (chain id 56). Send from any exchange or wallet on the BSC network. Start small — 0.02–0.1 BNB is plenty to test with.',
};

/** Why a chain is in Paper when the user did not put it there. Solana's
 *  wallet card shows the same thing for the engine. */
const DISARM_REASON: Record<string, string> = {
  restart: 'Paper after restart — each EVM chain is armed by hand',
  no_wallet: 'Disarmed: no wallet',
  wallet_removed: 'Disarmed: the wallet was removed',
  kill_switch: 'Disarmed: kill switch',
  chain_disabled: 'Disarmed: chain turned off in Settings',
};

/** One chain's balance + Paper/Live pill for the active wallet. */
function ChainStrip({ chain, evm, refresh }: { chain: EvmChainKind; evm: EvmState | null; refresh: () => Promise<void> }) {
  const toast = useToast();
  const modal = useModal();
  const meta = EVM_CHAIN_META[chain];
  const armed = evm?.live.armed === true;
  const info = evm?.wallet ?? null;
  const reason = evm?.live.lastDisarmReason ?? null;
  const disarmNote = !armed && reason && reason !== 'user' ? DISARM_REASON[reason] ?? null : null;

  const setMode = async (wantLive: boolean): Promise<void> => {
    if (wantLive === armed) return;
    if (wantLive) {
      const yes = await modal.confirm({
        title: `Go Live on ${meta.name}`,
        message: `Live signs and broadcasts REAL transactions from the active EVM wallet on ${meta.name}. Real ${meta.nativeSymbol} moves. Switch to Live?`,
        confirmLabel: 'Go Live',
        destructive: true,
      });
      if (!yes) return;
      const r = await window.krypt.evm.arm(chain);
      r.ok ? toast.warn(r.message) : toast.error(r.message);
    } else {
      const r = await window.krypt.evm.disarm(chain);
      r.ok ? toast.success(r.message) : toast.error(r.message);
    }
    void refresh();
  };

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-label uppercase tracking-label text-krypt-muted">{meta.name}</div>
        <div className="mt-1 text-2xl font-bold font-mono text-white">
          {evm === null ? '…' : fmtNative(info?.balanceNative ?? null, meta.nativeSymbol, 5)}
        </div>
        {info?.balanceCheckedAt ? <div className="text-body text-krypt-muted/60">checked {fmtClock(info.balanceCheckedAt)}</div> : null}
        {disarmNote && <div className="text-body text-krypt-muted/70 mt-0.5">{disarmNote}</div>}
      </div>
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-white/12 overflow-hidden text-label font-bold uppercase tracking-label">
          <button
            onClick={() => void setMode(false)}
            className={cls('px-3 py-1.5 transition', !armed ? 'bg-emerald-500/20 text-emerald-200' : 'text-krypt-muted hover:text-white')}
          >
            Paper
          </button>
          <button
            onClick={() => void setMode(true)}
            className={cls('px-3 py-1.5 transition', armed ? 'bg-rose-500/25 text-rose-200 shadow-crimson-glow' : 'text-krypt-muted hover:text-white')}
          >
            Live
          </button>
        </div>
        <GhostButton onClick={() => void window.krypt.evm.wallet.refreshBalance(chain).then(() => void refresh())} className="!py-1.5 !px-3 text-xs">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </GhostButton>
      </div>
    </div>
  );
}

export function EvmWalletPanel({
  chain,
  only,
  showWallet = true,
}: {
  /** The chain to open on when `only` is not set — the top bar's chain. */
  chain?: EvmChainKind;
  /** Pin every per-chain surface to this chain and drop the tab picker. */
  only?: EvmChainKind;
  /** Render the shared key block. False = the other panel owns the key. */
  showWallet?: boolean;
}) {
  const toast = useToast();
  const modal = useModal();
  const { settings } = useAppState();
  const hood = useEvmState('robinhood');
  const bsc = useEvmState('bnb');
  // A chain switched off in Settings is hidden here too — its strip could
  // otherwise arm a chain that has no other surface, and its balance poll
  // kept hitting an RPC the user turned off. That holds for `only` as well:
  // a pinned chain the user turned off shows no strip and polls nothing.
  const shownChains = (only ? [only] : EVM_CHAINS).filter((c) => settings.evm[c].enabled);
  // What the panel opens on. `only` wins; otherwise the top bar's chain.
  const preferred: EvmChainKind = only ?? chain ?? 'robinhood';
  // There are exactly two EVM chains, so "the other one" is where the shared
  // key block lives whenever this panel is not the one rendering it.
  const otherChain: EvmChainKind = preferred === 'robinhood' ? 'bnb' : 'robinhood';
  const [tab, setTab] = useState<EvmChainKind>(preferred);
  const [wallets, setWallets] = useState<EvmWalletSummary[]>([]);
  const [holdings, setHoldings] = useState<EvmHolding[] | null>(null);
  const [sellingAll, setSellingAll] = useState(false);
  const [fills, setFills] = useState<EvmFill[]>([]);
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [selling, setSelling] = useState<string | null>(null);

  // The top bar's chain is the tab's default; the tab can look at the other
  // enabled one. Under `only` there is nothing to choose — shownChains is at
  // most that one chain, so this pins the tab to it.
  useEffect(() => {
    setTab(shownChains.includes(preferred) ? preferred : shownChains[0] ?? preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred, settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);

  const byChain: Record<EvmChainKind, { evm: EvmState | null; refresh: () => Promise<void> }> = { robinhood: hood, bnb: bsc };
  const current = byChain[tab];
  const armed = current.evm?.live.armed === true;
  // THIS chain's signer. A chain can now have no signer of its own while the
  // other chain has wallets (they were made for the other chain), so the
  // question is asked per tab, never "does any EVM wallet exist".
  const info = current.evm?.wallet ?? null;
  // null = the rail has not answered yet. Only a real answer may say there
  // is no wallet; a file that could not be READ says so in its own words.
  const loaded = current.evm !== null;
  const walletFailure = info?.failure ?? (hood.evm?.wallet ?? bsc.evm?.wallet)?.failure ?? null;
  const exists = info?.exists === true;
  const meta = EVM_CHAIN_META[tab];
  const otherOf = (c: EvmChainKind): EvmChainKind => (c === 'robinhood' ? 'bnb' : 'robinhood');
  const otherMeta = EVM_CHAIN_META[otherOf(tab)];
  // The pre-split state this panel exists to end: one key signing on both.
  const hoodId = hood.evm?.wallet?.id ?? null;
  const bscId = bsc.evm?.wallet?.id ?? null;
  const sharedSigner = hoodId !== null && hoodId === bscId && settings.evm.robinhood.enabled && settings.evm.bnb.enabled;
  // What this page lists, and what it deliberately does not.
  const visible = wallets.filter((w) => walletVisibleOn(w, tab));
  const hiddenFunded = wallets.filter((w) => !walletVisibleOn(w, tab) && (w.balanceNative ?? 0) > 0);

  const refreshAll = useCallback(async () => {
    await Promise.all([hood.refresh(), bsc.refresh()]);
  }, [hood, bsc]);

  const reload = useCallback(async () => {
    const [l, f] = await Promise.all([window.krypt.evm.wallet.list(tab), window.krypt.evm.fills(tab)]);
    if (l.ok && l.data) setWallets(l.data);
    if (f.ok && f.data) setFills(f.data.slice(-20).reverse());
    void refreshAll();
  }, [tab, refreshAll]);

  const loadHoldings = useCallback(async () => {
    const h = await window.krypt.evm.holdings(tab);
    if (h.ok && h.data) setHoldings(h.data);
  }, [tab]);

  useEffect(() => {
    setHoldings(null);
    setFills([]);
    void reload();
    if (exists) {
      void loadHoldings();
      for (const c of shownChains) void window.krypt.evm.wallet.refreshBalance(c).then(() => void byChain[c].refresh());
    }
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmFill' && ev.fill.chain === tab) {
        void reload();
        void loadHoldings();
      }
    });
    const t = setInterval(() => {
      if (document.hidden || !exists) return;
      for (const c of shownChains) void window.krypt.evm.wallet.refreshBalance(c).then(() => void byChain[c].refresh());
    }, 20_000);
    return () => {
      off();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exists, tab, settings.evm.robinhood.enabled, settings.evm.bnb.enabled]);

  // try/finally: a write that throws in main must not leave the buttons
  // spinning, and the user must be told rather than left with a silent
  // console error.
  const doGenerate = async (): Promise<void> => {
    setBusy(true);
    try {
      // Made for THIS chain; main says whether it signs here now.
      const r = await window.krypt.evm.wallet.generate(tab);
      if (r.ok) {
        toast.success(r.message);
        void reload();
      } else toast.error(r.message);
    } catch (err) {
      toast.error(`Wallet not saved: ${(err as Error).message}`);
      void reload();
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.evm.wallet.import(tab, importText.trim());
      if (r.ok) {
        setShowImport(false);
        setImportText('');
        toast.success(r.message);
        void reload();
      } else toast.error(r.message);
    } catch (err) {
      toast.error(`Wallet not saved: ${(err as Error).message}`);
      void reload();
    } finally {
      setBusy(false);
    }
  };

  const doSelect = async (id: string): Promise<void> => {
    const r = await window.krypt.evm.wallet.select(tab, id);
    r.ok ? toast.success(r.message) : toast.error(r.message);
    void reload();
  };

  /** A pre-split wallet leaves this page for the other chain's. The key is untouched. */
  const doAssignAway = async (w: EvmWalletSummary): Promise<void> => {
    const to = otherOf(tab);
    const r = await window.krypt.evm.wallet.assign(to, w.id);
    r.ok ? toast.success(`${w.label} now lives under ${EVM_CHAIN_META[to].shortName} Wallet`) : toast.error(r.message);
    void reload();
  };

  const doRename = async (id: string): Promise<void> => {
    const r = await window.krypt.evm.wallet.rename(tab, id, renameText);
    setRenaming(null);
    if (!r.ok) toast.error(r.message);
    void reload();
  };

  const doRemove = async (w: EvmWalletSummary): Promise<void> => {
    const yes = await modal.confirm({
      title: `Remove ${w.label}`,
      message: `This deletes the encrypted key for ${w.address.slice(0, 10)}… from this machine. It is the same key on Robinhood Chain AND BNB Smart Chain — if you have not exported it, anything in it on either chain is gone forever. Continue?`,
      confirmLabel: 'Remove wallet',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.evm.wallet.remove(tab, w.id);
    r.ok ? toast.success(r.message) : toast.error(r.message);
    void reload();
  };

  const doExport = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Export EVM wallets',
      message:
        'This writes the PRIVATE KEYS of every EVM wallet to a plain text file for MetaMask or Rabby. Anyone who gets that file can spend these wallets on every EVM chain. Save it offline and delete it when done. Continue?',
      confirmLabel: 'Export private keys',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.evm.wallet.exportAll();
    if (r.ok) toast.success(`Exported ${r.data?.count ?? ''} wallet(s) — delete that file once imported`);
    else toast.warn(r.message);
  };

  /**
   * Everything on this chain, in one go.
   *
   * Confirmed with the count and the chain named, because it is irreversible
   * and because "sell all" on a page with a chain switcher must never be
   * ambiguous about WHICH chain. The rail sells one at a time and does not
   * stop on a failure, so a partial result is normal and is reported as one.
   */
  const sellEverything = async (): Promise<void> => {
    const n = holdings?.filter((h) => h.amount > 0).length ?? 0;
    const yes = await modal.confirm({
      title: `Sell everything on ${meta.name}`,
      message: armed
        ? `Sell 100% of all ${n} position${n === 1 ? '' : 's'} back to ${meta.nativeSymbol}? This cannot be undone.`
        : `${meta.name} is in Paper, so nothing would be broadcast. Arm it first to actually sell.`,
      confirmLabel: armed ? `Sell all ${n}` : 'OK',
      destructive: armed,
    });
    if (!yes || !armed) return;
    setSellingAll(true);
    const r = await window.krypt.evm.sellAll(tab);
    setSellingAll(false);
    // A partial is a warning, not an error: what got out, got out.
    if (r.ok && r.data && r.data.results.some((x) => !x.ok)) toast.warn(r.message);
    else if (r.ok) toast.success(r.message);
    else toast.error(r.message);
    void loadHoldings();
  };

  const sellOne = async (h: EvmHolding): Promise<void> => {
    const yes = await modal.confirm({
      title: `Sell ${h.symbol || shortAddr(h.token, 4)} (100%)`,
      message: armed
        ? `Sell your entire balance of ${h.symbol || h.token} back to ${meta.nativeSymbol} on ${meta.name}?`
        : `Simulate selling your entire balance of ${h.symbol || h.token}? Nothing is broadcast in Paper.`,
      confirmLabel: armed ? 'Sell 100%' : 'Simulate',
      destructive: armed,
    });
    if (!yes) return;
    setSelling(h.token);
    const r = await window.krypt.evm.sell(tab, h.token, 100, !armed);
    setSelling(null);
    if (r.ok) toast.success(r.message);
    else if (isPendingResult(r)) toast.warn(PENDING_TOAST);
    else toast.error(r.message);
    void loadHoldings();
  };

  /**
   * Only THIS chain's arm state blocks changing THIS chain's signer.
   *
   * It used to be either chain, which was right while both shared one wallet:
   * a signer that changes identity under a live broadcast is the hazard the
   * Solana switcher refuses. Now that each chain has its own, an armed BNB has
   * nothing to say about who signs on Robinhood, and blocking it would be a
   * rule with no risk behind it. The rail enforces the same thing in main.
   */
  const tabArmed = byChain[tab].evm?.live.armed === true;

  const body = (
    <>
        {walletFailure ? (
          <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-300 flex-shrink-0 mt-0.5" />
            <p className="text-body text-rose-200 leading-relaxed">
              Wallet file could not be read — <span className="font-semibold">nothing was overwritten</span>. {walletFailure} Fix or move that
              file and restart; generating or importing is blocked until then so the existing keys stay safe.
            </p>
          </div>
        ) : !loaded ? (
          <div className="text-body text-krypt-muted">Reading wallet…</div>
        ) : !exists ? (
          !showWallet ? (
            <div className="text-body text-krypt-muted leading-relaxed">
              No {meta.name} wallet yet. Make one in the {EVM_CHAIN_META[otherChain].shortName} panel, or here once this panel owns the key block.
            </div>
          ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-krypt-purple/15 border border-krypt-purple/30 flex items-center justify-center">
                <KeyRound className="h-5 w-5 text-krypt-purple" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Generate a {meta.name} wallet</div>
                <div className="text-xs text-krypt-muted mt-0.5">
                  A fresh secp256k1 key made for {meta.name}, stored encrypted by {info?.encryptionAvailable ? 'your OS keystore (DPAPI)' : 'your OS'}. Your Solana wallet is never involved.
                  {wallets.length > 0 && ` ${wallets.length} other EVM wallet${wallets.length === 1 ? '' : 's'} on file belong to ${otherMeta.shortName}.`}
                </div>
              </div>
            </div>
            {info && !info.encryptionAvailable && (
              <div className="flex items-center gap-2 text-xs text-rose-300">
                <AlertTriangle className="h-4 w-4" /> OS secure storage is unavailable — generation is blocked to avoid storing a key unencrypted.
              </div>
            )}
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void doGenerate()} disabled={busy || !info?.encryptionAvailable}>
                <KeyRound className="h-4 w-4" /> Generate {meta.shortName} wallet
              </PrimaryButton>
              <GhostButton onClick={() => setShowImport((v) => !v)}>Import private key</GhostButton>
            </div>
          </>
          )
        ) : (
          <>
            <div className={cls('grid gap-3', shownChains.length > 1 ? 'lg:grid-cols-2' : '')}>
              {shownChains.map((c) => (
                <ChainStrip key={c} chain={c} evm={byChain[c].evm} refresh={byChain[c].refresh} />
              ))}
            </div>

            <div>
              {showWallet ? (
                <>
                  <div className="text-label uppercase tracking-label text-krypt-muted mb-1">Deposit address · {meta.name}</div>
                  <Copyable value={info?.address ?? ''} />
                  <div className="text-body text-krypt-muted/70 mt-1">{DEPOSIT_NOTE[tab]}</div>
                  {sharedSigner && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-300" />
                      <p className="text-body leading-relaxed text-amber-200">
                        Robinhood Chain and BNB Smart Chain are signing with the <span className="font-semibold">same key</span> — one from before the
                        chains were split. Press <span className="font-semibold">New {meta.shortName} wallet</span> below to give {meta.name} its own;{' '}
                        {otherMeta.shortName} keeps this one.
                      </p>
                    </div>
                  )}
                </>
              ) : (
                // Not an omission — say whose key this is and where it lives.
                <div className="text-body text-krypt-muted/70">
                  Same wallet as {EVM_CHAIN_META[otherChain].name} — one EVM key, the same address on both. Manage it (generate, import, switch,
                  rename, remove) in the {EVM_CHAIN_META[otherChain].shortName} panel. Deposits to that address arrive on {meta.name} too.
                </div>
              )}
              <div className="text-body text-krypt-muted/60 mt-1">
                Each EVM chain starts in Paper and is armed by hand; there are no per-trade or balance caps here yet. To move {meta.nativeSymbol} out,
                export the key and use MetaMask or Rabby — this page has no withdraw.
              </div>
            </div>

            {showWallet && (
            <>
            {/* One list of keys, one signer per chain, and each page lists
                the wallets made for its chain. A pre-split key (no home) is
                listed on both until the user assigns it. The dot means
                "signs on the chain in the tab above". */}
            <div className="mb-1.5 text-label leading-relaxed text-krypt-muted/70">
              The dot marks the wallet that signs on <span className="text-white/70">{meta.shortName}</span>. Wallets made here are{' '}
              {meta.shortName} wallets; {otherMeta.shortName} wallets live on their own page. A key from before the split shows on both until you
              say where it belongs.
            </div>
            <div className="space-y-1.5">
              {visible.map((w) => (
                <div
                  key={w.id}
                  className={cls(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 transition',
                    w.active ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/8 bg-white/[0.02] hover:border-white/20',
                  )}
                >
                  <button
                    onClick={() => {
                      if (!w.active) void doSelect(w.id);
                    }}
                    disabled={w.active || tabArmed}
                    title={
                      tabArmed
                        ? `Switch ${meta.shortName} to Paper to change its wallet`
                        : w.active
                          ? `Signs on ${meta.shortName}`
                          : `Make this the signing wallet on ${meta.shortName}`
                    }
                    className={cls(
                      'h-6 w-6 flex-shrink-0 rounded-full border flex items-center justify-center text-label',
                      w.active ? 'border-krypt-purple bg-krypt-purple/30 text-white' : 'border-white/20 text-krypt-muted hover:border-white/40',
                      tabArmed && !w.active ? 'opacity-40 cursor-not-allowed' : '',
                    )}
                  >
                    {w.active ? '●' : ''}
                  </button>
                  <div className="min-w-0 flex-1">
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
                        className="w-40 rounded bg-black/40 border border-white/15 px-2 py-0.5 text-note text-white outline-none"
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
                    <div className="font-mono text-label text-krypt-muted truncate">{w.address}</div>
                    {w.createdFor === null && (
                      <span
                        className="mt-0.5 inline-block rounded-full border border-white/10 bg-white/5 px-1.5 text-micro text-krypt-muted"
                        title="Made before the chains were split — the same address on both, listed on both until you say where it belongs"
                      >
                        pre-split · both chains
                      </span>
                    )}
                    {w.createdFor !== null && w.createdFor !== tab && (
                      <span className="mt-0.5 inline-block rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 text-micro text-amber-300" title={`Made for ${EVM_CHAIN_META[w.createdFor].name} but signing here`}>
                        made for {EVM_CHAIN_META[w.createdFor].shortName}
                      </span>
                    )}
                  </div>
                  <div className="text-right font-mono text-note text-white/85">{fmtNative(w.balanceNative, meta.nativeSymbol)}</div>
                  {w.createdFor === null && !w.active && (
                    <span title={`Keep this wallet under ${otherMeta.shortName} Wallet only — it leaves this page; the key and its balances are unchanged`}>
                      <GhostButton onClick={() => void doAssignAway(w)} className="!py-1 !px-2 text-label">
                        {otherMeta.shortName} only
                      </GhostButton>
                    </span>
                  )}
                  <GhostButton onClick={() => void doRemove(w)} destructive>
                    <Trash2 className="h-3.5 w-3.5" />
                  </GhostButton>
                </div>
              ))}
            </div>
            {hiddenFunded.length > 0 && (
              <div className="text-label leading-relaxed text-amber-300/90">
                {hiddenFunded.length} {otherMeta.shortName} wallet{hiddenFunded.length === 1 ? '' : 's'} also hold{hiddenFunded.length === 1 ? 's' : ''} {meta.nativeSymbol} on{' '}
                {meta.name}: {hiddenFunded.map((w) => `${shortAddr(w.address, 6)} (${fmtNative(w.balanceNative, meta.nativeSymbol)})`).join(', ')} — listed under{' '}
                {otherMeta.shortName} Wallet.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <span title={sharedSigner ? `Make a wallet for ${meta.name} and sign with it here` : `Make another ${meta.shortName} wallet`}>
                <GhostButton onClick={() => void doGenerate()} disabled={busy}>
                  <KeyRound className="h-3.5 w-3.5" /> New {meta.shortName} wallet
                </GhostButton>
              </span>
              <GhostButton onClick={() => setShowImport((v) => !v)}>
                <Download className="h-3.5 w-3.5" /> Import key
              </GhostButton>
              <GhostButton onClick={() => void doExport()}>
                <Download className="h-3.5 w-3.5" /> Export all (MetaMask)
              </GhostButton>
            </div>
            </>
            )}
          </>
        )}

        {showWallet && showImport && (
          <div className="space-y-2 pt-2 border-t border-white/10">
            <div className="flex items-center gap-2 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Importing a wallet you use elsewhere exposes it to an unattended app, on every EVM chain. Prefer generating a fresh one.
            </div>
            <div className="flex gap-2">
              <input
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="0x… private key (64 hex characters)"
                spellCheck={false}
                className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
              />
              <PrimaryButton onClick={() => void doImport()} disabled={busy || !importText.trim()}>
                Import
              </PrimaryButton>
            </div>
          </div>
        )}

        {exists && (
          <div className="pt-3 border-t border-white/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="text-xs font-semibold text-white">Holdings</div>
                {/* One tab is not a choice, it is decoration — and under
                    `only` there is by definition one. The rows below name the
                    chain in their own words either way. */}
                {shownChains.length > 1 && (
                  <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-micro font-bold uppercase tracking-label">
                    {shownChains.map((c) => (
                      <button
                        key={c}
                        onClick={() => setTab(c)}
                        className={cls(
                          'px-2 py-1 transition',
                          tab === c ? (c === 'robinhood' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-400/20 text-amber-200') : 'text-krypt-muted hover:text-white',
                        )}
                      >
                        {EVM_CHAIN_META[c].shortName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* The exit this chain did not have. Solana has had a
                    sell-everything since the beginning; holding five BNB
                    positions and selling them one at a time while the price
                    moves was the asymmetry this closes. */}
                {holdings !== null && holdings.some((h) => h.amount > 0) && (
                  <button
                    onClick={() => void sellEverything()}
                    disabled={sellingAll}
                    className="rounded-md border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 text-micro font-bold uppercase tracking-label text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
                    title={`Sell every position on ${meta.name}`}
                  >
                    {sellingAll ? 'Selling…' : 'Sell all'}
                  </button>
                )}
                <button onClick={() => void loadHoldings()} className="text-krypt-muted/60 hover:text-white" title="Refresh holdings">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
            </div>
            {holdings === null ? (
              <p className="text-body text-krypt-muted">Reading…</p>
            ) : holdings.length === 0 ? (
              <p className="text-body text-krypt-muted">No tokens held on {meta.name} that this app knows about. Tokens bought here appear automatically.</p>
            ) : (
              <div className="space-y-1">
                {holdings.map((h) => (
                  <div key={h.token} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-body hover:bg-white/[0.04] transition">
                    <span className="font-semibold text-white/90 w-20 truncate">{h.symbol || shortAddr(h.token, 4)}</span>
                    <span className="font-mono text-krypt-muted w-24 text-right">{fmtTokens(h.amount)}</span>
                    <span className="font-mono text-white/80 w-28 text-right">{fmtNative(h.valueNative, meta.nativeSymbol)}</span>
                    <span className="text-micro uppercase tracking-wider text-krypt-muted/60 flex-1 truncate">{VENUE_LABEL[h.venue]}</span>
                    <GhostButton onClick={() => void sellOne(h)} destructive disabled={selling !== null} className="!py-1 !px-2 text-label">
                      {selling === h.token ? '…' : armed ? 'Sell 100%' : 'Sim sell'}
                    </GhostButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {fills.length > 0 && (
          <div className="pt-3 border-t border-white/10">
            <div className="text-xs font-semibold text-white mb-2">Recent fills on {meta.name}</div>
            <div className="space-y-1">
              {fills.map((f) => {
                const delta = weiToNumber(f.nativeDeltaWei);
                return (
                  <div key={f.id} className="flex items-center gap-3 rounded-md px-2 py-1 text-body font-mono hover:bg-white/[0.04] transition">
                    <span className={cls('w-9 uppercase text-micro font-bold', f.side === 'buy' ? 'text-emerald-300' : 'text-rose-300')}>{f.side}</span>
                    <span className="text-white/85 w-20 truncate">{f.symbol || shortAddr(f.token, 4)}</span>
                    <span className="text-krypt-muted w-28 text-right">
                      {f.requested === 0 ? 'fee' : delta === null ? (f.state === 'pending' ? 'pending' : '—') : fmtNative(delta, meta.nativeSymbol, 5)}
                    </span>
                    <span className={cls('text-micro uppercase tracking-wider w-20', f.state === 'reconciled' ? 'text-krypt-muted/60' : f.state === 'pending' ? 'text-amber-300/80' : 'text-rose-300/80')}>
                      {f.state}
                    </span>
                    <span className="flex-1 text-right text-krypt-muted/60">{fmtClock(f.at)}</span>
                    <button onClick={() => void window.krypt.app.openExternal(explorerTx(tab, f.hash))} className="text-krypt-purple hover:text-white" title="View on the explorer">
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
    </>
  );

  // Under `only` the caller has already given this panel a title of its own
  // (the grid's header), so a Section heading here would just say the same
  // thing twice and the Card would draw a border inside a border.
  if (only) return <div className="space-y-4">{body}</div>;

  return (
    <Section
      title="EVM wallets — Robinhood Chain + BNB Smart Chain"
      description="Each chain signs with a wallet made for it, encrypted by your OS. A key is the same address on every EVM chain, so one list holds them all; balances, Paper/Live, holdings and fills are kept per chain."
    >
      <Card className="space-y-4">{body}</Card>
    </Section>
  );
}
