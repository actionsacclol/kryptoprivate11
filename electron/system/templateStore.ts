// Where auto-sell templates live.
//
// Its own file rather than a corner of settings.json, for the same reason
// orders and alerts have their own: this is a list the user edits, it grows,
// and a parse failure here must not take the whole settings file with it.
//
// The built-in templates are not stored — they are code, they cannot be
// corrupted, and a user editing one saves a copy under a new id. A file that
// cannot be read leaves the built-ins working and refuses to overwrite
// itself, which is the same rule the wallet store follows.

import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_TEMPLATES, MAX_TEMPLATES, validateTemplate, type OrderTemplate } from '@shared/orderTemplates';
import { logger } from './logger';

const FILE = 'order-templates.json';

interface StoreFile {
  version: 1;
  templates: OrderTemplate[];
  /** Which template arms on a manual buy; null = none, and nothing is armed. */
  activeId: string | null;
}

let filePath = '';
let cache: StoreFile | null = null;
let loadFailure: string | null = null;

const empty = (): StoreFile => ({ version: 1, templates: [], activeId: null });

function parse(raw: unknown): StoreFile | null {
  const o = raw as Partial<StoreFile>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.templates)) return null;
  const templates = o.templates
    .filter((t): t is OrderTemplate => !!t && typeof (t as OrderTemplate).id === 'string')
    // A template the current version cannot honour is dropped rather than
    // half-armed later.
    .filter((t) => validateTemplate(t).ok)
    .slice(0, MAX_TEMPLATES);
  // Auto-sell is OFF unless the file names a template that SURVIVED the
  // filtering above. A stored id whose template was dropped — invalid after
  // a version change, or sliced off past MAX_TEMPLATES — is healed to null
  // here rather than left dangling. `active()` already refuses to arm a
  // ghost, so this is not a behaviour fix; it is so the stored state, the
  // dropdown and the engine agree on "off" instead of disagreeing quietly.
  // Same rule the EVM wallet store applies to its own dangling activeId.
  const wanted = typeof o.activeId === 'string' ? o.activeId : null;
  const armed =
    wanted !== null && (templates.some((t) => t.id === wanted) || BUILT_IN_TEMPLATES.some((t) => t.id === wanted))
      ? wanted
      : null;
  return { version: 1, templates, activeId: armed };
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      logger.error(`order templates: ${loadFailure} — built-ins still work, and the file will not be overwritten`);
    }
    cache = empty();
    return;
  }
  // JSON.parse belongs INSIDE a try. `init` runs during bootstrap, before the
  // window exists and under a `whenReady().then()` with no catch — so a
  // SyntaxError here does not degrade the feature, it kills the app before it
  // can show anything, on every launch, and a user holding a live position
  // cannot open the app to sell. Unreadable and unparseable are the same
  // event: we could not load it, so we fail closed and never overwrite it.
  let raw: unknown;
  try {
    raw = JSON.parse(text || '{}');
  } catch (e) {
    loadFailure = `${filePath} is not valid JSON (${(e as Error).message})`;
    logger.error(`order templates: ${loadFailure} — built-ins still work, and the file will not be overwritten`);
    cache = empty();
    return;
  }
  const parsed = parse(raw);
  if (!parsed) {
    loadFailure = `${filePath} is not a template file this version understands`;
    logger.error(`order templates: ${loadFailure} — built-ins still work, and the file will not be overwritten`);
    cache = empty();
    return;
  }
  cache = parsed;
}

function persist(): void {
  if (!filePath || !cache) return;
  if (loadFailure) {
    logger.warn(`order templates: not saving — ${loadFailure}`);
    return;
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    logger.warn(`order templates: could not save (${(e as Error).message})`);
  }
}

/** Built-ins first, then the user's own. */
export function list(): OrderTemplate[] {
  return [...BUILT_IN_TEMPLATES, ...(cache?.templates ?? [])];
}

export function activeId(): string | null {
  return cache?.activeId ?? null;
}

/** The template that arms on a buy, or null when the feature is off. */
export function active(): OrderTemplate | null {
  const id = activeId();
  if (!id) return null;
  return list().find((t) => t.id === id) ?? null;
}

export function setActive(id: string | null): { ok: boolean; message: string } {
  if (!cache) return { ok: false, message: 'Templates are not loaded' };
  if (id !== null && !list().some((t) => t.id === id)) return { ok: false, message: 'No such template' };
  cache.activeId = id;
  persist();
  const t = active();
  return { ok: true, message: id === null ? 'Auto-sell is off' : `“${t?.name}” will arm on every manual buy` };
}

export function upsert(t: OrderTemplate): { ok: boolean; message: string } {
  if (!cache) return { ok: false, message: 'Templates are not loaded' };
  const v = validateTemplate(t);
  if (!v.ok) return { ok: false, message: v.message };
  // A built-in is code: editing one saves a copy the user owns.
  const id = t.id.startsWith('builtin-') ? `t_${Date.now().toString(36)}` : t.id;
  const next = { ...t, id };
  const i = cache.templates.findIndex((x) => x.id === id);
  if (i >= 0) cache.templates[i] = next;
  else {
    if (cache.templates.length >= MAX_TEMPLATES) return { ok: false, message: `At most ${MAX_TEMPLATES} templates` };
    cache.templates.push(next);
  }
  // Editing a built-in into a copy carries the "active" flag with it, so the
  // user's edit takes effect rather than silently leaving the original armed.
  if (t.id.startsWith('builtin-') && cache.activeId === t.id) cache.activeId = id;
  persist();
  return { ok: true, message: `Saved “${next.name}”` };
}

export function remove(id: string): { ok: boolean; message: string } {
  if (!cache) return { ok: false, message: 'Templates are not loaded' };
  if (id.startsWith('builtin-')) return { ok: false, message: 'The built-in templates cannot be deleted' };
  const before = cache.templates.length;
  cache.templates = cache.templates.filter((t) => t.id !== id);
  if (cache.templates.length === before) return { ok: false, message: 'No such template' };
  if (cache.activeId === id) cache.activeId = null;
  persist();
  return { ok: true, message: 'Template deleted' };
}

/** Why templates are read-only right now, or null. */
export function failure(): string | null {
  return loadFailure;
}
