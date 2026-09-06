// Trading from a paired chat — the rules, as pure functions.
//
// Until now the bots were read-only by construction, and the comment at the
// top of shared/bots.ts said a chat message must never be a step in the
// signing chain. This file is that decision being changed deliberately, so
// the reasoning belongs here rather than in a commit nobody reads:
//
// WHAT THE RISK ACTUALLY IS. A chat command cannot move SOL to a stranger —
// there is no withdraw command and the signer's policy refuses any
// destination that is not this install's own wallet. What someone with your
// Telegram account COULD do is make you trade: force-sell your bags (bad, but
// the proceeds land in your own wallet) or buy a token they control, which is
// a way to drain you. So buys and sells are not the same risk and are not
// gated the same way:
//
//   • Selling is allowed once trading is on. The worst case is an unwanted
//     exit, and being able to close a position from a phone is the entire
//     point of the feature.
//   • Buying is off by default, has its own switch, is bounded per trade and
//     per hour, and still passes through the per-trade cap the rest of the
//     app enforces.
//   • Every spending command needs a confirmation reply with a one-time code
//     that expires, so a single stolen message is not enough.
//
// The desktop remains the authority: caps live in settings, the app logs and
// announces every chat trade, and /lock disables chat trading immediately.

export interface BotTradePolicy {
  /** Master switch. Off = the bots are read-only, as they always were. */
  enabled: boolean;
  /** Buys are a separate, deliberate decision. */
  allowBuys: boolean;
  /** Largest single chat buy, SOL. */
  maxBuySol: number;
  /** Total chat buying allowed in a rolling hour, SOL. */
  hourlyCapSol: number;
  /** Require a /yes <code> reply before anything is signed. */
  requireConfirm: boolean;
}

export const DEFAULT_BOT_TRADE_POLICY: BotTradePolicy = {
  enabled: false,
  allowBuys: false,
  maxBuySol: 0.1,
  hourlyCapSol: 0.5,
  requireConfirm: true,
};

/** How long a confirmation code is good for. */
export const CONFIRM_TTL_MS = 60_000;
/** Chat commands that spend, per minute, however fast someone types. */
export const MAX_TRADES_PER_MINUTE = 4;

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface TradeIntent {
  kind: 'buy' | 'sell';
  mint: string;
  /** SOL for a buy; percent of the position for a sell. */
  amount: number;
}

/**
 * Parse a spending command. Returns null for anything that is not one, and a
 * REASON for something that looks like one but is malformed — silence is
 * right for a stranger, but the owner should be told why their typo failed.
 */
export function parseTradeCommand(text: string): { intent: TradeIntent } | { error: string } | null {
  const parts = text.trim().split(/\s+/);
  const head = (parts[0] ?? '').toLowerCase().replace(/^\//, '').split('@')[0];
  if (head !== 'buy' && head !== 'sell') return null;

  const mint = parts[1] ?? '';
  if (!MINT_RE.test(mint)) return { error: `Usage: /${head} <mint> ${head === 'buy' ? '<SOL>' : '[percent]'}` };

  if (head === 'buy') {
    const sol = Number(parts[2]);
    if (!Number.isFinite(sol) || sol <= 0) return { error: 'How much? e.g. /buy <mint> 0.05' };
    return { intent: { kind: 'buy', mint, amount: sol } };
  }
  const pct = parts[2] === undefined ? 100 : Number(parts[2]);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: 'Percent must be between 1 and 100, e.g. /sell <mint> 50' };
  return { intent: { kind: 'sell', mint, amount: pct } };
}

export interface TradeAttempt {
  at: number;
  kind: 'buy' | 'sell';
  sol: number;
}

/**
 * May this intent proceed? `recent` is the chat's own trade history, used for
 * the rolling caps. Refusals are worded for the person reading them on a
 * phone.
 */
export function checkTradeAllowed(
  intent: TradeIntent,
  policy: BotTradePolicy,
  recent: TradeAttempt[],
  now: number,
): { ok: boolean; reason: string } {
  if (!policy.enabled) return { ok: false, reason: 'Trading from chat is off. Turn it on in the app under Settings → Chat bots.' };
  if (intent.kind === 'buy' && !policy.allowBuys) {
    return { ok: false, reason: 'Buying from chat is off — only selling is allowed. Change it in the app.' };
  }

  const minuteAgo = now - 60_000;
  if (recent.filter((r) => r.at >= minuteAgo).length >= MAX_TRADES_PER_MINUTE) {
    return { ok: false, reason: 'Too many trades in the last minute. Wait a moment.' };
  }

  if (intent.kind === 'buy') {
    if (intent.amount > policy.maxBuySol) {
      return { ok: false, reason: `That is above the ${policy.maxBuySol} SOL per-trade limit for chat buys.` };
    }
    const hourAgo = now - 3_600_000;
    const spent = recent.filter((r) => r.at >= hourAgo && r.kind === 'buy').reduce((a, r) => a + r.sol, 0);
    if (spent + intent.amount > policy.hourlyCapSol) {
      const left = Math.max(0, policy.hourlyCapSol - spent);
      return { ok: false, reason: `That would pass the ${policy.hourlyCapSol} SOL hourly limit for chat buys (${left.toFixed(3)} SOL left this hour).` };
    }
  }
  return { ok: true, reason: 'ok' };
}

export interface PendingConfirm {
  code: string;
  intent: TradeIntent;
  createdAt: number;
}

/** A short code that is easy to retype on a phone and not guessable in one go. */
export function makeConfirmCode(seed: number): string {
  const n = Math.abs(Math.floor(seed)) % 10000;
  return String(n).padStart(4, '0');
}

/**
 * Does this message confirm the pending intent? A code is single-use: the
 * caller drops `pending` whether this passes or fails, so a replayed message
 * cannot trade twice.
 */
export function checkConfirm(text: string, pending: PendingConfirm | null, now: number): { ok: boolean; reason: string } {
  const parts = text.trim().split(/\s+/);
  const head = (parts[0] ?? '').toLowerCase().replace(/^\//, '').split('@')[0];
  if (head !== 'yes' && head !== 'confirm') return { ok: false, reason: '' };
  if (!pending) return { ok: false, reason: 'Nothing is waiting for confirmation.' };
  if (now - pending.createdAt > CONFIRM_TTL_MS) return { ok: false, reason: 'That confirmation expired. Send the command again.' };
  if ((parts[1] ?? '') !== pending.code) return { ok: false, reason: 'Wrong code.' };
  return { ok: true, reason: 'ok' };
}

/** What the bot says back before anything is signed. */
export function describeIntent(intent: TradeIntent, symbol: string): string {
  const what = symbol || `${intent.mint.slice(0, 6)}…`;
  return intent.kind === 'buy' ? `BUY ${intent.amount} SOL of ${what}` : `SELL ${intent.amount}% of ${what}`;
}
