// Profiles — several isolated copies of the app on one machine (2026-09-26).
//
// "Chrome profiles, but for Krypto Bot": each profile is its OWN userData
// folder, so settings, wallets, scripts, ledgers, orders, logs, pump sessions
// and caches are separate, and two profiles can run side by side with
// different settings. The folder the app has always used (legacy redirect
// included) is the Default profile and behaves exactly as before — nothing is
// migrated.
//
// This file is the pure half: ids, the command-line flag, the registry format
// (fail CLOSED — an unreadable registry is not an empty one), and the rules
// for what a duplicate copies and how it is made safe to run beside its
// source. electron/system/profiles.ts does the disk and process work.
//
// SECURITY. The flag names a profile by ID, never by path. An id is a short
// lowercase slug, it must be in the registry, and the folder is always
// <profiles root>/<id>. There is no way to point userData anywhere else from
// the command line or the environment — a raw path would let anyone who can
// write a shortcut aim the app (and its signing key) at a folder they prepared.

/** `--profile=<id>`. The only form accepted: one token, `=`-joined. */
export const PROFILE_ARG = '--profile';
/** Environment fallback, read only when the command line names no profile. */
export const PROFILE_ENV = 'KRYPTO_PROFILE';
/** The id that means "the folder the app has always used". */
export const DEFAULT_PROFILE_ID = 'default';
/** Folder under appData that holds every other profile, and the registry. */
export const PROFILES_ROOT_NAME = 'Krypto Bot Profiles';
export const REGISTRY_FILE = 'profiles.json';
/** A marker each running instance writes into its own userData. */
export const INSTANCE_FILE = 'instance.json';
export const MAX_PROFILES = 20;
export const MAX_PROFILE_NAME = 40;

/**
 * Lowercase letters, digits and inner hyphens, 1–32 characters. Nothing that
 * can climb out of a folder ('..', separators, drive letters) can match.
 */
export const PROFILE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Names Windows refuses as folder names, plus our own reserved one. */
const RESERVED_IDS = new Set([
  DEFAULT_PROFILE_ID,
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Badge colours a profile can carry. The renderer maps each to its classes. */
export const PROFILE_COLOURS = ['violet', 'emerald', 'amber', 'sky', 'rose', 'lime', 'orange', 'teal'] as const;
export type ProfileColour = (typeof PROFILE_COLOURS)[number];

export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: number;
  colour: ProfileColour | null;
}

export interface ProfileRegistry {
  version: 1;
  profiles: ProfileEntry[];
}

export const EMPTY_REGISTRY: ProfileRegistry = { version: 1, profiles: [] };

/** A profile id that may name a NON-default profile folder. */
export function isProfileId(v: unknown): v is string {
  return typeof v === 'string' && PROFILE_ID_RE.test(v) && !RESERVED_IDS.has(v);
}

/**
 * A display name, cleaned: trimmed, control characters removed, inner runs of
 * whitespace collapsed, at most MAX_PROFILE_NAME characters. Null when
 * nothing usable is left.
 */
export function cleanProfileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return [...s].slice(0, MAX_PROFILE_NAME).join('').trim() || null;
}

/** An id for a new profile, from its name, unique against `taken`. */
export function slugForName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  if (!base || !isProfileId(base)) base = 'profile';
  if (!used.has(base) && isProfileId(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id) && isProfileId(id)) return id;
  }
  // Unreachable with MAX_PROFILES, but never loop forever or return a clash.
  return `profile-${Date.now().toString(36)}`;
}

export type ProfileArg =
  | { kind: 'none' }
  | { kind: 'default' }
  | { kind: 'id'; id: string }
  | { kind: 'invalid'; raw: string };

/**
 * Which profile the command line (or, failing that, the environment) asks for.
 *
 * Only `--profile=<id>` is read. A bare `--profile` or `--profile <id>` is
 * refused as invalid rather than guessed at: Chromium's own switch parser
 * reads the `=` form, and a stray positional could be a file a shell
 * association passed in. Two DIFFERENT --profile flags are ambiguous and
 * refused too; the same one twice is fine.
 */
