// Telegram member counts and website domain records for a token's links,
// looked up in main from two public sources (2026-09-20) — see
// shared/linkIntel.ts for what they are and why they are honest.
//
// When it runs: only when someone asked about THIS token — a person opened
// its page or the Links panel, or a script called bot.links / bot.market for
// it. Rules evaluating every launch read the cache and never trigger a
// lookup, so the scanner's hundreds of coins an hour do not turn into
// hundreds of requests to Telegram and the registries. On top of that, each
// source has a 60-an-hour budget and a failure is remembered for a while,
// so a looping caller cannot hammer anyone.
//
// Where the requests go: t.me (Telegram's preview page), data.iana.org (the
// list of RDAP servers) and the registry that list names for the domain's
// ending. Never the token's own website. The fetch here is its own small
// thing rather than data/http.ts's getJson: that helper is JSON-only,
// pinned to one fixed host per provider and refuses every redirect, while
// this needs HTML from t.me and a registry host chosen from IANA's list.
// Every host is still checked against an allowlist before a byte goes out,
// and a redirect is followed only onto another allowlisted host.

import {
  parseRdapDomain,
  parseTelegramPreview,
  rdapBaseFor,
  rdapHosts,
  telegramPreviewUrl,
  websiteHostOf,
  type DomainLookup,
  type DomainRecord,
  type LinkIntel,
  type LinkIntelFacts,
  type LookupState,
  type TelegramLookup,
  type TelegramPreview,
  type WebsiteHost,
} from '@shared/linkIntel';
import { tokenLinks } from '@shared/tokenLinks';
import * as market from './market';

export type { DomainLookup, LinkIntel, LookupState, TelegramLookup };

const TG_TTL = 30 * 60_000;
const TG_FAIL_TTL = 10 * 60_000;
const DOMAIN_TTL = 24 * 3_600_000;
const DOMAIN_FAIL_TTL = 60 * 60_000;
const BOOT_TTL = 24 * 3_600_000;
const PER_HOUR = 60;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 9_000;
const UA = 'Mozilla/5.0 (compatible; KryptoBot; +https://krypt.cc)';
const IANA_URL = 'https://data.iana.org/rdap/dns.json';
const TG_HOSTS = new Set(['t.me']);
const IANA_HOSTS = new Set(['data.iana.org']);

interface Entry<T> {
  value: T | null;
  readAt: number;
  reason: string | null;
  expires: number;
}

const tgCache = new Map<string, Entry<TelegramPreview>>();
const domainCache = new Map<string, Entry<DomainRecord>>();
const inflight = new Map<string, Promise<void>>();
let bootstrap: { data: unknown; hosts: Set<string>; at: number } | null = null;
let bootstrapPending: Promise<{ data: unknown; hosts: Set<string>; at: number } | null> | null = null;
const tgCalls: number[] = [];
const rdapCalls: number[] = [];

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;
let doFetch: FetchLike = (input, init) => fetch(input, init);

/** Test seam: answer the requests yourself. */
export function _setFetch(f: FetchLike | null): void {
  doFetch = f ?? ((input, init) => fetch(input, init));
}

/** Test seam. */
export function _reset(): void {
  tgCache.clear();
  domainCache.clear();
  inflight.clear();
  bootstrap = null;
  bootstrapPending = null;
  tgCalls.length = 0;
  rdapCalls.length = 0;
}

/** Sliding hour. True = a slot was taken. */
function budget(calls: number[], now = Date.now()): boolean {
  while (calls.length && calls[0] < now - 3_600_000) calls.shift();
  if (calls.length >= PER_HOUR) return false;
  calls.push(now);
  return true;
}

type Body = { ok: true; status: number; text: string } | { ok: false; status: number | null; reason: string };

async function fetchBody(url: string, opts: { accept: string; allowHosts: Set<string>; hops?: number }): Promise<Body> {
  const hops = opts.hops ?? 0;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: null, reason: 'malformed URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, status: null, reason: 'not https' };
  if (!opts.allowHosts.has(u.hostname.toLowerCase())) return { ok: false, status: null, reason: `refused host ${u.hostname}` };
  let res: Response;
  try {
    res = await doFetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: opts.accept, 'user-agent': UA },
    });
  } catch (err) {
    return { ok: false, status: null, reason: `network: ${(err as Error).message}` };
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || hops >= 2) return { ok: false, status: res.status, reason: 'redirected' };
    let next: URL;
    try {
      next = new URL(loc, u);
    } catch {
      return { ok: false, status: res.status, reason: 'bad redirect' };
    }
    // The next host is checked against the same allowlist.
    return fetchBody(next.toString(), { ...opts, hops: hops + 1 });
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return { ok: false, status: res.status, reason: 'too large' };
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, status: res.status, reason: `read: ${(err as Error).message}` };
  }
  if (buf.length > MAX_BYTES) return { ok: false, status: res.status, reason: 'too large' };
  return { ok: true, status: res.status, text: buf.toString('utf8') };
}

