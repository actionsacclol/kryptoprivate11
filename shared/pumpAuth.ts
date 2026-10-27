// Signing into pump.fun with a wallet this app already holds.
//
// pump's sign-in is a plain proof of key ownership: sign a short message, POST
// `{ address, signature, timestamp }`, get a session token back. Their schema
// accepts `authType: "non_custodial"`, which is us — no browser, no extension,
// no Privy. The key never leaves the main process, exactly as it does not for
// a trade.
//
// ─── Why there is no generic "sign this" function anywhere ───────────────
//
// Every signing path in this app is a NAMED DOOR with its own intent: a trade,
// a fan-out buy, a launch (which additionally demands the freshly generated
// mint secret). Adding "sign these bytes for me" would hand the renderer — and
// anything that ever reaches it — the exact primitive wallet phishing is built
// on, and it would sit next to keys that hold real positions.
//
// So this module builds the message and `wallet.signPumpLogin` takes a wallet
// id and a NUMBER. There is no parameter through which caller-supplied bytes
// can reach a signature, which is a property of the shape rather than of a
// check someone has to remember to write.
//
// ─── Where the message came from ─────────────────────────────────────────
//
// OBSERVED, not guessed. It could not be derived: a wrong message and a wrong
// key are both answered "Invalid signature" with nothing to tell them apart,
// and it is in no published schema. So it was read off a real sign-in, from
// the text Phantom itself displayed before signing (2026-09-22):
//
//     Sign in to pump.fun: 1790047569405
//
// Thirteen digits — milliseconds, not seconds. One space after the colon, no
// trailing punctuation. Every character matters: the signature is over these
// exact bytes, and one wrong character produces a signature that will never
// verify while pump's error blames our key.

/**
 * The message pump asks the wallet to sign, as a function of the timestamp.
 *
 * If this ever stops working, the first thing to suspect is that pump changed
 * the wording. Re-read it the same way — sign in on their site and look at
 * what the wallet displays — rather than guessing at a variation.
 */
export const PUMP_LOGIN_TEMPLATE: ((timestamp: number) => string) | null = (timestamp) =>
  `Sign in to pump.fun: ${timestamp}`;

/**
 * Which login route to use. Three exist as of 2026-09-22:
 *
 *   POST /auth/login          the original; sets an `auth_token` cookie, or
 *                             returns the raw token with `rawJwt: true`.
 *   POST /auth/login/token    returns the session JWT as a bearer token.
 *   POST /auth/login/session  sets the cookie; REQUIRES an Origin header and
 *                             answers 400 without one.
 *
 * Their own site uses `/auth/login/session` (observed 2026-09-22), which suits
 * a browser: it sets a cookie and refuses without an `Origin` header. This app
 * is not a browser and has no origin to honestly claim, so it asks for the
 * BEARER arm instead and carries the token itself.
 *
 * `/auth/login` with `rawJwt: true` returns the same token and is the fallback
 * if the bearer arm is ever withdrawn — their schema calls the original
 * superseded, which is the kind of thing that eventually becomes a 404.
 */
export const PUMP_LOGIN_PATH = '/auth/login/token';
export const PUMP_LOGIN_FALLBACK_PATH = '/auth/login';

/**
 * Making an account is its own step now (OBSERVED 2026-10-22). Until then the
 * first sign-in with an address created it; now both login routes answer a
 * new address `404 ACCOUNT_NOT_FOUND` — "No account for this wallet; create
 * one through POST /auth/register". Register takes the SAME signed body as
 * login plus an `Origin` header (400 "Missing Origin header" without one),
 * answers 200 with the session's claims and sets the `auth_token` cookie;
 * login then works, and the account already has a pump-made username and
 * picture. A wallet that already has an account never sees the 404.
 */
export const PUMP_REGISTER_PATH = '/auth/register';
/** pump's error code for "this address has no account yet". */
export const PUMP_NO_ACCOUNT = 'ACCOUNT_NOT_FOUND';

/** The only host this module will ever talk to. */
export const PUMP_API_HOST = 'frontend-api-v3.pump.fun';

/**
 * MILLISECONDS. Read off the observed message above, which carried thirteen
 * digits. Their schema says only `number`, so this is the kind of thing that
 * can only be settled by looking.
 */
