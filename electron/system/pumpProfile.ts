// Reading and writing a pump.fun account's profile.
//
// The rules and the observed request shapes live in shared/pumpProfile.ts.
// This is the side that talks to pump.
//
// ─── Which account ───────────────────────────────────────────────────────
//
// The one belonging to the wallet named by the caller, and main resolves that
// to a session itself. Nothing here takes a token, a host or a path from a
// caller: the host is a constant, the path is a constant, and the only thing
// that crosses into this module is a wallet id and the three text fields.
//
// ─── Partial by design ───────────────────────────────────────────────────
//
// Only changed fields are sent, one request each, because that is what pump's
// own client does and because a write that re-sent everything would overwrite
// a bio set on pump itself with whatever this form was showing.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from './logger';
import * as pumpAuth from './pumpAuth';
import { PUMP_API_HOST } from '@shared/pumpAuth';
import { callerStatsFrom, callerStatsPath, type CallerStats } from '@shared/pumpStats';
import {
  EMPTY_PROFILE,
  PROFILE_PATH,
  accountLookupFrom,
  publicUserPath,
  type PumpAccountLookup,
  profileFrom,
  profileProblem,
  profileUpdates,
  withBioWatermark,
  type ProfileOutcome,
  type PumpProfileDraft,
} from '@shared/pumpProfile';

/** Built from the constant host; never from anything a caller supplies. */
const urlFor = (route: string): string => `https://${PUMP_API_HOST}${route}`;

/**
 * Where an account's profile is read: pump's PUBLIC `GET /users/<address>`,
 * which carries username, bio and profile_image.
 *
 * Until 2026-09-22 this read /auth/my-profile, which answers only the
 * session's claims (address, roles, iat/exp) — no username, bio or picture.
 * So the editor always opened blank, and the "empty bio gets the line" check
 * saw EVERY bio as empty. Read once per call, not cached: the editor and the
 * write both need what pump holds now.
 */
async function readPublicProfile(address: string): Promise<{ status: number; body: unknown } | null> {
  const route = publicUserPath(address);
  if (!route) return null;
  // pump allows 30 of these a minute (x-ratelimit-limit: 30, reset 60 s,
  // seen 09-22) and the accounts page, the name refresh and a lookup share
  // them. A 429 is waited out ONCE — as long as pump says, capped at 4 s so
  // the editor never hangs — and then the cache answers (readProfileForEditor).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(urlFor(route), {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 404) return { status: 404, body: null };
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset') ?? '2');
        await new Promise((r) => setTimeout(r, Math.min(4_000, Math.max(500, (Number.isFinite(wait) ? wait : 2) * 1000))));
        continue;
      }
      if (!res.ok) {
        logger.info(`pump profile: public read answered ${res.status} for ${address.slice(0, 6)}…`);
        return null;
      }
      return { status: res.status, body: await res.json() };
    } catch {
      return null;
    }
  }
  return null;
}

// ─── What this app last saw of each profile ──────────────────────────────
//
// Asked 09-22 after the editor sometimes opened with "could not read": when
// pump will not answer (its 30-a-minute limit, a blip), the editor shows the
// profile as this app last read OR WROTE it, and says how old that is.
// Public data only — username, bio, picture URL — kept in userData by address.
// A display fallback and nothing more: the empty-bio check never trusts it,
// and a live read always replaces it. An unreadable cache file is an empty
// cache, which costs a live read and nothing else.

const CACHE_FILE = 'pump-profiles.json';
let cache: Map<string, { profile: PumpProfileDraft; at: number }> | null = null;

function cacheMap(): Map<string, { profile: PumpProfileDraft; at: number }> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), CACHE_FILE), 'utf8')) as Record<string, unknown>;
    for (const [addr, v] of Object.entries(raw ?? {})) {
      const o = v as { profile?: unknown; at?: unknown };
      if (typeof o?.at === 'number') cache.set(addr, { profile: profileFrom(o.profile), at: o.at });
    }
  } catch {
    /* no file yet, or unreadable — an empty cache */
  }
  return cache;
}

function remember(address: string, profile: PumpProfileDraft): void {
  const m = cacheMap();
  m.set(address, { profile: { ...profile }, at: Date.now() });
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), CACHE_FILE), JSON.stringify(Object.fromEntries(m)));
  } catch (err) {
    logger.warn(`pump profile: could not save the profile cache — ${(err as Error).message}`);
  }
}

