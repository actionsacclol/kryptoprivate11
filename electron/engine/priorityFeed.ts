// Priority feed — the fastest socket, spent only on tokens that matter.
//
// ─── The trade this exists to make ────────────────────────────────────
//
// Measured 2026-08-24/25:
//   • Helius delivers 92% of pump events FIRST, a median 150ms ahead of
//     api.mainnet-beta and 578ms ahead of publicnode.
//   • The pump firehose is 780,000 pushes an hour, so pointing Helius at it
//     costs ~21k credits an hour (byte billing) and burns a 1M allowance in
//     about two days.
//
// Both facts are true at once, so the answer is not "which socket" but "which
// SUBSCRIPTION". Discovery — watching every launch — is broad, tolerant of
// 150ms, and stays on the free sockets. The tokens you are actually HOLDING
// are the opposite: a handful of mints, where 150ms is the difference between
// a stop loss filling and chasing the wick.
//
// So this subscribes per-MINT rather than per-program. A held token produces a
// few events a second at most, which is a rounding error against 780k/hour.
//
// ─── One socket, many subscriptions ───────────────────────────────────
//
// `FeedManager` opens a socket per URL and subscribes once, which would mean a
// connection per mint. This keeps ONE Helius connection and issues a
// `logsSubscribe` per mint over it, tracking subscription ids so a mint can be
// dropped the moment the position closes.
//
// ─── Per-mint fill (2026-08-30) ───────────────────────────────────────
//
// Feed insurance for HELD mints only. When a notification for a held mint
// shows a pump Buy/Sell instruction but decodes no trade (the day pump drops
// `emit!`), the engine asks for a fill: `getTransaction(confirmed)` on Helius
// (p50 +101 ms for a just-seen signature), batched ≤10 signatures per
// request and ≤1 request per 100 ms because Helius counts each batch
// element against the 10 rps cap. The trade is decoded from the emit_cpi
// inner instructions and re-injected as a notification with `innerEvents`.
// Never for the firehose — a fill costs a credit, a held mint earns it.

import WebSocket from 'ws';
import type { LogNotification, InnerEvent } from './feed';
import { decodeCpiEventData, PUMP_PROGRAM_ID } from './pumpDecoder';
import { getTransactions, resolveAccountKeys, noteSocketRejection, noteSocketRateLimit, socketParkRemainingMs } from '../chain/rpcClient';
import { base58Decode } from '../chain/base58';

export interface PriorityFeedHost {
  /** Helius websocket URL, or empty when no key is configured. */
  wssUrl(): string;
  /** Helius HTTP URL for fills, or empty when no key is configured. */
  execHttpUrl(): string;
  commitment(): 'processed' | 'confirmed';
  /** Delivered straight into the engine's normal log path. */
  onLogs(n: LogNotification): void;
  /** Fill batches are HTTP calls against the key — bill them. */
  billHttp(calls: number): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

let host: PriorityFeedHost | null = null;
let ws: WebSocket | null = null;
let running = false;
let nextId = 1;
let attempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

/** Mints we want, and the live subscription id for each once confirmed. */
const wanted = new Map<string, number | null>();
/** Pending request id → mint, so a subscribe reply can be matched up. */
const pending = new Map<number, string>();
/** Events delivered. */
let events = 0;
/** Uncompressed bytes received — billed against the Helius budget by the
 *  engine (2 credits / 0.1 MB). */
let bytes = 0;

export function attach(h: PriorityFeedHost): void {
  host = h;
}

export function eventCount(): number {
  return events;
}

export function byteCount(): number {
  return bytes;
}

export function watchedMints(): string[] {
  return [...wanted.keys()];
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

/** Start following a mint on the fast socket. Cheap and idempotent. */
export function watch(mint: string): void {
  if (!host || !mint || wanted.has(mint)) return;
  wanted.set(mint, null);
  if (!running) start();
  else subscribe(mint);
}

export function unwatch(mint: string): void {
  const id = wanted.get(mint);
  wanted.delete(mint);
  if (id != null && ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [id] }));
    } catch {
      /* the socket is going away anyway */
    }
  }
  // Nothing left worth paying for.
  if (!wanted.size) stop();
}

