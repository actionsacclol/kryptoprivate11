// Sign in to pump.fun in the user's own Chrome or Edge, then keep the session.
//
// For an account that signs in with email, Google, Apple or GitHub (Privy),
// which pump no longer lets in by wallet signature. Two passes over ONE
// browser profile that belongs to this app (userData/pump-browser), never the
// user's everyday profile:
//
//   1. A normal window on pump.fun, started with NO debugging port, because
//      Google refuses OAuth in a browser that has one. The user signs in and
//      closes the window. Nothing here watches it except for its exit.
//   2. The same profile headless, with a debugging port on loopback for a few
//      seconds: read pump's `auth_token` cookie, close. If the cookie was not
//      kept across the restart, pump's page is loaded once so it can issue a
//      fresh one from the saved login. The token then goes to
//      pumpAuth.adoptWebSession, which asks pump who it belongs to and files
//      it under that wallet — or as a sign-in-only account.
//
// The profile stays, so next month's sign-in is one click (Google and pump
// both remember it), exactly as an everyday browser would keep it. Only the
// cookie's NAME ever reaches the log.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import WebSocket from 'ws';
import { logger } from './logger';
import * as pumpAuth from './pumpAuth';
import {
  browserCandidates,
  COOKIE_WAIT_MS,
  parseDevToolsActivePort,
  pumpCookieNames,
  pumpSessionCookies,
  PUMP_SIGNIN_URL,
  SIGNIN_WAIT_MS,
  type CdpCookie,
} from '@shared/pumpBrowserSignIn';

const profileDir = (): string => path.join(app.getPath('userData'), 'pump-browser');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const COMMON_ARGS = ['--no-first-run', '--no-default-browser-check'];

let running = false;
let cancelled = false;
let child: ChildProcess | null = null;

export function findBrowser(): string | null {
  for (const p of browserCandidates(process.platform, process.env)) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* next one */
    }
  }
  return null;
}

/** Stop waiting: closes the sign-in window if it is still open. */
export function cancel(): boolean {
  if (!running) return false;
  cancelled = true;
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  return true;
}

function waitExit(p: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    p.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/**
 * Pass 1. Resolves once the window is closed — when the process we started
 * exits AND the profile is no longer held. The second check is for a launch
 * that handed off to a window already open on this profile and exited at once.
 */
async function signInWindow(exe: string): Promise<'closed' | 'timeout' | 'cancelled'> {
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(exe, [`--user-data-dir=${dir}`, ...COMMON_ARGS, '--new-window', PUMP_SIGNIN_URL], { stdio: 'ignore' });
  child = p;
  p.on('error', (e) => logger.warn(`pump browser sign-in: could not start the browser — ${e.message}`));
  const deadline = Date.now() + SIGNIN_WAIT_MS;
  const exited = await waitExit(p, SIGNIN_WAIT_MS);
  child = null;
  if (cancelled) return 'cancelled';
  if (!exited) {
    try {
      p.kill();
    } catch {
      /* gone */
    }
    return 'timeout';
  }
  // Chrome holds `lockfile` in the profile while it runs (Windows), and
  // `SingletonLock` elsewhere.
  const held = (): boolean => fs.existsSync(path.join(dir, 'lockfile')) || fs.existsSync(path.join(dir, 'SingletonLock'));
  while (held() && Date.now() < deadline) {
    if (cancelled) return 'cancelled';
    await sleep(1_000);
  }
  return held() ? 'timeout' : 'closed';
}

/** A minimal DevTools client: one socket, numbered calls, nothing listened to. */
function devtools(url: string): Promise<{ send: (method: string, params?: object) => Promise<Record<string, unknown>>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let n = 0;
    const waits = new Map<number, (r: Record<string, unknown>) => void>();
    ws.on('message', (raw) => {
      try {
        const j = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        const w = typeof j.id === 'number' ? waits.get(j.id) : undefined;
        if (!w) return;
        waits.delete(j.id as number);
        w(j.result ?? {});
      } catch {
        /* not ours */
      }
    });
    ws.once('error', reject);
    ws.once('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = ++n;
            const t = setTimeout(() => {
              waits.delete(id);
              rej(new Error(`${method} timed out`));
            }, 10_000);
            waits.set(id, (r) => {
              clearTimeout(t);
              res(r);
            });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => ws.close(),
      }),
    );
  });
}

