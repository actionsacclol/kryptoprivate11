// The app password's key store (security swarm, 2026-11-04).
//
// Why it exists: every key was encrypted with the operating system's key store
// and nothing else, and DPAPI has no idea which program is asking. Any program
// running as the Windows user could open every key, app open or closed.
//
// With a password set, one random data key (DEK) encrypts every secret and
// lives only in this process's memory while unlocked. It is stored twice:
//   - under the password (scrypt), then sealed again with the OS key store, so
//     a copied vault.json cannot be attacked offline without the Windows
//     account as well;
//   - under the recovery code alone, so losing the Windows profile is
//     survivable. That wrap deliberately skips the OS layer.
//
// With no password nothing changes: same files, same bytes, same OS encryption.
//
// HONEST LIMIT: this stops file theft, including while the app is closed. It
// cannot stop malware that logs the password or reads memory while unlocked.
//
// Each sealed value carries its own format (`kv1:`), so a read never has to
// know which mode the file was written in. Writes follow `writesKv1()`.

import { app, safeStorage } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { durableWrite, overwriteAndRemove, readBackup, scrubLeftovers } from './durableWrite';
import { logger } from './logger';
import {
  aad,
  aesOpen,
  aesSeal,
  deriveKey,
  isKv1,
  kdfParamsOk,
  kv1Decode,
  kv1Encode,
  newKdfParams,
  newRecoveryCode,
  normaliseCode,
  PASSWORD_KDF_FLOOR_N,
  PASSWORD_KDF_N,
  RECOVERY_KDF_N,
  type KdfParams,
} from './vaultCrypto';

export { isKv1 } from './vaultCrypto';

export interface VaultOrphan {
  publicKey: string;
  secretEnc: string;
  from: string;
}

export interface VaultFile {
  kind: 'krypto-vault';
  version: 1;
  /** `pending`: password being turned on. `active`: the normal state.
   *  `disabling`: being turned off. Only `active` is ever a resting state. */
  state: 'pending' | 'active' | 'disabling';
  vaultId: string;
  createdAt: number;
  password: { kdf: KdfParams; dpapiSealed: string };
  recovery: { kdf: KdfParams; sealed: string };
  orphans: VaultOrphan[];
}

export type VaultStatus = 'none' | 'sealed' | 'open' | 'broken';

export type UnlockResult =
  | { ok: true }
  /** Named apart on purpose: telling someone their password is wrong when
   *  Windows lost the outer key would send them guessing forever. */
  | { ok: false; reason: 'wrong-password' | 'os-key-lost' | 'broken'; message: string };

/** Every file holding a secret. The migration handles these and only these. */
export const SECRET_FILES = ['wallets.json', 'evm-wallets.json', 'aio-wallet.json', 'pump-session.json'] as const;
export const PRE_VAULT_SUFFIX = '.pre-vault';
const ABSENT_MARKER = '{"kryptoPreVault":"absent"}';

let file_: VaultFile | null = null;
let dek: Buffer | null = null;
let brokenWhy: string | null = null;
let initialised = false;
/** During a migration the stores write in the mode being moved to. */
let writeModeOverride: boolean | null = null;

const userData = (): string => app.getPath('userData');
const vaultPath = (): string => path.join(userData(), 'vault.json');
const secretPath = (name: string): string => path.join(userData(), name);

function parseVault(text: string): VaultFile | null {
  try {
    const o = JSON.parse(text) as Partial<VaultFile>;
    if (o.kind !== 'krypto-vault' || o.version !== 1) return null;
    if (o.state !== 'pending' && o.state !== 'active' && o.state !== 'disabling') return null;
    if (typeof o.vaultId !== 'string' || !o.password || !o.recovery) return null;
    if (!kdfParamsOk(o.password.kdf, 'vault') || typeof o.password.dpapiSealed !== 'string') return null;
    if (!kdfParamsOk(o.recovery.kdf, 'vault') || typeof o.recovery.sealed !== 'string') return null;
    return { ...(o as VaultFile), orphans: Array.isArray(o.orphans) ? o.orphans : [] };
  } catch {
    return null;
  }
}

function writeVault(v: VaultFile): void {
  durableWrite(vaultPath(), JSON.stringify(v, null, 2));
  file_ = v;
}