export function stop(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  // Re-learned on the next socket: the ceiling belonged to that connection.
  observedSubCap = null;
  pending.clear();
  for (const mint of wanted.keys()) wanted.set(mint, null);
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
  stopFills();
}

function start(): void {
  if (running || !host) return;
  const url = host.wssUrl();
  // No key, no priority feed — the free sockets already carry these mints via
  // the program firehose, just later. Degrading is the correct behaviour.
  if (!url) return;
  running = true;
  connect();
}

function connect(): void {
  if (!running || !host) return;
  const url = host.wssUrl();
  if (!url) {
    running = false;
    return;
  }
  // The host refused a handshake with 429 recently (any socket class): wait
  // the park out rather than add another handshake to the storm.
  const parked = socketParkRemainingMs(url);
  if (parked > 0) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, parked + Math.random() * 1_000);
    return;
  }
  currentUrl = url;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false });
  } catch (err) {
    scheduleReconnect((err as Error)?.message ?? 'socket failed');
    return;
  }
  ws = sock;

  // Liveness. A half-open TCP on the held-mint lane used to sit blind until
  // the OS noticed. We ping every 15 s — but the pong DEADLINE is enforced
  // only once this socket has answered a ping at least once: a server that
  // never pongs (a CDN-fronted one may not) must not be killed on silence,
  // and inbound traffic is proof of life anyway. 2026-09-03: an unconditional
  // deadline re-opened this socket every ~25 s against Helius, and the
  // handshake storm ended in 429s on the whole key.
  let lastAlive = Date.now();
  let everPonged = false;
  let pingTimer: NodeJS.Timeout | null = null;
  const stopPing = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };
  sock.on('pong', () => {
    everPonged = true;
    lastAlive = Date.now();
  });

  sock.on('open', () => {
    // NOT `attempts = 0` here: an endpoint that accepts and then drops would
    // be redialled at 2 s forever. The first ack or notification resets it.
    lastAlive = Date.now();
    pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (everPonged && Date.now() - lastAlive > 25_000) {
        try {
          sock.terminate();
        } catch {
          /* close handler reconnects */
        }
        return;
      }
      try {
        sock.ping();
      } catch {
        /* surfaces as close/error */
      }
    }, 15_000);
    host?.log('info', `priority feed connected (${wanted.size} mint(s) on the fast socket)`);
    for (const mint of wanted.keys()) subscribe(mint);
  });

  sock.on('message', (raw) => {
    lastAlive = Date.now();
    bytes += Buffer.isBuffer(raw) ? raw.length : String(raw).length;
    let msg: {
      id?: number;
      result?: number;
      error?: { code?: number; message?: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { signature?: string; logs?: string[]; err?: unknown }; context?: { slot?: number } } };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // A rejected subscribe ("Too many subscriptions" is the realistic one)
    // used to vanish: the mint sat in `wanted` with no id, no retry and no
    // line in the log. Say so; the mint stays on the slower public pool.
    if (typeof msg.id === 'number' && msg.error) {
      const mint = pending.get(msg.id);
      pending.delete(msg.id);
      const text = msg.error.message ?? 'no reason given';
      // If the host really does have a per-socket ceiling, this is where we
      // find out what it is — learn the number instead of assuming one.
      if (/too many|limit/i.test(text)) observedSubCap = Math.max(1, subCount());
      host?.log('warn', `priority feed: subscribe rejected for ${mint ? `${mint.slice(0, 8)}…` : 'a mint'} — ${text}; it stays on the public pool`);
      return;
    }

    // Subscription confirmation: remember the id so we can unsubscribe later.
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      attempts = 0;
      const mint = pending.get(msg.id);
      pending.delete(msg.id);
      if (mint && wanted.has(mint)) wanted.set(mint, msg.result);
      return;
    }

    if (msg.method !== 'logsNotification') return;
    const value = msg.params?.result?.value;
    if (!value?.signature || !Array.isArray(value.logs)) return;
    attempts = 0;
    events += 1;
    // Straight into the engine's normal path. The engine dedupes by signature
    // across every feed, so an event arriving here first simply means the
    // slower copy from the public pool is discarded a moment later.
    host?.onLogs({
      signature: value.signature,
      slot: msg.params?.result?.context?.slot ?? 0,
      logs: value.logs,
      receivedAt: Date.now(),
      // Named distinctly so the feed-health panel shows when the fast socket
      // is the one winning the race for a held token.
      provider: 'helius:priority',
    });
  });

  sock.on('close', () => {
    stopPing();
    if (ws === sock) scheduleReconnect('socket closed');
  });
  sock.on('error', (err) => {
    stopPing();
    const why = (err as Error)?.message ?? 'socket error';
    // A handshake refused for credentials will be refused every time. Say so
    // once; the url picker then stops offering the keyed socket, instead of
    // reconnect-looping against a key the endpoint has already turned down.
    noteSocketRejection(url, why);
    noteSocketRateLimit(url, why);
    if (ws === sock) scheduleReconnect(why);
  });
}

