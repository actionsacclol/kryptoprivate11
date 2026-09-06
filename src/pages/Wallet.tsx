import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertTriangle, ArrowUpRight, Copy, Download, ExternalLink, FlaskConical, KeyRound, RefreshCw, ShieldAlert, Trash2, Wallet as WalletIcon, Zap } from 'lucide-react';
import { Badge, Card, GhostButton, NumberInput, Page, PrimaryButton, Section, Switch } from '../components/common';
import { Tome3D } from '../components/viz/Tome3D';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { useAppState } from '../state/AppStateProvider';
import { SwitchToPaper } from '../components/SwitchToPaper';
import { FanoutPanel } from '../components/terminal/FanoutPanel';
import type { LiveState, WalletInfo, WalletSummary } from '@shared/types';
import { cls, fmtClock } from '../utils/format';

function LiveExecutionPanel({ armed, balanceSol }: { armed: boolean; balanceSol: number | null }) {
  const { settings, updateSettings } = useAppState();
  const toast = useToast();
  const modal = useModal();
  const e = settings.execution;
  // ONE mode: Live when armed AND broadcast on, else Paper. The Paper/Live
  // switch lives in the top bar; this panel just follows it.
  const isLive = armed && e.liveEnabled;
  const [mint, setMint] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [sellMint, setSellMint] = useState('');
  const [busy, setBusy] = useState<'sim' | 'real' | 'sell' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; stage: string; message: string } | null>(null);

  const doSell = async (): Promise<void> => {
    if (sellMint.trim().length < 32) { toast.error('Enter a valid mint to sell'); return; }
    const yes = await modal.confirm({
      title: 'Sell token (100%)',
      message: `Sell your entire balance of ${sellMint.slice(0, 8)}… back to SOL?`,
      confirmLabel: 'Sell 100%',
      destructive: true,
    });
    if (!yes) return;
    setBusy('sell');
    setResult(null);
    const r = await window.krypt.live.sellToken(sellMint.trim());
    setBusy(null);
    const data = r.data ?? { ok: r.ok, stage: '?', message: r.message };
    setResult(data);
    if (data.ok) { toast.success('Sell sent'); setSellMint(''); }
    else toast.warn(data.message);
  };

  const run = async (simulateOnly: boolean): Promise<void> => {
    const sol = Number(amount);
    if (mint.trim().length < 32) { toast.error('Enter a valid mint address'); return; }
    if (!(sol > 0)) { toast.error('Enter a positive SOL amount'); return; }
    // No per-buy confirm — going Live is the deliberate gate (top bar). Every
    // buy is still simulated and loss-bounded before it signs.
    setBusy(simulateOnly ? 'sim' : 'real');
    setResult(null);
    const r = await window.krypt.live.testTrade(mint.trim(), sol, simulateOnly);
    setBusy(null);
    const data = r.data ?? { ok: r.ok, stage: '?', message: r.message };
    setResult(data);
    if (data.ok) toast.success(simulateOnly ? 'Paper buy simulated' : 'Buy sent');
    else toast.warn(data.message);
  };

  return (
    <Section title="Live execution" description="Real trades via a maintained relayer; every transaction is simulated and loss-bounded before your key signs it.">
      <Card className="space-y-4">
        {e.liveEnabled && armed && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-center gap-2 text-xs text-amber-200">
            <Zap className="h-4 w-4 flex-shrink-0" />
            <span><span className="font-semibold">Real broadcast is ON.</span> Trades you place by hand spend exactly what you enter; the {e.maxLiveSol} SOL per-trade cap bounds advanced orders, copy trade and fan-out. The bot never opens a position on its own — every real trade is one you initiate.</span>
          </div>
        )}
        <div className="grid lg:grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <div className="text-sm font-semibold text-white mb-1">Max SOL / trade</div>
            <NumberInput
              value={e.maxLiveSol}
              onChange={(n) => void updateSettings({ execution: { ...e, maxLiveSol: n } })}
              suffix="SOL"
              warn={(n) => (n <= 0 ? 'Must be greater than 0' : n > 1 ? 'Large per-trade cap — sure?' : null)}
            />
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <div className="text-sm font-semibold text-white mb-1">Slippage %</div>
            <NumberInput
              value={e.liveSlippagePct}
              onChange={(n) => void updateSettings({ execution: { ...e, liveSlippagePct: n } })}
              suffix="%"
              warn={(n) => (n <= 0 ? 'Must be greater than 0' : n > 50 ? 'Very high slippage' : null)}
            />
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <FlaskConical className="h-4 w-4 text-krypt-purple" /> Quick buy by mint
          </div>
          <p className="text-xs text-krypt-muted">
            Paste a token mint and buy it. In <span className="text-emerald-300">Paper</span> mode it simulates; in{' '}
            <span className="text-rose-300">Live</span> mode it spends real SOL. Switch modes in the top bar.
          </p>
          <div className="flex flex-wrap gap-2">
            <input value={mint} onChange={(ev) => setMint(ev.target.value)} placeholder="Token mint address" spellCheck={false}
              className="flex-1 min-w-[240px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60" />
            <input value={amount} onChange={(ev) => setAmount(ev.target.value)} inputMode="decimal"
              className="w-24 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white outline-none focus:border-krypt-purple/60" />
            <span className="self-center text-xs text-krypt-muted">SOL</span>
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={() => void run(!isLive)} disabled={busy !== null}>
              <Zap className="h-4 w-4" />
              {busy ? (isLive ? 'Sending…' : 'Simulating…') : isLive ? `Buy ${amount} SOL` : `Paper buy ${amount} SOL`}
            </PrimaryButton>
          </div>
          {result && (
            <div className={cls('rounded-lg border px-3 py-2 text-xs font-mono', result.ok ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' : 'border-rose-400/30 bg-rose-500/10 text-rose-200')}>
              [{result.stage}] {result.message}
            </div>
          )}
          <div className="pt-2 border-t border-white/10 space-y-2">
            <div className="text-xs font-semibold text-white">Sell a token (100%)</div>
            <div className="text-[11px] text-krypt-muted">Liquidate a leftover or dust position back to SOL. Needs real broadcast on.</div>
            <div className="flex flex-wrap gap-2">
              <input value={sellMint} onChange={(ev) => setSellMint(ev.target.value)} placeholder="Token mint to sell" spellCheck={false}
                className="flex-1 min-w-[240px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60" />
              <GhostButton destructive onClick={() => void doSell()} disabled={busy !== null || !e.liveEnabled}>
                {busy === 'sell' ? 'Selling…' : 'Sell 100%'}
              </GhostButton>
            </div>
          </div>
          {balanceSol !== null && balanceSol < 0.02 && (
            <div className="flex items-center gap-2 text-[11px] text-amber-300"><AlertTriangle className="h-3.5 w-3.5" /> Low balance — fund the wallet before a real buy.</div>
          )}
        </div>
      </Card>
    </Section>
  );
}

