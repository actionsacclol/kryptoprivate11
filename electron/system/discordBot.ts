// Discord transport — gateway websocket in, REST out.
//
// Discord has no polling equivalent of Telegram's `getUpdates`, so receiving a
// DM means holding the gateway socket: HELLO → IDENTIFY → heartbeat forever,
// and listen for MESSAGE_CREATE. Outbound only, like every other connection
// this app makes.
//
// ─── The intent the user must switch on ───────────────────────────────
//
// Reading message TEXT needs the MESSAGE CONTENT intent, which is privileged
// and off by default. Without it the socket connects, DMs arrive, and every
// `content` is an empty string — which looks exactly like a broken bot. The
// settings panel says so, and `lastError` surfaces the disconnect reason
// Discord sends (4014) when the intent was not enabled for the application.

import WebSocket from 'ws';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15). */
const INTENTS = (1 << 12) | (1 << 15);

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface InboundMessage {
  senderId: string;
  /** The DM channel to reply in. */
  replyTo: string;
  text: string;
}

export interface DiscordHost {
  token(): string;
  onMessage(msg: InboundMessage): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

let host: DiscordHost | null = null;
let ws: WebSocket | null = null;
let running = false;
let heartbeat: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let attempts = 0;
let lastError: string | null = null;
let selfId: string | null = null;

export function attach(h: DiscordHost): void {
  host = h;
}

export function isRunning(): boolean {
  return running && ws?.readyState === WebSocket.OPEN;
}

export function lastFailure(): string | null {
  return lastError;
}

export function start(): void {
  if (running || !host?.token()) return;
  running = true;
  attempts = 0;
  connect();
}

export function stop(): void {
  running = false;
  clearTimers();
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  ws = null;
}

function clearTimers(): void {
  if (heartbeat) clearInterval(heartbeat);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  heartbeat = null;
  reconnectTimer = null;
}

function connect(): void {
  const token = host?.token();
  if (!running || !token) return;
  clearTimers();
  try {
    ws = new WebSocket(GATEWAY);
  } catch (err) {
    scheduleReconnect((err as Error)?.message ?? 'socket failed');
    return;
  }

  ws.on('open', () => {
    attempts = 0;
  });

  ws.on('message', (raw) => {
    let msg: { op?: number; t?: string; d?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.op === OP_HELLO) {
      const interval = Number((msg.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250);
      heartbeat = setInterval(() => {
        try {
          ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: null }));
        } catch {
          /* the close handler will reconnect */
        }
      }, interval);
      ws?.send(
        JSON.stringify({
          op: OP_IDENTIFY,
          d: {
            token,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'krypt-terminal', device: 'krypt-terminal' },
          },
        }),
      );
      return;
    }

    if (msg.op === OP_INVALID_SESSION) {
      scheduleReconnect('session invalidated');
      return;
    }
    if (msg.op === OP_HEARTBEAT_ACK) return;
    if (msg.op !== OP_DISPATCH) return;

    if (msg.t === 'READY') {
      const user = (msg.d as { user?: { id?: string; username?: string } })?.user;
      selfId = user?.id ?? null;
      lastError = null;
      host?.log('info', `Discord bot connected as ${user?.username ?? 'bot'}`);
      return;
    }

    if (msg.t !== 'MESSAGE_CREATE') return;
    const d = msg.d as {
      content?: string;
      channel_id?: string;
      guild_id?: string;
      author?: { id?: string; bot?: boolean };
    };
    // Ignore our own messages and other bots, and only accept DIRECT
    // messages: a bot invited to a server would otherwise be readable by that
    // server's members.
    if (!d?.author?.id || d.author.bot || d.author.id === selfId) return;
    if (d.guild_id) return;
    if (!d.channel_id) return;
    host?.onMessage({ senderId: d.author.id, replyTo: d.channel_id, text: d.content ?? '' });
  });

  ws.on('close', (code) => {
    // 4014 = disallowed intent: the app has not enabled MESSAGE CONTENT.
    if (code === 4014) {
      lastError = 'Discord refused the MESSAGE CONTENT intent — enable it in the Developer Portal (Bot → Privileged Gateway Intents).';
      host?.log('error', lastError);
      running = false;
      clearTimers();
      return;
    }
    if (code === 4004) {
      lastError = 'Discord rejected the bot token.';
      host?.log('error', lastError);
      running = false;
      clearTimers();
      return;
    }
    scheduleReconnect(`socket closed (${code})`);
  });

  ws.on('error', (err) => {
    scheduleReconnect((err as Error)?.message ?? 'socket error');
  });
}

function scheduleReconnect(why: string): void {
  clearTimers();
  if (!running) return;
  attempts += 1;
  if (attempts === 1) host?.log('warn', `Discord gateway: ${why}; reconnecting`);
  lastError = why;
  const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
  reconnectTimer = setTimeout(connect, wait);
}

/** Send a DM. Opening the channel first means a reply works even if the user
 *  has not messaged us in this session. */
export async function send(channelId: string, text: string): Promise<boolean> {
  const token = host?.token();
  if (!token || !channelId) return false;
  try {
    const res = await fetch(`${API}/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Open (or fetch) the DM channel with a user, so pushes can reach them. */
export async function dmChannelFor(userId: string): Promise<string | null> {
  const token = host?.token();
  if (!token || !userId) return null;
  try {
    const res = await fetch(`${API}/users/@me/channels`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string };
    return body?.id ?? null;
  } catch {
    return null;
  }
}

/** Confirm a token before saving it. */
export async function verify(token: string): Promise<{ ok: boolean; username?: string; message: string }> {
  if (!token.trim()) return { ok: false, message: 'No token' };
  try {
    const res = await fetch(`${API}/users/@me`, {
      headers: { authorization: `Bot ${token.trim()}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ok: false, message: res.status === 401 ? 'Discord rejected the token' : `HTTP ${res.status}` };
    const body = (await res.json()) as { username?: string };
    return { ok: true, username: body?.username, message: `Connected as ${body?.username ?? 'bot'}` };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'request failed' };
  }
}
