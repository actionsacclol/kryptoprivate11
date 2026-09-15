import { app, BrowserWindow, Menu, Notification, dialog, nativeImage, powerMonitor, screen, session } from 'electron';
import { postFlag, publicTokenUrl, redactWebhook } from './system/discordWebhook';
import { EVM_CHAIN_META } from '@shared/evm';
import type { NotifyTarget } from '@shared/types';
import path from 'node:path';
import fs from 'node:fs';
import { registerIpc, getEngine, syncLiveMode, bridgeDeps, setWindowHost } from './ipc';
import * as store from './system/settings-store';
import * as wallet from './system/wallet';
import { failure as evmWalletFailure } from './evm/evmWallet';
import * as evmRail from './evm/rail';
import * as bots from './system/bots';
import * as heliusBudget from './system/heliusBudget';
import * as discord from './system/discord';
import { guardWebContents, applyCsp } from './system/webSecurity';
import { logger } from './system/logger';
import * as crashGuard from './system/crashGuard';
import * as acceptance from './system/acceptance';
import { ACCEPTANCE_LOG_FILE, ACCEPTANCE_RETENTION_DAYS } from '@shared/legal/entity';
import * as recorder from './engine/recorder';
import * as creators from './engine/creators';
import { initTemplateStore } from './engine/txBuilder';
import * as watchlist from './engine/watchlist';
import * as advOrders from './engine/advOrders';
import * as ledger from './engine/ledger';
import * as market from './data/market';
import * as templateStore from './system/templateStore';
import * as evmScanner from './evm/scanner';
import * as walletScout from './engine/walletScout';
import * as paperBook from './engine/paperBook';
import * as bridgeStore from './engine/bridgeStore';
import * as alertStore from './engine/alerts';
import * as copyTrade from './engine/copyTrade';
import * as automation from './engine/automation';
import * as programWatch from './engine/programWatch';
import { registerImageProtocol, registerImageScheme, setEnabled as setImagesEnabled } from './data/images';
import { installNetAgent } from './system/netAgent';
import { pickUserDataDir, LEGACY_PROFILE_NAMES } from './system/profileContinuity';

// ──────────────────────────────────────────────────────────────────────
// Crash guard — installed before anything else can throw
// ──────────────────────────────────────────────────────────────────────
// Node 20 treats an unhandled rejection as fatal, so without this a single
// unawaited `fetch` anywhere in the engine closes the terminal mid-trade.
// This must be the first statement that runs: an exception raised while the
// modules below are initialising is exactly the kind we cannot afford to miss.
// ──────────────────────────────────────────────────────────────────────
// Profile continuity across the rename (Krypt Terminal → Krypto Bot)
// ──────────────────────────────────────────────────────────────────────
// Electron derives userData from the product name in packaged AND dev runs,
// so the rename would point every existing install at an empty profile —
// no wallet. If the new folder holds no wallet and a legacy folder does, use
// the legacy folder in place (see system/profileContinuity.ts, unit-tested).
// Zero copying; the DPAPI-bound wallet file stays where it was. Must run
// before anything reads userData — it is the first thing this module does.
const profilePick = pickUserDataDir({
  current: app.getPath('userData'),
  legacy: LEGACY_PROFILE_NAMES.map((n) => path.join(app.getPath('appData'), n)),
  exists: (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  join: path.join,
});
if (profilePick.redirectedFrom) app.setPath('userData', profilePick.dir);

const CRASH_DIR = path.join(app.getPath('userData'), 'crashes');
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');

// Durable log first, so even a failure a few lines down leaves evidence.
logger.attachFileSink(
  LOGS_DIR,
  `=== Krypto Bot ${app.getVersion()} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform} ${process.arch} · packaged=${app.isPackaged} · ${new Date().toISOString()} ===`,
);
if (profilePick.redirectedFrom) {
  logger.info(`profile: using legacy folder ${profilePick.dir} (new-name folder ${profilePick.redirectedFrom} has no wallet)`);
}

crashGuard.install({
  dir: CRASH_DIR,
  log: (level, line) => logger[level](line),
  windowUp: () => mainWindow != null && !mainWindow.isDestroyed(),
  quit: (reason) => {
    // A silent exit before the window exists is indistinguishable from "the
    // app does nothing" — say what happened and where the evidence is.
    // showErrorBox is documented safe before app-ready (it blocks until
    // dismissed; on Linux pre-ready it prints to stderr). Nothing in here may
    // throw: we are already inside the crash handler.
    try {
      logger.error(`fatal: ${reason}`);
      logger.flushSync();
    } catch {
      /* the log is evidence, not a dependency */
    }
    try {
      dialog.showErrorBox(
        'Krypto Bot could not start',
        `${reason}\n\nLog: ${logger.filePath() ?? path.join(LOGS_DIR, 'app.log')}\nCrash files: ${CRASH_DIR}`,
      );
    } catch {
      /* no display / dialog unavailable — the log already has it */
    }
    app.exit(1);
  },
  notify: (summary) => {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Krypto Bot recovered from an error',
      body: `${summary}\nThe app is still running. If a trade was in flight, check your position.\nCrash file: ${CRASH_DIR}`,
    }).show();
  },
  context: () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    packaged: String(app.isPackaged),
  }),
});

// ──────────────────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────────────────
process.env.DIST_ELECTRON = __dirname;
process.env.DIST = path.join(__dirname, '..', 'dist');
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(__dirname, '..', 'public');

