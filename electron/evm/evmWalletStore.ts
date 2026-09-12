// Robinhood Chain wallet bookkeeping — pure, no key material, no `electron`.
//
// The same split as system/walletStore.ts (Solana): evmWallet.ts owns the
// secret, this file owns the list, and every rule is a pure function over a
// plain object so it can be tested offline. The Solana file is NOT reused:
// an EVM key is secp256k1, an address is 20 bytes, and there is no balance
// cap or withdrawal address on this chain yet — sharing the record shape
// would put Solana-only fields on every EVM wallet and, worse, let one
// store's activeId silently point at the other chain's signer.
//
// Invariants (mirroring the Solana store, pinned by test/evmwalletstore):
//   1. every chain's active id names a wallet that exists, or is null
//      because this install holds none.
//   2. Adding never changes who signs, except for the very first wallet.
//   3. The same address cannot be held twice.
//   4. Removing a chain's active wallet promotes the OLDEST survivor.
//
// One list of keys, one signer PER CHAIN.
//
// An EVM private key is chain-agnostic: the same 32 bytes are the same
// address on Robinhood Chain and on BNB, so there is one list of keys and
// there always was. What there was not, until 2026-09-11, was a way to use a
// DIFFERENT one on each chain - both chains read a single `activeId`, so
// every BNB trade came from the same address as every Robinhood trade whether
// the user wanted that or not.
//
// So the list stays shared and the CHOICE became per chain. Nothing about the
// keys themselves changed, which is why the migration below is a widening
// rather than a conversion: an old file's single `activeId` seeds both
// chains, and a user who never opens the picker sees what they saw before.
//
// ─── A home chain per wallet (2026-09-12) ─────────────────────────────────
//
// The widening had a visible cost: BNB Wallet showed the Robinhood address,
// because the one pre-split key was seeded as BNB's signer, and making a new
// wallet from the BNB page added it to the list without making BNB use it
// (adding never changes who signs). So every wallet now records the chain it
// was MADE FOR, from the page that made it:
//
//   · a chain only adopts a wallet made for it (or a pre-split one) as its
//     signer when it needs one — a BNB wallet is never Robinhood's fallback;
//   · a wallet made for a chain whose signer is missing or shared with the
//     other chain becomes that chain's signer at once, which is the user
//     asking for the split to happen;
//   · a pre-split wallet has no home and stays visible on both, because it
//     was used on both and may hold funds on both. `assignWallet` lets the
//     user say where it belongs.
//
// Keys never move. This is bookkeeping over the same file.

import { EVM_CHAINS, EVM_CHAIN_META, type EvmChainKind } from '@shared/evm';

export interface EvmStoredWallet {
  id: string;
  label: string;
  /** Checksummed 0x address. */
  address: string;
  /** Opaque ciphertext of the 32-byte private key; evmWallet.ts only. */
  secretEnc: string;
  createdAt: number;
  /**
   * The chain this wallet was made for. Absent on a wallet from before
   * 2026-09-12, which belongs to both chains — and that absence is kept
   * rather than guessed, because such a key may hold funds on both.
   */
  createdFor?: EvmChainKind;
}

const isChain = (v: unknown): v is EvmChainKind => typeof v === 'string' && (EVM_CHAINS as string[]).includes(v);

/** May this wallet sign on this chain without the user picking it? */
export function eligibleOn(w: EvmStoredWallet, chain: EvmChainKind): boolean {
  return w.createdFor === undefined || w.createdFor === chain;
}

const shortName = (chain: EvmChainKind): string => EVM_CHAIN_META[chain].shortName;
const otherChain = (chain: EvmChainKind): EvmChainKind => EVM_CHAINS.find((c) => c !== chain) ?? chain;

export interface EvmWalletsFile {
  version: 1;
  /**
   * Stamped when the file was first written, and deliberately NOT changed by
   * the per-chain work: `parseFile` refuses a file whose stamp disagrees, and
   * a refused wallet file is a fail-closed file - every key in it becomes
   * unreachable. It identifies the file's origin, not which chain the keys
   * belong to, because they belong to both.
   */
  chainId: number;
  /** Who signs, per chain. Null where this install holds no wallets at all. */
  active: Record<EvmChainKind, string | null>;
  wallets: EvmStoredWallet[];
}

export const MAX_EVM_WALLETS = 20;
const MAX_LABEL = 32;

const noActive = (): Record<EvmChainKind, string | null> => ({ robinhood: null, bnb: null });

export function emptyFile(chainId: number): EvmWalletsFile {
  return { version: 1, chainId, active: noActive(), wallets: [] };
}

/**
 * Default labels say EVM, not Hood.
 *
 * They were "Hood wallet N" from when this list existed only for Robinhood.
 * The same key signs on BNB too, and since 2026-09-11 it can be the BNB
 * signer while a different one signs on Robinhood — so the old name is now
 * actively misleading. Existing labels are untouched; this only names wallets
 * made from here on.
 */
