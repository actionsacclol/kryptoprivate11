// The SSRF boundary for token images, as pure functions.
//
// Split out of `images.ts` so it imports nothing from Electron: these are the
// checks that decide whether a creator-controlled string becomes an outbound
// request, they are the part most worth testing, and a test should not have
// to boot Electron to run them. See `images.ts` for the handler that uses
// them and for why the whole mechanism exists.

import { isIP } from 'node:net';

export const IMAGE_SCHEME = 'krypt-img';

/**
 * Decode `krypt-img://i/<base64url>` back to the https URL it names.
 *
 * Returns null for anything that is not plainly an https URL — that single
 * check is what stops `file:///`, `data:`, `http://` and assorted garbage
 * from ever reaching the fetch below it.
 */
export function decodeTarget(reqUrl: string): string | null {
  try {
    const u = new URL(reqUrl);
    const encoded = u.pathname.replace(/^\/+/, '');
    if (!encoded) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const target = Buffer.from(b64, 'base64').toString('utf8');
    return target.startsWith('https://') ? target : null;
  } catch {
    return null;
  }
}

/**
 * True for any address we refuse to contact: loopback, link-local (which
 * includes the 169.254.169.254 cloud-metadata endpoint), the RFC1918 ranges
 * and CGNAT. Checked against the address we resolved OURSELVES, which is
 * what closes the DNS-rebinding path — a hostname that looks public but
 * resolves to 127.0.0.1 is caught here rather than at the socket.
 */
export function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split('.').map(Number);
    if (p[0] === 0) return true;                              // this-host
    if (p[0] === 10) return true;                             // RFC1918
    if (p[0] === 127) return true;                            // loopback
    if (p[0] === 169 && p[1] === 254) return true;            // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // RFC1918
    if (p[0] === 192 && p[1] === 168) return true;            // RFC1918
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;                             // multicast + reserved
    return false;
  }
  if (v === 6) {
    const a = addr.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  // Not an IP at all — the caller resolves hostnames before asking.
  return false;
}

/** Content types we will render. SVG is excluded deliberately: it is an
 *  executable document, not a picture, and it would be sourced from a
 *  stranger's server. */
export function isRenderableImageType(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return type.startsWith('image/') && type !== 'image/svg+xml';
}
