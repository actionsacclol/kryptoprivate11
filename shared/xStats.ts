// What an X page says about itself — followers, likes, reposts — read from
// the page the Links panel is already showing (2026-09-20).
//
// No API, no key, no extra request: the panel's browser view has rendered
// x.com for a human to look at, and the host asks that view for the numbers
// on its screen. That is the whole trick, and its whole limit: it reads the
// page a person opened, once, and never crawls. Pulling X pages for every
// flagged coin with the user's cookies is the pattern X detects and
// suspends accounts for, and it is what our own terms tell users not to do
// to a third party.
//
// X's markup changes without notice. Every number here is found by more
// than one route (a test id, an aria-label, a link's text) and is null when
// none of them answer — unknown, never 0 — and the panel says which page
// layout it could not read, so a silent wrong number cannot happen.
//
// `readXPage` is written to run INSIDE the guest page: it takes a tiny
// accessor over the document and its own number parser, references nothing
// else, and is shipped as source text (`xStatsReaderScript`). The same
// function runs in the tests against a fake accessor.

export type XPageKind = 'profile' | 'post' | 'other';

export interface XStats {
  page: XPageKind;
  /** The account the page is about, without the @. */
  handle: string | null;
  followers: number | null;
  following: number | null;
  /** "March 2021" as X shows it. */
  joined: string | null;
  verified: boolean | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  views: number | null;
  bookmarks: number | null;
  /** X is showing its sign-in wall instead of the page. */
  loginWall: boolean;
  /** document.title, for the line under the numbers. */
  title: string;
}

/** The accessor the reader runs on: the real document in the guest, a fake in tests. */
export interface XDomAccess {
  text(selector: string): string | null;
  attr(selector: string, name: string): string | null;
  texts(selector: string): string[];
  title(): string;
  url(): string;
  bodyText(): string;
}

/** "12.3K" → 12300, "1,234" → 1234, "1.2M" → 1200000. Null when no number. */
export function parseCount(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  // The suffix must stand alone ("12 Bookmarks" is twelve, not twelve
  // billion) — and that check belongs to the SUFFIX only. X renders the
  // number and its word without a space ("533Followers"); a look-ahead on
  // the whole match made the number itself back off to "53" (a real
  // account's 533 read as 53, 2026-09-20).
  // A suffix is a lone K/M/B: one that runs into a lower-case word
  // ("Bookmarks") is the word's first letter, one followed by a capital
  // ("12.3KFollowers", X's spacing) or nothing is the multiplier.
  const m = raw.replace(/ /g, ' ').match(/(\d[\d,]*(?:\.\d+)?)(?:\s*([KMBkmb])(?![a-z]))?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as 'K' | 'M' | 'B'] : 1;
  return Math.round(n * mult);
}

/** profile · post · other, from the URL alone. */
export function xPageKindOf(url: string): XPageKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  if (!/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return 'other';
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[1] === 'status') return 'post';
  if (parts.length === 1 && !['i', 'home', 'search', 'explore', 'hashtag', 'login', 'signup', 'settings', 'compose', 'intent'].includes(parts[0].toLowerCase())) return 'profile';
  return 'other';
}

/**
 * Read an X page. Runs in the guest (see `xStatsReaderScript`) and in tests.
 * Self-contained on purpose: only `q` and `count` — no module scope.
 */
