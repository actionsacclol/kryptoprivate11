// Posting a pump.fun callout on a coin you just bought.
//
// The rules and the settings live in shared/calloutAuto.ts. This is the side
// that talks to pump.
//
// ─── The preflight is the gate, and it is obeyed ─────────────────────────
//
// pump's own `/callout/eligibility/{mint}` says whether this account may call
// this coin right now, and why not when it may not. It is asked EVERY time
// rather than assumed, because the answer depends on things this app does not
// track: whether the position is still held, how many of the three attempts
// on this coin are left, and whether a cooldown is running.
//
// Nothing here invents a limit pump does not have, and nothing works around
// one it does. A refusal is recorded and reported, not retried.
//
// ─── Which account posts ─────────────────────────────────────────────────
//
// The one belonging to the WALLET THAT BOUGHT. That is the wallet holding the
// coin, so it is the only one pump would accept, and it is the honest author
// of the call. A wallet with no pump session does not post at all.

import { logger } from '../system/logger';
import * as pumpAuth from '../system/pumpAuth';
import { act as socialAct, ensureRegistered } from '../system/pumpSocial';
import { PUMP_API_HOST } from '@shared/pumpAuth';
import {
  CALLOUT_CREATE_PATH,
  calloutBody,
  calloutReplyPath,
  replyBody,
  canPostCallouts,
  pickThesis,
  fillCallout,
  type AutoCalloutSettings,
  type CalloutFacts,
  type CalloutOutcome,
  calloutIdFrom,
  replyIdFrom,
} from '@shared/calloutAuto';

/** Built from the constant host; never from anything a caller supplies. */
const urlFor = (route: string): string => `https://${PUMP_API_HOST}${route}`;

interface Preflight {
  eligible: boolean;
  verdict: string;
  attemptsRemaining: number | null;
  cooldownSeconds: number | null;
  /** Already called this coin from this account. */
  existingCalloutId: string | null;
}

/**
 * What pump says about calling this coin from this account.
 *
 * Every number is nullable: a shape that changed on their side must read as
 * unknown rather than as zero attempts left or no cooldown.
 */
