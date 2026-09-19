// Wallet watcher — one `logsSubscribe` per FOLLOWED WALLET on the live
// socket, so copy trading sees a leader wherever it trades.
//
// Until 2026-09-06 a followed wallet was only ever noticed on the pump.fun
// curve firehose: a leader that trades through Jupiter into Raydium,
// Meteora or Orca was "followed" and nothing ever happened. This module
// subscribes to the wallet itself (`mentions: [wallet]`), so every
// transaction it signs arrives as a signature; the transaction is read once
// and its swap decoded from the wallet's own balance deltas (walletSwap.ts)
// — no per-DEX decoders, and the same for every router and pool.
//
// Same socket rules as the priority feed, learned the hard way: the pong
// deadline is enforced only after a first pong and inbound frames count as
// life; a handshake 429 parks the host for every socket class; reconnect
// backoff resets on an ack or a notification, never on a bare open.
//
// 2026-09-09: the "public socket allows ten subscriptions" rule that used to
// live here was wrong and cost users leaders. `x-ratelimit-pubsub-limit: 10`
// is 10 pubsub CONNECTIONS per IP — 16 subscriptions on one socket were all
// acked. What is scarce is the socket, and this module opens exactly one. A
// wallet is only marked `over-cap` if the host itself refuses the subscribe.
//
// Independent of the scanner: paper copying costs nothing and should work
// with the launch feed stopped, so this runs whenever a config is enabled.

import WebSocket from 'ws';
import type { CopyWatchStatus } from '@shared/copytrade';
import { getSignaturesForAddress, getTransaction, noteSocketRejection, noteSocketRateLimit, socketParkRemainingMs } from '../chain/rpcClient';
import { decodeWalletSwap, type WalletSwap } from './walletSwap';