export function parseProfileArg(argv: readonly string[], env?: Record<string, string | undefined>): ProfileArg {
  const found: string[] = [];
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a === PROFILE_ARG) return { kind: 'invalid', raw: a };
    if (a.startsWith(`${PROFILE_ARG}=`)) found.push(a.slice(PROFILE_ARG.length + 1));
  }
  let raw: string | null = null;
  if (found.length) {
    if (new Set(found).size > 1) return { kind: 'invalid', raw: found.join(', ') };
    raw = found[0];
  } else {
    const e = env?.[PROFILE_ENV];
    if (typeof e === 'string' && e.trim()) raw = e.trim();
  }
  if (raw === null) return { kind: 'none' };
  // Quotes a shortcut or shell left on the value.
  const v = raw.replace(/^["']|["']$/g, '');
  if (v === DEFAULT_PROFILE_ID) return { kind: 'default' };
  if (isProfileId(v)) return { kind: 'id', id: v };
  return { kind: 'invalid', raw: raw.slice(0, 80) };
}

/** The command-line argument that opens a profile. `id` must be valid. */
export function profileArgFor(id: string): string {
  if (id !== DEFAULT_PROFILE_ID && !isProfileId(id)) throw new Error('invalid profile id');
  return `${PROFILE_ARG}=${id}`;
}

export type RegistryRead = { ok: true; registry: ProfileRegistry } | { ok: false; error: string };

/**
 * Parse the registry. FAIL CLOSED: anything that is not exactly the shape we
 * write — bad JSON, a wrong version, a malformed or duplicated entry — is an
 * error, never an empty list. A registry read as empty would let the next
 * create overwrite it and orphan every profile folder it listed.
 *
 * `null` text means the file does not exist: a first run, empty and writable.
 */
export function parseRegistry(text: string | null): RegistryRead {
  if (text === null) return { ok: true, registry: { version: 1, profiles: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `the profiles list is not valid JSON (${(e as Error).message})` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'the profiles list is not an object' };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: `the profiles list has an unknown version (${String(r.version)})` };
  if (!Array.isArray(r.profiles)) return { ok: false, error: 'the profiles list has no profiles array' };
  if (r.profiles.length > MAX_PROFILES * 5) return { ok: false, error: 'the profiles list is implausibly long' };
  const out: ProfileEntry[] = [];
  const ids = new Set<string>();
  for (const p of r.profiles as unknown[]) {
    if (typeof p !== 'object' || p === null) return { ok: false, error: 'the profiles list has a malformed entry' };
    const e = p as Record<string, unknown>;
    if (!isProfileId(e.id)) return { ok: false, error: `the profiles list has an invalid id (${String(e.id).slice(0, 40)})` };
    if (ids.has(e.id)) return { ok: false, error: `the profiles list names ${e.id} twice` };
    const name = cleanProfileName(e.name);
    if (!name) return { ok: false, error: `profile ${e.id} has no name` };
    if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) return { ok: false, error: `profile ${e.id} has no creation time` };
    const colour = PROFILE_COLOURS.includes(e.colour as ProfileColour) ? (e.colour as ProfileColour) : null;
    ids.add(e.id);
    out.push({ id: e.id, name, createdAt: e.createdAt, colour });
  }
  return { ok: true, registry: { version: 1, profiles: out } };
}

export function serializeRegistry(reg: ProfileRegistry): string {
  return JSON.stringify(
    { version: 1, profiles: reg.profiles.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, colour: p.colour })) },
    null,
    2,
  );
}

/** A colour for the next profile: the first one no profile has yet. */
export function nextColour(reg: ProfileRegistry): ProfileColour {
  const used = new Set(reg.profiles.map((p) => p.colour));
  return PROFILE_COLOURS.find((c) => !used.has(c)) ?? PROFILE_COLOURS[reg.profiles.length % PROFILE_COLOURS.length];
}

/** Why a name cannot be used for a new or renamed profile, or null. */
export function nameProblem(name: string | null, reg: ProfileRegistry, exceptId: string | null = null): string | null {
  if (!name) return 'Give the profile a name.';
  if (name.toLowerCase() === 'default') return '"Default" is the name of the original profile.';
  if (reg.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) return 'A profile with that name already exists.';
  return null;
}

// ── Duplicating ────────────────────────────────────────────────────────

/**
 * Files a duplicate copies from the current profile. Settings, scripts, order
 * templates, watchlist, price alerts, the creator blocklist, window furniture,
 * learned builder templates, and the terms acceptance record (the same person
 * accepted the same documents; a BLANK profile asks again).
 *
 * NOT copied, deliberately: trade ledgers, paper positions, advanced orders,
 * copy-trade configs, bot sessions, bridge transfers and research caches. They
 * describe positions and wallets, and a clone that inherited them would act on
 * holdings that belong to the other instance.
 */
