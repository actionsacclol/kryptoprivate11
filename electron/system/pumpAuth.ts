// pump.fun sessions: sign in, hold the tokens, hand them out, sign out.
//
// The rules live in shared/pumpAuth.ts. This is the side that talks to the
// network and touches disk.
//
// ─── One account per wallet ──────────────────────────────────────────────
//
// pump ties an account to the address that signed in, so three wallets are
// three accounts and all three are valid at once. Sessions are held in a map
// keyed by wallet id, and every call that acts as an account names the wallet
// it is acting for. There is no separate "active account" pointer, because the
// app already has exactly one idea of which wallet is acting and a second one
// would drift out of step and post as the wrong account.
//
// ─── Why not data/http.ts ────────────────────────────────────────────────
//
// Same reason as system/launchMeta.ts: that module is built for polling market
// endpoints on a timer, with a per-provider queue, a gap and a park. This is a
// single user-initiated request at the moment someone presses a button. The
// rule that matters is kept and kept the same way — the host is a CONSTANT and
// nothing here takes a URL, a host or a path component from a caller, so there
// is no way to point it somewhere else. Redirects are refused for the same
// reason they are refused there.
//
// ─── The tokens are credentials ──────────────────────────────────────────
//
// Each is a session JWT that can act as that user socially. They are stored
// under `userData`, never in settings (which are exported, diffed and logged),
// each encrypted with the same `safeStorage` the wallet secrets use, and the
// field is named `token` so `system/diagnostics.ts` redacts it — that module
// treats anything ending in "token" as a secret, which is the rule that caught
// `anthropicKey`.

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import * as wallet from './wallet';
import { logger } from './logger';
import {
  loginBodyProblem,
  PUMP_API_HOST,
  PUMP_LOGIN_FALLBACK_PATH,
  PUMP_LOGIN_PATH,
  pumpLoginReady,
  pumpTimestamp,
  viewOf,
  type PumpAuthStatus,
  type PumpLoginBody,
  type PumpSession,
  WEB_ACCOUNT_PREFIX,
} from '@shared/pumpAuth';

/** Built from the constant host; never from anything a caller supplies. */
const urlFor = (route: string): string => `https://${PUMP_API_HOST}${route}`;
const profileUrl = (): string => `https://${PUMP_API_HOST}/auth/my-profile`;

/**
 * The bearer arm first, the original as a fallback.
 *
 * `/auth/login/token` was confirmed working 2026-09-22 (200 with a JWT), so it
 * leads. The original still answers and returns the same token with
 * `rawJwt: true`; it is here because their schema calls it superseded, and a
 * superseded route is the kind that eventually 404s — at which point the
 * fallback is the one that keeps working, not the other way round.
 */
const LOGIN_ROUTES: Array<{ path: string; rawJwt: boolean }> = [
  { path: PUMP_LOGIN_PATH, rawJwt: false },
  { path: PUMP_LOGIN_FALLBACK_PATH, rawJwt: true },
];

const storePath = (): string => path.join(app.getPath('userData'), 'pump-session.json');

/** walletId → session. One pump account per wallet. */
const sessions = new Map<string, PumpSession>();
let loaded = false;
let lastError: string | null = null;

/**
 * Encrypted at rest, the same way the wallet secrets are.
 *
 * `safeStorage` is unavailable on some Linux desktops; there a token is simply
 * not persisted rather than written in the clear, and the user signs in again
 * next run.
 */
function encryptToken(tok: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(tok).toString('base64');
  } catch {
    return null;
  }
}

function decryptToken(blob: unknown): string | null {
  if (typeof blob !== 'string' || !blob) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(blob, 'base64')) || null;
  } catch {
    return null;
  }
}

function sessionFrom(raw: Record<string, unknown>): PumpSession | null {
  const tok = decryptToken(raw.token);
  if (!tok || typeof raw.address !== 'string' || !raw.address) return null;
  return {
    address: raw.address,
    walletId: typeof raw.walletId === 'string' ? raw.walletId : '',
    token: tok,
    at: typeof raw.at === 'number' ? raw.at : 0,
    username: typeof raw.username === 'string' ? raw.username : null,
    userId: typeof raw.userId === 'string' ? raw.userId : null,
    via: raw.via === 'web' ? 'web' : 'wallet',
  };
}

