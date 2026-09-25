// Launch — create a token, on the chains where that can be done safely.
//
// Everything the signer needs before it will co-sign anything lives on this
// page: the master switch, the dedicated wallet, an honest per-chain readout
// of what is wired — and then the form that actually makes the thing.
//
// It is off when you arrive, and that is the point. While it is off the
// `launch` intent cannot be constructed at all, so the signer's one-signature
// rule applies exactly as it does for someone who never opens this page.
//
// The form's own checks come from `draftProblems` in shared/launch.ts — the
// SAME function the main process runs before it signs. What greys out the
// button and what refuses the launch cannot drift apart.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, Check, Coins, ImagePlus, Loader2, Rocket, Wallet } from 'lucide-react';
import {
  BLOCKER_TEXT,
  LAUNCH_CHAINS,
  MAX_CREATOR_TAX_BPS,
  MAX_NAME,
  MAX_SYMBOL,
  MIN_DEV_BUY,
  draftProblems,
  emptyDraft,
  launchWalletId,
  LAUNCH_WATERMARK,
  DESCRIPTION_BUDGET,
  readiness,
  type LaunchChain,
  type LaunchConfig,
  type LaunchDraft,
} from '@shared/launch';
import { useAppState } from '../state/AppStateProvider';
import { LaunchStats } from '../components/terminal/LaunchStats';
import { KryptoSessions } from '../components/terminal/KryptoSessions';
import {
  KRYPTO_DISCLOSURE_MAX,
  KRYPTO_DRIVERS,
  KRYPTO_DRIVER_TEXT,
  KRYPTO_MAX_BUDGET_SOL,
  KRYPTO_MIN_BUDGET_SOL,
  KRYPTO_STRATEGIES,
  KRYPTO_STRATEGY_TEXT,
  kryptoDisclosure,
  kryptoOptionProblems,
  type KryptoOptions,
} from '@shared/kryptoMode';
import { useToast } from '../state/ToastProvider';
import { cls } from '../utils/format';
import { Empty, Field } from '../components/common';

const CHAIN_LABEL: Record<LaunchChain, string> = { solana: 'Solana', robinhood: 'Robinhood Chain' };
const VENUE: Record<LaunchChain, string> = { solana: 'pump.fun', robinhood: 'Pons' };
const NATIVE: Record<LaunchChain, string> = { solana: 'SOL', robinhood: 'ETH' };

/**
 * Whether a chain's create instruction has been decoded from a REAL
 * transaction and pinned by a test.
 *
 * Robinhood is TRUE: `launchAndBuy` was decoded from chain and our encoder
 * now reproduces a real launch byte for byte, pinned by
 * test/ponslaunch.test.mjs against a fixture captured from that transaction.
 *
 * Solana is TRUE as well: all sixteen of `create_v2`'s accounts derive from
 * pump's on-chain IDL and match three real launches, and the argument encoding
 * reproduces one byte for byte. Pinned by test/pumplaunch.test.mjs.
 */
const BUILDER_VERIFIED: Record<LaunchChain, boolean> = { solana: true, robinhood: true };

interface WalletRow {
  id: string;
  label: string;
  publicKey: string;
  balanceSol?: number | null;
}

interface EvmWalletRow {
  id: string;
  label: string;
  address: string;
  active: boolean;
  balanceNative: number | null;
}

const inputCls =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-note text-white placeholder:text-krypt-muted/60 focus:border-krypt-purple/60 focus:outline-none';

interface LaunchAttempt {
  at: number;
  chain: LaunchChain;
  symbol: string;
  token: string | null;
  hash: string | null;
  outcome: string;
}
const ATTEMPTS_KEY = 'krypt.launch.attempts';
function loadAttempts(): LaunchAttempt[] {
  try {
    const raw = localStorage.getItem(ATTEMPTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object' && typeof (x as LaunchAttempt).at === 'number') as LaunchAttempt[]) : [];
  } catch {
    return [];
  }
}
function remember(list: LaunchAttempt[], a: LaunchAttempt): LaunchAttempt[] {
  const next = [a, ...list].slice(0, 20);
  try {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(next));
  } catch {
    /* the chain is the record; this is the map to it */
  }
  return next;
}

