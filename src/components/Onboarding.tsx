import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  ExternalLink,
  FileText,
  Gift,
  Info,
  KeyRound,
  Loader2,
  Rocket,
  ShieldAlert,
  Wallet as WalletIcon,
  Zap, PlayCircle } from 'lucide-react';
import { feePctLabel, referralProblem, TREASURY_ADDRESS } from '@shared/fees';
import { CLICKWRAP_SUMMARY, ALL_DOCUMENTS, type LegalDocument } from '@shared/legal/documents';
import { entityInfo } from '@shared/legal/entity';
import type { RouteId } from './Sidebar';
import { useAppState } from '../state/AppStateProvider';
import { GhostButton, PrimaryButton } from './common';
import { cls } from '../utils/format';

// First run.
//
// ─── Order matters ────────────────────────────────────────────────────
//
//  1. LEGAL — a hard gate. Nothing happens until the user affirmatively
//     agrees. legalcheck.md: a link in a footer is not acceptance, and the
//     plain-language summary is what makes it enforceable when someone later
//     says "I never read it". Full text is one click away and works offline.
//     The platform fee is disclosed HERE, in the accept summary — not in a
//     later step — so it sits with the terms the user actually agrees to.
//  2. REFERRAL — optional; just "a friend referred you? paste their address".
//  3. KEYS — the app works with no keys at all, so this is opt-in help, not a
//     wall. The fields are HERE rather than a pointer to Settings: "where do I
//     put my API key" is best answered by letting them put it in.
//  4. WALLET, then 5. READY.
//
// Only step 1 blocks. Everything after it can be skipped, because an
// onboarding that traps someone who just wants to look around is a worse
// product than one they can escape.

type Step = 'loading' | 'legal' | 'referral' | 'keys' | 'wallet' | 'ready' | 'done';

const FLOW: Step[] = ['referral', 'keys', 'wallet', 'ready'];

/** Accept a bare key or a whole pasted Helius URL — people paste both. */
function extractHeliusKey(raw: string): string {
  const t = raw.trim();
  const fromUrl = t.match(/api-key=([A-Za-z0-9-]+)/);
  return fromUrl ? fromUrl[1] : t;
}

