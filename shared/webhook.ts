// Discord webhook URLs — the pure rules, shared by all three sides.
//
// Kept out of electron/system/discordWebhook.ts (which does the actual POST
// through undici) so that the IPC validator and the renderer can both import
// the SAME rule without dragging a networking stack in behind it. Three
// copies of "what counts as a Discord webhook" would drift, and the one that
// mattered — the boundary check — would be the one nobody noticed had.
//
// ─── Why the host is pinned ──────────────────────────────────────────
//
// This is the only field in the app that accepts a URL from the renderer.
// Everywhere else the main process refuses on principle: the block-feed host
// is a pick from a hardcoded list precisely so no IPC channel ever carries
// one. A webhook cannot work that way — it is per user and unguessable by us
// — so the mitigation is an allowlist instead. Without it, this is a settings
// field that makes the app POST your flagged tokens to any host on the
// internet, which is a tidy exfiltration channel for anyone who can write
// that file or reach the renderer.

import { EVM_CHAIN_META, type ChainKind } from './evm';

/** Discord's webhook hosts. Nothing else is ever accepted. */
export const WEBHOOK_HOSTS = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'] as const;

const HOSTS = new Set<string>(WEBHOOK_HOSTS);

/** Long enough for any Discord webhook, short enough to be obviously bounded. */
export const MAX_WEBHOOK_CHARS = 400;

/**
 * Why this is not a usable Discord webhook URL, or null when it is fine.
 *
 * The empty string is "off", NOT an error: the field ships empty, and every
 * panel saves by spreading the stored block, so a default that failed its own
 * rule would make the whole settings page unsaveable — the exact trap that
 * broke execution settings for a release (2026-09-08).
 */
export function webhookUrlProblem(raw: string): string | null {
  const url = (raw ?? '').trim();
  if (!url) return null;
  if (url.length > MAX_WEBHOOK_CHARS) return 'that URL is too long to be a Discord webhook';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'that is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'a webhook URL must start with https://';
  if (!HOSTS.has(u.hostname)) {
    return `only Discord webhooks are accepted here, not ${u.hostname} — copy the URL from your channel's Integrations settings`;
  }
  // /api/webhooks/<id>/<token>, or /api/v10/webhooks/<id>/<token>.
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('webhooks');
  if (parts[0] !== 'api' || i === -1 || parts.length < i + 3) {
    return 'that is a Discord link but not a webhook URL — it should look like /api/webhooks/<id>/<token>';
  }
  return null;
}

/** Never let a webhook URL reach a log, a toast or the screen: the last path
 *  segment is the credential. This is what gets shown instead. */
export function redactWebhook(raw: string): string {
  const url = (raw ?? '').trim();
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('webhooks');
    const id = i !== -1 ? (parts[i + 1] ?? '') : '';
    return `${u.hostname}/…/${id ? `${id.slice(0, 6)}…` : ''}/•••`;
  } catch {
    return '(malformed)';
  }
}

/**
 * A public page a human can open for this token.
 *
 * Deliberately a PUBLIC link and not a deep link into the app: a webhook post
 * lands in a channel other people may read, on phones with no Krypto Bot
 * installed. The desktop notification is the one that opens the app.
 */
export function publicTokenUrl(chain: ChainKind, mint: string): string | null {
  if (!mint) return null;
  if (chain === 'solana') return `https://pump.fun/coin/${mint}`;
  const meta = EVM_CHAIN_META[chain];
  return meta ? `${meta.explorer}/token/${mint}` : null;
}
