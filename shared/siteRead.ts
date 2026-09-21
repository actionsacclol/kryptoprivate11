// What a token's own website says about itself, read off the page the Links
// panel is already showing (2026-09-20). The same trick as shared/xStats.ts:
// the panel's browser view has rendered the site for a person to look at,
// and the host asks that view what is on its screen. No request of ours
// reaches the creator's server beyond the one the person made by opening
// the page — the site never learns that anyone is checking it.
//
// What is worth knowing, and checkable from the page alone:
//   • does the site NAME this coin — the contract address in its text or its
//     links? A site that never mentions the mint was made for something else
//     (or for every coin at once);
//   • which X accounts and Telegram rooms it links to — do they match what
//     the launch published?
//   • how much of a site it is — words, outbound hosts, the builder that
//     made it (meta generator);
//   • whether it asks visitors to connect a wallet or claim something —
//     what a drainer page does, said as the words on the page, not a verdict.
//
// `readSitePage` runs INSIDE the guest page: it takes only an accessor and
// the mint, references nothing else, and ships as source text. The same
// function runs in the tests against a fake accessor. The guest is a
// creator's page and may lie; the reply is validated in main into a bounded
// record before anything reads it.

export interface SiteRead {
  url: string;
  host: string;
  title: string | null;
  description: string | null;
  /** The token's contract address appears in the page text or a link on it. */
  namesContract: boolean;
  /** X accounts the page links to (lower-case handles, no @, at most 10). */
  xHandles: string[];
  /** Telegram rooms the page links to (https://t.me/…, at most 10). */
  telegramLinks: string[];
  /** Distinct other hosts the page links out to. */
  outboundHosts: number;
  wordCount: number;
  /** The site builder's meta generator tag, when it has one. */
  generator: string | null;
  /** The page text asks to connect a wallet or claim tokens / an airdrop. */
  mentionsConnectWallet: boolean;
}

/** The accessor the reader runs on: the real document in the guest, a fake in tests. */
export interface SiteDomAccess {
  title(): string;
  url(): string;
  /** A meta tag's content by name or property. */
  meta(name: string): string | null;
  /** Every anchor's raw href, as written. */
  hrefs(): string[];
  bodyText(): string;
}

/**
 * Read a website page. Runs in the guest (see `siteReaderScript`) and in
 * tests. Self-contained on purpose: only `q` and `mint`, no module scope.
 */
