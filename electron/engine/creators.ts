// Creator reputation database — research §4 / §14: locally built from
// observed launches, persisted in userData. This is deliberately simple in
// v1 (counts, not graphs) but it already answers the two questions that
// matter most: "have we seen this creator before?" and "do they dump?"

import fs from 'node:fs';
import path from 'node:path';

export interface CreatorRecord {
  launches: number;
  /** Launches where the creator sold during the evaluation window. */
  dumps: number;
  /** Launches that reached curve completion while we watched. */
  completions: number;
  lastSeen: number;
}

interface CreatorDb {
  version: 1;
  creators: Record<string, CreatorRecord>;
  blacklist: string[];
}

const EMPTY: CreatorDb = { version: 1, creators: {}, blacklist: [] };

let db: CreatorDb = EMPTY;
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, 'creators.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CreatorDb>;
    db = {
      version: 1,
      creators: raw.creators ?? {},
      blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
    };
  } catch {
    db = { version: 1, creators: {}, blacklist: [] };
  }
}

/** Writes are chained so two never interleave; each is async — this file
 *  used to be pretty-printed and written SYNCHRONOUSLY every 2 s while
 *  scanning (recordLaunch fires per launch), on the same thread that decodes
 *  the feed and answers a trade IPC. flush() at quit stays synchronous. */
let writing: Promise<void> = Promise.resolve();
const SAVE_DEBOUNCE_MS = 10_000;

function scheduleSave(): void {
  if (!filePath || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = JSON.stringify(db);
    const target = filePath;
    writing = writing.then(async () => {
      try {
        // Atomic write: tmp file then rename (guidelines §5.9).
        const tmp = `${target}.tmp`;
        await fs.promises.writeFile(tmp, payload, 'utf8');
        await fs.promises.rename(tmp, target);
      } catch {
        /* persistence is best-effort; in-memory state remains correct */
      }
    });
  }, SAVE_DEBOUNCE_MS);
}

export function get(creator: string): CreatorRecord {
  return db.creators[creator] ?? { launches: 0, dumps: 0, completions: 0, lastSeen: 0 };
}

export function recordLaunch(creator: string): void {
  const rec = get(creator);
  db.creators[creator] = { ...rec, launches: rec.launches + 1, lastSeen: Date.now() };
  scheduleSave();
}

export function recordDump(creator: string): void {
  const rec = get(creator);
  db.creators[creator] = { ...rec, dumps: rec.dumps + 1, lastSeen: Date.now() };
  scheduleSave();
}

export function recordCompletion(creator: string): void {
  const rec = get(creator);
  db.creators[creator] = { ...rec, completions: rec.completions + 1, lastSeen: Date.now() };
  scheduleSave();
}

export function blacklist(): Set<string> {
  return new Set(db.blacklist);
}

/**
 * Seed the blacklist from a bundled/imported list (research action #9).
 * Sources like ScamSniffer's free drainer list or the RED-COHORT sniper-ring
 * catalogue are ingested as RISK FLAGS — merged, deduped, never overwriting
 * user entries. Per the RED-COHORT authors' selection-bias caveat these are
 * risk signals, not proof; the scorer treats them as penalties.
 */
export function seedBlacklist(addresses: string[]): number {
  let added = 0;
  const have = new Set(db.blacklist);
  for (const a of addresses) {
    if (typeof a === 'string' && a.length >= 32 && !have.has(a)) {
      db.blacklist.push(a);
      have.add(a);
      added++;
    }
  }
  if (added > 0) scheduleSave();
  return added;
}

export function blacklistSize(): number {
  return db.blacklist.length;
}

export function addToBlacklist(creator: string): void {
  if (!db.blacklist.includes(creator)) {
    db.blacklist.push(creator);
    scheduleSave();
  }
}

export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!filePath) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* best-effort */
  }
}