// ──────────────────────────────────────────────────────────────────────
// Single-instance lock
// ──────────────────────────────────────────────────────────────────────
// Must run before app-ready: token icons are served by our own main-process
// handler so the renderer's CSP can stay closed to remote image hosts.
registerImageScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();

  // Discover's columns all wait on the same few provider listings, and
  // GeckoTerminal is queued at one request every 2.1 s — so the last of them
  // lands ~8 s after the FIRST one is asked for. Nothing asks until React has
  // mounted, which throws away the whole window the renderer spends booting.
  // Asking now moves that ladder earlier; the renderer's own call joins the
  // same in-flight request. Honours the data switch and the per-provider
  // toggles (see market.prewarmDiscover).
  market.prewarmDiscover();
  });
  /**
 * Dev-only remote debugging.
 *
 * Set KRYPT_DEBUG_PORT to expose the Chrome DevTools Protocol so the UI can be
 * driven and inspected from outside — which is the only way to check "every
 * route renders with no console errors" without a human at the screen.
 *
 * Gated on the env var so a shipped build never opens the port: an always-on
 * debugger is a local RCE surface in an app that holds keys.
 */
if (process.env.KRYPT_DEBUG_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.KRYPT_DEBUG_PORT);
}

// Taskbar identity on Windows. Measured on 2026-09-03: the window's own
// icons are correct either way (WM_GETICON returns our K at 16 and 32 px),
// but the taskbar BUTTON follows the app identity, not the window. With no
// explicit id the window inherits the host executable's identity — in an
// unpackaged run that is electron.exe, so the button shows the Electron
// logo however the window is dressed.
//
// A dev run gets its OWN id rather than the installed app's. Two reasons:
// it must not group with, or borrow the icon of, an installed copy, and
// Explorer caches a taskbar icon per identity — a fresh id resolves the
// icon fresh instead of serving whatever this id showed last week.
if (process.platform === 'win32') {
  const aumid = app.isPackaged ? 'cc.krypt.terminal' : `cc.krypt.terminal.dev.${app.getVersion()}`;
  app.setAppUserModelId(aumid);
  logger.info(`taskbar identity: ${aumid}`);
  // Windows routes a toast's CLICK by its AppUserModelID, and only for an id
  // that owns a Start Menu shortcut. The installer creates one for the
  // packaged id; a dev run's id has none, so its notifications appear and
  // their clicks go nowhere. The handler below is not at fault and needs no
  // fixing — said here so the next person does not go looking for a bug that
  // only exists unpackaged.
  if (!app.isPackaged) logger.info('dev run: desktop notifications will show but clicking one cannot open its coin (no Start Menu shortcut for this AppUserModelID)');
}

// macOS reads a packaged app's icon from its bundle, but an unpackaged run
// has no bundle — the Dock would show Electron's default. Set it explicitly.
if (process.platform === 'darwin' && !app.isPackaged) {
  app.whenReady().then(() => {
    try {
      app.dock?.setIcon(path.join(__dirname, '..', 'resources', 'krypt.png'));
    } catch {
      /* a missing icon must never stop the app from starting */
    }
  });
}


// Windows occlusion tracking pauses the renderer the moment another window
// fully covers it — the usual cause of "the chart froze while I was on
// another screen and jumped when I came back". A trading terminal renders
// covered or not.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// GPU. A user-mode app cannot blue-screen Windows, but a WebGL scene that
// renders every frame can provoke a bad graphics driver into one (a user's
// BSOD, 2026-09-08). Hardware acceleration is a setting, read here because
// Chromium only honours the switch BEFORE the app is ready; and a GPU
// process that keeps dying turns the setting off for the next start, so a
// machine with a broken driver ends up on software rendering by itself.
if (!store.load().hardwareAcceleration) {
  app.disableHardwareAcceleration();
  logger.warn('gpu: hardware acceleration is OFF (Settings → Display) — software rendering');
}
let gpuCrashesThisRun = 0;
app.on('child-process-gone', (_e, details) => {
  if (details.type !== 'GPU') return;
  gpuCrashesThisRun++;
  logger.error(`gpu: GPU process gone (${details.reason}, exit ${details.exitCode}) — ${gpuCrashesThisRun} this run`);
  let body = 'The graphics driver crashed under Krypto Bot. Chromium is falling back to software rendering for now.';
  if (gpuCrashesThisRun >= 2 && store.load().hardwareAcceleration) {
    try {
      store.update({ hardwareAcceleration: false });
      body += ' Hardware acceleration has been turned off for the next start (Settings → Display to turn it back on).';
      logger.warn('gpu: hardware acceleration turned OFF after repeated GPU process crashes');
    } catch (err) {
      logger.error(`gpu: could not persist the fallback: ${(err as Error).message}`);
    }
  }
  try {
    if (Notification.isSupported()) new Notification({ title: 'Graphics driver crashed', body }).show();
  } catch {
    /* the log has it */
  }
});

