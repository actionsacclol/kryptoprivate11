// Robinhood Chain hot wallets — the module that owns the secret.
//
// Same storage model as system/wallet.ts (Solana): a 32-byte private key
// encrypted with Electron safeStorage (Windows DPAPI / macOS Keychain),
// ciphertext in userData/evm-wallets.json, several wallets held, exactly
// ONE active, only the active one signs. The key is decrypted transiently
// inside signTransaction(), after the policy has passed, and scrubbed.
//
// Kept apart from the Solana wallet on purpose: a different curve
// (secp256k1), a different address shape, a different file. Sharing the
// list would let one chain's "active" quietly become the other's signer.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address, type Hex } from 'viem';
import { logger } from '../system/logger';
import { client } from './client';
import { CHAINS } from './chains';
import { checkEvmTx, type EvmPolicy } from './policy';
import {
  activeWallet,
  addWallet,
  addWalletFor,
  assignWallet,
  cleanLabel,
  emptyFile,
  nextLabel,
  parseFile,
  removeWallet as removeFromStore,
  renameWallet as renameInStore,
  selectWallet,
  type EvmStoredWallet,
  type EvmWalletsFile,
} from './evmWalletStore';
import { EVM_CHAIN_META, ROBINHOOD_CHAIN_ID, weiToEth, type EvmChainKind, type EvmWalletInfo, type EvmWalletSummary } from '@shared/evm';

const FILE = 'evm-wallets.json';

let cache: EvmWalletsFile | null = null;
/** Balances are per CHAIN and per address: the same key holds ETH on
 *  Robinhood and BNB on BNB, and one figure must never stand in for the other. */
let balances = new Map<string, { wei: bigint; at: number }>();
const balKey = (chain: EvmChainKind, addr: string): string => `${chain}:${addr.toLowerCase()}`;
let loadFailure: string | null = null;

function file(): string {
  return path.join(app.getPath('userData'), FILE);
}

