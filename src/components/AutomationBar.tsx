import { useCallback, useEffect, useState } from 'react';
import { OctagonX, Play, Square } from 'lucide-react';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { cls } from '../utils/format';
import { EVM_CHAIN_META, EVM_CHAINS, type EvmChainKind } from '@shared/evm';

// Engine controls, on the automation routes where they belong.
//
// These lived in the global top bar, from when this app was only a sniper
// bot. It is now mainly a terminal, and a permanent "Start scanning" button
// above a chart is noise at best — at worst it invites starting the automation
// by accident while you are trading by hand.
//
// What did NOT move is the awareness of a running engine. TopBar keeps a
// compact chip whenever the engine is running, entries are paused, positions
// are open, or live trading is armed. Hiding a bot that is spending money
// would be a worse bug than the clutter this fixes.

/**
 * One button per scanner, because there are three of them now.
 *
 * This used to be a single "Start scanning" for the Solana engine. Once the
 * EVM chains got Observatories of their own, that button sat above a Robinhood
 * page and started SOLANA — the same words meaning a different thing depending
 * on where you were standing. So each scanner is named and controlled
 * separately, and all three states are visible from any automation page:
 * hiding a running scanner behind a page you are not on is how someone leaves
 * one polling for a week.
 *
 * A scanner spends nothing. These are not money controls — the Paper/Live
 * switch in the top bar is the only one of those.
 */
function ScannerButton({
  label,
  title,
  running,
  disabled,
  onToggle,
}: {
  label: string;
  title: string;
  running: boolean | null;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={title}
      className={cls(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-note font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
        running
          ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white hover:bg-krypt-purple/25'
          : 'border-white/10 bg-white/5 text-white/80 hover:border-white/20 hover:bg-white/10',
      )}
    >
      {running ? <Square className="h-3 w-3 text-rose-300" /> : <Play className="h-3 w-3" />}
      {label}
      {/* Unknown is not "off": a scanner whose state we could not read gets a
          dash, so nobody reads a grey dot as "nothing is running". */}
      <span
        className={cls(
          'h-1.5 w-1.5 rounded-full',
          running === null ? 'bg-amber-300' : running ? 'animate-pulse-slow bg-emerald-400' : 'bg-white/25',
        )}
        aria-hidden
      />
    </button>
  );
}

/** Live running state of both EVM scanners, pushed by the engine event feed. */
function useEvmScanners(): { running: Record<EvmChainKind, boolean | null>; refresh: () => void } {
  const [running, setRunning] = useState<Record<EvmChainKind, boolean | null>>({ robinhood: null, bnb: null });

  const evmSettings = useAppState().settings.evm;
  const refresh = useCallback(() => {
    for (const c of EVM_CHAINS) {
      // A chain switched off has no scanner to ask about.
      if (!evmSettings[c].enabled) {
        setRunning((cur) => ({ ...cur, [c]: null }));
        continue;
      }
      void window.krypt.evm.scan.status(c).then((r) => {
        setRunning((cur) => ({ ...cur, [c]: r.ok && r.data ? r.data.running : null }));
      });
    }
  }, [evmSettings]);

  useEffect(() => {
    refresh();
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind !== 'evmScan') return;
      setRunning((cur) => ({ ...cur, [ev.status.chain]: ev.status.running }));
    });
  }, [refresh]);

  return { running, refresh };
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-micro font-display uppercase tracking-label text-krypt-muted">{label}</span>
      <span className="font-mono text-note text-white/85">{value}</span>
    </div>
  );
}