export interface WalletWatcherHost {
  /** Socket to subscribe on; empty means the watcher cannot run. */
  wssUrl(): string;
  /** HTTP endpoint the leader's transactions are read from. */
  httpUrl(): string;
  onSwap(ev: { wallet: string; swap: WalletSwap; signature: string; at: number; tradeAt: number | null }): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface WalletStats {
  lastSeenAt: number | null;
  lastSwapAt: number | null;
  seen: number;
  swaps: number;
  overCap: boolean;
  /** A subscription for this wallet has been acked at least once THIS
   *  process. Only then is a reconnect a gap worth filling — on the first
   *  subscribe of a session there is nothing to have missed, and replaying
   *  a leader's last half hour into their record would double-count it. */
  subscribed: boolean;
  /** When a catch-up last ran, so the heartbeat can round-robin. */
  recoveredAt: number;
}

/**
 * There is no ten-wallet ceiling — see the header note. This is a runaway
 * guard, not a limit we claim the host has.
 *
 * MEASURED 2026-09-09: `x-ratelimit-pubsub-limit: 10` on
 * api.mainnet-beta.solana.com counts pubsub CONNECTIONS per IP, not
 * subscriptions per connection. The header decrements once per socket opened,
 * 16 `logsSubscribe` frames on ONE socket were all acked, and connections 11,
 * 12 and 13 were refused with HTTP 429 at the handshake. Following 14 leaders
 * left four of them silently unwatched for a limit that does not exist.
 *
 * 16 is the verified number, so the guard sits at 64 — well past any real
 * follow list. If the host ever refuses a subscribe for volume, the count it
 * refused at is recorded in `observedSubCap` and becomes the ceiling.
 */
const VERIFIED_SUBS_PER_SOCKET = 16;
const SUB_GUARD = 64;
/** Live subscriptions this socket refused to go past, once observed. */
let observedSubCap: number | null = null;
const PING_MS = 15_000;
const SILENCE_MS = 25_000;
/**
 * How hard a followed wallet's transaction is chased before it is given up
 * on.
 *
 * It used to be three tries 700 ms apart — about two seconds — and a give-up
 * was SILENT. On a rate-limited public endpoint (the default; `rpcClient`
 * parks a host that 429s) two seconds is nothing, and every transaction lost
 * that way is a leader trade the copier never acts on: an exit that never
 * fires reads to the user as a position that "sold late" whenever something
 * else eventually closes it (report, 2026-09-15). This is an exit decision,
 * so it is worth tens of seconds and a line in the log when it fails.
 */
const FETCH_ATTEMPTS = 6;
const FETCH_RETRY_MS = 700;
const FETCH_RETRY_MAX_MS = 8_000;
const SEEN_CAP = 2_000;

// ── Catch-up ──────────────────────────────────────────────────────────
//
// `logsSubscribe` is live-only: whatever a wallet does while the socket is
// down is never delivered, and nothing here used to ask for it afterwards.
// A reconnect costs a backoff of up to 30 s, far longer when the host is
// parked — and a leader's exit inside that window was simply never seen. The
// position then stayed open until the leader happened to sell again, which
// is exactly the "eventually sold, 1 h 28 m late" shape of the report.
//
// So after a gap, and on a slow round-robin heartbeat (a subscription can
// also go quietly dead while the socket stays open), the wallet's recent
// signatures are read and anything unseen is put through the same decode
// path. `seen` dedupes it against the live feed, and copyTrade applies its
// own staleness rules to whatever comes out — a recovered BUY is refused for
// age, a recovered SELL fires only while the instruction is still current.

/** Signatures a catch-up asks for. Two minutes of a busy wallet. */
const RECOVER_LIMIT = 25;
/** Nothing older than this is replayed, whatever the gap was. */
const RECOVER_WINDOW_MS = 30 * 60_000;
/** One wallet per tick, so following ten leaders costs one read a minute. */
const RECOVER_TICK_MS = 60_000;
/** A live subscription is still re-checked this often, in case it is dead. */
const RECOVER_EVERY_MS = 5 * 60_000;

let host: WalletWatcherHost | null = null;
let ws: WebSocket | null = null;
let running = false;
let nextId = 1;
let attempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let recoverTimer: NodeJS.Timeout | null = null;
let currentUrl = '';
let capNotedAt = 0;

/** Followed wallet → live subscription id (null until acked). */
const wanted = new Map<string, number | null>();
/** Pending request id → wallet. */
const pending = new Map<number, string>();
/** Subscription id → wallet, for routing notifications. */
const bySub = new Map<number, string>();
const stats = new Map<string, WalletStats>();
/** Signatures already handled; a socket reconnect can replay one. */
const seen = new Set<string>();

const keyed = (u: string): boolean => /api-key=|[?&]token=/i.test(u);

export function attach(h: WalletWatcherHost): void {
  host = h;
}

function statsFor(wallet: string): WalletStats {
  let s = stats.get(wallet);
  if (!s) {
    s = { lastSeenAt: null, lastSwapAt: null, seen: 0, swaps: 0, overCap: false, subscribed: false, recoveredAt: 0 };
    stats.set(wallet, s);
  }
  return s;
}

/** Follow exactly these wallets: new ones are subscribed, dropped ones
 *  unsubscribed, and the socket closes when none remain. Idempotent. */
export function setWallets(wallets: string[]): void {
  const want = new Set(wallets.filter(Boolean));
  for (const w of [...wanted.keys()]) if (!want.has(w)) unwatch(w);
  for (const w of want) if (!wanted.has(w)) watch(w);
}

export function watchedWallets(): string[] {
  return [...wanted.keys()];
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

export function status(): Record<string, CopyWatchStatus> {
  const out: Record<string, CopyWatchStatus> = {};
  for (const [wallet, id] of wanted) {
    const s = statsFor(wallet);
    out[wallet] = {
      state: !running ? 'off' : s.overCap ? 'over-cap' : id !== null ? 'watching' : 'connecting',
      lastSeenAt: s.lastSeenAt,
      lastSwapAt: s.lastSwapAt,
      seen: s.seen,
      swaps: s.swaps,
    };
  }
  return out;
}

function watch(wallet: string): void {
  if (!host || !wallet || wanted.has(wallet)) return;
  wanted.set(wallet, null);
  statsFor(wallet);
  if (!running) start();
  else subscribe(wallet);
}

function unwatch(wallet: string): void {
  const id = wanted.get(wallet);
  wanted.delete(wallet);
  stats.delete(wallet);
  if (id != null) {
    bySub.delete(id);
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'logsUnsubscribe', params: [id] }));
      } catch {
        /* the socket is going away anyway */
      }
    }
  }
  if (!wanted.size) stop();
}

export function stop(): void {
  running = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (recoverTimer) clearInterval(recoverTimer);
  recoverTimer = null;
  // Re-learned on the next socket: the ceiling belonged to that connection.
  observedSubCap = null;
  pending.clear();
  bySub.clear();
  for (const w of wanted.keys()) wanted.set(w, null);
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
}