const addressOf = (walletId: string): string | null =>
  pumpAuth.status().sessions.find((x) => x.walletId === walletId)?.address ?? null;

/**
 * For the editor: the live profile, or — when pump will not answer — the one
 * this app last read or wrote, with when. Null only when there is neither.
 */
export async function readProfileForEditor(walletId: string): Promise<{ profile: PumpProfileDraft; cachedAt: number | null } | null> {
  const live = await readProfile(walletId);
  if (live) return { profile: live, cachedAt: null };
  const address = addressOf(walletId);
  const hit = address ? cacheMap().get(address) : undefined;
  return hit ? { profile: { ...hit.profile }, cachedAt: hit.at } : null;
}

/**
 * The profile pump currently holds for this wallet's account.
 *
 * Null when it could not be read at all, which is different from a profile
 * that is genuinely empty: the form must not offer to "clear" three fields it
 * never managed to see.
 */
export async function readProfile(walletId: string): Promise<PumpProfileDraft | null> {
  const token = pumpAuth.token(walletId);
  if (!token) return null;
  const address = pumpAuth.status().sessions.find((x) => x.walletId === walletId)?.address ?? null;
  if (!address) return null;
  const r = await readPublicProfile(address);
  if (!r) return null; // unreadable — NOT the same as empty
  // 404: pump holds no profile for the address yet, which IS an empty one.
  const profile = r.status === 404 ? { ...EMPTY_PROFILE } : profileFrom(r.body);
  remember(address, profile);
  return profile;
}

/**
 * Write the changed parts of a profile.
 *
 * One POST per changed field, in the order username → bio → picture, stopping
 * at the first refusal. Stopping matters: a username pump rejects as taken is
 * the common case, and carrying on to write the bio would leave the account
 * half-edited with no clear account of what landed. `written` names the fields
 * that did go through either way.
 *
 * Never throws at the caller.
 */
export async function writeProfile(walletId: string, patch: Partial<PumpProfileDraft>): Promise<ProfileOutcome> {
  const token = pumpAuth.token(walletId);
  if (!token) return { ok: false, message: 'that wallet has no pump.fun account signed in', written: [] };

  // Against what pump actually holds, not against what the form was showing
  // when it opened. A profile edited elsewhere in the meantime is the reason
  // the read happens here rather than being passed in.
  const read = await readProfile(walletId);
  // Unreadable right now: diff against what this app last saw rather than a
  // blank, so a field that has not changed is not re-sent.
  const address = addressOf(walletId);
  const current = read ?? (address ? cacheMap().get(address)?.profile : undefined) ?? EMPTY_PROFILE;

  // A field the caller did not pass is NOT a field cleared: it keeps what pump
  // holds. Until 09-22 the bulk rename passed bio '' and profileImage '', and
  // because a cleared field is a deliberate delete, every rename also wiped
  // the account's bio and picture. (When the read fails, an unpassed field
  // equals the blank `current` and so is not sent either.)
  //
  // The bio gets its last line here, in main, whatever path wrote it.
  const next: PumpProfileDraft = {
    username: patch.username ?? current.username,
    bio: patch.bio !== undefined ? withBioWatermark(patch.bio) : current.bio,
    profileImage: patch.profileImage ?? current.profileImage,
  };
  const why = profileProblem(next);
  if (why) return { ok: false, message: why, written: [] };

  const bodies = profileUpdates(next, current);
  if (bodies.length === 0) return { ok: true, message: 'nothing to change', written: [] };

  const written: string[] = [];
  for (const body of bodies) {
    const field = Object.keys(body)[0];
    try {
      const res = await fetch(urlFor(PROFILE_PATH), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // The cookie their guard reads, plus a bearer beside it — their
          // preflight allows only `content-type` as a request header, so a
          // browser cannot send Authorization at all and the session rides on
          // `auth_token`. This app is not a browser and can send either.
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
        let msg = `pump refused the ${field} (${res.status})`;
        try {
          const j = JSON.parse(raw) as { message?: unknown; errors?: unknown };
          if (typeof j.message === 'string' && j.message) msg = `pump: ${j.message}`;
        } catch {
          /* not JSON — the status is what we have */
        }
        return { ok: false, message: msg, written };
      }
      written.push(field);
    } catch (err) {
      return { ok: false, message: `could not reach pump.fun: ${(err as Error).message}`, written };
    }
  }

  // What pump now holds, as far as this app knows: what was there plus what
  // just landed. Kept so the editor can show it when pump is not answering.
  if (address) {
    const landed = { ...current };
    for (const f of written) (landed as Record<string, string>)[f] = (next as unknown as Record<string, string>)[f];
    remember(address, landed);
  }
  // The username the rest of the app displays comes from pumpAuth's own read,
  // so it is refreshed rather than assumed to match what was just sent.
  await pumpAuth.refreshProfile(walletId);
  logger.info(`pump profile updated for ${walletId}: ${written.join(', ')}`);
  return { ok: true, message: `Updated ${written.join(', ')}`, written };
}