export function cleanLabel(raw: string, fallbackIndex: number): string {
  const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return trimmed.length ? trimmed : `EVM wallet ${fallbackIndex}`;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function parseWallet(w: unknown): EvmStoredWallet | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.address !== 'string' || !ADDRESS_RE.test(o.address)) return null;
  if (typeof o.secretEnc !== 'string' || !o.secretEnc) return null;
  const parsed: EvmStoredWallet = {
    id: o.id,
    label: typeof o.label === 'string' && o.label.trim() ? o.label.slice(0, MAX_LABEL) : 'EVM wallet',
    address: o.address,
    secretEnc: o.secretEnc,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
  // Only set when it was written: an absent home is a fact about the wallet
  // (pre-split), not a field to fill in.
  if (isChain(o.createdFor)) parsed.createdFor = o.createdFor;
  return parsed;
}

/** Read whatever is on disk into the current shape, or null when it is not
 *  a file this version understands. A malformed entry is skipped rather than
 *  taking the other wallets down with it. */
export function parseFile(raw: unknown, chainId: number): EvmWalletsFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.wallets)) return null;
  // A file for another chain is not this chain's wallet list.
  if (typeof obj.chainId === 'number' && obj.chainId !== chainId) return null;
  const wallets: EvmStoredWallet[] = [];
  for (const w of obj.wallets as unknown[]) {
    const parsed = parseWallet(w);
    if (parsed && !wallets.some((x) => x.address.toLowerCase() === parsed.address.toLowerCase())) wallets.push(parsed);
  }
  // Migration: one signer becomes one signer PER CHAIN.
  //
  // A file written before 2026-09-11 has a single `activeId`. It seeds BOTH
  // chains, so an existing install keeps signing with exactly the wallet it
  // signed with yesterday until the user picks otherwise. A widening, never a
  // reset - this file holds the only copy of every key, and the one thing
  // worse than a confusing default is a surprising one.
  const legacy = typeof obj.activeId === 'string' ? obj.activeId : null;
  const saved = obj.active && typeof obj.active === 'object' ? (obj.active as Record<string, unknown>) : null;
  const pick = (chain: EvmChainKind): string | null => {
    const v = saved ? saved[chain] : undefined;
    return typeof v === 'string' ? v : legacy;
  };
  const active: Record<EvmChainKind, string | null> = { robinhood: pick('robinhood'), bnb: pick('bnb') };
  return healActive({ version: 1, chainId, active, wallets });
}

/** Every chain's active id names a wallet that exists, or is null. */
export function healActive(file: EvmWalletsFile): EvmWalletsFile {
  // A file that needs no repair is returned AS IS, same object. Rebuilding it
  // on every read would churn an object on every wallet lookup for nothing,
  // and callers compare by identity to decide whether to persist.
  const sound = (id: string | null | undefined): boolean => !!id && file.wallets.some((w) => w.id === id);
  if (file.active && EVM_CHAINS.every((c) => sound(file.active[c]))) return file;
  const byAge = [...file.wallets].sort((a, b) => a.createdAt - b.createdAt);
  const active = noActive();
  for (const chain of EVM_CHAINS) {
    const want = file.active ? file.active[chain] : null;
    if (want && file.wallets.some((w) => w.id === want)) {
      active[chain] = want;
      continue;
    }
    // The oldest wallet ELIGIBLE here. A wallet made for the other chain is
    // never borrowed: a chain whose only candidates belong to the other one
    // has no signer, and its page offers to make it one, rather than quietly
    // signing with a wallet the user made for somewhere else.
    const oldest = byAge.find((w) => eligibleOn(w, chain));
    active[chain] = oldest ? oldest.id : null;
  }
  return { ...file, active };
}

export function activeWallet(file: EvmWalletsFile, chain: EvmChainKind): EvmStoredWallet | null {
  const id = file.active ? file.active[chain] : null;
  if (!id) return null;
  return file.wallets.find((w) => w.id === id) ?? null;
}

export interface EvmStoreResult {
  file: EvmWalletsFile;
  ok: boolean;
  message: string;
}

export function addWallet(file: EvmWalletsFile, w: EvmStoredWallet): EvmStoreResult {
  if (file.wallets.length >= MAX_EVM_WALLETS) return { file, ok: false, message: `At most ${MAX_EVM_WALLETS} wallets.` };
  if (!ADDRESS_RE.test(w.address)) return { file, ok: false, message: 'Not a valid address.' };
  if (file.wallets.some((x) => x.address.toLowerCase() === w.address.toLowerCase())) {
    return { file, ok: false, message: 'That key is already in this wallet list.' };
  }
  if (file.wallets.some((x) => x.id === w.id)) return { file, ok: false, message: 'Duplicate wallet id.' };
  const wallets = [...file.wallets, w];
  // The FIRST wallet a chain can use becomes its signer. Any later one
  // changes nothing about who signs, on either chain.
  const active = noActive();
  for (const chain of EVM_CHAINS) active[chain] = (file.active ? file.active[chain] : null) ?? (eligibleOn(w, chain) ? w.id : null);
  return { file: healActive({ ...file, wallets, active }), ok: true, message: `Added ${w.label}` };
}

