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
import { parseFromSandbox, sandboxPageHtml, ALIVE_TIMEOUT_MS, EVENT_TIMEOUT_MS, READY_MAX_MS, READY_TIMEOUT_MS, type MainToSandbox, type SandboxToMain } from '@shared/scriptProtocol';

const CHANNEL = 'script-sandbox';
const PARTITION = 'script-sandbox';

export interface SandboxHost {
  /** A validated message from the sandbox of `scriptId`. */
  onMessage(scriptId: string, msg: SandboxToMain): void;
  /** The sandbox died (crash, kill, watchdog) — the script is no longer running. */
  onGone(scriptId: string, reason: string): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface Inflight {
  /** Answers the dispatch caller; only the first call counts. */
  settle: (r: { ok: boolean; error?: string }) => void;
  /** The watchdog deadline. A `done` does NOT clear it — see dispatch(). */
  timer: NodeJS.Timeout;
  /** A well-formed `done` arrived for this id. */
  onDone: (r: { ok: boolean; error?: string }) => void;
}

interface Box {
  scriptId: string;
  win: BrowserWindow;
  /** Held directly: reading `win.webContents` throws once the window is gone. */
  contents: WebContents;
  contentsId: number;
  /** Which start() made this box; a stale start must not touch a newer one. */
  gen: number;
  /** The harness said `alive`: the preload installed the bridge. */
  alive: boolean;
  aliveWaiters: Array<() => void>;
  ready: boolean;
  readyWaiters: Array<(ok: boolean, why: string) => void>;
  /** What Electron said when the preload failed to load, if it did. This is
   *  the only place the real reason is knowable; without it every preload
   *  failure looks like a plain timeout. */
  preloadError: string | null;
  /** Pending event dispatches, by id. */
  inflight: Map<number, Inflight>;
  nextEventId: number;
}

/** Message rate wall, per sandbox. A script that floods the channel makes
 *  MAIN do the work — and main is where breakers, orders and sells are
 *  evaluated, so a jam delays a stop-loss. Measured: 20,000 messages =
 *  8.4 s of main-process time. */
const MSG_BURST = 120;
const MSG_PER_SEC = 60;

interface Bucket {
  tokens: number;
  last: number;
  dropped: number;
  /** One error per flood, not one per dropped message. */
  reported: boolean;
}

const boxes = new Map<string, Box>();
const byContents = new Map<number, string>();
const buckets = new Map<number, Bucket>();
let host: SandboxHost | null = null;
let installed = false;
let generation = 0;

/** Where the bridge preload lives. Overridable ONLY so the live test can
 *  point it at a file that does not exist and prove what a broken install
 *  actually reports — that failure shipped once as a bare eight-second
 *  timeout and nothing pinned it. */
let preloadPath: string | null = null;
export function _setPreloadPath(p: string | null): void {
  preloadPath = p;
}

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
  // WebRTC's only way out is a proxy that carries UDP (see the window's
  // `disable_non_proxied_udp` below); pin this partition to a direct
  // connection so the user's system proxy can never be that carrier.
  void ses.setProxy({ mode: 'direct' }).catch(() => undefined);
  ipcMain.on(CHANNEL, (event, raw: unknown) => {
    const scriptId = byContents.get(event.sender.id);
    if (!scriptId) return; // not one of ours
    const box = boxes.get(scriptId);
    if (!box) return;
    // The rate wall, before anything reads the message. `ready` and `done`
    // are exempt: they are the control path (startup and the watchdog), they
    // parse without touching the payload, and main's own state bounds what
    // they can do — starving them would let a flood fake a hang or a
    // failure to start. Everything else — log, call, error, and anything
    // malformed — is bucketed, so a flood costs main a lookup and no more.
    const kind = typeof raw === 'object' && raw !== null ? (raw as { t?: unknown }).t : undefined;
    if (kind !== 'ready' && kind !== 'done' && !allow(box)) return;
    const msg = parseFromSandbox(raw);
    if (!msg) {
      host?.log('warn', `script ${scriptId}: dropped a malformed sandbox message`);
      return;
    }
    if (msg.t === 'alive') {
      box.alive = true;
      for (const w of box.aliveWaiters.splice(0)) w();
    } else if (msg.t === 'ready') {
      box.ready = true;
      for (const w of box.readyWaiters.splice(0)) w(true, '');
    } else if (msg.t === 'error' && !box.ready) {
      // The script threw while loading: say so now, not after the ready
      // timeout has run out.
      for (const w of box.readyWaiters.splice(0)) w(false, msg.line);
    } else if (msg.t === 'done') {
      // A `done` is the page's WORD that the handler finished — page code can
      // forge one (the preload's `on` is additive and the id is in the body).
      // It answers the caller; only a live renderer clears the watchdog.
      box.inflight.get(msg.id)?.onDone({ ok: msg.ok, error: msg.error });
    }
    host?.onMessage(scriptId, msg);
  });
}

