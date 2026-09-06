import { DEFAULT_FOLLOW, DEFAULT_RANDOM, validateFollow, validateRandom } from '@shared/lab';
// Multi-wallet state rules — pure, no key material, no `electron` import.
//
// Split from wallet.ts on the same principle as signPolicy.ts: that module
// owns the secret, this one owns the bookkeeping, and bookkeeping is where
// the quiet money bugs live. A dangling `activeId`, a promotion that picks
// nothing, an import that silently duplicates a key you already hold — none
// of those throw, they just leave you trading the wrong wallet. So every rule
// here is a pure function over a plain object and is unit-tested directly.
//
// Nothing in this file ever sees a decrypted secret. `secretEnc` is carried
// around as an opaque string.

export interface StoredWallet {
  /** Stable local id. Not derived from the key, so a relabel or a re-import
   *  never changes how the rest of the app refers to this wallet. */
  id: string;
  label: string;
  publicKey: string;
  /** Opaque ciphertext, produced and consumed only by wallet.ts. */
  secretEnc: string;
  homeAddress: string | null;
  maxBalanceSol: number;
  createdAt: number;
}

/** A named set of wallets, so a fan-out buy can target a whole group at once.
 *  Membership is by wallet id; a removed wallet is simply dropped from every
 *  group it was in. */
export interface WalletGroup {
  id: string;
  name: string;
  walletIds: string[];
  /** Wallet Lab settings (follow / random) for this group. */
  lab?: import('@shared/lab').LabGroupConfig;
}

export interface WalletsFile {
  version: 2;
  /** The wallet that signs single trades. Null only when there are none. */
  activeId: string | null;
  wallets: StoredWallet[];
  /** Named groups for fan-out. Absent on files written before groups existed. */
  groups: WalletGroup[];
}

export const MAX_GROUPS = 20;
const MAX_GROUP_NAME = 32;

/** The single-wallet file this replaced. Still read once, to migrate. */
export interface LegacyWalletFile {
  version: 1;
  publicKey: string;
  secretEnc: string;
  homeAddress: string | null;
  maxBalanceSol: number;
  createdAt: number;
}

export const DEFAULT_MAX_BALANCE_SOL = 2;
const MAX_LABEL = 32;
/** A cap, not a limit anyone should reach — it exists so a runaway loop or a
 *  pasted list cannot fill the keystore. */
export const MAX_WALLETS = 20;

function parseLab(raw: unknown): import('@shared/lab').LabGroupConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { follow?: unknown; random?: unknown };
  const follow = { ...DEFAULT_FOLLOW, ...(o.follow && typeof o.follow === 'object' ? (o.follow as object) : {}) } as import('@shared/lab').FollowSettings;
  const random = { ...DEFAULT_RANDOM, ...(o.random && typeof o.random === 'object' ? (o.random as object) : {}) } as import('@shared/lab').RandomSettings;
  if (!validateFollow(follow).ok || !validateRandom(random).ok) return undefined;
  return { follow, random };
}

export function emptyFile(): WalletsFile {
  return { version: 2, activeId: null, wallets: [], groups: [] };
}

export function cleanLabel(raw: string, fallbackIndex: number): string {
  const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return trimmed.length ? trimmed : `Wallet ${fallbackIndex}`;
}

/**
 * Read whatever is on disk into the current shape.
 *
 * Accepts the v1 single-wallet file and migrates it, because the alternative
 * — treating an unrecognised file as "no wallet" — would look exactly like a
 * wallet that vanished, on a file holding the only copy of a key.
 */
export function parseFile(raw: unknown, now: number, mintId: () => string): WalletsFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.version === 1 && typeof obj.publicKey === 'string' && typeof obj.secretEnc === 'string') {
    return migrateLegacy(obj as unknown as LegacyWalletFile, now, mintId());
  }

  if (obj.version !== 2 || !Array.isArray(obj.wallets)) return null;
  const wallets: StoredWallet[] = [];
  for (const w of obj.wallets as unknown[]) {
    const parsed = parseWallet(w);
    // Skip a malformed entry rather than discarding the whole file: one bad
    // record must not take the other wallets down with it.
    if (parsed && !wallets.some((x) => x.publicKey === parsed.publicKey)) wallets.push(parsed);
  }
  const activeId = typeof obj.activeId === 'string' ? obj.activeId : null;
  const validIds = new Set(wallets.map((w) => w.id));
  const groups: WalletGroup[] = [];
  if (Array.isArray(obj.groups)) {
    for (const g of obj.groups as unknown[]) {
      const parsed = parseGroup(g, validIds);
      if (parsed && !groups.some((x) => x.id === parsed.id)) groups.push(parsed);
    }
  }
  return healActive({ version: 2, activeId, wallets, groups });
}