/**
 * Add a wallet made FOR one chain, from that chain's page.
 *
 * It signs there straight away in exactly one situation: the chain has no
 * signer of its own — none at all, or one it SHARES with the other chain (a
 * pre-split key seeded onto both). That is the "BNB Wallet shows my Robinhood
 * address" state, and making a wallet for BNB is the user asking for it to
 * end. A chain already signing with a wallet the other chain does not use
 * keeps it: adding never changes who signs, same as everywhere else.
 *
 * `allowSwitch` is the arm interlock, decided by the caller who knows the
 * arm state: a switch that would happen under a live chain is refused whole,
 * so the user is never left with a wallet added but the split not made.
 */
export function addWalletFor(file: EvmWalletsFile, w: EvmStoredWallet, chain: EvmChainKind, allowSwitch = true): EvmStoreResult & { switched: boolean } {
  const cur = file.active ? file.active[chain] : null;
  const shared = cur !== null && file.active[otherChain(chain)] === cur;
  const needsSwitch = cur === null || shared;
  if (needsSwitch && !allowSwitch) {
    return { file, ok: false, switched: false, message: `Switch ${shortName(chain)} to Paper before giving it its own wallet.` };
  }
  const added = addWallet(file, { ...w, createdFor: chain });
  if (!added.ok) return { ...added, switched: false };
  if (!needsSwitch) return { ...added, switched: false, message: `Added ${w.label} for ${shortName(chain)}` };
  // With no signer at all, addWallet already promoted it; with a shared one,
  // this is the explicit choice. Either way the other chain is untouched.
  const sel = selectWallet(added.file, chain, w.id);
  return { file: sel.file, ok: true, switched: true, message: `${w.label} now signs on ${shortName(chain)}` };
}

/**
 * Say which chain a wallet belongs to — the way a pre-split wallet leaves
 * the page of a chain it is not used on. Refused while it signs on a
 * different chain: that chain would be signing with a wallet its own page
 * no longer lists.
 */
export function assignWallet(file: EvmWalletsFile, id: string, chain: EvmChainKind): EvmStoreResult {
  const idx = file.wallets.findIndex((w) => w.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such wallet.' };
  const target = file.wallets[idx];
  const elsewhere = EVM_CHAINS.find((c) => c !== chain && file.active && file.active[c] === id);
  if (elsewhere) return { file, ok: false, message: `${target.label} signs on ${shortName(elsewhere)} — pick another signer there first.` };
  if (target.createdFor === chain) return { file, ok: true, message: `${target.label} is already a ${shortName(chain)} wallet` };
  const wallets = [...file.wallets];
  wallets[idx] = { ...target, createdFor: chain };
  return { file: { ...file, wallets }, ok: true, message: `${target.label} is now a ${shortName(chain)} wallet` };
}

/** Choose who signs on ONE chain. The other chain is never touched. */
export function selectWallet(file: EvmWalletsFile, chain: EvmChainKind, id: string): EvmStoreResult {
  const target = file.wallets.find((w) => w.id === id);
  if (!target) return { file, ok: false, message: 'No such wallet.' };
  const where = EVM_CHAIN_META[chain].shortName;
  if (file.active && file.active[chain] === id) {
    return { file, ok: true, message: `${target.label} already signs on ${where}` };
  }
  return {
    file: { ...file, active: { ...file.active, [chain]: id } },
    ok: true,
    message: `${target.label} now signs on ${where}`,
  };
}

export function renameWallet(file: EvmWalletsFile, id: string, label: string): EvmStoreResult {
  const idx = file.wallets.findIndex((w) => w.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such wallet.' };
  const wallets = [...file.wallets];
  wallets[idx] = { ...wallets[idx], label: cleanLabel(label, idx + 1) };
  return { file: { ...file, wallets }, ok: true, message: 'Renamed' };
}

export function removeWallet(file: EvmWalletsFile, id: string): EvmStoreResult {
  const target = file.wallets.find((w) => w.id === id);
  if (!target) return { file, ok: false, message: 'No such wallet.' };
  const wallets = file.wallets.filter((w) => w.id !== id);
  // Only the chains that were signing with it are re-pointed; a chain using a
  // different wallet keeps the one it has.
  const active = { ...file.active };
  for (const chain of EVM_CHAINS) if (active[chain] === id) active[chain] = null;
  return { file: healActive({ ...file, wallets, active }), ok: true, message: `Removed ${target.label}` };
}

export function nextLabel(file: EvmWalletsFile, chain?: EvmChainKind): string {
  const prefix = chain ? `${shortName(chain)} wallet` : 'EVM wallet';
  for (let n = 1; n <= MAX_EVM_WALLETS + 1; n++) {
    const candidate = `${prefix} ${n}`;
    if (!file.wallets.some((w) => w.label === candidate)) return candidate;
  }
  return prefix;
}
