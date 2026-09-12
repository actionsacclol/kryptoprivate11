// Dedicated hot-wallet manager. The trading wallet is generated IN-APP so
// the user's real wallet keys never touch Krypto Bot (guidelines §13:
// separate trading hot wallet, max balance, encrypted OS credential
// storage, no seed in config, no key in logs).
//
// Storage model:
//  - The 32-byte ed25519 secret is encrypted with Electron safeStorage,
//    which uses the OS keystore (Windows DPAPI, macOS Keychain), tied to
//    the user account. The ciphertext lives in userData/wallets.json.
//  - SEVERAL wallets may be held; exactly ONE is active and it is the only
//    one that can sign. Everything downstream (engine, liveSigner, sweep)
//    calls the same `publicKey()` / `signVersionedTransaction()` it always
//    did and is unaware there is a list — which is the point: switching
//    wallets must not become a new way for the signer to misbehave.
//  - The bookkeeping rules live in walletStore.ts, with no key material, so
//    they can be tested offline.
//  - A v1 `wallet.json` is migrated on first read. The old file is LEFT IN
//    PLACE: it holds a copy of a key, and deleting it as a side effect of an
//    upgrade is not a risk worth taking.
//  - The PUBLIC key is stored/returned in the clear (it's public).
//  - The secret is decrypted ONLY transiently, inside this module, and is
//    never sent to the renderer, written to a log, or put in a config value.
//
// Signing IS implemented here (LIVE_EXECUTION_AVAILABLE is true). Every
// signature goes through signVersionedTransaction(), which decodes the
// transaction and re-validates where the SOL goes before the key is decrypted
// — see checkOutflow() for the policy and why it exists.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { base58Encode, base58Decode } from '../engine/base58';
import { logger } from './logger';
import { getBalance } from '../engine/rpcClient';
import { checkOutflow, type SignPolicy } from './signPolicy';
import {
  activeWallet,
  addWallet,
  cleanLabel,
  emptyFile,
  nextLabel,
  parseFile,
  patchActive,
  removeWallet as removeFromStore,
  renameWallet as renameInStore,
  selectWallet,
  createGroup as createGroupInStore,
  renameGroup as renameGroupInStore,
  deleteGroup as deleteGroupInStore,
  setGroupMembers as setGroupMembersInStore,
  groupWallets,
  DEFAULT_MAX_BALANCE_SOL,
  type StoredWallet,
  type WalletsFile,
  type WalletGroup,
  setGroupLab as setGroupLabInStore,
} from './walletStore';
import type { WalletInfo, WalletSummary } from '@shared/types';

export type { SignIntent, SignPolicy } from './signPolicy';

const LAMPORTS_PER_SOL = 1_000_000_000;

let cache: WalletsFile | null = null;
/** Balances are per WALLET — a cached figure from the previous wallet shown
 *  against the new one is the kind of small lie that gets someone to send
 *  funds to the wrong place. Keyed by public key, cleared on switch. */
let balances = new Map<string, { lamports: number; at: number }>();

function file(): string {
  return path.join(app.getPath('userData'), 'wallets.json');
}

function legacyFile(): string {
  return path.join(app.getPath('userData'), 'wallet.json');
}

function newId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Set when wallets.json exists but could not be read or parsed. The file
 * holds the only copy of every encrypted key, so this state must never be
 * confused with "this install has no wallets": treating it as empty would
 * let the next persist() overwrite the keys with an empty file. While it is
 * set, the store reports no wallets AND refuses to write.
 */
let loadFailure: string | null = null;

/** Why the store is read-only right now, or null when it is healthy.
 *  Loads the file if that has not happened yet, so an early caller cannot
 *  read a stale "healthy". */
export function failure(): string | null {
  loadFile();
  return loadFailure;
}

