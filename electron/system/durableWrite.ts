// Writing a file that holds the only copy of a key (security swarm, 2026-11-04).
//
// Write-then-rename alone is not crash safe. Without an fsync the rename can
// reach the disk before the data does, and a power cut leaves an empty or torn
// file where every wallet used to be. So: write, fsync, close, rename, then
// fsync the folder where the platform allows it (Windows does not).
//
// One previous generation is kept beside each file as `<file>.bak`, which is
// what a corrupt file falls back to. That copy is a copy of a key, so anything
// that REMOVES a key must not leave it there: `scrub` writes the new content
// over the backup as well.
//
// Freed disk blocks, shadow copies and SSD wear-levelling are out of reach of
// any file API. This removes the file; it cannot promise the bytes are gone.

import fs from 'node:fs';
import path from 'node:path';

export type BackupMode =
  /** Move the current content to `.bak` first. The normal save. */
  | 'keep'
  /** The backup gets the NEW content too: for removals and re-encryption. */
  | 'scrub'
  /** No backup at all (a file the user chose, or a backup itself). */
  | 'none';

export const bakPath = (p: string): string => `${p}.bak`;

function writeSynced(p: string, data: string | Buffer, mode: number): void {
  const fd = fs.openSync(p, 'w', mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncFolder(p: string): void {
  // Windows refuses to open a folder this way, and POSIX filesystems that
  // cannot do it say so. Either way the file itself is already flushed.
  try {
    const fd = fs.openSync(path.dirname(p), 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}

function replaceSynced(p: string, data: string | Buffer, mode: number): void {
  const tmp = `${p}.tmp`;
  writeSynced(tmp, data, mode);
  fs.renameSync(tmp, p);
  syncFolder(p);
}

/** Replace `p` so a crash leaves the old content or the new, never a mix. */
export function durableWrite(p: string, data: string | Buffer, opts: { backup?: BackupMode; mode?: number } = {}): void {
  const mode = opts.mode ?? 0o600;
  const backup = opts.backup ?? 'keep';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (backup === 'keep') {
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current) replaceSynced(bakPath(p), current, mode);
  }
  replaceSynced(p, data, mode);
  if (backup === 'scrub') replaceSynced(bakPath(p), data, mode);
}

const DEAD_SUFFIX = '.dead';

function scrubDead(dead: string): void {
  try {
    const size = fs.statSync(dead).size;
    if (size > 0) writeSynced(dead, Buffer.alloc(size), 0o600);
  } catch {
    /* absent, or unwritable: the unlink below is still worth trying */
  }
  try {
    fs.unlinkSync(dead);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Remove a file that held a key: gone in one atomic step, then overwritten.
 *
 * The rename comes first because zeroing in place is not safe. A crash between
 * zeroing and unlinking leaves a file of zeros under the real name, and vault.init
 * restores `.pre-vault` copies by name, so that once read as "put these zeros back
 * over the only copy of your keys". The crash test found it. A file is either
 * whole under its own name or out of the way.
 *
 * Overwriting beats leaving bytes for the next undelete tool, but it cannot reach
 * a shadow copy or a remapped SSD block.
 */
export function overwriteAndRemove(p: string): void {
  const dead = `${p}${DEAD_SUFFIX}`;
  try {
    fs.renameSync(p, dead);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  scrubDead(dead);
}

/** Finish what a crash interrupted. Run at startup. */
export function scrubLeftovers(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(DEAD_SUFFIX)) continue;
    try {
      scrubDead(path.join(dir, n));
    } catch {
      /* it is out of the way either way; the next start tries again */
    }
  }
}

/** The previous generation's text, or null when there is none to read. */
export function readBackup(p: string): string | null {
  try {
    return fs.readFileSync(bakPath(p), 'utf8');
  } catch {
    return null;
  }
}
