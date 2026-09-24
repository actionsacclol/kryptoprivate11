// Auto-callout — post a pump.fun callout on the coins you buy.
//
// A callout is a public statement, under your name, that other people trade
// against. pump ranks callers and pays them out of the volume a call brings
// in, so this is a promotion tool as much as a record: what goes out matters.
//
// ─── What pump itself allows (measured 2026-09-22) ───────────────────────
//
// The preflight at `/callout/eligibility/{mint}` is the gate, and it is worth
// reading before assuming anything:
//
//   • You must HOLD the coin, worth at least ONE DOLLAR. A wallet with no
//     position is refused with `INSUFFICIENT_BALANCE` and `position: null`
//     beside it. That floor is low enough that an ordinary buy clears it,
//     which is why this works on buy at all.
//   • ONE CALLOUT per coin, per account. `postableAccounts[0].existingCalloutId`
//     comes back with the uuid of the one that already exists — the same id a
//     pump.fun link carries as `highlight_callout=`. A second call is not a
//     thing; a REPLY is (see below). No edit route is known.
//   • `attemptsRemaining` is 3, under `preflight.create`. What it counts is
//     NOT known — it was read as "three callouts per coin" until the one-per-
//     coin rule turned up, and a number whose meaning is a guess is not a
//     number to build on. It is still obeyed at zero, which costs nothing.
//   • `cooldownRemainingSeconds` sits under `preflight.reply`, and it means
//     what it says: the gap between REPLIES. It refused first-ever callouts
//     until 2026-09-22.
//   • Lifetime counts among live callers run to 203 with a median of 64, so
//     there is no global cap.
//
// So the preflight is asked every time and its answer is obeyed. Nothing here
// invents a limit pump does not have, and nothing here works around one it
// does.
//
// ─── Why the text is a list ──────────────────────────────────────────────
//
// The same sentence on every coin is a signature, and a caller whose every
// call reads identically is one people mute. A list of lines, one picked at
// random, is what the user asked for and is also the version that stays
// readable. It is NOT a way to look like several different people — the calls
// all carry the same wallet and pump shows the caller's position on each.

import { webhookUrlProblem } from './webhook';

/** Longest a single thesis may be. The real ones are short — "Runner" and a
 *  dozen words are typical in the live feed. */
export const MAX_THESIS = 200;

// ── The watermark ─────────────────────────────────────────────────────
//
// Every auto-posted callout ends with a mark saying it came from here.
//
// It is DISCLOSURE before it is promotion. A callout posted by a machine the
// instant a buy confirms is not the same thing as one someone sat down and
// wrote, and a reader deciding whether to trade on it deserves to know which
// they are looking at. That it also says where it came from is a side effect
// rather than the point.
//
// It is shown in the form, and the character budget below is what is left for
// the user's own words — the same rule the launch description follows.

export const CALLOUT_WATERMARK = 'Called with krypt.cc/bot';

/** Between the user's words and the mark: a new line, so the mark stands on
 *  its own under the call instead of running on from it (asked 09-22). */
const WATERMARK_SEP = '\n';

/** The mark this app used before, so text stamped with it is re-stamped with
 *  the current mark rather than carrying both. */
const LEGACY_CALLOUT_MARKS = ['via krypt.cc/tools/krypto'];

/**
 * A thesis as it will actually be posted.
 *
 * Idempotent: the form marks it for display and main marks it again on the
 * way out, so one that already carries the mark is returned unchanged.
 */
export function withCalloutWatermark(thesis: string): string {
  let body = (thesis ?? '').trim();
  for (const old of LEGACY_CALLOUT_MARKS) {
    if (body.endsWith(old)) body = body.slice(0, -old.length).replace(/[\s·]+$/, '');
  }
  if (!body) return CALLOUT_WATERMARK;
  if (body.endsWith(CALLOUT_WATERMARK)) return body;
  return `${body}${WATERMARK_SEP}${CALLOUT_WATERMARK}`;
}

/** What is left for the user's own words once the mark is accounted for. */
export const THESIS_BUDGET = MAX_THESIS - (CALLOUT_WATERMARK.length + WATERMARK_SEP.length);

