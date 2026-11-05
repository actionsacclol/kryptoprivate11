// The encrypted key backup: every key, in one file, under a password of its own.
//
// Independent of the vault and of the OS key store on purpose. It is what gets
// someone back in after a reinstall, a new PC, or a Windows reset, so it must
// open anywhere. No addresses in the clear: the file says nothing about what it
// holds to whoever finds it.
//
// Pure apart from reading the wallets, so round trips and tampering are tested.

import { base58Encode } from '../chain/base58';
import { ed25519 } from '@noble/curves/ed25519';
import * as evmWallet from '../evm/evmWallet';
import * as aioWallet from './aioWallet';
import * as vault from './vault';
import * as wallet from './wallet';
import { aesOpen, aesSeal, deriveKey, kdfParamsOk, newKdfParams, PASSWORD_KDF_N, type KdfParams } from './vaultCrypto';

export const BACKUP_EXTENSION = 'kryptkeys';

interface BackupHeader {
  format: 'krypto-keys';
  version: 1;
  createdAt: string;
  app: string;
  kdf: KdfParams;
}

export interface BackupPayload {
  solana: Array<{ label: string; publicKey: string; secret: string; homeAddress: string | null; maxBalanceSol: number }>;
  evm: Array<{ label: string; address: string; privateKey: string; createdFor: string | null }>;
  aio: { label: string; phrase: string; paths?: { solana: string; evm: string } } | null;
}

/** Every key this profile holds, in plaintext, for the file below. */
export function collectPayload(): BackupPayload {
  const solana = wallet.keysForBackup().map((w) => {
    const keypair = new Uint8Array(64);
    keypair.set(w.secret, 0);
    keypair.set(ed25519.getPublicKey(w.secret), 32);
    const secret = base58Encode(keypair);
    keypair.fill(0);
    w.secret.fill(0);
    return { label: w.label, publicKey: w.publicKey, secret, homeAddress: w.homeAddress, maxBalanceSol: w.maxBalanceSol };
  });
  // A key found only in an old file belongs in the backup too.
  for (const o of vault.orphans()) {
    const seed = vault.openOrphan(o);
    const keypair = new Uint8Array(64);
    keypair.set(seed, 0);
    keypair.set(ed25519.getPublicKey(seed), 32);
    solana.push({ label: `Recovered (${o.from})`, publicKey: o.publicKey, secret: base58Encode(keypair), homeAddress: null, maxBalanceSol: 2 });
    keypair.fill(0);
    seed.fill(0);
  }
  return { solana, evm: evmWallet.keysForBackup(), aio: aioWallet.phraseForBackup() };
}

export async function encryptBackup(payload: BackupPayload, password: string, appVersion: string): Promise<string> {
  const header: BackupHeader = { format: 'krypto-keys', version: 1, createdAt: new Date().toISOString(), app: appVersion, kdf: newKdfParams(PASSWORD_KDF_N) };
  const key = await deriveKey(password, header.kdf);
  try {
    const sealed = aesSeal(key, Buffer.from(JSON.stringify(payload), 'utf8'), JSON.stringify(header));
    return JSON.stringify({ ...header, ct: sealed.toString('base64') }, null, 2);
  } finally {
    key.fill(0);
  }
}

export type DecryptResult = { ok: true; payload: BackupPayload } | { ok: false; reason: 'not-a-backup' | 'wrong-password'; message: string };

export async function decryptBackup(text: string, password: string): Promise<DecryptResult> {
  let parsed: BackupHeader & { ct?: unknown };
  try {
    parsed = JSON.parse(text) as BackupHeader & { ct?: unknown };
  } catch {
    return { ok: false, reason: 'not-a-backup', message: 'That is not a Krypto Bot key backup.' };
  }
  if (parsed?.format !== 'krypto-keys' || parsed.version !== 1 || typeof parsed.ct !== 'string') {
    return { ok: false, reason: 'not-a-backup', message: 'That is not a Krypto Bot key backup, or it was made by a newer version.' };
  }
  // A file from outside decides how much memory scrypt asks for, so its
  // parameters are checked before any of them are used.
  if (!kdfParamsOk(parsed.kdf, 'file')) return { ok: false, reason: 'not-a-backup', message: 'This backup asks for settings that are not allowed, so it was not opened.' };
  const { ct, ...headerFields } = parsed;
  const header: BackupHeader = { format: headerFields.format, version: headerFields.version, createdAt: headerFields.createdAt, app: headerFields.app, kdf: headerFields.kdf };
  const key = await deriveKey(password, parsed.kdf);
  try {
    const plain = aesOpen(key, Buffer.from(ct as string, 'base64'), JSON.stringify(header));
    const payload = JSON.parse(plain.toString('utf8')) as BackupPayload;
    plain.fill(0);
    if (!Array.isArray(payload.solana) || !Array.isArray(payload.evm)) return { ok: false, reason: 'not-a-backup', message: 'This backup opened but its contents are not valid.' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'wrong-password', message: 'Wrong password, or the file has been changed.' };
  } finally {
    key.fill(0);
  }
}

/** Addresses for the import confirmation. */
export function addressesIn(p: BackupPayload): string[] {
  return [...p.solana.map((w) => `Solana: ${w.publicKey}`), ...p.evm.map((w) => `EVM: ${w.address}`), ...(p.aio ? [`All-in-One wallet: ${p.aio.label}`] : [])];
}

/** Add what is in the backup. Never overwrites, and a chain that has a signer
 *  keeps it. A full list is reported, not silently dropped. Withdrawal addresses
 *  are NOT restored: a file should not be able to set where money goes. */
export function importPayload(p: BackupPayload): { added: number; alreadyHeld: number; failed: string[] } {
  let added = 0;
  let alreadyHeld = 0;
  const failed: string[] = [];
  const heldSol = new Set(wallet.list().map((w) => w.publicKey));
  for (const w of p.solana) {
    if (heldSol.has(w.publicKey)) {
      alreadyHeld += 1;
      continue;
    }
    const r = wallet.importSecret(w.secret, w.label);
    if (r.ok) added += 1;
    else failed.push(`Solana ${w.publicKey}: ${r.message}`);
  }
  const heldEvm = new Set(evmWallet.list('robinhood').map((w) => w.address.toLowerCase()));
  for (const w of p.evm) {
    if (heldEvm.has(w.address.toLowerCase())) {
      alreadyHeld += 1;
      continue;
    }
    // No chain named: naming one can move that chain's signer, and a restore must
    // not change who signs. It lands on both chains' lists.
    const r = evmWallet.importSecret(w.privateKey, w.label, undefined, false);
    if (r.ok) added += 1;
    else failed.push(`EVM ${w.address}: ${r.message}`);
  }
  if (p.aio) {
    if (aioWallet.info().exists) failed.push('All-in-One wallet: this profile already has one, so the one in the backup was not added. Its words are still in the backup.');
    else {
      const r = aioWallet.importPhrase(p.aio.phrase, p.aio.label, p.aio.paths);
      if (r.ok) added += 1;
      else failed.push(`All-in-One wallet: ${r.message}`);
    }
  }
  return { added, alreadyHeld, failed };
}

/** Whether a chosen path syncs to someone else's computer, which is worth saying
 *  even for an encrypted file. */
export function cloudSyncedPath(p: string): string | null {
  const m = /[\\/](OneDrive|Dropbox|Google Drive|GoogleDrive|iCloud Drive|iCloudDrive|Box Sync)[^\\/]*[\\/]/i.exec(p);
  return m ? m[1] : null;
}