/**
 * Put the files right after a crash, then load. Runs first at startup, before
 * anything reads a key store.
 *
 *   no vault                 → leftovers from a finished turn-off are removed
 *   pending                  → turn-on never finished: restore, drop the vault
 *   disabling                → turn-off never finished: restore, stay active
 *   active with leftovers    → turn-on committed: remove them
 *   vault.json unreadable    → its backup, or refuse. NEVER "no password"
 */
export function init(): void {
  if (initialised) return;
  initialised = true;
  scrubLeftovers(userData());
  let text: string | null = null;
  try {
    text = fs.readFileSync(vaultPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      brokenWhy = `${vaultPath()} could not be read (${(e as Error).message})`;
      logger.error(`vault: ${brokenWhy}`);
      return;
    }
  }
  if (text === null && readBackup(vaultPath()) === null) {
    try {
      removePreVaultCopies();
    } catch (err) {
      // Leftovers from a finished turn-off. Costs nothing to leave until next time.
      logger.warn(`vault: could not tidy up (${(err as Error).message})`);
    }
    return;
  }
  const parsed = (text !== null ? parseVault(text) : null) ?? parseVault(readBackup(vaultPath()) ?? '');
  if (!parsed) {
    brokenWhy = `${vaultPath()} is not readable, and neither is its backup. Your keys are still encrypted on disk; the app will not touch them.`;
    logger.error(`vault: ${brokenWhy}`);
    return;
  }
  file_ = parsed;
  try {
    if (parsed.state === 'pending') {
      logger.warn('vault: turning the password on did not finish; putting the files back as they were');
      restorePreVaultCopies();
      removeVaultFiles();
      return;
    }
    if (parsed.state === 'disabling') {
      logger.warn('vault: turning the password off did not finish; the password stays on');
      restorePreVaultCopies();
      writeVault({ ...parsed, state: 'active' });
      return;
    }
    removePreVaultCopies();
  } catch (err) {
    // The copies are still there, so the next start can try again.
    brokenWhy = `A password change did not finish and could not be put right (${(err as Error).message}). Your keys are untouched. Close anything using this folder and start the app again.`;
    logger.error(`vault: ${brokenWhy}`);
  }
}

export function status(): VaultStatus {
  init();
  if (brokenWhy) return 'broken';
  if (!file_) return 'none';
  return dek ? 'open' : 'sealed';
}

export const brokenReason = (): string | null => brokenWhy;

/** Password mode, open or sealed. */
export const isOn = (): boolean => {
  const s = status();
  return s === 'open' || s === 'sealed';
};

export const isSealed = (): boolean => status() === 'sealed';

/** New secrets go through `seal` rather than the OS key store. */
export function writesKv1(): boolean {
  if (writeModeOverride !== null) return writeModeOverride;
  return isOn();
}

/** Encrypt under the data key. Throws while sealed: nothing can be written
 *  under a key this process does not hold. */
export function seal(plain: Uint8Array, boundTo: string): string {
  if (!dek) throw new Error('Wallets are locked');
  return kv1Encode(aesSeal(dek, plain, boundTo));
}

/** Decrypt a `kv1:` value. Throws while sealed, so nothing can sign. */
export function open(blob: string, boundTo: string): Buffer {
  if (!dek) throw new Error('Wallets are locked');
  return aesOpen(dek, kv1Decode(blob), boundTo);
}

/** Whether the OS key store is available to hold the outer layer at all. */
export function osKeyStoreAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function wrapForPassword(key: Uint8Array, password: string, kdf: KdfParams): Promise<string> {
  const kek = await deriveKey(password, kdf);
  try {
    const wrapped = aesSeal(kek, key, aad.dekPassword);
    return safeStorage.encryptString(wrapped.toString('base64')).toString('base64');
  } finally {
    kek.fill(0);
  }
}

async function wrapForRecovery(key: Uint8Array, code: string, kdf: KdfParams): Promise<string> {
  const kek = await deriveKey(code, kdf);
  try {
    return aesSeal(kek, key, aad.dekRecovery).toString('base64');
  } finally {
    kek.fill(0);
  }
}