function start(): void {
  if (running || !host) return;
  const url = host.wssUrl();
  if (!url) {
    host.log('warn', 'wallet watcher: no websocket endpoint is configured, so followed wallets cannot be watched');
    return;
  }
  running = true;
  attempts = 0;
  if (!recoverTimer) recoverTimer = setInterval(recoverTick, RECOVER_TICK_MS);
  connect();
}

function connect(): void {
  if (!running || !host) return;
  const url = host.wssUrl();
  if (!url) {
    running = false;
    return;
  }
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
    lastAlive = Date.now();
    pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (everPonged && Date.now() - lastAlive > SILENCE_MS) {
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
    }, PING_MS);
    for (const s of stats.values()) s.overCap = false;
    for (const wallet of wanted.keys()) subscribe(wallet);
  });

  sock.on('message', (raw) => {
    lastAlive = Date.now();
    let msg: {
      id?: number;
      result?: number | boolean;
      error?: { code?: number; message?: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown; logs?: string[] }; context?: { slot?: number } } };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && msg.error) {
      const wallet = pending.get(msg.id);
      pending.delete(msg.id);
      const text = msg.error.message ?? 'no reason given';
      if (wallet) {
        if (/too many|limit/i.test(text)) {
          statsFor(wallet).overCap = true;
          // Learn the real per-socket ceiling from the host rather than
          // assuming one: this many were accepted, the next was not.
          observedSubCap = Math.max(1, subCount());
        }
        host?.log('warn', `wallet watcher: subscribe rejected for ${wallet.slice(0, 6)}… — ${text}`);
      }
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      attempts = 0;
      const wallet = pending.get(msg.id);
      pending.delete(msg.id);
      if (wallet && wanted.has(wallet)) {
        wanted.set(wallet, msg.result);
        bySub.set(msg.result, wallet);
        const st = statsFor(wallet);
        // A resubscribe means the last one stopped, and whatever the wallet
        // did in between was never delivered. The FIRST subscribe of a
        // session has no gap behind it.
        if (st.subscribed) void recoverGap(wallet, 'the subscription was re-established');
        st.subscribed = true;
      }
      return;
    }
    if (msg.method !== 'logsNotification') return;
    attempts = 0;
    const sub = msg.params?.subscription;
    const value = msg.params?.result?.value;
    if (typeof sub !== 'number' || !value?.signature) return;
    const wallet = bySub.get(sub);
    if (!wallet || !wanted.has(wallet)) return;
    void onNotification(wallet, value.signature, value.err);
  });

  sock.on('close', () => {
    stopPing();
    if (ws === sock) scheduleReconnect('socket closed');
  });
  sock.on('error', (err) => {
    stopPing();
    const why = (err as Error)?.message ?? 'socket error';
    noteSocketRejection(url, why);
    noteSocketRateLimit(url, why);
    if (ws === sock) scheduleReconnect(why);
  });
}

/** Live + in-flight subscriptions on the current socket. */
function subCount(): number {
  return [...wanted.values()].filter((v) => v !== null).length + pending.size;
}

function subscribe(wallet: string): void {
  if (ws?.readyState !== WebSocket.OPEN || !host) return;
  if (!keyed(currentUrl)) {
    const live = subCount();
    const ceiling = observedSubCap ?? SUB_GUARD;
    if (live >= ceiling) {
      statsFor(wallet).overCap = true;
      if (Date.now() - capNotedAt > 60_000) {
        capNotedAt = Date.now();
        host.log(
          'warn',
          observedSubCap === null
            ? `wallet watcher: holding at ${SUB_GUARD} wallet subscriptions on one socket — ${wallet.slice(0, 6)}… is not watched; unfollow someone to make room`
            : `wallet watcher: this socket refused a subscribe past ${observedSubCap} followed wallets (${VERIFIED_SUBS_PER_SOCKET} were verified to work) — ${wallet.slice(0, 6)}… is not watched`,
        );
      }
      return;
    }
  }
  const id = nextId++;
  pending.set(id, wallet);
  try {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        // Confirmed, not processed: the transaction is read back at
        // confirmed, and a processed notification would only be asked for
        // before it can be answered.
        params: [{ mentions: [wallet] }, { commitment: 'confirmed' }],
      }),
    );
  } catch {
    pending.delete(id);
  }
}

