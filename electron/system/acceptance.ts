// Clickwrap acceptance record.
//
// ─── The honest limitation, stated first ──────────────────────────────
//
// legalcheck.md says: "localStorage alone proves nothing… log it SERVER-SIDE."
// That is right, and this product has no server. Krypto Bot is downloadable
// software with no backend and no account, so there is nothing to POST to.
//
// What this does instead is the strongest record available locally, and it is
// deliberately better than a version string in a settings file:
//
//   • Append-only JSONL. Accepting again adds a row; nothing is overwritten,
//     so the history of what was accepted and when survives.
//   • Each row stores a SHA-256 of the FULL TEXT of every document accepted.
//     A version string proves a label was clicked; a hash proves which exact
//     words were on screen. If a document changes, old rows still pin the old
//     text.
//   • No IP address is recorded, in any form. Not hashed, not salted — the app
//     genuinely does not know it, and inventing a lookup to obtain one would
//     create the exact data legalcheck.md warns against storing.
//
// A local record is evidence the user could in principle alter. Where a
// server-side row is needed, it belongs to the DOWNLOAD flow on krypt.cc, which
// is a different codebase — see TOOLS_LEGAL_GUIDE.md there. This file is what
// binds someone who already has the binary.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AcceptedDocument {
  id: string;
  /** SHA-256 of the document's full text, as shown to the user. */
  sha256: string;
}

export interface AcceptanceRecord {
  /** Random per-row id, so rows can be referred to individually. */
  id: string;
  product: string;
  termsVersion: string;
  /** ISO 8601, UTC. */
  acceptedAt: string;
  appVersion: string;
  platform: string;
  /** The user's locale, which is the closest thing to a country we hold and is
   *  not personal data on its own. */
  locale: string;
  documents: AcceptedDocument[];
}

let file = '';

export function init(userDataDir: string, fileName: string): void {
  file = path.join(userDataDir, fileName);
}

export function logPath(): string {
  return file;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Pure helpers (tested offline) ────────────────────────────────────

/** Parse the append-only log, skipping unparseable rows rather than throwing.
 *  A corrupted row must not destroy the evidence of every other acceptance. */
export function parseLog(text: string): AcceptanceRecord[] {
  const out: AcceptanceRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as AcceptanceRecord;
      if (row && typeof row.termsVersion === 'string' && typeof row.acceptedAt === 'string') out.push(row);
    } catch {
      /* a torn write at the end of the file is expected; keep the rest */
    }
  }
  return out;
}

/** True when this exact version has been accepted at some point. */
export function hasAccepted(rows: AcceptanceRecord[], version: string): boolean {
  return rows.some((r) => r.termsVersion === version);
}

/** The most recent acceptance of any version, or null. */
export function latest(rows: AcceptanceRecord[]): AcceptanceRecord | null {
  let best: AcceptanceRecord | null = null;
  for (const r of rows) {
    const at = Date.parse(r.acceptedAt);
    if (!Number.isFinite(at)) continue;
    if (!best || at > Date.parse(best.acceptedAt)) best = r;
  }
  return best;
}

/** Rows past the retention period. legalcheck.md: a retention promise with no
 *  code behind it is worse than no promise, so this is what enforces it. */
export function expiredRows(rows: AcceptanceRecord[], now: number, retentionDays: number): AcceptanceRecord[] {
  const cutoff = now - retentionDays * 86_400_000;
  return rows.filter((r) => {
    const at = Date.parse(r.acceptedAt);
    return Number.isFinite(at) && at < cutoff;
  });
}

// ─── I/O ──────────────────────────────────────────────────────────────

export function all(): AcceptanceRecord[] {
  if (!file) return [];
  try {
    return parseLog(fs.readFileSync(file, 'utf8'));
  } catch {
    return []; // no file yet is the normal first run
  }
}

/**
 * Append one acceptance.
 *
 * Never throws and never reports failure upward: legalcheck.md is explicit that
 * "failing to log must never block the user's action". A user who cannot write
 * to their own profile still gets to use the software they just agreed to.
 */
export function append(row: AcceptanceRecord): boolean {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function newRecord(input: {
  product: string;
  termsVersion: string;
  appVersion: string;
  platform: string;
  locale: string;
  documents: AcceptedDocument[];
  now?: number;
}): AcceptanceRecord {
  return {
    id: crypto.randomUUID(),
    product: input.product,
    termsVersion: input.termsVersion,
    acceptedAt: new Date(input.now ?? Date.now()).toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    locale: input.locale,
    documents: input.documents,
  };
}

/** Drop rows past retention. Rewrites the file only when something goes. */
export function purge(now: number, retentionDays: number): number {
  if (!file) return 0;
  const rows = all();
  if (!rows.length) return 0;
  const expired = expiredRows(rows, now, retentionDays);
  if (!expired.length) return 0;
  const keep = rows.filter((r) => !expired.includes(r));
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);
    return expired.length;
  } catch {
    return 0;
  }
}
