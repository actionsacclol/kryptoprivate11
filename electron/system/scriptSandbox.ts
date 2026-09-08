// Script sandboxes: one hidden, sandboxed renderer per running code script.
//
// Why a renderer and not `vm`: Node's vm module is not a security boundary,
// and a utility process still has Node — `require('fs')` is one line away.
// A sandboxed BrowserWindow is Chromium's own process sandbox: no Node, no
// filesystem, and with the partition below, no network either. What a
// script CAN do is send messages on one channel; `automation.ts` decides
// what each one is allowed to mean.
//
// The window is tied to a script id at creation. A message is attributed
// by the webContents it came from, never by anything the message says.

import { BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import path from 'node:path';
import { parseFromSandbox, sandboxPageHtml, EVENT_TIMEOUT_MS, READY_TIMEOUT_MS, type MainToSandbox, type SandboxToMain } from '@shared/scriptProtocol';

const CHANNEL = 'script-sandbox';
const PARTITION = 'script-sandbox';

export interface SandboxHost {
  /** A validated message from the sandbox of `scriptId`. */
  onMessage(scriptId: string, msg: SandboxToMain): void;
  /** The sandbox died (crash, kill, watchdog) — the script is no longer running. */
  onGone(scriptId: string, reason: string): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Box {
  scriptId: string;
  win: BrowserWindow;
  ready: boolean;
  readyWaiters: Array<(ok: boolean, why: string) => void>;
  /** Pending event dispatches, by id. */
  inflight: Map<number, { resolve: (r: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout }>;
  nextEventId: number;
}

const boxes = new Map<string, Box>();
const byContents = new Map<number, string>();
let host: SandboxHost | null = null;
let installed = false;

/** Once, before any sandbox: lock the partition down and route its messages. */
export function install(h: SandboxHost): void {
  host = h;
  if (installed) return;
  installed = true;
  const ses = session.fromPartition(PARTITION);
  // No network. The only request allowed is the sandbox page itself — a
  // data: URL loading as the main frame (it DOES pass through here; the
  // live test found the blanket cancel blocking it). Everything else —
  // fetch, XHR, WebSocket, images, fonts, any navigation — is cancelled.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isOwnPage = details.resourceType === 'mainFrame' && details.url.startsWith('data:text/html');
    callback({ cancel: !isOwnPage });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ipcMain.on(CHANNEL, (event, raw: unknown) => {
    const scriptId = byContents.get(event.sender.id);
    if (!scriptId) return; // not one of ours
    const msg = parseFromSandbox(raw);
    if (!msg) {
      host?.log('warn', `script ${scriptId}: dropped a malformed sandbox message`);
      return;
    }
    const box = boxes.get(scriptId);
    if (!box) return;
    if (msg.t === 'ready') {
      box.ready = true;
      for (const w of box.readyWaiters.splice(0)) w(true, '');
    } else if (msg.t === 'error' && !box.ready) {
      // The script threw while loading: say so now, not after the ready
      // timeout has run out.
      for (const w of box.readyWaiters.splice(0)) w(false, msg.line);
    } else if (msg.t === 'done') {
      const p = box.inflight.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        box.inflight.delete(msg.id);
        p.resolve({ ok: msg.ok, error: msg.error });
      }
    }
    host?.onMessage(scriptId, msg);
  });
}

export function isRunning(scriptId: string): boolean {
  const b = boxes.get(scriptId);
  return !!b && b.ready && !b.win.isDestroyed();
}

/** Start (or restart) the sandbox for a script and load its code. */
export async function start(scriptId: string, code: string): Promise<{ ok: boolean; message: string }> {
  await stop(scriptId, 'restart');
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: {
        preload: path.join(__dirname, 'scriptPreload.js'),
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        backgroundThrottling: false,
        images: false,
        webgl: false,
      },
    });
  } catch (err) {
    return { ok: false, message: `sandbox window: ${(err as Error).message}` };
  }
  const box: Box = { scriptId, win, ready: false, readyWaiters: [], inflight: new Map(), nextEventId: 1 };
  boxes.set(scriptId, box);
  byContents.set(win.webContents.id, scriptId);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const gone = (reason: string): void => {
    if (boxes.get(scriptId) !== box) return;
    teardown(box);
    host?.onGone(scriptId, reason);
  };
  win.webContents.on('render-process-gone', (_e, d) => gone(`renderer ${d.reason}`));
  win.on('closed', () => gone('closed'));

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sandboxPageHtml())}`);
  } catch (err) {
    teardown(box);
    return { ok: false, message: `sandbox load: ${(err as Error).message}` };
  }
  if (win.isDestroyed()) return { ok: false, message: 'sandbox closed while loading' };
  post(box, { t: 'init', scriptId, code });
  const ready = await new Promise<{ ok: boolean; why: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, why: `no ready within ${READY_TIMEOUT_MS} ms` }), READY_TIMEOUT_MS);
    box.readyWaiters.push((ok, why) => {
      clearTimeout(timer);
      resolve({ ok, why });
    });
  });
  if (!ready.ok) {
    await stop(scriptId, 'failed to start');
    return { ok: false, message: ready.why };
  }
  return { ok: true, message: 'running' };
}

/** Push an event and wait for the handlers. A handler still running after
 *  EVENT_TIMEOUT_MS is a runaway: the renderer is killed, the script is
 *  reported gone, and the caller sees an error. */
export function dispatch(scriptId: string, name: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const box = boxes.get(scriptId);
  if (!box || !box.ready || box.win.isDestroyed()) return Promise.resolve({ ok: false, error: 'not running' });
  const id = box.nextEventId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      box.inflight.delete(id);
      resolve({ ok: false, error: `handler for "${name}" ran past ${EVENT_TIMEOUT_MS} ms — killed` });
      try {
        box.win.webContents.forcefullyCrashRenderer();
      } catch {
        void stop(scriptId, 'watchdog');
      }
    }, EVENT_TIMEOUT_MS);
    box.inflight.set(id, { resolve, timer });
    post(box, { t: 'event', id, name, payload });
  });
}

/** Answer a `call` the script made. */
export function reply(scriptId: string, id: number, ok: boolean, value?: unknown, error?: string): void {
  const box = boxes.get(scriptId);
  if (!box || box.win.isDestroyed()) return;
  post(box, { t: 'reply', id, ok, value, error });
}

export async function stop(scriptId: string, reason = 'stopped'): Promise<void> {
  const box = boxes.get(scriptId);
  if (!box) return;
  teardown(box);
  host?.log('info', `script ${scriptId}: sandbox ${reason}`);
}

export async function stopAll(): Promise<void> {
  for (const id of [...boxes.keys()]) await stop(id, 'shutdown');
}

function teardown(box: Box): void {
  if (boxes.get(box.scriptId) === box) boxes.delete(box.scriptId);
  byContents.delete(box.win.webContents.id);
  for (const [, p] of box.inflight) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: 'sandbox stopped' });
  }
  box.inflight.clear();
  for (const w of box.readyWaiters.splice(0)) w(false, 'sandbox stopped');
  try {
    if (!box.win.isDestroyed()) box.win.destroy();
  } catch {
    /* already gone */
  }
}

function post(box: Box, msg: MainToSandbox): void {
  try {
    const wc: WebContents = box.win.webContents;
    if (!wc.isDestroyed()) wc.send(CHANNEL, msg);
  } catch {
    /* frame gone — the gone handler reports it */
  }
}