/** Measure at setup: a machine too small for the full work factor still gets
 *  one it can run, because an unlock that fails for memory is a locked wallet. */
async function passwordKdf(): Promise<KdfParams> {
  const full = newKdfParams(PASSWORD_KDF_N);
  const start = Date.now();
  try {
    (await deriveKey('probe', full)).fill(0);
    if (Date.now() - start <= 3_000) return full;
  } catch (err) {
    logger.warn(`vault: full key stretching unavailable (${(err as Error).message})`);
  }
  logger.warn('vault: using the lower key-stretching setting on this machine');
  return newKdfParams(PASSWORD_KDF_FLOOR_N);
}

async function unwrapWithPassword(v: VaultFile, password: string): Promise<UnlockResult & { key?: Buffer }> {
  let wrappedB64: string;
  try {
    wrappedB64 = safeStorage.decryptString(Buffer.from(v.password.dpapiSealed, 'base64'));
  } catch (err) {
    logger.error(`vault: the OS key store refused the vault (${(err as Error).message})`);
    return {
      ok: false,
      reason: 'os-key-lost',
      message: 'Windows can no longer open this vault. This happens after a Windows password reset or moving to a new PC, and it is not a wrong password. Use your recovery code.',
    };
  }
  const kek = await deriveKey(password, v.password.kdf);
  try {
    const key = aesOpen(kek, Buffer.from(wrappedB64, 'base64'), aad.dekPassword);
    return { ok: true, key };
  } catch {
    return { ok: false, reason: 'wrong-password', message: 'Wrong password.' };
  } finally {
    kek.fill(0);
  }
}

/** Open the vault for this run. */
export async function unlock(password: string): Promise<UnlockResult> {
  init();
  if (brokenWhy || !file_) return { ok: false, reason: 'broken', message: brokenWhy ?? 'There is no vault.' };
  const r = await unwrapWithPassword(file_, password);
  if (!r.ok) return r;
  if (r.key) dek = r.key;
  return { ok: true };
}

/** Re-enter the password while already open: does it match? Used by the idle
 *  lock and before sensitive actions. The data key in memory is untouched. */
export async function checkPassword(password: string): Promise<UnlockResult> {
  init();
  if (!file_) return { ok: false, reason: 'broken', message: 'There is no vault.' };
  const r = await unwrapWithPassword(file_, password);
  if (!r.ok) return r;
  const same = !!(r.key && dek && r.key.length === dek.length && timingSafeEqual(r.key, dek));
  r.key?.fill(0);
  return same ? { ok: true } : { ok: false, reason: 'wrong-password', message: 'Wrong password.' };
}

async function buildWraps(key: Uint8Array, password: string): Promise<{ password: VaultFile['password']; recovery: VaultFile['recovery']; code: string }> {
  const code = newRecoveryCode();
  const pwKdf = await passwordKdf();
  const recKdf = newKdfParams(RECOVERY_KDF_N);
  const dpapiSealed = await wrapForPassword(key, password, pwKdf);
  const sealed = await wrapForRecovery(key, normaliseCode(code, 25)!, recKdf);
  return { password: { kdf: pwKdf, dpapiSealed }, recovery: { kdf: recKdf, sealed }, code };
}

/**
 * Prove both wraps open from what is about to be written, before any key file
 * is touched. A vault the owner cannot open is worse than having no vault.
 */
async function trialOpen(v: Pick<VaultFile, 'password' | 'recovery'>, key: Uint8Array, password: string, code: string): Promise<void> {
  const viaPassword = await unwrapWithPassword(v as VaultFile, password);
  if (!viaPassword.ok || !viaPassword.key || !viaPassword.key.equals(Buffer.from(key))) throw new Error('the password wrap did not open');
  viaPassword.key.fill(0);
  const kek = await deriveKey(normaliseCode(code, 25)!, v.recovery.kdf);
  try {
    const opened = aesOpen(kek, Buffer.from(v.recovery.sealed, 'base64'), aad.dekRecovery);
    if (!opened.equals(Buffer.from(key))) throw new Error('the recovery wrap did not open');
    opened.fill(0);
  } finally {
    kek.fill(0);
  }
}

