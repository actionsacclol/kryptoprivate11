import { OctagonX, Play, Square } from 'lucide-react';
import { useAppState } from '../state/AppStateProvider';
import { useModal } from '../state/ModalProvider';
import { cls } from '../utils/format';

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

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] font-display uppercase tracking-[0.24em] text-krypt-muted">{label}</span>
      <span className="font-mono text-[12px] text-white/85">{value}</span>
    </div>
  );
}

export function AutomationBar() {
  const { status, settings, startEngine, stopEngine, killSwitch } = useAppState();
  const modal = useModal();

  const onKill = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Kill switch',
      message: `Stop the engine, disarm live execution and close every open paper position (${status.openPositions}). Tokens you actually hold are left alone — sell those from the Holdings page.`,
      confirmLabel: 'Stop everything',
      destructive: true,
    });
    if (yes) void killSwitch();
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/8 bg-black/20 px-6 py-2.5">
      {!status.running ? (
        <button
          onClick={() => void startEngine()}
          className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-4 py-1.5 text-[13px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110 active:scale-[0.98]"
        >
          <Play className="h-3.5 w-3.5" />
          Start scanning
        </button>
      ) : (
        <button
          onClick={() => void stopEngine()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-1.5 text-[13px] font-semibold text-white/90 transition hover:bg-white/10 hover:border-white/20"
        >
          <Square className="h-3.5 w-3.5 text-rose-300" />
          Stop
        </button>
      )}

      <button
        onClick={() => void onKill()}
        disabled={status.openPositions === 0}
        title="Close every open position now"
        className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-1.5 text-[13px] font-semibold text-rose-200 transition hover:bg-rose-500/20 hover:shadow-crimson-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
      >
        <OctagonX className="h-3.5 w-3.5" />
        Kill switch
      </button>

      {status.running && status.entriesPaused && (
        <span
          title={status.pauseReason ?? ''}
          className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300"
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
        className="inline-flex items-center gap-1.5 rounded-full border border-arc-gold/40 bg-arc-gold/10 px-3 py-1 font-display text-[10px] font-bold uppercase tracking-[0.2em] text-arc-gold"
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
        <span className="text-[10px] font-display uppercase tracking-[0.24em] text-krypt-muted">{status.feed}</span>
      </div>

      <Readout label="Ev/s" value={status.running ? status.eventsPerSec.toFixed(1) : '—'} />
      <Readout label="Latency" value={status.running ? `${Math.round(status.decodeLatencyMs)}ms` : '—'} />
      <Readout label="Slot" value={status.slot > 0 ? String(status.slot) : '—'} />
    </div>
  );
}