function parseGroup(g: unknown, validIds: Set<string>): WalletGroup | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.slice(0, MAX_GROUP_NAME) : 'Group';
  // Only keep member ids that still refer to a real wallet, and drop dupes.
  const walletIds = Array.isArray(o.walletIds)
    ? [...new Set((o.walletIds as unknown[]).filter((id): id is string => typeof id === 'string' && validIds.has(id)))]
    : [];
  // Wallet Lab settings ride on the group. Kept only when they validate
  // (2026-09-03: this rebuild used to DROP them on every read, so follow and
  // warmer settings never persisted — not even within a session).
  const lab = parseLab(o.lab);
  return lab ? { id: o.id, name, walletIds, lab } : { id: o.id, name, walletIds };
}

function parseWallet(w: unknown): StoredWallet | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.publicKey !== 'string' || !o.publicKey) return null;
  if (typeof o.secretEnc !== 'string' || !o.secretEnc) return null;
  const max = typeof o.maxBalanceSol === 'number' && o.maxBalanceSol > 0 ? o.maxBalanceSol : DEFAULT_MAX_BALANCE_SOL;
  return {
    id: o.id,
    label: typeof o.label === 'string' && o.label.trim() ? o.label.slice(0, MAX_LABEL) : 'Wallet',
    publicKey: o.publicKey,
    secretEnc: o.secretEnc,
    homeAddress: typeof o.homeAddress === 'string' ? o.homeAddress : null,
    maxBalanceSol: max,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
}

export function migrateLegacy(legacy: LegacyWalletFile, now: number, id: string): WalletsFile {
  const w: StoredWallet = {
    id,
    label: 'Wallet 1',
    publicKey: legacy.publicKey,
    secretEnc: legacy.secretEnc,
    homeAddress: legacy.homeAddress ?? null,
    maxBalanceSol: legacy.maxBalanceSol > 0 ? legacy.maxBalanceSol : DEFAULT_MAX_BALANCE_SOL,
    createdAt: legacy.createdAt || now,
  };
  return { version: 2, activeId: w.id, wallets: [w], groups: [] };
}

/**
 * Guarantee the invariant every caller depends on: `activeId` names a wallet
 * that exists, and is null only when none do.
 *
 * Without this a file whose active wallet was removed by hand reads back with
 * no signer while wallets are plainly listed — which presents as "no wallet"
 * on a machine that has several.
 */
export function healActive(file: WalletsFile): WalletsFile {
  if (!file.wallets.length) return { ...file, activeId: null };
  if (file.activeId && file.wallets.some((w) => w.id === file.activeId)) return file;
  const oldest = [...file.wallets].sort((a, b) => a.createdAt - b.createdAt)[0];
  return { ...file, activeId: oldest.id };
}

export function activeWallet(file: WalletsFile): StoredWallet | null {
  if (!file.activeId) return null;
  return file.wallets.find((w) => w.id === file.activeId) ?? null;
}

export interface StoreResult {
  file: WalletsFile;
  ok: boolean;
  message: string;
}

/** Add a wallet. The first one added becomes active; later ones do not, so
 *  importing a key never silently changes which wallet is signing. */
export function addWallet(file: WalletsFile, w: StoredWallet): StoreResult {
  if (file.wallets.length >= MAX_WALLETS) {
    return { file, ok: false, message: `At most ${MAX_WALLETS} wallets.` };
  }
  if (file.wallets.some((x) => x.publicKey === w.publicKey)) {
    return { file, ok: false, message: 'That key is already in this wallet list.' };
  }
  if (file.wallets.some((x) => x.id === w.id)) {
    return { file, ok: false, message: 'Duplicate wallet id.' };
  }
  const wallets = [...file.wallets, w];
  const activeId = file.activeId ?? w.id;
  return { file: healActive({ ...file, wallets, activeId }), ok: true, message: `Added ${w.label}` };
}

export function selectWallet(file: WalletsFile, id: string): StoreResult {
  const target = file.wallets.find((w) => w.id === id);
  if (!target) return { file, ok: false, message: 'No such wallet.' };
  if (file.activeId === id) return { file, ok: true, message: `${target.label} is already active` };
  return { file: { ...file, activeId: id }, ok: true, message: `Switched to ${target.label}` };
}