/** The new password's vault, ready for a migration to commit. */
export interface PreparedVault {
  vault: VaultFile;
  key: Buffer;
  recoveryCode: string;
}

export async function prepare(password: string): Promise<PreparedVault> {
  const key = randomBytes(32);
  const wraps = await buildWraps(key, password);
  await trialOpen(wraps, key, password, wraps.code);
  return {
    key,
    recoveryCode: wraps.code,
    vault: {
      kind: 'krypto-vault',
      version: 1,
      state: 'pending',
      vaultId: randomBytes(8).toString('hex'),
      createdAt: Date.now(),
      password: wraps.password,
      recovery: wraps.recovery,
      orphans: [],
    },
  };
}

/** The caller has already had the current password entered (requireProof). */
export async function changePassword(newPassword: string): Promise<void> {
  init();
  if (!file_ || !dek) throw new Error('Unlock first.');
  const pwKdf = await passwordKdf();
  const dpapiSealed = await wrapForPassword(dek, newPassword, pwKdf);
  writeVaultScrubbed({ ...file_, password: { kdf: pwKdf, dpapiSealed } });
}

/** An old wrap left in the backup would still open with the OLD password. */
function writeVaultScrubbed(v: VaultFile): void {
  durableWrite(vaultPath(), JSON.stringify(v, null, 2), { backup: 'scrub' });
  file_ = v;
}

/**
 * A replacement recovery code. Nothing changes until `commit`, which the caller
 * runs once the user has typed it back. Closing the window before that, or an
 * idle lock, leaves the old code working rather than a code nobody wrote down.
 */
export async function prepareNewRecovery(): Promise<{ code: string; commit: () => void }> {
  if (!file_ || !dek) throw new Error('Unlock first.');
  const code = newRecoveryCode();
  const kdf = newKdfParams(RECOVERY_KDF_N);
  const sealed = await wrapForRecovery(dek, normaliseCode(code, 25)!, kdf);
  return {
    code,
    commit: () => {
      if (!file_) throw new Error('The vault is gone.');
      writeVaultScrubbed({ ...file_, recovery: { kdf, sealed } });
    },
  };
}

/**
 * The forgotten-password door: the recovery code opens the data key and sets a
 * new password. The data key does not change, so no key file is rewritten. A new
 * recovery code is issued, because the old one has now been typed out. Nothing
 * is written until `commit`, so walking away leaves the old password and code
 * working.
 */
export async function prepareRecovery(codeInput: string, newPassword: string): Promise<UnlockResult & { recoveryCode?: string; commit?: () => void }> {
  init();
  if (brokenWhy || !file_) return { ok: false, reason: 'broken', message: brokenWhy ?? 'There is no vault.' };
  const code = normaliseCode(codeInput, 25);
  if (!code) return { ok: false, reason: 'wrong-password', message: 'A recovery code is 25 letters and numbers.' };
  const kek = await deriveKey(code, file_.recovery.kdf);
  let key: Buffer;
  try {
    key = aesOpen(kek, Buffer.from(file_.recovery.sealed, 'base64'), aad.dekRecovery);
  } catch {
    return { ok: false, reason: 'wrong-password', message: 'That recovery code does not open this vault.' };
  } finally {
    kek.fill(0);
  }
  const wraps = await buildWraps(key, newPassword);
  await trialOpen(wraps, key, newPassword, wraps.code);
  return {
    ok: true,
    recoveryCode: wraps.code,
    commit: () => {
      if (!file_) throw new Error('The vault is gone.');
      writeVaultScrubbed({ ...file_, password: wraps.password, recovery: wraps.recovery });
      dek = key;
    },
  };
}

/** A recovery code check that opens nothing and changes nothing, for setup's
 *  "type it back" step. */
export const sameRecoveryCode = (typed: string, shown: string): boolean => {
  const a = normaliseCode(typed, 25);
  const b = normaliseCode(shown, 25);
  return !!a && a === b;
};

// ── Migration plumbing (driven by vaultMigrate.ts) ─────────────────────

/** Turn-on, step 1: the vault is durable as `pending` before any store moves. */
export function beginEnable(p: PreparedVault): void {
  dek = p.key;
  writeModeOverride = true;
  writeVault(p.vault);
}