function readWalletsFile(p: string): { ok: true; file: WalletsFile | null } | { ok: false; why: string } {
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    // Absent is a normal first run. Anything else — a locked file, a bad
    // disk, no permission — is a failure to READ, not an empty wallet set.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file: null };
    return { ok: false, why: `${p} could not be read (${(e as Error).message})` };
  }
  try {
    const parsed = parseFile(JSON.parse(text), Date.now(), newId);
    if (!parsed) return { ok: false, why: `${p} is not a wallet file this version understands` };
    return { ok: true, file: parsed };
  } catch (e) {
    return { ok: false, why: `${p} is corrupt (${(e as Error).message})` };
  }
}

function loadFile(): WalletsFile {
  if (cache) return cache;
  const current = readWalletsFile(file());
  if (!current.ok) {
    // Keep the bytes. A later version, or the user with a text editor, can
    // still recover keys from them; an overwrite could not be undone.
    loadFailure = `${current.why}. Your keys are still in that file — the app will not write to it until this is resolved.`;
    logger.error(`wallet store: ${loadFailure}`);
    cache = emptyFile();
    return cache;
  }
  if (current.file) {
    loadFailure = null;
    cache = current.file;
    return cache;
  }
  // No wallets.json. A pre-multi-wallet install may still have the old
  // single-wallet file to migrate across.
  const legacy = readWalletsFile(legacyFile());
  if (!legacy.ok) {
    loadFailure = `${legacy.why}. The app will not write over it.`;
    logger.error(`wallet store: ${loadFailure}`);
    cache = emptyFile();
    return cache;
  }
  if (legacy.file) {
    loadFailure = null;
    cache = legacy.file;
    persist(cache);
    return cache;
  }
  loadFailure = null;
  cache = emptyFile();
  return cache;
}

/** The wallet that signs. Everything in this module works on this one. */
function load(): StoredWallet | null {
  return activeWallet(loadFile());
}

function persist(f: WalletsFile): void {
  // Never write over a file we failed to read: that is how keys are lost.
  if (loadFailure) throw new Error(`refusing to write wallets.json — ${loadFailure}`);
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  cache = f;
}

/** A refusal every mutating entry point returns while the file is unreadable. */
function blockedByFailure(): { ok: false; message: string } | null {
  loadFile();
  return loadFailure ? { ok: false, message: `Wallet file unavailable — ${loadFailure}` } : null;
}

/** Apply a store transition and write it out. */
function commit(result: { file: WalletsFile; ok: boolean; message: string }): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (result.ok) persist(result.file);
  return { ok: result.ok, message: result.message };
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

/** Decrypt the secret transiently. Callers must not persist or log it. */
function decryptSecret(w: StoredWallet): Uint8Array {
  const buf = Buffer.from(w.secretEnc, 'base64');
  const hex = safeStorage.decryptString(buf);
  return fromHex(hex);
}

function encryptSecret(secret: Uint8Array): string {
  return safeStorage.encryptString(toHex(secret)).toString('base64');
}

export function exists(): boolean {
  return load() !== null;
}

export function info(): WalletInfo {
  const w = load();
  const bal = w ? balances.get(w.publicKey) : undefined;
  return {
    exists: w !== null,
    publicKey: w?.publicKey ?? null,
    homeAddress: w?.homeAddress ?? null,
    balanceSol: bal ? bal.lamports / LAMPORTS_PER_SOL : null,
    balanceCheckedAt: bal?.at ?? null,
    maxBalanceSol: w?.maxBalanceSol ?? DEFAULT_MAX_BALANCE_SOL,
    encryptionAvailable: encAvailable(),
    createdAt: w?.createdAt ?? null,
    id: w?.id ?? null,
    label: w?.label ?? null,
    walletCount: loadFile().wallets.length,
  };
}

/** Every wallet held, for the switcher. Public data only — no ciphertext. */
export function list(): WalletSummary[] {
  const f = loadFile();
  return f.wallets.map((w) => {
    const bal = balances.get(w.publicKey);
    return {
      id: w.id,
      label: w.label,
      publicKey: w.publicKey,
      active: w.id === f.activeId,
      balanceSol: bal ? bal.lamports / LAMPORTS_PER_SOL : null,
      balanceCheckedAt: bal?.at ?? null,
      maxBalanceSol: w.maxBalanceSol,
      homeAddress: w.homeAddress,
      createdAt: w.createdAt,
    };
  });
}

