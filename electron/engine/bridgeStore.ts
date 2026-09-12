// Transfers that have left one chain and not arrived on the other.
//
// The money is in neither wallet while this record exists, which makes losing
// the record the worst failure this feature has: the user would see funds gone
// from one side, nothing on the other, and no trace of a transfer to chase.
//
// So it is written the moment the source transaction is BROADCAST — not when
// it confirms, and not when it settles. That ordering is the whole point, and
// it is the lesson from evm/scanner.ts, fixed earlier on 2026-09-11: pendings
// there were persisted only when the model changed, six hours away, so a
// restart inside the window lost everything. The fix was to write on entry.
// Same shape here, higher stakes.
//
// ─── Fail closed, and say so ─────────────────────────────────────────────
//
// An unreadable file is NOT an empty one. If this file cannot be parsed, the
// store refuses every write for the session, keeps the file untouched, and
// reports a failure the UI must render as "could not read your in-flight
// transfers" — never as "none in flight". The difference between those two
// sentences is a user who chases their money and a user who does not.
//
// ─── The chain is the source of truth ────────────────────────────────────
//
// PHASE2.md: "After a crash, the chain, not local storage, is the source of
// truth." These records are a list of things to ASK about. The answer comes
// from the transaction hash; LI.FI's status is corroboration, never the
// record.

import fs from 'node:fs';
import path from 'node:path';
import { isInFlight, type BridgeStatus, type InFlight } from '@shared/bridge';
import { logger } from '../system/logger';

const FILE = 'bridge-inflight.json';

/**
 * Kept forever until terminal, then aged out.
 *
 * A transfer that arrived is history; one that is still unknown after this
 * long is almost certainly never going to be answered by the aggregator, but
 * it is NOT deleted — it is the only record the user has that they sent it.
 */
const KEEP_TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;

let filePath = '';
let cache: InFlight[] = [];
let loadFailure: string | null = null;

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  cache = [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      logger.error(`bridge: ${loadFailure}`);
    }
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    loadFailure = `${filePath} is not valid JSON (${(e as Error).message})`;
    logger.error(`bridge: ${loadFailure}`);
    return;
  }
  const rows = (raw as { transfers?: unknown })?.transfers;
  if (!Array.isArray(rows)) {
    loadFailure = `${filePath} is not a bridge record this version understands`;
    logger.error(`bridge: ${loadFailure}`);
    return;
  }
  for (const r of rows as Array<Partial<InFlight>>) {
    if (typeof r?.id !== 'string' || typeof r.txHash !== 'string' || typeof r.startedAt !== 'number') continue;
    if (r.from !== 'solana' && r.from !== 'robinhood' && r.from !== 'bnb') continue;
    if (r.to !== 'solana' && r.to !== 'robinhood' && r.to !== 'bnb') continue;
    cache.push({
      id: r.id,
      from: r.from,
      to: r.to,
      txHash: r.txHash,
      fromAmountRaw: typeof r.fromAmountRaw === 'string' ? r.fromAmountRaw : '0',
      toAmountMinRaw: typeof r.toAmountMinRaw === 'string' ? r.toAmountMinRaw : '0',
      toDecimals: typeof r.toDecimals === 'number' ? r.toDecimals : 18,
      tool: typeof r.tool === 'string' ? r.tool : 'unknown',
      startedAt: r.startedAt,
      // A record restored from disk starts UNKNOWN unless it was terminal.
      // Whatever it said last session is not evidence about now, and
      // "pending" would claim knowledge this process does not have.
      status: terminal(r.status) ? (r.status as BridgeStatus) : 'unknown',
      deliveredRaw: typeof r.deliveredRaw === 'string' ? r.deliveredRaw : null,
      note: typeof r.note === 'string' ? r.note : null,
    });
  }
  const live = cache.filter((t) => isInFlight(t.status)).length;
  if (live) logger.info(`bridge: ${live} transfer(s) still in flight, restored — their outcome is re-read from the chain`);
}

const terminal = (s: unknown): boolean => s === 'done' || s === 'partial' || s === 'refunded' || s === 'failed';

/** Why this store is read-only this session, or null. */
export function failure(): string | null {
  return loadFailure;
}

/** Everything we know about, newest first. */
export function all(): InFlight[] {
  return [...cache].sort((a, b) => b.startedAt - a.startedAt);
}

/** The ones whose money is still somewhere in between. */
export function pending(): InFlight[] {
  return all().filter((t) => isInFlight(t.status));
}

function persist(): boolean {
  // A file we could not read is one we must not overwrite: it is the only
  // record of money that has left a wallet.
  if (!filePath || loadFailure) return false;
  const keep = cache
    .filter((t) => isInFlight(t.status) || Date.now() - t.startedAt < KEEP_TERMINAL_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_RECORDS);
  cache = keep;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, transfers: keep }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    logger.error(`bridge: could not save the in-flight record — ${(e as Error).message}`);
    return false;
  }
}

/**
 * Record a transfer the moment it is broadcast.
 *
 * Throws if the store is read-only, and the caller must check BEFORE sending:
 * broadcasting money we cannot write down is the one ordering this feature
 * must never have.
 */
export function record(t: InFlight): void {
  if (loadFailure) throw new Error(`Bridge record is read-only this session: ${loadFailure}`);
  const before = cache;
  cache = [t, ...cache.filter((x) => x.id !== t.id)];
  // A write that FAILS is the same refusal as a file that could not be read:
  // `record` runs from inside the send, before the bytes go out, and a throw
  // here is what stops them. Until 2026-09-11 a full disk was logged and the
  // money left with an in-memory record that a restart would forget. And the
  // row comes OUT of memory again on the way, or the page would show "On its
  // way" for money that never left and the next successful write would put
  // the phantom on disk (found by the same day's Solana audit).
  if (!persist()) {
    cache = before;
    throw new Error('Bridge record could not be written to disk');
  }
}

/** Update what we have learned about a transfer. */
export function update(id: string, patch: Partial<Pick<InFlight, 'status' | 'deliveredRaw' | 'note'>>): void {
  if (loadFailure) return;
  const i = cache.findIndex((t) => t.id === id);
  if (i < 0) return;
  cache[i] = { ...cache[i]!, ...patch };
  persist();
}

/** Test seam. */
export function _reset(): void {
  cache = [];
  loadFailure = null;
  filePath = '';
}
