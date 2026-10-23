// The last resort for pump.fun's sign-in: send the request from INSIDE a hidden
// pump.fun page.
//
// pumpFetch.ts sends through Chromium's network stack, which Cloudflare lets
// through today (2026-10-22). If it ever starts demanding a real browser
// challenge of that too, the request has to come from a page that has passed
// one. This keeps one hidden window on https://pump.fun/, waits for Cloudflare
// to let it in, and fetches from page context — the same thing pump's own site
// does, so Origin and the clearance cookie are exactly what their guard expects.
// Tested working 2026-10-22 (register/login answered by pump from page context).
//
// Used by pumpFetch.ts whenever Chromium's own request cannot get through —
// a Cloudflare challenge, or the TLS client-certificate demand pump's hosts
// began making on 2026-10-22 (ERR_SSL_CLIENT_AUTH_CERT_NEEDED, which Electron's
// `net` cannot answer but a real page can). See fixpump.md.
//
// What the window may do is kept small: it loads one URL, opens nothing, asks
// for no permission, and is destroyed after it has been idle for a while. The
// host is checked here as well, so a caller cannot point it elsewhere.

import electron from 'electron';
import type { BrowserWindow } from 'electron';
import { logger } from './logger';
import { PUMP_API_HOST } from '@shared/pumpAuth';

const PARTITION = 'persist:pump-cf';
const HOME = 'https://pump.fun/';
const READY_TIMEOUT_MS = 30_000;
const IDLE_MS = 90_000;

let win: BrowserWindow | null = null;
let opening: Promise<BrowserWindow> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const stillChallenged = (title: string): boolean => /just a moment|attention required|checking your browser/i.test(title);

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(close, IDLE_MS);
  idleTimer.unref?.();
}

function close(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = win;
  win = null;
  opening = null;
  if (w && !w.isDestroyed()) w.destroy();
}

async function open(): Promise<BrowserWindow> {
  const { BrowserWindow: Win } = electron;
  if (!Win) throw new Error('no browser available outside Electron');
  const w = new Win({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  w.on('closed', () => {
    if (win === w) win = null;
    opening = null;
  });
  try {
    await Promise.race([
      w.loadURL(HOME),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('pump.fun took too long to load')), READY_TIMEOUT_MS)),
    ]);
    // Cloudflare's own check runs in the page; wait for it to hand over the real site.
    const until = Date.now() + READY_TIMEOUT_MS;
    while (stillChallenged(w.getTitle()) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    if (stillChallenged(w.getTitle())) throw new Error("Cloudflare did not let the page through");
  } catch (e) {
    if (!w.isDestroyed()) w.destroy();
    throw e;
  }
  return w;
}

async function windowReady(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  opening ??= open().then((w) => {
    win = w;
    return w;
  });
  try {
    return await opening;
  } catch (e) {
    opening = null;
    throw e;
  }
}

/** The session token a call carries, from its Cookie or Authorization header. */
function tokenOf(headers: Record<string, string> | undefined): string | null {
  const get = (k: string): string | undefined => Object.entries(headers ?? {}).find(([x]) => x.toLowerCase() === k)?.[1];
  const c = get('cookie')?.match(/(?:^|;\s*)auth_token=([^;\s]+)/);
  if (c) return c[1];
  const a = get('authorization')?.match(/^Bearer\s+(\S+)/i);
  return a ? a[1] : null;
}

// One request at a time. An authenticated call parks its token in the window's
// cookie jar for the length of the request and takes it out again, so two
// wallets' calls must never overlap or one would ride on the other's session.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Send `url` from inside the pump.fun page. Returns a real Response so callers
 * read it exactly as they read a normal one. Throws if no page could be opened
 * — the caller then keeps the answer it already had.
 *
 * Authenticated calls work here too: the page cannot set Cookie or
 * Authorization itself (their preflight allows only `content-type`), but the
 * `auth_token` cookie is exactly how their own site authenticates, so the token
 * is set as that cookie on the API host and the fetch is made with credentials.
 */
export function browserFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const run = chain.then(() => send(url, init));
  chain = run.catch(() => undefined);
  return run;
}

async function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.host !== PUMP_API_HOST) throw new Error('browserFetch only talks to pump.fun');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`browserFetch will not send ${method}`);
  // The only request headers a page may send to this API (see the header above).
  const headers: Record<string, string> = { accept: 'application/json' };
  const ct = Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  if (ct) headers['content-type'] = ct;
  const token = tokenOf(init.headers);
  const w = await windowReady();
  armIdle();
  const jar = w.webContents.session.cookies;
  const origin = `https://${PUMP_API_HOST}/`;
  if (token) await jar.set({ url: origin, name: 'auth_token', value: token, secure: true, httpOnly: true, sameSite: 'no_restriction' });
  try {
    const out = (await w.webContents.executeJavaScript(
      `(async (u, m, h, b, c) => {
         const r = await fetch(u, { method: m, headers: h, body: b, credentials: c });
         return { status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() };
       })(${JSON.stringify(u.toString())}, ${JSON.stringify(method)}, ${JSON.stringify(headers)}, ${JSON.stringify(init.body ?? null)}, ${JSON.stringify(token ? 'include' : 'omit')})`,
    )) as { status: number; ct: string; text: string };
    logger.info(`pump.fun: ${method} ${u.pathname} answered ${out.status} from the hidden page`);
    const noBody = out.status === 204 || out.status === 205 || out.status === 304;
    return new Response(noBody ? null : out.text, { status: out.status, headers: out.ct ? { 'content-type': out.ct } : {} });
  } finally {
    if (token) await jar.remove(origin, 'auth_token').catch(() => undefined);
  }
}

/** Tests / shutdown: drop the window. */
export function closeBrowser(): void {
  close();
}