export function commitEnable(): void {
  if (!file_) throw new Error('no vault to commit');
  writeVaultScrubbed({ ...file_, state: 'active' });
  writeModeOverride = null;
}

export function abortEnable(): void {
  restorePreVaultCopies();
  removeVaultFiles();
  writeModeOverride = null;
}

export function beginDisable(): void {
  if (!file_ || !dek) throw new Error('Unlock first.');
  writeVault({ ...file_, state: 'disabling' });
  writeModeOverride = false;
}

export function abortDisable(): void {
  if (!file_) return;
  restorePreVaultCopies();
  writeVault({ ...file_, state: 'active' });
  writeModeOverride = null;
}

/** The commit point of turning off: the vault goes, and the data key with it. */
export function commitDisable(): void {
  removeVaultFiles();
  writeModeOverride = null;
}

export function writePreVaultCopies(): void {
  for (const name of SECRET_FILES) {
    const p = secretPath(name);
    let current: Buffer;
    try {
      current = fs.readFileSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      current = Buffer.from(ABSENT_MARKER, 'utf8');
    }
    durableWrite(`${p}${PRE_VAULT_SUFFIX}`, current, { backup: 'none' });
  }
}

function restorePreVaultCopies(): void {
  for (const name of SECRET_FILES) {
    const p = secretPath(name);
    const pre = `${p}${PRE_VAULT_SUFFIX}`;
    let copy: Buffer;
    try {
      copy = fs.readFileSync(pre);
    } catch {
      continue; // never got this far for this file: it was not touched
    }
    if (copy.toString('utf8') === ABSENT_MARKER) {
      // The backup too: it holds what the move wrote, and a missing file falls
      // back to its backup.
      overwriteAndRemove(`${p}.bak`);
      overwriteAndRemove(p);
    } else durableWrite(p, copy, { backup: 'scrub' });
    overwriteAndRemove(pre);
  }
}

export function removePreVaultCopies(): void {
  for (const name of SECRET_FILES) {
    overwriteAndRemove(`${secretPath(name)}${PRE_VAULT_SUFFIX}`);
    overwriteAndRemove(`${secretPath(name)}.tmp`);
  }
}

function removeVaultFiles(): void {
  // Backup first: vault.init reads a backup when the main file is missing, so a
  // crash between these two must not bring an old state back to life.
  overwriteAndRemove(`${vaultPath()}.bak`);
  overwriteAndRemove(`${vaultPath()}.tmp`);
  overwriteAndRemove(vaultPath());
  file_ = null;
  dek?.fill(0);
  dek = null;
}

// ── Keys found only in an old file ─────────────────────────────────────

export function addOrphan(publicKey: string, secret: Uint8Array, from: string): void {
  if (!file_) throw new Error('no vault');
  writeVault({
    ...file_,
    orphans: [...file_.orphans.filter((o) => o.publicKey !== publicKey), { publicKey, secretEnc: seal(secret, aad.orphan(publicKey)), from }],
  });
}

export function orphans(): VaultOrphan[] {
  return file_?.orphans ?? [];
}

export function openOrphan(o: VaultOrphan): Buffer {
  return open(o.secretEnc, aad.orphan(o.publicKey));
}

// ── Starting over without a password ───────────────────────────────────

/**
 * Nobody can open this vault. Set it aside and start empty. NOTHING IS DELETED:
 * if the password is remembered in a year, moving the folder back restores it.
 */
export function setAsideLockedVault(day: string): string {
  const dir = path.join(userData(), `locked-vault-${day}`);
  fs.mkdirSync(dir, { recursive: true });
  const names = ['vault.json', 'vault.json.bak', 'security.json', 'security.json.bak', ...SECRET_FILES, ...SECRET_FILES.map((n) => `${n}.bak`)];
  for (const name of names) {
    const from = secretPath(name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name));
  }
  file_ = null;
  dek = null;
  brokenWhy = null;
  logger.warn(`vault: a locked vault was set aside in ${dir}`);
  return dir;
}

/** For tests: forget everything in memory, as a new process would. */
export function __resetForTest(): void {
  file_ = null;
  dek?.fill(0);
  dek = null;
  brokenWhy = null;
  initialised = false;
  writeModeOverride = null;
}
