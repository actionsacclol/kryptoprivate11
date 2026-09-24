// Solana WebSocket feed manager — a RACING POOL of logsSubscribe sockets,
// plus a blockSubscribe STANDBY that decodes emit_cpi inner instructions.
//
// Research §1 / edge-speed plan #4h, promoted to default after the 2026-07-21
// tape analysis measured ~20% silent event loss on a single public websocket
// under firehose load. N endpoints subscribe in parallel, every notification
// routes through one shared signature deduper, and the earliest arrival wins.
// An event is lost only if EVERY socket drops it, so redundancy attacks the
// loss rate directly — and per-provider jitter (50–150ms) shrinks to
// min(provider latency) for free.
//
// ─── Feed insurance (2026-08-30) ──────────────────────────────────────
//
// Pump emits every trade twice today: as a `Program data:` log (`emit!`) and
// as a self-CPI inner instruction (`emit_cpi!`). The log sockets decode 99.9%
// of trades. The risk is the day `emit!` goes — Anchor's stated reason for
// emit_cpi — when every log socket would keep delivering notifications that
// decode to nothing. `BlockFeedSocket` is the standby for that day: a
// `blockSubscribe` on the one free host that accepts it (publicnode,
// confirmed only, ~189 blocks/min, +196 ms p50 behind processed logs) whose
// transactions carry the inner instructions. It enters the SAME dedupe, so
// while the logs decode it loses every race and costs nothing but bandwidth;
// the moment they stop decoding, its copies are the ones that pass.
//
// Per-socket: auto-reconnect with backoff, ping health checks, subscription
// restoration. The {onLogs,onState} callback contract is unchanged so a
// Yellowstone gRPC adapter can still slot in behind it later.

import WebSocket from 'ws';
import { PUMP_PROGRAM_ID, type PumpEvent } from './pumpDecoder';
import type { AmmEvent } from './ammDecoder';
import { base58Decode } from '../chain/base58';
import { noteSocketRejection, noteSocketRateLimit, socketParkRemainingMs, parseWireTransaction, resolveAccountKeys, type RawIx, MAX_SUPPORTED_TX_VERSION } from '../chain/rpcClient';
import type { FeedSocketStatus, FeedState } from '@shared/types';

/** An event decoded from an emit_cpi inner instruction rather than a log. */
export type InnerEvent = PumpEvent | AmmEvent;

export interface LogNotification {
  signature: string;
  slot: number;
  logs: string[];
  /** Local arrival timestamp (ms). Without this, latency is unknowable. */
  receivedAt: number;
  /** Host of the socket that delivered this event first. */
  provider: string;
  /**
   * Events already decoded from the transaction's emit_cpi inner
   * instructions (block feed, per-mint getTransaction fill). When present
   * the consumer uses THESE and does not decode `logs` — a tx in the
   * double-emit transition carries the same trade in both places, so
   * combining the two sources would double count. Prefer CPI, never combine
   * (same rule as txBuilder.extractSample).
   */
  innerEvents?: InnerEvent[];
}

export interface FeedCallbacks {
  onLogs: (n: LogNotification) => void;
  onState: (state: FeedState, detail: string) => void;
  /** The server answered our subscribe with a JSON-RPC error ("Too many
   *  subscriptions", rate-limit, invalid params). The socket reconnects on
   *  its own; this exists so callers can log the server's message loudly. */
  onSubscribeError?: (host: string, message: string) => void;
}

/** Timing knobs — production defaults; tests inject small values. */
export interface FeedTiming {
  /** First reconnect delay; doubles per attempt up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** A socket open this long without dropping counts as healthy: its backoff
   *  resets. (A notification alone does not — see the message handler.) */
  backoffResetAfterMs?: number;
  /** No subscribe ack AND no notification within this window → reconnect. */
  subscribeAckTimeoutMs?: number;
  /**
   * Where the reconnect jitter comes from. Production leaves it alone.
   *
   * It is injectable for the same reason `pickThesis` and `followSize` take a
   * `rand`: a test that wants to assert the BACKOFF cannot also be sampling
   * the jitter. With ±25% on each delay, 100 ms and 200 ms overlap at
   * 125 ms vs 150 ms, so "did the delay grow?" measured off a real clock came
   * down to a 20% margin against whatever the machine was doing — which is a
   * test that fails on a busy laptop and says nothing about the code.
   */
  rnd?: () => number;
}