export function readSitePage(q: SiteDomAccess, mint: string): SiteRead {
  const url = q.url();
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  const text = q.bodyText();
  const hrefs = q.hrefs();
  const xHandles: string[] = [];
  const telegramLinks: string[] = [];
  const hosts = new Set<string>();
  const notHandles = ['i', 'home', 'search', 'explore', 'hashtag', 'intent', 'share', 'login', 'signup', 'settings', 'compose'];
  for (const raw of hrefs) {
    let u: URL;
    try {
      u = new URL(raw, url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const h = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^mobile\./, '');
    if (h === 'x.com' || h === 'twitter.com') {
      const m = u.pathname.match(/^\/@?([A-Za-z0-9_]{1,15})(?:\/|$)/);
      if (m && notHandles.indexOf(m[1].toLowerCase()) < 0) {
        const handle = m[1].toLowerCase();
        if (xHandles.indexOf(handle) < 0 && xHandles.length < 10) xHandles.push(handle);
      }
    } else if (h === 't.me' || h === 'telegram.me') {
      const link = `https://t.me${u.pathname.replace(/\/+$/, '')}`;
      if (link !== 'https://t.me' && telegramLinks.indexOf(link) < 0 && telegramLinks.length < 10) telegramLinks.push(link);
    } else if (h && h !== host && !h.endsWith(`.${host}`)) {
      hosts.add(h);
    }
  }
  const trimmed = text.trim();
  const description = q.meta('description') ?? q.meta('og:description');
  const generator = q.meta('generator');
  return {
    url,
    host,
    title: q.title() || null,
    description: description ? description.slice(0, 300) : null,
    namesContract: mint.length > 0 && (text.indexOf(mint) >= 0 || hrefs.some((h) => h.indexOf(mint) >= 0)),
    xHandles,
    telegramLinks,
    outboundHosts: hosts.size,
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
    generator: generator ? generator.slice(0, 80) : null,
    mentionsConnectWallet: /connect\s+(your\s+)?wallet|claim\s+(your\s+)?(airdrop|rewards?|tokens?)|walletconnect/i.test(text),
  };
}

/**
 * The script the panel runs in the guest: builds the accessor from the real
 * document and calls the same reader. The mint is the only value inlined,
 * and only after it looks like one — the guest is a stranger's page and
 * gets nothing else of ours.
 */
export function siteReaderScript(mint: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('not a mint');
  return `(() => {
  const q = {
    title: () => document.title,
    url: () => location.href,
    meta: (n) => { const e = document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]'); return e ? e.getAttribute('content') : null; },
    hrefs: () => Array.from(document.querySelectorAll('a[href]')).slice(0, 2000).map((a) => a.getAttribute('href') || ''),
    bodyText: () => (document.body && document.body.innerText ? document.body.innerText.slice(0, 200000) : ''),
  };
  return (${readSitePage.toString()})(q, ${JSON.stringify(mint)});
})()`;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const int = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : 0);

/** Untrusted text from a guest page becomes a bounded, typed record — or null. */
export function validateSiteRead(raw: unknown): SiteRead | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url, 2_048);
  if (!url || !/^https?:\/\//.test(url)) return null;
  const handles = Array.isArray(r.xHandles) ? (r.xHandles as unknown[]).filter((h): h is string => typeof h === 'string' && /^[a-z0-9_]{1,15}$/.test(h)).slice(0, 10) : [];
  const tg = Array.isArray(r.telegramLinks) ? (r.telegramLinks as unknown[]).filter((l): l is string => typeof l === 'string' && /^https:\/\/t\.me\/[+A-Za-z0-9_/-]{1,120}$/.test(l)).slice(0, 10) : [];
  return {
    url,
    host: str(r.host, 253) ?? '',
    title: str(r.title, 200),
    description: str(r.description, 300),
    namesContract: r.namesContract === true,
    xHandles: handles,
    telegramLinks: tg,
    outboundHosts: int(r.outboundHosts, 10_000),
    wordCount: int(r.wordCount, 1_000_000),
    generator: str(r.generator, 80),
    mentionsConnectWallet: r.mentionsConnectWallet === true,
  };
}

/** Does the site link to the token's own X account? Null when the token has none to compare. */
export function siteLinksX(s: SiteRead, tokenXHandle: string | null | undefined): boolean | null {
  if (!tokenXHandle) return null;
  const want = tokenXHandle.toLowerCase();
  return s.xHandles.some((h) => h === want);
}

/** One line for a strip: what the site says, with what it does not. */
export function describeSiteRead(s: SiteRead, tokenXHandle: string | null | undefined): string {
  const parts: string[] = [];
  parts.push(s.namesContract ? 'names the contract' : 'does not name the contract');
  const same = siteLinksX(s, tokenXHandle);
  if (same === true) parts.push(`links the token’s X (@${tokenXHandle})`);
  else if (same === false) parts.push(s.xHandles.length ? `links a different X (@${s.xHandles[0]})` : 'links no X');
  else if (s.xHandles.length) parts.push(`links X @${s.xHandles[0]}`);
  if (s.telegramLinks.length) parts.push(`${s.telegramLinks.length} Telegram link${s.telegramLinks.length === 1 ? '' : 's'}`);
  parts.push(`${s.wordCount} words`, `${s.outboundHosts} outbound host${s.outboundHosts === 1 ? '' : 's'}`);
  if (s.generator) parts.push(`built with ${s.generator}`);
  if (s.mentionsConnectWallet) parts.push('asks to connect a wallet or claim');
  return parts.join(' · ');
}
