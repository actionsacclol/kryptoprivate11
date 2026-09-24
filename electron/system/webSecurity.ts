import { shell, type BrowserWindow, app } from 'electron';
import { isEmbeddableUrl } from '@shared/tokenLinks';
import { logger } from './logger';

/**
 * Content-Security-Policy for the renderer.
 *
 * The renderer never makes network requests of its own — the engine lives in
 * the main process and the renderer talks to it only over IPC — so
 * `connect-src` can stay closed in production. Fonts are bundled locally
 * (see src/main.tsx), so `font-src 'self'` is sufficient and no remote origin
 * is needed at all.
 *
 * `style-src` keeps 'unsafe-inline' because React sets style attributes and
 * Tailwind injects a style element; that is a far weaker concession than
 * script-src would be, and script-src stays strict.
 */
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // krypt-img: is our OWN main-process handler, not a remote origin. It is
  // how token icons reach the renderer without opening img-src to https:,
  // which would let any token creator harvest the IP of every install that
  // scrolled past their coin. See electron/data/images.ts.
  "img-src 'self' data: blob: krypt-img:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // blob: is for a video the USER picked as a card background: the renderer
  // reads the file it was handed and makes an object URL for it. It is the
  // renderer's own bytes, same-origin, and opens no network origin — an mp4
  // is far too large to carry as a data: URL, which is why img-src's trick
  // does not work here. See src/components/terminal/videoBackground.ts.
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** Dev additionally needs the Vite dev server, its HMR websocket, and the
 *  eval-based dev transform. Never used in a packaged build. */
function cspDev(devUrl: string): string {
  let origin = devUrl;
  try {
    origin = new URL(devUrl).origin;
  } catch {
    /* fall back to the raw string */
  }
  const ws = origin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: blob: krypt-img: ${origin}`,
    `font-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin} ${ws}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Attach the CSP to every response the renderer loads. Set as a response
 * header rather than a <meta> tag so it also covers the dev server and cannot
 * be removed by anything that manages to inject markup.
 */
export function applyCsp(win: BrowserWindow, devUrl: string | undefined): void {
  const policy = devUrl ? cspDev(devUrl) : CSP_PROD;
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

/**
 * External links open in the system browser, never inside the app; the top
 * frame can never navigate away from app-local content (a remote page must
 * never gain access to the preload's window.krypt surface).
 */
export function guardWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const isLocal =
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith('http://127.0.0.1');
    if (!isLocal) {
      e.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
}

/**
 * Embedded browser views — the Links panel's <webview> (2026-09-20).
 *
 * A webview is a page the app did not write, shown inside a window that
 * carries window.krypt. It is safe only because of what it is NOT given:
 * no preload (so no bridge), no Node, context isolation and the sandbox on,
 * https only, and its own session partition so its cookies never touch the
 * app's. Every one of those is set HERE, in main, when the view attaches —
 * a renderer that asked for more would simply not get it. Popups are denied
 * and handed to the system browser; downloads and permission prompts
 * (camera, notifications, …) are refused outright.
 *
 * Registered once at startup; `web-contents-created` fires for the guest
 * too, which is where its own navigation guards go.
 */
export function guardWebviews(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete (webPreferences as { preload?: string }).preload;
      delete (webPreferences as { preloadURL?: string }).preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.experimentalFeatures = false;
      webPreferences.enableBlinkFeatures = '';
      if (!isEmbeddableUrl(params.src)) {
        logger.warn(`webview: refused to attach a view for ${String(params.src).slice(0, 120)}`);
        event.preventDefault();
      }
    });
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (isEmbeddableUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const onlyHttps = (e: { preventDefault: () => void }, url: string): void => {
      if (!isEmbeddableUrl(url)) e.preventDefault();
    };
    contents.on('will-navigate', onlyHttps);
    contents.on('will-redirect', onlyHttps);
    // The guest's session is its own partition; refuse what a page could ask
    // of the machine. Idempotent per session.
    const ses = contents.session;
    if (!guardedSessions.has(ses)) {
      guardedSessions.add(ses);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.on('will-download', (e) => e.preventDefault());
    }
  });
}
const guardedSessions = new WeakSet<Electron.Session>();
