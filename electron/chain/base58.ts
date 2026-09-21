// Minimal base58 (Bitcoin alphabet) — enough to render Solana pubkeys and
// signatures without pulling in a whole web3 SDK. Pure JS, no deps.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP: Record<string, number> = {};
const ALPHABET_CODES = new Uint8Array(58);
for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET[i]] = i;
  ALPHABET_CODES[i] = ALPHABET.charCodeAt(i);
}

// Reused scratch buffers — base58Encode is on the hot path (called for the
// `user` of every trade event, ~30k/min). A 32-byte pubkey needs ≤44 base58
// digits; 64-byte signatures ≤88. Sizing generously and reusing avoids per-
// call allocation + array growth. Single-threaded, so reuse is safe.
const DIGITS = new Uint8Array(128);
const OUT_CODES = new Uint8Array(128);

export function base58Encode(buf: Uint8Array): string {
  if (buf.length === 0) return '';
  let digitsLen = 1;
  DIGITS[0] = 0;
  for (let b = 0; b < buf.length; b++) {
    let carry = buf[b];
    for (let j = 0; j < digitsLen; j++) {
      const x = DIGITS[j] * 256 + carry;
      DIGITS[j] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) {
      DIGITS[digitsLen++] = carry % 58;
      carry = (carry / 58) | 0;
    }
  }
  let n = 0;
  for (let b = 0; b < buf.length; b++) {
    if (buf[b] === 0) OUT_CODES[n++] = ALPHABET_CODES[0];
    else break;
  }
  // An all-zero input is ONLY its leading-zero ones: the value part is empty.
  // Without this the seed digit `0` was emitted too, so the system program
  // (32 zero bytes) came out as THIRTY-THREE ones — never equal to the
  // '111…1' constant it was compared with, and a 33-byte seed when derived
  // from again (found 2026-09-20 parsing a v1 transaction's static keys).
  const allZero = digitsLen === 1 && DIGITS[0] === 0;
  if (!allZero) for (let i = digitsLen - 1; i >= 0; i--) OUT_CODES[n++] = ALPHABET_CODES[DIGITS[i]];
  return String.fromCharCode(...OUT_CODES.subarray(0, n));
}

export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  // Start empty, not [0]: a leading [0] slot is spurious for values with
  // leading zero bytes (addresses beginning with '1'), yielding a byte too
  // many. The leading-'1' loop below restores the real leading zeros.
  const bytes: number[] = [];
  for (const ch of str) {
    const val = ALPHABET_MAP[ch];
    if (val === undefined) throw new Error(`base58: invalid character "${ch}"`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === ALPHABET[0]) bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}
