// A token's own links — where they point, and whether the app may show one
// inside itself.
//
// Two surfaces read this (2026-09-20): the token page header, which lists
// the links and opens them in the system browser, and the Links panel on My
// Layout, which embeds the page in a sandboxed browser view and swaps it
// when another link is clicked. Both must agree on what a token's links ARE,
// so the derivation lives here, pure and pinned by test/tokenlinks.test.mjs.
//
// Only https. A link is whatever a token's creator published, so this is
// the one place the app takes a URL from data it did not write and puts it
// on screen; `isEmbeddableUrl` is the rule the main process enforces when a
// browser view is attached, and the same rule is applied here first.

import type { Launchpad, TokenSocials } from './market';

export type TokenLinkKind = 'x' | 'website' | 'telegram' | 'launchpad';

export interface TokenLink {
  kind: TokenLinkKind;
  /** Short button text: "X", "Website", "Telegram", "pump.fun". */
  label: string;
  url: string;
  /** The host, for the URL line under an embedded page. */
  host: string;
}

/** The launchpads whose token pages the app links to, per chain. */
export const LAUNCHPAD_SITES = {
  /** Certain: the $KRYPTO card links the same way (shared/canary.ts). */
  pumpfun: (mint: string): string => `https://pump.fun/coin/${mint}`,
  /**
   * four.meme's token page. The path answered 403 (bot wall), not 404, to a
   * plain fetch on 2026-09-20, so it could not be confirmed from here; it is
   * the pattern the site's own listings use. One constant to fix if wrong.
   */
  fourmeme: (address: string): string => `https://four.meme/token/${address}`,
  /**
   * Pons on Robinhood Chain: the launchpad's token browser. Its token-page
   * path is UNVERIFIED — www.ponslaunchpad.com did not resolve from the dev
   * machine on 2026-09-20 — so this opens the launchpad, not the token.
   */
  pons: (_address: string): string => 'https://www.ponslaunchpad.com/launchpad.html',
} as const;

/** The launchpad page for a token, or null when the app knows no page. */
export function launchpadSite(chain: string, launchpad: Launchpad | null | undefined, mint: string): { label: string; url: string } | null {
  if (!mint) return null;
  if (chain === 'solana' && launchpad === 'pumpfun') return { label: 'pump.fun', url: LAUNCHPAD_SITES.pumpfun(mint) };
  if (chain === 'bnb' && launchpad === 'fourmeme') return { label: 'four.meme', url: LAUNCHPAD_SITES.fourmeme(mint) };
  if (chain === 'robinhood' && launchpad === 'pons') return { label: 'Pons', url: LAUNCHPAD_SITES.pons(mint) };
  return null;
}

/**
 * May this URL be shown inside the app's browser view? https only, a real
 * host, no credentials in the URL, nothing local. The same rule runs in the
 * main process when the view is attached (webSecurity.ts), so a renderer
 * that skipped this check would still be refused.
 */
export function isEmbeddableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2_048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com']);
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.org']);

/**
 * The links for a token, in display order: X, website, Telegram, launchpad.
 * A social whose URL fails `isEmbeddableUrl` is dropped — an http:// or a
 * bare handle is not a page the app can open safely. A "twitter" field that
 * does not point at X is shown as a website, labelled by its host, rather
 * than as X: the label must say where a click goes.
 */
export function tokenLinks(chain: string, mint: string, launchpad: Launchpad | null | undefined, socials: Pick<TokenSocials, 'twitter' | 'website' | 'telegram'> | null | undefined): TokenLink[] {
  const out: TokenLink[] = [];
  const seen = new Set<string>();
  const push = (kind: TokenLinkKind, label: string, url: string): void => {
    if (!isEmbeddableUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ kind, label, url, host: hostOf(url) });
  };
  const tw = socials?.twitter ?? null;
  if (tw && isEmbeddableUrl(tw)) {
    const h = hostOf(tw);
    if (X_HOSTS.has(h)) push('x', 'X', tw);
    else push('website', h || 'Link', tw);
  }
  const web = socials?.website ?? null;
  if (web && isEmbeddableUrl(web)) {
    const h = hostOf(web);
    if (X_HOSTS.has(h)) push('x', 'X', web);
    else if (TELEGRAM_HOSTS.has(h)) push('telegram', 'Telegram', web);
    else push('website', 'Website', web);
  }
  const tg = socials?.telegram ?? null;
  if (tg && isEmbeddableUrl(tg)) push('telegram', 'Telegram', tg);
  const lp = launchpadSite(chain, launchpad, mint);
  if (lp) push('launchpad', lp.label, lp.url);
  return out;
}
