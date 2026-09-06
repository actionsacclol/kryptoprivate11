import type { RunnerFlag } from '@shared/runners';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppSettings, EngineStatus, LaunchRow, PaperPosition } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { useToast } from './ToastProvider';

// Central renderer state: hydrated once from engine:snapshot, then kept
// live by the engine:event stream. The engine (main process) is the source
// of truth — this provider only mirrors it.

const EMPTY_STATUS: EngineStatus = {
  running: false,
  feed: 'stopped',
  slot: 0,
  decodeLatencyMs: 0,
  eventsPerSec: 0,
  launchesSeen: 0,
  launchesEvaluated: 0,
  launchesEntered: 0,
  runnersFlagged: 0,
  launchesRejected: 0,
  openPositions: 0,
  closedPositions: 0,
  realizedPnlSol: 0,
  startedAt: null,
  entriesPaused: false,
  pauseReason: null,
  layoutErrors: 0,
  feedSockets: [],
  feedLossPct: null,
  liveActive: false,
  liveBuys: 0,
  liveSells: 0,
  liveRealizedPnlSol: null,
  walletBalanceSol: null,
};

const LAUNCH_CAP = 300;
const POSITION_CAP = 400;
const EQUITY_CAP = 900; // ~15 min at 1 point/sec

export interface EquityPoint {
  t: number;
  v: number;
}

interface AppState {
  status: EngineStatus;
  launches: LaunchRow[];
  positions: PaperPosition[];
  /** Potential runners flagged this session, newest first. */
  runners: RunnerFlag[];
  settings: AppSettings;
  /** Session realized-PnL series, appended from status pushes. */
  equity: EquityPoint[];
  startEngine: () => Promise<void>;
  stopEngine: () => Promise<void>;
  killSwitch: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  blacklistCreator: (creator: string) => Promise<void>;
  /** Re-pull the engine snapshot (status, launches, positions, runners). The
   *  stream keeps these live; this is for a user who wants to be sure. */
  refreshFromEngine: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>');
  return ctx;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [launches, setLaunches] = useState<LaunchRow[]>([]);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [runners, setRunners] = useState<RunnerFlag[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const upsertLaunch = useCallback((launch: LaunchRow) => {
    setLaunches((cur) => {
      const idx = cur.findIndex((l) => l.mint === launch.mint);
      let next: LaunchRow[];
      if (idx >= 0) {
        next = [...cur];
        next[idx] = launch;
      } else {
        next = [launch, ...cur];
        if (next.length > LAUNCH_CAP) next = next.slice(0, LAUNCH_CAP);
      }
      return next;
    });
  }, []);

  const upsertPosition = useCallback((pos: PaperPosition) => {
    setPositions((cur) => {
      const idx = cur.findIndex((p) => p.id === pos.id);
      if (idx >= 0) {
        const next = [...cur];
        next[idx] = pos;
        return next;
      }
      const next = [pos, ...cur];
      // Long sessions: shed the oldest CLOSED rows past the cap (never open ones).
      if (next.length > POSITION_CAP) {
        for (let i = next.length - 1; i >= 0 && next.length > POSITION_CAP; i--) {
          if (next[i].state === 'closed') next.splice(i, 1);
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Hydrate from the engine snapshot, then stay live on the event stream.
    // Events can land BEFORE the snapshot resolves — live data always wins,
    // so the (older) snapshot only fills state the stream hasn't touched.
    const gotLive = { status: false, launches: false, positions: false };
    void window.krypt.engine.snapshot().then((r) => {
      if (cancelled || !r.ok || !r.data) return;
      if (!gotLive.status) setStatus(r.data.status);
      setSettings(r.data.settings);
      if (!gotLive.launches) setLaunches([...r.data.launches].reverse());
      if (!gotLive.positions) setPositions([...r.data.positions].reverse());
      setRunners(r.data.runners ?? []);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      switch (ev.kind) {
        case 'status':
          gotLive.status = true;
          setStatus(ev.status);
          if (ev.status.running) {
            setEquity((cur) => {
              const next = [...cur, { t: Date.now(), v: ev.status.realizedPnlSol }];
              return next.length > EQUITY_CAP ? next.slice(next.length - EQUITY_CAP) : next;
            });
          }
          break;
        case 'launch':
        case 'launchUpdate':
          gotLive.launches = true;
          upsertLaunch(ev.launch);
          break;
        case 'position':
        case 'positionUpdate':
          gotLive.positions = true;
          upsertPosition(ev.position);
          break;
        case 'runner':
          setRunners((cur) => [ev.runner, ...cur.filter((x) => x.mint !== ev.runner.mint)].slice(0, 50));
          break;
        case 'runners':
          // The engine expired some flags; take its list verbatim.
          setRunners(ev.runners);
          break;
        case 'toast':
          toastRef.current[ev.level](ev.message);
          break;
        case 'log':
          break; // Console page reads the log channel directly
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [upsertLaunch, upsertPosition]);

  const startEngine = useCallback(async () => {
    const r = await window.krypt.engine.start();
    if (r.ok) toastRef.current.success(r.message);
    else toastRef.current.error(r.message);
  }, []);

  const stopEngine = useCallback(async () => {
    const r = await window.krypt.engine.stop();
    if (r.ok) toastRef.current.info(r.message);
    else toastRef.current.error(r.message);
  }, []);

  const killSwitch = useCallback(async () => {
    const r = await window.krypt.engine.kill();
    if (r.ok) toastRef.current.warn(r.message);
    else toastRef.current.error(r.message);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const r = await window.krypt.settings.update(patch);
    if (r.ok && r.data) {
      setSettings(r.data);
      toastRef.current.success('Settings saved');
    } else {
      toastRef.current.error(r.message);
    }
  }, []);

  const refreshFromEngine = useCallback(async () => {
    const r = await window.krypt.engine.snapshot();
    if (!r.ok || !r.data) {
      toastRef.current.error(r.message || 'Could not reach the engine');
      return;
    }
    setStatus(r.data.status);
    setSettings(r.data.settings);
    setLaunches([...r.data.launches].reverse());
    setPositions([...r.data.positions].reverse());
    setRunners(r.data.runners ?? []);
  }, []);

  const blacklistCreator = useCallback(async (creator: string) => {
    const r = await window.krypt.creators.blacklist(creator);
    if (r.ok) toastRef.current.success(r.message);
    else toastRef.current.error(r.message);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      status,
      launches,
      positions,
      runners,
      settings,
      equity,
      startEngine,
      stopEngine,
      killSwitch,
      updateSettings,
      blacklistCreator,
      refreshFromEngine,
    }),
    [status, launches, positions, runners, settings, equity, startEngine, stopEngine, killSwitch, updateSettings, blacklistCreator, refreshFromEngine],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
