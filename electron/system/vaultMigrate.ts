// Turning the app password on and off: moving every key between encryptions.
//
// THIS IS THE STEP THAT CAN LOSE KEYS, so the shape is built around that:
//   - Nothing is touched until every key has decrypted to its own address.
//   - The whole move runs in one synchronous tick, so no signer sees half a state
//     and nobody has to disarm.
//   - Every store's old bytes are durable beside it before it changes.
//   - Each store proves it read back before the next one starts.
//   - Each sealed value carries its own format, so even a half-moved file reads.
//   - A failure puts the files back. A crash does the same at the next start
//     (vault.init), driven by the state written in vault.json.
//
// test/vaultmigrate.test.mjs crashes this at every single write.

import * as evmWallet from '../evm/evmWallet';
import * as aioWallet from './aioWallet';
import { logger } from './logger';
import * as securityState from './securityState';
import * as vault from './vault';
import * as wallet from './wallet';

/** Why the keys cannot be moved right now, or null. */
export function preflight(): string | null {
  const stores: Array<string | null> = [wallet.failure(), evmWallet.failure(), aioWallet.failure()];
  const broken = stores.filter((s): s is string => !!s);
  if (broken.length) return `A wallet file could not be read, so nothing was changed. ${broken.join(' ')}`;
  const unusable = [...wallet.unusableKeys(), ...evmWallet.unusableKeys()];
  const phrase = aioWallet.phraseProblem();
  if (phrase) unusable.push(`All-in-One wallet: ${phrase}`);
  if (unusable.length) return `Nothing was changed, because these keys cannot be opened: ${unusable.join('; ')}`;
  return null;
}

function reloadStores(): void {
  wallet.reloadFromDisk();
  evmWallet.reloadFromDisk();
  aioWallet.reloadFromDisk();
}

function resealStores(resealExtra: () => void): void {
  wallet.resealAll();
  evmWallet.resealAll();
  aioWallet.resealAll();
  resealExtra();
}

export interface MigrateResult {
  ok: boolean;
  message: string;
  /** Something after the commit that a person should know about. */
  warnings?: string[];
}

/**
 * Turn the password on. `prepared` was built, and both of its keys trial-opened,
 * before this is called, and the user has typed the recovery code back.
 *
 * `resealExtra` re-encrypts stores that are not worth bundling here (the pump
 * sessions). It is passed in so this module stays testable on its own.
 */
export function enable(prepared: vault.PreparedVault, resealExtra: () => void = () => undefined): MigrateResult {
  const problem = preflight();
  if (problem) return { ok: false, message: problem };
  try {
    vault.beginEnable(prepared);
    vault.writePreVaultCopies();
    resealStores(resealExtra);
    securityState.initForNewVault();
    vault.commitEnable(); // the commit point
  } catch (err) {
    logger.error(`vault: turning the password on failed, putting the files back (${(err as Error).message})`);
    try {
      securityState.removeFiles();
      vault.abortEnable();
    } finally {
      reloadStores();
    }
    return { ok: false, message: `The password was not set and your keys are as they were: ${(err as Error).message}` };
  }
  const warnings: string[] = [];
  try {
    vault.removePreVaultCopies();
  } catch (err) {
    warnings.push(`A temporary copy could not be removed (${(err as Error).message}). It is removed at the next start.`);
  }
  const legacy = wallet.absorbLegacyFile();
  if (legacy) warnings.push(legacy);
  logger.warn('vault: app password is on');
  return { ok: true, message: 'Your keys are now encrypted with your password.', warnings };
}

/** Turn the password off. The caller has already had it re-entered. */
export function disable(resealExtra: () => void = () => undefined): MigrateResult {
  const problem = preflight();
  if (problem) return { ok: false, message: problem };
  if (!vault.osKeyStoreAvailable()) return { ok: false, message: 'This system has no OS key store to move the keys back to, so the password stays on.' };
  // A key found only in an old file has nowhere to live without the vault. It
  // joins the wallet list, because the one thing this must never do is lose it.
  try {
    for (const o of vault.orphans()) {
      const seed = vault.openOrphan(o);
      try {
        const r = wallet.ensureFromSeed(new Uint8Array(seed), 'Recovered wallet');
        if (!r.ok) return { ok: false, message: `The password stays on, because a key from an old file could not join your wallet list: ${r.message}` };
      } finally {
        seed.fill(0);
      }
    }
  } catch (err) {
    return { ok: false, message: `The password stays on: ${(err as Error).message}` };
  }
  try {
    vault.beginDisable();
    vault.writePreVaultCopies();
    resealStores(resealExtra);
    vault.commitDisable(); // the commit point
  } catch (err) {
    logger.error(`vault: turning the password off failed, putting the files back (${(err as Error).message})`);
    try {
      vault.abortDisable();
    } finally {
      reloadStores();
    }
    return { ok: false, message: `The password stays on and your keys are as they were: ${(err as Error).message}` };
  }
  const warnings: string[] = [];
  try {
    securityState.removeFiles();
    vault.removePreVaultCopies();
  } catch (err) {
    warnings.push(`A temporary copy could not be removed (${(err as Error).message}). It is removed at the next start.`);
  }
  logger.warn('vault: app password is off');
  return { ok: true, message: 'The password is off. Your keys are protected by your Windows account only.', warnings };
}