/** Token bucket per sandbox. False ⇒ drop this message. */
function allow(box: Box): boolean {
  const now = Date.now();
  let b = buckets.get(box.contentsId);
  if (!b) {
    b = { tokens: MSG_BURST, last: now, dropped: 0, reported: false };
    buckets.set(box.contentsId, b);
  }
  b.tokens = Math.min(MSG_BURST, b.tokens + ((now - b.last) / 1000) * MSG_PER_SEC);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    // Recovered: a later flood is a new episode and reports again.
    if (b.tokens >= MSG_BURST - 1 && b.reported) {
      host?.log('info', `script ${box.scriptId}: message flood over — ${b.dropped} dropped`);
      b.reported = false;
      b.dropped = 0;
    }
    return true;
  }
  b.dropped += 1;
  if (!b.reported) {
    b.reported = true;
    host?.log('warn', `script ${box.scriptId}: over ${MSG_PER_SEC} sandbox messages a second — dropping the excess`);
    host?.onMessage(box.scriptId, {
      t: 'error',
      line: `flooded the sandbox channel (over ${MSG_PER_SEC} messages a second) — messages are being dropped`,
    });
  }
  return false;
}

export function isRunning(scriptId: string): boolean {
  const b = boxes.get(scriptId);
  return !!b && b.ready && !b.contents.isDestroyed();
}

/** What `start` says. `retryable` marks a failure that another attempt could
 *  plausibly survive — a slow start, a stalled provider — as opposed to code
 *  that will fail identically every time. The caller uses it to decide
 *  between backing off and disarming the script. */
export interface StartResult {
  ok: boolean;
  message: string;
  retryable?: boolean;
}

