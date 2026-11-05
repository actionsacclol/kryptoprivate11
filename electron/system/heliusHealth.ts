// Asks Helius what it thinks of the saved key, and says so bottom left.
//
// User report 2026-11-04: a new key, "Scanning · paused", "Attuning". The sockets
// only ever saw "Unexpected server response: 429" and waited 30 s, forever. The
// reason was in the refusal's body: {"code":-32429,"message":"max usage reached"}.
// A socket does not read that body, and a credits refusal needs a different answer
// from a rate limit, so this makes one small check of its own: a getSlot and one
// handshake that closes at once. A handshake delivers no data, so only the getSlot
// is billed. It runs at launch, when the key changes, and at most once every five
// minutes while something is being refused. It never touches a socket that trades.

import WebSocket from 'ws';
import { classifyHelius, type HeliusAnswer } from '../../shared/issues';
import { feedCostText } from '../../shared/credits';
import { clearIssue, raiseIssue } from './appIssues';
import { clearSocketSpent, markSocketSpent, noteRpcRejection } from '../chain/rpcClient';
import * as heliusBudget from './heliusBudget';

interface Host {
  key(): string;
  /** The monthly credit ceiling, 0 for none. */
  limit(): number;
  /** Move the scanner off Helius. True if that changed anything. */
  leaveHeliusFeed(): boolean;
}

const CHECK_GAP_MS = 5 * 60_000;
const RECHECK_MS = 30 * 60_000;
const SETTINGS_ACTION = { label: 'Open Settings', route: 'settings' } as const;

let host: Host | null = null;
let lastCheckAt = 0;
let running = false;
let again = false;
let recheck: ReturnType<typeof setTimeout> | null = null;
/** Helius only was switched off this time round, and the card must keep saying so
 *  until it is closed: otherwise it stays off and nobody remembers why. */
let switchedOff = false;

export function attach(h: Host): void {
  host = h;
}

function readHandshake(url: string): Promise<HeliusAnswer | null> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const done = (a: HeliusAnswer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(a);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => done(null), 10_000);
    try {
      ws = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });
    } catch {
      done(null);
      return;
    }
    ws.on('open', () => done({ status: 101, body: '' }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d: Buffer) => {
        if (body.length < 2_048) body += d.toString('utf8');
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
      res.on('error', () => done({ status: res.statusCode ?? 0, body }));
    });
    // Terminating a socket mid-handshake reports an error too, hence `settled`.
    ws.on('error', () => done(null));
  });
}

async function readHttp(url: string): Promise<HeliusAnswer | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(8_000),
    });
    heliusBudget.meterHttp(url, 'getSlot');
    return { status: res.status, body: (await res.text()).slice(0, 2_048) };
  } catch {
    return null;
  }
}

function scheduleRecheck(): void {
  if (recheck) clearTimeout(recheck);
  recheck = setTimeout(() => {
    recheck = null;
    void checkNow();
  }, RECHECK_MS);
  recheck.unref?.();
}

async function runCheck(): Promise<void> {
  const key = (host?.key() ?? '').trim();
  if (recheck) clearTimeout(recheck);
  recheck = null;
  if (!key) {
    clearIssue('helius-credits');
    clearIssue('helius-limit');
    return;
  }
  lastCheckAt = Date.now();
  const httpUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const wssUrl = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
  const [http, socket] = await Promise.all([readHttp(httpUrl), readHandshake(wssUrl)]);
  // The key was changed while this was asking: this answer is about the old one.
  if ((host?.key() ?? '').trim() !== key) {
    again = true;
    return;
  }
  const v = classifyHelius(http, socket);
  if (v.refused) noteRpcRejection(httpUrl, v.refused);
  if (v.socketSpent || v.httpSpent) {
    if (v.socketSpent) markSocketSpent(wssUrl);
    if (v.socketSpent && host?.leaveHeliusFeed()) switchedOff = true;
    raiseIssue({
      id: 'helius-credits',
      level: 'error',
      title: 'Helius has no credits left',
      body:
        'Helius refused your key with "max usage reached", its answer when a plan is out of credits. ' +
        'A new key on the same account may not help: check your usage at dashboard.helius.dev. ' +
        'Credits come back with the next billing cycle or a top-up.' +
        (switchedOff
          ? ' Helius feed was switched off, so the scanner keeps running on the public sockets. ' +
            `Leave it off unless your plan can carry it: ${feedCostText(host?.limit() ?? 0)}`
          : ''),
      action: SETTINGS_ACTION,
    });
    scheduleRecheck();
  } else if (v.fine) {
    clearSocketSpent(wssUrl);
    clearIssue('helius-credits');
    switchedOff = false;
  }
  if (v.limited) {
    raiseIssue({
      id: 'helius-limit',
      level: 'warn',
      title: 'Helius is refusing connections',
      body: `Helius answered: ${v.limited}`,
      action: SETTINGS_ACTION,
    });
  } else if (socket) {
    clearIssue('helius-limit');
  }
}

/** Ask now: at launch, and whenever the key or how it is used has changed. */
export async function checkNow(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await runCheck();
    } while (again);
  } catch {
    /* a health check must never take anything down */
  } finally {
    running = false;
  }
}

/** A keyed socket or request was just refused. Only Helius has a body to read. */
export function noteRefusal(url: string): void {
  if (!/helius/i.test(url)) return;
  if (Date.now() - lastCheckAt < CHECK_GAP_MS) return;
  void checkNow();
}
