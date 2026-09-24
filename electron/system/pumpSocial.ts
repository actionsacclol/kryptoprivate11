// pump.fun follows and likes, and the account registration they need.
// The routes and why each is shaped as it is: shared/pumpSocial.ts.
//
// Every call names the wallet whose account acts. The host is a constant, the
// target is checked against its shape before it gets here, and redirects are
// refused — the same rules as system/pumpAuth.ts and system/pumpProfile.ts.

import * as pumpAuth from './pumpAuth';
import { logger } from './logger';
import { PUMP_API_HOST } from '@shared/pumpAuth';
import {
  REGISTER_PATH,
  SOCIAL_GAP_MS,
  socialLabel,
  socialRoute,
  socialTarget,
  type SocialAction,
} from '@shared/pumpSocial';
import {
  KRYPT_REFERRAL_CODE,
  REFERRAL_APPLY_PATH,
  SETTLED_OUTCOMES,
  referralOutcomeFrom,
  type ReferralOutcome,
} from '@shared/pumpReferral';

const urlFor = (route: string): string => `https://${PUMP_API_HOST}${route}`;

const headersFor = (token: string): Record<string, string> => ({
  accept: 'application/json',
  'content-type': 'application/json',
  // The cookie pump's guard reads, plus a bearer beside it (pumpProfile.ts).
  cookie: `auth_token=${token}`,
  authorization: `Bearer ${token}`,
  origin: 'https://pump.fun',
});

/** pump's own words from a refusal, else the status. */
async function refusal(res: Response, what: string): Promise<string> {
  let msg = `pump refused the ${what} (${res.status})`;
  try {
    const j = JSON.parse(await res.text()) as { message?: unknown };
    if (typeof j.message === 'string' && j.message) msg = `pump: ${j.message}`;
  } catch {
    /* not JSON — the status is what we have */
  }
  return msg;
}

// ─── Registration ────────────────────────────────────────────────────────
//
// Once per account per run is enough; pump answers a repeat with 204. Keyed by
// the TOKEN, not the wallet, so a fresh sign-in registers again — harmless,
// and it covers an account pump has reset.
const registered = new Set<string>();

export async function ensureRegistered(walletId: string): Promise<{ ok: boolean; message: string }> {
  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, message: 'that wallet has no pump.fun account signed in' };
  if (registered.has(token)) return { ok: true, message: 'registered' };
  try {
    const res = await fetch(urlFor(REGISTER_PATH), {
      method: 'POST',
      headers: headersFor(token),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const why = await refusal(res, 'account registration');
      logger.warn(`pump social: register failed for ${walletId} — ${why}`);
      return { ok: false, message: why };
    }
    registered.add(token);
    return { ok: true, message: 'registered' };
  } catch (err) {
    return { ok: false, message: `could not reach pump.fun: ${(err as Error).message}` };
  }
}

// ─── Krypt's referral ────────────────────────────────────────────────────
//
// Applied to every account right after it signs in (shared/pumpReferral.ts has
// why and what it pays). pump's window is 24 h from an account's first
// sign-in, so later is too late. Registered first — the referral belongs to a
// pump user, and an unregistered API sign-in is not one yet. A settled answer
// is remembered per ADDRESS for the run; pump's own apply is idempotent anyway.
const referralSettled = new Map<string, ReferralOutcome>();

export async function applyReferral(walletId: string): Promise<ReferralOutcome> {
  const s = pumpAuth.status().sessions.find((x) => x.walletId === walletId);
  const token = pumpAuth.token(walletId);
  if (!s || !token) return 'unknown';
  const known = referralSettled.get(s.address);
  if (known) return known;
  const reg = await ensureRegistered(walletId);
  if (!reg.ok) return 'unknown';
  try {
    const res = await fetch(urlFor(REFERRAL_APPLY_PATH), {
      method: 'POST',
      headers: headersFor(token),
      body: JSON.stringify({ username: KRYPT_REFERRAL_CODE }),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      logger.warn(`pump referral: apply answered ${res.status} for ${s.address.slice(0, 6)}…`);
      return 'unknown';
    }
    const outcome = referralOutcomeFrom(await res.json().catch(() => null));
    if (SETTLED_OUTCOMES.includes(outcome)) referralSettled.set(s.address, outcome);
    const line = `pump referral: ${s.address.slice(0, 6)}… → ${outcome}`;
    if (outcome === 'unknownUsername' || outcome === 'referrerNotEligible' || outcome === 'unknown') {
      // Our side is wrong (the code account renamed or restricted), not theirs.
      logger.warn(`${line} — check the "${KRYPT_REFERRAL_CODE}" account on pump.fun`);
    } else {
      logger.info(line);
    }
    return outcome;
  } catch (err) {
    logger.warn(`pump referral: could not reach pump.fun — ${(err as Error).message}`);
    return 'unknown';
  }
}

// ─── Follow / unfollow / like / unlike ───────────────────────────────────
//
// One account's calls run one after another with a short gap, so a script
// looping over a list is paced rather than refused. Different accounts do not
// wait on each other.
const lanes = new Map<string, Promise<unknown>>();

export function act(
  walletId: string,
  action: SocialAction,
  rawTarget: unknown,
): Promise<{ ok: boolean; message: string; target?: string }> {
  const target = socialTarget(action, rawTarget);
  if (!target) {
    const what = action === 'follow' || action === 'unfollow'
      ? 'a wallet address, a pump user id or a pump.fun/profile link'
      : 'a callout id';
    return Promise.resolve({ ok: false, message: `${action}: expected ${what}` });
  }
  const prev = lanes.get(walletId) ?? Promise.resolve();
  const run = prev.then(async () => {
    try {
      return await send(walletId, action, target);
    } finally {
      await new Promise((r) => setTimeout(r, SOCIAL_GAP_MS));
    }
  });
  const tail = run.catch(() => undefined);
  lanes.set(walletId, tail);
  void tail.then(() => {
    if (lanes.get(walletId) === tail) lanes.delete(walletId);
  });
  return run;
}

async function send(walletId: string, action: SocialAction, target: string): Promise<{ ok: boolean; message: string; target?: string }> {
  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, message: 'that wallet has no pump.fun account signed in' };
  const reg = await ensureRegistered(walletId);
  if (!reg.ok) return { ok: false, message: reg.message };
  const { method, path } = socialRoute(action, target);
  try {
    const res = await fetch(urlFor(path), {
      method,
      headers: headersFor(token),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401) {
      return { ok: false, message: 'pump.fun says this account’s session has ended — sign it in again', target };
    }
    if (!res.ok) return { ok: false, message: await refusal(res, action), target };
    const label = socialLabel(action, target);
    logger.info(`pump social: ${walletId} ${label}`);
    return { ok: true, message: label, target };
  } catch (err) {
    return { ok: false, message: `could not reach pump.fun: ${(err as Error).message}`, target };
  }
}