function newId(): string {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function encAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function failure(): string | null {
  loadFile();
  return loadFailure;
}

function loadFile(): EvmWalletsFile {
  if (cache) return cache;
  const p = file();
  let text: string | null = null;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${p} could not be read (${(e as Error).message})`;
      logger.error(`evm wallet: ${loadFailure}`);
      cache = emptyFile(ROBINHOOD_CHAIN_ID);
      return cache;
    }
  }
  if (text === null) {
    cache = emptyFile(ROBINHOOD_CHAIN_ID);
    return cache;
  }
  try {
    const parsed = parseFile(JSON.parse(text), ROBINHOOD_CHAIN_ID);
    if (!parsed) {
      loadFailure = `${p} is not a wallet file this version understands`;
      logger.error(`evm wallet: ${loadFailure}`);
      cache = emptyFile(ROBINHOOD_CHAIN_ID);
      return cache;
    }
    cache = parsed;
  } catch (e) {
    loadFailure = `${p} is corrupt (${(e as Error).message})`;
    logger.error(`evm wallet: ${loadFailure}`);
    cache = emptyFile(ROBINHOOD_CHAIN_ID);
  }
  return cache;
}

function persist(next: EvmWalletsFile): void {
  // A file we could not read is a file we must not overwrite: it holds the
  // only copy of every key. Every mutator checks blockedByFailure() first, so
  // reaching this is a programming error — throw, like the Solana store.
  if (loadFailure) {
    logger.warn(`evm wallet: not saving — ${loadFailure}`);
    throw new Error(`Wallet file is read-only this session: ${loadFailure}`);
  }
  const p = file();
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // `activeId` is written alongside `active` for one reason: yesterday's
  // build reads ONLY `activeId`, and a file without it makes that build heal
  // to the OLDEST wallet — silently changing who signs after a rollback. One
  // redundant key keeps a downgrade honest. Robinhood's choice is the one
  // mirrored, because that is the chain the single-signer build served.
  const onDisk = { ...next, activeId: next.active.robinhood };
  fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  // Only a wallet that is on disk may be listed (or become the active
  // signer). If the write above throws, memory stays as it was, so a key that
  // exists nowhere but RAM is never shown as something the user can fund.
  cache = next;
}

function blockedByFailure(): { ok: false; message: string } | null {
  loadFile();
  return loadFailure ? { ok: false, message: `Wallet file is read-only this session: ${loadFailure}` } : null;
}

/**
 * Who signs on this chain.
 *
 * The chain is a required argument, not a default, because the whole point of
 * the per-chain work is that there is no such thing as "the" active EVM
 * wallet any more. A caller that does not know which chain it is acting for
 * does not know enough to spend money.
 */
function load(chain: EvmChainKind): EvmStoredWallet | null {
  return activeWallet(loadFile(), chain);
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function decryptSecret(w: EvmStoredWallet): Hex {
  const buf = Buffer.from(w.secretEnc, 'base64');
  const hex = safeStorage.decryptString(buf);
  return `0x${hex.replace(/^0x/, '')}` as Hex;
}

function encryptSecret(pk: Hex): string {
  return safeStorage.encryptString(pk.replace(/^0x/, '')).toString('base64');
}

// ── Public reads ──────────────────────────────────────────────────────

/** Does this chain have a signer? True as soon as any wallet exists. */
export function exists(chain: EvmChainKind): boolean {
  return load(chain) !== null;
}

/** The address that signs on this chain. */
export function address(chain: EvmChainKind): Address | null {
  return (load(chain)?.address as Address | undefined) ?? null;
}

export function addressOf(walletId: string): Address | null {
  return (loadFile().wallets.find((w) => w.id === walletId)?.address as Address | undefined) ?? null;
}

export function info(chain: EvmChainKind): EvmWalletInfo {
  const w = load(chain);
  const bal = w ? balances.get(balKey(chain, w.address)) : undefined;
  return {
    chain,
    nativeSymbol: EVM_CHAIN_META[chain].nativeSymbol,
    exists: w !== null,
    address: w?.address ?? null,
    balanceNative: bal ? weiToEth(bal.wei) : null,
    balanceCheckedAt: bal?.at ?? null,
    encryptionAvailable: encAvailable(),
    createdAt: w?.createdAt ?? null,
    id: w?.id ?? null,
    label: w?.label ?? null,
    walletCount: loadFile().wallets.length,
    failure: loadFailure,
  };
}

export function list(chain: EvmChainKind): EvmWalletSummary[] {
  const f = loadFile();
  return f.wallets.map((w) => {
    const bal = balances.get(balKey(chain, w.address));
    return {
      id: w.id,
      label: w.label,
      address: w.address,
      // "Active" is per chain now: the same wallet can be the signer on one
      // chain and just another row on the other.
      active: w.id === (f.active ? f.active[chain] : null),
      balanceNative: bal ? weiToEth(bal.wei) : null,
      balanceCheckedAt: bal?.at ?? null,
      createdAt: w.createdAt,
      createdFor: w.createdFor ?? null,
    };
  });
}

/** The message a new wallet is announced with. `forChain` names what it was
 *  made for; `switched` says whether it signs there now. */
function madeMessage(label: string, forChain: EvmChainKind | undefined, switched: boolean): string {
  if (!forChain) return 'EVM wallet generated — export the key and store it somewhere safe';
  const where = EVM_CHAIN_META[forChain].name;
  return switched
    ? `${label} made for ${where} — it signs there now. Export the key and keep it safe.`
    : `${label} made for ${where}. Export the key and keep it safe.`;
}

export function balanceWei(chain: EvmChainKind, addr: Address): bigint | null {
  return balances.get(balKey(chain, addr))?.wei ?? null;
}

// ── Writes ────────────────────────────────────────────────────────────

/**
 * Make a wallet. With `forChain` it is made FOR that chain (the page that
 * asked) and signs there at once if the chain had no signer of its own — see
 * `addWalletFor`. `allowSwitch` is the caller's arm interlock.
 */
export function generate(label = '', forChain?: EvmChainKind, allowSwitch = true): { ok: boolean; message: string; address?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (!encAvailable()) return { ok: false, message: 'OS secure storage is unavailable — refusing to store a key unencrypted.' };
  const f = loadFile();
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const name = label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f, forChain);
  const record = { id: newId(), label: name, address: account.address, secretEnc: encryptSecret(pk), createdAt: Date.now() };
  const res = addRecord(f, record, forChain, allowSwitch);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return { ok: true, message: madeMessage(name, forChain, res.switched), address: account.address };
}

/** One shape for both ways of adding: with a home chain (and the possible
 *  switch), or the plain chain-free add. */
function addRecord(f: ReturnType<typeof loadFile>, record: Parameters<typeof addWallet>[1], forChain: EvmChainKind | undefined, allowSwitch: boolean) {
  if (forChain) return addWalletFor(f, record, forChain, allowSwitch);
  return { ...addWallet(f, record), switched: false };
}

/** Import a raw private key (0x-prefixed or bare 64 hex characters). */
export function importSecret(input: string, label = '', forChain?: EvmChainKind, allowSwitch = true): { ok: boolean; message: string; address?: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  if (!encAvailable()) return { ok: false, message: 'OS secure storage is unavailable.' };
  const trimmed = (input ?? '').trim();
  const bare = trimmed.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) return { ok: false, message: 'Expect a 32-byte private key as 64 hex characters (0x…).' };
  const pk = `0x${bare.toLowerCase()}` as Hex;
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(pk);
  } catch {
    return { ok: false, message: 'That is not a valid secp256k1 private key.' };
  }
  const f = loadFile();
  const name = label ? cleanLabel(label, f.wallets.length + 1) : nextLabel(f, forChain);
  const record = { id: newId(), label: name, address: account.address, secretEnc: encryptSecret(pk), createdAt: Date.now() };
  const res = addRecord(f, record, forChain, allowSwitch);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  return {
    ok: true,
    message: forChain ? `${name} imported for ${EVM_CHAIN_META[forChain].name}${res.switched ? ' — it signs there now' : ''}` : 'Wallet imported',
    address: account.address,
  };
}

/** Say which chain a wallet belongs to. See `assignWallet`. */
export function assign(chain: EvmChainKind, id: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const res = assignWallet(loadFile(), id, chain);
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: res.message };
}

export function select(chain: EvmChainKind, id: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const res = selectWallet(loadFile(), chain, id);
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: res.message };
}

export function rename(id: string, label: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const res = renameInStore(loadFile(), id, label);
  if (!res.ok) return res;
  persist(res.file);
  return { ok: true, message: res.message };
}

export function remove(id?: string): { ok: boolean; message: string } {
  const blocked = blockedByFailure();
  if (blocked) return blocked;
  const f = loadFile();
  // With no id, remove whichever wallet signs on Robinhood - the same wallet
  // the old single-signer behaviour would have removed. Callers that mean a
  // specific wallet name it, and the UI always does.
  const targetId = id ?? (f.active ? f.active.robinhood : null);
  if (!targetId) return { ok: false, message: 'No wallet' };
  const target = f.wallets.find((w) => w.id === targetId);
  const res = removeFromStore(f, targetId);
  if (!res.ok) return { ok: false, message: res.message };
  persist(res.file);
  if (target) for (const k of [...balances.keys()]) if (k.endsWith(`:${target.address.toLowerCase()}`)) balances.delete(k);
  if (!res.file.wallets.length) balances = new Map();
  return { ok: true, message: res.message };
}

/** Plaintext export of every key, for MetaMask / Rabby. The caller has
 *  shown the warning dialog; this just writes the file. */
export function exportAllToFile(destPath: string): { ok: boolean; message: string; count: number } {
  const f = loadFile();
  if (!f.wallets.length) return { ok: false, message: 'No wallets to export', count: 0 };
  try {
    const lines: string[] = [
      '# Krypto Bot — Robinhood Chain and BNB Smart Chain wallets (one key, same address on both)',
      '# PRIVATE KEYS, plaintext',
      '# Anyone with this file can spend these wallets. Delete it once imported.',
      '# Import into MetaMask / Rabby: Add account → Import private key.',
      `# Chains: Robinhood Chain (id ${ROBINHOOD_CHAIN_ID}) and BNB Smart Chain (id ${EVM_CHAIN_META.bnb.id}) — the same key works on both`,
      '',
    ];
    for (const w of f.wallets) {
      let pk: Hex | null = null;
      try {
        pk = decryptSecret(w);
        lines.push(`${w.label}\t${w.address}\t${pk}`);
      } finally {
        pk = null;
      }
    }
    fs.writeFileSync(destPath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    return { ok: true, message: `Exported ${f.wallets.length} wallet(s)`, count: f.wallets.length };
  } catch (err) {
    return { ok: false, message: `Export failed: ${(err as Error).message}`, count: 0 };
  }
}

