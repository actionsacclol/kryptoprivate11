// Chat bots — the orchestrator.
//
// Owns pairing state, decides who gets an answer (via shared/bots.ts), runs
// the read-only commands against a host interface, and pushes alerts. The two
// transports below it know nothing about authorisation; this module knows
// nothing about websockets or long polling.
//
// SAFETY. Until 2026-09-05 there was no path from a chat message to a
// signature at all. There is one now, deliberately, and these are the walls
// around it (the reasoning is in shared/botTrading.ts):
//
//   • Off by default, with buying behind a second switch.
//   • Only the paired owner is ever answered; everyone else gets silence.
//   • Every spending command is quoted back and needs a /yes <code> reply
//     within a minute. The code is single-use.
//   • Buys are bounded per trade and per rolling hour, on top of the app's
//     own per-trade cap. Sells are not rationed — an exit must not be.
//   • No command can name a destination for SOL. There is no withdraw, no
//     transfer, no address argument anywhere in the table, and the signer
//     policy would refuse one regardless.
//   • /lock turns chat trading off from the phone, and the app announces and
//     logs every chat trade so the desktop is never the last to know.

import {
  decide,
  newPairingCode,
  tryPair,
  HELP_TEXT,
  type BotCommand,
  type BotKind,
  type BotSettings,
  type Pairing,
} from '@shared/bots';
import {
  CONFIRM_TTL_MS,
  checkConfirm,
  checkTradeAllowed,
  describeIntent,
  makeConfirmCode,
  parseTradeCommand,
  type PendingConfirm,
  type TradeAttempt,
  type TradeIntent,
} from '@shared/botTrading';
import * as telegram from './telegramBot';
import * as discord from './discordBot';