export function readXPage(q: XDomAccess, count: (s: string | null | undefined) => number | null): XStats {
  const url = q.url();
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const parts = path.split('/').filter(Boolean);
  const isPost = parts.length >= 3 && parts[1] === 'status';
  const page: XPageKind = isPost ? 'post' : parts.length === 1 ? 'profile' : 'other';
  const out: XStats = {
    page,
    handle: null,
    followers: null,
    following: null,
    joined: null,
    verified: null,
    likes: null,
    reposts: null,
    replies: null,
    views: null,
    bookmarks: null,
    loginWall: false,
    title: q.title(),
  };
  // A number from the first of several routes that answers.
  const firstCount = (routes: Array<() => string | null>): number | null => {
    for (const r of routes) {
      const n = count(r());
      if (n !== null) return n;
    }
    return null;
  };
  // X serves two shells. Signed in: test ids on everything, counts in the
  // controls' aria-labels ("1,203 Likes. Like"). Signed out — what a fresh
  // panel gets (read on 2026-09-20): no data-testid anywhere; the join date
  // is the /about link, the badge an aria-label by the name, the handle's
  // casing only in the title, and a post's counts are the TEXT of controls
  // whose labels are the bare words ("Like" → "310K"). Views are not shown
  // to a signed-out reader at all, so they stay unknown there.
  if (page === 'profile') {
    out.handle = parts[0] ?? null;
    out.followers = firstCount([
      () => q.text('a[href$="/verified_followers"]'),
      () => q.text('a[href$="/followers"]'),
      () => q.attr('a[href$="/verified_followers"]', 'aria-label'),
    ]);
    out.following = firstCount([() => q.text('a[href$="/following"]'), () => q.attr('a[href$="/following"]', 'aria-label')]);
    const joinedRaw = q.text('[data-testid="UserJoinDate"]') ?? q.text('a[href$="/about"]');
    const joinedText = joinedRaw && /Joined/i.test(joinedRaw) ? joinedRaw.replace(/^\s*Joined\s*/i, '').trim() : '';
    const joinedBody = q.bodyText().match(/Joined\s+([A-Z][a-z]+ \d{4})/);
    out.joined = joinedText || (joinedBody ? joinedBody[1] : null);
    const nameBlock = q.text('[data-testid="UserName"]') ?? '';
    const m = nameBlock.match(/@([A-Za-z0-9_]{1,15})/) ?? q.title().match(/\(@([A-Za-z0-9_]{1,15})\)/);
    if (m) out.handle = m[1];
    if (nameBlock) {
      const verifiedSvg = q.attr('[data-testid="UserName"] svg[data-testid="icon-verified"]', 'aria-label') ?? q.attr('[data-testid="UserName"] svg[aria-label]', 'aria-label');
      out.verified = verifiedSvg !== null && /verified/i.test(verifiedSvg);
    } else if (q.text('main h1') !== null) {
      // The signed-out shell shows no timeline, so the only badge on the
      // page is the profile's own; a name with no badge is not verified.
      out.verified = q.attr('main [aria-label="Verified account"]', 'aria-label') !== null;
    }
  } else if (page === 'post') {
    out.handle = parts[0] ?? null;
    const label = (testid: string): string | null => q.attr(`article [data-testid="${testid}"]`, 'aria-label') ?? q.attr(`[data-testid="${testid}"]`, 'aria-label');
    const control = (word: string): string | null => q.text(`article [aria-label="${word}"]`);
    out.likes = firstCount([() => label('like'), () => label('unlike'), () => control('Like'), () => control('Unlike')]);
    out.reposts = firstCount([() => label('retweet'), () => label('unretweet'), () => control('Repost'), () => control('Undo repost')]);
    out.replies = firstCount([() => label('reply'), () => control('Reply')]);
    out.bookmarks = firstCount([() => label('bookmark'), () => label('removeBookmark'), () => control('Bookmark'), () => control('Remove Bookmark')]);
    out.views = firstCount([() => q.attr('article a[href$="/analytics"]', 'aria-label'), () => q.text('article a[href$="/analytics"]')]);
  }
  const body = q.bodyText();
  const nothingRead = out.followers === null && out.following === null && out.likes === null && out.views === null;
  out.loginWall = nothingRead && (/sign in to x|log in to x|sign up now|don.t miss what.s happening/i.test(body) || q.text('[data-testid="login"]') !== null || q.text('[data-testid="loginButton"]') !== null);
  return out;
}

/**
 * The script the panel runs in the guest: builds the accessor from the real
 * document and calls the same reader. Source text, because a guest has no
 * preload and no bridge — this IS the only code of ours that ever runs on
 * an X page, and it only reads.
 */
export function xStatsReaderScript(): string {
  return `(() => {
  const q = {
    text: (s) => { const e = document.querySelector(s); return e ? (e.textContent ?? null) : null; },
    attr: (s, n) => { const e = document.querySelector(s); return e ? e.getAttribute(n) : null; },
    texts: (s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent ?? ''),
    title: () => document.title,
    url: () => location.href,
    bodyText: () => (document.body && document.body.innerText ? document.body.innerText.slice(0, 20000) : ''),
  };
  const count = ${parseCount.toString()};
  return (${readXPage.toString()})(q, count);
})()`;
}

const MAX_COUNT = 1e12;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? Math.round(v) : null);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

/** Untrusted text from a guest page becomes a bounded, typed record — or null. */
export function validateXStats(raw: unknown): XStats | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const page = r.page === 'profile' || r.page === 'post' || r.page === 'other' ? r.page : null;
  if (!page) return null;
  const handle = str(r.handle, 15);
  return {
    page,
    handle: handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null,
    followers: int(r.followers),
    following: int(r.following),
    joined: str(r.joined, 40),
    verified: typeof r.verified === 'boolean' ? r.verified : null,
    likes: int(r.likes),
    reposts: int(r.reposts),
    replies: int(r.replies),
    views: int(r.views),
    bookmarks: int(r.bookmarks),
    loginWall: r.loginWall === true,
    title: str(r.title, 120) ?? '',
  };
}

/** "12.3K" for a strip, the way X abbreviates: one decimal below a hundred
 *  of the unit (12.3K, 45.2K, 1.2M), none above (123K, 250M), no ".0". */
export function fmtCount(n: number | null): string {
  if (n === null) return '—';
  const unit = (v: number, suffix: string): string => {
    const s = v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
    return `${s}${suffix}`;
  };
  if (n >= 1e9) return unit(n / 1e9, 'B');
  if (n >= 1e6) return unit(n / 1e6, 'M');
  if (n >= 1e3) return unit(n / 1e3, 'K');
  return String(n);
}

/** One line for the panel and the token header. Says what could not be read. */
export function describeXStats(s: XStats): string {
  if (s.loginWall) return 'X is showing its sign-in wall — sign in inside the box and it reads again';
  if (s.page === 'profile') {
    const parts = [
      s.handle ? `@${s.handle}` : null,
      s.followers !== null ? `${fmtCount(s.followers)} followers` : 'followers unknown',
      s.following !== null ? `${fmtCount(s.following)} following` : null,
      s.joined ? `joined ${s.joined}` : null,
      s.verified === true ? 'verified' : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  if (s.page === 'post') {
    const parts = [
      s.handle ? `post by @${s.handle}` : 'post',
      s.likes !== null ? `${fmtCount(s.likes)} likes` : 'likes unknown',
      s.reposts !== null ? `${fmtCount(s.reposts)} reposts` : null,
      s.replies !== null ? `${fmtCount(s.replies)} replies` : null,
      s.views !== null ? `${fmtCount(s.views)} views` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  return 'not a profile or a post — nothing to read';
}