/** Start (or restart) the sandbox for a script and load its code. */
export async function start(scriptId: string, code: string, info?: { chain?: string; nativeSymbol?: string }): Promise<StartResult> {
  await stop(scriptId, 'restart');
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: {
        preload: preloadPath ?? path.join(__dirname, 'scriptPreload.js'),
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
  const contents = win.webContents;
  const box: Box = {
    scriptId,
    win,
    contents,
    contentsId: contents.id,
    gen: ++generation,
    alive: false,
    aliveWaiters: [],
    ready: false,
    readyWaiters: [],
    preloadError: null,
    inflight: new Map(),
    nextEventId: 1,
  };
  boxes.set(scriptId, box);
  byContents.set(box.contentsId, scriptId);
  // The last hole in "no network": a data-channel-only RTCPeerConnection
  // needs no permission, is not a request (so the webRequest cancel above
  // never sees it) and no `*-src` directive covers it — `stun:<attacker>`
  // was a DNS + UDP way out. The CSP3 `webrtc 'block'` directive is in the
  // page for the day Chromium implements it; measured on Electron 43 it does
  // nothing (meta AND header: 9 host candidates either way, and
  // `default_public_interface_only` reached Google's STUN server and put this
  // machine's public IP in the SDP). This DOES work: no candidate is
  // gathered at all, in the page's realm and in any iframe realm it can
  // make — measured 9 candidates → 0.
  try {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  } catch {
    /* older Electron — the CSP and the page comment stand */
  }
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  // A preload that fails to load is SILENT: the page's harness finds no
  // bridge and returns, so the only symptom was the ready timeout eight
  // seconds later, with no way to tell a broken install from a slow script.
  // Nothing subscribed to this until 2026-09-09.
  contents.on('preload-error', (_e, preloadPath, err) => {
    box.preloadError = `${path.basename(preloadPath)}: ${err?.message ?? String(err)}`;
    host?.log('error', `script ${scriptId}: sandbox preload failed to load — ${box.preloadError}`);
  });
  const gone = (reason: string): void => {
    // A closed window still owned by this script id must be reported even
    // when a newer box has taken the id — but only ours is torn down.
    const mine = boxes.get(scriptId) === box;
    teardown(box);
    if (mine) host?.onGone(scriptId, reason);
  };
  contents.on('render-process-gone', (_e, d) => gone(`renderer ${d.reason}`));
  win.on('closed', () => gone('closed'));

  // Every failure below tears down THIS box, never `stop(scriptId)`: a second
  // start may already own the id, and stopping "the script" would kill the
  // healthy newer sandbox while this stale start reports the failure.
  const superseded = (): boolean => boxes.get(scriptId) !== box;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sandboxPageHtml())}`);
  } catch (err) {
    teardown(box);
    return { ok: false, message: `sandbox load: ${(err as Error).message}` };
  }
  if (superseded()) {
    teardown(box);
    return { ok: false, message: `superseded by a newer start (#${box.gen} → #${generation})` };
  }
  if (contents.isDestroyed()) {
    teardown(box);
    return { ok: false, message: 'sandbox closed while loading' };
  }
  // Phase 1: is the bridge there at all? `alive` is the harness's first
  // statement, so this covers process start and nothing else. Missing it
  // means the preload never ran — a broken build, not a slow script.
  if (!box.alive) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ALIVE_TIMEOUT_MS);
      box.aliveWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (superseded()) {
    teardown(box);
    return { ok: false, message: `superseded by a newer start (#${box.gen} → #${generation})` };
  }
  if (!box.alive) {
    const why = box.preloadError
      ? `the sandbox preload failed to load (${box.preloadError}) — this is a broken install, not a problem with your script`
      : `the sandbox bridge never loaded (no signal in ${ALIVE_TIMEOUT_MS} ms) — this is a broken install, not a problem with your script`;
    teardown(box);
    host?.log('error', `script ${scriptId}: ${why}`);
    return { ok: false, message: why, retryable: true };
  }

  // Phase 2: the script's own top-level code. It may use top-level `await`,
  // so this budget is the USER's, and a renderer that keeps answering is
  // given more of it rather than killed for being slow.
  post(box, { t: 'init', scriptId, code, chain: info?.chain, nativeSymbol: info?.nativeSymbol });
  const startedAt = Date.now();
  let ready: { ok: boolean; why: string } | null = null;
  for (;;) {
    ready = await new Promise<{ ok: boolean; why: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), READY_TIMEOUT_MS);
      box.readyWaiters.push((ok, why) => {
        clearTimeout(timer);
        resolve({ ok, why });
      });
    });
    if (superseded()) {
      teardown(box);
      return { ok: false, message: `superseded by a newer start (#${box.gen} → #${generation})` };
    }
    // `why` is only 'timeout' for our own timer; a real load error arrives
    // through the waiter and is reported as itself.
    if (ready.ok || ready.why !== 'timeout') break;
    if (contents.isDestroyed()) break;
    const elapsed = Date.now() - startedAt;
    // Still breathing? Then it is waiting on something (a `bot.market` behind
    // a parked provider, say), not wedged. Wedged renderers never answer.
    const breathing = await probeAlive(contents);
    if (!breathing || elapsed >= READY_MAX_MS) {
      const why = breathing
        ? `the script's own top-level code did not finish within ${Math.round(READY_MAX_MS / 1000)} s`
        : `the sandbox stopped responding while loading the script (${Math.round(elapsed / 1000)} s)`;
      teardown(box);
      host?.log('warn', `script ${scriptId}: ${why}`);
      return { ok: false, message: why, retryable: breathing };
    }
    host?.log('info', `script ${scriptId}: still starting after ${Math.round(elapsed / 1000)} s — its top-level code is waiting on something, the sandbox is healthy`);
  }
  if (!ready.ok) {
    teardown(box);
    host?.log('info', `script ${scriptId}: sandbox failed to start (${ready.why})`);
    return { ok: false, message: ready.why };
  }
  return { ok: true, message: 'running' };
}