/** Standby block sockets for a FeedManager. */
export interface BlockFeedOptions {
  /** Hosts to open a blockSubscribe on (one socket each). */
  urls: string[];
  /** Decoder for an inner instruction's raw data on `programId`
   *  (pumpDecoder.decodeCpiEventData / ammDecoder.decodeCpiAmmEventData). */
  decodeInner: (data: Buffer) => InnerEvent | null;
  /**
   * Account the server filters blocks by (`mentionsAccountOrProgram`).
   * Defaults to the program itself. Measured 2026-08-30: publicnode delivers
   * nothing for the pump-amm program id but does for its global-config
   * account, so the amm feed passes that instead.
   */
  mentions?: string;
}

const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const DEFAULT_TIMING: Required<FeedTiming> = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  backoffResetAfterMs: 30_000,
  subscribeAckTimeoutMs: 20_000,
  rnd: Math.random,
};
const SEEN_CAP = 16_384;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Reconnect delay with ±25% jitter so N sockets that were rejected together
 *  do not hammer the endpoint again in lockstep. `rnd` ∈ [0,1). */
export function jitteredDelay(baseMs: number, rnd: number = Math.random()): number {
  return Math.round(baseMs * (0.75 + rnd * 0.5));
}

/** Server message out of a JSON-RPC error object, whatever shape it took. */
function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown };
    const msg = typeof e.message === 'string' ? e.message : JSON.stringify(error);
    return e.code !== undefined ? `${msg} (code ${String(e.code)})` : msg;
  }
  return String(error);
}

/** Bytes in a ws frame payload, whatever container `ws` handed us. */
function frameLength(raw: WebSocket.RawData): number {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0);
  return (raw as ArrayBuffer).byteLength ?? 0;
}

/** What a socket hands the pool: a notification minus the provider tag. */
export type PoolNotification = Omit<LogNotification, 'provider'>;

interface SocketPool {
  onNotification: (s: RpcSocket, n: PoolNotification) => void;
  onSocketState: (s: RpcSocket, detail: string) => void;
  onSubscribeError: (s: RpcSocket, message: string) => void;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: { result?: unknown };
}

/**
 * One websocket subscription with its own reconnect/ping lifecycle. The
 * subscribe request and the notification parser are the only things that
 * differ between a logs socket and a block socket, so those are abstract.
 */
abstract class RpcSocket {
  private ws: WebSocket | null = null;
  private wantRunning = false;
  private backoffMs: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  /** Set once this server has answered a ping; only then is a missing pong evidence of a dead socket. */
  private everPonged = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  /** Id of the subscribe request in flight on the current socket. Bumped
   *  per connect so a late reply from a dead socket can never be mistaken
   *  for the current one. */
  private subReqId = 0;
  /** Server-assigned subscription id once acked (0 = not yet). */
  private subscriptionId = 0;
  protected readonly timing: Required<FeedTiming>;
  state: FeedState = 'stopped';
  /** Notifications delivered by this socket (pre-dedupe). */
  events = 0;
  /** Notifications where this socket was the first to deliver. */
  wins = 0;
  /** CPI-carrying deliveries passed to the consumer AFTER a log copy of the
   *  same signature. The pool cannot tell whether the log copy decoded, so
   *  the consumer decides; the engine's watchdog reads `events`, not this. */
  fills = 0;
  /** Uncompressed bytes received. Helius bills websocket traffic by the
   *  byte (2 credits / 0.1 MB), so this is the billing counter. */
  bytes = 0;
  readonly host: string;
  /** Provider tag stamped on notifications (`host`, or `host:block`). */
  readonly provider: string;

  constructor(
    readonly url: string,
    providerSuffix: string,
    protected pool: SocketPool,
    timing: FeedTiming = {},
  ) {
    this.host = hostOf(url);
    this.provider = providerSuffix ? `${this.host}:${providerSuffix}` : this.host;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.backoffMs = this.timing.initialBackoffMs;
  }

