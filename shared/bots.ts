// Chat bots — pure core: settings, pairing, authorisation, command parsing.
//
// No network, no secrets in flight, no `electron`. The transports live in
// electron/system/{telegramBot,discordBot}.ts; everything that decides WHO
// gets an answer lives here, because that is the part worth testing.
//
// ─── The threat this is shaped around ─────────────────────────────────
//
// A bot token is a public endpoint with your name on it. Anyone who finds the
// bot can message it. So the rules are:
//
//   • Before pairing, the ONLY accepted message is `/pair <code>`, where the
//     code was generated locally and shown in the app. Nothing else gets a
//     reply — not even an error, because a reply confirms the bot exists.
//   • After pairing, exactly one sender id is served. Everyone else is
//     ignored in silence, forever.
//   • The pairing code expires, and wrong attempts are capped. A six-digit
//     code is guessable at a few thousand tries; it must not survive them.
//   • NOTHING here can trade. The command table is read-only by
//     construction until 2026-09-05, when trading from chat was added
//     deliberately — see shared/botTrading.ts for the threat model and the
//     rules. Signing still requires a local, armed, funded wallet inside the
//     per-trade cap; a chat message can now ASK for a trade, bounded by its
//     own caps and a one-time confirmation, and can never name a
//     destination for SOL.

import { DEFAULT_BOT_TRADE_POLICY, type BotTradePolicy } from './botTrading';

export type BotKind = 'telegram' | 'discord';

export interface BotConfig {
  enabled: boolean;
  /** Bot token. SECRET — never logged, never sent to the renderer in full. */
  token: string;
  /**
   * The sender this bot answers to, learned by pairing. Telegram: chat id.
   * Discord: user id. Null until paired.
   */
  ownerId: string | null;
  /** Push alerts and fills to the chat as they happen. */
  pushAlerts: boolean;
}

export interface BotSettings {
  telegram: BotConfig;
  discord: BotConfig;
  /** Trading from a paired chat. Off by default; ./botTrading.ts carries the
   *  threat model and the rules that bound it. */
  trading: BotTradePolicy;
}

export function defaultBotConfig(): BotConfig {
  return { enabled: false, token: '', ownerId: null, pushAlerts: true };
}

export function defaultBotSettings(): BotSettings {
  return { telegram: defaultBotConfig(), discord: defaultBotConfig(), trading: { ...DEFAULT_BOT_TRADE_POLICY } };
}

// ── Pairing ───────────────────────────────────────────────────────────

/** How long a shown code stays valid. Long enough to switch apps and type it. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong attempts before the code is burned. */
export const PAIRING_MAX_ATTEMPTS = 5;

export interface Pairing {
  code: string;
  createdAt: number;
  attempts: number;
}

/** Six digits, zero-padded. `rand` is injected so tests are deterministic. */
export function newPairingCode(rand: () => number = Math.random): string {
  return String(Math.floor(rand() * 1_000_000)).padStart(6, '0');
}

export function pairingExpired(p: Pairing, now: number): boolean {
  return now - p.createdAt > PAIRING_TTL_MS;
}

export type PairResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'no-pairing' | 'expired' | 'burned' | 'wrong-code' };

/**
 * Check a `/pair` attempt. Mutates `attempts` on a wrong code — the caller
 * persists the pairing object.
 */
export function tryPair(pairing: Pairing | null, code: string, senderId: string, now: number): PairResult {
  if (!pairing) return { ok: false, reason: 'no-pairing' };
  if (pairingExpired(pairing, now)) return { ok: false, reason: 'expired' };
  if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) return { ok: false, reason: 'burned' };
  if (code.trim() !== pairing.code) {
    pairing.attempts += 1;
    return { ok: false, reason: 'wrong-code' };
  }
  return { ok: true, ownerId: senderId };
}

// ── Commands ──────────────────────────────────────────────────────────

export interface BotCommand {
  name: string;
  args: string[];
}

/**
 * Parse a chat message into a command.
 *
 * Telegram appends `@botname` to commands in groups; Discord does not. Both
 * are normalised here so the dispatcher sees one shape.
 */