// A lid closing stops the network without closing a socket. Every socket class
// only notices when its own ping deadline expires, so on resume they all redial
// in the same millisecond — into a budget of ten pubsub connections per IP,
// where the eleventh handshake is a 429 that parks the whole host for 30 s.
// Measured 2026-09-09. So: put them down on the way out, bring them back
// staggered. Nothing here touches positions, orders or the ability to exit.
powerMonitor.on('suspend', () => {
  try {
    getEngine().suspendSockets('system suspend');
  } catch {
    /* no engine yet — nothing to suspend */
  }
});
powerMonitor.on('resume', () => {
  // Wi-Fi is not up the instant the screen is, and a redial into a dead
  // interface just burns a reconnect attempt. Wait, with jitter so several
  // machines on one network do not wake in lockstep either.
  setTimeout(
    () => {
      try {
        getEngine().resumeSockets();
      } catch {
        /* no engine — nothing to resume */
      }
    },
    3_000 + Math.random() * 2_000,
  );
});

// `bootstrap` does ~160 lines of init before showMainWindow(). Without this
// catch, one throw in any of them becomes an unhandled rejection: no window is
// ever shown, crashGuard sees windowUp() === false and exits, and the user gets
// an unnamed error box on every single launch with no way back in. That is the
// worst failure this app has, because someone holding a live position cannot
// open it to sell.
//
// We do NOT try to limp on with a half-initialised engine — a window that looks
// working but has no ledger or no order store is a way to lose money quietly.
// We name the failure instead, so the next launch can be fixed rather than
// guessed at, and quit deliberately rather than being killed.
app.whenReady().then(bootstrap).catch(bootstrapFailed);
}

function bootstrapFailed(e: unknown): void {
  const detail = e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e);
  try {
    logger.error(`bootstrap failed — the app cannot start: ${detail}`);
  } catch {
    /* logging is itself set up during bootstrap; never let it mask the real error */
  }
  try {
    dialog.showErrorBox(
      'Krypto Bot could not start',
      `Startup failed before the window opened.\n\n${detail}\n\n` +
        'Your wallets and positions are untouched. If this repeats, the log file names the step that failed.',
    );
  } catch {
    /* headless or pre-ready: the log above is the record */
  }
  app.exit(1);
}

let mainWindow: BrowserWindow | null = null;

function showMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0A0A0F',
    title: 'Krypto Bot',
    autoHideMenuBar: true,
    // `resources/` is packed INSIDE app.asar (package.json `files`), so the
    // path is the same relative one in both modes: dist-electron/../resources.
    // The old packaged branch pointed at <install>/resources/resources, which
    // does not exist, and the window silently kept Electron's icon.
    icon: path.join(__dirname, '..', 'resources', process.platform === 'win32' ? 'krypt.ico' : 'krypt.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only contextBridge + ipcRenderer, both available in
      // a sandboxed renderer — so there is no reason to run it unsandboxed.
      sandbox: true,
      webSecurity: true,
      // Chromium throttles a hidden/minimised window's timers to ~1/min,
      // which stalled every poll and the chart tail; positions came back
      // stale on restore. Prices keep moving whether the window shows or not.
      backgroundThrottling: false,
      // No DevTools in a shipped build (2026-09-02, beta.7 check): the fuses
      // close Node-level inspection, but the renderer's DevTools is its own
      // switch, and the default application menu still bound Ctrl+Shift+I.
      devTools: !app.isPackaged,
    },
    show: false,
  });
  if (app.isPackaged) {
    // The default menu carries reload and DevTools accelerators; the app has
    // its own hotkeys and needs none of them. Text-editing shortcuts inside
    // inputs are native and unaffected.
    Menu.setApplicationMenu(null);
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  }

  // A renderer error in the MAIN window only ever existed in DevTools, so a
  // crash card told a user "RENDERER CRASHED" while the app log said nothing
  // at all. Errors and warnings land in the log now, which is what makes a
  // report like "it flashes red" diagnosable after the fact.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return;
    const where = sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : '';
    logger[level >= 3 ? 'error' : 'warn'](`renderer${where} — ${String(message).slice(0, 400)}`);
  });

  // Reveal robustly: ready-to-show is the ideal trigger, but did-finish-load
  // + a hard timeout guarantee the window can never get stuck invisible.
  const reveal = (): void => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    win.focus();
  };
  // The constructor's `icon` covers the normal case; setting it again from a
  // decoded image catches a path that reads but does not parse, and says so.
  if (process.platform !== 'darwin') {
    const iconPath = path.join(__dirname, '..', 'resources', process.platform === 'win32' ? 'krypt.ico' : 'krypt.png');
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) logger.warn(`mainWindow: window icon did not decode (${iconPath})`);
    else win.setIcon(img);
  }

  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  const revealTimer = setTimeout(reveal, 4000);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`mainWindow: did-fail-load ${code} "${desc}" ${url}`);
    reveal();
  });
  // A dead renderer leaves the engine running headless with no UI — the user
  // sees a blank or frozen window and has no way to reach the kill switch or
  // their positions. Reload once per crash, rate-limited so a reload loop
  // cannot spin (repeated crashes leave the window down and say so).
  let reloadsThisRun = 0;
  let lastReloadAt = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`mainWindow: render process gone (${details.reason})`);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    if (now - lastReloadAt > 60_000) reloadsThisRun = 0;
    if (reloadsThisRun >= 3) {
      logger.error('mainWindow: renderer crashed repeatedly — not reloading again. The engine is still running; restart the app to get the UI back.');
      return;
    }
    reloadsThisRun++;
    lastReloadAt = now;
    logger.warn(`mainWindow: reloading the UI (attempt ${reloadsThisRun}/3) — the engine kept running`);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.reload();
      } catch (err) {
        logger.error(`mainWindow: reload failed: ${(err as Error).message}`);
      }
    }, 1_000);
  });

  win.on('closed', () => {
    clearTimeout(revealTimer);
    if (mainWindow === win) mainWindow = null;
    quitIfOnlySandboxesRemain();
  });

  guardWebContents(win);

  // Only an unpackaged run may point the window at a dev server. Honouring
  // this in a shipped build would let an environment variable load an
  // arbitrary remote origin into a window that carries window.krypt — and
  // apply the permissive dev CSP to it.
  const devUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  applyCsp(win, devUrl);
  if (devUrl) {
    win.loadURL(devUrl).catch((err) => logger.error(`loadURL failed: ${err}`));
  } else {
    win
      .loadFile(path.join(process.env.DIST!, 'index.html'))
      .catch((err) => logger.error(`loadFile failed: ${err}`));
  }
  mainWindow = win;
  return win;
}