/** True if the RENDERER itself answers. A wedged one never does; a page
 *  merely waiting on main does. Same probe the event watchdog uses. */
async function probeAlive(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 1_000);
    contents
      .executeJavaScript('0')
      .then(() => {
        clearTimeout(timer);
        done(true);
      })
      .catch(() => {
        clearTimeout(timer);
        done(false);
      });
  });
}

/** Push an event and wait for the handlers. A handler still running after
 *  EVENT_TIMEOUT_MS is a runaway: the renderer is killed, the script is
 *  reported gone, and the caller sees an error.
 *
 *  The page cannot talk its way out of that. Its `done` answers the caller,
 *  but the deadline is only lifted once the RENDERER answers an injected
 *  expression — `executeJavaScript` is a true liveness probe (it sits pending
 *  for exactly as long as a wedged renderer is wedged, where
 *  `win.on('unresponsive')` never fires at all for a hidden window: Chromium's
 *  hang monitor is input-driven). So a forged `done` from a second, additive
 *  ipcRenderer listener buys nothing — the probe never comes back and the
 *  renderer is crashed on time. */
export function dispatch(scriptId: string, name: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const box = boxes.get(scriptId);
  if (!box || !box.ready || box.contents.isDestroyed()) return Promise.resolve({ ok: false, error: 'not running' });
  const id = box.nextEventId++;
  return new Promise((resolve) => {
    let settled = false;
    let probing = false;
    const settle = (r: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      box.inflight.delete(id);
      settle({ ok: false, error: `handler for "${name}" ran past ${EVENT_TIMEOUT_MS} ms — killed` });
      kill(box, scriptId);
    }, EVENT_TIMEOUT_MS);
    const clear = (): void => {
      clearTimeout(timer);
      if (box.inflight.get(id) === entry) box.inflight.delete(id);
    };
    const onDone = (r: { ok: boolean; error?: string }): void => {
      settle(r);
      if (probing) return;
      probing = true;
      // Not a value we use — only the renderer's ability to answer at all.
      // Either outcome ends the deadline; a rejection means the frame is
      // gone, which the 'gone' handler reports on its own.
      try {
        void box.contents.executeJavaScript('0').then(clear, clear);
      } catch {
        clear();
      }
    };
    const entry: Inflight = { settle, timer, onDone };
    box.inflight.set(id, entry);
    post(box, { t: 'event', id, name, payload });
  });
}

function kill(box: Box, scriptId: string): void {
  try {
    if (!box.contents.isDestroyed()) box.contents.forcefullyCrashRenderer();
    else void stop(scriptId, 'watchdog');
  } catch {
    void stop(scriptId, 'watchdog');
  }
}

/** Answer a `call` the script made. */
export function reply(scriptId: string, id: number, ok: boolean, value?: unknown, error?: string): void {
  const box = boxes.get(scriptId);
  if (!box || box.contents.isDestroyed()) return;
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

// Nothing here may read a property OFF the window: a page that called
// window.close() (or any stop after a crash) reaches teardown with the
// BrowserWindow already destroyed, and `win.webContents` then THROWS
// "Object has been destroyed" — out of the 'closed' listener, past
// host.onGone (so automation never learns the script died) and into
// crashGuard, which writes a crash file and shouts about a trade in flight.
// The contents id and object are captured at creation for exactly this.
function teardown(box: Box): void {
  if (boxes.get(box.scriptId) === box) boxes.delete(box.scriptId);
  byContents.delete(box.contentsId);
  buckets.delete(box.contentsId);
  for (const [, p] of box.inflight) {
    clearTimeout(p.timer);
    p.settle({ ok: false, error: 'sandbox stopped' });
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
    const wc: WebContents = box.contents;
    if (!wc.isDestroyed()) wc.send(CHANNEL, msg);
  } catch {
    /* frame gone — the gone handler reports it */
  }
}