export function renameWallet(file: WalletsFile, id: string, label: string): StoreResult {
  const idx = file.wallets.findIndex((w) => w.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such wallet.' };
  const wallets = [...file.wallets];
  wallets[idx] = { ...wallets[idx], label: cleanLabel(label, idx + 1) };
  return { file: { ...file, wallets }, ok: true, message: 'Renamed' };
}

/**
 * Remove a wallet, promoting another when the active one goes.
 *
 * Deliberately does NOT refuse to remove the last wallet — the user is
 * entitled to delete their key. What it refuses to do is leave the file in a
 * state where something still points at a wallet that is gone.
 */
export function removeWallet(file: WalletsFile, id: string): StoreResult {
  const target = file.wallets.find((w) => w.id === id);
  if (!target) return { file, ok: false, message: 'No such wallet.' };
  const wallets = file.wallets.filter((w) => w.id !== id);
  const activeId = file.activeId === id ? null : file.activeId;
  // Drop the gone wallet from every group it was in, so no group points at a
  // wallet that no longer exists.
  const groups = (file.groups ?? []).map((g) => ({ ...g, walletIds: g.walletIds.filter((wid) => wid !== id) }));
  return {
    file: healActive({ ...file, wallets, activeId, groups }),
    ok: true,
    message: `Removed ${target.label}`,
  };
}

// ─── Groups (for fan-out) ─────────────────────────────────────────────

export function createGroup(file: WalletsFile, name: string, id: string): StoreResult {
  const cur = file.groups ?? [];
  if (cur.length >= MAX_GROUPS) return { file, ok: false, message: `At most ${MAX_GROUPS} groups.` };
  const clean = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME) || `Group ${cur.length + 1}`;
  const group: WalletGroup = { id, name: clean, walletIds: [] };
  return { file: { ...file, groups: [...cur, group] }, ok: true, message: `Created ${clean}` };
}

export function renameGroup(file: WalletsFile, id: string, name: string): StoreResult {
  const cur = file.groups ?? [];
  const idx = cur.findIndex((g) => g.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such group.' };
  const clean = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME) || cur[idx].name;
  const groups = [...cur];
  groups[idx] = { ...groups[idx], name: clean };
  return { file: { ...file, groups }, ok: true, message: 'Renamed' };
}

export function deleteGroup(file: WalletsFile, id: string): StoreResult {
  const cur = file.groups ?? [];
  if (!cur.some((g) => g.id === id)) return { file, ok: false, message: 'No such group.' };
  return { file: { ...file, groups: cur.filter((g) => g.id !== id) }, ok: true, message: 'Deleted' };
}

/** Set a group's membership to exactly these wallet ids (invalid ids dropped). */
export function setGroupMembers(file: WalletsFile, id: string, walletIds: string[]): StoreResult {
  const cur = file.groups ?? [];
  const idx = cur.findIndex((g) => g.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such group.' };
  const valid = new Set(file.wallets.map((w) => w.id));
  const members = [...new Set(walletIds.filter((w) => valid.has(w)))];
  const groups = [...cur];
  groups[idx] = { ...groups[idx], walletIds: members };
  return { file: { ...file, groups }, ok: true, message: 'Updated' };
}

export function setGroupLab(file: WalletsFile, id: string, lab: import('@shared/lab').LabGroupConfig): StoreResult {
  const cur = file.groups ?? [];
  const idx = cur.findIndex((g) => g.id === id);
  if (idx < 0) return { file, ok: false, message: 'No such group.' };
  const groups = [...cur];
  groups[idx] = { ...groups[idx], lab };
  return { file: { ...file, groups }, ok: true, message: 'Saved' };
}

/** The wallets in a group, in the group's order, skipping any that vanished. */
export function groupWallets(file: WalletsFile, id: string): StoredWallet[] {
  const group = (file.groups ?? []).find((g) => g.id === id);
  if (!group) return [];
  const byId = new Map(file.wallets.map((w) => [w.id, w]));
  return group.walletIds.map((wid) => byId.get(wid)).filter((w): w is StoredWallet => w !== undefined);
}

/** Patch the ACTIVE wallet's settings (withdrawal address, balance cap). */
export function patchActive(file: WalletsFile, patch: Partial<Pick<StoredWallet, 'homeAddress' | 'maxBalanceSol'>>): StoreResult {
  const active = activeWallet(file);
  if (!active) return { file, ok: false, message: 'No wallet' };
  const wallets = file.wallets.map((w) => (w.id === active.id ? { ...w, ...patch } : w));
  return { file: { ...file, wallets }, ok: true, message: 'Updated' };
}

/** The next default label, given what is already there. */
export function nextLabel(file: WalletsFile): string {
  for (let n = 1; n <= MAX_WALLETS + 1; n++) {
    const candidate = `Wallet ${n}`;
    if (!file.wallets.some((w) => w.label === candidate)) return candidate;
  }
  return 'Wallet';
}