export function Launch() {
  const { settings, updateSettings } = useAppState();
  const toast = useToast();
  const cfg: LaunchConfig = settings.launch;
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [evmWallets, setEvmWallets] = useState<EvmWalletRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chain, setChain] = useState<LaunchChain>('solana');
  const [draft, setDraft] = useState<LaunchDraft>(() => emptyDraft('solana'));
  const [image, setImage] = useState<{ handle: string; name: string; dataUrl: string } | null>(null);
  // Every send, kept: a create that timed out waiting for its receipt is a
  // token that may exist, and a toast vanishes in seconds. This is the list
  // the user goes to before ever pressing Launch twice. Per-viewer, in
  // localStorage — the truth is on chain; this is the map to it.
  const [attempts, setAttempts] = useState<LaunchAttempt[]>(() => loadAttempts());
  const [tab, setTab] = useState<'new' | 'mine' | 'stats' | 'krypto'>('new');
  // The bot wallet the last pin declared (null = no Krypto Mode in that pin).
  const [kryptoAddress, setKryptoAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'image' | 'upload' | 'preview' | 'send'>('');
  const [checked, setChecked] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; chain: LaunchChain; note?: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const [fees, setFees] = useState<{ claimableLamports: number | null; failure: string | null } | null>(null);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.krypt.wallet
      .list()
      .then((r) => {
        if (alive && r.ok && Array.isArray(r.data)) setWallets(r.data as WalletRow[]);
      })
      .catch(() => undefined);
    void window.krypt.wallet
      .info()
      .then((r) => {
        if (alive && r.ok && r.data) setActiveId((r.data as { id?: string }).id ?? null);
      })
      .catch(() => undefined);
    void window.krypt.evm.wallet
      .list('robinhood')
      .then((r) => {
        if (alive && r.ok && Array.isArray(r.data)) setEvmWallets(r.data as EvmWalletRow[]);
      })
      .catch(() => undefined);
    // The Solana first buy is an ordinary buy, so the engine has to be armed
    // for it. Read it here so the page refuses BEFORE a token exists rather
    // than reporting a failed buy afterwards.
    void window.krypt.live
      .state()
      .then((r) => {
        if (alive && r.ok && r.data) setArmed(r.data.armed === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Switching chain keeps what carries over (the name, the image, the words)
  // and resets what does not (the first buy is denominated differently, and
  // the per-chain options mean nothing on the other chain).
  const switchChain = useCallback((next: LaunchChain) => {
    setChain(next);
    setChecked(null);
    setDraft((d) => ({ ...emptyDraft(next), name: d.name, symbol: d.symbol, description: d.description, imageUrl: d.imageUrl, metadataUri: d.metadataUri, twitter: d.twitter, telegram: d.telegram, website: d.website }));
  }, []);

  const set = useCallback(<K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) => {
    // The pinned metadata carries the name, symbol, description and socials.
    // Editing any of them after pinning makes the pin stale, so it is
    // dropped and the page asks for a new one (the image pin stays — it did
    // not change). Until 2026-09-11 only an image change did this.
    const unpins = key === 'name' || key === 'symbol' || key === 'description' || key === 'twitter' || key === 'telegram' || key === 'website';
    setDraft((d) => (unpins && d.metadataUri ? { ...d, [key]: value, metadataUri: '' } : { ...d, [key]: value }));
    setChecked(null);
  }, []);

  // Krypto Mode is written INTO the pinned description, so switching it on
  // or off after pinning makes the pin stale exactly like editing the words.
  const setKrypto = useCallback((patch: Partial<KryptoOptions>) => {
    setDraft((d) => ({
      ...d,
      krypto: { ...d.krypto, ...patch },
      metadataUri: 'enabled' in patch && patch.enabled !== d.krypto.enabled ? '' : d.metadataUri,
    }));
    setChecked(null);
  }, []);

  const save = useCallback(
    async (next: Partial<LaunchConfig>) => {
      const merged = { ...cfg, ...next };
      const r = await updateSettings({ launch: merged });
      if (r === undefined || r) toast.success(merged.enabled ? 'Launching is on for this install.' : 'Launching is off.');
    },
    [cfg, updateSettings, toast],
  );

  const evmActiveId = evmWallets?.find((w) => w.active)?.id ?? null;
  const pickedSol = wallets?.find((w) => w.id === cfg.walletId) ?? null;
  const pickedEvm = evmWallets?.find((w) => w.id === cfg.evmWalletId) ?? null;
  // Armed AND live: the Solana first buy is an ordinary buy and needs both.
  const liveReady = settings.execution.liveEnabled && armed;

  const ready = useMemo(
    () =>
      readiness(cfg, chain, {
        activeWalletId: chain === 'solana' ? activeId : evmActiveId,
        walletBalance: chain === 'solana' ? pickedSol?.balanceSol ?? null : pickedEvm?.balanceNative ?? null,
        builderVerified: BUILDER_VERIFIED[chain],
        liveReady,
      }),
    [cfg, chain, activeId, evmActiveId, pickedSol, pickedEvm, liveReady],
  );

  const problems = [...draftProblems(draft), ...(chain === 'solana' ? kryptoOptionProblems(draft.krypto) : [])];
  const canSend = ready.ready && problems.length === 0 && busy === '';

  const pickImage = useCallback(async () => {
    setBusy('image');
    try {
      const r = await window.krypt.launch.pickImage();
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (!r.data) return; // cancelled
      setImage(r.data);
      // A new image invalidates what was pinned: the old URL still points at
      // the old picture, and silently launching with it would be the worst
      // kind of wrong.
      setDraft((d) => ({ ...d, imageUrl: '', metadataUri: '' }));
      setChecked(null);
    } finally {
      setBusy('');
    }
  }, [toast]);

  const upload = useCallback(async () => {
    if (!image) return;
    setBusy('upload');
    try {
      const r = await window.krypt.launch.upload(image.handle, {
        name: draft.name.trim(),
        symbol: draft.symbol.trim(),
        description: draft.description.trim(),
        twitter: draft.twitter.trim(),
        telegram: draft.telegram.trim(),
        website: draft.website.trim(),
        kryptoMode: chain === 'solana' && draft.krypto.enabled,
      });
      if (!r.ok || !r.data) {
        toast.error(r.message);
        return;
      }
      setDraft((d) => ({ ...d, imageUrl: r.data!.imageUrl, metadataUri: r.data!.metadataUri }));
      setKryptoAddress(r.data.kryptoAddress ?? null);
      setChecked(null);
      toast.success(
        r.data.kryptoAddress
          ? 'Pinned to IPFS, with the Krypto Mode bot wallet named in the description. Nothing has been created yet.'
          : 'Image and details pinned to IPFS. Nothing has been created yet.',
      );
    } finally {
      setBusy('');
    }
  }, [image, draft, chain, toast]);

  const preview = useCallback(async () => {
    setBusy('preview');
    setChecked(null);
    try {
      const r = await window.krypt.launch.preview(draft);
      if (!r.ok) {
        toast.error(r.message);
        setChecked(null);
        return;
      }
      setChecked(r.message);
    } finally {
      setBusy('');
    }
  }, [draft, toast]);

  const send = useCallback(async () => {
    setBusy('send');
    try {
      const r = await window.krypt.launch.send(draft);
      if (!r.ok || !r.data) {
        // A timed-out receipt is not a launch that did not happen. The hash
        // and the mint, when there are any, are what the user needs to find
        // out — kept on the page, not only in a toast.
        const hash = r.data?.hash;
        const token = r.data?.token;
        if (hash || token) setAttempts((a) => remember(a, { at: Date.now(), chain, symbol: draft.symbol.trim(), token: token ?? null, hash: hash ?? null, outcome: r.message }));
        toast.error(hash ? `${r.message} Transaction: ${hash}` : r.message);
        return;
      }
      const out = r.data;
      if (out.token) setAttempts((a) => remember(a, { at: Date.now(), chain, symbol: draft.symbol.trim(), token: out.token ?? null, hash: out.hash ?? null, outcome: out.buyFailed ? `created; first buy failed: ${out.buyFailed}` : 'created' }));
      if (out.token) setCreated({ token: out.token, chain, note: out.buyFailed });
      if (out.buyFailed) toast.error(`${out.message} ${out.buyFailed}`);
      else toast.success(out.message);
    } finally {
      setBusy('');
    }
  }, [draft, chain, toast]);

  const walletPicked = launchWalletId(cfg, chain) !== '';

  // Creator fees accrue to the wallet, not to a coin, so this is read once
  // for the configured Solana launch wallet and refreshed after a claim.
  const loadFees = useCallback(() => {
    if (!cfg.walletId) {
      setFees(null);
      return;
    }
    void window.krypt.launch
      .fees()
      // A read that FAILED keeps its reason: the page shows a dash either
      // way, but "could not read your vault: …" is not "nothing to show".
      .then((r) => setFees(r.ok && r.data ? r.data : r.ok ? null : { claimableLamports: null, failure: r.message }))
      .catch((e: unknown) => setFees({ claimableLamports: null, failure: (e as Error).message }));
  }, [cfg.walletId]);

  useEffect(loadFees, [loadFees]);

  const claim = useCallback(async () => {
    setClaiming(true);
    try {
      const r = await window.krypt.launch.claimFees();
      if (r.ok) toast.success(r.message === 'confirmed' ? 'Creator fees claimed.' : r.message);
      else toast.error(r.message);
      loadFees();
    } finally {
      setClaiming(false);
    }
  }, [toast, loadFees]);

  const claimableSol = fees?.claimableLamports === null || fees?.claimableLamports === undefined ? null : fees.claimableLamports / 1e9;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-1 flex items-center gap-2">
        <Rocket className="h-4 w-4 text-krypt-pink" />
        <h1 className="text-lg font-semibold text-white">Launch a token</h1>
      </div>
      <p className="mb-4 text-note leading-relaxed text-krypt-muted">
        Create your own token on {LAUNCH_CHAINS.map((c) => CHAIN_LABEL[c]).join(' or ')}. Off by default — while it is off this app
        cannot co-sign a launch at all.
      </p>

      {/* Three tabs: making one, what you have made, and how they are doing.
          The launches list used to sit at the bottom of the form, below the
          part nobody scrolls to after their first launch. */}
      <div className="mb-5 flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
        {([
          ['new', 'Launch'],
          ['mine', `My launches${attempts.length ? ` (${attempts.length})` : ''}`],
          ['stats', 'Stats'],
          ['krypto', 'Krypto Mode'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cls(
              'flex-1 rounded-md px-3 py-1.5 text-note font-semibold transition',
              tab === id ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'stats' && <LaunchStats attempts={attempts} />}

      {tab === 'krypto' && <KryptoSessions />}

      {tab === 'mine' && (
        <div className="space-y-3">
          <p className="text-body leading-relaxed text-krypt-muted">
            Kept on this machine — the chain is the record, this is the map to it. A create that timed out may still
            have landed, so look the transaction up before launching the same coin again.
          </p>
          {attempts.length === 0 ? (
            <Empty title="Nothing launched yet" message="Anything you send from the Launch tab shows up here." />
          ) : (
            <div className="space-y-1.5">
              {attempts.map((a) => (
                <div key={`${a.at}-${a.hash ?? a.token ?? ''}`} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-body">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-white/90">
                      {a.symbol || '(no symbol)'} · {a.chain} · {new Date(a.at).toLocaleString()}
                    </span>
                    <span className="text-krypt-muted">{a.outcome}</span>
                  </div>
                  {a.token && <div className="mt-1 select-all break-all font-mono text-label text-krypt-muted">token {a.token}</div>}
                  {a.hash && <div className="select-all break-all font-mono text-label text-krypt-muted">tx {a.hash}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'new' && (
      <>

      {/* ── what this is worth, said once, before the switch ───────────── */}
      <div className="mb-5 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
        <div className="mb-1 flex items-center gap-2 text-note font-semibold text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" /> Read this before you turn it on
        </div>
        <ul className="space-y-1 text-body leading-relaxed text-amber-100/80">
          <li>
            Measured on this app's own corpus of 73,890 launches: <span className="text-white/90">82.5% are dead in ten minutes</span>,
            about 2% ever graduate, and roughly 1 in 5,000 becomes a token with a lasting fee stream.
          </li>
          <li>
            A launch with no audience is worth <span className="text-white/90">one to three dollars</span>. We can build the coin in
            seconds; we cannot bring the people, and nothing in this app will.
          </li>
          <li>
            This app's own creator check flags a wallet that launches ten times in a day as a{' '}
            <span className="text-white/90">launch factory</span>, and it will flag yours.
          </li>
          <li>You are responsible for what you create and distribute, and for the rules that apply where you live.</li>
        </ul>
      </div>

      {/* ── the switch ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-white/10 bg-krypt-panel p-4">
        <div>
          <div className="text-value font-semibold text-white">Allow launching from this install</div>
          <div className="mt-0.5 text-body leading-relaxed text-krypt-muted">
            Off: the signer refuses any transaction needing a second signature, which is every launch. On: it accepts exactly one
            extra signer — the new mint this app generates — and nothing else.
          </div>
        </div>
        <button
          onClick={() => void save({ enabled: !cfg.enabled })}
          className={cls(
            'ml-4 shrink-0 rounded-lg border px-3 py-1.5 text-note font-semibold transition',
            cfg.enabled
              ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white hover:bg-krypt-purple/25'
              : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
          )}
        >
          {cfg.enabled ? 'On' : 'Off'}
        </button>
      </div>

      {/* ── chain ──────────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl border border-white/10 bg-krypt-panel p-4">
        <div className="mb-2 text-value font-semibold text-white">Where</div>
        <div className="flex gap-2">
          {LAUNCH_CHAINS.map((c) => (
            <button
              key={c}
              onClick={() => switchChain(c)}
              className={cls(
                'flex-1 rounded-lg border px-3 py-2 text-left transition',
                chain === c ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/5',
              )}
            >
              <div className="text-note font-semibold text-white/90">{CHAIN_LABEL[c]}</div>
              <div className="text-label text-krypt-muted">{VENUE[c]}</div>
            </button>
          ))}
        </div>
        {!ready.ready && ready.blocker && (
          <p className="mt-2 text-body leading-relaxed text-amber-200/80">{BLOCKER_TEXT[ready.blocker]}</p>
        )}
      </div>

      {/* ── the wallet ─────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl border border-white/10 bg-krypt-panel p-4">
        <div className="mb-2 flex items-center gap-2 text-value font-semibold text-white">
          <Wallet className="h-3.5 w-3.5" /> Launch wallet · {CHAIN_LABEL[chain]}
        </div>
        <p className="mb-3 text-body leading-relaxed text-krypt-muted">
          Launching signs from its own wallet, never the one you trade with. A mistake in the launch path then cannot reach the keys
          holding your positions — and your creator address is not your trading address on chain.
        </p>
        {chain === 'solana' ? (
          wallets === null ? (
            <p className="text-body text-krypt-muted">Reading wallets…</p>
          ) : wallets.length === 0 ? (
            <p className="text-body text-krypt-muted">No wallets yet. Create one on the Wallet page first.</p>
          ) : (
            <div className="space-y-1">
              {wallets.map((w) => {
                const isActive = w.id === activeId;
                const isPicked = w.id === cfg.walletId;
                return (
                  <button
                    key={w.id}
                    disabled={isActive}
                    onClick={() => void save({ walletId: isPicked ? '' : w.id })}
                    title={isActive ? 'This is your trading wallet — launching needs a different one' : undefined}
                    className={cls(
                      'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40',
                      isPicked ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/5',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-note text-white/90">{w.label || 'Wallet'}</span>
                      <span className="block truncate font-mono text-label text-krypt-muted">
                        {w.publicKey}
                        {isActive && ' · your trading wallet'}
                      </span>
                    </span>
                    {isPicked && <Check className="h-3.5 w-3.5 shrink-0 text-krypt-purple" />}
                  </button>
                );
              })}
            </div>
          )
        ) : evmWallets === null ? (
          <p className="text-body text-krypt-muted">Reading wallets…</p>
        ) : evmWallets.length === 0 ? (
          <p className="text-body text-krypt-muted">No Robinhood wallets yet. Create one on the Wallet page first.</p>
        ) : (
          <div className="space-y-1">
            {evmWallets.map((w) => {
              const isPicked = w.id === cfg.evmWalletId;
              return (
                <button
                  key={w.id}
                  disabled={w.active}
                  onClick={() => void save({ evmWalletId: isPicked ? '' : w.id })}
                  title={w.active ? 'This is your trading wallet — launching needs a different one' : undefined}
                  className={cls(
                    'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40',
                    isPicked ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/5',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-note text-white/90">{w.label || 'Wallet'}</span>
                    <span className="block truncate font-mono text-label text-krypt-muted">
                      {w.address}
                      {w.active && ' · your trading wallet'}
                    </span>
                  </span>
                  {isPicked && <Check className="h-3.5 w-3.5 shrink-0 text-krypt-purple" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── the form ───────────────────────────────────────────────────── */}
      <div className={cls('rounded-xl border border-white/10 bg-krypt-panel p-4', (!cfg.enabled || !walletPicked) && 'opacity-50')}>
        <div className="mb-3 text-value font-semibold text-white">Your token</div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint={`${draft.name.length}/${MAX_NAME}`}>
            <input value={draft.name} maxLength={MAX_NAME} onChange={(e) => set('name', e.target.value)} placeholder="Doge Supreme" className={inputCls} />
          </Field>
          <Field label="Ticker" hint={`${draft.symbol.length}/${MAX_SYMBOL}`}>
            <input
              value={draft.symbol}
              maxLength={MAX_SYMBOL}
              onChange={(e) => set('symbol', e.target.value.toUpperCase())}
              placeholder="DOGES"
              className={cls(inputCls, 'font-mono')}
            />
          </Field>
        </div>

        <div className="mt-3">
          {/* The budget counts down from what is left AFTER the watermark, not
              from pump's limit — otherwise someone fills 500 characters and
              the stamped version is refused at the upload. */}
          <Field label="Description" hint={`${draft.description.length}/${DESCRIPTION_BUDGET}`}>
            <textarea
              value={draft.description}
              maxLength={DESCRIPTION_BUDGET}
              rows={2}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What is this?"
              className={cls(inputCls, 'resize-none')}
            />
          </Field>
          {/* Shown, not hidden: the line goes into the metadata the mint points
              at, so it travels with the coin wherever anyone reads it. Nobody
              should find it afterwards on a token that exists forever under
              their name. */}
          <p className="mt-1.5 text-label leading-relaxed text-krypt-muted/70">
            Every coin launched here ends with{' '}
            <span className="text-krypt-muted">“{LAUNCH_WATERMARK}”</span>. It is written into the token's own
            metadata, so it travels with the coin.
            {chain === 'solana' && draft.krypto.enabled && (
              <>
                {' '}
                Krypto Mode adds one more line naming the bot’s wallet
                {draft.description.length > DESCRIPTION_BUDGET - KRYPTO_DISCLOSURE_MAX
                  ? ` — your text is cut to ${DESCRIPTION_BUDGET - KRYPTO_DISCLOSURE_MAX} characters to make room.`
                  : '.'}
              </>
            )}
          </p>
        </div>

        {/* Image + pin. Two steps on purpose: picking a file touches nothing,
            pinning publishes it, and neither creates a token. */}
        <div className="mt-3 flex items-start gap-3">
          <button
            onClick={() => void pickImage()}
            disabled={busy !== ''}
            className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-white/15 bg-black/30 transition hover:border-krypt-purple/50 disabled:opacity-50"
          >
            {image ? (
              <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlus className="h-5 w-5 text-krypt-muted" />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-body font-semibold text-white/80">Image</div>
            <p className="mt-0.5 text-label leading-relaxed text-krypt-muted">
              {image ? image.name : 'PNG, JPG, GIF or WebP. This is the only thing most people will ever see of your token.'}
            </p>
            {image && (!draft.imageUrl || !draft.metadataUri) && (
              <button
                onClick={() => void upload()}
                disabled={busy !== '' || draft.name.trim() === '' || draft.symbol.trim() === ''}
                className="mt-2 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-body text-white/90 transition hover:bg-white/10 disabled:opacity-40"
              >
                {busy === 'upload' && <Loader2 className="h-3 w-3 animate-spin" />}
                Pin to IPFS
              </button>
            )}
            {draft.imageUrl && draft.metadataUri && (
              <div className="mt-1.5 flex items-center gap-1.5 text-label text-emerald-300">
                <Check className="h-3 w-3" /> Pinned. Nothing has been created yet.
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-3">
          <Field label="Twitter"><input value={draft.twitter} onChange={(e) => set('twitter', e.target.value)} placeholder="optional" className={inputCls} /></Field>
          <Field label="Telegram"><input value={draft.telegram} onChange={(e) => set('telegram', e.target.value)} placeholder="optional" className={inputCls} /></Field>
          <Field label="Website"><input value={draft.website} onChange={(e) => set('website', e.target.value)} placeholder="optional" className={inputCls} /></Field>
        </div>

        {/* ── your own first buy ──────────────────────────────────────── */}
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <Field label={`Your own first buy (${NATIVE[chain]})`} hint={`minimum ${MIN_DEV_BUY[chain]}`}>
            <input
              type="number"
              step="0.001"
              min={MIN_DEV_BUY[chain]}
              value={draft.devBuy}
              onChange={(e) => set('devBuy', Number(e.target.value))}
              className={cls(inputCls, 'font-mono')}
            />
          </Field>
          <p className="mt-1.5 text-label leading-relaxed text-krypt-muted">
            {chain === 'robinhood'
              ? 'Pons creates and buys in one call, so nobody can buy in front of you. The buy is billed the normal 0.5% platform fee, charged separately once the launch confirms.'
              : "pump's create and buy are separate instructions, so this app creates the token and then buys it through the ordinary trade path — verified, billed and booked as a real position. There is a window of a few seconds in between."}
          </p>
        </div>

        {/* ── per-chain options ───────────────────────────────────────── */}
        {chain === 'solana' ? (
          <div className="mt-3 space-y-2">
            {([
              ['mayhem', 'Mayhem mode', 'Trades against inflated virtual reserves, with the fee going to a reserved recipient.'],
              ['cashback', 'Cashback', 'Your entire creator fee is redirected to traders, permanently. This cannot be undone, and it is why the typical successful launch pays its creator nothing.'],
            ] as const).map(([key, label, why]) => (
              <button
                key={key}
                onClick={() => set(key, !draft[key])}
                className="flex w-full items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/5"
              >
                <span className={cls('mt-0.5 h-3.5 w-3.5 shrink-0 rounded border', draft[key] ? 'border-krypt-purple bg-krypt-purple/40' : 'border-white/20')} />
                <span className="min-w-0">
                  <span className="block text-body font-semibold text-white/90">{label}</span>
                  <span className="block text-label leading-relaxed text-krypt-muted">{why}</span>
                </span>
              </button>
            ))}

            {/* ── $Krypto Mode ─────────────────────────────────────────── */}
            <div className={cls('rounded-lg border p-3', draft.krypto.enabled ? 'border-krypt-purple/40 bg-krypt-purple/[0.07]' : 'border-white/10 bg-white/[0.02]')}>
              <button onClick={() => setKrypto({ enabled: !draft.krypto.enabled })} className="flex w-full items-start gap-2.5 text-left">
                <span className={cls('mt-0.5 h-3.5 w-3.5 shrink-0 rounded border', draft.krypto.enabled ? 'border-krypt-purple bg-krypt-purple/40' : 'border-white/20')} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-body font-semibold text-white/90">
                    <Bot className="h-3.5 w-3.5 text-krypt-purple" /> $Krypto Mode
                  </span>
                  <span className="block text-label leading-relaxed text-krypt-muted">
                    Your coin gets its own trading bot from the moment it launches, run by a built-in strategy, your AI key, or an AI
                    over MCP. It trades from a new wallet made for it, and <span className="text-white/80">that wallet is written
                    into the coin’s description</span>, like mayhem mode is on-chain: anyone can see the bot and every trade it makes.
                    Turn it on before you pin.
                  </span>
                </span>
              </button>
              {draft.krypto.enabled && (
                <div className="mt-3 space-y-3">
                  <Field label="Who drives it">
                    <div className="grid grid-cols-3 gap-1.5">
                      {KRYPTO_DRIVERS.map((d) => (
                        <button
                          key={d}
                          onClick={() => setKrypto({ driver: d })}
                          className={cls('rounded-lg border px-2 py-1.5 text-body transition', draft.krypto.driver === d ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10')}
                        >
                          {KRYPTO_DRIVER_TEXT[d].label}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <p className="-mt-1.5 text-label leading-relaxed text-krypt-muted">{KRYPTO_DRIVER_TEXT[draft.krypto.driver].help}</p>
                  {draft.krypto.driver === 'strategy' && (
                    <div className="space-y-1.5">
                      {KRYPTO_STRATEGIES.map((st) => (
                        <button
                          key={st}
                          onClick={() => setKrypto({ strategy: st })}
                          className={cls('flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition', draft.krypto.strategy === st ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-white/[0.02] hover:bg-white/5')}
                        >
                          <span className={cls('mt-1 h-2.5 w-2.5 shrink-0 rounded-full border', draft.krypto.strategy === st ? 'border-krypt-purple bg-krypt-purple' : 'border-white/30')} />
                          <span className="min-w-0">
                            <span className="block text-body font-semibold text-white/90">{KRYPTO_STRATEGY_TEXT[st].label}</span>
                            <span className="block text-label leading-relaxed text-krypt-muted">{KRYPTO_STRATEGY_TEXT[st].help}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <Field label="Budget (SOL)" hint={`${KRYPTO_MIN_BUDGET_SOL}–${KRYPTO_MAX_BUDGET_SOL}, the most the bot has in play at once`}>
                    <input
                      type="number"
                      step="0.01"
                      min={KRYPTO_MIN_BUDGET_SOL}
                      max={KRYPTO_MAX_BUDGET_SOL}
                      value={draft.krypto.budgetSol}
                      onChange={(e) => setKrypto({ budgetSol: Number(e.target.value) })}
                      className={cls(inputCls, 'font-mono')}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      [false, 'Start on paper', 'Simulated at the live price. Go live from the Krypto Mode tab when you are happy.'],
                      [true, 'Start live', `Funds ${draft.krypto.budgetSol} SOL from the launch wallet into the bot wallet right after launch.`],
                    ] as const).map(([live, label, why]) => (
                      <button
                        key={label}
                        onClick={() => setKrypto({ live })}
                        className={cls('rounded-lg border px-3 py-2 text-left transition', draft.krypto.live === live ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-white/[0.02] hover:bg-white/5')}
                      >
                        <span className="block text-body font-semibold text-white/90">{label}</span>
                        <span className="block text-label leading-relaxed text-krypt-muted">{why}</span>
                      </button>
                    ))}
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 text-label leading-relaxed text-krypt-muted">
                    <div className="mb-1 font-semibold text-white/80">This line goes into the description:</div>
                    <div className="break-all font-mono text-white/70">
                      {kryptoDisclosure(kryptoAddress && draft.metadataUri ? kryptoAddress : '<the bot wallet — made when you pin>')}
                    </div>
                    <div className="mt-1.5">
                      Every trade goes through the normal trade path: 0.5% fee, your live limits and breakers. The bot never trades
                      faster than every 15 seconds, never buys back within a minute of a sell, and stops at 20 trades an hour, so it
                      manages a position rather than making volume.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <Field label="Creator fee (basis points)" hint={`0–${MAX_CREATOR_TAX_BPS}, paid to your launch wallet`}>
              <input
                type="number"
                step="1"
                min={0}
                max={MAX_CREATOR_TAX_BPS}
                value={draft.creatorTaxBps}
                onChange={(e) => set('creatorTaxBps', Math.round(Number(e.target.value)))}
                className={cls(inputCls, 'font-mono')}
              />
            </Field>
            <p className="mt-1 text-label text-krypt-muted">100 basis points is 1% of every trade, for as long as the token trades.</p>
          </div>
        )}

        {/* ── what is stopping this ───────────────────────────────────── */}
        {problems.length > 0 && cfg.enabled && walletPicked && (
          <ul className="mt-4 space-y-1 rounded-lg border border-white/10 bg-black/20 p-3 text-label leading-relaxed text-krypt-muted">
            {problems.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
        )}

        {checked && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] p-3 text-body leading-relaxed text-emerald-200">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{checked} Nothing has been created — press Launch to do it for real.</span>
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => void preview()}
            disabled={!canSend}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-note text-white/90 transition hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'preview' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Check it first
          </button>
          <button
            onClick={() => void send()}
            disabled={!canSend || checked === null}
            title={checked === null ? 'Check it first — a token cannot be un-created' : undefined}
            className="flex items-center gap-1.5 rounded-lg border border-krypt-pink/40 bg-krypt-pink/15 px-3 py-1.5 text-note font-semibold text-white transition hover:bg-krypt-pink/25 disabled:opacity-40"
          >
            {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            Launch {draft.symbol.trim() || 'it'}
          </button>
        </div>
      </div>

      {/* ── what you have earned ───────────────────────────────────────
          Shown whenever a Solana launch wallet is set, including before the
          first launch: a user who launched on a previous install and came
          back needs to find this, and a zero that is really a zero is worth
          saying out loud. An unreadable balance renders as a dash, never 0. */}
      {cfg.walletId && (
        <div className="mt-4 rounded-xl border border-white/10 bg-krypt-panel p-4">
          <div className="mb-1 flex items-center gap-2 text-value font-semibold text-white">
            <Coins className="h-3.5 w-3.5 text-arc-gold" /> Creator fees
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-base text-white">
                {claimableSol === null ? '—' : `${claimableSol.toFixed(6)} SOL`}
              </div>
              <p className="mt-0.5 text-body leading-relaxed text-krypt-muted">
                {fees?.failure
                  ? `Could not read your creator vault: ${fees.failure}`
                  : 'Everything every coin this wallet launched has paid you, in one vault. The vault keeps its rent, so this is what would actually arrive.'}
              </p>
            </div>
            <button
              onClick={() => void claim()}
              disabled={claiming || !claimableSol}
              title={claimableSol ? undefined : 'Nothing to claim yet'}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-arc-gold/40 bg-arc-gold/10 px-3 py-1.5 text-note font-semibold text-arc-gold transition hover:bg-arc-gold/20 disabled:opacity-40"
            >
              {claiming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Claim
            </button>
          </div>
        </div>
      )}

      {attempts.length > 0 && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-value font-semibold text-white">Every launch this page has sent</div>
          <p className="mb-2 mt-0.5 text-body leading-relaxed text-krypt-muted">
            Kept on this machine. A create that timed out may still have landed — look the transaction up before launching again.
          </p>
          <div>
            <div className="space-y-1.5">
              {attempts.map((a) => (
                <div key={`${a.at}-${a.hash ?? a.token ?? ''}`} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-body">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-white/90">
                      {a.symbol || '(no symbol)'} · {a.chain} · {new Date(a.at).toLocaleString()}
                    </span>
                    <span className="text-krypt-muted">{a.outcome}</span>
                  </div>
                  {a.token && <div className="mt-1 select-all break-all font-mono text-label text-krypt-muted">token {a.token}</div>}
                  {a.hash && <div className="select-all break-all font-mono text-label text-krypt-muted">tx {a.hash}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {created && (
        <div className="mt-4 rounded-xl border border-krypt-purple/40 bg-krypt-purple/10 p-4">
          <div className="text-value font-semibold text-white">{CHAIN_LABEL[created.chain]} · your token is live</div>
          <div className="mt-1 select-all break-all font-mono text-body text-krypt-muted">{created.token}</div>
          {created.note && <p className="mt-2 text-body leading-relaxed text-amber-200/80">Your own first buy did not go through: {created.note}</p>}
        </div>
      )}

      <div className="mt-5 space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-body leading-relaxed text-krypt-muted">
        <p className="font-semibold text-white/80">How this is kept safe</p>
        <p>
          The switch, the separate wallet, and a signer rule that accepts exactly one extra signature — the mint this app generates
          for your launch — and refuses everything else. With the switch off, a create is refused by the same rule that refused it
          before this page existed.
        </p>
        <p>
          Both create instructions were decoded from real transactions and are pinned by tests: Pons's{' '}
          <span className="font-mono">launchAndBuy</span> reproduces a real launch byte for byte, and all sixteen of pump's{' '}
          <span className="font-mono">create_v2</span> accounts derive from its own on-chain IDL and match three real launches.
          Every launch is simulated against the live chain before it is signed, and nothing is broadcast until that simulation
          passes.
        </p>
        <p>
          Your image and details are pinned to IPFS through pump.fun's public uploader, which returns an ordinary{' '}
          <span className="font-mono">ipfs.io</span> link. That link is what goes into the token, on either chain.
        </p>
      </div>
      </>
      )}
    </div>
  );
}