// ── Balances ──────────────────────────────────────────────────────────

export function noteBalance(chain: EvmChainKind, addr: Address, wei: bigint): void {
  balances.set(balKey(chain, addr), { wei, at: Date.now() });
}

export async function refreshBalance(chain: EvmChainKind): Promise<{ ok: boolean; message: string }> {
  const w = load(chain);
  if (!w) return { ok: false, message: 'No wallet' };
  try {
    const wei = await client(chain).getBalance({ address: w.address as Address });
    noteBalance(chain, w.address as Address, wei);
    return { ok: true, message: 'ok' };
  } catch (e) {
    return { ok: false, message: `Balance read failed: ${(e as Error).message}` };
  }
}

export async function refreshAll(chain: EvmChainKind): Promise<void> {
  const f = loadFile();
  await Promise.all(
    f.wallets.map(async (w) => {
      try {
        noteBalance(chain, w.address as Address, await client(chain).getBalance({ address: w.address as Address }));
      } catch {
        /* one wallet's read failing must not blank the others */
      }
    }),
  );
}

// ── Signing ───────────────────────────────────────────────────────────

export interface UnsignedTx {
  /** The wallet the trade was planned, quoted and nonce'd for. An EVM raw
   *  transaction has no intrinsic sender, so the signer must be told which
   *  key the caller expects — and refuse any other. */
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
}