export const DUPLICATE_FILES = [
  'settings.json',
  'automation.json',
  'order-templates.json',
  'watchlist.json',
  'alerts.json',
  'creators.json',
  'panel-windows.json',
  'pump-templates.json',
  'legal-acceptance.jsonl',
] as const;

/** Folders a duplicate copies: the renderer's own storage (layouts, pinned
 *  panels, tabs, look) and the card background. */
export const DUPLICATE_DIRS = ['Local Storage', 'card-background'] as const;

/**
 * Only with "also copy wallets". `Local State` holds the key Chromium's
 * safeStorage wraps secrets with on Windows — without it the copied wallet
 * file cannot be decrypted in the new folder. Pump sessions are per wallet,
 * so they go with the wallets.
 */
export const WALLET_FILES = ['wallets.json', 'wallet.json', 'evm-wallets.json', 'pump-session.json', 'pump-profiles.json', 'Local State'] as const;

/** Never copied from a leveldb folder: the lock the source instance holds. */
export const SKIP_IN_DIRS = new Set(['LOCK']);

export function duplicatePlan(copyWallets: boolean): { files: string[]; dirs: string[] } {
  return {
    files: [...DUPLICATE_FILES, ...(copyWallets ? WALLET_FILES : [])],
    dirs: [...DUPLICATE_DIRS],
  };
}

/** The first MCP port after `start` that no other profile uses. */
export function pickMcpPort(used: Iterable<number>, start = 8788, max = 65535): number {
  const taken = new Set(used);
  for (let p = start; p <= max; p++) if (!taken.has(p)) return p;
  return start;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * settings.json for a clone, from the source's settings object.
 *
 * What would make two instances collide or surprise someone is reset:
 *  - chat bots: token, owner and switch cleared. One bot token polled by two
 *    instances is a Telegram 409 for one of them, and on Discord BOTH would
 *    answer — and both would execute a chat trade.
 *  - AI connection: off, no token, and its own port. An agent set up for one
 *    profile must never find itself connected to the other.
 *  - Live: starts in Paper. A clone opening already armed on a copied wallet
 *    is the one surprise that costs money.
 *  - A custom recordings folder: back to the profile's own, so two recorders
 *    never write and prune the same day-files.
 */
export function cloneSettings(src: unknown, opts: { mcpPort: number }): Obj {
  const s: Obj = isObj(src) ? structuredClone(src) : {};
  const bots = isObj(s.bots) ? s.bots : {};
  for (const k of ['telegram', 'discord']) {
    const b = isObj(bots[k]) ? bots[k] : {};
    bots[k] = { ...b, enabled: false, token: '', ownerId: null };
  }
  if (isObj(bots.trading)) bots.trading = { ...bots.trading, enabled: false };
  s.bots = bots;
  const mcp = isObj(s.mcp) ? s.mcp : {};
  s.mcp = { ...mcp, enabled: false, token: '', port: opts.mcpPort, access: 'read' };
  if (isObj(s.execution)) s.execution = { ...s.execution, liveEnabled: false };
  s.recorderDir = '';
  return s;
}

/**
 * automation.json for a clone: the scripts, every one switched OFF, with no
 * runtime state. The runtime holds what a script bought and spent today —
 * true of the source's wallet, meaningless (or wrong) in the clone.
 */
export function cloneAutomation(src: unknown): Obj | null {
  if (!isObj(src) || !Array.isArray(src.scripts)) return null;
  return {
    ...src,
    scripts: src.scripts.map((x) => (isObj(x) ? { ...x, enabled: false } : x)),
    runtime: {},
  };
}

/** The window title for a profile. The Default one keeps the bare name while
 *  it is the only profile, so nothing changes for someone who never uses this. */
export function windowTitle(base: string, profileName: string | null, otherProfiles: number): string {
  if (profileName === null) return otherProfiles > 0 ? `${base} — Default` : base;
  return `${base} — ${profileName}`;
}

/** A file name for a desktop shortcut: Windows-illegal characters removed. */
export function shortcutFileName(base: string, profileName: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = profileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim() || 'Profile';
  return `${base} - ${safe}.lnk`;
}
