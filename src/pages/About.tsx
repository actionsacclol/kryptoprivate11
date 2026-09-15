import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/version';
import { ExternalLink, FolderOpen, RotateCcw, ShieldAlert } from 'lucide-react';
import { Card, GhostButton, Page, Section } from '../components/common';
import { GuidePanel } from '../components/GuidePanel';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';

const TOOLS: Array<{ name: string; desc: string; url: string }> = [
  { name: 'Krypt Macro', desc: 'Mouse + keyboard macro recorder', url: 'https://krypt.cc/tools/macro' },
  { name: 'Krypt Crosshair', desc: 'Custom overlay crosshairs', url: 'https://krypt.cc/tools/crosshair' },
  { name: 'Krypt Tweaker', desc: 'Windows optimization, reversible', url: 'https://krypt.cc/tools/tweaker' },
  { name: 'Krypt Cleaner', desc: 'System cleanup without the scam', url: 'https://krypt.cc/tools/cleaner' },
];

export function About() {
  const { updateSettings } = useAppState();
  const toast = useToast();
  const [version, setVersion] = useState('…');
  const [paths, setPaths] = useState<{ logs: string | null; crashes: string | null }>({ logs: null, crashes: null });
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    void window.krypt.app.version().then((r) => {
      if (r.ok && r.data) setVersion(r.data);
    });
    void window.krypt.app.logPaths().then((r) => {
      if (r.ok && r.data) setPaths(r.data);
    });
    void window.krypt.update.status().then((r) => {
      if (r.ok && r.data) setUpdate(r.data);
    });
  }, []);

  // The only place in the app that can force a check. Everywhere else reads
  // what main already knows.
  const checkForUpdate = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await window.krypt.update.check();
      if (r.ok && r.data) setUpdate(r.data);
      else toast.error(r.message);
    } finally {
      setChecking(false);
    }
  };

  const openLogs = async (): Promise<void> => {
    const r = await window.krypt.app.openLogs();
    if (!r.ok) toast.error(r.message || 'Could not open the logs folder');
  };

  // Replaying onboarding just clears the `onboarded` flag. The Onboarding
  // component (mounted at the app root, over every page) re-reads it and shows
  // the flow again — starting at the referral step, NOT the legal gate, because
  // acceptance is tracked separately and is not being revoked.
  const replayOnboarding = async (): Promise<void> => {
    await updateSettings({ onboarded: false });
    toast.success('Onboarding restarted');
  };

  return (
    <Page title="About" subtitle={`Krypto Bot v${version}`}>
      <Section>
        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <img
              src="./krypt.png"
              alt=""
              className="h-12 w-12 rounded-lg drop-shadow-[0_0_6px_rgba(168,85,247,0.55)]"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
            <div>
              <div className="text-lg font-bold">
                <span className="text-krypt-gradient">Krypto</span> <span className="text-white">Terminal</span>
              </div>
              <div className="text-xs text-krypt-muted">Free. No ads. No telemetry.</div>
            </div>
          </div>
          <p className="text-sm text-krypt-muted leading-relaxed">
            A local-first Solana memecoin trading terminal. It reads new launches directly on-chain
            across Pump.fun, LaunchLab, Meteora and Boop, scores the first seconds of real trading,
            checks holders, the dev&apos;s history and bundle/sniper cohorts, and lets you trade
            manually from a wallet whose key never leaves your machine. Everything unknown renders as
            a dash, never a fabricated zero.
          </p>
        </Card>
      </Section>

      <Section title="Version">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {/* Four states, and three of them are not "you are fine".
                  "Could not check" must never read as "up to date" — a user
                  told they are current by an app that never asked stops
                  checking. See shared/version.ts. */}
              <div className="text-sm text-white/90">
                {update === null ? 'Reading…' : update.detail}
              </div>
              <div className="mt-0.5 text-xs text-krypt-muted">
                {update?.checkedAt
                  ? `Last checked ${new Date(update.checkedAt).toLocaleString()}.`
                  : 'Not checked yet this session.'}{' '}
                Nothing is downloaded or installed automatically — updates are installed by you, from krypt.cc.
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => void checkForUpdate()}
                disabled={checking}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check now'}
              </button>
              {update?.state === 'update' && (
                <button
                  onClick={() => window.krypt.app.openExternal('https://krypt.cc')}
                  className="rounded-lg border border-krypt-purple/40 bg-krypt-purple/15 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-krypt-purple/25"
                >
                  Get {update.latest}
                </button>
              )}
            </div>
          </div>
        </Card>
      </Section>

      <GuidePanel />

      <Section title="Onboarding">
        <Card>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-note text-krypt-muted leading-relaxed flex-1 min-w-[200px]">
              Want the welcome walkthrough again — the fee summary, API keys, wallet setup and the
              quick tour? Replay it any time.
            </p>
            <GhostButton onClick={() => void replayOnboarding()}>
              <RotateCcw className="h-3.5 w-3.5" /> Replay onboarding
            </GhostButton>
          </div>
        </Card>
      </Section>

      <Section title="Market data">
        <Card>
          <div className="text-note text-krypt-muted leading-relaxed space-y-2">
            <p>
              Prices, pools and token facts come from providers this app queries directly from your
              machine. Two of them ask to be credited where their data is shown, and this is that
              credit.
            </p>
            <p>
              <span className="text-white">Powered by Jupiter.</span> Routing, token records and
              Shield warnings.
            </p>
            <p>
              <span className="text-white">On-chain data provided by GeckoTerminal.</span> Pools,
              candles and token information.
            </p>
            <p>
              Also queried: DexScreener, pump.fun, RugCheck, and Birdeye or Solana RPC endpoints you
              configure yourself. Section 4 of the Privacy Policy lists every host and what each one
              can see.
            </p>
          </div>
        </Card>
      </Section>

      <Section title="Logs & diagnostics">
        <Card>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-note text-krypt-muted leading-relaxed flex-1 min-w-[200px] space-y-1">
              <p>
                Everything the app logs is kept on disk (API keys redacted) so a problem can be
                reported after the fact. Attach <span className="text-white">app.log</span> and any
                crash file when asking for help.
              </p>
              <p className="font-mono text-body break-all">Log: {paths.logs ?? '—'}</p>
              <p className="font-mono text-body break-all">Crash files: {paths.crashes ?? '—'}</p>
            </div>
            <GhostButton onClick={() => void openLogs()}>
              <FolderOpen className="h-3.5 w-3.5" /> Open logs folder
            </GhostButton>
          </div>
        </Card>
      </Section>

      <Section title="Responsible use">
        <Card className="border-amber-400/20">
          <div className="flex gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-300 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-krypt-muted leading-relaxed space-y-2">
              <p>
                Memecoin trading is extremely high risk: a large majority of new launches die the
                same day they appear, and no filter catches every rug. The app runs in
                <span className="text-white font-semibold"> Live mode by default on Solana</span> once a
                wallet exists, so a trade you place spends real SOL; Paper mode in the top bar simulates
                instead. It signs only with a dedicated hot wallet whose key is encrypted on this
                machine, and on Solana is bounded by a per-trade cap, a balance cap and a kill switch.
                The EVM chains (Robinhood Chain, BNB Smart Chain) start in Paper, are armed by hand per
                chain, and have no caps yet. Krypt takes 0.5 % of each side of a trade on every chain.
                Trade with lunch money, never your main wallet.
                Nothing here is financial advice.
              </p>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="More free Krypt tools">
        <div className="grid grid-cols-2 gap-3">
          {TOOLS.map((t) => (
            <Card key={t.name} hoverable className="cursor-pointer" >
              <button
                onClick={() => void window.krypt.app.openExternal(t.url)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-white">{t.name}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-krypt-muted" />
                </div>
                <div className="text-xs text-krypt-muted mt-1">{t.desc}</div>
              </button>
            </Card>
          ))}
        </div>
      </Section>
    </Page>
  );
}
