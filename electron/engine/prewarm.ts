// Trade-path prewarm.
//
// A manual order used to do ALL of its network setup inside the click: open
// TLS to the RPC, the Helius sender, the Jito block engine and PumpPortal;
// fetch the Jito tip floor; read pump's Global config; read every lookup
// table the build referenced; check the fee recipients for rent-exemption;
// fetch a blockhash. Measured 2026-08-29 that was 400–600 ms of a
// 1.4–2.3 s order that had nothing to do with the trade itself.
//
// arm() now kicks this off and a heartbeat keeps it warm while armed, so an
// order finds every one of those already in hand. Everything here is
// fire-and-forget and failure-tolerant: a prewarm that fails changes
// nothing — the trade path still does the work itself, as before.

import * as netAgent from '../system/netAgent';
import * as jitoTips from './jitoTips';
import * as confirmSocket from './confirmSocket';
import { primeBlockhash, primeGlobal } from './txBuilder';
import { prewarmAlts, HELIUS_SENDER_URL, JITO_SEND_URL } from './broadcast';
import { prewarmFeeRecipients } from './liveSigner';

export interface PrewarmTargets {
  httpUrl: string;
  /** WebSocket the confirmation socket should sit on. */
  wssUrl: string;
  useJito: boolean;
  useHeliusSender: boolean;
  /** Relayer host is only worth warming while it is a live route. */
  useRelayer: boolean;
  /** Engine hook: re-read the trading wallet's balance (shared cache + status). */
  refreshBalance?: () => Promise<void>;
}

const HEARTBEAT_MS = 30_000;
const RELAYER_ORIGIN = 'https://pumpportal.fun/api/trade-local';
const HEALTH = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'getHealth' });

let timer: NodeJS.Timeout | null = null;
let getTargets: (() => PrewarmTargets | null) | null = null;
let inFlight = false;

async function once(): Promise<void> {
  if (inFlight || !getTargets) return;
  const t = getTargets();
  if (!t) return;
  inFlight = true;
  try {
    const jobs: Array<Promise<unknown>> = [
      // Sockets: the RPC (every hop), then each enabled lane.
      netAgent.warm(t.httpUrl, HEALTH),
      t.useHeliusSender ? netAgent.warm(HELIUS_SENDER_URL, HEALTH) : Promise.resolve(),
      t.useJito ? netAgent.warm(JITO_SEND_URL, HEALTH) : Promise.resolve(),
      // A GET to the relayer route 4xxs, which is fine — the TLS session stays.
      t.useRelayer ? netAgent.warm(RELAYER_ORIGIN) : Promise.resolve(),
      // Data the build/injection would otherwise fetch inline.
      primeBlockhash(t.httpUrl),
      primeGlobal(t.httpUrl),
      prewarmAlts(t.httpUrl),
      prewarmFeeRecipients(t.httpUrl),
      t.useJito ? jitoTips.refresh() : Promise.resolve(),
      t.refreshBalance ? t.refreshBalance() : Promise.resolve(),
    ];
    confirmSocket.ensure(t.wssUrl);
    await Promise.allSettled(jobs);
  } finally {
    inFlight = false;
  }
}

/** Start warming now and keep it warm on a heartbeat until stop(). */
export function start(targets: () => PrewarmTargets | null): void {
  getTargets = targets;
  void once();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void once(), HEARTBEAT_MS);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  getTargets = null;
  confirmSocket.close();
}

/** Test seam / one-off (e.g. right before a fan-out). */
export function kick(): void {
  void once();
}