/**
 * Sign with the ACTIVE wallet. The policy is enforced here, independently of
 * whatever the caller already checked — this is the last gate before a
 * signature exists, and it runs BEFORE the key is decrypted.
 */
export async function signTransaction(chain: EvmChainKind, tx: UnsignedTx, policy: EvmPolicy): Promise<{ ok: boolean; message: string; signed?: Hex; from?: Address }> {
  const w = load(chain);
  if (!w) return { ok: false, message: `No wallet is set to sign on ${chain}` };
  return signWith(chain, w, tx, policy);
}

/**
 * Sign as a SPECIFIC wallet, by id — the launcher's path.
 *
 * A launch signs from a wallet of its own so that a mistake in the launch
 * code cannot reach the keys holding your positions, which means it cannot go
 * through `signTransaction` (that one signs as whatever is active). The gate
 * is otherwise identical: the same policy check, on the same bytes, before
 * the key is decrypted.
 */
export async function signTransactionForWallet(
  chain: EvmChainKind,
  walletId: string,
  tx: UnsignedTx,
  policy: EvmPolicy,
): Promise<{ ok: boolean; message: string; signed?: Hex; from?: Address }> {
  const w = loadFile().wallets.find((x) => x.id === walletId);
  if (!w) return { ok: false, message: 'That wallet no longer exists — refusing to sign' };
  return signWith(chain, w, tx, policy);
}

/** A specific wallet's address, for building that wallet's transaction. */
export function addressOfWallet(walletId: string): Address | null {
  const w = loadFile().wallets.find((x) => x.id === walletId);
  return w ? (getAddress(w.address) as Address) : null;
}

async function signWith(chain: EvmChainKind, w: EvmStoredWallet, tx: UnsignedTx, policy: EvmPolicy): Promise<{ ok: boolean; message: string; signed?: Hex; from?: Address }> {
  const chainId = CHAINS[chain].viem.id;
  // The active wallet can change between a trade's plan and its signature
  // (a Remove, or Paper + Select in the window). The caller names the wallet
  // it planned for; a different active key is refused, never substituted —
  // the Solana signer's "fee payer is not this wallet" rule.
  let from: string;
  try {
    from = getAddress(tx.from);
  } catch {
    return { ok: false, message: 'Transaction names no valid sender — refusing to sign' };
  }
  if (getAddress(w.address) !== from) return { ok: false, message: 'Active wallet changed during the trade — refusing to sign' };
  // The chain the key is asked to sign for is what the policy is checked
  // against (not the policy's own id, which would compare it to itself).
  const verdict = checkEvmTx(
    { chainId, to: tx.to, value: tx.value, data: tx.data, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas },
    policy,
  );
  if (!verdict.ok) return { ok: false, message: verdict.message };
  // The policy names the chain it was written for; the key signs for the
  // chain it was asked to. They must agree, or a tx built for one chain
  // could be replayed on the other with the same key.
  if (policy.chainId !== chainId) return { ok: false, message: `Policy is for chain ${policy.chainId}, signing for ${chainId} — refusing` };
  let pk: Hex | null = null;
  try {
    pk = decryptSecret(w);
    const account = privateKeyToAccount(pk);
    if (getAddress(account.address) !== getAddress(w.address)) return { ok: false, message: 'Key mismatch — refusing to sign' };
    const signed = await account.signTransaction({
      chainId,
      type: 'eip1559',
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
    });
    return { ok: true, message: 'signed', signed, from: account.address };
  } catch (err) {
    return { ok: false, message: `Signing failed: ${(err as Error).message}` };
  } finally {
    pk = null;
  }
}

export { toHex as __hexForTest };
