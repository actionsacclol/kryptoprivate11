// Signing in to pump.fun in the user's own browser (2026-10-25) — the rules.
//
// Why a real browser: an account that has an email or social login on pump.fun
// (Privy) refuses the app's wallet-signature login — 409 "Wallet belongs to an
// existing Privy account" — and Google refuses OAuth both inside Electron and
// in a Chrome that has a debugging port open (tried 2026-09-23). So the user
// signs in in a plain Chrome or Edge with NO debugging port, closes it, and
// only then is the same profile started headless with a port, long enough to
// read pump's `auth_token` cookie. Google never sees the port.
//
// The side that spawns the browser is electron/system/pumpBrowserSignIn.ts.
// This file is the part that can be tested without one.

/** Where pump's own site starts. The only URL the sign-in browser is given. */
export const PUMP_SIGNIN_URL = 'https://pump.fun/';

/** pump's web session cookie — the same one /auth/register sets (2026-10-22). */
export const PUMP_COOKIE_NAME = 'auth_token';

/** Long enough for an email code or a 2FA prompt; the window can be closed sooner. */
export const SIGNIN_WAIT_MS = 20 * 60_000;

/** How long the headless pass waits for pump's page to hand out a fresh cookie. */
export const COOKIE_WAIT_MS = 25_000;

/**
 * Chrome first (what most people sign in to Google with), then Edge, which
 * every Windows install has. Paths only — nothing here is taken from settings
 * or a caller, so the app can only ever start a browser installed in the usual
 * place.
 */
export function browserCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramW6432].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    const out: string[] = [];
    for (const r of roots) out.push(`${r}\\Google\\Chrome\\Application\\chrome.exe`);
    for (const r of roots) out.push(`${r}\\Microsoft\\Edge\\Application\\msedge.exe`);
    return [...new Set(out)];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

/**
 * Chrome writes `DevToolsActivePort` into the profile when it opens a port:
 * the port on line one, the browser's websocket path on line two. Anything
 * else is refused, so the socket can only ever go to loopback.
 */
export function parseDevToolsActivePort(text: string): { port: number; wsPath: string } | null {
  const [a, b] = (text ?? '').split(/\r?\n/);
  const port = Number(a);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (typeof b !== 'string' || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(b)) return null;
  return { port, wsPath: b };
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  expires?: number;
  session?: boolean;
}

const onPump = (domain: string): boolean => {
  const d = (domain ?? '').replace(/^\./, '').toLowerCase();
  return d === 'pump.fun' || d.endsWith('.pump.fun');
};

/**
 * pump's session cookies from a cookie list, newest expiry first, at most
 * three. Only a JWT-shaped value under the known name on a pump.fun domain —
 * every other cookie in the profile (Google's included) is left alone.
 */
export function pumpSessionCookies(cookies: CdpCookie[]): string[] {
  const rows = (Array.isArray(cookies) ? cookies : []).filter(
    (c) =>
      c &&
      c.name === PUMP_COOKIE_NAME &&
      onPump(c.domain) &&
      typeof c.value === 'string' &&
      c.value.length <= 4096 &&
      c.value.split('.').length === 3,
  );
  rows.sort((x, y) => (y.expires ?? 0) - (x.expires ?? 0));
  return [...new Set(rows.map((c) => c.value))].slice(0, 3);
}

/** NAMES of the pump.fun cookies, never values — for the log when no session turned up. */
export function pumpCookieNames(cookies: CdpCookie[]): string[] {
  return [...new Set((Array.isArray(cookies) ? cookies : []).filter((c) => c && onPump(c.domain)).map((c) => `${c.name}${c.session ? ' (session)' : ''}`))];
}

/**
 * pump's answer when the account behind a wallet has an email or social
 * login: wallet-signature sign-in is closed for it, and the browser is the
 * only way in. Matched on the words because the code field is not known.
 */
export const isPrivyRefusal = (status: number, message: string): boolean => status === 409 && /privy/i.test(message ?? '');