// ── Popped-out panels ─────────────────────────────────────────────────
//
// One panel in its own frameless window. Same renderer bundle, same preload,
// same CSP — it is the app's entry with `#panel=<id>`, which src/main.tsx
// branches on. Nothing about the security posture changes: a second window
// with window.krypt has to be exactly as locked down as the first.
//
// Frameless is the point ("no bar at the top so it is clean"), and it costs
// two things the OS normally provides — moving and closing. The renderer owns
// both: an app-region drag surface, and a close control plus Escape.

const panelWindows = new Map<string, BrowserWindow>();

/** Notifications still on screen. See the comment where one is added. */
const liveNotifications = new Set<Notification>();

// ── Where each panel window was left ──────────────────────────────────
//
// A popped-out panel exists to be arranged and left alone, usually on a second
// monitor, so reopening it in the middle of the primary display every time
// defeats the feature. Bounds are remembered per panel id.
//
// Its own small file rather than settings: this is per-machine window
// furniture, it changes on every drag, and a corrupt or missing file has to
// mean "use the defaults" rather than break anything. Reads are wrapped and
// every stored value is re-validated on the way out — a saved position is a
// hint, never something to trust into a window constructor.

const PANEL_BOUNDS_FILE = 'panel-windows.json';
type Bounds = { x: number; y: number; width: number; height: number };
let panelBounds: Record<string, Bounds> = {};

function panelBoundsPath(): string {
  return path.join(app.getPath('userData'), PANEL_BOUNDS_FILE);
}

function loadPanelBounds(): void {
  try {
    const raw = fs.readFileSync(panelBoundsPath(), 'utf8');
    const v = JSON.parse(raw) as unknown;
    panelBounds = typeof v === 'object' && v !== null ? (v as Record<string, Bounds>) : {};
  } catch {
    panelBounds = {};
  }
}

let boundsSaveTimer: NodeJS.Timeout | null = null;
function savePanelBoundsSoon(): void {
  if (boundsSaveTimer) return;
  // Debounced: a drag fires these continuously and this is a disk write.
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    try {
      fs.writeFileSync(panelBoundsPath(), JSON.stringify(panelBounds));
    } catch {
      /* window furniture that cannot be saved is not worth an error */
    }
  }, 800);
  boundsSaveTimer.unref?.();
}

const isFiniteInt = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * A remembered position, only if it still lands on a screen that exists.
 *
 * Monitors get unplugged and resolutions change. Restoring blind would put a
 * window at x=3000 on a machine that is now one laptop display — visible in
 * the taskbar, reachable by nothing.
 */
function usablePanelBounds(panelId: string): Bounds | null {
  const b = panelBounds[panelId];
  if (!b || !isFiniteInt(b.x) || !isFiniteInt(b.y) || !isFiniteInt(b.width) || !isFiniteInt(b.height)) return null;
  if (b.width < 200 || b.height < 160) return null;
  // The centre of the title strip has to be inside some display's work area,
  // which is what makes the window grabbable after it opens.
  const probe = { x: b.x + Math.round(b.width / 2), y: b.y + 16 };
  const onScreen = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return probe.x >= w.x && probe.x <= w.x + w.width && probe.y >= w.y && probe.y <= w.y + w.height;
  });
  return onScreen ? b : null;
}

/** Handed to ipc.ts so it can drive windows without importing this file back. */
export function windowHost(): { openPanel: (id: string) => { ok: boolean; message: string }; closePanel: (w: BrowserWindow | null) => boolean; focusMain: () => BrowserWindow | null } {
  return { openPanel: openPanelWindow, closePanel: closePanelWindow, focusMain: focusMainWindow };
}

/** Only ids the renderer actually has a panel for, and only a shape that can
 *  never leave the hash it is going into. */
const PANEL_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