export function AutomationBar() {
  const { status, settings, startEngine, stopEngine, killSwitch } = useAppState();
  const modal = useModal();
  const scanners = useEvmScanners();

  const toggleEvm = async (chain: EvmChainKind, running: boolean | null): Promise<void> => {
    if (running) await window.krypt.evm.scan.stop(chain);
    else await window.krypt.evm.scan.start(chain);
    scanners.refresh();
  };

  // The kill switch is disabled only when there is genuinely nothing to stop.
  // It used to hang off `openPositions`, which counts ONLY the autonomous
  // strategy paper book — a book whose one producer sits behind
  // `strategy.paperEntries`, off by default. So on a default install the
  // button that stops the engine and disarms live execution on every chain
  // was permanently greyed out, exactly when a panicking user reaches for it.
  const nothingToStop = !status.running && status.openPositions === 0 && !status.liveActive;

  const onKill = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Kill switch',
      message: `Stop the engine, disarm live execution on every chain (Solana, Robinhood, BNB) and close every open paper position (${status.openPositions}). Tokens you actually hold are left alone — sell those from the Holdings page.`,
      confirmLabel: 'Stop everything',
      destructive: true,
    });
    if (yes) void killSwitch();
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/8 bg-black/20 px-6 py-2.5">
      <span className="flex items-center gap-1.5">
        <span className="text-micro font-display uppercase tracking-label text-krypt-muted">Scanners</span>
        <ScannerButton
          label="Solana"
          title={status.running ? 'Stop the Solana engine' : 'Start the Solana engine — it watches launches and never trades'}
          running={status.running}
          onToggle={() => void (status.running ? stopEngine() : startEngine())}
        />
        {EVM_CHAINS.map((c) => (
          <ScannerButton
            key={c}
            label={EVM_CHAIN_META[c].shortName}
            title={
              !settings.evm[c].enabled
                ? `${EVM_CHAIN_META[c].name} is turned off in Settings`
                : scanners.running[c]
                  ? `Stop watching ${EVM_CHAIN_META[c].name}`
                  : `Watch ${EVM_CHAIN_META[c].launchpadLabel} launches on ${EVM_CHAIN_META[c].name}`
            }
            running={scanners.running[c]}
            disabled={!settings.evm[c].enabled}
            onToggle={() => void toggleEvm(c, scanners.running[c])}
          />
        ))}
      </span>

      <button
        onClick={() => void onKill()}
        disabled={nothingToStop}
        title={
          nothingToStop
            ? 'Nothing is running, armed, or open'
            : 'Stop the engine, disarm live execution on every chain, and close every open paper position'
        }
        className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-1.5 text-value font-semibold text-rose-200 transition hover:bg-rose-500/20 hover:shadow-crimson-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
      >
        <OctagonX className="h-3.5 w-3.5" />
        Kill switch
      </button>

      {status.running && status.entriesPaused && (
        <span
          title={status.pauseReason ?? ''}
          className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-label font-semibold uppercase tracking-wider text-amber-300"
        >
          entries paused
        </span>
      )}

      <div className="flex-1" />

      {/* The scanner watches and flags; it never trades (engine.autoLiveActive()
          is permanently false). There is ONE Paper/Live switch, in the top bar,
          and it applies to trades you place yourself — so this pill says what
          the scanner does, not what mode it is in. */}
      <span
        title={
          settings.strategy.runnerAlerts?.enabled
            ? 'The scanner judges every launch at +60 s and +120 s with the measured graduation-odds model and flags the top buckets to you. It never buys.'
            : 'Runner alerts are off (Strategy → Runner alerts). The scanner still tracks launches; it never buys.'
        }
        className="inline-flex items-center gap-1.5 rounded-full border border-arc-gold/40 bg-arc-gold/10 px-3 py-1 font-display text-label font-bold uppercase tracking-label text-arc-gold"
      >
        {settings.strategy.runnerAlerts?.enabled ? 'Runner alerts on' : 'Runner alerts off'}
      </span>

      <div className="flex items-center gap-2" title="Solana RPC feed">
        <span
          className={cls(
            'h-2 w-2 rounded-full',
            status.feed === 'live'
              ? 'bg-emerald-400 animate-pulse-slow shadow-[0_0_8px_rgba(52,211,153,0.7)]'
              : status.feed === 'stopped'
                ? 'bg-krypt-muted/40'
                : 'bg-amber-400 animate-pulse-slow',
          )}
        />
        <span className="text-label font-display uppercase tracking-label text-krypt-muted">{status.feed}</span>
      </div>

      <Readout label="Ev/s" value={status.running ? status.eventsPerSec.toFixed(1) : '—'} />
      <Readout label="Latency" value={status.running ? `${Math.round(status.decodeLatencyMs)}ms` : '—'} />
      <Readout label="Slot" value={status.slot > 0 ? String(status.slot) : '—'} />
    </div>
  );
}
