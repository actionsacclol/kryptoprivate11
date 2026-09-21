// What a token's Telegram link and website domain say about themselves,
// from two PUBLIC records that need no key and no account (2026-09-20).
//
// • Telegram: `https://t.me/<name>` serves a preview page to anyone — the
//   title, the description, and "149 subscribers" (a channel) or "26 481
//   members, 1 564 online" (a group). That is the page a browser shows a
//   person who has no Telegram; the app reads the same page. A PRIVATE
//   invite (`t.me/+…`) shows a generic "Join group chat" page with no count,
//   and that stays unknown here — Telegram publishes no number for it.
// • The website's domain: every registry publishes its domains' records
//   over RDAP (the standard that replaced WHOIS): registration date,
//   expiry, registrar. IANA lists which server answers for which ending
//   (data.iana.org/rdap/dns.json), so the lookup asks the registry itself,
//   never the token's site. A few endings (.io, .me, .co on 2026-09-20)
//   publish no RDAP at all, and the record is honestly unknown there.
//
// Traffic — how many people visit the site — is NOT here, and is not
// obtainable without a paid or keyed service; a number for it would be a
// guess. The age of the domain, who hosts the site, and whether the site
// names the coin (shared/siteRead.ts) are what a person can actually check.
//
// Pure: parsers over text and JSON, run in main against the live answers
// and in tests against fixtures. Unknown is null, never 0.

export type TelegramKind = 'channel' | 'group' | 'account' | 'invite' | 'unknown';

export interface TelegramPreview {
  /** The page that was read, normalised to https://t.me/… */
  url: string;
  kind: TelegramKind;
  title: string | null;
  /** Subscribers for a channel, members for a group. Null when the page shows none. */
  members: number | null;
  /** The word Telegram used for the count. */
  countWord: 'subscribers' | 'members' | null;
  online: number | null;
  description: string | null;
  /** A private invite: Telegram shows its generic join page and no count. */
  privateInvite: boolean;
}

export interface DomainRecord {
  domain: string;
  /** ISO dates as the registry states them. */
  registeredAt: string | null;
  expiresAt: string | null;
  changedAt: string | null;
  registrar: string | null;
  statuses: string[];
}

/** Where a website lives, before any lookup. */
export interface WebsiteHost {
  host: string;
  /** The registrable domain to look up, or null when the site sits on a shared platform. */
  domain: string | null;
  tld: string | null;
  /** "Vercel", "GitHub Pages", … when the host is a shared platform's; the platform's domain age says nothing about the coin. */
  hostedOn: string | null;
}

/** How far a lookup has got: nothing asked · in flight · answered · could not answer. */
export type LookupState = 'none' | 'pending' | 'ok' | 'failed';

export interface TelegramLookup {
  url: string;
  state: LookupState;
  preview: TelegramPreview | null;
  readAt: number | null;
  reason: string | null;
}

export interface DomainLookup {
  url: string;
  host: string;
  domain: string | null;
  hostedOn: string | null;
  state: LookupState;
  record: DomainRecord | null;
  readAt: number | null;
  reason: string | null;
}

/** Both lookups for one token, as main answers the renderer. */
export interface LinkIntel {
  mint: string;
  /** False when main holds no facts for the token yet (nothing to look up). */
  hasFacts: boolean;
  telegram: TelegramLookup | null;
  website: DomainLookup | null;
}

/** What rides into the scripts and the rule variables (shared/automation.ts). */
export interface LinkIntelFacts {
  telegram: { kind: TelegramKind; members: number | null; countWord: 'subscribers' | 'members' | null; online: number | null; title: string | null; readAt: number } | null;
  domain: { name: string | null; registeredAt: string | null; registrar: string | null; hostedOn: string | null; readAt: number } | null;
}

/** Normalise any Telegram link to the preview page, or null when it is not one. */
export function telegramPreviewUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 't.me' && host !== 'telegram.me') return null;
  let path = u.pathname.replace(/\/+$/, '');
  // The "channel view" (t.me/s/name) has the same preview at t.me/name.
  if (path.startsWith('/s/')) path = path.slice(2);
  if (!path || path === '/') return null;
  // One segment (a name, a +invite) or joinchat/<hash>; a message link
  // (t.me/name/123) points at the same room.
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'joinchat' && parts[1]) return `https://t.me/joinchat/${parts[1]}`;
  if (!/^[+A-Za-z0-9_]{1,64}$/.test(parts[0])) return null;
  return `https://t.me/${parts[0]}`;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
