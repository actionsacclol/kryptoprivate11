// The All-in-One wallet's record: the phrase (encrypted) and which two
// stored wallets it made. See shared/aio.ts for what it is and is not.
//
// ORDER OF WRITES, because this file holds the only copy of the phrase:
// the record (with the phrase) is written FIRST, then each key is added to
// its store, then the record is updated with the ids. A crash anywhere in
// between leaves a record whose keys are "missing" — `repair` rebuilds them
// from the phrase. The reverse order could leave keys whose phrase was never
// saved, and the phrase is the backup the user was promised.
//
// FAIL CLOSED like wallets.json: a file that exists but cannot be read makes
// this module read-only, never "no All-in-One wallet" — writing a fresh one
// over it would destroy a phrase.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import * as wallet from './wallet';
import * as evmWallet from '../evm/evmWallet';
import { logger } from './logger';
import { evmPrivateKeyAtPath, newSeedPhrase, normaliseSeedPhrase, seedPhraseProblem, solanaSeedAtPath } from './seedPhrase';
import {
  aioFileBody,
  aioInfoOf,
  cleanAioLabel,
  emptyAioInfo,
  parseAioFile,
  type AioRecord,
  type AioWalletInfo,
  aioEvmPath,
  aioSolanaPath,
} from '@shared/aio';

let cache: AioRecord | null | undefined;
let loadFailure: string | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'aio-wallet.json');
}

function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function load(): AioRecord | null {
  if (cache !== undefined) return cache;
  let text: string;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      loadFailure = null;
      cache = null;
      return cache;
    }
    loadFailure = `${file()} could not be read (${(e as Error).message}). Your recovery phrase is still in it — the app will not write to it until this is resolved.`;
    logger.error(`aio wallet: ${loadFailure}`);
    cache = null;
    return cache;
  }
  let parsed: ReturnType<typeof parseAioFile>;
  try {
    parsed = parseAioFile(JSON.parse(text));
  } catch {
    parsed = 'invalid';
  }
  if (parsed === 'invalid') {
    loadFailure = `${file()} is not an All-in-One record this version understands. It is left untouched — your recovery phrase may still be in it.`;
    logger.error(`aio wallet: ${loadFailure}`);
    cache = null;
    return cache;
  }
  loadFailure = null;
  cache = parsed;
  return cache;
}