function Reader({ onBack }: { onBack: () => void }) {
  const [open, setOpen] = useState<LegalDocument['id']>('terms');
  const doc = ALL_DOCUMENTS.find((d) => d.id === open) ?? ALL_DOCUMENTS[0];
  return (
    <>
      <div className="px-6 py-3 border-b border-white/10 flex items-center gap-2 flex-wrap">
        <GhostButton onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </GhostButton>
        {ALL_DOCUMENTS.map((d) => (
          <button
            key={d.id}
            onClick={() => setOpen(d.id)}
            className={cls(
              'rounded-md border px-2.5 py-1 text-[10px] font-semibold transition',
              d.id === open
                ? 'border-krypt-purple/40 bg-krypt-purple/15 text-white'
                : 'border-white/10 bg-black/25 text-krypt-muted hover:text-white',
            )}
          >
            {d.title}
          </button>
        ))}
      </div>
      <div className="px-6 py-4 max-h-[52vh] overflow-y-auto">
        <div className="font-display text-[13px] font-semibold text-white">{doc.title}</div>
        <div className="text-[10px] text-krypt-muted/70 mb-3">{doc.subtitle}</div>
        {doc.sections.map((sec) => (
          <div key={sec.heading} className="mb-3">
            <h3 className={cls('text-[11px] font-semibold mb-1', sec.emphasis ? 'text-arc-gold' : 'text-white')}>
              {sec.heading}
            </h3>
            {sec.body.map((para, i) => (
              <p
                key={i}
                className={cls(
                  'text-[11px] leading-relaxed mb-1.5',
                  sec.emphasis ? 'text-white/90 font-medium' : 'text-krypt-muted',
                )}
              >
                {para}
              </p>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function StepDots({ current }: { current: Step }) {
  const idx = FLOW.indexOf(current);
  if (idx < 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {FLOW.map((s, i) => (
        <span
          key={s}
          className={cls(
            'h-1.5 rounded-full transition-all',
            i === idx ? 'w-5 bg-krypt-purple' : i < idx ? 'w-1.5 bg-krypt-purple/50' : 'w-1.5 bg-white/15',
          )}
        />
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  saved,
  link,
  onLink,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  saved: boolean;
  link: string;
  onLink: () => void;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold text-white">{label}</span>
        {saved && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">
            <Check className="h-2.5 w-2.5" /> saved
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onLink}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-krypt-purple hover:text-white transition-colors"
        >
          {link} <ExternalLink className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-krypt-muted">{hint}</p>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        className="mt-2 w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
      />
    </div>
  );
}

/** The guide video, offered at the end of onboarding and from About. */
const VIDEO_URL = 'https://www.youtube.com/watch?v=pqIWxrocy68';

export function Onboarding({
  onNavigate,
  onGateChange,
}: {
  onNavigate?: (route: RouteId) => void;
  /** Reports whether the gate is currently up. App marks the shell behind
   *  it `inert` while true, so Tab/Enter cannot reach the Paper/Live toggle
   *  or a quick-buy before the terms are accepted. */
  onGateChange?: (gated: boolean) => void;
}) {
  const { settings, updateSettings } = useAppState();
  const info = entityInfo();

  const [step, setStep] = useState<Step>('loading');
  const gated = step !== 'done';
  useEffect(() => {
    onGateChange?.(gated);
  }, [gated, onGateChange]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (step !== 'loading' && step !== 'done') boxRef.current?.focus();
  }, [step]);
  const [reading, setReading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [addr, setAddr] = useState('');
  const [touched, setTouched] = useState(false);
  const [helius, setHelius] = useState('');
  const [birdeye, setBirdeye] = useState('');
  const [savedHelius, setSavedHelius] = useState(false);
  const [savedBirdeye, setSavedBirdeye] = useState(false);

  const refresh = useCallback(async () => {
    const r = await window.krypt.legal.status();
    const accepted = r.ok && r.data ? r.data.accepted : false;
    if (!accepted) {
      setStep('legal');
      return;
    }
    setStep(settings.onboarded ? 'done' : 'referral');
  }, [settings.onboarded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const problem = touched ? referralProblem(addr, { ownAddresses: [], treasury: TREASURY_ADDRESS }) : null;

  if (step === 'loading' || step === 'done') return null;

  const acceptLegal = async (): Promise<void> => {
    setBusy(true);
    await window.krypt.legal.accept();
    setBusy(false);
    setStep(settings.onboarded ? 'done' : 'referral');
  };

  /** Persist the referral choice as soon as it is made, so closing the app
   *  mid-setup does not lose the one answer we cannot ask for again. */
  const goFromFee = async (): Promise<void> => {
    setBusy(true);
    await updateSettings({ referrer: addr.trim() });
    setBusy(false);
    setStep('keys');
  };

  const saveHelius = async (): Promise<void> => {
    const key = extractHeliusKey(helius);
    if (!/^[A-Za-z0-9-]{8,}$/.test(key)) return;
    await updateSettings({ rpc: { ...settings.rpc, heliusApiKey: key } });
    setSavedHelius(true);
  };

  const saveBirdeye = async (): Promise<void> => {
    const key = birdeye.trim();
    if (key.length < 8) return;
    await updateSettings({ data: { ...settings.data, birdeyeApiKey: key } });
    setSavedBirdeye(true);
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    await updateSettings({ onboarded: true });
    setBusy(false);
    setStep('done');
  };

  const jump = (route: RouteId): void => {
    void finish().then(() => onNavigate?.(route));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-sm p-6">
      <div ref={boxRef} tabIndex={-1} className="w-full max-w-xl rounded-lg border border-white/10 bg-krypt-panel shadow-2xl outline-none">
        <div className="px-6 pt-6 pb-4 border-b border-white/10 flex items-end gap-3">
          <div className="flex-1">
            <div className="font-display text-[11px] tracking-[0.36em] text-arc-gold/80">WELCOME TO</div>
            <div className="font-display text-2xl font-bold text-krypt-gradient tracking-[0.12em] mt-1">
              KRYPT TERMINAL
            </div>
            {step === 'legal' && (
              <div className="text-[10px] text-krypt-muted/70 mt-1.5">
                Published by {info.entity} · terms version {info.termsVersion}
              </div>
            )}
          </div>
          <StepDots current={step} />
        </div>

        {/* ── 1. Legal gate ─────────────────────────────────────────── */}
        {step === 'legal' && reading && <Reader onBack={() => setReading(false)} />}

        {step === 'legal' && !reading && (
          <>
            <div className="px-6 py-4 max-h-[54vh] overflow-y-auto">
              <p className="text-[11px] leading-relaxed text-krypt-muted mb-3">
                Before you use {info.product}, please read this summary. It is short on purpose, and the full documents
                are one click away.
              </p>
              <div className="space-y-2.5">
                {CLICKWRAP_SUMMARY.map((pt) => (
                  <div
                    key={pt.title}
                    className={cls(
                      'rounded-md border px-3 py-2',
                      pt.flagged ? 'border-arc-gold/25 bg-arc-gold/[0.06]' : 'border-white/10 bg-black/25',
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
                      {pt.flagged ? (
                        <AlertTriangle className="h-3.5 w-3.5 text-arc-gold flex-shrink-0" />
                      ) : (
                        <Info className="h-3.5 w-3.5 text-krypt-purple flex-shrink-0" />
                      )}
                      {pt.title}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-krypt-muted">{pt.detail}</p>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setReading(true)}
                className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-krypt-purple hover:text-white transition-colors"
              >
                <FileText className="h-3.5 w-3.5" />
                Read the full Terms of Service, Privacy Policy and Software Terms
              </button>
            </div>

            <div className="px-6 py-4 border-t border-white/10">
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 accent-krypt-purple"
                />
                <span className="text-[11px] leading-relaxed text-krypt-muted">
                  I am {info.minimumAge} or older, I have read and agree to the{' '}
                  <span className="text-white">Terms of Service</span>,{' '}
                  <span className="text-white">Privacy Policy</span> and{' '}
                  <span className="text-white">Software Terms</span>, and I understand this software carries a risk of
                  total financial loss and that disputes are resolved by individual arbitration.
                </span>
              </label>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[10px] text-krypt-muted/60">Declining closes the app.</span>
                <div className="flex-1" />
                <GhostButton onClick={() => void window.krypt.app.quit()} disabled={busy} destructive>
                  Decline &amp; quit
                </GhostButton>
                <PrimaryButton onClick={() => void acceptLegal()} disabled={!agreed || busy}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                  I agree &amp; continue
                </PrimaryButton>
              </div>
            </div>
          </>
        )}

        {/* ── 2. Cost + referral ────────────────────────────────────── */}
        {step === 'referral' && (
          <>
            <div className="px-6 py-6 space-y-3">
              <div className="flex items-center gap-2 text-white text-[13px] font-semibold">
                <Gift className="h-4 w-4 text-arc-gold" />
                Have a friend who referred you?
              </div>
              <p className="text-[11px] leading-relaxed text-krypt-muted">
                Put their Solana address below and they&apos;ll earn rewards as you trade. Leave it blank if not.
              </p>
              <input
                value={addr}
                onChange={(e) => {
                  setAddr(e.target.value);
                  setTouched(true);
                }}
                spellCheck={false}
                placeholder="Their SOL address (optional)"
                className="w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
              />
              {problem && <p className="text-[11px] text-rose-300">{problem}</p>}
            </div>
            <div className="px-6 py-4 border-t border-white/10 flex items-center gap-2">
              <span className="text-[10px] text-krypt-muted/60">You can add this later in Settings.</span>
              <div className="flex-1" />
              <PrimaryButton onClick={() => void goFromFee()} disabled={!!problem || busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                Continue
              </PrimaryButton>
            </div>
          </>
        )}

        {/* ── 3. API keys ───────────────────────────────────────────── */}
        {step === 'keys' && (
          <>
            <div className="px-6 py-5 space-y-3 max-h-[56vh] overflow-y-auto">
              <div className="flex items-center gap-2 text-white text-[12px] font-semibold">
                <KeyRound className="h-3.5 w-3.5 text-krypt-purple" />
                Connect your data (optional)
              </div>
              <p className="text-[11px] leading-relaxed text-krypt-muted">
                <span className="text-white">Krypto works right now with no keys at all.</span> It races several free
                public Solana endpoints for the launch feed. These two are free upgrades — paste them here, or skip and
                add them any time under Settings.
              </p>

              <Field
                label="Helius API key"
                hint="Free tier. Used only where it matters — trade simulation, sending, confirmation and fee estimates — so a free key lasts months. Bulk scanning stays on public endpoints. Paste the key or the whole URL."
                value={helius}
                onChange={(v) => {
                  setHelius(v);
                  setSavedHelius(false);
                }}
                placeholder="Helius API key, or paste the full https://…?api-key=… URL"
                saved={savedHelius || !!settings.rpc.heliusApiKey}
                link="Get a free key"
                onLink={() => void window.krypt.app.openExternal('https://dashboard.helius.dev')}
              />

              <Field
                label="Birdeye API key"
                hint="Optional. Adds sub-minute price candles for charts. Everything else works without it."
                value={birdeye}
                onChange={(v) => {
                  setBirdeye(v);
                  setSavedBirdeye(false);
                }}
                placeholder="Birdeye API key"
                saved={savedBirdeye || !!settings.data.birdeyeApiKey}
                link="Get a key"
                onLink={() => void window.krypt.app.openExternal('https://bds.birdeye.so')}
              />

              <p className="text-[10px] leading-relaxed text-krypt-muted/60">
                Keys are stored on this machine only and are stripped from recordings. They are never sent to Krypt —
                there is no Krypt server to send them to.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-white/10 flex items-center gap-2">
              <GhostButton onClick={() => setStep('referral')} disabled={busy}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </GhostButton>
              <div className="flex-1" />
              <GhostButton onClick={() => setStep('wallet')} disabled={busy}>
                Skip for now
              </GhostButton>
              <PrimaryButton
                onClick={async () => {
                  setBusy(true);
                  if (helius.trim()) await saveHelius();
                  if (birdeye.trim()) await saveBirdeye();
                  setBusy(false);
                  setStep('wallet');
                }}
                disabled={busy}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                Save &amp; continue
              </PrimaryButton>
            </div>
          </>
        )}

        {/* ── 4. Wallet ─────────────────────────────────────────────── */}
        {step === 'wallet' && (
          <>
            <div className="px-6 py-5 space-y-3 max-h-[56vh] overflow-y-auto">
              <div className="flex items-center gap-2 text-white text-[12px] font-semibold">
                <WalletIcon className="h-3.5 w-3.5 text-krypt-purple" />
                Your trading wallet
              </div>
              <p className="text-[11px] leading-relaxed text-krypt-muted">
                Krypto can browse, score and research tokens with no wallet at all. You only need one to place a trade.
              </p>
              <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2.5 space-y-1.5">
                <p className="text-[11px] leading-relaxed text-krypt-muted">
                  <span className="text-white">Use a dedicated hot wallet.</span> Generate a fresh one under Wallet, or
                  import an existing key. Fund it with an amount you would not mind losing entirely — not your main
                  wallet.
                </p>
                <p className="text-[11px] leading-relaxed text-krypt-muted">
                  <span className="text-white">Your key is encrypted by Windows</span> and never leaves this machine. If
                  your OS cannot store it securely, Krypto refuses to store it at all rather than leave it in the clear.
                </p>
                <p className="text-[11px] leading-relaxed text-krypt-muted">
                  <span className="text-white">Once this wallet exists the app is in Live mode</span> — a trade you place
                  spends real SOL. Switch to Paper in the top bar to practise first. Nothing trades on its own: there is a
                  per-trade cap, a balance cap and a kill switch, and the scanner only flags tokens.
                </p>
              </div>
              <div className="rounded-md border border-arc-gold/25 bg-arc-gold/[0.06] px-3 py-2">
                <p className="text-[11px] leading-relaxed text-krypt-muted">
                  <AlertTriangle className="inline h-3.5 w-3.5 text-arc-gold mr-1 -mt-0.5" />
                  Back up your key somewhere safe before you fund it. Nobody — including Krypt — can recover it for you.
                </p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-white/10 flex items-center gap-2">
              <GhostButton onClick={() => setStep('keys')} disabled={busy}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </GhostButton>
              <div className="flex-1" />
              <GhostButton onClick={() => setStep('ready')} disabled={busy}>
                Later
              </GhostButton>
              <PrimaryButton onClick={() => jump('wallet')} disabled={busy}>
                <WalletIcon className="h-3.5 w-3.5" /> Set up a wallet
              </PrimaryButton>
            </div>
          </>
        )}

        {/* ── 5. Ready ──────────────────────────────────────────────── */}
        {step === 'ready' && (
          <>
            <div className="px-6 py-5 space-y-3 max-h-[56vh] overflow-y-auto">
              <div className="flex items-center gap-2 text-white text-[12px] font-semibold">
                <Rocket className="h-3.5 w-3.5 text-arc-gold" />
                You’re set
              </div>
              <div className="space-y-2">
                {[
                  {
                    icon: Compass,
                    title: 'Discover',
                    detail:
                      'Four live columns — New, Graduating, Migrated and Trending — across pump.fun, LaunchLab, Meteora and Boop. Click any token to open its full breakdown.',
                  },
                  {
                    icon: ShieldAlert,
                    title: 'Check before you buy',
                    detail:
                      'Every token page shows holders, the dev’s track record, bundle and sniper cohorts, and a risk score. Anything Krypt could not verify shows a dash, never a zero.',
                  },
                  {
                    icon: Zap,
                    title: 'Trade manually',
                    detail: `Arm live execution on the Wallet page, then buy and sell from the token page. Stop losses and take profits live under Orders. Krypt takes a ${feePctLabel()} fee per trade — about half the going rate — charged on-chain in the same transaction.`,
                  },
                  {
                    icon: KeyRound,
                    title: 'Everything is under Settings',
                    detail:
                      'API keys, market-data providers, hotkeys, chat bots, the fee details and your referrer — all there at any time.',
                  },
                ].map((row) => (
                  <div key={row.title} className="rounded-md border border-white/10 bg-black/25 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
                      <row.icon className="h-3.5 w-3.5 text-krypt-purple flex-shrink-0" />
                      {row.title}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-krypt-muted">{row.detail}</p>
                  </div>
                ))}
              </div>
              {/* Offered at the end rather than the start: someone who has
                  just made a wallet is the person most likely to watch it,
                  and it opens in their browser so it never blocks setup. */}
              <button
                onClick={() => void window.krypt.app.openExternal(VIDEO_URL)}
                className="flex w-full items-center gap-3 rounded-md border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-2.5 text-left transition hover:bg-krypt-purple/20"
              >
                <PlayCircle className="h-5 w-5 flex-shrink-0 text-krypt-purple" />
                <span>
                  <span className="block text-[11px] font-semibold text-white">Watch the guide (10 min)</span>
                  <span className="block text-[10px] leading-relaxed text-krypt-muted">
                    The whole app end to end, including the parts that lose people money. Opens in your browser.
                  </span>
                </span>
              </button>
              <p className="text-[10px] leading-relaxed text-krypt-muted/60">
                Start small. Memecoins are the most volatile assets there are, and most go to zero.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-white/10 flex items-center gap-2">
              <GhostButton onClick={() => setStep('wallet')} disabled={busy}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </GhostButton>
              <div className="flex-1" />
              <PrimaryButton onClick={() => void finish()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Compass className="h-3.5 w-3.5" />}
                Start exploring
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
