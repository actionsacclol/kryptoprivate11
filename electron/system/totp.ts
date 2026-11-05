// Authenticator codes (RFC 6238): six digits every 30 seconds, HMAC-SHA1,
// because that is what every authenticator app supports. Pure.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, '')) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('not base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_PERIOD_S);

/** The code for one time step. `digits` is here for the RFC's 8-digit vectors. */
export function hotp(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, '0');
}

/**
 * The step this code is valid for, or null. One step either side, so a clock a
 * little out still works. A step at or before `lastUsedStep` is refused: a code
 * someone watched being typed cannot be typed again.
 */
export function matchStep(secretB32: string, code: string, nowMs: number, lastUsedStep: number): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = stepAt(nowMs);
  let found: number | null = null;
  // Every candidate is checked even after a match, so timing says nothing.
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(expected, Buffer.from(clean, 'utf8')) && step > lastUsedStep && found === null) found = step;
  }
  secret.fill(0);
  return found;
}

export function otpauthUrl(secretB32: string, account: string): string {
  const issuer = 'Krypto Bot';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
}

/** Lockout after repeated wrong codes: 5 free tries, then 5 minutes, doubling
 *  to an hour. Returns how long to refuse for, in milliseconds. */
export function lockoutMs(failCount: number): number {
  if (failCount < 5) return 0;
  return Math.min(60, 5 * 2 ** (failCount - 5)) * 60_000;
}