  /** JSON-RPC method + params for the subscription. */
  protected abstract subscribeRequest(): { method: string; params: unknown[] };
  /** The notification method name the server pushes for it. */
  protected abstract notificationMethod(): string;
  /** Parse one notification's `params.result` and hand the pool whatever
   *  it yields (0..n notifications). Runs on the socket thread — cheap. */
  protected abstract handleNotification(result: unknown, receivedAt: number): void;

  start(): void {
    this.wantRunning = true;
    this.connect('connecting');
  }

  stop(): void {
    this.wantRunning = false;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setState('stopped', 'stopped');
  }

  private setState(s: FeedState, detail: string): void {
    this.state = s;
    this.pool.onSocketState(this, detail);
  }

  private connect(as: FeedState): void {
    if (!this.wantRunning) return;
    // The host refused a handshake with 429 recently (any socket class):
    // wait the park out rather than add another handshake to the storm.
    const parked = socketParkRemainingMs(this.url);
    if (parked > 0) {
      this.setState('reconnecting', `${this.host} rate limited handshakes — waiting ${Math.ceil(parked / 1000)}s`);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wantRunning) this.connect(as);
      }, parked + Math.random() * 1_000);
      return;
    }
    this.setState(as, `connecting to ${this.host}`);
    let ws: WebSocket;
    try {
      // perMessageDeflate costs a threadpool inflate per frame, serialised
      // per socket — tens of ms of queueing under a firehose burst, for
      // bandwidth nobody is short of. (Helius bills uncompressed bytes.)
      ws = new WebSocket(this.url, { handshakeTimeout: 10_000, perMessageDeflate: false });
    } catch (err) {
      this.scheduleReconnect(`socket create failed: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;
    this.everPonged = false; // each new socket must earn its pong deadline

    ws.on('open', () => {
      // NOT `live` yet: an open socket only means TCP+handshake. The server
      // can still reject the subscription ("Too many subscriptions", rate
      // limit, invalid params) and a badge that said LIVE with zero events
      // forever was exactly the audited failure. Live = ack or first event.
      //
      // Backoff is deliberately NOT reset here either: an endpoint that
      // accepts and immediately closes would otherwise tight-loop at the
      // initial delay. It resets on a notification or after the socket has
      // stayed open for `backoffResetAfterMs` (see armHealthyTimer).
      const reqId = ++this.subReqId;
      this.subscriptionId = 0;
      // Restore the subscription on every (re)connect.
      const req = this.subscribeRequest();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method: req.method, params: req.params }));
      this.setState(as, `subscribe sent to ${this.host} (awaiting ack)`);
      this.armPing();
      this.armHealthyTimer();
      this.armAckTimer(ws);
    });

    ws.on('message', (raw) => {
      const receivedAt = Date.now();
      this.bytes += frameLength(raw);
      // Inbound traffic is proof of life. A busy node can delay a pong past
      // the deadline while streaming perfectly well; killing the firehose
      // socket for that and redialling was the 2026-09-03 storm shape
      // (priorityFeed and confirmSocket already counted frames as life).
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      let msg: RpcMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      // The JSON-RPC reply to OUR subscribe request. This used to be dropped
      // on the floor along with any error it carried.
      if (msg.method === undefined && msg.id !== undefined && Number(msg.id) === this.subReqId) {
        this.clearAckTimer();
        if (msg.error !== undefined) {
          const message = rpcErrorMessage(msg.error);
          this.pool.onSubscribeError(this, message);
          this.scheduleReconnect(`subscribe rejected by ${this.host}: ${message}`);
          return;
        }
        if (typeof msg.result === 'number' || typeof msg.result === 'string') {
          this.subscriptionId = Number(msg.result) || 1;
          if (this.state !== 'live') this.setState('live', `subscribed (id ${String(msg.result)})`);
        }
        return;
      }

      if (msg.method !== this.notificationMethod()) return;
      // Data flowing proves the subscription regardless of the ack: some
      // providers answer with a notification before (or instead of) the ack.
      // It does NOT reset the backoff: an overloaded node that accepts,
      // streams for two seconds and sheds the connection would otherwise be
      // redialled at 1 s forever. Only `backoffResetAfterMs` of staying up
      // earns that (armHealthyTimer).
      this.clearAckTimer();
      if (this.state !== 'live') this.setState('live', 'first notification');
      this.handleNotification(msg.params?.result, receivedAt);
    });

    ws.on('pong', () => {
      this.everPonged = true;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    ws.on('error', (err) => {
      noteSocketRejection(this.url, err.message);
      // A handshake 429 parks the HOST for every socket class (rpcClient),
      // so the pump, amm, priority and confirm sockets back off together.
      noteSocketRateLimit(this.url, err.message);
      this.scheduleReconnect(`socket error: ${err.message}`);
    });

    ws.on('close', () => {
      this.scheduleReconnect('socket closed');
    });
  }

  private armPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        return;
      }
      // Only hold a server to a pong deadline once it has answered a ping at
      // least once. Some endpoints never reply to ping frames while
      // streaming perfectly well; terminating those produced a reconnect
      // storm that rate-limited the key (the same fix priorityFeed and
      // confirmSocket already carry).
      if (!this.everPonged) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        // No pong from a server that has ponged before — the connection is
        // dead even if TCP has not noticed.
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  /** A socket that stays up this long has earned a fresh backoff. */
  private armHealthyTimer(): void {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = setTimeout(() => {
      this.healthyTimer = null;
      this.backoffMs = this.timing.initialBackoffMs;
    }, this.timing.backoffResetAfterMs);
  }

  /** Neither an ack nor a notification arrived: the subscription is not
   *  known to exist. Treat it like a dead socket rather than sit "live". */
  private armAckTimer(ws: WebSocket): void {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.ws !== ws || this.subscriptionId !== 0 || this.state === 'live') return;
      this.scheduleReconnect(`subscribe unacknowledged by ${this.host} after ${this.timing.subscribeAckTimeoutMs}ms`);
    }, this.timing.subscribeAckTimeoutMs);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }
    this.clearAckTimer();
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (!this.wantRunning) return;
    if (this.reconnectTimer) return; // one pending reconnect at a time
    this.subscriptionId = 0;
    this.setState('reconnecting', reason);
    const delay = jitteredDelay(this.backoffMs, this.timing.rnd());
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect('reconnecting');
    }, delay);
  }
}

/** A `logsSubscribe` on one program — the racing-pool member. */
class FeedSocket extends RpcSocket {
  constructor(
    url: string,
    private commitment: 'processed' | 'confirmed',
    private programId: string,
    pool: SocketPool,
    timing: FeedTiming = {},
  ) {
    super(url, '', pool, timing);
  }

  protected subscribeRequest(): { method: string; params: unknown[] } {
    return { method: 'logsSubscribe', params: [{ mentions: [this.programId] }, { commitment: this.commitment }] };
  }

  protected notificationMethod(): string {
    return 'logsNotification';
  }

  protected handleNotification(result: unknown, receivedAt: number): void {
    const r = result as { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } | undefined;
    const value = r?.value;
    if (!value?.signature || !Array.isArray(value.logs)) return;
    if (value.err) return; // failed tx — nothing tradeable happened
    this.events += 1;
    this.pool.onNotification(this, { signature: value.signature, slot: r?.context?.slot ?? 0, logs: value.logs, receivedAt });
  }
}

/** One transaction as `blockSubscribe` delivers it with `encoding: 'base64'`. */
interface BlockTx {
  /** `[base64, 'base64']` for base64 encoding; an object with `signatures`
   *  for json — both are accepted so a provider quirk cannot blind us. */
  transaction?: [string, string] | { signatures?: string[]; message?: { accountKeys?: string[] } };
  meta?: {
    err?: unknown;
    logMessages?: string[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    innerInstructions?: Array<{ index: number; instructions: RawIx[] }> | null;
  } | null;
}

/**
 * A `blockSubscribe` standby: every confirmed block that mentions the
 * program, with full transaction details, decoded straight from the emit_cpi
 * inner instructions. See the header for why it exists.
 *
 * Cost model: whole blocks are heavy (measured 0.5–0.9 MB/s for pump), so
 * the per-tx work is ordered cheapest-first — `meta.err`, then a string scan
 * of the log lines for the program's invoke line, and only then the base64
 * parse of the wire bytes for the account table. A tx with no decodable
 * inner event produces no notification at all.
 */
export class BlockFeedSocket extends RpcSocket {
  /** Blocks received. */
  blocks = 0;
  private readonly invokeLine: string;

  constructor(
    url: string,
    private programId: string,
    private decodeInner: (data: Buffer) => InnerEvent | null,
    pool: SocketPool,
    timing: FeedTiming = {},
    private mentions: string = programId,
  ) {
    super(url, 'block', pool, timing);
    this.invokeLine = `Program ${programId} invoke`;
  }

  protected subscribeRequest(): { method: string; params: unknown[] } {
    return {
      method: 'blockSubscribe',
      params: [
        { mentionsAccountOrProgram: this.mentions },
        {
          commitment: 'confirmed',
          encoding: 'base64',
          transactionDetails: 'full',
          showRewards: false,
          // A block holding one v1 transaction is refused whole (-32015)
          // when the subscriber only takes v0 — since 2026-09-15 that was
          // most blocks. parseWireTransaction reads both formats.
          maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        },
      ],
    };
  }

  protected notificationMethod(): string {
    return 'blockNotification';
  }

  protected handleNotification(result: unknown, receivedAt: number): void {
    const r = result as { value?: { slot?: number; err?: unknown; block?: { transactions?: BlockTx[] } | null } } | undefined;
    const value = r?.value;
    if (!value || value.err || !value.block) return;
    this.blocks += 1;
    const slot = value.slot ?? 0;
    for (const tx of value.block.transactions ?? []) {
      const n = this.decodeTx(tx, slot, receivedAt);
      if (!n) continue;
      this.events += 1;
      this.pool.onNotification(this, n);
    }
  }

  /** Exposed for tests: one block transaction → notification or null. */
  decodeTx(tx: BlockTx, slot: number, receivedAt: number): PoolNotification | null {
    const meta = tx.meta;
    if (!meta || meta.err) return null;
    const inner = meta.innerInstructions;
    if (!inner || inner.length === 0) return null;
    const logs = meta.logMessages ?? [];
    // Cheap prefilter: a block filtered by account (amm) or a tx that merely
    // mentions the program never reaches the base64 parse below.
    let invoked = false;
    for (const l of logs) {
      if (l.startsWith(this.invokeLine)) {
        invoked = true;
        break;
      }
    }
    if (!invoked) return null;

    let signature: string;
    let staticKeys: string[];
    if (Array.isArray(tx.transaction)) {
      const wire = parseWireTransaction(tx.transaction[0]);
      if (!wire) return null;
      signature = wire.signature;
      staticKeys = wire.accountKeys;
    } else {
      signature = tx.transaction?.signatures?.[0] ?? '';
      staticKeys = tx.transaction?.message?.accountKeys ?? [];
    }
    if (!signature) return null;
    const loaded = meta.loadedAddresses;
    const keys = resolveAccountKeys({
      meta: { err: null, loadedAddresses: loaded ? { writable: loaded.writable ?? [], readonly: loaded.readonly ?? [] } : undefined },
      transaction: { message: { accountKeys: staticKeys, header: { numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] } },
    });

    const innerEvents: InnerEvent[] = [];
    for (const group of inner) {
      for (const ix of group.instructions) {
        if (keys[ix.programIdIndex] !== this.programId) continue;
        let data: Buffer;
        try {
          data = Buffer.from(base58Decode(ix.data));
        } catch {
          continue;
        }
        const ev = this.decodeInner(data);
        if (ev) innerEvents.push(ev);
      }
    }
    if (innerEvents.length === 0) return null;
    return { signature, slot, logs, receivedAt, innerEvents };
  }
}

/** Per-socket detail beyond FeedSocketStatus, for billing and the watchdog. */
export interface FeedSocketDetail extends FeedSocketStatus {
  /** Uncompressed bytes received (the Helius billing unit). */
  bytes: number;
  /** Deliveries that passed the dedupe after an undecodable log copy. */
  fills: number;
  /** Block sockets only: blocks received. */
  blocks: number;
  /** Provider tag as stamped on notifications. */
  provider: string;
  kind: 'logs' | 'block';
}

export class FeedManager {
  private sockets: RpcSocket[];
  private blockSockets: BlockFeedSocket[];
  private state: FeedState = 'stopped';
  /** signature → whether a delivery carrying innerEvents has already passed.
   *  A log copy (no innerEvents) claims the signature first; a later CPI copy
   *  passes once, so the consumer can use it if the log copy decoded nothing. */
  private seen = new Map<string, boolean>();
  private seenOrder: string[] = [];
  lastSlot = 0;

  /** `programId` defaults to the pump launch program; pass another (e.g. the
   *  pump-amm program for post-migration capture) to watch a different one.
   *  `block` adds blockSubscribe standby sockets that decode emit_cpi events. */
  constructor(
    urls: string[],
    commitment: 'processed' | 'confirmed',
    private cb: FeedCallbacks,
    programId: string = PUMP_PROGRAM_ID,
    timing: FeedTiming = {},
    block?: BlockFeedOptions,
  ) {
    const pool: SocketPool = {
      onNotification: (s, n) => this.onNotification(s, n),
      onSocketState: (s, detail) => this.onSocketState(s, detail),
      onSubscribeError: (s, message) => this.cb.onSubscribeError?.(s.host, message),
    };
    const clean = (list: string[]): string[] => [...new Set(list.map((u) => u.trim()).filter((u) => /^wss?:\/\//.test(u)))];
    this.sockets = clean(urls).map((url) => new FeedSocket(url, commitment, programId, pool, timing));
    this.blockSockets = block
      ? clean(block.urls).map((url) => new BlockFeedSocket(url, programId, block.decodeInner, pool, timing, block.mentions ?? programId))
      : [];
  }

  private all(): RpcSocket[] {
    return [...this.sockets, ...this.blockSockets];
  }

  start(): void {
    for (const s of this.all()) s.start();
  }

  stop(): void {
    for (const s of this.all()) s.stop();
    this.state = 'stopped';
    this.cb.onState('stopped', 'stopped by user');
  }

  getState(): FeedState {
    return this.state;
  }

  getStats(): FeedSocketStatus[] {
    return this.getDetails().map(({ url, host, state, events, wins }) => ({ url, host, state, events, wins }));
  }

  /** getStats plus bytes/fills/blocks. Block sockets report host `<host>:block`. */
  getDetails(): FeedSocketDetail[] {
    // url is display/identity only — strip credentials so status payloads
    // (screenshots, recordings) can never leak an API key.
    return this.all().map((s) => ({
      url: s.url.replace(/api-key=[^&]+/gi, 'api-key=***'),
      host: s.provider,
      provider: s.provider,
      state: s.state,
      events: s.events,
      wins: s.wins,
      fills: s.fills,
      bytes: s.bytes,
      blocks: s instanceof BlockFeedSocket ? s.blocks : 0,
      kind: s instanceof BlockFeedSocket ? 'block' : 'logs',
    }));
  }

  private onNotification(socket: RpcSocket, n: PoolNotification): void {
    if (n.slot > this.lastSlot) this.lastSlot = n.slot;
    const hasInner = !!n.innerEvents?.length;
    const prior = this.seen.get(n.signature);
    if (prior !== undefined) {
      // Shared dedupe: the first socket to deliver a signature wins; replays
      // (reconnects, the other sockets) are dropped here — EXCEPT one CPI
      // copy after a log copy, which the consumer needs if the log copy
      // decoded no trade (the day pump drops emit!). It decides; we pass.
      if (prior || !hasInner) return;
      this.seen.set(n.signature, true);
      socket.fills += 1;
      this.cb.onLogs({ ...n, provider: socket.provider });
      return;
    }
    this.seen.set(n.signature, hasInner);
    this.seenOrder.push(n.signature);
    if (this.seenOrder.length > SEEN_CAP) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - SEEN_CAP);
      for (const s of drop) this.seen.delete(s);
    }
    socket.wins += 1;
    this.cb.onLogs({ ...n, provider: socket.provider });
  }

  private onSocketState(socket: RpcSocket, detail: string): void {
    // Pool state = best socket state: live if ANY socket is live.
    const states = this.all().map((s) => s.state);
    const next: FeedState = states.includes('live')
      ? 'live'
      : states.includes('connecting')
        ? 'connecting'
        : states.includes('reconnecting')
          ? 'reconnecting'
          : 'stopped';
    const summary = this.all()
      .map((s) => `${s.provider}:${s.state}`)
      .join(', ');
    this.state = next;
    this.cb.onState(next, `${socket.provider}: ${detail} [${summary}]`);
  }
}
