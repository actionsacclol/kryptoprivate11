// Signature confirmation over one persistent WebSocket.
//
// broadcastAndConfirm used to learn that a trade landed only by polling
// getSignatureStatuses every 400 ms (then every 1 s). A Solana slot is
// ~400 ms, so a tx that landed in one slot was still "unconfirmed" on our
// side for up to a whole poll interval — pure detection latency on every
// fill, and one HTTP round trip per poll while it waited.
//
// `signatureSubscribe` pushes the status the moment the node sees it. This
// module keeps ONE socket open while the engine is armed (prewarm.ts calls
// ensure() on a heartbeat) and multiplexes every subscription over it. The
// poll in broadcast.ts stays as the backstop: a socket that is down, slow,
// or on a lagging node simply means the poll wins that race, exactly as
// before. Nothing here can make a fill later than it was.

import WebSocket from 'ws';

export interface SignatureOutcome {
  /** The chain's error object for a landed-but-reverted tx; null = success. */
  err: unknown;
  slot: number;
}

type Commitment = 'processed' | 'confirmed' | 'finalized';

interface Waiter {
  signature: string;
  commitment: Commitment;
  resolve: (r: SignatureOutcome | null) => void;
  timer: NodeJS.Timeout;
}

let ws: WebSocket | null = null;
let url = '';
let nextId = 1;
let pingTimer: NodeJS.Timeout | null = null;
let lastPongAt = 0;
/** The pong deadline applies only once the server has answered a ping;
 *  a server that never pongs is judged by its traffic instead. */
let everPonged = false;
/** request id → waiter, until the subscribe ack maps it to a subscription id. */
const pendingSubs = new Map<number, Waiter>();
/** subscription id → waiter. */
const active = new Map<number, Waiter>();

const PING_MS = 20_000;
const PONG_DEADLINE_MS = 12_000;

export function isOpen(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

/** Open the socket to `wssUrl` if it is not already open there. Idempotent
 *  and cheap — safe on a heartbeat. */
export function ensure(wssUrl: string): void {
  if (!wssUrl) return;
  if (ws && url === wssUrl && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  close();
  url = wssUrl;
  let sock: WebSocket;
  try {
    // Compression costs a threadpool hop per frame and buys nothing on
    // ~200-byte notifications.
    sock = new WebSocket(wssUrl, { handshakeTimeout: 8_000, perMessageDeflate: false });
  } catch {
    return;
  }
  ws = sock;
  sock.on('open', () => {
    lastPongAt = Date.now();
    everPonged = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (everPonged && Date.now() - lastPongAt > PING_MS + PONG_DEADLINE_MS) {
        // Half-open: the OS may take minutes to notice. We do not.
        try {
          sock.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        sock.ping();
      } catch {
        /* a failed ping surfaces as close/error below */
      }
    }, PING_MS);
    // Subscriptions requested while connecting go out now.
    for (const [id, w] of pendingSubs) send(id, w);
  });
  sock.on('pong', () => {
    everPonged = true;
    lastPongAt = Date.now();
  });
  sock.on('message', (raw) => {
    lastPongAt = Date.now();
    let msg: {
      id?: number;
      result?: number | boolean;
      method?: string;
      params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { err?: unknown } } };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      const w = pendingSubs.get(msg.id);
      pendingSubs.delete(msg.id);
      if (w) active.set(msg.result, w);
      return;
    }
    if (msg.method !== 'signatureNotification') return;
    const subId = msg.params?.subscription;
    if (typeof subId !== 'number') return;
    const w = active.get(subId);
    if (!w) return;
    active.delete(subId);
    clearTimeout(w.timer);
    const v = msg.params?.result?.value;
    w.resolve({ err: v && 'err' in v ? (v.err ?? null) : null, slot: msg.params?.result?.context?.slot ?? 0 });
  });
  const dropAll = (): void => {
    // Every waiter resolves null = "not observed"; the poll decides.
    for (const w of pendingSubs.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    for (const w of active.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    pendingSubs.clear();
    active.clear();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (ws === sock) ws = null;
  };
  sock.on('close', dropAll);
  sock.on('error', () => {
    try {
      sock.terminate();
    } catch {
      /* ignore */
    }
  });
}

export function close(): void {
  const sock = ws;
  ws = null;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  if (sock) {
    try {
      sock.terminate();
    } catch {
      /* ignore */
    }
  }
}

function send(id: number, w: Waiter): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'signatureSubscribe',
        params: [w.signature, { commitment: w.commitment }],
      }),
    );
  } catch {
    pendingSubs.delete(id);
    clearTimeout(w.timer);
    w.resolve(null);
  }
}

/**
 * Resolve when the node reports `signature` at `commitment`, or null when
 * the socket could not tell us within `timeoutMs` (down, reconnecting,
 * subscription refused). Null is NOT "did not land" — the caller's poll
 * remains the authority.
 */
export function waitFor(signature: string, commitment: Commitment, timeoutMs: number): Promise<SignatureOutcome | null> {
  return new Promise((resolve) => {
    if (!ws) {
      resolve(null);
      return;
    }
    const id = nextId++;
    const w: Waiter = {
      signature,
      commitment,
      resolve,
      timer: setTimeout(() => {
        pendingSubs.delete(id);
        for (const [subId, a] of active) if (a === w) active.delete(subId);
        resolve(null);
      }, Math.max(1_000, timeoutMs)),
    };
    pendingSubs.set(id, w);
    if (ws.readyState === WebSocket.OPEN) send(id, w);
    // CONNECTING: the open handler flushes pendingSubs.
  });
}
