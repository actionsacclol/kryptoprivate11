// pump.fun follows and likes, as one of the user's own signed-in accounts.
//
// Asked 2026-09-22 for scripting ("let's build following and likes") and so it
// survives pump's 2026-09-25 web sign-in change: pump's announcement says API
// sessions are not affected, so doing this through the API, not their site,
// is what keeps working.
//
// ─── Routes, READ from pump's own site code and CONFIRMED live 09-22 ──────
//
// pump.fun's web bundle declares its API as a route table. The ones used here,
// each exercised with two throwaway accounts (A following B):
//
//   POST   /users/register            201 — REQUIRED once per account. A fresh
//                                    API sign-in is not a full user: follow
//                                    answered 409 "Could not create follow" and
//                                    like 403 "no coin-communities profile for
//                                    this wallet" until it ran. pump's own site
//                                    calls it on load; nothing in the app did.
//   POST   /following/v2/{userId}     201, repeatable (following twice is 201).
//   DELETE /following/{userId}        200.
//   GET    /following/single/{id}?userId={viewer}   {follow: {...} | null}
//   POST   /callout/{calloutId}/like  {created}; a made-up id → 404 "callout
//   DELETE /callout/{calloutId}/like  {removed};  not found" once registered.
//
// `userId` is "a valid base58 public key or user id" in pump's words (a 400
// says exactly that otherwise) — a wallet address or pump's own user UUID.
// A callout id is a UUID.
//
// Same rule as every pump route in this app: the host is a constant and a
// caller supplies an ID, never a URL or a path. The ID is checked against its
// shape here, so nothing a script passes can add a segment or a query.

/** A Solana address (32–44 base58 characters). */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** pump's user and callout ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REGISTER_PATH = '/users/register';

export type SocialAction = 'follow' | 'unfollow' | 'like' | 'unlike';
export const SOCIAL_ACTIONS: readonly SocialAction[] = ['follow', 'unfollow', 'like', 'unlike'];

/** Who a follow is aimed at: a wallet address or a pump user id. Accepts a
 *  pasted profile link too (pump.fun/profile/<address>), because that is
 *  what a person copies. Null when it is neither. */
export function pumpUserTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?pump\.fun\/profile\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  if (BASE58_ADDRESS.test(s)) return s;
  if (UUID.test(s)) return s.toLowerCase();
  return null;
}

/** A callout id, or the first UUID in a pasted link to one. */
export function calloutTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(raw.trim());
  return m ? m[0].toLowerCase() : null;
}

/** The target for an action, checked for that action's kind. */
export function socialTarget(action: SocialAction, raw: unknown): string | null {
  return action === 'follow' || action === 'unfollow' ? pumpUserTarget(raw) : calloutTarget(raw);
}

/** Method and path for an action on an already-checked target. */
export function socialRoute(action: SocialAction, target: string): { method: 'POST' | 'DELETE'; path: string } {
  const t = encodeURIComponent(target);
  switch (action) {
    case 'follow':
      return { method: 'POST', path: `/following/v2/${t}` };
    case 'unfollow':
      return { method: 'DELETE', path: `/following/${t}` };
    case 'like':
      return { method: 'POST', path: `/callout/${t}/like` };
    case 'unlike':
      return { method: 'DELETE', path: `/callout/${t}/like` };
  }
}

/** The words for a result line: "followed 7xKX…", "liked callout 1a2b3c4d…". */
export function socialLabel(action: SocialAction, target: string): string {
  const short = target.length > 12 ? `${target.slice(0, 8)}…` : target;
  switch (action) {
    case 'follow':
      return `followed ${short}`;
    case 'unfollow':
      return `unfollowed ${short}`;
    case 'like':
      return `liked callout ${short}`;
    case 'unlike':
      return `unliked callout ${short}`;
  }
}

/** Space between two social calls from ONE account, so a script looping over
 *  a list does not trip pump's limiter. Not a cap on how many. */
export const SOCIAL_GAP_MS = 1_200;