/** The url the live socket was dialled with — for the subscription guard. */
let currentUrl = '';
/**
 * There is no ten-subscription ceiling. Until 2026-09-09 this file said there
 * was, citing `x-ratelimit-pubsub-limit: 10` on api.mainnet-beta.solana.com.
 *
 * MEASURED 2026-09-09: that header counts pubsub CONNECTIONS per IP, not
 * subscriptions per connection. Three independent observations —
 *   • the header decrements once per socket opened (10 → 9 → 8), not per
 *     subscribe;
 *   • 16 `logsSubscribe` frames on ONE socket were all acked;
 *   • connections 11, 12 and 13 were refused with HTTP 429 at the handshake.
 * So the scarce resource is the socket this module already shares, and the
 * old cap silently unsubscribed held mints (and, in walletWatcher.ts, copy
 * leaders) to respect a limit the host does not have.
 *
 * 16 is what was actually verified, so this is a guard, not a claim: four
 * times the proven number, far above any realistic held-mint count, and there
 * only to stop a runaway loop from firing thousands of frames. If the host
 * ever does refuse a subscribe for volume, `observedSubCap` below records the
 * count it refused at and THAT becomes the ceiling — a number we watched
 * happen rather than one we guessed.
 */
const VERIFIED_SUBS_PER_SOCKET = 16;
const SUB_GUARD = 64;
/** Live subscriptions this socket refused to go past, once observed. */
let observedSubCap: number | null = null;
let capNotedAt = 0;
const keyed = (u: string): boolean => /api-key=|[?&]token=/i.test(u);

/** Live + in-flight subscriptions on the current socket. */
function subCount(): number {
  return [...wanted.values()].filter((v) => v !== null).length + pending.size;
}

/** Test seam / diagnostics: mints with a confirmed subscription id. */
export function subscribedMints(): string[] {
  return [...wanted.entries()].filter(([, id]) => id !== null).map(([m]) => m);
}

function subscribe(mint: string): void {
  if (ws?.readyState !== WebSocket.OPEN || !host) return;
  if (!keyed(currentUrl)) {
    const live = subCount();
    const ceiling = observedSubCap ?? SUB_GUARD;
    if (live >= ceiling) {
      if (Date.now() - capNotedAt > 60_000) {
        capNotedAt = Date.now();
        host.log(
          'info',
          observedSubCap === null
            ? `priority feed: holding at ${SUB_GUARD} live subscriptions on one socket — ${mint.slice(0, 8)}… stays on the program firehose (still covered, about 150 ms slower)`
            : `priority feed: this socket refused a subscribe past ${observedSubCap} (${VERIFIED_SUBS_PER_SOCKET} were verified to work) — ${mint.slice(0, 8)}… stays on the program firehose (still covered, about 150 ms slower)`,
        );
      }
      return;
    }
  }
  const id = nextId++;
  pending.set(id, mint);
  try {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [{ mentions: [mint] }, { commitment: host.commitment() }],
      }),
    );
  } catch {
    pending.delete(id);
  }
}

function scheduleReconnect(why: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!running) return;
  attempts += 1;
  if (attempts === 1) host?.log('warn', `priority feed: ${why}; reconnecting`);
  reconnectTimer = setTimeout(connect, reconnectDelayMs(attempts));
}

/**
 * Backoff with ±25% jitter, like every other socket class in the app. Until
 * 2026-09-09 this lane was the only one that redialled on a round number:
 * after a suspend/resume or a host blip every socket comes back at the same
 * instant, and the pubsub CONNECTION cap (10 per IP on the public host, the
 * app's worst case is exactly 10) turns a synchronised redial into a 429 at
 * the handshake — which parks the whole host, for every socket class, for 30 s.
 */