function openPanelWindow(panelId: string): { ok: boolean; message: string } {
  if (!PANEL_ID_RE.test(panelId)) return { ok: false, message: 'Unknown panel' };
  const existing = panelWindows.get(panelId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true, message: 'Already open' };
  }

  const saved = usablePanelBounds(panelId);
  const win = new BrowserWindow({
    width: saved?.width ?? 420,
    height: saved?.height ?? 460,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 260,
    minHeight: 200,
    // No chrome at all. `resizable` still works: Chromium keeps invisible
    // resize borders on a frameless window.
    frame: false,
    resizable: true,
    backgroundColor: '#0E0D15',
    title: 'Krypto Bot',
    autoHideMenuBar: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
    show: false,
  });
  if (app.isPackaged) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  // The same navigation and window-open guards the main window gets. A second
  // window carrying window.krypt has to be as locked down as the first, and
  // this was missed when the window was added.
  guardWebContents(win);

  // A panel window that fails is currently invisible in the log: it either
  // shows nothing or shows the renderer's crash card, and neither says why
  // from the main side. Say it here, where the app log can be read after the
  // fact rather than from a DevTools window nobody had open.
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    logger.error(`panel ${panelId}: did-fail-load ${code} ${desc} (${url})`),
  );
  win.webContents.on('render-process-gone', (_e, details) =>
    logger.error(`panel ${panelId}: render process gone — ${details.reason}`),
  );
  win.webContents.on('preload-error', (_e, preloadPath, err) =>
    logger.error(`panel ${panelId}: preload failed (${preloadPath}) — ${err?.message ?? err}`),
  );
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logger.error(`panel ${panelId}: renderer — ${String(message).slice(0, 400)}`);
  });

  const devUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  // NOT applyCsp: it registers a SESSION-wide onHeadersReceived listener, and
  // Electron keeps only the last one per session — a second call here silently
  // replaced the main window's. Both windows share the default session, so the
  // policy the main window installed already covers this one.
  const hash = `panel=${panelId}`;
  if (devUrl) {
    win.loadURL(`${devUrl}#${hash}`).catch((err) => logger.error(`panel loadURL failed: ${err}`));
  } else {
    win.loadFile(path.join(process.env.DIST!, 'index.html'), { hash }).catch((err) => logger.error(`panel loadFile failed: ${err}`));
  }
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  logger.info(`panel ${panelId}: window opened (${devUrl ? 'dev server' : 'file'})`);
  // Remember where it was left. `moved`/`resized` fire at the END of a drag on
  // Windows and macOS; the close handler catches a window closed mid-gesture.
  const remember = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    panelBounds[panelId] = win.getBounds();
    savePanelBoundsSoon();
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('close', remember);
  win.on('closed', () => panelWindows.delete(panelId));
  panelWindows.set(panelId, win);
  return { ok: true, message: 'Opened' };
}

/** Close the window a request came from, when that window is a panel. A panel
 *  window must never be able to close the main one. */
function closePanelWindow(win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed()) return false;
  for (const [id, w] of panelWindows) {
    if (w === win) {
      panelWindows.delete(id);
      win.close();
      return true;
    }
  }
  return false;
}

/** The main window, for things that must land there rather than in whichever
 *  window happens to be first — a notification click, or a coin opened from a
 *  popped-out panel. */