/** Pass 2. pump's session cookie(s) from the profile, or why there are none. */
async function readSession(exe: string): Promise<{ tokens: string[]; why: string }> {
  const dir = profileDir();
  const portFile = path.join(dir, 'DevToolsActivePort');
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    /* a stale one is checked against the new process below anyway */
  }
  // Port 0 = any free one, on loopback (Chrome's default address).
  const p = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, ...COMMON_ARGS, 'about:blank'], { stdio: 'ignore' });
  let client: Awaited<ReturnType<typeof devtools>> | null = null;
  try {
    let at: ReturnType<typeof parseDevToolsActivePort> = null;
    for (let i = 0; i < 100 && !at; i++) {
      if (p.exitCode !== null) return { tokens: [], why: 'The browser closed before the session could be read.' };
      try {
        at = parseDevToolsActivePort(fs.readFileSync(portFile, 'utf8'));
      } catch {
        /* not written yet */
      }
      if (!at) await sleep(100);
    }
    if (!at) return { tokens: [], why: 'The browser did not open its local connection, so the session could not be read.' };
    client = await devtools(`ws://127.0.0.1:${at.port}${at.wsPath}`);
    const cookies = async (): Promise<CdpCookie[]> => ((await client!.send('Storage.getCookies')).cookies as CdpCookie[]) ?? [];

    let all = await cookies();
    let tokens = pumpSessionCookies(all);
    if (tokens.length === 0) {
      // Not kept across the restart (a session-only cookie): let pump's page
      // issue one from the login the profile did keep.
      await client.send('Target.createTarget', { url: PUMP_SIGNIN_URL });
      const until = Date.now() + COOKIE_WAIT_MS;
      while (tokens.length === 0 && Date.now() < until) {
        await sleep(1_000);
        all = await cookies();
        tokens = pumpSessionCookies(all);
      }
    }
    if (tokens.length === 0) {
      const names = pumpCookieNames(all);
      logger.warn(`pump browser sign-in: no session cookie found — pump.fun cookies present: ${names.length ? names.join(', ') : 'none'}`);
      return {
        tokens: [],
        why: names.length
          ? 'pump.fun is open in that browser but did not leave a session. Make sure you finished signing in before closing the window, then try again.'
          : 'No pump.fun sign-in was found in that browser. Sign in on pump.fun first, then close the window.',
      };
    }
    return { tokens, why: '' };
  } catch (e) {
    return { tokens: [], why: `Could not read the session from the browser: ${(e as Error).message}` };
  } finally {
    try {
      await client?.send('Browser.close');
    } catch {
      /* closing anyway */
    }
    client?.close();
    if (!(await waitExit(p, 5_000))) {
      try {
        p.kill();
      } catch {
        /* gone */
      }
    }
  }
}

export async function signIn(): Promise<{ ok: boolean; message: string; address?: string; walletId?: string }> {
  if (running) return { ok: false, message: 'A browser sign-in is already open — finish it or press Cancel.' };
  const exe = findBrowser();
  if (!exe) return { ok: false, message: 'Neither Chrome nor Edge was found on this computer, so there is no browser to sign in with.' };
  running = true;
  cancelled = false;
  logger.info(`pump browser sign-in: opened ${path.basename(exe)} on pump.fun`);
  try {
    const closed = await signInWindow(exe);
    if (closed === 'cancelled') return { ok: false, message: 'Browser sign-in cancelled.' };
    if (closed === 'timeout') return { ok: false, message: 'The sign-in window was open for too long, so the app stopped waiting. Try again.' };
    const read = await readSession(exe);
    if (read.tokens.length === 0) return { ok: false, message: read.why };
    let last = 'pump.fun did not accept the session.';
    for (const tok of read.tokens) {
      const r = await pumpAuth.adoptWebSession(tok);
      if (r.ok) {
        logger.info(`pump browser sign-in: session kept for ${r.address?.slice(0, 6)}…`);
        return r;
      }
      last = r.message;
    }
    logger.warn(`pump browser sign-in: pump refused the session — ${last}`);
    return { ok: false, message: last };
  } finally {
    running = false;
    child = null;
  }
}
