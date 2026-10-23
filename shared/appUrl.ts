// Which URLs a window carrying window.krypt may navigate to (2026-10-23).
//
// The guard used to be a prefix test — `startsWith('file://')` or
// `startsWith('http://localhost')` — which let in `http://localhost.evil.com/`,
// any HTML file on disk, and `file://server/share/x.html` (on Windows that is
// an SMB fetch that also leaks the user's NTLM hash). Each of those would load
// with the preload, so the page got the whole bridge: trades, settings, the
// MCP token. Pure, so it is tested without Electron.

export interface AppUrlRules {
  /** file:// URL of the app's own index.html (pathToFileURL of DIST/index.html). */
  indexUrl: string;
  /** The Vite dev server, unpackaged runs only. Matched by exact origin. */
  devUrl?: string;
}

/** True only for the app's own page: that one index.html (any hash or query),
 *  or the dev server's exact origin. */
export function isAppUrl(url: string, rules: AppUrlRules): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (rules.devUrl) {
    try {
      if (u.origin === new URL(rules.devUrl).origin) return true;
    } catch {
      /* a malformed dev URL allows nothing extra */
    }
  }
  if (u.protocol !== 'file:') return false;
  let want: URL;
  try {
    want = new URL(rules.indexUrl);
  } catch {
    return false;
  }
  if (want.protocol !== 'file:') return false;
  // A host is a network share, never the app's own file.
  if (u.host !== '' || want.host !== '') return false;
  // Windows paths are case-insensitive, and either side may be escaped.
  const norm = (p: string): string => {
    try {
      return decodeURIComponent(p).replace(/\\/g, '/').toLowerCase();
    } catch {
      return p.toLowerCase();
    }
  };
  return norm(u.pathname) === norm(want.pathname);
}
