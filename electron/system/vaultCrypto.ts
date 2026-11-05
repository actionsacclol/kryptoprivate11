// The encryption behind the app password and the key backup file. Pure: no
// `electron` import, no disk, no state, so every rule is tested directly.
//
// scrypt + AES-256-GCM, from node:crypto, because that is the only strong pair
// Electron's build provides with no new dependency. Its BoringSSL has no
// Argon2 (`crypto.argon2Sync` exists and throws) and no chacha20-poly1305,
// measured under Electron 2026-11-04, and a plain-node test would not notice.

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64, 16 to 64 bytes. */
  salt: string;
}

/** About 256 MiB and a second on a normal PC. The password's work factor. */
export const PASSWORD_KDF_N = 2 ** 18;
/** What a machine too slow or too small for the above falls back to, at setup. */
export const PASSWORD_KDF_FLOOR_N = 2 ** 17;
/** A recovery code is 125 random bits and needs no stretching to speak of. */
export const RECOVERY_KDF_N = 2 ** 15;

const MAX_N_VAULT = 2 ** 20;
/** A backup file comes from outside: a hostile one must not exhaust memory. */
const MAX_N_FILE = 2 ** 19;

export const MIN_PASSWORD_LENGTH = 12;

const COMMON = new Set([
  'password1234', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiop123', 'passwordpassword',
  'iloveyou1234', 'adminadmin12', 'letmeinletmein', '111111111111', '000000000000', 'aaaaaaaaaaaa',
  'kryptokrypto', 'kryptobot123', 'solanasolana', 'bitcoinbitcoin',
]);

/** Why this password will not do, or null. Length over composition rules. */
export function passwordProblem(password: string): string | null {
  const clean = password.normalize('NFKC');
  if ([...clean].length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short sentence works well.`;
  if (COMMON.has(clean.toLowerCase())) return 'That password is too common. Pick something only you would use.';
  if (new Set(clean).size < 4) return 'That password repeats too few characters.';
  return null;
}

export function newKdfParams(N: number): KdfParams {
  return { alg: 'scrypt', N, r: 8, p: 1, salt: randomBytes(16).toString('base64') };
}

/** Whether these parameters are safe to run. Checked before any derivation,
 *  because N and r decide how much memory the process is about to ask for. */
export function kdfParamsOk(k: unknown, source: 'vault' | 'file'): k is KdfParams {
  if (!k || typeof k !== 'object') return false;
  const o = k as Record<string, unknown>;
  if (o.alg !== 'scrypt' || o.r !== 8 || o.p !== 1 || typeof o.N !== 'number' || typeof o.salt !== 'string') return false;
  const N = o.N;
  if (!Number.isInteger(N) || N < 2 ** 14 || N > (source === 'vault' ? MAX_N_VAULT : MAX_N_FILE)) return false;
  if ((N & (N - 1)) !== 0) return false;
  const salt = Buffer.from(o.salt, 'base64');
  return salt.length >= 16 && salt.length <= 64;
}

/** Always async, so a re-prompt never stalls the engine on the main thread. */
export function deriveKey(secret: string, k: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(k.salt, 'base64');
    // Node's default maxmem refuses these parameters.
    const maxmem = 128 * k.N * k.r + 32 * 1024 * 1024;
    scrypt(secret.normalize('NFKC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** nonce (12) || ciphertext || tag (16) */
export function aesSeal(key: Uint8Array, plain: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

/** Throws on a wrong key, a tampered byte, or AAD from another record. */
export function aesOpen(key: Uint8Array, blob: Uint8Array, aad: string): Buffer {
  if (blob.length < 12 + 16) throw new Error('ciphertext too short');
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

// ── Record format ──────────────────────────────────────────────────────

export const KV1_PREFIX = 'kv1:';

export const isKv1 = (blob: unknown): blob is string => typeof blob === 'string' && blob.startsWith(KV1_PREFIX);

export const kv1Encode = (b: Uint8Array): string => `${KV1_PREFIX}${Buffer.from(b).toString('base64')}`;

export const kv1Decode = (s: string): Buffer => Buffer.from(s.slice(KV1_PREFIX.length), 'base64');

/** What each sealed value is bound to, so a ciphertext cannot be swapped onto
 *  another wallet in the file and sign as it. */
export const aad = {
  solana: (publicKey: string): string => `wallet:sol:${publicKey}`,
  evm: (address: string): string => `wallet:evm:${address.toLowerCase()}`,
  aioPhrase: (solanaAddress: string): string => `aio:phrase:${solanaAddress}`,
  pumpToken: (address: string): string => `pump:token:${address}`,
  securityState: 'security:state',
  orphan: (publicKey: string): string => `orphan:sol:${publicKey}`,
  dekPassword: 'vault:dek:password',
  dekRecovery: 'vault:dek:recovery',
} as const;

// ── Recovery code ──────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters from a uniform 5 bits each: never `byte % 32` of a wider range. */
function randomBase32(chars: number): string {
  let out = '';
  for (const b of randomBytes(chars)) out += CROCKFORD[b & 31];
  return out;
}

/** 125 random bits, as five groups of five. Shown once. */
export function newRecoveryCode(): string {
  return randomBase32(25).match(/.{5}/g)!.join('-');
}

/** A single-use 2FA fallback: 50 bits, as two groups of five. */
export function newBackupCode(): string {
  return randomBase32(10).match(/.{5}/g)!.join('-');
}

/** Forgiving about what a person types, strict about what comes out. Crockford
 *  reads O as 0 and I or L as 1, and hyphens and case do not matter. */
export function normaliseCode(input: string, length: number): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (c.length !== length) return null;
  for (const ch of c) if (!CROCKFORD.includes(ch)) return null;
  return c;
}
