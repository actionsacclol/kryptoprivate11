// The window every password, code and secret goes through.
//
// It is a separate window that main owns, with its own preload, its own session
// and one job, for the reason the whole feature rests on: the app's page must
// never see a password or a code, or be able to press the button itself. If the
// main page were compromised, this window would still say exactly what is being
// approved, in words main wrote.
//
// So there is one rule to tell users: the password is only ever asked for in
// this small separate window, never inside the app's page.

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { logger } from './logger';

export interface PromptField {
  name: string;
  label: string;
  kind: 'password' | 'text' | 'code';
  hint?: string;
}

export interface PromptView {
  title: string;
  /** Plain sentences, in order. Set as text, never as markup. */
  lines: string[];
  /** Words to write down: shown large, cannot be selected or copied. */
  secret?: string;
  /** The modules of a QR code, rows of booleans. */
  qr?: boolean[][];
  fields: PromptField[];
  submit: string;
  /** Null: no way out (the screen lock). */
  cancel?: string | null;
  /** Secondary actions, such as "Forgot password". */
  extra?: Array<{ id: string; label: string }>;
  error?: string;
  danger?: boolean;
}

export type PromptStep = { view: PromptView } | { done: true; value?: unknown };
export type PromptHandler = (action: string, values: Record<string, string>) => Promise<PromptStep> | PromptStep;

interface Open {
  win: BrowserWindow;
  view: PromptView;
  onAction: PromptHandler;
  resolve: (r: { done: boolean; value?: unknown }) => void;
  closable: boolean;
  busy: boolean;
  finished: boolean;
}

let current: Open | null = null;
let channelsReady = false;

function installChannels(): void {
  if (channelsReady) return;
  channelsReady = true;
  const own = (senderId: number): Open | null => (current && !current.win.isDestroyed() && current.win.webContents.id === senderId ? current : null);
  ipcMain.handle('securityPrompt:view', (e) => own(e.sender.id)?.view ?? null);
  ipcMain.handle('securityPrompt:resize', (e, height: unknown) => {
    const o = own(e.sender.id);
    if (!o || typeof height !== 'number' || !Number.isFinite(height)) return;
    o.win.setContentSize(WIDTH, Math.max(160, Math.min(Math.ceil(height), MAX_HEIGHT)));
    o.win.center();
  });
  ipcMain.handle('securityPrompt:act', async (e, action: unknown, values: unknown) => {
    const o = own(e.sender.id);
    if (!o || o.busy || typeof action !== 'string') return null;
    if (action === 'cancel') {
      if (o.view.cancel === null) return o.view;
      finish(o, { done: false });
      return { closed: true };
    }
    const clean: Record<string, string> = {};
    if (values && typeof values === 'object') {
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) if (typeof v === 'string') clean[k] = v.slice(0, 1024);
    }
    o.busy = true;
    try {
      const step = await o.onAction(action, clean);
      if ('done' in step) {
        finish(o, { done: true, value: step.value });
        return { closed: true };
      }
      o.view = step.view;
      return step.view;
    } catch (err) {
      // Never the error's detail in a window that is handling a secret's path.
      logger.error(`security prompt: ${(err as Error).message}`);
      o.view = { ...o.view, error: `That did not work: ${(err as Error).message}` };
      return o.view;
    } finally {
      o.busy = false;
    }
  });
}

const WIDTH = 480;
const MAX_HEIGHT = 760;

function finish(o: Open, result: { done: boolean; value?: unknown }): void {
  if (o.finished) return;
  o.finished = true;
  if (current === o) current = null;
  o.resolve(result);
  if (!o.win.isDestroyed()) {
    o.closable = true;
    o.win.destroy();
  }
}

export const promptOpen = (): boolean => current !== null;

/** Bring whatever is open to the front. */
export function focusPrompt(): boolean {
  if (!current || current.win.isDestroyed()) return false;
  if (current.win.isMinimized()) current.win.restore();
  current.win.show();
  current.win.focus();
  return true;
}

/** Shutting down: a window that refuses to close would hold up the whole quit,
 *  and with it the engine's drain, or a Windows shutdown. */
export function allowPromptClose(): void {
  if (current) current.closable = true;
}

/** Close an open approval as cancelled, because the screen is about to lock. */
export function cancelOpenPrompt(): void {
  if (current) finish(current, { done: false });
}

/**
 * Show a prompt and wait. Resolves `{ done: true }` when the handler finishes it,
 * `{ done: false }` when the user cancels or closes it. One at a time: a second
 * request while one is open is refused rather than stacked.
 */
export function runPrompt(opts: { parent?: BrowserWindow | null; first: PromptView; onAction: PromptHandler; closable?: boolean }): Promise<{ done: boolean; value?: unknown }> {
  installChannels();
  if (current) {
    focusPrompt();
    return Promise.resolve({ done: false, value: 'busy' });
  }
  const parent = opts.parent && !opts.parent.isDestroyed() && opts.parent.isVisible() ? opts.parent : undefined;
  const closable = opts.closable !== false;
  const win = new BrowserWindow({
    width: WIDTH,
    height: 420,
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: !parent,
    maximizable: false,
    fullscreenable: false,
    closable,
    title: 'Krypto Bot security',
    backgroundColor: '#0b0b14',
    autoHideMenuBar: true,
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: {
      preload: path.join(process.env.DIST_ELECTRON ?? __dirname, 'securityPreload.js'),
      partition: 'security-prompt',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.setMenu(null);
  // A secret on this window should not end up in a screen recording.
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  return new Promise((resolve) => {
    const open: Open = { win, view: opts.first, onAction: opts.onAction, resolve, closable, busy: false, finished: false };
    current = open;
    win.on('close', (e) => {
      if (!open.closable) e.preventDefault();
    });
    win.on('closed', () => finish(open, { done: false }));
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.loadFile(path.join(process.env.VITE_PUBLIC ?? '', 'security.html')).catch((err) => {
      logger.error(`security prompt: could not load (${(err as Error).message})`);
      open.closable = true;
      finish(open, { done: false, value: 'load-failed' });
    });
  });
}
