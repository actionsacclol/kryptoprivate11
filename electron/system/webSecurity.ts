import { shell, type BrowserWindow } from 'electron';

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
  "media-src 'self'",
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
    "media-src 'self'",
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