export function parseCommand(text: string): BotCommand | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0].split('@')[0].toLowerCase();
  if (!name) return null;
  return { name, args: parts.slice(1) };
}

/**
 * Every command this bot will ever answer. READ-ONLY BY CONSTRUCTION.
 *
 * If a trading command is ever wanted it does not belong in this table — it
 * belongs behind a separate, deliberate decision about whether a chat message
 * may move money, which today's answer is no.
 */
export const COMMANDS: Array<{ name: string; usage: string; help: string }> = [
  { name: 'help', usage: '/help', help: 'This list' },
  { name: 'status', usage: '/status', help: 'Engine, feed and live-trading state' },
  { name: 'positions', usage: '/positions', help: 'Open positions and unrealised PnL' },
  { name: 'pnl', usage: '/pnl', help: 'Portfolio value and PnL' },
  { name: 'wallet', usage: '/wallet', help: 'Active wallet address and balance' },
  { name: 'alerts', usage: '/alerts', help: 'Armed price alerts' },
  { name: 'orders', usage: '/orders', help: 'Armed stops, take profits and limits' },
  { name: 'price', usage: '/price <mint>', help: 'What a token is worth right now' },
  // Spending commands. Off unless trading from chat is enabled in the app,
  // and each one needs a /yes reply before anything is signed.
  { name: 'buy', usage: '/buy <mint> <SOL>', help: 'Buy — needs chat trading AND buys enabled in the app' },
  { name: 'sell', usage: '/sell <mint> [percent]', help: 'Sell a position (default 100%)' },
  { name: 'yes', usage: '/yes <code>', help: 'Confirm the trade the bot just quoted' },
  { name: 'lock', usage: '/lock', help: 'Turn chat trading off immediately' },
  { name: 'unpair', usage: '/unpair', help: 'Forget this chat; the bot stops answering' },
];

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}

// ── Authorisation ─────────────────────────────────────────────────────

export type BotAction =
  | { kind: 'pair'; code: string }
  | { kind: 'run'; command: BotCommand }
  | { kind: 'ignore'; why: string };

/**
 * Decide what to do with an inbound message.
 *
 * The default is IGNORE. Every path to a reply is explicit, and an
 * unrecognised sender never learns anything — including whether they got the
 * command right.
 */
export function decide(opts: {
  text: string;
  senderId: string;
  ownerId: string | null;
  hasPairing: boolean;
}): BotAction {
  const cmd = parseCommand(opts.text);

  if (!opts.ownerId) {
    // Unpaired: the only thing that can happen is pairing.
    if (cmd?.name === 'pair' && cmd.args.length) return { kind: 'pair', code: cmd.args[0] };
    return { kind: 'ignore', why: opts.hasPairing ? 'not paired yet' : 'no pairing in progress' };
  }

  if (opts.senderId !== opts.ownerId) {
    // Silence is the whole point: a stranger must not be able to tell this
    // bot apart from one that does not exist.
    return { kind: 'ignore', why: 'sender is not the paired owner' };
  }

  if (!cmd) return { kind: 'ignore', why: 'not a command' };
  // A second /pair from the owner is pointless but harmless; treat it as
  // unknown rather than re-running pairing.
  if (!isKnownCommand(cmd.name)) return { kind: 'ignore', why: `unknown command /${cmd.name}` };
  return { kind: 'run', command: cmd };
}

/** Never show a whole token — not in the UI, not in a log, not in a status. */
export function redactToken(token: string): string {
  const t = (token ?? '').trim();
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/**
 * A token that at least looks like the right kind of thing.
 *
 * Deliberately loose — the aim is to catch a pasted username or a truncated
 * copy, not to validate a credential we cannot verify offline anyway.
 */
export function looksLikeToken(kind: BotKind, token: string): boolean {
  const t = (token ?? '').trim();
  if (!t) return false;
  if (kind === 'telegram') return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(t);
  return t.length >= 50 && !t.includes(' ');
}

export const HELP_TEXT = [
  'Krypto Bot.',
  'Trading from chat is OFF unless you switched it on in the app, and buying',
  'needs a second switch. Nothing here can move SOL to another address.',
  '',
  ...COMMANDS.map((c) => `${c.usage} — ${c.help}`),
].join('\n');
