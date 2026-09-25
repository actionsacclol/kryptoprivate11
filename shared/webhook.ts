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

// ─── An embed a SCRIPT asks to post ──────────────────────────────────
//
// `bot.discord(inputName, embed)`. The script names one of its own `webhook`
// settings, never a URL — main resolves the URL from the answers the user
// typed into the script's form, so a script cannot aim a post anywhere the
// user did not paste. What the script supplies is only the embed, and that is
// rebuilt here field by field to Discord's own limits: anything unknown is
// dropped, every string is capped, and only https links survive. Mentions are
// always off (the payload sets allowed_mentions), so a coin called @everyone
// cannot ping a server.

export interface ScriptEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  author?: { name: string; url?: string; icon_url?: string };
  timestamp: string;
}

/** Discord's own caps, a little under where it matters. */
export const EMBED_LIMITS = { title: 256, description: 1800, fields: 10, fieldName: 256, fieldValue: 1024, footer: 200 } as const;

const httpsUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  try {
    return new URL(s).protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
};

/** Discord's nested shape ({url}, {text}) or the bare string, never an object's toString. */
const inner = (v: unknown, key: string): unknown =>
  typeof v === 'string' ? v : typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;

const cap = (raw: unknown, n: number): string => {
  const s = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * The embed as it will be sent, or why there is nothing to send.
 *
 * `label` is appended to the footer so a channel reader can always tell a
 * script posted it and which one; `paper` marks a rehearsal as one.
 */
export function scriptEmbed(
  raw: unknown,
  label: string,
  paper: boolean,
): { embed: ScriptEmbed } | { error: string } {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const title = cap(o.title, EMBED_LIMITS.title).trim();
  const description = cap(o.description, EMBED_LIMITS.description).trim();
  const fields = (Array.isArray(o.fields) ? o.fields : [])
    .slice(0, 50)
    .map((f) => (typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : {}))
    .map((f) => ({
      name: cap(f.name, EMBED_LIMITS.fieldName).trim(),
      value: cap(f.value, EMBED_LIMITS.fieldValue).trim(),
      inline: f.inline === true,
    }))
    // Discord refuses the whole post over one empty field name or value.
    .filter((f) => f.name && f.value)
    .slice(0, EMBED_LIMITS.fields);
  if (!title && !description && fields.length === 0) return { error: 'nothing to post — give the embed a title, description or fields' };

  const color = Number(o.color);
  const url = httpsUrl(o.url);
  const thumb = httpsUrl(inner(o.thumbnail, 'url'));
  const image = httpsUrl(inner(o.image, 'url'));
  const footerIn = cap(inner(o.footer, 'text'), EMBED_LIMITS.footer - 60).trim();
  const authorIn = (typeof o.author === 'object' && o.author !== null ? o.author : {}) as Record<string, unknown>;
  const authorName = cap(typeof o.author === 'string' ? o.author : authorIn.name, 256).trim();
  const authorUrl = httpsUrl(authorIn.url);
  const authorIcon = httpsUrl(authorIn.icon_url ?? authorIn.iconUrl);
  const tag = `${paper ? 'PAPER · ' : ''}Krypto Bot script: ${cap(label, 40)}`;

  return {
    embed: {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(Number.isInteger(color) && color >= 0 && color <= 0xffffff ? { color } : {}),
      ...(fields.length ? { fields } : {}),
      ...(thumb ? { thumbnail: { url: thumb } } : {}),
      ...(image ? { image: { url: image } } : {}),
      ...(authorName ? { author: { name: authorName, ...(authorUrl ? { url: authorUrl } : {}), ...(authorIcon ? { icon_url: authorIcon } : {}) } } : {}),
      footer: { text: footerIn ? `${footerIn} · ${tag}` : tag },
      timestamp: new Date().toISOString(),
    },
  };
}

// ─── The callout embed ───────────────────────────────────────────────
//
// The Auto-callout page's Discord post (asked 09-23): the same layout the
// scorenow script posts its calls in, so both read as one thing in a channel.
// Built here, from facts main already holds, and shaped to Discord's limits
// by scriptEmbed's rules. Unknown numbers render as an em dash, never 0.

export const KRYPT_BOT_URL = 'https://krypt.cc/bot';

export interface CalloutEmbedFacts {
  mint: string;
  name: string | null;
  symbol: string | null;
  /** The text that went out. */
  thesis: string;
  /** The callout's public pump.fun page; null when pump did not say its id. */
  link: string | null;
  mcUsd: number | null;
  holders: number | null;
  buyers: number | null;
  curvePct: number | null;
  imageUrl: string | null;
  /** The Send-test button: says so in the title and the text. */
  test?: boolean;
}

const usd = (n: number | null): string =>
  n === null || !Number.isFinite(n)
    ? '—'
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(1)}k`
        : `$${Math.round(n)}`;

const count = (n: number | null): string =>
  n === null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

export function calloutEmbed(f: CalloutEmbedFacts): ScriptEmbed {
  const coinPage = `https://pump.fun/coin/${f.mint}`;
  const who =
    f.name && f.symbol ? `${f.name} ($${f.symbol})` : f.name || (f.symbol ? `$${f.symbol}` : `${f.mint.slice(0, 8)}…`);
  const raw = {
    author: { name: 'Krypto Bot · new call', url: KRYPT_BOT_URL },
    title: `${f.test ? '🧪 TEST — ' : ''}📣 ${who}`,
    url: f.link ?? coinPage,
    description: [
      `> ${f.thesis}`,
      '',
      f.link ? `**[→ Open the callout on pump.fun](${f.link})**` : null,
      '',
      '*Not financial advice.*',
      f.test ? '*This is a test post: no call was made.*' : null,
    ]
      .filter((x) => x !== null)
      .join('\n'),
    color: 0x22c55e,
    thumbnail: f.imageUrl ? { url: f.imageUrl } : undefined,
    fields: [
      { name: 'Market cap', value: usd(f.mcUsd), inline: true },
      { name: 'Holders', value: count(f.holders), inline: true },
      { name: 'Buyers', value: count(f.buyers), inline: true },
      { name: 'Curve', value: f.curvePct === null || !Number.isFinite(f.curvePct) ? '—' : `${Math.round(f.curvePct)}%`, inline: true },
      {
        name: 'Links',
        value: [
          f.link ? `[Callout](${f.link})` : null,
          `[DexScreener](https://dexscreener.com/solana/${f.mint})`,
          `[Krypto Bot](${KRYPT_BOT_URL})`,
        ]
          .filter(Boolean)
          .join(' · '),
        inline: false,
      },
    ],
  };
  const built = scriptEmbed(raw, 'auto-callout', false);
  // Never empty (a title is always set), so the error branch cannot happen;
  // the footer is ours, not a script's, so it is set after.
  const embed = 'embed' in built ? built.embed : { title: raw.title, timestamp: new Date().toISOString() };
  return { ...embed, footer: { text: 'krypt.cc/bot · Krypto Bot auto-callout' } };
}

/** A Discord message id: a snowflake, digits only. It becomes a path segment,
 *  so nothing else is accepted. */
export function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{15,25}$/.test(v);
}

/**
 * The URL for one webhook call (2026-09-25, call outcomes):
 *   • no message id → the post URL with `?wait=true`, so Discord answers with
 *     the message it created (and its id) instead of a bare 204;
 *   • a message id → `/messages/<id>`, to EDIT that one message.
 * Any other query (a `thread_id`) is kept, so a thread post edits in its thread.
 * Only ever called on a URL `webhookUrlProblem` already passed.
 */
export function webhookCallUrl(raw: string, messageId?: string): string {
  const u = new URL(raw.trim());
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('webhooks');
  u.pathname = `/${parts.slice(0, i + 3).join('/')}${messageId ? `/messages/${messageId}` : ''}`;
  if (messageId) u.searchParams.delete('wait');
  else u.searchParams.set('wait', 'true');
  return u.toString();
}