// ── Telegram ───────────────────────────────────────────────────────────

/** The preview of a Telegram link, from cache or t.me. Null when it is not a Telegram link. */
export async function lookupTelegram(rawUrl: string): Promise<Entry<TelegramPreview> | null> {
  const url = telegramPreviewUrl(rawUrl);
  if (!url) return null;
  const hit = tgCache.get(url);
  if (hit && hit.expires > Date.now()) return hit;
  const key = `tg:${url}`;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      (async () => {
        const now = Date.now();
        if (!budget(tgCalls, now)) {
          tgCache.set(url, { value: null, readAt: now, reason: `Telegram lookups paused: ${PER_HOUR} an hour`, expires: now + 5 * 60_000 });
          return;
        }
        const r = await fetchBody(url, { accept: 'text/html', allowHosts: TG_HOSTS });
        if (!r.ok) {
          tgCache.set(url, { value: null, readAt: now, reason: r.status ? `t.me answered ${r.status}` : r.reason, expires: now + TG_FAIL_TTL });
          return;
        }
        if (r.status !== 200) {
          tgCache.set(url, { value: null, readAt: now, reason: `t.me answered ${r.status}`, expires: now + TG_FAIL_TTL });
          return;
        }
        const p = parseTelegramPreview(r.text, url);
        const got = p.members !== null || p.title !== null || p.privateInvite;
        tgCache.set(url, {
          value: got ? p : null,
          readAt: Date.now(),
          reason: got ? null : 'no preview on the page — not a public channel, group or account',
          expires: Date.now() + (got ? TG_TTL : TG_FAIL_TTL),
        });
      })().finally(() => inflight.delete(key)),
    );
  }
  await inflight.get(key);
  return tgCache.get(url) ?? null;
}

// ── Domain records (RDAP) ──────────────────────────────────────────────

async function loadBootstrap(): Promise<{ data: unknown; hosts: Set<string>; at: number } | null> {
  if (bootstrap && bootstrap.at > Date.now() - BOOT_TTL) return bootstrap;
  if (!bootstrapPending) {
    bootstrapPending = (async () => {
      const r = await fetchBody(IANA_URL, { accept: 'application/json', allowHosts: IANA_HOSTS });
      if (!r.ok || r.status !== 200) return null;
      try {
        const data: unknown = JSON.parse(r.text);
        bootstrap = { data, hosts: rdapHosts(data), at: Date.now() };
        return bootstrap;
      } catch {
        return null;
      }
    })().finally(() => {
      bootstrapPending = null;
    });
  }
  return bootstrapPending;
}

/** The registry's record for a domain, from cache or RDAP. */
export async function lookupDomain(domain: string): Promise<Entry<DomainRecord> | null> {
  const name = domain.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return null;
  const hit = domainCache.get(name);
  if (hit && hit.expires > Date.now()) return hit;
  const key = `rdap:${name}`;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      (async () => {
        const now = Date.now();
        const fail = (reason: string, ttl = DOMAIN_FAIL_TTL): void => {
          domainCache.set(name, { value: null, readAt: now, reason, expires: now + ttl });
        };
        if (!budget(rdapCalls, now)) return fail(`domain lookups paused: ${PER_HOUR} an hour`, 5 * 60_000);
        const boot = await loadBootstrap();
        if (!boot) return fail('IANA’s list of registry servers could not be fetched');
        const tld = name.slice(name.lastIndexOf('.') + 1);
        const base = rdapBaseFor(boot.data, tld);
        if (!base) return fail(`the .${tld} registry publishes no RDAP record`, DOMAIN_TTL);
        const r = await fetchBody(`${base}domain/${name}`, { accept: 'application/rdap+json, application/json', allowHosts: boot.hosts });
        if (!r.ok) return fail(r.status ? `the registry answered ${r.status}` : r.reason);
        if (r.status === 404) return fail('the registry has no record under that name', DOMAIN_TTL);
        if (r.status !== 200) return fail(`the registry answered ${r.status}`);
        let json: unknown;
        try {
          json = JSON.parse(r.text);
        } catch {
          return fail('the registry’s answer was not JSON');
        }
        const rec = parseRdapDomain(json, name);
        if (!rec) return fail('the registry’s answer was not a domain record');
        domainCache.set(name, { value: rec, readAt: Date.now(), reason: null, expires: Date.now() + DOMAIN_TTL });
      })().finally(() => inflight.delete(key)),
    );
  }
  await inflight.get(key);
  return domainCache.get(name) ?? null;
}