/**
 * Generate a fresh trading wallet and ADD it to the list.
 *
 * It does not become active unless it is the first — switching the signer is
 * always an explicit act, never a side effect of creating a key.
 */
export function generate(label = ''): { ok: boolean; message: string; publicKey?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (!encAvailable()) {
    return { ok: false, message: 'OS secure storage is unavailable — refusing to store a key unencrypted.' };
  }
  const f = loadFile();
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const publicKey = base58Encode(pub);
  const res = addWallet(f, {
    id: newId(),
    label: label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f),
    publicKey,
    secretEnc: encryptSecret(secret),
    homeAddress: null,
    maxBalanceSol: DEFAULT_MAX_BALANCE_SOL,
    createdAt: Date.now(),
  });
  // Best-effort scrub of the plaintext secret from this frame.
  secret.fill(0);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: 'Trading wallet generated', publicKey };
}

/** Import an existing 32-byte seed or 64-byte keypair (advanced). */
export function importSecret(input: string, label = ''): { ok: boolean; message: string; publicKey?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (!encAvailable()) return { ok: false, message: 'OS secure storage is unavailable.' };
  let secret: Uint8Array;
  try {
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed) as number[];
      secret = new Uint8Array(arr).slice(0, 32); // seed portion of a 64-byte keypair
    } else {
      const bytes = base58Decode(trimmed);
      secret = bytes.length >= 64 ? bytes.slice(0, 32) : bytes;
    }
    if (secret.length !== 32) return { ok: false, message: 'Key must be a 32-byte seed or 64-byte keypair.' };
  } catch {
    return { ok: false, message: 'Could not parse key (expect base58 or a JSON byte array).' };
  }
  const publicKey = base58Encode(ed25519.getPublicKey(secret));
  const f = loadFile();
  const res = addWallet(f, {
    id: newId(),
    label: label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f),
    publicKey,
    secretEnc: encryptSecret(secret),
    homeAddress: null,
    maxBalanceSol: DEFAULT_MAX_BALANCE_SOL,
    createdAt: Date.now(),
  });
  secret.fill(0);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: 'Wallet imported', publicKey };
}

/** Make a held wallet the signer. */
export function select(id: string): { ok: boolean; message: string } {
  return commit(selectWallet(loadFile(), id));
}

// ─── Groups (fan-out). Public data only — never any key material. ─────

export interface GroupView {
  id: string;
  name: string;
  /** Member wallets, resolved to public data for the UI. */
  members: Array<{ id: string; label: string; publicKey: string }>;
  lab?: import('@shared/lab').LabGroupConfig;
}

export function groups(): GroupView[] {
  const file = loadFile();
  return (file.groups ?? []).map((g: WalletGroup) => ({
    id: g.id,
    name: g.name,
    members: groupWallets(file, g.id).map((w) => ({ id: w.id, label: w.label, publicKey: w.publicKey })),
    lab: g.lab,
  }));
}

export function setGroupLab(id: string, lab: import('@shared/lab').LabGroupConfig): { ok: boolean; message: string } {
  return commit(setGroupLabInStore(loadFile(), id, lab));
}

/** Several wallets in one go (Wallet Lab). Stops at the first refusal. */
export function generateMany(count: number, labelPrefix: string): { ok: boolean; message: string; created: number; ids: string[] } {
  const blocked = blockedByFailure();
  if (blocked) return { ...blocked, created: 0, ids: [] };
  const n = Math.max(1, Math.min(20, Math.floor(count)));
  const ids: string[] = [];
  const before = new Set(loadFile().wallets.map((w) => w.id));
  for (let i = 0; i < n; i++) {
    const label = labelPrefix.trim() ? `${labelPrefix.trim()} ${i + 1}` : '';
    const r = generate(label);
    if (!r.ok) break;
  }
  for (const w of loadFile().wallets) if (!before.has(w.id)) ids.push(w.id);
  const created = ids.length;
  if (created < n) return { ok: created > 0, message: `${created} of ${n} created`, created, ids };
  return { ok: true, message: `${created} wallet(s) created`, created, ids };
}