export async function preflight(mint: string, token: string): Promise<Preflight | null> {
  try {
    const res = await fetch(urlFor(`/callout/eligibility/${encodeURIComponent(mint)}`), {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      eligible?: unknown;
      preflight?: {
        create?: { verdict?: unknown; attemptsRemaining?: unknown };
        reply?: { cooldownRemainingSeconds?: unknown };
        postableAccounts?: Array<{ existingCalloutId?: unknown }>;
      };
    };
    const create = j.preflight?.create;
    const acct = j.preflight?.postableAccounts?.[0];
    return {
      eligible: j.eligible === true,
      verdict: typeof create?.verdict === 'string' ? create.verdict : 'UNKNOWN',
      attemptsRemaining: typeof create?.attemptsRemaining === 'number' ? create.attemptsRemaining : null,
      cooldownSeconds:
        typeof j.preflight?.reply?.cooldownRemainingSeconds === 'number' ? j.preflight.reply.cooldownRemainingSeconds : null,
      existingCalloutId: typeof acct?.existingCalloutId === 'string' ? acct.existingCalloutId : null,
    };
  } catch {
    return null;
  }
}

/**
 * Why the preflight's answer means "do not CREATE a callout", in plain words.
 *
 * The cooldown is deliberately NOT here. It is read from
 * `preflight.reply.cooldownRemainingSeconds`, and once replies turned out to
 * be a real, separate action (2026-09-22) it was plain that a reply's cooldown
 * had been refusing first-ever callouts — a coin nobody has called cannot be
 * in a reply cooldown, and skipping the post was silent. It gates replies now,
 * in `replyRefusal`.
 *
 * If that reading is wrong and pump does apply it to creates, the cost is one
 * refusal from their server, reported in their words and not retried — not a
 * loop. That is the right way round for a guess this size.
 */
function refusal(p: Preflight): string | null {
  if (p.existingCalloutId) return 'you have already called this coin — reply to it instead';
  if (p.attemptsRemaining !== null && p.attemptsRemaining <= 0) return 'no attempts left on this coin';
  if (!p.eligible) return `pump says ${p.verdict.toLowerCase().replace(/_/g, ' ')}`;
  if (p.verdict === 'INSUFFICIENT_BALANCE') return 'the position is too small for pump to accept a call';
  return null;
}

/** Why a reply cannot go now. The cooldown's actual job. */
function replyRefusal(p: Preflight): string | null {
  if (!p.existingCalloutId) return 'you have not called this coin yet, so there is nothing to reply to';
  if (p.cooldownSeconds !== null && p.cooldownSeconds > 0) return `pump is cooling down for another ${p.cooldownSeconds}s`;
  return null;
}

/**
 * Post one callout, now, as this wallet, with this exact text.
 *
 * The one place a callout is actually created. Everything that posts —
 * auto-callout on a buy, a script calling `bot.callout`, the test button on
 * the Auto-callout page — comes through here, so the preflight is asked, the
 * refusal is obeyed and the watermark is applied on every path. There is no
 * second way to reach pump's create route.
 *
 * Never throws at the caller: some callers run off the back of a trade that
 * already succeeded, and a social post failing must not read as a failed
 * trade.
 */
export async function postNow(
  walletId: string,
  mint: string,
  thesis: string,
  opts: { likeOwn?: boolean } = {},
): Promise<CalloutOutcome> {
  const text = (thesis ?? '').trim();
  if (!text) return { ok: false, message: 'there is no text to post' };
  // The account belonging to the wallet that holds the coin — the only one
  // pump would accept, and the honest author of the call.
  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, message: 'that wallet has no pump.fun account signed in' };
  // An API sign-in is not a full pump user until /users/register (seen 09-22
  // refusing likes with "no coin-communities profile"); once per session.
  await ensureRegistered(walletId);

  const pre = await preflight(mint, token);
  if (!pre) return { ok: false, message: 'pump did not answer the eligibility check' };
  const no = refusal(pre);
  if (no) return { ok: false, message: no, verdict: pre.verdict };

  if (!canPostCallouts() || !CALLOUT_CREATE_PATH) {
    // Honest refusal rather than a guessed route: a wrong path fails at their
    // server on every buy and reads as a bug in our posting.
    return {
      ok: false,
      message: 'this build does not know how pump creates a callout yet, so nothing was posted',
      verdict: pre.verdict,
      thesis: text,
    };
  }

  const body = calloutBody(mint, text);
  if (!body) {
    return {
      ok: false,
      message: 'this build does not know the shape of pump’s callout request yet, so nothing was posted',
      verdict: pre.verdict,
      thesis: text,
    };
  }

  try {
    const res = await fetch(urlFor(CALLOUT_CREATE_PATH), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // BOTH, deliberately. Their browser client authenticates with the
        // `auth_token` COOKIE — the preflight allows only `content-type` as a
        // request header, so a browser cannot send Authorization at all. This
        // app is not a browser and can send either, and the two carry the
        // same JWT, so whichever the guard reads is present.
        cookie: `auth_token=${token}`,
        authorization: `Bearer ${token}`,
        // Their CORS is origin-scoped and the server may check it. This is
        // the origin their own client sends.
        origin: 'https://pump.fun',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      let why = `pump refused the callout (${res.status})`;
      try {
        const j = JSON.parse(raw) as { message?: unknown };
        if (typeof j.message === 'string' && j.message) why = `pump: ${j.message}`;
      } catch {
        /* not JSON — the status is what we have */
      }
      return { ok: false, message: why, verdict: pre.verdict, thesis: text };
    }
    // What went out, in full, including the watermark — the log is the record
    // of a PUBLIC post made under the user's name, so it quotes the posted
    // text rather than the text that was asked for.
    const posted = String(body.thesis ?? text);
    logger.info(`callout posted on ${mint.slice(0, 8)}… — "${posted}"`);
    // The id, for a script that likes or replies to it. From the create answer
    // if it carries one, else from a second preflight, which reports this
    // account's existing callout on the coin. Best effort: a post that went
    // out is ok whether or not its id could be learned.
    let calloutId = calloutIdFrom(raw);
    if (!calloutId) calloutId = (await preflight(mint, token).catch(() => null))?.existingCalloutId ?? null;
    // The author likes their own call (Auto-callout › "Like your own
    // callouts"). Best effort: the post went out whatever this does.
    let message = `Called ${mint.slice(0, 6)}… on pump.fun`;
    if (opts.likeOwn && calloutId) {
      const liked = await socialAct(walletId, 'like', calloutId);
      message += liked.ok ? ' and liked it' : ` (could not like it: ${liked.message})`;
    }
    return { ok: true, message, verdict: pre.verdict, thesis: posted, calloutId };
  } catch (err) {
    return { ok: false, message: `could not reach pump.fun: ${(err as Error).message}`, verdict: pre.verdict, thesis: text };
  }
}