function persist(rec: AioRecord | null): void {
  if (loadFailure) throw new Error(`refusing to write aio-wallet.json — ${loadFailure}`);
  const tmp = `${file()}.tmp`;
  // Owner-only, like the other key stores (evm-wallets.json).
  fs.writeFileSync(tmp, JSON.stringify(aioFileBody(rec), null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file());
  cache = rec;
}

function blocked(): { ok: false; message: string } | null {
  load();
  return loadFailure ? { ok: false, message: `All-in-One record unavailable — ${loadFailure}` } : null;
}

export function failure(): string | null {
  load();
  return loadFailure;
}

export function info(): AioWalletInfo {
  const rec = load();
  if (loadFailure) return emptyAioInfo(loadFailure);
  if (!rec) return emptyAioInfo();
  return aioInfoOf(rec, {
    solanaIds: wallet.list().map((w) => w.id),
    evmIds: evmWallet.list('robinhood').map((w) => w.id),
    activeSolanaId: wallet.info().id ?? null,
    activeEvmIds: { bnb: evmWallet.info('bnb').id ?? null, robinhood: evmWallet.info('robinhood').id ?? null },
  });
}

/** The two stored-wallet ids, for the caller that switches signers. */
export function walletIds(): { solana: string | null; evm: string | null } {
  const i = info();
  return { solana: i.solanaWalletId, evm: i.evmWalletId };
}

/** Add whichever of the two keys its store does not hold. Returns the ids,
 *  and which ones were already held (adopted, not created). */
function addKeys(
  phrase: string,
  label: string,
  paths?: { solana: string; evm: string },
): { ok: boolean; message: string; solanaId?: string; evmId?: string; adopted: { solana: boolean; evm: boolean } } {
  const seed = solanaSeedAtPath(phrase, aioSolanaPath(paths?.solana));
  const key = evmPrivateKeyAtPath(phrase, aioEvmPath(paths?.evm));
  try {
    const sol = wallet.ensureFromSeed(seed, label);
    if (!sol.ok || !sol.id) return { ok: false, message: `Solana key not added — ${sol.message}`, adopted: { solana: false, evm: false } };
    const evm = evmWallet.ensureFromPrivateKey(key, label);
    if (!evm.ok || !evm.id) return { ok: false, message: `EVM key not added — ${evm.message}`, solanaId: sol.id, adopted: { solana: sol.existed === true, evm: false } };
    return { ok: true, message: 'ok', solanaId: sol.id, evmId: evm.id, adopted: { solana: sol.existed === true, evm: evm.existed === true } };
  } finally {
    seed.fill(0);
    key.fill(0);
  }
}

/**
 * Set the wallet up from a phrase: a fresh one (`create`) or the user's own
 * (`importPhrase`). One All-in-One wallet per install.
 */
function setUp(phrase: string, labelIn: unknown, fresh: boolean, paths?: { solana: string; evm: string }): { ok: boolean; message: string } {
  const b = blocked();
  if (b) return b;
  if (!encAvailable()) return { ok: false, message: 'OS secure storage is unavailable — refusing to store a recovery phrase unencrypted.' };
  if (load()) return { ok: false, message: 'There is already an All-in-One wallet. Remove it first to set up a different one.' };
  const problem = seedPhraseProblem(phrase);
  if (problem) return { ok: false, message: problem };
  const clean = normaliseSeedPhrase(phrase);
  const label = cleanAioLabel(labelIn);

  // Addresses first — public, and what the record is checked against.
  const seed = solanaSeedAtPath(clean, aioSolanaPath(paths?.solana));
  const key = evmPrivateKeyAtPath(clean, aioEvmPath(paths?.evm));
  const solanaAddress = Keypair.fromSeed(seed).publicKey.toBase58();
  const evmAddress = privateKeyToAccount(`0x${Buffer.from(key).toString('hex')}`).address;
  seed.fill(0);
  key.fill(0);

  const rec: AioRecord = {
    version: 1,
    label,
    solanaAddress,
    evmAddress,
    solanaWalletId: null,
    evmWalletId: null,
    phraseEnc: safeStorage.encryptString(clean).toString('base64'),
    createdAt: Date.now(),
    // An imported phrase is one the user already holds somewhere.
    backedUpAt: fresh ? null : Date.now(),
    ...(paths ? { paths } : {}),
  };
  try {
    persist(rec); // the phrase is safe on disk before any key moves
  } catch (err) {
    return { ok: false, message: `Not saved: ${(err as Error).message}` };
  }
  const added = addKeys(clean, label, paths);
  const next: AioRecord = { ...rec, solanaWalletId: added.solanaId ?? null, evmWalletId: added.evmId ?? null, adopted: added.adopted };
  try {
    persist(next);
  } catch (err) {
    return { ok: false, message: `Keys added but the record was not updated: ${(err as Error).message}` };
  }
  logger.warn(`aio wallet: ${fresh ? 'created' : 'imported'} — Solana ${solanaAddress}, EVM ${evmAddress}`);
  if (!added.ok) return { ok: false, message: `${added.message}. The recovery phrase is saved — use Repair once that is fixed.` };
  return { ok: true, message: fresh ? 'All-in-One wallet created' : 'All-in-One wallet imported' };
}

/** A fresh phrase. Returned ONCE, for the backup screen; never logged. */
export function create(label?: unknown): { ok: boolean; message: string; phrase?: string } {
  const phrase = newSeedPhrase();
  const r = setUp(phrase, label, true);
  return r.ok ? { ...r, phrase } : r;
}

export function importPhrase(phrase: unknown, label?: unknown, paths?: { solana: string; evm: string }): { ok: boolean; message: string } {
  if (typeof phrase !== 'string') return { ok: false, message: 'Enter the recovery phrase.' };
  return setUp(phrase, label, false, paths);
}

/** The phrase, decrypted for the backup screen. The caller has asked the
 *  user to confirm; this never logs it. */
export function reveal(): { ok: boolean; message: string; phrase?: string } {
  const b = blocked();
  if (b) return b;
  const rec = load();
  if (!rec) return { ok: false, message: 'No All-in-One wallet.' };
  try {
    return { ok: true, message: 'ok', phrase: safeStorage.decryptString(Buffer.from(rec.phraseEnc, 'base64')) };
  } catch (err) {
    return { ok: false, message: `The recovery phrase could not be decrypted on this machine (${(err as Error).message}).` };
  }
}

export function markBackedUp(): { ok: boolean; message: string } {
  const b = blocked();
  if (b) return b;
  const rec = load();
  if (!rec) return { ok: false, message: 'No All-in-One wallet.' };
  try {
    persist({ ...rec, backedUpAt: Date.now() });
  } catch (err) {
    return { ok: false, message: `Not saved: ${(err as Error).message}` };
  }
  return { ok: true, message: 'Backup confirmed' };
}

/** Which of the two keys were already held before the phrase was set up. */
export function adoptedKeys(): { solana: boolean; evm: boolean } {
  return load()?.adopted ?? { solana: false, evm: false };
}

/** Put back a key that was removed from its store, from the phrase. */
export function repair(): { ok: boolean; message: string } {
  const r = reveal();
  if (!r.ok || !r.phrase) return { ok: false, message: r.message };
  const rec = load()!;
  const added = addKeys(r.phrase, rec.label, rec.paths);
  try {
    // Which keys were adopted is a fact about setup, kept as it was.
    persist({ ...rec, solanaWalletId: added.solanaId ?? rec.solanaWalletId, evmWalletId: added.evmId ?? rec.evmWalletId });
  } catch (err) {
    return { ok: false, message: `Keys added but the record was not updated: ${(err as Error).message}` };
  }
  return added.ok ? { ok: true, message: 'Both keys are in place' } : { ok: false, message: added.message };
}

/** Forget the record and its phrase. The CALLER removes the two keys from
 *  their stores first (it holds the arm interlocks those removals need). */
export function forget(): { ok: boolean; message: string } {
  const b = blocked();
  if (b) return b;
  if (!load()) return { ok: false, message: 'No All-in-One wallet.' };
  persist(null);
  logger.warn('aio wallet: removed');
  return { ok: true, message: 'All-in-One wallet removed' };
}