function focusMainWindow(): BrowserWindow | null {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

async function bootstrap(): Promise<void> {
  // Keep-alive for every outbound fetch (see system/netAgent.ts) — before
  // anything opens a connection.
  installNetAgent();
  // Load persisted orders BEFORE registerIpc(), which constructs the engine
  // and attaches the order host. Restored orders come back PAUSED by design
  // (see advOrders.ts §3) — the user resumes them deliberately.
  // Clickwrap evidence, plus the purge that makes the retention period in the
  // privacy policy a fact rather than a promise.
  acceptance.init(app.getPath('userData'), ACCEPTANCE_LOG_FILE);
  const purged = acceptance.purge(Date.now(), ACCEPTANCE_RETENTION_DAYS);
  if (purged) logger.info(`legal: purged ${purged} acceptance record(s) past retention`);

  advOrders.init(app.getPath('userData'));
  templateStore.init(app.getPath('userData'));
  walletScout.init(app.getPath('userData'));
  evmScanner.initModels(app.getPath('userData'));
  ledger.init(app.getPath('userData'));
  // The only record of money that has left one chain and not reached the
  // other. Registered here with every other fail-closed store: a user whose
  // in-flight list reads "none" when it really means "could not read" would
  // stop looking for a transfer that is still owed to them.
  bridgeStore.init(app.getPath('userData'));
  paperBook.init(app.getPath('userData'));
  alertStore.init(app.getPath('userData'));
  copyTrade.init(app.getPath('userData'));
  // User scripts and rules. Live ones come back disabled; paper ones
  // resume once the engine exists (startEnabled, below registerIpc).
  automation.init(app.getPath('userData'));

  // If a saved file exists but cannot be read, the app runs WITHOUT
  // overwriting it. Say so plainly and immediately: silently showing "no
  // wallet" would read as "my money is gone", and the user needs to know
  // their keys are still on disk before they do anything drastic.
  //
  // EVERY store that fails closed is listed, not just the two wallets and
  // settings. Nothing is saved while such a flag is set, so a store that
  // stays silent here looks empty and stays unsaved: a user would type a
  // copy config, write a script, or start a lab run and lose all of it on
  // the next start with no clue why. Runs after the loads above for that
  // reason — their failure flags do not exist until they have tried.
  //
  // advOrders is in the list too: its own toast goes through the order host,
  // which does not exist yet at init time, so without this line an unreadable
  // orders file was set aside in silence.
  {
    const stores: { what: string; why: string | null }[] = [
      { what: 'wallet', why: wallet.failure() },
      { what: 'EVM wallet', why: evmWalletFailure() },
      { what: 'settings', why: store.failure() },
      { what: 'trade ledger', why: ledger.failure() },
      { what: 'copy trading', why: copyTrade.failure() },
      { what: 'scripts and rules', why: automation.failure() },
      { what: 'advanced orders', why: advOrders.failure() },
      // The highest-stakes one on this list: it records transfers that have
      // left a wallet and not arrived anywhere yet. Silence here would read as
      // "nothing in flight" to a user whose money is genuinely in transit.
      { what: 'in-flight bridge transfers', why: bridgeStore.failure() },
    ];
    const broken = stores.filter((s): s is { what: string; why: string } => !!s.why);
    if (broken.length) {
      logger.error(`startup: ${broken.map((b) => b.why).join(' | ')}`);
      dialog.showMessageBoxSync({
        type: 'warning',
        title: broken.length === 1 ? 'A saved file could not be read' : 'Saved files could not be read',
        message:
          broken.length === 1
            ? `Your ${broken[0].what} file could not be read`
            : `${broken.length} saved files could not be read: ${broken.map((b) => b.what).join(', ')}`,
        detail: `${broken.map((b) => b.why).join('\n\n')}\n\nNothing has been overwritten, and nothing will be saved to ${broken.length === 1 ? 'that file' : 'those files'} this session. Close the app, copy ${broken.length === 1 ? 'it' : 'them'} somewhere safe, and check ${broken.length === 1 ? 'it' : 'them'} before continuing.`,
        buttons: [broken.length === 1 ? 'Continue without saving to it' : 'Continue without saving to them'],
        noLink: true,
      });
    }
  }

  // The configs are loaded: point the wallet watcher at the enabled ones.
  getEngine().syncCopyWatch();
  // A sell the leader made while our buy was still in flight is an
  // instruction that has to survive the process, not just the async gap —
  // otherwise a crash or a quit at the wrong moment leaves the position open
  // with nothing left remembering it was meant to close (user report,
  // 2026-09-13). Fresh ones are mirrored now; ones from a long-closed app are
  // recorded as skipped, loudly, rather than traded on hours late.
  {
    const resumed = copyTrade.resumePendingExits();
    if (resumed.fired > 0) {
      logger.warn(`${resumed.fired} copy exit(s) parked before shutdown are being mirrored now`);
    }
    if (resumed.expired > 0) {
      logger.warn(
        `${resumed.expired} copy exit(s) were too old to mirror after the restart — those positions are still held`,
      );
    }
  }
  if (advOrders.pausedCount() > 0) {
    logger.warn(
      `${advOrders.pausedCount()} advanced order(s) restored PAUSED after restart — resume them from the Orders page`,
    );
  }

  // Before registerIpc, so the panel handlers have their windows the moment
  // they are registered.
  // Needs app.getPath('userData'), so it happens here rather than at import.
  loadPanelBounds();
  setWindowHost(windowHost());
  registerIpc();
  // Follow anything still in flight between chains.
  //
  // Every two minutes, and deliberately not on the priority lane: PHASE2's
  // rule is that exit processing outranks everything, and a transfer that has
  // already left can wait a few seconds longer than a sell can. It polls only
  // when something is actually in flight, so an install that never bridges
  // never makes the call — which matters, because the quote budget and the
  // status budget share a provider.
  void import('./engine/bridge').then((m) => {
    // A transfer that ends — arrived, refunded, failed — is a desktop
    // notification, the same channel as a runner alert.
    m.setNotifier((title, body) => getEngine().pushNotification(title, body));
    // The poll asks the Solana chain about its own signatures, on the same
    // endpoint the send used.
    m.setDeps(bridgeDeps);
  });
  setInterval(() => {
    void import('./engine/bridge')
      .then(async (m) => {
        if (m.inFlight().length === 0) return;
        // `poll()` never overlaps itself; a tick that lands mid-poll joins it.
        await m.poll();
      })
      .catch(() => undefined);
  }, 120_000).unref?.();

  // Is there a newer build? Asked once, thirty seconds in, so it competes
  // with nothing at startup — and never awaited, because a slow or missing
  // endpoint must not hold up a boot. The renderer reads the answer from
  // memory whenever it paints.
  setTimeout(() => {
    void import('./system/updateCheck').then((m) => m.check()).catch(() => undefined);
  }, 30_000).unref?.();
  // And every six hours after: a terminal left open for days used to never
  // learn of a release (found by audit 2026-09-11). Still never awaited.
  setInterval(() => {
    void import('./system/updateCheck').then((m) => m.check()).catch(() => undefined);
  }, 6 * 60 * 60_000).unref?.();
  // Sandboxes are windows, so only now: the app is ready and the engine
  // (which hosts the scripts) exists.
  automation.startTimers();
  void automation.startEnabled();
  const state = store.load();
  // Referral payouts ride every trade, so the address has to be live from the
  // first one — not only after the user next opens Settings.
  void import('./engine/liveSigner').then((m) => m.setReferrer(state.referrer));

  /**
   * Post a flagged runner to the Discord webhook for its chain, if set.
   *
   * The URL is per chain and lives with that chain's other runner-alert
   * settings, so Solana flags and BNB flags can go to different channels.
   * Never awaited by the caller and never throws: a webhook is a courtesy
   * copy of a notification that has already been shown.
   */
  const sendRunnerWebhook = async (title: string, body: string, target: NotifyTarget): Promise<void> => {
    const cur = store.load();
    const url =
      target.chain === 'solana'
        ? (cur.strategy.runnerAlerts.webhookUrl ?? '')
        : (cur.evm[target.chain]?.runnerAlerts?.webhookUrl ?? '');
    if (!url.trim()) return;
    const res = await postFlag(url, {
      title,
      body,
      mint: target.mint,
      chainLabel: target.chain === 'solana' ? 'Solana' : EVM_CHAIN_META[target.chain].name,
      url: publicTokenUrl(target.chain, target.mint),
    });
    // Said once per failure, with the URL redacted — its path carries the
    // credential. A silent webhook is worse than a noisy one: the whole point
    // is that someone is relying on it to be watching for them.
    if (!res.ok) logger.warn(`Discord webhook (${redactWebhook(url)}) did not send: ${res.message}`);
  };

  // Desktop notifications for alerts. Injected rather than imported by the
  // engine so the engine stays free of Electron and testable in Node.
  getEngine().setNotifier((title, body, target) => {
    // The same alert also goes to any paired chat bot. Best-effort and never
    // awaited: a slow chat API must not delay a local notification, let alone
    // the engine tick that produced it.
    try {
      bots.push(`${title}${String.fromCharCode(10)}${body}`);
    } catch {
      /* a chat push must never affect the alert itself */
    }
    // ...and to this chain's Discord webhook, if the user configured one.
    // Same best-effort rule, same reason.
    if (target) {
      try {
        void sendRunnerWebhook(title, body, target);
      } catch {
        /* a webhook must never affect the alert itself */
      }
    }
    if (!Notification.isSupported()) return;
    try {
      const n = new Notification({ title, body, silent: !store.load().alerts.sound });
      // HELD until the toast goes away.
      //
      // `n` was a local: once show() returned and this function exited, nothing
      // referenced the Notification any more, so V8 was free to collect it
      // while the native toast was still on screen — and with it the click
      // handler below. The toast appeared, the click did nothing, and no log
      // line was written because no JS ran. Classic on Windows, where the
      // toast outlives the call by seconds.
      liveNotifications.add(n);
      const release = (): void => { liveNotifications.delete(n); };
      n.on('close', release);
      n.on('failed', release);
      // A notification that cannot be clicked is a dead end: it tells you a
      // runner was flagged and then makes you go find the coin by hand. The
      // click brings the window up and puts the token on screen (user
      // report, 2026-09-13). Notifications with no token behind them — an
      // update notice, a crash summary — just focus the window.
      n.on('click', () => {
        // The MAIN window specifically. `getAllWindows()[0]` used to be the
        // only window there was; a popped-out panel could now be first, and
        // raising it would leave the token nowhere to open.
        logger.info(`notification clicked${target ? `: opening ${target.mint.slice(0, 10)} on ${target.chain}` : ' (no token behind it)'}`);
        focusMainWindow();
        if (target) {
          try {
            getEngine().requestOpenToken(target.mint, target.chain);
          } catch {
            /* the window is up either way, which is most of the point */
          }
        }
      });
      n.show();
    } catch {
      /* a failed notification must never take down the engine */
    }
  });

  registerImageProtocol();
  setImagesEnabled(state.data.networkDataEnabled && state.data.loadTokenImages);

  creators.init(app.getPath('userData'));
  // Credit guard for the (expensive) Helius feed socket. Counted, persisted,
  // and enforced by the engine — see shared/credits.ts for the measurement
  // that made this necessary.
  heliusBudget.init(app.getPath('userData'), store.load().rpc.heliusMonthlyCredits ?? 0);
  // Any disarm — user, breaker, decoder drift, restart — flips the persisted
  // mode to Paper, so the UI and the engine can never disagree about whether
  // real SOL moves. Live is re-entered only through the top-bar switch.
  getEngine().onDisarm = (reason) => {
    // Losing the wallet is not a mode choice: keep Live as the preference so
    // the next wallet arms straight away (syncLiveMode in wallet:generate).
    if (reason === 'no_wallet') return;
    const cur = store.load();
    if (cur.execution.liveEnabled) store.update({ execution: { ...cur.execution, liveEnabled: false } });
    getEngine().announceStatus();
  };
  getEngine().disableHeliusFeed = () => {
    const cur = store.load();
    store.update({ rpc: { ...cur.rpc, heliusFeedSocket: false } });
  };
  // Reuse any pump account-layout template learned by a previous run — see
  // txBuilder.ts. Learning it costs ~200 RPC reads a free endpoint will not serve.
  initTemplateStore(app.getPath('userData'));
  watchlist.init(app.getPath('userData'));
  const recDir = recorder.init(app.getPath('userData'), state.recorderEnabled, state.recorderDir);
  // A research tool that can silently fill a disk is a bug in a shipped app:
  // measured 2026-08-25, one day of firehose recording reached 15 GB. Prune on
  // start and hourly thereafter, oldest day-files first.
  recorder.setMaxBytes((state.recorderMaxGb ?? 0) * 1e9);
  // The prune walks the recordings dir (readdir + stat over up to 15 GB of
  // day files). It ran BEFORE the window existed; a few seconds later costs
  // nothing and first paint no longer waits on the disk.
  setTimeout(() => {
    const freed = recorder.prune();
    if (freed > 0) logger.info(`recordings pruned — reclaimed ${(freed / 1e9).toFixed(2)} GB`);
  }, 3_000);
  setInterval(() => {
    const n = recorder.prune();
    if (n > 0) logger.info(`recordings pruned — reclaimed ${(n / 1e9).toFixed(2)} GB`);
  }, 60 * 60_000);
  logger.info(`recordings dir: ${recDir}${state.recordFirehose ? ' (firehose ON)' : ''}`);
  programWatch.init(app.getPath('userData'));

  showMainWindow();

  // Opt-in unattended collection (settings.scannersAutoStart). AFTER the
  // window, so a scanner can never be the reason the app fails to show — and
  // each start is wrapped, because a chain refusing to start is a log line,
  // not a boot failure.
  // Solana has its own switch (`autoStartEngine`, below) — this is only the
  // EVM scanners, so the two never fight over the same chain.
  if (state.scannersAutoStart) {
    setTimeout(() => {
      for (const chain of ['robinhood', 'bnb'] as const) {
        try {
          const r = evmScanner.start(chain);
          logger.info(`auto-start: ${chain} — ${r.message}`);
        } catch (err) {
          logger.warn(`auto-start: ${chain} did not start — ${(err as Error).message}`);
        }
      }
    }, 3_000);
  }

  // Discord RPC — best-effort, never blocks boot (guidelines §8).
  if (state.discordRpcEnabled) {
    discord.startDiscordRpc().catch(() => {});
  }
  updateDiscord();
  setInterval(updateDiscord, 5_000);

  if (state.autoStartEngine) {
    const r = getEngine().start();
    logger.info(`auto-start engine: ${r.message}`);
  }

  // A previous run may have crashed while holding real tokens — check the
  // chain once the window is up and auto-sell if the user opted in.
  setTimeout(() => {
    syncLiveMode();
    getEngine().recoverAfterCrash().catch((err) => logger.warn(`crash recovery: ${err}`));
  }, 6_000);

  logger.info('Krypto Bot ready');
}

function updateDiscord(): void {
  if (!store.load().discordRpcEnabled) return;
  const engine = getEngine();
  const s = engine.status();
  if (s.running) {
    const pnl = s.realizedPnlSol;
    const sign = pnl >= 0 ? '+' : '';
    discord.setActivity(
      `Scanning Pump.fun launches · ${s.launchesSeen} seen`,
      s.openPositions > 0 ? `${s.openPositions} paper open · ${sign}${pnl.toFixed(3)} SOL` : 'Flagging potential runners',
    );
  } else {
    discord.setActivity('Idle in Krypto Bot', 'Scanner off');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

/**
 * Quit once the last window the USER can see is gone.
 *
 * `window-all-closed` fires only when EVERY BrowserWindow has closed, and a
 * running code script is a hidden BrowserWindow on the 'script-sandbox'
 * partition (system/scriptSandbox.ts). So closing the main window while any
 * script ran left those sandboxes up, the event unfired, and on Windows the
 * process alive with no UI at all — no before-quit, so no persistNow, no
 * engine drain, no live-sell window, and a LIVE-armed script still spending
 * real SOL with nothing on screen. The only way out was Task Manager.
 *
 * A sandbox is told apart by its session, not by counting: the main window
 * declares no `partition`, so it is the only window on the default session,
 * and this fires only when none of those is left. The app has no tray and
 * never hides the main window (`.hide()` appears nowhere), so "no
 * default-session window" means the user really did close the app. macOS is
 * left alone for the same reason `window-all-closed` was: the app lives on
 * in the Dock there.
 */
function quitIfOnlySandboxesRemain(): void {
  if (process.platform === 'darwin') return;
  const visible = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.webContents.session === session.defaultSession,
  );
  if (visible.length > 0) return;
  const sandboxes = BrowserWindow.getAllWindows().length;
  logger.info(
    `lifecycle: the main window closed — quitting${sandboxes ? ` (${sandboxes} script sandbox(es) do not keep the app alive)` : ''}`,
  );
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let quitDrained = false;
app.on('before-quit', (e) => {
  // Scripts next: their sandboxes are windows, and a script must not fire
  // into a closing engine.
  void automation.shutdown();
  // The per-chain Observatories poll RPC on a timer. They spend nothing and
  // hold nothing, but a live interval during the drain below is a request
  // against an endpoint for a window that is closing.
  evmScanner.stopAll();
  walletScout.flushSync();
  evmScanner.flushModels();
  const engine = getEngine();
  const wasRunning = engine.isRunning();
  if (wasRunning) engine.stop(); // queues auto-sell of held tokens (if enabled)
  recorder.flushSync();
  creators.flush();
  discord.stopDiscordRpc();
  ledger.flushSync();
  // `cancel` and `create` ride a 200 ms debounce, so quitting inside that
  // window would lose the change — cancel-then-quit brought a cancelled
  // order back ARMED on the next launch.
  advOrders.flushSync();
  logger.flushSync();
  // Give queued live sells a bounded window to land before the process dies —
  // otherwise "quit" would strand real tokens exactly like a crash. The EVM
  // rail gets the same window for a trade between broadcast and receipt (its
  // ledger row is written at broadcast, this just lets the receipt settle
  // it); both are bounded, so quitting never hangs.
  if (!quitDrained) {
    quitDrained = true;
    e.preventDefault();
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const drains: Promise<unknown>[] = [];
    if (wasRunning) drains.push(engine.drainLive(8_000).catch(() => undefined));
    // Returns at once when no EVM trade is in flight; the race is the belt
    // and braces that keeps a wedged RPC from holding the process open.
    drains.push(Promise.race([evmRail.drain(8_000), sleep(8_500)]).catch(() => undefined));
    void Promise.all(drains).finally(() => app.quit());
  }
});
