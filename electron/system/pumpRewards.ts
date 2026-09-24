// pump.fun callout rewards, read per signed-in account (2026-09-23).
//
// The pure half — shapes, labels, the terms URL — is shared/pumpRewards.ts.
// This is the network half: the same host and the same session as callouts,
// the bearer never leaving main. Reads are free to run; accepting the terms
// is a POST that only ever follows a person pressing the button for ONE
// account, and is logged.

import * as pumpAuth from './pumpAuth';
import { logger } from './logger';
import { PUMP_API_HOST } from '@shared/pumpAuth';
import { payoutsFrom, termsFrom, type PumpRewards } from '@shared/pumpRewards';

const urlFor = (route: string): string => `https://${PUMP_API_HOST}${route}`;

async function authed(walletId: string, route: string, method: 'GET' | 'POST' = 'GET'): Promise<{ ok: boolean; status: number; body: unknown }> {
  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, status: 0, body: null };
  const res = await fetch(urlFor(route), {
    method,
    headers: {
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      // Their web client authenticates with the auth_token cookie; the same
      // JWT as a bearer covers either reading (see autoCallout.ts).
      cookie: `auth_token=${token}`,
      authorization: `Bearer ${token}`,
      origin: 'https://pump.fun',
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON — the status is what we have */
  }
  return { ok: res.ok, status: res.status, body };
}

/** One account's rewards. Never throws; what could not be read is null. */
export async function rewardsFor(walletId: string): Promise<PumpRewards | null> {
  const s = pumpAuth.status().sessions.find((x) => x.walletId === walletId);
  if (!s) return null;
  const out: PumpRewards = {
    walletId,
    address: s.address,
    username: s.username,
    termsAccepted: null,
    termsAcceptedAt: null,
    rewardsPaidUsdc: null,
    referralPaidUsdc: null,
    recent: [],
    problem: null,
  };
  try {
    const [tos, rewards, referral] = await Promise.all([
      authed(walletId, '/creator-rewards-tos'),
      authed(walletId, '/payouts?kind=reward&page=0&pageSize=10'),
      authed(walletId, '/payouts?kind=referral&totalsOnly=true'),
    ]);
    const t = tos.ok ? termsFrom(tos.body) : null;
    if (t) {
      out.termsAccepted = t.accepted;
      out.termsAcceptedAt = t.acceptedAt;
    }
    const r = rewards.ok ? payoutsFrom(rewards.body) : null;
    if (r) {
      out.rewardsPaidUsdc = r.totalPaidUsdc;
      out.recent = r.payouts;
    }
    const ref = referral.ok ? payoutsFrom(referral.body) : null;
    if (ref) out.referralPaidUsdc = ref.totalPaidUsdc;
    const failed = [tos, rewards, referral].filter((x) => !x.ok);
    if (failed.length) {
      out.problem = failed.some((x) => x.status === 401)
        ? 'pump.fun says this session is not valid — sign in again'
        : `pump.fun did not answer (${[...new Set(failed.map((x) => x.status || 'no reply'))].join(', ')})`;
    }
  } catch (e) {
    out.problem = `could not reach pump.fun: ${(e as Error).message}`;
  }
  return out;
}

/** Every signed-in account, one after another (pump rate-limits bursts). */
export async function allRewards(): Promise<PumpRewards[]> {
  const out: PumpRewards[] = [];
  for (const s of pumpAuth.status().sessions) {
    const r = await rewardsFor(s.walletId);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Accept pump's callout-reward terms for ONE account. Only ever called from a
 * button a person pressed, after the terms were linked beside it. Idempotent
 * on pump's side.
 */
export async function acceptTerms(walletId: string): Promise<{ ok: boolean; message: string }> {
  const s = pumpAuth.status().sessions.find((x) => x.walletId === walletId);
  if (!s) return { ok: false, message: 'That wallet has no pump.fun account signed in.' };
  try {
    const r = await authed(walletId, '/creator-rewards-tos/accept', 'POST');
    if (!r.ok) {
      const msg = (r.body as { message?: unknown } | null)?.message;
      return { ok: false, message: typeof msg === 'string' && msg ? `pump: ${msg}` : `pump refused (${r.status})` };
    }
    const already = (r.body as { alreadyAccepted?: unknown } | null)?.alreadyAccepted === true;
    logger.info(`pump rewards: callout-reward terms accepted for ${s.address.slice(0, 8)}…${already ? ' (already accepted)' : ''}`);
    return { ok: true, message: already ? 'Already accepted.' : 'Terms accepted — this account can be paid callout rewards.' };
  } catch (e) {
    return { ok: false, message: `could not reach pump.fun: ${(e as Error).message}` };
  }
}