export type PumpTimestampUnit = 'ms' | 's';
export const PUMP_TIMESTAMP_UNIT: PumpTimestampUnit = 'ms';

/** The body pump's schema accepts. `transaction` and `deviceId` are for their
 *  own clients and are never sent. */
export interface PumpLoginBody {
  address: string;
  /** Base58 ed25519 signature — their schema caps this at 88 characters. */
  signature: string;
  timestamp: number;
  authType: 'non_custodial';
}

/** Their schema's own limits, so a malformed body is caught before a request. */
export const MAX_SIGNATURE_CHARS = 88;
export const MAX_ADDRESS_CHARS = 44;

/**
 * The message to sign for this timestamp, or null while the template is
 * unknown.
 *
 * Pure and exported so a test can pin it the moment the template lands, and so
 * the main process and any future caller cannot build the string differently.
 */
export function pumpLoginMessage(timestamp: number): string | null {
  if (!PUMP_LOGIN_TEMPLATE) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return PUMP_LOGIN_TEMPLATE(Math.floor(timestamp));
}

/** Whether sign-in can be attempted at all. False = the template is not known
 *  yet, which the UI must say plainly rather than offering a button that
 *  cannot work. */
export function pumpLoginReady(): boolean {
  return PUMP_LOGIN_TEMPLATE !== null;
}

/** The timestamp to sign and send, in whichever unit pump expects. */
export function pumpTimestamp(now = Date.now()): number {
  return PUMP_TIMESTAMP_UNIT === 's' ? Math.floor(now / 1000) : now;
}

/**
 * Why a login body is unusable, or null when it is sendable.
 *
 * Checked before the request so a malformed body is our error, reported in our
 * words, rather than a 401 from pump that reads as "your key is wrong".
 */
export function loginBodyProblem(b: PumpLoginBody): string | null {
  if (!b.address || b.address.length > MAX_ADDRESS_CHARS) return 'the wallet address is missing or too long';
  if (!b.signature) return 'nothing was signed';
  if (b.signature.length > MAX_SIGNATURE_CHARS) return `the signature is ${b.signature.length} characters; pump accepts ${MAX_SIGNATURE_CHARS}`;
  if (!Number.isFinite(b.timestamp) || b.timestamp <= 0) return 'the timestamp is not a number';
  return null;
}

// ─── One account per wallet ──────────────────────────────────────────────
//
// pump ties an account to the ADDRESS that signed in, so three wallets are
// three accounts, and they are all valid at once. Sessions are therefore held
// per wallet rather than one at a time.
//
// There is deliberately NO "active pump account" setting. The app already has
// exactly one concept of which wallet is acting — the active signer — and a
// second, separately-chosen pointer would be a thing that drifts out of step
// with it and posts as the wrong account. So the session simply follows the
// wallet: whatever wallet an action is for, that wallet's session is the one
// used, and a caller that wants a different account names a different wallet.

/** A stored session. The token is a credential and is treated as one — see
 *  the redaction rule in system/diagnostics.ts. */
export interface PumpSession {
  /** The wallet's address, which IS the pump account's identity. */
  address: string;
  /** Which app wallet signed it — the key this session is filed under. */
  walletId: string;
  token: string;
  /** When we signed in, ms. */
  at: number;
  /** pump's display name for the account, when the profile read answered. */
  username: string | null;
  /**
   * pump's own id for the account, from the profile read.
   *
   * Their caller stats are keyed by it (`/callout/leaderboard-stats/{userId}`),
   * and it is not derivable from the address. Null when the profile read has
   * not answered or their shape changed — which reads as "stats unavailable",
   * never as a guess.
   */
  userId?: string | null;
  /**
   * How the session was obtained (2026-09-23). 'wallet' = the app signed
   * pump's login message with a wallet it holds (the original path). 'web' =
   * the user signed in on pump.fun itself (email, Google, Apple, GitHub) in
   * the app's login window, and the app kept that session — the fallback for
   * pump retiring wallet sign-in on 2026-09-25. Absent on older rows = wallet.
   */
  via?: 'wallet' | 'web';
}

/**
 * The walletId a web sign-in is filed under when its address is NOT one of
 * the app's wallets (a pump-held Privy wallet). Such an account can post,
 * like, follow, edit its profile and read its rewards — but the app holds no
 * key for it, so it can never trade, and it does not count against the
 * wallet cap. A prefix no wallet id can have.
 */