export function reconnectDelayMs(n: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

// ── Per-mint fill ───────────────────────────────────────────────────────

export const FILL_BATCH_MAX = 10;
export const FILL_BATCH_INTERVAL_MS = 100;
/** A just-seen signature may not be confirmed yet; try a few times. */
const FILL_MAX_ATTEMPTS = 3;
const FILL_RETRY_MS = 500;
const FILL_QUEUE_CAP = 200;

/** Signatures waiting for the next batch, with how often each was tried. */
const fillQueue = new Map<string, number>();
let fillTimer: NodeJS.Timeout | null = null;
let fillInFlight = false;
let fillsRequested = 0;
let fillsDecoded = 0;

export function fillStats(): { requested: number; decoded: number; queued: number } {
  return { requested: fillsRequested, decoded: fillsDecoded, queued: fillQueue.size };
}

/**
 * Ask for the emit_cpi events of a transaction whose logs decoded no trade.
 * No-op without a Helius key: the block feed is the keyless standby. The
 * caller guarantees this is a HELD mint's transaction — never the firehose.
 */
export function requestFill(signature: string): void {
  if (!host || !signature || !host.execHttpUrl()) return;
  if (fillQueue.has(signature)) return;
  if (fillQueue.size >= FILL_QUEUE_CAP) return;
  fillQueue.set(signature, 0);
  fillsRequested += 1;
  armFillTimer();
}

function armFillTimer(): void {
  if (fillTimer) return;
  fillTimer = setTimeout(() => {
    fillTimer = null;
    void runFillBatch();
  }, FILL_BATCH_INTERVAL_MS);
}

function stopFills(): void {
  if (fillTimer) clearTimeout(fillTimer);
  fillTimer = null;
  fillQueue.clear();
}

async function runFillBatch(): Promise<void> {
  if (fillInFlight || !host) {
    if (fillQueue.size) armFillTimer();
    return;
  }
  const url = host.execHttpUrl();
  if (!url) {
    fillQueue.clear();
    return;
  }
  const sigs = [...fillQueue.keys()].slice(0, FILL_BATCH_MAX);
  if (sigs.length === 0) return;
  for (const s of sigs) fillQueue.delete(s);
  fillInFlight = true;
  try {
    host.billHttp(sigs.length);
    const r = await getTransactions(url, sigs);
    const now = Date.now();
    sigs.forEach((sig, i) => {
      const tx = r.ok ? (r.data?.[i] ?? null) : null;
      if (!tx) {
        // Not confirmed yet (or a transient failure): retry a little later.
        const tried = (fillQueue.get(sig) ?? 0) + 1;
        if (tried < FILL_MAX_ATTEMPTS) setTimeout(() => {
          if (!host || fillQueue.has(sig)) return;
          fillQueue.set(sig, tried);
          armFillTimer();
        }, FILL_RETRY_MS);
        return;
      }
      if (tx.meta?.err) return;
      const innerEvents = innerPumpEvents(tx);
      if (innerEvents.length === 0) return;
      fillsDecoded += 1;
      host?.onLogs({
        signature: sig,
        slot: (tx as { slot?: number }).slot ?? 0,
        logs: tx.meta?.logMessages ?? [],
        receivedAt: now,
        provider: 'helius:fill',
        innerEvents,
      });
    });
  } finally {
    fillInFlight = false;
    if (fillQueue.size) armFillTimer();
  }
}

/** Test seam. */
export function _reset(): void {
  stop();
  wanted.clear();
  events = 0;
  bytes = 0;
  attempts = 0;
  currentUrl = '';
  capNotedAt = 0;
  fillsRequested = 0;
  fillsDecoded = 0;
}

/** Pump events from a transaction's emit_cpi inner instructions. */
function innerPumpEvents(tx: Parameters<typeof resolveAccountKeys>[0]): InnerEvent[] {
  const keys = resolveAccountKeys(tx);
  const out: InnerEvent[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PUMP_PROGRAM_ID) continue;
      let data: Buffer;
      try {
        data = Buffer.from(base58Decode(ix.data));
      } catch {
        continue;
      }
      const ev = decodeCpiEventData(data);
      if (ev) out.push(ev);
    }
  }
  return out;
}