function Copyable({ value }: { value: string }) {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value);
        toast.success('Copied');
      }}
      className="group inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white hover:border-krypt-purple/40 transition w-full"
    >
      <span className="truncate">{value}</span>
      <Copy className="h-3.5 w-3.5 text-krypt-muted group-hover:text-krypt-purple flex-shrink-0 ml-auto" />
    </button>
  );
}

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
function WithdrawPanel({
  info,
  onDone,
  onChangeAddress,
}: {
  info: WalletInfo;
  onDone: () => void;
  onChangeAddress: () => void;
}) {
  const toast = useToast();
  const modal = useModal();
  const [amount, setAmount] = useState(0);
  const [useMax, setUseMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ signature: string; lamports: number } | null>(null);

  const home = info.homeAddress;
  const balanceKnown = info.balanceSol != null;
  const max = maxWithdrawableSol(info.balanceSol);
  const effective = useMax ? (max ?? 0) : amount;

  const reason = !home
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
    <Card className="space-y-2">
      <div className="text-sm font-semibold text-white">Withdraw SOL</div>
      <div className="text-xs text-krypt-muted">
        Send SOL from the active trading wallet to its withdrawal address. SOL only — SPL tokens are not sent here; sell them first or export the key.
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-krypt-muted">To</span>
        <span className="font-mono text-white/85 truncate" title={home ?? undefined}>
          {home ?? '— no withdrawal address'}
        </span>
        <button onClick={onChangeAddress} className="text-krypt-purple hover:text-white text-[10px] whitespace-nowrap">
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

      <div className="text-[10px] text-krypt-muted/70">
        Balance {info.balanceSol != null ? `${info.balanceSol.toFixed(4)} SOL` : '—'}. Max leaves the
        {' '}{(RENT_EXEMPT_MIN_LAMPORTS / LAMPORTS_PER_SOL).toFixed(5)} SOL rent-exempt minimum plus
        {' '}{(WITHDRAW_FEE_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL).toFixed(5)} SOL fee headroom behind.
        {reason && <span className="ml-1 text-amber-300/90">{reason}.</span>}
      </div>

      {last && (
        <div className="flex items-center gap-2 text-[11px] text-krypt-muted">
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
    </Card>
  );
}

export function WalletPage() {
  const toast = useToast();
  const modal = useModal();
  const { settings, updateSettings } = useAppState();
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [live, setLive] = useState<LiveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [homeInput, setHomeInput] = useState('');
  const [capInput, setCapInput] = useState('');
  const homeInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [w, l, list] = await Promise.all([
      window.krypt.wallet.info(),
      window.krypt.live.state(),
      window.krypt.wallet.list(),
    ]);
    if (w.ok && w.data) setInfo(w.data);
    if (l.ok && l.data) setLive(l.data);
    if (list.ok && list.data) setWallets(list.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (info?.exists) {
      setHomeInput(info.homeAddress ?? '');
      setCapInput(String(info.maxBalanceSol));
      const t = setInterval(() => void window.krypt.wallet.refreshBalance().then((r) => { if (r.ok && r.data) setInfo(r.data); }), 20_000);
      void window.krypt.wallet.refreshBalance().then((r) => { if (r.ok && r.data) setInfo(r.data); });
      return () => clearInterval(t);
    }
  }, [info?.exists]);

  const doGenerate = async (): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.wallet.generate();
    setBusy(false);
    if (r.ok && r.data) { setInfo(r.data); void refresh(); toast.success('Trading wallet generated — back it up now'); }
    else toast.error(r.message);
  };

  const doSelect = async (id: string): Promise<void> => {
    const r = await window.krypt.wallet.select(id);
    if (r.ok && r.data) { setInfo(r.data); void refresh(); toast.success(r.message); }
    else toast.error(r.message);
  };

  const doRename = async (id: string): Promise<void> => {
    const r = await window.krypt.wallet.rename(id, renameText);
    setRenaming(null);
    if (r.ok) { void refresh(); } else toast.error(r.message);
  };

  const doRemoveOne = async (wal: WalletSummary): Promise<void> => {
    const yes = await modal.confirm({
      title: `Remove ${wal.label}`,
      message: `This deletes the encrypted key for ${wal.publicKey.slice(0, 8)}… from this machine. If you have not backed it up, any funds in it are gone forever. Continue?`,
      confirmLabel: 'Remove wallet',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.wallet.remove(wal.id);
    if (r.ok && r.data) { setInfo(r.data); void refresh(); toast.success(r.message); }
    else toast.error(r.message);
  };

  const doImport = async (): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.wallet.import(importText.trim());
    setBusy(false);
    if (r.ok && r.data) { setInfo(r.data); void refresh(); setShowImport(false); setImportText(''); toast.success('Wallet imported'); }
    else toast.error(r.message);
  };

  const doBackup = async (): Promise<void> => {
    const r = await window.krypt.wallet.backup();
    if (r.ok) toast.success('Backed up — store that file somewhere safe and offline');
    else toast.warn(r.message);
  };

  const doExport = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Export all wallets',
      message:
        'This writes the PRIVATE KEYS of every wallet to a plain text file so you can import them into Phantom or another wallet. Anyone who gets that file can spend your wallets. Save it somewhere offline and delete it when done. Continue?',
      confirmLabel: 'Export private keys',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.wallet.exportAll();
    if (r.ok) toast.success(`Exported ${r.data?.count ?? ''} wallet(s) — delete that file once imported`);
    else toast.warn(r.message);
  };

  const doRemove = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Remove wallet',
      message: 'This deletes the encrypted key from this machine. If you have not backed it up, any funds in it are gone forever. Continue?',
      confirmLabel: 'Remove wallet',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.wallet.remove();
    if (r.ok && r.data) { setInfo(r.data); void refresh(); toast.info('Wallet removed'); }
  };

  const saveHome = async (): Promise<void> => {
    const r = await window.krypt.wallet.setHome(homeInput.trim());
    if (r.ok && r.data) { setInfo(r.data); toast.success('Withdrawal address saved'); }
    else toast.error(r.message);
  };

  const saveCap = async (): Promise<void> => {
    const r = await window.krypt.wallet.setMaxBalance(Number(capInput));
    if (r.ok && r.data) { setInfo(r.data); toast.success('Balance cap saved'); }
    else toast.error(r.message);
  };

  const overCap = info?.balanceSol != null && info.balanceSol > info.maxBalanceSol;

  return (
    <Page title="Wallet" subtitle="A dedicated hot wallet for sniping — generated here, encrypted by your OS, funded with lunch money.">
      {/* The Vault Tome — the wallet's beating heart */}
      <div className="plate relative h-[260px] rounded-lg !bg-black/45 overflow-hidden mb-6">
        <div className="absolute inset-0 grid-backdrop animate-dust pointer-events-none" aria-hidden="true" />
        <Tome3D />
        <div className="pointer-events-none absolute top-4 left-5">
          <div className="font-display text-[10px] uppercase tracking-[0.34em] text-arc-gold/75">The Vault</div>
          {info?.exists ? (
            <>
              <div className={cls('mt-1.5 text-3xl font-bold font-mono tabular-nums glow-text', overCap ? 'text-amber-300' : 'text-white')}>
                {info.balanceSol != null ? info.balanceSol.toFixed(4) : '—'}
                <span className="ml-2 text-sm font-normal text-krypt-muted">SOL</span>
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-krypt-muted">
                {info.publicKey ? `${info.publicKey.slice(0, 6)}…${info.publicKey.slice(-6)}` : ''}
              </div>
            </>
          ) : (
            <div className="mt-1.5 font-display text-sm tracking-[0.12em] text-krypt-muted">No wallet bound to the tome</div>
          )}
        </div>
        <div className="pointer-events-none absolute top-4 right-5 flex flex-col items-end gap-2">
          <span className={cls(
            'inline-flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.24em]',
            live?.armed ? 'text-rose-300' : 'text-krypt-muted/60',
          )}>
            <span className={cls('h-1 w-1 rotate-45', live?.armed ? 'bg-rose-400 shadow-crimson-glow animate-rune-pulse' : 'bg-krypt-muted/30')} />
            {live?.armed ? 'Armed' : 'Disarmed'}
          </span>
          <span className={cls(
            'inline-flex items-center gap-1.5 font-display text-[9px] uppercase tracking-[0.24em]',
            settings.execution.autoCashout ? 'text-arc-gold/90' : 'text-krypt-muted/60',
          )}>
            <span className={cls('h-1 w-1 rotate-45', settings.execution.autoCashout ? 'bg-arc-gold shadow-gold-glow animate-rune-pulse' : 'bg-krypt-muted/30')} />
            Profit rite {settings.execution.autoCashout ? 'active' : 'dormant'}
          </span>
        </div>
      </div>

      {/* Live gate banner */}
      <div className="mb-6 rounded-xl border border-amber-400/25 bg-amber-500/5 px-4 py-3 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-amber-300 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-krypt-muted leading-relaxed">
          <span className="text-white font-semibold">This app starts in Live mode: a trade you place here spends real SOL.</span>{' '}
          Switch to Paper in the top bar to practise without money. Every trade is built locally (a maintained relayer is
          the fallback), simulated and loss-bounded before your key signs, and nothing buys on its own — the scanner only
          flags tokens, it never places an order. Fund only what you can afford to lose.
        </div>
      </div>

      {!info?.exists ? (
        <Section title="Set up your trading wallet">
          <Card className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-krypt-purple/15 border border-krypt-purple/30 flex items-center justify-center">
                <WalletIcon className="h-5 w-5 text-krypt-purple" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Generate a dedicated hot wallet</div>
                <div className="text-xs text-krypt-muted mt-0.5">
                  A brand-new keypair, stored encrypted by {info?.encryptionAvailable ? 'your OS keystore (DPAPI)' : 'your OS'}. Your main wallet is never involved.
                </div>
              </div>
            </div>
            {!info?.encryptionAvailable && (
              <div className="flex items-center gap-2 text-xs text-rose-300">
                <AlertTriangle className="h-4 w-4" /> OS secure storage is unavailable — generation is blocked to avoid storing a key unencrypted.
              </div>
            )}
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void doGenerate()} disabled={busy || !info?.encryptionAvailable}>
                <KeyRound className="h-4 w-4" /> Generate wallet
              </PrimaryButton>
              <GhostButton onClick={() => setShowImport((v) => !v)}>Import existing key</GhostButton>
            </div>
            {showImport && (
              <div className="space-y-2 pt-2 border-t border-white/10">
                <div className="flex items-center gap-2 text-xs text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" /> Importing a wallet you use elsewhere exposes it to an unattended bot. Prefer generating a fresh one.
                </div>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="Base58 private key or JSON byte array"
                  rows={2}
                  spellCheck={false}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 resize-y"
                />
                <PrimaryButton onClick={() => void doImport()} disabled={busy || !importText.trim()}>Import</PrimaryButton>
              </div>
            )}
          </Card>
        </Section>
      ) : (
        <>
          {/* Wallet switcher — only earns its space once there is a choice to
              make, but the "add" controls stay available at one wallet. */}
          <Section
            title="Your wallets"
            description="Several trading wallets, one active at a time. Only the active wallet can sign, so switching is blocked while live execution is armed — switch the top bar to Paper first."
          >
            <Card>
              <div className="space-y-1.5">
                {wallets.map((wal) => (
                  <div
                    key={wal.id}
                    className={cls(
                      'flex items-center gap-3 rounded-lg border px-3 py-2 transition',
                      wal.active ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/8 bg-white/[0.02] hover:border-white/20',
                    )}
                  >
                    <button
                      onClick={() => { if (!wal.active) void doSelect(wal.id); }}
                      disabled={wal.active || live?.armed === true}
                      title={live?.armed ? 'Disarm live execution to switch wallets' : wal.active ? 'Active' : 'Make this the signing wallet'}
                      className={cls(
                        'h-6 w-6 flex-shrink-0 rounded-full border flex items-center justify-center text-[10px]',
                        wal.active ? 'border-krypt-purple bg-krypt-purple/30 text-white' : 'border-white/20 text-krypt-muted hover:border-white/40',
                        live?.armed && !wal.active ? 'opacity-40 cursor-not-allowed' : '',
                      )}
                    >
                      {wal.active ? '●' : ''}
                    </button>

                    <div className="min-w-0 flex-1">
                      {renaming === wal.id ? (
                        <input
                          autoFocus
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => void doRename(wal.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void doRename(wal.id); if (e.key === 'Escape') setRenaming(null); }}
                          className="w-40 rounded bg-black/40 border border-white/15 px-2 py-0.5 text-[12px] text-white outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => { setRenaming(wal.id); setRenameText(wal.label); }}
                          title="Rename"
                          className="text-[12px] font-medium text-white/90 hover:text-white"
                        >
                          {wal.label}
                        </button>
                      )}
                      <div className="font-mono text-[10px] text-krypt-muted truncate">{wal.publicKey}</div>
                    </div>

                    <div className="text-right">
                      <div className="font-mono text-[12px] text-white/85">
                        {wal.balanceSol != null ? `${wal.balanceSol.toFixed(3)} SOL` : '—'}
                      </div>
                      <div className="text-[9px] text-krypt-muted">cap {wal.maxBalanceSol} SOL</div>
                    </div>

                    <GhostButton onClick={() => void doRemoveOne(wal)} destructive>
                      <Trash2 className="h-3.5 w-3.5" />
                    </GhostButton>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <GhostButton onClick={() => void doGenerate()} disabled={busy}>
                  <KeyRound className="h-3.5 w-3.5" /> New wallet
                </GhostButton>
                <GhostButton onClick={() => setShowImport((v) => !v)}>
                  <Download className="h-3.5 w-3.5" /> Import key
                </GhostButton>
                {live?.armed && <SwitchToPaper reason="Live execution is armed — wallets cannot change while it is." />}
              </div>

              {showImport && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="base58 secret key or [1,2,3,…] byte array"
                    className="flex-1 rounded bg-black/40 border border-white/15 px-2 py-1 font-mono text-[11px] text-white outline-none"
                  />
                  <PrimaryButton onClick={() => void doImport()} disabled={busy || !importText.trim()}>
                    Import
                  </PrimaryButton>
                </div>
              )}

              <p className="mt-2 text-[10px] leading-relaxed text-krypt-muted/60">
                Each wallet keeps its own balance cap and withdrawal address. Fills are recorded against the wallet that
                made them, so switching never mixes up your history.
              </p>
            </Card>
          </Section>

          {/* Balance + deposit */}
          <div className="grid lg:grid-cols-2 gap-4">
            <Section title="Balance">
              <Card>
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] text-krypt-muted">Trading wallet</div>
                    <div className={cls('mt-1 text-3xl font-bold font-mono', overCap ? 'text-amber-300' : 'text-white')}>
                      {info.balanceSol != null ? info.balanceSol.toFixed(4) : '—'} <span className="text-sm text-krypt-muted">SOL</span>
                    </div>
                  </div>
                  <GhostButton onClick={() => void window.krypt.wallet.refreshBalance().then((r) => { if (r.ok && r.data) setInfo(r.data); })} className="!py-1.5 !px-3 text-xs">
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </GhostButton>
                </div>
                {overCap && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-amber-300">
                    <AlertTriangle className="h-4 w-4" /> Above your {info.maxBalanceSol} SOL cap — sweep some out.
                  </div>
                )}
                {info.balanceCheckedAt && <div className="mt-2 text-[11px] text-krypt-muted/60">checked {fmtClock(info.balanceCheckedAt)}</div>}
              </Card>
            </Section>

            <Section title="Deposit address" description="Send SOL here from your main wallet or an exchange.">
              <Card className="space-y-2">
                <Copyable value={info.publicKey ?? ''} />
                <div className="text-[11px] text-krypt-muted/70">Only SOL on Solana mainnet. Start small — 0.1–0.5 SOL is plenty to test with.</div>
              </Card>
            </Section>
          </div>

          {/* Safety rails */}
          <Section title="Safety rails">
            <div className="grid lg:grid-cols-2 gap-3">
              <Card className="space-y-2">
                <div className="text-sm font-semibold text-white">Max balance cap</div>
                <div className="text-xs text-krypt-muted">Warn when the wallet holds more than this.</div>
                <div className="flex gap-2">
                  <input value={capInput} onChange={(e) => setCapInput(e.target.value)} inputMode="decimal"
                    className="w-28 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white outline-none focus:border-krypt-purple/60" />
                  <GhostButton onClick={() => void saveCap()}>Save</GhostButton>
                </div>
              </Card>
              <Card className="space-y-2">
                <div className="text-sm font-semibold text-white">Withdrawal address</div>
                <div className="text-xs text-krypt-muted">Where a sweep sends funds (your safe wallet).</div>
                <div className="flex gap-2">
                  <input ref={homeInputRef} value={homeInput} onChange={(e) => setHomeInput(e.target.value)} placeholder="Your main wallet address" spellCheck={false}
                    className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60" />
                  <GhostButton onClick={() => void saveHome()}>Save</GhostButton>
                </div>
              </Card>
            </div>
            <div className="mt-3">
              <WithdrawPanel
                info={info}
                onDone={() => { void refresh(); void window.krypt.wallet.refreshBalance().then((r) => { if (r.ok && r.data) setInfo(r.data); }); }}
                onChangeAddress={() => homeInputRef.current?.focus()}
              />
            </div>
          </Section>

          {/* Auto-profit rites */}
          <Section
            title="Auto-profit rites"
            description="Let the tome bank your wins and never strand a token."
          >
            <div className="grid lg:grid-cols-2 gap-3">
              <div className="space-y-3">
                <Switch
                  checked={settings.execution.autoCashout}
                  onChange={(v) => void updateSettings({ execution: { ...settings.execution, autoCashout: v } })}
                  label="Auto-cashout profits"
                  description={
                    info.homeAddress
                      ? `Sweep live profits to ${info.homeAddress.slice(0, 6)}…${info.homeAddress.slice(-4)} once they reach the threshold`
                      : 'Sweep live profits to your withdrawal address — set one above first'
                  }
                />
                <div className="flex items-center justify-between gap-4 rounded-md border border-white/10 bg-black/20 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-white">Cashout threshold</div>
                    <div className="text-xs text-krypt-muted mt-0.5">Sweep once unswept profit reaches this much</div>
                  </div>
                  <NumberInput
                    value={settings.execution.cashoutThresholdSol}
                    min={0.01}
                    max={100}
                    step={0.01}
                    suffix="SOL"
                    onChange={(v) => void updateSettings({ execution: { ...settings.execution, cashoutThresholdSol: v } })}
                  />
                </div>
              </div>
              <Switch
                checked={settings.execution.autoSellOnExit}
                onChange={(v) => void updateSettings({ execution: { ...settings.execution, autoSellOnExit: v } })}
                label="Auto-sell on stop or crash"
                description="DANGER: when the sniper stops or quits — or a previous run crashed holding tokens — market-sells EVERY SPL token in this wallet at up to 15% slippage, including tokens this app never bought. Off by default. Needs real broadcast on."
              />
            </div>
          </Section>

          {/* Live safety status — the mode itself is toggled in the top bar. */}
          {live?.armed && !live.available && (
            <Section title="Live trading">
              <Card>
                <div className="flex items-center gap-2 text-xs text-amber-200">
                  <Badge tone="warn">execution pending</Badge>
                  Live is on but nothing signs until execution is built.
                </div>
              </Card>
            </Section>
          )}
          {!live?.armed && live?.lastDisarmReason && (
            <p className="text-[11px] text-krypt-muted/70 px-1">
              Live auto-switched to Paper — reason: {live.lastDisarmReason.replace(/_/g, ' ')}. Re-enable it in the top bar.
            </p>
          )}

          {/* Buy by mint + sell */}
          <LiveExecutionPanel armed={!!live?.armed} balanceSol={info.balanceSol} />

          {/* Fan-out: groups + several wallets buying the same token at once */}
          {wallets.length > 1 && <FanoutPanel wallets={wallets} armed={!!live?.armed} />}

          {/* Backup / danger */}
          <Section title="Backup & removal">
            <Card className="flex flex-wrap items-center gap-2">
              <GhostButton onClick={() => void doBackup()}>
                <Download className="h-4 w-4" /> Back up keypair
              </GhostButton>
              <GhostButton onClick={() => void doExport()}>
                <Download className="h-4 w-4" /> Export all (Phantom)
              </GhostButton>
              <span className="text-xs text-krypt-muted">Keypair = a Solana CLI file. Export all = a plain text file of private keys for Phantom / Solflare / Backpack.</span>
              <div className="flex-1" />
              <GhostButton destructive onClick={() => void doRemove()}>
                <Trash2 className="h-4 w-4" /> Remove wallet
              </GhostButton>
            </Card>
          </Section>
        </>
      )}
    </Page>
  );
}