export interface BotHost {
  settings(): BotSettings;
  /** Persist a learned owner id (pairing succeeded) or clear it (unpair). */
  saveOwner(kind: BotKind, ownerId: string | null): void;
  /** Read-only views the commands render. Each returns display text. */
  statusText(): string;
  positionsText(): string;
  pnlText(): string;
  walletText(): string;
  alertsText(): string;
  ordersText(): string;
  priceText(mint: string): Promise<string>;
  /** Symbol for a mint, for the confirmation line. Never blocks. */
  symbolFor(mint: string): string;
  /** Execute. These are the ONLY two host calls that can move money, and
   *  both are already bounded by the app's own arming and caps. */
  buy(mint: string, sol: number): Promise<{ ok: boolean; message: string }>;
  sell(mint: string, pct: number): Promise<{ ok: boolean; message: string }>;
  /** Turn chat trading off, from the phone. */
  lockTrading(): void;
  /** Tell the desktop what the chat just did. */
  announce(level: 'info' | 'warn' | 'error', line: string): void;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

let host: BotHost | null = null;
/** One pending confirmation per chat, replaced by any newer command. */
const pending: Record<BotKind, PendingConfirm | null> = { telegram: null, discord: null };
/** Recent spending, for the rolling caps. Trimmed as it is read. */
let attempts: TradeAttempt[] = [];
const pairings: Record<BotKind, Pairing | null> = { telegram: null, discord: null };
/** DM channel per kind, so a push knows where to go without a fresh lookup. */
const pushTarget: Record<BotKind, string | null> = { telegram: null, discord: null };

export function attach(h: BotHost): void {
  host = h;
  telegram.attach({
    token: () => h.settings().telegram.token.trim(),
    onMessage: (m) => void onMessage('telegram', m.senderId, m.replyTo, m.text),
    log: (l, line) => h.log(l, line),
  });
  discord.attach({
    token: () => h.settings().discord.token.trim(),
    onMessage: (m) => void onMessage('discord', m.senderId, m.replyTo, m.text),
    log: (l, line) => h.log(l, line),
  });
}

/** Start or stop each transport to match settings. Safe to call repeatedly. */
export function sync(): void {
  if (!host) return;
  const s = host.settings();
  const want = (k: BotKind): boolean => s[k].enabled && s[k].token.trim().length > 0;

  if (want('telegram') && !telegram.isRunning()) telegram.start();
  if (!want('telegram') && telegram.isRunning()) telegram.stop();

  if (want('discord') && !discord.isRunning()) discord.start();
  if (!want('discord') && discord.isRunning()) discord.stop();
}

export function stopAll(): void {
  telegram.stop();
  discord.stop();
}

// ── Pairing ───────────────────────────────────────────────────────────

/**
 * Begin pairing: generate a code for the user to send to their bot.
 *
 * Returns the code so the UI can display it. It is never sent anywhere — the
 * user carries it to the chat, which is what proves they control both ends.
 */
export function beginPairing(kind: BotKind): { code: string } {
  const code = newPairingCode();
  pairings[kind] = { code, createdAt: Date.now(), attempts: 0 };
  host?.log('info', `${kind} pairing started — send /pair ${code} to your bot`);
  return { code };
}

export function cancelPairing(kind: BotKind): void {
  pairings[kind] = null;
}

export function unpair(kind: BotKind): void {
  pairings[kind] = null;
  pushTarget[kind] = null;
  host?.saveOwner(kind, null);
  host?.log('info', `${kind} bot unpaired`);
}

export interface BotStatus {
  kind: BotKind;
  enabled: boolean;
  running: boolean;
  paired: boolean;
  /** Never the token itself. */
  tokenPresent: boolean;
  pairingActive: boolean;
  lastError: string | null;
}

export function status(): BotStatus[] {
  const s = host?.settings();
  return (['telegram', 'discord'] as BotKind[]).map((kind) => ({
    kind,
    enabled: s?.[kind].enabled ?? false,
    running: kind === 'telegram' ? telegram.isRunning() : discord.isRunning(),
    paired: !!s?.[kind].ownerId,
    tokenPresent: !!s?.[kind].token.trim(),
    pairingActive: !!pairings[kind],
    lastError: kind === 'discord' ? discord.lastFailure() : null,
  }));
}

// ── Inbound ───────────────────────────────────────────────────────────

async function reply(kind: BotKind, to: string, text: string): Promise<void> {
  if (kind === 'telegram') await telegram.send(to, text);
  else await discord.send(to, text);
}

async function onMessage(kind: BotKind, senderId: string, replyTo: string, text: string): Promise<void> {
  if (!host) return;
  const cfg = host.settings()[kind];
  const action = decide({ text, senderId, ownerId: cfg.ownerId, hasPairing: !!pairings[kind] });

  if (action.kind === 'ignore') {
    // Deliberately silent. A reply — even a refusal — tells a stranger the
    // bot is real and worth attacking.
    return;
  }

  if (action.kind === 'pair') {
    const result = tryPair(pairings[kind], action.code, senderId, Date.now());
    if (!result.ok) {
      if (result.reason === 'wrong-code') {
        host.log('warn', `${kind}: wrong pairing code from ${senderId}`);
      }
      return; // silent on every failure path
    }
    pairings[kind] = null;
    pushTarget[kind] = replyTo;
    host.saveOwner(kind, result.ownerId);
    host.log('info', `${kind} bot paired with ${result.ownerId}`);
    await reply(kind, replyTo, `Paired with Krypto Bot.\n\n${HELP_TEXT}`);
    return;
  }

  // Remember where the owner speaks to us, so pushes need no lookup.
  pushTarget[kind] = replyTo;

  // Spending commands and their confirmation are handled before the
  // read-only table, because they carry state (the pending code) and the
  // read-only table must stay exactly what it was.
  const spending = await runSpending(kind, text, action.command);
  if (spending !== null) {
    await reply(kind, replyTo, spending);
    return;
  }
  await reply(kind, replyTo, run(action.command));
}

/**
 * The trading path. Returns null when the message is not about trading, so
 * the caller falls through to the read-only commands.
 */
async function runSpending(kind: BotKind, text: string, cmd: BotCommand): Promise<string | null> {
  if (!host) return null;
  const policy = host.settings().trading;
  const now = Date.now();

  if (cmd.name === 'lock') {
    host.lockTrading();
    pending[kind] = null;
    host.announce('warn', 'Chat trading was turned off from the paired chat');
    return 'Chat trading is off. Turn it back on in the app.';
  }

  // A confirmation for something already quoted.
  const confirm = checkConfirm(text, pending[kind], now);
  if (confirm.reason || cmd.name === 'yes') {
    const intent = pending[kind]?.intent;
    // Single use, whatever the outcome: a replayed message cannot trade twice.
    pending[kind] = null;
    if (!confirm.ok) return confirm.reason || 'Nothing is waiting for confirmation.';
    if (!intent) return 'Nothing is waiting for confirmation.';
    return execute(kind, intent);
  }

  const parsed = parseTradeCommand(text);
  if (!parsed) return null;
  if ('error' in parsed) return parsed.error;

  const allowed = checkTradeAllowed(parsed.intent, policy, attempts, now);
  if (!allowed.ok) {
    host.log('warn', `${kind} bot: refused ${parsed.intent.kind} — ${allowed.reason}`);
    return allowed.reason;
  }

  const line = describeIntent(parsed.intent, host.symbolFor(parsed.intent.mint));
  if (!policy.requireConfirm) return execute(kind, parsed.intent);

  const code = makeConfirmCode(now);
  pending[kind] = { code, intent: parsed.intent, createdAt: now };
  return `${line}\n\nReply /yes ${code} within ${Math.round(CONFIRM_TTL_MS / 1000)}s to place it.`;
}

async function execute(kind: BotKind, intent: TradeIntent): Promise<string> {
  if (!host) return 'Not ready.';
  // Re-checked at execution, not just at quote time: the caps may have been
  // reached by another command while this one waited for confirmation.
  const recheck = checkTradeAllowed(intent, host.settings().trading, attempts, Date.now());
  if (!recheck.ok) return recheck.reason;

  const what = describeIntent(intent, host.symbolFor(intent.mint));
  host.announce('warn', `Chat trade requested: ${what}`);
  host.log('warn', `${kind} bot: executing ${what}`);
  attempts = [...attempts.filter((a) => a.at > Date.now() - 3_600_000), { at: Date.now(), kind: intent.kind, sol: intent.kind === 'buy' ? intent.amount : 0 }];

  const res = intent.kind === 'buy' ? await host.buy(intent.mint, intent.amount) : await host.sell(intent.mint, intent.amount);
  host.announce(res.ok ? 'info' : 'error', `Chat trade ${res.ok ? 'done' : 'failed'}: ${what} — ${res.message}`);
  host.log(res.ok ? 'info' : 'warn', `${kind} bot: ${what} → ${res.message}`);
  return `${res.ok ? 'Done' : 'Failed'}: ${what}\n${res.message}`;
}

function run(cmd: BotCommand): string {
  if (!host) return 'Not ready.';
  switch (cmd.name) {
    case 'help':
      return HELP_TEXT;
    case 'status':
      return host.statusText();
    case 'positions':
      return host.positionsText();
    case 'pnl':
      return host.pnlText();
    case 'wallet':
      return host.walletText();
    case 'alerts':
      return host.alertsText();
    case 'orders':
      return host.ordersText();
    case 'unpair': {
      // Answer BEFORE forgetting them, or the confirmation never arrives.
      const kinds = (['telegram', 'discord'] as BotKind[]).filter((k) => host?.settings()[k].ownerId);
      for (const k of kinds) unpair(k);
      return 'Unpaired. This bot will not answer again until you pair it from the app.';
    }
    default:
      return HELP_TEXT;
  }
}

// ── Outbound pushes ───────────────────────────────────────────────────

/**
 * Push a line to every paired chat that wants alerts.
 *
 * Best-effort and never awaited by callers on the hot path: a chat being slow
 * must not delay an alert firing locally.
 */
export function push(text: string): void {
  if (!host) return;
  const s = host.settings();
  for (const kind of ['telegram', 'discord'] as BotKind[]) {
    const cfg = s[kind];
    if (!cfg.enabled || !cfg.ownerId || !cfg.pushAlerts) continue;
    const target = pushTarget[kind];
    if (target) {
      void reply(kind, target, text);
      continue;
    }
    if (kind === 'telegram') {
      // A Telegram chat id IS the reply address.
      void telegram.send(cfg.ownerId, text);
    } else {
      // Discord needs a DM channel opened for the user id first.
      void discord.dmChannelFor(cfg.ownerId).then((ch) => {
        if (!ch) return;
        pushTarget.discord = ch;
        void discord.send(ch, text);
      });
    }
  }
}

export const verifyToken = {
  telegram: telegram.verify,
  discord: discord.verify,
};