/**
 * Post a callout for a coin this wallet just bought.
 *
 * The auto path: the switch, the minimum buy size and the random line from
 * the user's list. The posting itself is `postNow`.
 */
export async function postCallout(
  walletId: string,
  mint: string,
  settings: AutoCalloutSettings,
  boughtSol: number,
  facts?: CalloutFacts,
): Promise<CalloutOutcome> {
  if (!settings.enabled) return { ok: false, message: 'auto-callout is off' };
  if (settings.minBuySol > 0 && boughtSol < settings.minBuySol) {
    return { ok: false, message: `buy of ${boughtSol} SOL is under your ${settings.minBuySol} SOL minimum` };
  }
  // Chosen BEFORE the eligibility round trip: a script or a settings page with
  // no text configured is refused for free rather than after asking pump.
  const thesis = pickThesis(settings.text);
  if (!thesis) return { ok: false, message: 'no text configured to post' };
  // Fill {ticker}/{mc}/… from the coin's facts. Without this the on-buy path
  // posted the template LITERALLY ("{ticker} {name}") — the script and launch
  // paths already filled, this one did not (fixed 2026-09-23).
  const text = facts ? fillCallout(thesis, facts) : thesis;
  return postNow(walletId, mint, text, { likeOwn: settings.likeOwn });
}

/**
 * Reply to the callout this wallet already made on a coin.
 *
 * A callout is one per coin per account and there is no edit route in hand, so
 * this is how a call is followed up as the coin moves — and a thread that
 * grows is the honest shape anyway: a silent edit rewrites a statement other
 * people have already traded against.
 *
 * The callout's id comes from pump's own preflight, never from a caller, and
 * it is checked as a UUID before it becomes part of a path.
 *
 * Never throws at the caller.
 */
export async function replyNow(walletId: string, mint: string, content: string): Promise<CalloutOutcome> {
  const text = (content ?? '').trim();
  if (!text) return { ok: false, message: 'there is no text to reply with' };

  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, message: 'that wallet has no pump.fun account signed in' };
  await ensureRegistered(walletId); // see postNow

  const pre = await preflight(mint, token);
  if (!pre) return { ok: false, message: 'pump did not answer the eligibility check' };
  const no = replyRefusal(pre);
  if (no) return { ok: false, message: no, verdict: pre.verdict };

  // Non-null by replyRefusal, but the path builder checks the shape anyway:
  // the id is the only caller-adjacent part of a URL in this module.
  const route = calloutReplyPath(pre.existingCalloutId ?? '');
  if (!route) return { ok: false, message: 'pump gave no usable id for that callout', verdict: pre.verdict };

  const body = replyBody(text);
  if (!body) return { ok: false, message: 'there is no text to reply with', verdict: pre.verdict };

  try {
    const res = await fetch(urlFor(route), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // The same pair as a callout: their preflight allows only
        // `content-type` as a request header, so their own client cannot send
        // Authorization and the session rides on the cookie.
        cookie: `auth_token=${token}`,
        authorization: `Bearer ${token}`,
        origin: 'https://pump.fun',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      let why = `pump refused the reply (${res.status})`;
      try {
        const j = JSON.parse(raw) as { message?: unknown };
        if (typeof j.message === 'string' && j.message) why = `pump: ${j.message}`;
      } catch {
        /* not JSON — the status is what we have */
      }
      return { ok: false, message: why, verdict: pre.verdict, thesis: text };
    }
    const posted = String(body.content ?? text);
    logger.info(`callout reply on ${mint.slice(0, 8)}… — "${posted}"`);
    return {
      ok: true,
      message: `Replied to your call on ${mint.slice(0, 6)}…`,
      verdict: pre.verdict,
      thesis: posted,
      calloutId: pre.existingCalloutId,
      replyId: replyIdFrom(raw),
    };
  } catch (err) {
    return { ok: false, message: `could not reach pump.fun: ${(err as Error).message}`, verdict: pre.verdict, thesis: text };
  }
}
