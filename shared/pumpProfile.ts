// Setting a pump.fun account's username, bio and picture.
//
// ─── The route, all of it observed ───────────────────────────────────────
//
// OBSERVED 2026-09-22 by watching a real profile edit, because it is not
// discoverable by probing and the field names are not guessable:
//
//   POST https://frontend-api-v3.pump.fun/users   →  201 Created
//
//   { "username": "kryptobottest" }                                (28 bytes)
//   { "bio": "bio test" }
//   { "profileImage": "https://ipfs.io/ipfs/bafkrei…" }            (99 bytes)
//
// THREE SEPARATE REQUESTS, one field each. Their client sends them that way
// and the byte counts confirm it — the profileImage body was exactly 99 bytes,
// which is that one key and that one value and nothing else. A single request
// carrying all three is probably accepted, but "probably" is not what this
// codebase sends at somebody's public profile, so `profileUpdates` produces
// one body per changed field and the sender posts them in turn.
//
// `profileImage` is a URL, not an upload. The picture has to be hosted first,
// and the launcher's IPFS pinning already returns exactly this shape of link
// (`https://ipfs.io/ipfs/<cid>`), so that is what puts one there.
//
// AUTH IS THE COOKIE, again: the preflight answers
// `access-control-allow-headers: content-type`, so their own browser client
// cannot send an Authorization header and the session rides on `auth_token`.
// This app sends both, the same way the callout sender does.
//
// RATE LIMIT, from the response headers: `x-ratelimit-limit: 30` with
// `x-ratelimit-reset: 120`. Thirty writes per two minutes is far above what a
// person editing a profile does, and three fields across five accounts is
// fifteen — so there is no queue here, only the knowledge that it exists.

/** The path a profile is written at. */
export const PROFILE_PATH = '/users';

// pump's own limits, READ 2026-09-22 from the route table in their site code:
// `POST /users` takes username max(15) and bio max(250). Until then these were
// 64 and 512 as guesses, so a long name was only refused by pump itself.
export const MAX_USERNAME = 15;
export const MAX_BIO = 250;

/** What the app can set. Every field optional: a partial edit is the normal
 *  case, and an untouched field must not be overwritten with a blank. */
export interface PumpProfileDraft {
  username: string;
  bio: string;
  /** An https URL to an already-hosted image. */
  profileImage: string;
}

export const EMPTY_PROFILE: PumpProfileDraft = { username: '', bio: '', profileImage: '' };

/** A profile as pump reports it back, with anything unreadable left blank. */
export function profileFrom(raw: unknown): PumpProfileDraft {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PROFILE };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    username: str(r.username ?? r.name),
    bio: str(r.bio),
    profileImage: str(r.profileImage ?? r.profile_image),
  };
}

/**
 * Why this draft cannot be sent, or null.
 *
 * Deliberately thin. The only rules enforced here are the ones this app knows:
 * a picture must be an https URL (a `data:` or `file:` would be a link nobody
 * else can load), and the two text fields have a sane ceiling. Whether a
 * username is taken, or short enough, or allowed at all, is pump's to say.
 */
export function profileProblem(d: PumpProfileDraft): string | null {
  if (d.username.length > MAX_USERNAME) return `The username is longer than ${MAX_USERNAME} characters.`;
  // Counted without the last line, which always fits in what BIO_BUDGET leaves.
  if (stripBioWatermark(d.bio).length > BIO_BUDGET) return `The bio is longer than ${BIO_BUDGET} characters.`;
  if (d.profileImage && !/^https:\/\//.test(d.profileImage)) {
    return 'The picture has to be an https link. Pick an image file and it will be pinned for you.';
  }
  return null;
}

/**
 * The requests to send: ONE BODY PER CHANGED FIELD, in the shape observed.
 *
 * Only what actually changed. A profile write that re-sent every field would
 * overwrite a bio somebody set on pump itself with whatever this form happened
 * to be showing, which is the kind of quiet data loss nobody reports.
 *
 * A field cleared to empty IS a change and is sent as an empty string — that
 * is a person deleting their bio, not an untouched field.
 */
