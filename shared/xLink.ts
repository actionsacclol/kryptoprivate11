// What a token's "X link" actually points at.
//
// A launch's twitter field is free text, and today the whole app treats it as
// a boolean: has an X link, yes or no. In a live sample the four things that
// turn up behind that boolean are not remotely equivalent:
//
//   • a PROFILE      — x.com/handle. There is an account to judge.
//   • a POST         — x.com/handle/status/123. Usually someone else's viral
//                      tweet the launcher is riding. There is no account of
//                      theirs at all, and "has socials" is doing real work
//                      misleading you here.
//   • a COMMUNITY    — x.com/i/communities/123. A room, not an account.
//   • a SEARCH/HASHTAG — nothing whatsoever.
//
// Everything anyone would want to ask about the account is undefined for
// three of those four, so this is the first question, not a detail. It is
// pure string work: no key, no request, nothing leaves the machine.
//
// It deliberately does NOT touch the existing `socials.twitter` boolean —
// the odds model was fit on that feature and must keep scoring what it was
// trained on.

export type XLinkKind = 'profile' | 'post' | 'community' | 'search' | 'other-x' | 'not-x' | 'none';

export interface XLink {
  kind: XLinkKind;
  /** The account the link names, without the @. Null when there is none. */
  handle: string | null;
  /** For a post link, the post's id. */
  postId: string | null;
  /** What to say in one phrase. */
  label: string;
}

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  // Embed mirrors people paste; they carry the same path shape.
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
]);

/** Path segments that are X's own routes, never a handle. */
const RESERVED = new Set([
  'i', 'home', 'search', 'hashtag', 'explore', 'notifications', 'messages', 'settings',
  'compose', 'intent', 'share', 'login', 'signup', 'about', 'tos', 'privacy', 'download',
]);

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const NONE: XLink = { kind: 'none', handle: null, postId: null, label: 'no X link' };

/**
 * Classify a token's X link. Never throws, never guesses: anything it cannot
 * resolve to an account comes back without a handle, so a caller cannot
 * accidentally look up something that was never there.
 */
export function parseXLink(raw: string | null | undefined): XLink {
  if (typeof raw !== 'string' || !raw.trim()) return NONE;
  let url: URL;
  try {
    // A missing scheme is common in creator metadata.
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { kind: 'not-x', handle: null, postId: null, label: 'not a link' };
  }
  // Hostname, never a substring: "x.com.evil.tld" is not X.
  if (!X_HOSTS.has(url.hostname.toLowerCase())) {
    return { kind: 'not-x', handle: null, postId: null, label: 'not an X link' };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) return { kind: 'other-x', handle: null, postId: null, label: 'X, but no account' };

  const first = parts[0].toLowerCase();
  if (first === 'i' && parts[1]?.toLowerCase() === 'communities') {
    return { kind: 'community', handle: null, postId: null, label: 'a community, not an account' };
  }
  if (first === 'search' || first === 'hashtag') {
    return { kind: 'search', handle: null, postId: null, label: 'a search, not an account' };
  }
  if (RESERVED.has(first)) return { kind: 'other-x', handle: null, postId: null, label: 'X, but no account' };
  if (!HANDLE_RE.test(parts[0])) return { kind: 'other-x', handle: null, postId: null, label: 'X, but no account' };

  const handle = parts[0];
  const isStatus = parts[1]?.toLowerCase() === 'status' || parts[1]?.toLowerCase() === 'statuses';
  if (isStatus && parts[2] && /^\d+$/.test(parts[2])) {
    return { kind: 'post', handle, postId: parts[2], label: `a post by @${handle}, not their account` };
  }
  if (parts.length === 1 || ['with_replies', 'media', 'likes', 'photo'].includes(parts[1]?.toLowerCase() ?? '')) {
    return { kind: 'profile', handle, postId: null, label: `@${handle}` };
  }
  return { kind: 'other-x', handle, postId: null, label: `@${handle}` };
}

/** True when there is an account worth looking up. */
export function hasAccount(link: XLink): boolean {
  return link.kind === 'profile' && link.handle !== null;
}

export interface ReuseCount {
  /** Other launches linking the SAME account. */
  handle: number;
  /** Other launches linking the SAME post. */
  post: number;
}

/**
 * How many other launches in view point at the same account or the same post.
 *
 * This is the whole free half of the feature: in one live hour a single post
 * was linked by 16 different launches and one handle by 22. That is a farm,
 * and it is visible with no API, no key and no request — just the links the
 * app already has. Counts EXCLUDE the token being asked about.
 */
export function countReuse(link: XLink, others: Array<{ mint: string; twitter: string | null }>, selfMint: string): ReuseCount {
  const out: ReuseCount = { handle: 0, post: 0 };
  if (link.kind === 'none' || link.kind === 'not-x') return out;
  for (const o of others) {
    if (o.mint === selfMint) continue;
    const l = parseXLink(o.twitter);
    if (link.handle && l.handle && l.handle.toLowerCase() === link.handle.toLowerCase()) out.handle++;
    if (link.postId && l.postId && l.postId === link.postId) out.post++;
  }
  return out;
}
