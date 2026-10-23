// pump.fun follows and likes, and the account registration they need.
// The routes and why each is shaped as it is: shared/pumpSocial.ts.
//
// Every call names the wallet whose account acts. The host is a constant, the
// target is checked against its shape before it gets here, and redirects are
// refused — the same rules as system/pumpAuth.ts and system/pumpProfile.ts.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import * as pumpAuth from './pumpAuth';
import { logger } from './logger';
import { pumpFetch } from '../data/pumpWall';
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
  referralDue,
  referralExpired,
  referralOutcomeFrom,
  referralQueueAfter,
  type PendingReferral,
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
    const res = await pumpFetch(urlFor(REGISTER_PATH), {
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

async function attemptReferral(walletId: string): Promise<ReferralOutcome> {
  const s = pumpAuth.status().sessions.find((x) => x.walletId === walletId);
  const token = pumpAuth.token(walletId);
  if (!s || !token) return 'unknown';
  const known = referralSettled.get(s.address);
  if (known) return known;
  const reg = await ensureRegistered(walletId);
  if (!reg.ok) return 'unknown';
  try {
    const res = await pumpFetch(urlFor(REFERRAL_APPLY_PATH), {
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

// ─── Retrying a referral that did not land ───────────────────────────────
//
// shared/pumpReferral.ts has the rules. An answer that is not final — pump
// busy, a block, the app closed a minute after sign-in — leaves the account in
// a small file under userData, and a timer asks again every few minutes until
// pump settles it or the 24 h window is over. Public data only (an address and
// a wallet id), so it is plain JSON, not sealed like a session.

const pendingPath = (): string => path.join(app.getPath('userData'), 'pump-referral-pending.json');

function loadPending(): PendingReferral[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as { pending?: unknown };
    if (!Array.isArray(raw.pending)) return [];
    return raw.pending.filter(
      (p): p is PendingReferral =>
        !!p && typeof p === 'object' && typeof (p as PendingReferral).address === 'string' && typeof (p as PendingReferral).walletId === 'string' && typeof (p as PendingReferral).since === 'number',
    );
  } catch {
    return []; // no file yet, or unreadable: nothing is owed, and the next failure starts it again
  }
}

function savePending(q: PendingReferral[]): void {
  try {
    if (q.length === 0) {
      if (fs.existsSync(pendingPath())) fs.unlinkSync(pendingPath());
      return;
    }
    fs.writeFileSync(pendingPath(), JSON.stringify({ version: 1, pending: q }, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`pump referral: could not save the retry queue (${(err as Error).message})`);
  }
}

/** Apply Krypt's referral, remembering it for retry if pump did not settle it. */
export async function applyReferral(walletId: string): Promise<ReferralOutcome> {
  const outcome = await attemptReferral(walletId);
  const s = pumpAuth.status().sessions.find((x) => x.walletId === walletId);
  if (s) {
    const before = loadPending();
    const after = referralQueueAfter(before, { address: s.address, walletId }, outcome, Date.now());
    if (JSON.stringify(before) !== JSON.stringify(after)) savePending(after);
    if (after.some((p) => p.address === s.address)) scheduleReferralSweep(30_000);
  }
  return outcome;
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweeping = false;

function scheduleReferralSweep(ms: number): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void sweepReferrals();
  }, ms);
  sweepTimer.unref?.();
}

/** One pass over the queue. Exported for the tests; the timer calls it. */
export async function sweepReferrals(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    let q = loadPending();
    const sessions = pumpAuth.status().sessions;
    // Out of the queue: window over, or the account was signed out.
    const keep = q.filter((p) => !referralExpired(p, now) && sessions.some((x) => x.walletId === p.walletId && x.address === p.address));
    if (keep.length !== q.length) {
      logger.info(`pump referral: dropped ${q.length - keep.length} account(s) from the retry queue (window over or signed out)`);
      savePending(keep);
      q = keep;
    }
    for (const p of q.filter((x) => referralDue(x, now))) {
      logger.info(`pump referral: retrying ${p.address.slice(0, 6)}… (try ${p.tries + 1}, last answer ${p.last})`);
      await applyReferral(p.walletId); // records its own answer in the queue
      await new Promise((r) => setTimeout(r, 1_500));
    }
  } finally {
    sweeping = false;
    if (loadPending().length > 0) scheduleReferralSweep(REFERRAL_SWEEP_MS);
  }
}

const REFERRAL_SWEEP_MS = 5 * 60_000;

/** Start retrying anything left over from an earlier run. Called once at startup. */
export function startReferralRetries(): void {
  if (loadPending().length > 0) scheduleReferralSweep(20_000);
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
    const res = await pumpFetch(urlFor(path), {
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
