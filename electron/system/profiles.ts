// Profiles — the disk and process half (2026-09-26). The rules are in
// shared/profiles.ts; read that first.
//
// Layout:
//   <appData>/<productName>/            the Default profile (or the legacy
//                                       folder profileContinuity picks)
//   <appData>/Krypto Bot Profiles/
//     profiles.json                     the registry (fail-closed)
//     <id>/                             one userData folder per profile
//
// Isolation comes from Electron itself once userData is set: every store in
// the app reads app.getPath('userData'), the renderer's storage and caches
// follow it (sessionData defaults to userData), and requestSingleInstanceLock
// is keyed on it — so the lock is per profile with no code of ours. Two
// windows of one profile focus the first; different profiles run side by side.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  DEFAULT_PROFILE_ID,
  INSTANCE_FILE,
  MAX_PROFILES,
  PROFILE_ENV,
  PROFILES_ROOT_NAME,
  REGISTRY_FILE,
  SKIP_IN_DIRS,
  cleanProfileName,
  cloneAutomation,
  cloneSettings,
  duplicatePlan,
  isProfileId,
  nameProblem,
  nextColour,
  parseProfileArg,
  parseRegistry,
  pickMcpPort,
  profileArgFor,
  serializeRegistry,
  shortcutFileName,
  slugForName,
  windowTitle,
  type ProfileColour,
  type ProfileEntry,
  type ProfileRegistry,
  type RegistryRead,
} from '@shared/profiles';
import { DEFAULT_MCP_SETTINGS } from '@shared/mcp';
import { SETTINGS_REVISION } from '@shared/types';

const PRODUCT = 'Krypto Bot';

interface Current {
  /** null = the Default profile. */
  id: string | null;
  name: string;
  colour: ProfileColour | null;
  dir: string;
}

let appDataDir = '';
let defaultDir = '';
let current: Current | null = null;

export function rootDir(): string {
  return path.join(appDataDir, PROFILES_ROOT_NAME);
}

function registryPath(): string {
  return path.join(rootDir(), REGISTRY_FILE);
}

/**
 * The folder for a profile id — ONLY ever <root>/<id>, from a validated id.
 * The resolved parent is compared back to the root as a second wall, so no
 * future change to the id rule can turn this into a path traversal.
 */
export function dirFor(id: string): string {
  if (!isProfileId(id)) throw new Error('invalid profile id');
  const root = path.resolve(rootDir());
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) throw new Error('profile folder escapes the profiles root');
  return dir;
}

export function readRegistry(): RegistryRead {
  let text: string | null = null;
  try {
    text = fs.readFileSync(registryPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: `${registryPath()} could not be read (${(e as Error).message})` };
    }
  }
  const r = parseRegistry(text);
  return r.ok ? r : { ok: false, error: `${registryPath()}: ${r.error}` };
}