export function createGroup(name: string): { ok: boolean; message: string } {
  return commit(createGroupInStore(loadFile(), name, `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`));
}

export function renameGroup(id: string, name: string): { ok: boolean; message: string } {
  return commit(renameGroupInStore(loadFile(), id, name));
}

export function deleteGroup(id: string): { ok: boolean; message: string } {
  return commit(deleteGroupInStore(loadFile(), id));
}

export function setGroupMembers(id: string, walletIds: string[]): { ok: boolean; message: string } {
  return commit(setGroupMembersInStore(loadFile(), id, walletIds));
}

export function rename(id: string, label: string): { ok: boolean; message: string } {
  return commit(renameInStore(loadFile(), id, label));
}

export function setHomeAddress(addr: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  const trimmed = addr.trim();
  try {
    if (base58Decode(trimmed).length !== 32) throw new Error('bad length');
  } catch {
    return { ok: false, message: 'Not a valid Solana address' };
  }
  const res = patchActive(loadFile(), { homeAddress: trimmed });
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: 'Withdrawal address saved' };
}

export function setMaxBalance(sol: number): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  if (!(sol > 0) || sol > 100) return { ok: false, message: 'Cap must be between 0 and 100 SOL' };
  const res = patchActive(loadFile(), { maxBalanceSol: sol });
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: 'Balance cap updated' };
}

/**
 * Record a balance the ENGINE already read from chain. `info()` answers from
 * this cache, and until 2026-09-02 only the Wallet page's own poll filled it
 * — so a token page opened first saw `balanceSol: null` and the trade panel
 * called a funded wallet "no SOL". The engine reads the balance at arm and
 * on its timers; those reads now land here too.
 */
export function noteBalance(publicKey: string, lamports: number): void {
  if (!publicKey || !Number.isFinite(lamports) || lamports < 0) return;
  balances.set(publicKey, { lamports, at: Date.now() });
}

export async function refreshBalance(httpUrl: string): Promise<{ ok: boolean; message: string; balanceSol?: number }> {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  const r = await getBalance(httpUrl, w.publicKey);
  if (!r.ok || r.data === undefined) return { ok: false, message: r.message };
  balances.set(w.publicKey, { lamports: r.data, at: Date.now() });
  return { ok: true, message: 'ok', balanceSol: r.data / LAMPORTS_PER_SOL };
}

/** Write a Solana-compatible keypair JSON (64-byte array) to a path the user
 *  chose, so they can recover the wallet in any Solana wallet. This is the
 *  ONLY path the secret leaves the app, straight to a file the user picked —
 *  never through the renderer or a log. */
/**
 * Export every wallet to a plain text file, as base58 private keys.
 *
 * base58 of the 64-byte secret key is the format Phantom, Solflare and Backpack
 * accept under "Import Private Key" — so this is the "get my keys out and into
 * a normal wallet" path, as opposed to backupToFile's Solana-CLI JSON array.
 *
 * This writes SECRET KEYS IN PLAINTEXT by design — that is the whole point of an
 * export — so the file leads with a warning and the caller confirms first.
 */