/**
 * An unreadable store is NOT "nobody is signed in".
 *
 * Same rule as ledger.ts and the five modules the 2026-09-09 audit found
 * getting it wrong. Here the cost of being wrong is small — sign in again — so
 * it reports and carries on rather than refusing to start.
 *
 * Reads the single-session shape this file had for one day as well, so an
 * early session is carried forward rather than silently dropped.
 */
function load(): void {
  if (loaded) return;
  loaded = true;
  const p = storePath();
  if (!fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const rows = Array.isArray(raw.sessions) ? (raw.sessions as Record<string, unknown>[]) : [raw];
    let undecryptable = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const s = sessionFrom(row);
      if (s && s.walletId) sessions.set(s.walletId, s);
      else if (row.address) undecryptable += 1;
    }
    if (undecryptable > 0) {
      // A different machine, or a reset keychain. Not an error worth shouting
      // about, but not silently "never signed in" either.
      lastError = `${undecryptable} saved pump.fun session${undecryptable === 1 ? '' : 's'} could not be decrypted on this machine; sign in again.`;
    }
  } catch (err) {
    lastError = 'The saved pump.fun sessions could not be read; sign in again.';
    logger.warn(`pump auth: session store unreadable (${(err as Error).message})`);
  }
}

function persist(): void {
  const p = storePath();
  try {
    if (sessions.size === 0) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    const rows: Array<Record<string, unknown>> = [];
    let unsealed = 0;
    for (const s of sessions.values()) {
      const sealed = encryptToken(s.token);
      // Never write a token in the clear. A session that cannot be sealed
      // still works for this run; it just will not survive a restart.
      if (!sealed) {
        unsealed += 1;
        continue;
      }
      rows.push({ ...s, token: sealed });
    }
    if (unsealed > 0) {
      logger.warn(`pump auth: no OS encryption available — ${unsealed} session(s) will not be remembered`);
    }
    if (rows.length === 0) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    fs.writeFileSync(p, JSON.stringify({ version: 2, sessions: rows }, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`pump auth: could not save the sessions (${(err as Error).message})`);
  }
}

export function status(): PumpAuthStatus {
  load();
  return {
    ready: pumpLoginReady(),
    // Newest first, so the account someone just signed into is at the top.
    sessions: [...sessions.values()].sort((a, b) => b.at - a.at).map(viewOf),
    lastError,
  };
}

/**
 * The bearer token for the account belonging to this wallet, or null.
 *
 * Deliberately not exposed over IPC — main makes any authenticated call
 * itself. The wallet is NAMED rather than implied, so a caller cannot act as
 * the wrong account by accident.
 */
export function token(walletId: string): string | null {
  load();
  return sessions.get(walletId)?.token ?? null;
}

/** Whether this wallet has a pump account signed in. */
export function signedIn(walletId: string): boolean {
  load();
  return sessions.has(walletId);
}

/** Sign one wallet out, or every wallet when none is named. */
export function signOut(walletId?: string): { ok: boolean; message: string } {
  load();
  if (!walletId) {
    const n = sessions.size;
    sessions.clear();
    lastError = null;
    persist();
    return { ok: true, message: n ? `Signed out of ${n} pump.fun account${n === 1 ? '' : 's'}` : 'Nothing to sign out of' };
  }
  const had = sessions.delete(walletId);
  lastError = null;
  persist();
  return { ok: true, message: had ? 'Signed out of pump.fun' : 'That wallet was not signed in' };
}

/** Pull a token out of whatever shape the response turns out to have. Their
 *  schema describes several (`access_token`, a raw JWT, a decoded payload),
 *  and which one arrives depends on the route — so this reads defensively
 *  rather than asserting a shape nobody has confirmed. */
function tokenFrom(body: unknown): string | null {
  if (typeof body === 'string' && body.split('.').length === 3) return body;
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  for (const k of ['access_token', 'accessToken', 'token', 'auth_token', 'authToken', 'jwt']) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Sign in with one of this app's wallets, creating the pump account if that
 * address has never signed in before — pump has no separate registration step.
 *
 * The caller names a wallet and nothing else. The message, the timestamp and
 * the body are all built here, so there is no request a caller can shape.
 * Signing in again with a wallet that already has a session replaces it, which
 * is how an expired one is refreshed.
 */
export async function signIn(walletId: string): Promise<{ ok: boolean; message: string }> {
  load();
  if (!pumpLoginReady()) {
    const why = 'The pump.fun sign-in message is not known in this build, so signing in would fail at their end.';
    lastError = why;
    return { ok: false, message: why };
  }
  const timestamp = pumpTimestamp();
  const signed = wallet.signPumpLogin(walletId, timestamp);
  if (!signed.ok || !signed.signature || !signed.address) {
    lastError = signed.message;
    return { ok: false, message: signed.message };
  }
  const body: PumpLoginBody = {
    address: signed.address,
    signature: signed.signature,
    timestamp,
    authType: 'non_custodial',
  };
  // Our own error in our own words, before a request goes out — a malformed
  // body answered 401 would read as "your key is wrong", which it is not.
  const problem = loginBodyProblem(body);
  if (problem) {
    lastError = problem;
    return { ok: false, message: `Cannot sign in — ${problem}` };
  }
  try {
    let tok: string | null = null;
    let why = 'pump.fun did not answer the sign-in';
    for (const route of LOGIN_ROUTES) {
      const res = await fetch(urlFor(route.path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(route.rawJwt ? { ...body, rawJwt: true } : body),
        redirect: 'error', // a 30x out of an allowlisted host is the classic escape
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) {
        // pump's own words, which are specific enough to act on ("Invalid
        // signature" means the message template is wrong, not the key).
        why = `pump.fun refused the sign-in (${res.status})`;
        try {
          const j = JSON.parse(text) as { message?: unknown };
          if (typeof j.message === 'string' && j.message) why = `pump.fun: ${j.message}`;
        } catch {
          /* not JSON — the status is what we have */
        }
        // 401 means the SIGNATURE was rejected, which the other route would
        // reject identically — only a missing or malformed route is worth a
        // second attempt.
        if (res.status === 401) break;
        logger.warn(`pump auth: ${route.path} answered ${res.status}; trying the next route`);
        continue;
      }
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a bare token comes back as text */
      }
      tok = tokenFrom(parsed);
      if (tok) break;
      why = 'pump.fun accepted the sign-in but returned no token this app could find.';
      logger.warn(`pump auth: ${route.path} accepted the sign-in but returned no token`);
    }
    if (!tok) {
      lastError = why;
      logger.warn(`pump auth: sign-in failed — ${why}`);
      return { ok: false, message: why };
    }
    sessions.set(walletId, { address: signed.address, walletId, token: tok, at: Date.now(), username: null, via: 'wallet' });
    lastError = null;
    persist();
    // The signature is not logged. The MESSAGE is, because it is the thing
    // worth seeing if the template ever stops matching.
    logger.info(`pump auth: signed in as ${signed.address.slice(0, 6)}… (signed "${signed.signed ?? ''}")`);
    void refreshProfile(walletId);
    return { ok: true, message: `Signed in to pump.fun as ${signed.address.slice(0, 6)}…` };
  } catch (err) {
    const why = `Could not reach pump.fun: ${(err as Error).message}`;
    lastError = why;
    return { ok: false, message: why };
  }
}

/** Read one account's display name, so the UI can show who it is. Best effort:
 *  a failure here does not undo a good session. */
export async function refreshProfile(walletId: string): Promise<void> {
  load();
  const s = sessions.get(walletId);
  if (!s) return;
  try {
    const res = await fetch(profileUrl(), {
      headers: { accept: 'application/json', authorization: `Bearer ${s.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401) {
      // Expired or revoked. Dropping it is the honest move — showing "signed
      // in" over a dead session is worse than asking again.
      logger.info(`pump auth: the session for ${s.address.slice(0, 6)}… is no longer valid; signed out`);
      sessions.delete(walletId);
      lastError = 'A pump.fun session expired. Sign in again.';
      persist();
      return;
    }
    if (!res.ok) return;
    // my-profile only proves the session is alive — it carries the session's
    // claims, not the profile. The name and pump's id for the account come
    // from the PUBLIC profile (2026-09-22; until then no username ever showed).
    const pub = await fetch(`https://${PUMP_API_HOST}/users/${encodeURIComponent(s.address)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    if (!pub || !pub.ok) return;
    const j = (await pub.json()) as Record<string, unknown>;
    const name = j.username ?? j.name ?? null;
    // Their own id for the account, which their caller stats are keyed by and
    // which nothing else can derive. Read defensively across the spellings a
    // JSON API might use; absent means "stats unavailable", never a guess.
    const uid = j.id ?? j.userId ?? j.user_id ?? null;
    const cur = sessions.get(walletId);
    if (cur) {
      let changed = false;
      if (typeof name === 'string' && name && cur.username !== name) {
        cur.username = name;
        changed = true;
      }
      if ((typeof uid === 'string' || typeof uid === 'number') && String(uid) && cur.userId !== String(uid)) {
        cur.userId = String(uid);
        changed = true;
      }
      if (changed) persist();
    }
  } catch {
    /* a profile we could not read changes nothing about the session */
  }
}

/**
 * Turn a pump.fun session token into a stored session, filed under whichever
 * account pump says it belongs to.
 *
 * NOT REACHED at runtime as of 2026-09-23: its only caller was the in-app
 * pump.fun sign-in window, which was removed that day because Google refuses
 * OAuth inside it. It is kept (and tested) purely as the basis for a future
 * web-session capture, should one be added. It is NOT a live fallback — a
 * pump.fun account made with email or a social login comes into the app today
 * through export-key → importAccount, which uses `claimWebSession` below, not
 * this. Delete both this and the `via:'web'` scaffolding if that stays true.
 *
 * The token is NOT trusted for who it says it is. pump's own /auth/my-profile
 * is asked, with it, which address it belongs to; that answer decides where
 * it is filed:
 *   · an address that is one of the app's wallets → that wallet's session
 *     (replacing any older one — this is how a linked account is renewed);
 *   · any other address (a pump-held wallet) → a sign-in-only account under
 *     WEB_ACCOUNT_PREFIX + address, which can post and like but never trade.
 * The token is sealed exactly like every other session.
 */
export async function adoptWebSession(token: string): Promise<{ ok: boolean; message: string; address?: string; walletId?: string }> {
  load();
  const tok = (token ?? '').trim();
  if (!tok || tok.length > 4096) return { ok: false, message: 'pump.fun did not hand over a usable session.' };
  let address: string | null = null;
  try {
    const res = await fetch(profileUrl(), {
      headers: { accept: 'application/json', authorization: `Bearer ${tok}`, cookie: `auth_token=${tok}` },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ok: false, message: `pump.fun did not accept the session it just set (${res.status}).` };
    const j = (await res.json()) as Record<string, unknown>;
    const a = j.address ?? j.walletAddress ?? (j.user as Record<string, unknown> | undefined)?.address;
    if (typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) address = a;
  } catch (e) {
    return { ok: false, message: `Could not check the session with pump.fun: ${(e as Error).message}` };
  }
  if (!address) return { ok: false, message: 'pump.fun did not say which account this session is for, so it was not kept.' };

  const own = wallet.list().find((w) => w.publicKey === address);
  const walletId = own ? own.id : `${WEB_ACCOUNT_PREFIX}${address}`;
  // No limit on sign-in-only accounts: they are external and never trade
  // (shared/pumpAuth.ts). The 10-wallet cap is about keys, not logins.
  // One session per address: a web sign-in for an address already filed
  // elsewhere replaces that row rather than living beside it.
  for (const [id, s] of sessions) if (s.address === address && id !== walletId) sessions.delete(id);
  sessions.set(walletId, { address, walletId, token: tok, at: Date.now(), username: null, via: 'web' });
  lastError = null;
  persist();
  logger.info(`pump auth: kept a pump.fun web sign-in for ${address.slice(0, 6)}… (${own ? `wallet "${own.label || own.id}"` : 'sign-in-only account, no key held'})`);
  void refreshProfile(walletId);
  return {
    ok: true,
    message: own
      ? `Signed in to pump.fun as ${address.slice(0, 6)}… — attached to your wallet "${own.label || 'wallet'}".`
      : `Signed in to pump.fun as ${address.slice(0, 6)}… — a sign-in-only account: it can post, like and edit its profile, but the app cannot trade it.`,
    address,
    walletId,
  };
}

/**
 * A wallet was just added whose address has a SIGN-IN-ONLY session (made on
 * pump.fun with an email, whose key the user then exported and imported).
 * Move that session onto the wallet, so the account the user already signed
 * in to becomes a full one — tradeable — instead of being orphaned under
 * web:<address> while a wallet-signature login (which pump refuses for a
 * linked address) is attempted. Returns whether a session moved.
 */
export function claimWebSession(address: string, walletId: string): boolean {
  load();
  const from = `${WEB_ACCOUNT_PREFIX}${address}`;
  const s = sessions.get(from);
  if (!s || s.address !== address || sessions.has(walletId)) return false;
  sessions.delete(from);
  sessions.set(walletId, { ...s, walletId });
  persist();
  logger.info(`pump auth: the sign-in-only account ${address.slice(0, 6)}… now belongs to an imported wallet`);
  return true;
}

/**
 * Fill in usernames the sign-in read missed, and re-read every name now and
 * then so a rename on pump.fun shows up here.
 *
 * The name is read ONCE, straight after sign-in (refreshProfile). When that
 * read failed — pump busy, or the account not registered yet — the name
 * stayed blank for good: on 2026-09-23 three of five signed-in accounts
 * showed an address where pump had a username. Now any blank name is retried
 * (at most every 5 minutes) and every name is refreshed every 6 hours.
 *
 * Background, one account at a time, 1.5 s apart — pump's frontend API
 * rate-limits bursts. Called from the pump:status IPC, i.e. while a page is
 * showing accounts; never from status() itself, which tests call offline.
 */
const NAME_RETRY_MS = 5 * 60_000;
const NAME_REFRESH_MS = 6 * 3_600_000;
let namesTriedAt = 0;
let namesInFlight = false;

export function refreshNamesSoon(now = Date.now()): void {
  load();
  if (namesInFlight || sessions.size === 0) return;
  const missing = [...sessions.values()].filter((s) => !s.username).map((s) => s.walletId);
  const everyone = now - namesTriedAt >= NAME_REFRESH_MS;
  if (!everyone && (missing.length === 0 || now - namesTriedAt < NAME_RETRY_MS)) return;
  const ids = everyone ? [...sessions.keys()] : missing;
  namesTriedAt = now;
  namesInFlight = true;
  void (async () => {
    try {
      for (const [i, id] of ids.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1_500));
        await refreshProfile(id);
      }
      const still = [...sessions.values()].filter((s) => !s.username).length;
      logger.info(`pump auth: refreshed ${ids.length} account name(s)${still ? `, ${still} still without a name on pump` : ''}`);
    } finally {
      namesInFlight = false;
    }
  })();
}

/**
 * Tests only: drop the in-memory state so the next call re-reads the file.
 * This is how a "restart" is simulated.
 */
export function _reset(): void {
  sessions.clear();
  loaded = false;
  lastError = null;
}

/**
 * Tests only: file a session without the network.
 *
 * Signing in needs a real key and a real request; everything AROUND it — the
 * per-wallet map, the sealing, the restart, signing one account out — is what
 * a multi-account store gets wrong, and this is how that half is exercised.
 * Not reachable from IPC, and it is in main, which already holds the keys.
 */
export function _put(s: PumpSession): void {
  load();
  sessions.set(s.walletId, { ...s });
  persist();
}
