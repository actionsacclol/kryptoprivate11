// The Send address book + send history on disk (2026-10-03). See
// shared/sendBook.ts for what it is for. Fail-closed like every record here:
// a file that cannot be read is not empty — nothing is written over it, and
// the page says so.

import fs from 'node:fs';
import path from 'node:path';
import { MAX_CONTACTS, MAX_HISTORY, parseSendBook, type SendBook, type SendContact, type SendHistoryRow } from '@shared/sendBook';
import { logger } from './logger';

const FILE = 'send-book.json';

let filePath = '';
let cache: SendBook = { contacts: [], history: [] };
let loadFailure: string | null = null;

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  cache = { contacts: [], history: [] };
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      logger.error(`send book: ${loadFailure}`);
    }
    return;
  }
  let parsed: SendBook | null = null;
  try {
    parsed = parseSendBook(JSON.parse(text));
  } catch (e) {
    loadFailure = `${filePath} is not valid JSON (${(e as Error).message})`;
  }
  if (!parsed) {
    loadFailure = loadFailure ?? `${filePath} is not an address book this version understands`;
    logger.error(`send book: ${loadFailure}`);
    return;
  }
  cache = parsed;
}

export function failure(): string | null {
  return loadFailure;
}

export function book(): SendBook {
  return { contacts: [...cache.contacts], history: [...cache.history] };
}

function persist(next: SendBook): { ok: boolean; message: string } {
  if (!filePath) return { ok: false, message: 'Address book not ready' };
  if (loadFailure) return { ok: false, message: `The address book could not be read, so it is not overwritten: ${loadFailure}` };
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...next }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    cache = next;
    return { ok: true, message: 'saved' };
  } catch (e) {
    return { ok: false, message: `Not saved: ${(e as Error).message}` };
  }
}

/** Save (or rename) a contact; one entry per address. */
export function saveContact(c: Omit<SendContact, 'id' | 'addedAt'>): { ok: boolean; message: string } {
  const same = (x: SendContact): boolean =>
    x.family === c.family && (c.family === 'evm' ? x.address.toLowerCase() === c.address.toLowerCase() : x.address === c.address);
  const existing = cache.contacts.find(same);
  const row: SendContact = existing
    ? { ...existing, label: c.label }
    : { id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, label: c.label, family: c.family, address: c.address, addedAt: Date.now() };
  const contacts = [row, ...cache.contacts.filter((x) => !same(x))].slice(0, MAX_CONTACTS);
  return persist({ ...cache, contacts });
}

export function removeContact(id: string): { ok: boolean; message: string } {
  return persist({ ...cache, contacts: cache.contacts.filter((c) => c.id !== id) });
}

/** One send, newest first. Informational — the chain is the record of money. */
export function noteSend(row: SendHistoryRow): void {
  const r = persist({ ...cache, history: [row, ...cache.history].slice(0, MAX_HISTORY) });
  if (!r.ok) logger.warn(`send book: history not saved — ${r.message}`);
}