export function exportAllToFile(destPath: string): { ok: boolean; message: string; count: number } {
  const file = loadFile();
  if (!file.wallets.length) return { ok: false, message: 'No wallets to export', count: 0 };
  const lines: string[] = [
    'Krypto Bot — wallet export',
    '',
    '!!! PRIVATE KEYS IN PLAINTEXT !!!',
    'Anyone with this file can spend these wallets. Keep it offline, never share',
    'it, and delete it once you have imported the keys. Krypt cannot recover a',
    'key that leaks.',
    '',
    'To import into Phantom / Solflare / Backpack: Add wallet -> Import Private',
    'Key -> paste the "Private key" line below.',
    '',
    '='.repeat(64),
    '',
  ];
  let count = 0;
  const secrets: Uint8Array[] = [];
  try {
    for (const w of file.wallets) {
      const secret = decryptSecret(w);
      secrets.push(secret);
      const pub = base58Decode(w.publicKey);
      const keypair = new Uint8Array(64);
      keypair.set(secret, 0);
      keypair.set(pub, 32);
      lines.push(`[${w.label}]`);
      lines.push(`Public key:  ${w.publicKey}`);
      lines.push(`Private key: ${base58Encode(keypair)}`);
      lines.push('');
      keypair.fill(0);
      count += 1;
    }
    fs.writeFileSync(destPath, lines.join('\n'), 'utf8');
    return { ok: true, message: `Exported ${count} wallet(s) to ${destPath}`, count };
  } catch (err) {
    return { ok: false, message: `Export failed: ${(err as Error).message}`, count: 0 };
  } finally {
    for (const s of secrets) s.fill(0);
  }
}

export function backupToFile(destPath: string): { ok: boolean; message: string } {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  try {
    const secret = decryptSecret(w);
    const pub = base58Decode(w.publicKey);
    const keypair = new Uint8Array(64);
    keypair.set(secret, 0);
    keypair.set(pub, 32);
    fs.writeFileSync(destPath, JSON.stringify(Array.from(keypair)), 'utf8');
    secret.fill(0);
    keypair.fill(0);
    return { ok: true, message: `Backed up to ${destPath}` };
  } catch (err) {
    return { ok: false, message: `Backup failed: ${(err as Error).message}` };
  }
}

/**
 * Sign a serialized (unsigned) VersionedTransaction and return the signed
 * bytes. This is the ONLY place the secret is used to sign. It decrypts
 * transiently, signs, scrubs, and returns only the signed transaction —
 * the key never leaves this function or reaches the renderer.
 *
 * The policy is enforced here, independently of whatever the caller already
 * checked: this function is the last gate before a signature exists.
 */
/** Sign with the ACTIVE wallet — the single-trade path, unchanged. */
export function signVersionedTransaction(
  unsignedTx: Uint8Array,
  policy: SignPolicy,
): { ok: boolean; message: string; signed?: Uint8Array } {
  const w = load();
  if (!w) return { ok: false, message: 'No wallet' };
  return signWith(w, unsignedTx, policy);
}

/**
 * Sign with a SPECIFIC wallet by id — the fan-out path, where several wallets
 * each buy the same token. Every wallet still goes through the exact same
 * outflow validation and fee-payer check as the active-wallet path; a fan-out
 * gets no shortcut around the signer's safety.
 */
export function signVersionedTransactionForWallet(
  walletId: string,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
): { ok: boolean; message: string; signed?: Uint8Array } {
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'No such wallet' };
  return signWith(w, unsignedTx, policy);
}

/**
 * Sign a LAUNCH: this wallet plus the new mint, and nothing else.
 *
 * Separate from the trade paths so the two-signer exception has exactly one
 * door, and that door needs the mint secret to open. A caller that does not
 * hold a freshly generated mint keypair cannot produce a two-signer signature
 * through this module at all.
 */
export function signLaunchForWallet(
  walletId: string,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
  launchMintSecret: Uint8Array,
): { ok: boolean; message: string; signed?: Uint8Array } {
  if (policy.intent !== 'launch') return { ok: false, message: 'signLaunchForWallet requires the launch intent' };
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'No such wallet' };
  return signWith(w, unsignedTx, policy, launchMintSecret);
}

/** Public key of a specific wallet by id, for building that wallet's tx. */
export function publicKeyOf(walletId: string): string | null {
  return loadFile().wallets.find((x) => x.id === walletId)?.publicKey ?? null;
}