// ── Per token ──────────────────────────────────────────────────────────

interface Targets {
  hasFacts: boolean;
  tg: string | null;
  web: (WebsiteHost & { url: string }) | null;
}

function targets(mint: string): Targets {
  const s = market.summaryIfCached(mint);
  if (!s) return { hasFacts: false, tg: null, web: null };
  const links = tokenLinks('solana', mint, s.launchpad ?? null, s.socials ?? null);
  const tg = links.find((l) => l.kind === 'telegram')?.url ?? null;
  const web = links.find((l) => l.kind === 'website') ?? null;
  const host = web ? websiteHostOf(web.url) : null;
  return { hasFacts: true, tg, web: web && host ? { ...host, url: web.url } : null };
}

function snapshot(mint: string, t: Targets): LinkIntel {
  let telegram: TelegramLookup | null = null;
  if (t.tg) {
    const url = telegramPreviewUrl(t.tg);
    if (!url) telegram = { url: t.tg, state: 'failed', preview: null, readAt: null, reason: 'not a t.me link' };
    else {
      const e = tgCache.get(url);
      telegram = e
        ? { url, state: e.value ? 'ok' : 'failed', preview: e.value, readAt: e.readAt, reason: e.reason }
        : { url, state: inflight.has(`tg:${url}`) ? 'pending' : 'none', preview: null, readAt: null, reason: null };
    }
  }
  let website: DomainLookup | null = null;
  if (t.web) {
    const w = t.web;
    const base = { url: w.url, host: w.host, domain: w.domain, hostedOn: w.hostedOn };
    if (w.hostedOn) website = { ...base, state: 'ok', record: null, readAt: null, reason: null };
    else if (!w.domain) website = { ...base, state: 'failed', record: null, readAt: null, reason: 'no domain to look up' };
    else {
      const e = domainCache.get(w.domain);
      website = e
        ? { ...base, state: e.value ? 'ok' : 'failed', record: e.value, readAt: e.readAt, reason: e.reason }
        : { ...base, state: inflight.has(`rdap:${w.domain}`) ? 'pending' : 'none', record: null, readAt: null, reason: null };
    }
  }
  return { mint, hasFacts: t.hasFacts, telegram, website };
}

/** What is known now, from the caches. Never fetches. */
export function cached(mint: string): LinkIntel {
  return snapshot(mint, targets(mint));
}

/** Start the lookups for a token (a script asked); answers land in the cache. */
export function trigger(mint: string): void {
  const t = targets(mint);
  if (t.tg) void lookupTelegram(t.tg).catch(() => undefined);
  if (t.web?.domain && !t.web.hostedOn) void lookupDomain(t.web.domain).catch(() => undefined);
}

/**
 * The lookups for a token. `wait` (a person is looking) awaits the answers
 * and fetches the token's facts first when main has none; otherwise the
 * lookups are started and the current state returned.
 */
export async function intel(mint: string, wait: boolean): Promise<LinkIntel> {
  let t = targets(mint);
  if (!t.hasFacts && wait) {
    try {
      await market.summary(mint);
    } catch {
      /* the snapshot says hasFacts: false */
    }
    t = targets(mint);
  }
  if (!wait) {
    trigger(mint);
    return snapshot(mint, t);
  }
  const jobs: Promise<unknown>[] = [];
  if (t.tg) jobs.push(lookupTelegram(t.tg).catch(() => null));
  if (t.web?.domain && !t.web.hostedOn) jobs.push(lookupDomain(t.web.domain).catch(() => null));
  await Promise.all(jobs);
  return snapshot(mint, t);
}

/** The cached answers in the shape the scripts and rule variables take. Null when there is nothing. */
export function facts(mint: string): LinkIntelFacts | null {
  const snap = cached(mint);
  const tg = snap.telegram?.preview ?? null;
  const telegram = tg && snap.telegram?.readAt ? { kind: tg.kind, members: tg.members, countWord: tg.countWord, online: tg.online, title: tg.title, readAt: snap.telegram.readAt } : null;
  const w = snap.website;
  const domain = w
    ? {
        name: w.domain,
        registeredAt: w.record?.registeredAt ?? null,
        registrar: w.record?.registrar ?? null,
        hostedOn: w.hostedOn,
        readAt: w.readAt ?? Date.now(),
      }
    : null;
  if (!telegram && !domain) return null;
  return { telegram, domain };
}