export const WEB_ACCOUNT_PREFIX = 'web:';
export const isWebOnlyAccount = (walletId: string): boolean => walletId.startsWith(WEB_ACCOUNT_PREFIX);
// No cap on sign-in-only accounts (decided 2026-09-23): they are external
// pump.fun accounts the app holds no key for and can never trade, so the
// 10-wallet cap — which bounds the wallets the app can SIGN with — does not
// apply to them, and nothing else does either.

// ─── How long a session lasts ────────────────────────────────────────────
//
// About 30 days, from pump's own token (every token seen 10-22 and 10-25;
// it was about two weeks before). The view now carries the token's own
// `exp` (tokenExpiry), so this is only the fallback. That is an OBSERVATION, not a
// guarantee they publish, so nothing here expires a session on its own: the
// authority is a 401 from their server, which `refreshProfile` already turns
// into a sign-out. This constant only decides when the UI says "worth
// refreshing", and being wrong about it costs one unnecessary sign-in.
export const PUMP_SESSION_DAYS = 30;
/** Flagged as stale with this long left, so nothing lapses mid-run. */
const RENEW_WITHIN_DAYS = 3;

/** Days left on a session — from pump's own expiry when known, else the
 *  estimate. Negative once it is past due. */
export function sessionDaysLeft(s: { at: number; expiresAt?: number | null }, now = Date.now()): number {
  if (typeof s.expiresAt === 'number') return (s.expiresAt - now) / 86_400_000;
  return PUMP_SESSION_DAYS - (now - s.at) / 86_400_000;
}

/** Worth signing in again before it bites. */
export function sessionStale(s: { at: number; expiresAt?: number | null }, now = Date.now()): boolean {
  return sessionDaysLeft(s, now) <= RENEW_WITHIN_DAYS;
}

/**
 * When pump's own token says it ends, ms — its `exp` claim, read without
 * checking the signature (pump checks that; this only decides what the page
 * says). 30 days on every token seen 2026-10-25. Null when it is not a JWT
 * with a sane `exp`, and the 14-day estimate stands in.
 */
export function tokenExpiry(token: string): number | null {
  const part = (token ?? '').split('.')[1];
  if (!part || part.length > 4096) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown };
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : NaN;
    // Inside a year either way, or it is not a value worth showing.
    return Number.isFinite(exp) && Math.abs(exp - Date.now()) < 366 * 86_400_000 ? exp : null;
  } catch {
    return null;
  }
}

/** One session as the UI sees it: everything but the credential. */
export type PumpSessionView = Omit<PumpSession, 'token'> & { expiresAt?: number | null };

/** Strip the token. The only way a session should ever leave main. */
export function viewOf(s: PumpSession): PumpSessionView {
  return { address: s.address, walletId: s.walletId, at: s.at, username: s.username, userId: s.userId ?? null, via: s.via ?? 'wallet', expiresAt: tokenExpiry(s.token) };
}

/**
 * A wallet whose pump session ENDED without the user signing out (2026-10-25).
 * Until then a dead session was simply dropped, so the page showed nothing and
 * the first sign was scripts' callouts failing. 'expired' = pump ended it and a
 * wallet sign-in may bring it back (Retry); 'browser' = pump refuses a wallet
 * sign-in for the account (email or social login, 409 Privy), so only the
 * browser sign-in works. Cleared by any successful sign-in or a sign-out.
 */
export interface PumpSignInNeeded {
  walletId: string;
  address: string;
  reason: 'expired' | 'browser';
  at: number;
}

/** What the UI is told. Never carries a token. */
export interface PumpAuthStatus {
  /** False when the template is not known yet — the button must say so. */
  ready: boolean;
  /** Every signed-in account, one per wallet, newest first. */
  sessions: PumpSessionView[];
  /** Why the last attempt failed, in pump's words or ours. */
  lastError: string | null;
  /** Sessions that ended on their own and want signing in again. */
  needsSignIn?: PumpSignInNeeded[];
}

/** The session for a wallet, or null. Shared so the UI and main agree on what
 *  "signed in" means for a given wallet rather than each deciding. */
export function sessionForWallet(status: PumpAuthStatus, walletId: string): PumpSessionView | null {
  return status.sessions.find((s) => s.walletId === walletId) ?? null;
}