function signWith(
  w: StoredWallet,
  unsignedTx: Uint8Array,
  policy: SignPolicy,
  /**
   * The launch mint's secret, supplied ONLY by signLaunchForWallet.
   *
   * It is a parameter rather than a field on SignPolicy on purpose: a policy
   * is a description that gets logged, compared and passed around, and a
   * secret has no business in one. It lives for the microseconds between
   * generation and signature and is zeroed in the finally below.
   */
  launchMintSecret?: Uint8Array,
): { ok: boolean; message: string; signed?: Uint8Array } {
  let secret: Uint8Array | null = null;
  let kp: Keypair | null = null;
  try {
    const tx = VersionedTransaction.deserialize(unsignedTx);
    // The tx must require exactly our signature as fee payer.
    const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
    if (feePayer !== w.publicKey) {
      return { ok: false, message: 'Transaction fee payer is not this wallet — refusing to sign' };
    }
    // A launch is the one shape with a second signer, and it can only arrive
    // through signLaunchForWallet — which is the only caller that can supply
    // the mint secret. Without it, intent 'launch' is unreachable here and the
    // original rule applies untouched.
    const launching = policy.intent === 'launch' && launchMintSecret !== undefined;
    if (policy.intent === 'launch' && !launching) {
      return { ok: false, message: 'A launch must be signed through the launch path — refusing to sign' };
    }
    if (!launching && tx.message.header.numRequiredSignatures !== 1) {
      return { ok: false, message: `Transaction needs ${tx.message.header.numRequiredSignatures} signers — refusing (expect 1)` };
    }
    // Decode-and-revalidate BEFORE the key is ever decrypted.
    const outflow = checkOutflow(tx, w.publicKey, w.homeAddress, policy);
    if (!outflow.ok) return { ok: false, message: outflow.message };

    secret = decryptSecret(w);
    kp = Keypair.fromSeed(secret);
    // Sanity: the derived signer must match the stored public key.
    if (kp.publicKey.toBase58() !== w.publicKey) {
      return { ok: false, message: 'Key mismatch — refusing to sign' };
    }
    if (launching) {
      // Both signatures, in one call: ours as fee payer, the mint's for
      // itself. checkOutflow has already proved slot 1 IS this mint.
      const mintKp = Keypair.fromSecretKey(launchMintSecret);
      if (mintKp.publicKey.toBase58() !== policy.launchMint) {
        return { ok: false, message: 'Launch mint key does not match the mint the policy named — refusing to sign' };
      }
      tx.sign([kp, mintKp]);
    } else {
      tx.sign([kp]);
    }
    return { ok: true, message: 'signed', signed: tx.serialize() };
  } catch (err) {
    return { ok: false, message: `Signing failed: ${(err as Error).message}` };
  } finally {
    if (secret) secret.fill(0);
    // Keypair holds the secret internally; drop the reference for GC.
    kp = null;
  }
}


/** The trading wallet's public key, or null. */
export function publicKey(): string | null {
  return load()?.publicKey ?? null;
}

/**
 * Delete one wallet (after the user has backed it up).
 *
 * With no id, the ACTIVE wallet goes — which is what the single-wallet
 * button always did. Removing the active one promotes another rather than
 * leaving the app with a dangling signer (see walletStore.healActive).
 */
export function remove(id?: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const f = loadFile();
  const targetId = id ?? f.activeId;
  if (!targetId) return { ok: false, message: 'No wallet' };
  const target = f.wallets.find((w) => w.id === targetId);
  const res = removeFromStore(f, targetId);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  if (target) balances.delete(target.publicKey);
  if (!res.file.wallets.length) {
    // An EMPTY v2 file is written, never deleted.
    //
    // The legacy `wallet.json` is kept on purpose (it holds a copy of a key),
    // and `loadFile` falls back to it whenever the current file is missing or
    // unreadable. Deleting the current file on the last removal would
    // therefore RESURRECT the migrated wallet on the next start — the user
    // removes their wallet, restarts, and it is back. An empty file parses
    // fine, so the fallback never fires and the removal sticks.
    balances = new Map();
    persist(res.file);
  }
  return { ok: true, message: res.message };
}
