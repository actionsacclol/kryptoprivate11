// Discord webhooks for runner flags — outbound only.
//
// ─── What this is NOT ────────────────────────────────────────────────
//
// This is not the chat bot. `system/bots.ts` is READ-ONLY, paired by a code,
// and silent to strangers — it answers questions from one owner and never
// initiates. A webhook is the opposite shape and has to be judged on its own
// terms: it is a URL the user copied out of their own Discord server, and the
// app POSTs to it unprompted.
//
// ─── Why the URL is pinned to Discord ────────────────────────────────
//
// Everywhere else in this app the main process refuses to take a URL from the
// renderer (the block-feed host is a pick from a hardcoded list for exactly
// this reason). A webhook cannot work that way — the URL is per user and
// unguessable by us. So the compromise is a host allowlist: the field accepts
// Discord's own webhook endpoints and nothing else, checked here AND at the
// IPC boundary in settingsValidation.ts.
//
// Without that, "Discord webhook" would be a free-text field in the settings
// file that makes the app POST your flagged tokens, wallet-free but still
// yours, to any host on the internet — a tidy exfiltration channel for anyone
// who can write that file or reach the renderer.
//
// ─── What is sent ────────────────────────────────────────────────────
//
// The same thing the desktop notification says, plus a link to the token.
// Nothing about the wallet, nothing about positions, no keys — a flag is a
// public fact about a public token.

import { request } from 'undici';
import { webhookUrlProblem } from '@shared/webhook';

// The URL rules live in shared/webhook.ts so the IPC validator and the
// renderer can import them without pulling undici in behind them. Re-exported
// here so callers that already talk to this module do not need both imports.
export { webhookUrlProblem, redactWebhook, publicTokenUrl } from '@shared/webhook';

/** Discord's own content cap is 2000; embed descriptions are 4096. Well under. */
const MAX_DESCRIPTION = 1800;
const TIMEOUT_MS = 6_000;

export interface WebhookFlag {
  title: string;
  body: string;
  /** Token address, for the link and the footer. */
  mint: string;
  /** Human chain name, e.g. "Solana" or "BNB Chain". */
  chainLabel: string;
  /** Where a human should go to look at it. */
  url: string | null;
}

export interface WebhookResult {
  ok: boolean;
  message: string;
}

/**
 * Post one flag. Never throws and never retries.
 *
 * No retry is deliberate. A flag is worth looking at for a couple of minutes;
 * a webhook that was down when it fired has nothing useful to say by the time
 * a backoff would have delivered it, and a queue of stale runner calls is
 * worse than silence. A 429 is reported as such so the caller can say so.
 */
export async function postFlag(webhookUrl: string, flag: WebhookFlag): Promise<WebhookResult> {
  const problem = webhookUrlProblem(webhookUrl);
  if (problem) return { ok: false, message: problem };
  const url = webhookUrl.trim();
  if (!url) return { ok: false, message: 'no webhook configured' };

  const description = flag.body.length > MAX_DESCRIPTION ? `${flag.body.slice(0, MAX_DESCRIPTION - 1)}…` : flag.body;
  const payload = {
    // `username` and no `content` keeps it a clean embed. allowed_mentions is
    // explicit and empty: a token name is attacker-controlled text, and a
    // coin called "@everyone" must not ping a server.
    username: 'Krypto Bot',
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: flag.title.slice(0, 240),
        description,
        url: flag.url ?? undefined,
        color: 0x8b7ce8,
        footer: { text: `${flag.chainLabel} · ${flag.mint}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
    });
    // Discord answers 204 with no body on success.
    const code = res.statusCode;
    res.body.dump().catch(() => undefined);
    if (code >= 200 && code < 300) return { ok: true, message: 'sent' };
    if (code === 401 || code === 403 || code === 404) {
      return { ok: false, message: `Discord rejected the webhook (${code}) — it may have been deleted or the URL is wrong` };
    }
    if (code === 429) return { ok: false, message: 'Discord is rate-limiting this webhook — this flag was dropped' };
    return { ok: false, message: `Discord answered ${code}` };
  } catch (e) {
    return { ok: false, message: (e as Error)?.message ?? 'the request failed' };
  }
}