function remember(signature: string): boolean {
  if (seen.has(signature)) return false;
  seen.add(signature);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

async function onNotification(wallet: string, signature: string, err: unknown, recovered = false): Promise<void> {
  const h = host;
  if (!h) return;
  const s = statsFor(wallet);
  if (!recovered) {
    s.seen += 1;
    s.lastSeenAt = Date.now();
  }
  if (err) return;
  if (!remember(signature)) return;
  // A just-confirmed transaction can take a beat to be readable, and a
  // rate-limited host can take a great deal longer than a beat.
  let why = 'not readable';
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (!wanted.has(wallet)) return;
    const res = await getTransaction(h.httpUrl(), signature);
    if (res.ok && res.data) {
      const swap = decodeWalletSwap(res.data, wallet);
      if (!swap) return;
      s.swaps += 1;
      s.lastSwapAt = Date.now();
      // WHEN THEY TRADED, not when we read it. A recovered transaction can
      // be many minutes old, and the copier decides what to do about that.
      const blockTime = res.data.blockTime;
      h.onSwap({
        wallet,
        swap,
        signature,
        at: Date.now(),
        tradeAt: typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : null,
      });
      return;
    }
    why = res.ok ? 'the node does not have it yet' : res.message;
    // Backoff, capped: a parked host is not helped by six fast retries, and
    // `rpcClient` already waits out its own park inside the call.
    await new Promise((r) => setTimeout(r, Math.min(FETCH_RETRY_MAX_MS, FETCH_RETRY_MS * 2 ** attempt)));
  }
  // Silence here was the bug: a leader trade that is KNOWN to have happened
  // and could not be read is a copy that will not fire, and the user had no
  // way to know it. It stays in `seen`, so a later catch-up will not re-chase
  // a transaction this endpoint cannot serve.
  h.log('warn', `wallet watcher: could not read ${wallet.slice(0, 6)}…'s transaction ${signature.slice(0, 8)}… — ${why}. That trade was not copied.`);
}

/**
 * Read what a followed wallet did recently and put anything unseen through
 * the live path.
 *
 * Bounded three ways: at most `RECOVER_LIMIT` signatures, nothing older than
 * `RECOVER_WINDOW_MS`, and everything already in `seen` dropped before a
 * single transaction is fetched. Oldest first, so a buy and the sell that
 * followed it arrive in the order they happened.
 */
async function recoverGap(wallet: string, why: string): Promise<void> {
  const h = host;
  if (!h || !wanted.has(wallet)) return;
  const s = statsFor(wallet);
  s.recoveredAt = Date.now();
  const res = await getSignaturesForAddress(h.httpUrl(), wallet, RECOVER_LIMIT);
  if (!res.ok || !res.data) {
    h.log('warn', `wallet watcher: could not catch up on ${wallet.slice(0, 6)}… (${why}) — ${res.message}`);
    return;
  }
  const floor = Date.now() - RECOVER_WINDOW_MS;
  const missed = res.data
    .filter((x) => !x.err && !seen.has(x.signature))
    .filter((x) => typeof x.blockTime !== 'number' || x.blockTime * 1_000 >= floor)
    .reverse();
  if (!missed.length) return;
  h.log('info', `wallet watcher: catching up on ${missed.length} transaction(s) from ${wallet.slice(0, 6)}… (${why})`);
  for (const x of missed) {
    if (!wanted.has(wallet)) return;
    await onNotification(wallet, x.signature, x.err, true);
  }
}

/**
 * One wallet per tick, least recently checked first.
 *
 * A live subscription can stop delivering while the socket stays open and
 * every health check passes — there is no ack for "you are still getting my
 * notifications". This is the cheap standing answer to that: following ten
 * leaders costs one `getSignaturesForAddress` a minute, and each wallet is
 * re-checked every `RECOVER_EVERY_MS`.
 */
function recoverTick(): void {
  if (!running || ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [wallet, id] of wanted) {
    if (id === null) continue;
    const at = statsFor(wallet).recoveredAt;
    if (now - at < RECOVER_EVERY_MS) continue;
    if (at < oldestAt) {
      oldestAt = at;
      oldest = wallet;
    }
  }
  if (oldest) void recoverGap(oldest, 'routine check that nothing was missed');
}

function scheduleReconnect(why: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (!running) return;
  pending.clear();
  bySub.clear();
  for (const w of wanted.keys()) wanted.set(w, null);
  attempts += 1;
  if (attempts === 1) host?.log('warn', `wallet watcher: ${why}; reconnecting`);
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
  reconnectTimer = setTimeout(connect, Math.round(base * (0.75 + Math.random() * 0.5)));
}

/** Test seam. */
export function _reset(): void {
  stop();
  wanted.clear();
  stats.clear();
  seen.clear();
  attempts = 0;
  currentUrl = '';
  capNotedAt = 0;
  observedSubCap = null;
}