function writeRegistry(reg: ProfileRegistry): { ok: boolean; message: string } {
  try {
    fs.mkdirSync(rootDir(), { recursive: true });
    // Per-process tmp name: two instances saving at once must not share one.
    const tmp = `${registryPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serializeRegistry(reg), 'utf8');
    fs.renameSync(tmp, registryPath());
    return { ok: true, message: 'saved' };
  } catch (e) {
    return { ok: false, message: `The profiles list could not be saved: ${(e as Error).message}` };
  }
}

export type StartupPick = { ok: true; id: string | null; dir: string } | { ok: false; message: string };

/**
 * Decide the profile BEFORE anything reads userData. Called first thing in
 * main.ts, after the legacy redirect has settled what Default means.
 *
 * Refuses rather than falls back: a shortcut for a clone that silently opened
 * the Default profile (the one with the real wallet) is the failure this
 * feature must never have. Each refusal says what to do.
 */
export function selectAtStartup(opts: { appData: string; defaultUserData: string; argv: readonly string[]; env: Record<string, string | undefined> }): StartupPick {
  appDataDir = opts.appData;
  defaultDir = opts.defaultUserData;
  const arg = parseProfileArg(opts.argv, opts.env);
  if (arg.kind === 'none' || arg.kind === 'default') {
    current = { id: null, name: 'Default', colour: null, dir: defaultDir };
    return { ok: true, id: null, dir: defaultDir };
  }
  if (arg.kind === 'invalid') {
    return { ok: false, message: `"${arg.raw}" is not a profile name this app understands. A profile is chosen with --profile=<id>, where the id is the short name shown under Settings → Profiles.` };
  }
  const reg = readRegistry();
  if (!reg.ok) {
    return { ok: false, message: `The list of profiles could not be read, so the "${arg.id}" profile cannot be opened safely.\n\n${reg.error}\n\nOpen Krypto Bot without a profile to reach your Default profile. Nothing has been changed.` };
  }
  const entry = reg.registry.profiles.find((p) => p.id === arg.id);
  if (!entry) {
    return { ok: false, message: `There is no profile called "${arg.id}". It may have been deleted. Open Krypto Bot without a profile, then Settings → Profiles to see the ones that exist.` };
  }
  let dir: string;
  try {
    dir = dirFor(entry.id);
    // A junction or symlink here would point the profile somewhere else on
    // disk, which is exactly what naming profiles by id exists to prevent.
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return { ok: false, message: `The folder for profile "${entry.name}" is a link to somewhere else, so it will not be opened.\n\n${dir}` };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, message: `The folder for profile "${entry.name}" could not be opened: ${(e as Error).message}` };
  }
  current = { id: entry.id, name: entry.name, colour: entry.colour, dir };
  return { ok: true, id: entry.id, dir };
}

export function currentProfile(): Current {
  return current ?? { id: null, name: 'Default', colour: null, dir: defaultDir };
}

/** The MCP server name for this instance: the Default keeps the old one. */
export function currentId(): string | null {
  return currentProfile().id;
}

export function title(): string {
  const reg = readRegistry();
  const others = reg.ok ? reg.registry.profiles.length : 0;
  const c = currentProfile();
  return windowTitle(PRODUCT, c.id === null ? null : c.name, others);
}

// ── Which profiles are running ─────────────────────────────────────────

/** Written once this instance holds its profile's lock. */
export function markRunning(): void {
  try {
    // A first run has no folder yet — this runs before any store makes it.
    fs.mkdirSync(currentProfile().dir, { recursive: true });
    fs.writeFileSync(path.join(currentProfile().dir, INSTANCE_FILE), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  } catch {
    /* only used to refuse deleting a running profile; absent = unknown */
  }
}

export function clearRunning(): void {
  try {
    const f = path.join(currentProfile().dir, INSTANCE_FILE);
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { pid?: unknown };
    if (raw.pid === process.pid) fs.unlinkSync(f);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Is an instance running on this folder? From the marker's pid. A reused pid
 * after a crash reads as "running" — the safe direction, since the only thing
 * this gates is deleting the folder.
 */
function runningAt(dir: string): boolean {
  if (path.resolve(dir) === path.resolve(currentProfile().dir)) return true;
  let pid: unknown;
  try {
    pid = (JSON.parse(fs.readFileSync(path.join(dir, INSTANCE_FILE), 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const hasWallets = (dir: string): boolean =>
  ['wallets.json', 'wallet.json', 'evm-wallets.json'].some((f) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  });

export interface ProfileRow {
  id: string;
  name: string;
  colour: ProfileColour | null;
  createdAt: number | null;
  isDefault: boolean;
  isCurrent: boolean;
  running: boolean;
  hasWallets: boolean;
}

export interface ProfilesView {
  current: { id: string; name: string; colour: ProfileColour | null; isDefault: boolean };
  profiles: ProfileRow[];
  /** Set when the registry could not be read: nothing can be changed. */
  registryError: string | null;
  canShortcut: boolean;
  max: number;
}

export function view(): ProfilesView {
  const c = currentProfile();
  const reg = readRegistry();
  const rows: ProfileRow[] = [
    { id: DEFAULT_PROFILE_ID, name: 'Default', colour: null, createdAt: null, isDefault: true, isCurrent: c.id === null, running: runningAt(defaultDir), hasWallets: hasWallets(defaultDir) },
  ];
  if (reg.ok) {
    for (const p of reg.registry.profiles) {
      let dir: string;
      try {
        dir = dirFor(p.id);
      } catch {
        continue;
      }
      rows.push({ id: p.id, name: p.name, colour: p.colour, createdAt: p.createdAt, isDefault: false, isCurrent: c.id === p.id, running: runningAt(dir), hasWallets: hasWallets(dir) });
    }
  }
  return {
    current: { id: c.id ?? DEFAULT_PROFILE_ID, name: c.name, colour: c.colour, isDefault: c.id === null },
    profiles: rows,
    registryError: reg.ok ? null : reg.error,
    canShortcut: process.platform === 'win32',
    max: MAX_PROFILES,
  };
}

// ── Changing the list ──────────────────────────────────────────────────

type Result = { ok: boolean; message: string; id?: string };

function writableRegistry(): { ok: true; reg: ProfileRegistry } | { ok: false; message: string } {
  const r = readRegistry();
  if (!r.ok) return { ok: false, message: `The profiles list could not be read, so nothing will be changed: ${r.error}` };
  return { ok: true, reg: r.registry };
}

/** MCP ports every profile's saved settings name, the Default's included. */
function usedMcpPorts(reg: ProfileRegistry, extra: number[]): number[] {
  const out = [DEFAULT_MCP_SETTINGS.port, ...extra];
  const dirs = [defaultDir, ...reg.profiles.map((p) => (isProfileId(p.id) ? dirFor(p.id) : null)).filter((d): d is string => !!d)];
  for (const d of dirs) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8')) as { mcp?: { port?: unknown } };
      if (typeof s?.mcp?.port === 'number') out.push(s.mcp.port);
    } catch {
      /* no settings = the default port, already counted */
    }
  }
  return out;
}

function prepareNew(nameRaw: unknown): { ok: true; reg: ProfileRegistry; entry: ProfileEntry; dir: string } | { ok: false; message: string } {
  const w = writableRegistry();
  if (!w.ok) return w;
  const reg = w.reg;
  if (reg.profiles.length >= MAX_PROFILES) return { ok: false, message: `You have ${MAX_PROFILES} profiles, which is the most this app keeps.` };
  const name = cleanProfileName(nameRaw);
  const problem = nameProblem(name, reg);
  if (problem || !name) return { ok: false, message: problem ?? 'Give the profile a name.' };
  // Ids already on disk are taken too, even if the list forgot them: a new
  // profile must never adopt an old profile's leftover folder (and wallet).
  let onDisk: string[] = [];
  try {
    onDisk = fs.readdirSync(rootDir());
  } catch {
    /* no root yet */
  }
  const id = slugForName(name, [...reg.profiles.map((p) => p.id), ...onDisk.map((n) => n.toLowerCase())]);
  const dir = dirFor(id);
  if (fs.existsSync(dir)) return { ok: false, message: 'A folder for that profile already exists. Pick another name.' };
  return { ok: true, reg, entry: { id, name, createdAt: Date.now(), colour: nextColour(reg) }, dir };
}

function commitNew(reg: ProfileRegistry, entry: ProfileEntry, dir: string): Result {
  const saved = writeRegistry({ version: 1, profiles: [...reg.profiles, entry] });
  if (!saved.ok) {
    // Nothing points at the folder we just made; take it back down.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* an empty folder left behind is harmless */
    }
    return saved;
  }
  return { ok: true, message: `Profile "${entry.name}" created.`, id: entry.id };
}

/** A blank profile: its own folder, first-run everything (terms included). */
export function create(nameRaw: unknown): Result {
  const p = prepareNew(nameRaw);
  if (!p.ok) return p;
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    // Only its own MCP port, so turning the AI connection on in two profiles
    // does not collide. Everything else is the shipped default.
    const port = pickMcpPort(usedMcpPorts(p.reg, []));
    fs.writeFileSync(
      path.join(p.dir, 'settings.json'),
      JSON.stringify({ settingsRevision: SETTINGS_REVISION, mcp: { ...DEFAULT_MCP_SETTINGS, port } }, null, 2),
      'utf8',
    );
  } catch (e) {
    return { ok: false, message: `The profile folder could not be created: ${(e as Error).message}` };
  }
  return commitNew(p.reg, p.entry, p.dir);
}

function copyDir(src: string, dst: string): void {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (SKIP_IN_DIRS.has(name)) continue;
      copyDir(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  if (st.isFile()) fs.copyFileSync(src, dst);
}

/**
 * Duplicate THIS profile. `settings` is the live in-memory settings object —
 * newer than the file while a save is pending. Returns what was skipped so
 * the user is told, not left to find out.
 */
export function duplicate(nameRaw: unknown, copyWallets: boolean, settings: unknown): Result & { skipped?: string[] } {
  const p = prepareNew(nameRaw);
  if (!p.ok) return p;
  const src = currentProfile().dir;
  const plan = duplicatePlan(copyWallets);
  const skipped: string[] = [];
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    const port = pickMcpPort(usedMcpPorts(p.reg, [(settings as { mcp?: { port?: number } })?.mcp?.port ?? DEFAULT_MCP_SETTINGS.port]));
    for (const f of plan.files) {
      const from = path.join(src, f);
      const to = path.join(p.dir, f);
      if (f === 'settings.json') {
        fs.writeFileSync(to, JSON.stringify(cloneSettings(settings, { mcpPort: port }), null, 2), 'utf8');
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(from);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push(`${f} (${(e as Error).message})`);
        continue;
      }
      if (f.endsWith('.json') && f !== 'Local State') {
        // Parsed on the way across: a file caught mid-write by the running
        // source is skipped, not copied torn.
        let obj: unknown;
        try {
          obj = JSON.parse(buf.toString('utf8'));
        } catch {
          skipped.push(`${f} (being written — try again)`);
          continue;
        }
        if (f === 'automation.json') {
          const c = cloneAutomation(obj);
          if (!c) {
            skipped.push(`${f} (unrecognised)`);
            continue;
          }
          fs.writeFileSync(to, JSON.stringify(c, null, 2), 'utf8');
          continue;
        }
      }
      fs.writeFileSync(to, buf);
    }
    for (const d of plan.dirs) {
      const from = path.join(src, d);
      if (!fs.existsSync(from)) continue;
      try {
        copyDir(from, path.join(p.dir, d));
      } catch (e) {
        // The renderer's storage is a live database; a file it holds open may
        // refuse. A clone with default layouts is still a working clone.
        try {
          fs.rmSync(path.join(p.dir, d), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        skipped.push(`${d} (${(e as Error).message})`);
      }
    }
  } catch (e) {
    try {
      fs.rmSync(p.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, message: `The profile could not be copied: ${(e as Error).message}` };
  }
  const r = commitNew(p.reg, p.entry, p.dir);
  return r.ok ? { ...r, message: `Profile "${p.entry.name}" created from ${currentProfile().name}.`, skipped } : r;
}

export function rename(id: unknown, nameRaw: unknown): Result {
  if (!isProfileId(id)) return { ok: false, message: 'The Default profile keeps its name.' };
  const w = writableRegistry();
  if (!w.ok) return w;
  const entry = w.reg.profiles.find((p) => p.id === id);
  if (!entry) return { ok: false, message: 'No such profile.' };
  const name = cleanProfileName(nameRaw);
  const problem = nameProblem(name, w.reg, id);
  if (problem || !name) return { ok: false, message: problem ?? 'Give the profile a name.' };
  const saved = writeRegistry({ version: 1, profiles: w.reg.profiles.map((p) => (p.id === id ? { ...p, name } : p)) });
  if (!saved.ok) return saved;
  if (current && current.id === id) current = { ...current, name };
  return { ok: true, message: `Renamed to "${name}".` };
}

/**
 * Delete a profile: never the Default, never this one, never one that is
 * running. The folder goes to the Recycle Bin / Trash, so a wallet deleted by
 * mistake can still be restored — this app never erases a key file itself.
 */
export async function remove(id: unknown, trash: (p: string) => Promise<void>): Promise<Result> {
  if (!isProfileId(id)) return { ok: false, message: 'The Default profile cannot be deleted.' };
  if (currentProfile().id === id) return { ok: false, message: 'This window is that profile. Open another profile to delete this one.' };
  const w = writableRegistry();
  if (!w.ok) return w;
  const entry = w.reg.profiles.find((p) => p.id === id);
  if (!entry) return { ok: false, message: 'No such profile.' };
  const dir = dirFor(id);
  if (runningAt(dir)) return { ok: false, message: `"${entry.name}" is running. Close its window first.` };
  if (fs.existsSync(dir)) {
    try {
      await trash(dir);
    } catch (e) {
      return { ok: false, message: `"${entry.name}" could not be moved to the Recycle Bin (${(e as Error).message}). Nothing was deleted. Its folder is ${dir}.` };
    }
  }
  const saved = writeRegistry({ version: 1, profiles: w.reg.profiles.filter((p) => p.id !== id) });
  if (!saved.ok) return saved;
  return { ok: true, message: `"${entry.name}" was moved to the Recycle Bin.` };
}

// ── Launching ──────────────────────────────────────────────────────────

function knownId(id: unknown): string | null {
  if (id === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
  if (!isProfileId(id)) return null;
  const r = readRegistry();
  return r.ok && r.registry.profiles.some((p) => p.id === id) ? id : null;
}

/** How to start this app again: the exe (packaged) or electron + the app dir (dev). */
function launchSpec(id: string, packaged: boolean, appPath: string): { exe: string; args: string[] } {
  return { exe: process.execPath, args: packaged ? [profileArgFor(id)] : [appPath, profileArgFor(id)] };
}

/**
 * Start a profile as its own process. If it is already running, its lock
 * sends the new process's launch to the existing window, which comes to the
 * front — the same thing a double-click on its shortcut does.
 */
export function open(id: unknown, packaged: boolean, appPath: string): Result {
  const known = knownId(id);
  if (!known) return { ok: false, message: 'No such profile.' };
  if ((known === DEFAULT_PROFILE_ID && currentProfile().id === null) || known === currentProfile().id) {
    return { ok: true, message: 'This window is that profile.' };
  }
  const { exe, args } = launchSpec(known, packaged, appPath);
  const env = { ...process.env };
  // The child picks its profile from its OWN argument, and must not inherit a
  // dev debug port (two processes cannot bind one).
  delete env[PROFILE_ENV];
  delete env.KRYPT_DEBUG_PORT;
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.on('error', () => undefined);
    child.unref();
  } catch (e) {
    return { ok: false, message: `The profile could not be started: ${(e as Error).message}` };
  }
  return { ok: true, message: 'Opening…' };
}

/** A Windows desktop shortcut that opens this profile directly. */
export function shortcut(
  id: unknown,
  packaged: boolean,
  appPath: string,
  desktop: string,
  write: (lnk: string, opts: { target: string; args: string; description: string; icon: string; iconIndex: number }) => boolean,
): Result {
  if (process.platform !== 'win32') return { ok: false, message: 'Desktop shortcuts are made on Windows only.' };
  const known = knownId(id);
  if (!known) return { ok: false, message: 'No such profile.' };
  const reg = readRegistry();
  const name = known === DEFAULT_PROFILE_ID ? 'Default' : (reg.ok ? reg.registry.profiles.find((p) => p.id === known)?.name : null) ?? known;
  const { exe, args } = launchSpec(known, packaged, appPath);
  const lnk = path.join(desktop, shortcutFileName(PRODUCT, name));
  const okd = write(lnk, {
    target: exe,
    args: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
    description: `${PRODUCT} — ${name} profile`,
    icon: exe,
    iconIndex: 0,
  });
  return okd ? { ok: true, message: `Shortcut "${path.basename(lnk)}" is on your desktop.` } : { ok: false, message: 'Windows refused to create the shortcut.' };
}