const stripTags = (s: string): string => decodeEntities(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const block = (html: string, cls: string): string | null => {
  const m = html.match(new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)</div>`));
  return m ? stripTags(m[1]) || null : null;
};
/** "26 481" / "10,695,679" / "1 564" → the integer. Telegram writes full numbers. */
const digits = (s: string): number | null => {
  const d = s.replace(/[^\d]/g, '');
  if (!d) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
};

/** Read Telegram's public preview page. Unknown stays null. */
export function parseTelegramPreview(html: string, url: string): TelegramPreview {
  const out: TelegramPreview = { url, kind: 'unknown', title: null, members: null, countWord: null, online: null, description: null, privateInvite: false };
  if (typeof html !== 'string' || !html) return out;
  out.title = block(html, 'tgme_page_title');
  const extra = block(html, 'tgme_page_extra');
  const desc = block(html, 'tgme_page_description');
  out.description = desc ? desc.slice(0, 300) : null;
  const isInvite = /^https:\/\/t\.me\/(\+|joinchat\/)/.test(url);
  if (extra) {
    const count = extra.match(/([\d\s  ,.]+)\s*(subscribers|members)\b/i);
    if (count) {
      out.members = digits(count[1]);
      out.countWord = count[2].toLowerCase() as 'subscribers' | 'members';
    }
    const online = extra.match(/([\d\s  ,.]+)\s*online\b/i);
    if (online) out.online = digits(online[1]);
    if (out.countWord === 'subscribers') out.kind = 'channel';
    else if (out.countWord === 'members') out.kind = 'group';
    else if (/^@/.test(extra)) out.kind = 'account';
  }
  if (isInvite) {
    // A private invite the app can see into shows the count; the generic
    // "Join group chat on Telegram" page shows none, and that is the fact.
    if (out.members === null) {
      out.privateInvite = /Join group chat on Telegram|Join channel on Telegram/i.test(html) || out.title === null;
      if (out.kind === 'unknown') out.kind = 'invite';
    } else if (out.kind === 'unknown') out.kind = 'group';
  }
  return out;
}

/** The registry's RDAP domain object → the dates and registrar it states. */
export function parseRdapDomain(json: unknown, domain: string): DomainRecord | null {
  if (typeof json !== 'object' || json === null) return null;
  const j = json as Record<string, unknown>;
  const events = Array.isArray(j.events) ? (j.events as Array<Record<string, unknown>>) : [];
  if (!Array.isArray(j.events) && typeof j.ldhName !== 'string') return null;
  const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
  const when = (action: string): string | null => {
    const e = events.find((x) => typeof x.eventAction === 'string' && x.eventAction.toLowerCase() === action);
    return e ? iso(e.eventDate) : null;
  };
  let registrar: string | null = null;
  const entities = Array.isArray(j.entities) ? (j.entities as Array<Record<string, unknown>>) : [];
  for (const e of entities) {
    const roles = Array.isArray(e.roles) ? (e.roles as unknown[]) : [];
    if (!roles.includes('registrar')) continue;
    const v = e.vcardArray;
    const props = Array.isArray(v) && Array.isArray(v[1]) ? (v[1] as unknown[]) : [];
    const fn = props.find((p) => Array.isArray(p) && p[0] === 'fn') as unknown[] | undefined;
    if (fn && typeof fn[3] === 'string' && fn[3].trim()) {
      registrar = fn[3].trim().slice(0, 80);
      break;
    }
  }
  const statuses = Array.isArray(j.status) ? (j.status as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 12) : [];
  return {
    domain: typeof j.ldhName === 'string' ? j.ldhName.toLowerCase() : domain,
    registeredAt: when('registration'),
    expiresAt: when('expiration'),
    changedAt: when('last changed'),
    registrar,
    statuses,
  };
}

/** IANA's RDAP bootstrap → the https base URL that answers for a TLD, or null. */
export function rdapBaseFor(bootstrap: unknown, tld: string): string | null {
  if (typeof bootstrap !== 'object' || bootstrap === null) return null;
  const services = (bootstrap as Record<string, unknown>).services;
  if (!Array.isArray(services)) return null;
  const want = tld.toLowerCase();
  for (const svc of services) {
    if (!Array.isArray(svc) || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
    if (!(svc[0] as unknown[]).some((t) => typeof t === 'string' && t.toLowerCase() === want)) continue;
    const base = (svc[1] as unknown[]).find((u) => typeof u === 'string' && u.startsWith('https://')) as string | undefined;
    if (base) return base.endsWith('/') ? base : `${base}/`;
  }
  return null;
}

/** Every host any RDAP base in the bootstrap lives on — the lookup may talk to these and nothing else. */
export function rdapHosts(bootstrap: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof bootstrap !== 'object' || bootstrap === null) return out;
  const services = (bootstrap as Record<string, unknown>).services;
  if (!Array.isArray(services)) return out;
  for (const svc of services) {
    if (!Array.isArray(svc) || !Array.isArray(svc[1])) continue;
    for (const u of svc[1] as unknown[]) {
      if (typeof u !== 'string' || !u.startsWith('https://')) continue;
      try {
        out.add(new URL(u).hostname.toLowerCase());
      } catch {
        /* not a URL */
      }
    }
  }
  return out;
}

/**
 * Shared platforms a memecoin site is often dropped on. The site has no
 * domain of its own there, so a registration date would describe Vercel,
 * not the coin — the lookup is skipped and the platform is named instead.
 */
export const SHARED_HOSTS: Readonly<Record<string, string>> = {
  'vercel.app': 'Vercel',
  'netlify.app': 'Netlify',
  'github.io': 'GitHub Pages',
  'pages.dev': 'Cloudflare Pages',
  'web.app': 'Firebase',
  'firebaseapp.com': 'Firebase',
  'framer.website': 'Framer',
  'framer.app': 'Framer',
  'carrd.co': 'Carrd',
  'webflow.io': 'Webflow',
  'wixsite.com': 'Wix',
  'wixstudio.io': 'Wix',
  'godaddysites.com': 'GoDaddy Sites',
  'mystrikingly.com': 'Strikingly',
  'weebly.com': 'Weebly',
  'wordpress.com': 'WordPress.com',
  'blogspot.com': 'Blogger',
  'notion.site': 'Notion',
  'gitbook.io': 'GitBook',
  'linktr.ee': 'Linktree',
  'bio.link': 'Bio Link',
  'beacons.ai': 'Beacons',
  'squarespace.com': 'Squarespace',
  'surge.sh': 'Surge',
  'glitch.me': 'Glitch',
  'replit.app': 'Replit',
  'repl.co': 'Replit',
  'onrender.com': 'Render',
  'herokuapp.com': 'Heroku',
  'fly.dev': 'Fly.io',
  'railway.app': 'Railway',
  'neocities.org': 'Neocities',
  'tiiny.site': 'Tiiny Host',
  'on.fleek.co': 'Fleek',
  'eth.limo': 'ENS via eth.limo',
  'ipfs.io': 'IPFS gateway',
  'ipfs.dweb.link': 'IPFS gateway',
  'pump.fun': 'pump.fun',
};

/** Country-code second levels where the registrable name is three labels (foo.co.uk). */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'co.in', 'net.in', 'org.in',
  'com.br', 'net.br', 'com.mx', 'com.ar', 'com.tr', 'co.za', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'com.my',
  'com.ph', 'co.id', 'com.vn', 'co.th', 'com.pk', 'com.ng', 'com.eg', 'com.sa', 'com.ua', 'com.pl', 'com.co',
  'com.pe', 'com.ve', 'com.uy', 'com.ec', 'com.do', 'com.gt', 'com.bo', 'com.py', 'co.il', 'com.ru',
]);

/** Where a website lives: its host, the domain to look up (or the platform it sits on). */
export function websiteHostOf(url: string | null | undefined): WebsiteHost | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  for (const suffix of Object.keys(SHARED_HOSTS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return { host, domain: null, tld, hostedOn: SHARED_HOSTS[suffix] };
  }
  const lastTwo = labels.slice(-2).join('.');
  const domain = TWO_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;
  return { host, domain, tld, hostedOn: null };
}

/** Whole days since registration, or null. */
export function domainAgeDays(registeredAt: string | null | undefined, now = Date.now()): number | null {
  if (!registeredAt) return null;
  const t = Date.parse(registeredAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** "Feb 2010" for a strip; "—" when unknown. */
export function fmtRegistered(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2 years", "3 months", "12 days" — the age a person would say. */
export function fmtAge(days: number | null): string {
  if (days === null) return '—';
  if (days < 1) return 'today';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 730) return `${Math.floor(days / 30)} months`;
  return `${Math.floor(days / 365)} years`;
}

const kCount = (n: number): string => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(n);
};

/** One line for a strip: what the Telegram page said. */
export function describeTelegram(p: TelegramPreview): string {
  if (p.privateInvite) return 'private invite — Telegram shows no member count until you join';
  const parts: string[] = [];
  if (p.kind === 'channel') parts.push('channel');
  else if (p.kind === 'group') parts.push('group');
  else if (p.kind === 'account') parts.push('an account, not a room');
  if (p.members !== null) parts.push(`${kCount(p.members)} ${p.countWord ?? 'members'}`);
  if (p.online !== null) parts.push(`${kCount(p.online)} online`);
  if (!parts.length) return 'no public count on this page';
  return parts.join(' · ');
}

/** One line for a strip: what the registry said about the domain. */
export function describeDomain(w: Pick<WebsiteHost, 'host' | 'domain' | 'hostedOn'> | null, r: DomainRecord | null, now = Date.now()): string {
  if (!w) return 'no website';
  if (w.hostedOn) return `hosted on ${w.hostedOn} — no domain of its own`;
  if (!r) return `${w.domain ?? w.host}: no registry record read`;
  const age = domainAgeDays(r.registeredAt, now);
  const parts = [w.domain ?? w.host];
  if (r.registeredAt) parts.push(`registered ${fmtRegistered(r.registeredAt)} (${fmtAge(age)})`);
  else parts.push('registration date not published');
  if (r.registrar) parts.push(`via ${r.registrar}`);
  return parts.join(' · ');
}