// ─── Variables in a line ─────────────────────────────────────────────────
//
// `{ticker}` and friends, so one list of lines works across coins instead of
// being written per coin. The braces match the app's own rule variables
// (`fill` in electron/engine/automation.ts), which is what the Scripts page
// already documents; `<ticker>` is accepted too, because that is what someone
// types first and a public post reading "<ticker> looks good" is a worse
// outcome than supporting one extra spelling.
//
// A value nobody knows renders as an em dash, never as 0 or a blank — the
// house rule, and here it also keeps the sentence honest: "— market cap" is
// visibly missing information, where "$0" is a claim.

/** What a line may name, and what each one means. Shown in the UI. */
export const CALLOUT_VARS: Array<{ name: string; means: string }> = [
  { name: 'ticker', means: 'the coin’s symbol' },
  { name: 'name', means: 'its full name' },
  { name: 'mc', means: 'market cap, short ($1.2M)' },
  { name: 'price', means: 'price in USD' },
  { name: 'holders', means: 'holder count' },
  { name: 'buyers', means: 'unique buyers so far' },
  { name: 'liq', means: 'liquidity, short' },
  { name: 'mint', means: 'the first 8 characters of the address' },
];

export interface CalloutFacts {
  ticker?: string | null;
  name?: string | null;
  mc?: number | null;
  price?: number | null;
  holders?: number | null;
  buyers?: number | null;
  liq?: number | null;
  mint?: string | null;
}