export function profileUpdates(next: PumpProfileDraft, current: PumpProfileDraft): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const keys: Array<keyof PumpProfileDraft> = ['username', 'bio', 'profileImage'];
  for (const k of keys) {
    const v = (next[k] ?? '').trim();
    if (v === (current[k] ?? '').trim()) continue;
    // The picture is NOT capped by either text limit — the observed URL is
    // 80 characters, longer than a username may be, and cutting it would post
    // a broken link. It is validated as an https URL instead.
    const capped = k === 'bio' ? v.slice(0, MAX_BIO) : k === 'username' ? v.slice(0, MAX_USERNAME) : v;
    out.push({ [k]: capped });
  }
  return out;
}

// ─── The bio's last line ─────────────────────────────────────────────────
//
// Every bio this app writes ends with its own line saying the account uses the
// tool, the same way every callout and every launch does (asked 09-22). Put
// on in MAIN on the way out, so no path can write an unmarked bio, and
// idempotent, so re-saving a bio pump already holds changes nothing. The form
// edits the user's words only and shows the line beneath them.

export const BIO_WATERMARK = 'Using krypt.cc/bot';
const BIO_SEP = '\n';

/** What is left for the user's own words once the line is accounted for. */
export const BIO_BUDGET = MAX_BIO - (BIO_WATERMARK.length + BIO_SEP.length);

/** The bio as it will be written. An empty bio becomes just the line. */
export function withBioWatermark(bio: string): string {
  const body = stripBioWatermark(bio);
  return body ? `${body.slice(0, BIO_BUDGET)}${BIO_SEP}${BIO_WATERMARK}` : BIO_WATERMARK;
}

/** The user's own words, without the line — what the form edits. */
export function stripBioWatermark(bio: string): string {
  const b = (bio ?? '').trim();
  return b.endsWith(BIO_WATERMARK) ? b.slice(0, -BIO_WATERMARK.length).trim() : b;
}

/** What a profile write did, for the UI and the log. */
export interface ProfileOutcome {
  ok: boolean;
  /** Our words or pump's, whichever explains it. */
  message: string;
  /** The fields that actually went through, in order. */
  written: string[];
}

// ─── Does this address already have an account? ─────────────────────────
//
// OBSERVED 2026-09-22: `GET /users/<address>` is PUBLIC — no session, 30
// requests per 60 s from the headers. Three answers:
//
//   404 "User not found"            nothing there; signing in creates it.
//   200 with is_pump_user: true     a real account somebody signed in to —
//                                   username, followers, picture, the lot.
//   200 with is_pump_user: false    a record pump made on its own (the system
//                                   program has one, auto-named
//                                   "lateoctopus4697"). Nobody has signed in.
//
// This is what lets an imported wallet say "this is @someone with 10
// followers — Sign in" instead of offering to CREATE an account that exists.
// Signing in with the key of an existing account logs in to that account;
// pump ties the account to the address, not to a device or an email.
//
// Anything else (429, 5xx, a body that is not this shape) is UNKNOWN, never
// "no account" — telling someone with 3,000 followers that they have no
// account is the wrong direction to be wrong in.

/** The public read of one address. Null when the address is not one this
 *  will put in a path. */
export function publicUserPath(address: string): string | null {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? `${PROFILE_PATH}/${address}` : null;
}

export type PumpAccountLookup =
  | { kind: 'account'; username: string | null; followers: number | null; banned: boolean }
  | { kind: 'record'; username: string | null; followers: number | null; banned: boolean }
  | { kind: 'none' }
  | { kind: 'unknown'; why: string };

/** Read pump's answer for one address. `status` is the HTTP status. */
export function accountLookupFrom(status: number, raw: unknown, address: string): PumpAccountLookup {
  if (status === 404) return { kind: 'none' };
  if (status !== 200) return { kind: 'unknown', why: `pump answered ${status}` };
  if (!raw || typeof raw !== 'object') return { kind: 'unknown', why: 'pump answered, but not with a profile' };
  const r = raw as Record<string, unknown>;
  // A profile for somebody else's address is not an answer about this one.
  if (r.address !== address) return { kind: 'unknown', why: 'pump answered about a different address' };
  const username = typeof r.username === 'string' && r.username ? r.username : null;
  const followers = typeof r.followers === 'number' && Number.isFinite(r.followers) ? r.followers : null;
  const banned = r.is_banned === true;
  if (r.is_pump_user === true) return { kind: 'account', username, followers, banned };
  if (r.is_pump_user === false) return { kind: 'record', username, followers, banned };
  return { kind: 'unknown', why: 'pump did not say whether anyone uses this address' };
}