/**
 * An account with NO bio gets just the line (asked 09-22: "if the user doesn't
 * add any bio"). Run after a sign-in and before the account's pump.fun window
 * opens. Never touches a bio that has words in it, and an UNREADABLE profile
 * is not an empty one — a failed read writes nothing ([[fail-open]]).
 * Asked once per wallet per run, so reopening a window does not re-read.
 */
const bioChecked = new Set<string>();
export async function stampEmptyBio(walletId: string): Promise<void> {
  if (bioChecked.has(walletId)) return;
  const read = await readProfile(walletId);
  if (!read) return; // unknown: try again next time
  bioChecked.add(walletId);
  if (read.bio.trim() !== '') return;
  const r = await writeProfile(walletId, { bio: '' }); // '' → the line alone
  logger.info(`pump profile: empty bio ${r.ok ? 'stamped' : `not stamped — ${r.message}`} for ${walletId}`);
}

/**
 * What pump says about this account as a caller.
 *
 * The route was 401 keyless when the callouts rail was built; this is the same
 * route asked with a session, and it has never been seen answering. So a
 * response nobody recognises comes back as `recognised: false` with the body
 * kept, rather than as a page full of zeroes — the difference between "you
 * have no calls" and "we could not read this" is the whole point of asking.
 */
export async function callerStats(walletId: string): Promise<CallerStats | { error: string }> {
  const address = pumpAuth.status().sessions.find((x) => x.walletId === walletId)?.address ?? null;
  if (!address) return { error: 'that wallet has no pump.fun account signed in' };
  const route = callerStatsPath(address);
  if (!route) return { error: 'that address is not a shape this will put in a URL' };
  try {
    // Public, like the callout list it is derived from — no session sent.
    const res = await fetch(urlFor(route), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { error: `pump answered ${res.status} for the caller stats` };
    try {
      return callerStatsFrom(await res.json());
    } catch {
      return { error: 'pump answered, but not with JSON' };
    }
  } catch (err) {
    return { error: `could not reach pump.fun: ${(err as Error).message}` };
  }
}

// ─── Who already has an account ──────────────────────────────────────────
//
// Keyless and public (see shared/pumpProfile.ts). Cached ten minutes per
// address: the answer changes when somebody signs in, and a sign-in from this
// app drops the entry itself. An UNKNOWN answer is not cached, so a 429 does
// not stick to a row for ten minutes.

const LOOKUP_TTL_MS = 10 * 60_000;
const lookups = new Map<string, { at: number; value: PumpAccountLookup }>();

/** Drop one address, or all of them. Called on sign-out: the row is about to
 *  show a lookup again, and one cached from before the sign-in would offer to
 *  "create" the account that sign-in just made. */
export function forgetLookup(address?: string | null): void {
  if (address) lookups.delete(address);
  else lookups.clear();
}

export async function lookupAccount(address: string): Promise<PumpAccountLookup> {
  const route = publicUserPath(address);
  if (!route) return { kind: 'unknown', why: 'not a Solana address' };
  const hit = lookups.get(address);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value;
  try {
    const res = await fetch(urlFor(route), {
      headers: { accept: 'application/json', origin: 'https://pump.fun' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* the status still says something */
    }
    const value = accountLookupFrom(res.status, body, address);
    if (value.kind !== 'unknown') lookups.set(address, { at: Date.now(), value });
    return value;
  } catch (err) {
    return { kind: 'unknown', why: `could not reach pump.fun: ${(err as Error).message}` };
  }
}