/** $1.2M / $12.3K / $940 — short enough to sit in a sentence. */
export function shortUsd(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(0)}`;
  return `$${v.toPrecision(2)}`;
}

/**
 * Put the coin's facts into a line.
 *
 * Both `{ticker}` and `<ticker>` are read. An unknown name is left exactly as
 * written — a typo should look like a typo, not vanish from a public post.
 */
export function fillCallout(text: string, facts: CalloutFacts): string {
  const known = new Set(CALLOUT_VARS.map((v) => v.name));
  return (text ?? '').replace(/[{<](\w+)[}>]/g, (whole, key: string) => {
    if (!known.has(key)) return whole;
    switch (key) {
      case 'ticker':
        return facts.ticker || '—';
      case 'name':
        return facts.name || '—';
      case 'mc':
        return shortUsd(facts.mc);
      case 'liq':
        return shortUsd(facts.liq);
      case 'price':
        return typeof facts.price === 'number' && Number.isFinite(facts.price)
          ? `$${facts.price < 0.01 ? facts.price.toPrecision(2) : facts.price.toFixed(facts.price < 1 ? 4 : 2)}`
          : '—';
      case 'holders':
        return typeof facts.holders === 'number' ? String(facts.holders) : '—';
      case 'buyers':
        return typeof facts.buyers === 'number' ? String(facts.buyers) : '—';
      case 'mint':
        return facts.mint ? facts.mint.slice(0, 8) : '—';
      default:
        return whole;
    }
  });
}

/** More than this many variants is a list nobody is curating. */
export const MAX_THESES = 30;

export interface AutoCalloutSettings {
  /** Off by default. Nothing is posted until this is switched on. */
  enabled: boolean;
  /**
   * One line per variant; a random one is used per callout.
   *
   * Stored as typed, blank lines and all, so the textarea round-trips exactly
   * what the user wrote. `thesesOf` is what reads it.
   */
  text: string;
  /**
   * Buys smaller than this are not called out. 0 = every buy.
   *
   * Not a limit pump imposes — it is here because calling every scratch trade
   * spends the standing that the payout actually tracks, and the volume a
   * call brings is what earns.
   */
  minBuySol: number;
  /**
   * The account that posted a callout likes it straight after (asked 09-22).
   * The like is the author's own, shown under their name, so it claims
   * nothing about anybody else. On by default; applies to every callout the
   * app posts — on a buy, from a script, or the test button.
   */
  likeOwn: boolean;
  /**
   * Post each auto-callout to this Discord webhook too (asked 09-23), in the
   * same embed as the scorenow script's calls. Empty = off. Discord's hosts
   * only — checked here, at the IPC boundary, and again before the POST.
   * A credential: never logged or rendered in full.
   */
  discordWebhookUrl: string;
  /**
   * Also call out a coin you LAUNCH (asked 2026-09-23), once your dev buy is
   * worth more than `launchMinUsd`, posted after a short delay so the coin
   * has a moment of life and pump does not drop a call made the same second
   * as the create. Uses the same text/likeOwn/webhook as any auto-callout.
   * On by default, but nothing posts until callout text is written.
   */
  onLaunch: boolean;
  /** A launch is only called out when its dev buy is worth more than this in
   *  USD (pump's own floor is $1; the default here is stricter). 0 = any. */
  launchMinUsd: number;
}

/** How long after a launch's dev buy the callout waits. Fixed: a brand-new
 *  coin needs a moment, and a call made the instant of the create is the kind
 *  pump was seen to drop (see the callout-latency notes). */
export const LAUNCH_CALLOUT_DELAY_MS = 30_000;

export const DEFAULT_AUTO_CALLOUT: AutoCalloutSettings = {
  enabled: false,
  text: '',
  minBuySol: 0,
  likeOwn: true,
  discordWebhookUrl: '',
  onLaunch: true,
  launchMinUsd: 2,
};

/** The usable variants: non-empty lines, trimmed, capped in length and count. */
export function thesesOf(text: string): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_THESES)
    // Cut to the BUDGET, not the raw cap: the mark is appended afterwards and
    // a line filling the whole cap would lose its tail to the slice.
    .map((l) => l.slice(0, THESIS_BUDGET));
}

/**
 * One variant, chosen at random. Null when there are none to choose from.
 *
 * `rand` is injected so a test can assert the choice rather than sampling it.
 */
export function pickThesis(text: string, rand: () => number = Math.random): string | null {
  const list = thesesOf(text);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/**
 * Why auto-callout cannot run as configured, or null when it can.
 *
 * Checked in the form so the switch can explain itself, and again in main
 * before anything is posted.
 */
export function autoCalloutProblem(s: AutoCalloutSettings): string | null {
  // First, and whether or not calling is on: a webhook is saved on its own,
  // and a bad one must be refused when it is typed, not when it is switched on.
  const hook = webhookUrlProblem(s.discordWebhookUrl ?? '');
  if (hook) return `Discord webhook: ${hook}.`;
  // The launch floor is checked whether or not on-buy calling is enabled:
  // "call out coins I launch" is its own switch. Guarded on presence — a
  // partial or pre-field object is not malformed (the store fills the default).
  if (typeof s.launchMinUsd === 'number' && (s.launchMinUsd < 0 || s.launchMinUsd > 100_000)) {
    return 'The launch call minimum must be between 0 and 100,000 USD.';
  }
  if (!s.enabled) return null; // off is not a problem, it is the default
  if (thesesOf(s.text).length === 0) {
    return 'Add at least one line of text to post. A callout with nothing written on it is not worth making.';
  }
  if (!Number.isFinite(s.minBuySol) || s.minBuySol < 0 || s.minBuySol > 100) {
    return 'The minimum buy must be between 0 and 100 SOL.';
  }
  return null;
}

// ─── The create call ─────────────────────────────────────────────────────
//
// OBSERVED on 2026-09-22 by watching a real callout being posted, because it
// is not discoverable by probing: `/callout/eligibility/{mint}`,
// `/callout/top/{mint}` and `/callout/{uuid}` answer, but `POST /callout`,
// `/callouts`, `/callout/{mint}` and `/coins/{mint}/callout` are all 404.
//
//   POST https://frontend-api-v3.pump.fun/callout/create  →  201 Created
//
// AUTH IS A COOKIE, not a bearer token. The preflight answers
// `access-control-allow-headers: content-type`, so a browser cannot send an
// Authorization header at all, and `access-control-allow-credentials: true`
// is how the session rides along. This app is not a browser and can send
// both — see electron/engine/autoCallout.ts, which sets the `auth_token`
// cookie (the name their own login sets) and an Authorization header beside
// it, so whichever the guard reads is there.

/** The path a callout is created at. */
export const CALLOUT_CREATE_PATH: string | null = '/callout/create';

/**
 * The minimum position pump requires, in USD.
 *
 * Their preflight refuses with `INSUFFICIENT_BALANCE` below it. Confirmed at
 * one dollar (2026-09-22); the smallest real call seen in the live feed held
 * $2.13 of cost basis, which is consistent. Recorded so the UI can say the
 * number rather than leaving someone to discover it as a refusal.
 */
export const MIN_CALLOUT_POSITION_USD = 1;

/**
 * Solana mainnet, as pump identifies a chain in a callout.
 *
 * Their callouts are multi-chain — the live feed carries hyperevm and arc
 * rows this app has no rail for — so the chain is named in the body rather
 * than implied. This app only calls out Solana buys, because that is the only
 * side `postCallout` is wired to; an EVM buy would need this to be that
 * chain's id, not this one.
 */
export const SOLANA_CHAIN_ID = 1_399_811_149;

/**
 * The payload version pump's own client sends.
 *
 * If they bump it, posts made with the old number are likely to be refused —
 * so it is a named constant rather than an inline 2, and a 400 mentioning a
 * version is the first thing to check here.
 */
export const CALLOUT_BODY_VERSION = 2;

/**
 * The request body, exactly as pump's own client sends it.
 *
 * OBSERVED 2026-09-22 from a real callout:
 *
 *   { coinMint, thesis, chainId: 1399811149, version: 2 }
 *
 * `coinMint` rather than `mint`, which is why this was not guessed: the wrong
 * field name is a 400 on every buy that reads as a bug in our posting.
 *
 * Null when either half is missing — an empty thesis is not a callout, and a
 * request without a mint is not one either.
 */
export function calloutBody(mint: string, thesis: string): Record<string, unknown> | null {
  const m = (mint ?? '').trim();
  const t = (thesis ?? '').trim();
  if (!m || !t) return null;
  // Marked HERE, on the way out, so a caller cannot post an unmarked one.
  // Idempotent, so the form showing it and this applying it never double it.
  return {
    coinMint: m,
    // Clamp the caller's text to THESIS_BUDGET FIRST, so the watermark is
    // always what remains — never the part sliced off. fillCallout expands a
    // template ({price} etc.) AFTER the per-line clamp, so a variable-stuffed
    // line could otherwise push the "Called with krypt.cc/bot" disclosure off
    // the end of a public post (audit 2026-09-23). The outer slice is then a
    // no-op guard.
    thesis: withCalloutWatermark(t.slice(0, THESIS_BUDGET)).slice(0, MAX_THESIS),
    chainId: SOLANA_CHAIN_ID,
    version: CALLOUT_BODY_VERSION,
  };
}

// ─── Replying to a callout ───────────────────────────────────────────────
//
// OBSERVED 2026-09-22, from a real reply:
//
//   POST frontend-api-v3.pump.fun/callout/<uuid>/replies  →  201 Created
//   { "content": "…" }                                        69 bytes
//
// A callout is ONE per coin per account, so a reply is how you UPDATE one —
// that is what this is for, and it is what pump's own client sends when you
// add to a call. It does not rewrite the original; it appends, and it
// RE-BUMPS the callout, which is the actual reason to send one.
//
// That bump is worth stating plainly, because it is what makes an automated
// reply loop tempting: the only things pacing it are pump's reply cooldown
// (`preflight.reply.cooldownRemainingSeconds`), their 10-per-60s limit, and
// the calling script's own action budget. Nothing here adds a bump of its own
// accord — a reply is sent when something asks for one.
//
// This is what `preflight.reply.cooldownRemainingSeconds` was always talking
// about. That field was being used to refuse a CREATE, which it never
// described — see `refusal` in electron/engine/autoCallout.ts.
//
// Rate limit, from the response headers: `x-ratelimit-limit: 10` with
// `x-ratelimit-reset: 60`. Tighter than the profile's 30/120, and the reason
// replies are one-at-a-time rather than a loop.

/** The path a reply is posted at, built from the callout's own id. */
export function calloutReplyPath(calloutId: string): string | null {
  return looksLikeCalloutId(calloutId) ? `/callout/${calloutId}/replies` : null;
}

/**
 * A callout id, as `highlight_callout=` carries it and as the eligibility
 * preflight returns it: a plain UUID.
 *
 * Checked because the id is the only caller-supplied part of the path. A
 * value that is not a UUID cannot become a path segment.
 */
export function looksLikeCalloutId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((id ?? '').trim());
}

/**
 * Longest a reply may be.
 *
 * pump's own limit is NOT known — the observed reply was 55 characters, which
 * says nothing about the ceiling. This is "nothing absurd gets sent"; their
 * refusal is the authority.
 */
export const MAX_REPLY = 500;

/** What is left for the user's own words once the mark is accounted for. */
export const REPLY_BUDGET = MAX_REPLY - (CALLOUT_WATERMARK.length + WATERMARK_SEP.length);

/**
 * The reply body, in the shape observed.
 *
 * Marked like a callout, and for the same reason: a reply posted by a machine
 * is not a reply somebody sat down and wrote, and it can be read on its own
 * away from the call it hangs under. Null when there is nothing to say.
 */
export function replyBody(content: string): Record<string, unknown> | null {
  const c = (content ?? '').trim();
  if (!c) return null;
  // Same as calloutBody: clamp first so the watermark is never truncated.
  return { content: withCalloutWatermark(c.slice(0, REPLY_BUDGET)).slice(0, MAX_REPLY) };
}

/** Whether posting is possible in this build at all. Needs the route AND the
 *  body shape — having one without the other posts nothing. */
export function canPostCallouts(): boolean {
  return CALLOUT_CREATE_PATH !== null && calloutBody('x', 'y') !== null;
}

/** What a callout attempt did, for the record and the log. */
export interface CalloutOutcome {
  ok: boolean;
  /** Our words or pump's, whichever explains it. */
  message: string;
  /** The verdict the preflight gave, when it was asked. */
  verdict?: string;
  /** The text that went out, when one did. */
  thesis?: string;
  /** pump's id for the callout that went out, when it could be learned —
   *  what a like or a reply names. Null when neither the create answer nor a
   *  second preflight gave it. */
  calloutId?: string | null;
  /** pump's id for a REPLY that went out, when its answer carried one — the
   *  last segment of the reply's public link. */
  replyId?: string | null;
}

/** A reply's own id out of pump's reply answer. Not `calloutIdFrom`: that
 *  reads `calloutId` first, which on a reply is the PARENT. */
export function replyIdFrom(raw: string): string | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const inner = j && typeof j.reply === 'object' && j.reply ? (j.reply as Record<string, unknown>) : {};
    for (const v of [j?.replyId, j?.id, inner.replyId, inner.id]) {
      if (typeof v === 'string' && UUID.test(v)) return v.toLowerCase();
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * The public page for a callout, or for one reply in its thread — the same
 * paths pump.fun's own share button builds (read out of its web bundle,
 * 2026-09-23). Null unless every part is the shape pump uses, so a link is
 * never built from something a caller made up.
 */
export function calloutPageUrl(mint: string, calloutId: string, replyId?: string | null): string | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint ?? '') || !UUID.test(calloutId ?? '')) return null;
  const base = `https://pump.fun/callouts/${mint}/${calloutId.toLowerCase()}`;
  return replyId && UUID.test(replyId) ? `${base}/${replyId.toLowerCase()}` : base;
}

/** The new callout's id out of pump's create answer, whatever its shape. The
 *  answer's schema was never observed, so this reads defensively: `id`,
 *  `calloutId`, or either inside `callout`, and only a UUID counts. */
export function calloutIdFrom(raw: string): string | null {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const inner = j && typeof j.callout === 'object' && j.callout ? (j.callout as Record<string, unknown>) : {};
    for (const v of [j?.calloutId, j?.id, inner.calloutId, inner.id]) {
      if (typeof v === 'string' && UUID.test(v)) return v.toLowerCase();
    }
  } catch {
    /* not JSON */
  }
  return null;
}
