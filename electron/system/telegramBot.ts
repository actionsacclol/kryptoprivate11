// Telegram transport — long polling, no SDK.
//
// Outbound HTTPS only: `getUpdates` holds a connection open for up to 25s and
// returns whatever arrived, so there is no inbound port, no webhook and no
// public endpoint on this machine. That is the whole reason to prefer polling
// here over the documented webhook flow.
//
// This module knows nothing about who is allowed to say what — it hands
// messages up and sends text back. The authorisation lives in shared/bots.ts.

const API = 'https://api.telegram.org';

/** Telegram holds the request open; this must exceed that or every poll aborts. */
const POLL_TIMEOUT_S = 25;
const REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_S + 10) * 1000;

export interface InboundMessage {
  /** Who sent it — the identity authorisation is decided on. */
  senderId: string;
  /** Where to reply. Equal to senderId in a private chat, but not in a group. */
  replyTo: string;
  text: string;
}

export interface TelegramHost {
  token(): string;
  onMessage(msg: InboundMessage): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

interface TgUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; is_bot?: boolean };
  };
}

let host: TelegramHost | null = null;
let running = false;
let offset = 0;
let consecutiveErrors = 0;

export function attach(h: TelegramHost): void {
  host = h;
}

export function isRunning(): boolean {
  return running;
}

export function start(): void {
  if (running || !host?.token()) return;
  running = true;
  consecutiveErrors = 0;
  void poll();
  host.log('info', 'Telegram bot polling started');
}

export function stop(): void {
  // The poll loop notices on its next tick; an in-flight long poll is left to
  // finish rather than aborted, which keeps the update offset consistent.
  running = false;
}

/** Send a message. Returns false rather than throwing — a chat that will not
 *  accept messages must never take the app down with it. */
export async function send(chatId: string, text: string): Promise<boolean> {
  const token = host?.token();
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Telegram caps a message at 4096 characters.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Confirm the token is real and name the bot, for the settings panel. */
export async function verify(token: string): Promise<{ ok: boolean; username?: string; message: string }> {
  if (!token.trim()) return { ok: false, message: 'No token' };
  try {
    const res = await fetch(`${API}/bot${token.trim()}/getMe`, { signal: AbortSignal.timeout(12_000) });
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!res.ok || !body?.ok) return { ok: false, message: body?.description ?? `HTTP ${res.status}` };
    return { ok: true, username: body.result?.username, message: `Connected as @${body.result?.username ?? 'bot'}` };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'request failed' };
  }
}

async function poll(): Promise<void> {
  while (running) {
    const token = host?.token();
    if (!token) {
      running = false;
      return;
    }
    try {
      const url = `${API}/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=%5B%22message%22%5D`;
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) {
        // 409 means another poller is attached to the same token. Backing off
        // rather than hammering keeps the other one working. A 429 names its
        // own wait (`parameters.retry_after`, seconds) — honour it exactly:
        // Telegram counts an early retry against the next window too.
        let retryAfterMs = 0;
        if (res.status === 429) {
          try {
            const body = (await res.json()) as { parameters?: { retry_after?: number } };
            retryAfterMs = Math.max(0, Math.min(120_000, (body?.parameters?.retry_after ?? 0) * 1000));
          } catch {
            /* no body — the exponential wait applies */
          }
        }
        await backoff(res.status === 409 ? 'another client is polling this bot' : `HTTP ${res.status}`, retryAfterMs);
        continue;
      }
      const body = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
      consecutiveErrors = 0;
      for (const u of body?.result ?? []) {
        if (typeof u.update_id === 'number') offset = Math.max(offset, u.update_id + 1);
        const m = u.message;
        if (!m?.text || m.from?.is_bot) continue;
        const senderId = m.from?.id !== undefined ? String(m.from.id) : '';
        const replyTo = m.chat?.id !== undefined ? String(m.chat.id) : senderId;
        if (!senderId) continue;
        host?.onMessage({ senderId, replyTo, text: m.text });
      }
    } catch (err) {
      if (!running) return;
      await backoff((err as Error)?.message ?? 'poll failed');
    }
  }
}

async function backoff(why: string, atLeastMs = 0): Promise<void> {
  consecutiveErrors += 1;
  // Only complain once per outage, not once per retry.
  if (consecutiveErrors === 1) host?.log('warn', `Telegram poll failed (${why}); retrying`);
  const wait = Math.max(atLeastMs, Math.min(30_000, 1_000 * 2 ** Math.min(consecutiveErrors, 5)));
  await new Promise((r) => setTimeout(r, wait));
}
