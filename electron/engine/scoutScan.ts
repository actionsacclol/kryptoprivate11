// Wallet Scout — the manual scan.
//
// The Scout's record is a by-product of the live decoders: every trade the
// engine (Solana) or an Observatory (EVM) decodes is noted as it passes. That
// makes a fresh install's board empty until the feed has been on for a while,
// and there was nothing to press. This is the thing to press: it reads the
// last N hours of trades from a historical source and feeds them through the
// SAME `note` the live path uses, so a scanned record and a watched record are
// built by one set of rules and land in one book.
//
// Two rules a replay has to keep that the live path gets for free:
//   · oldest-first, always — a sell only scores against a buy already on the
//     book, so a newest-first page fed as it arrived would score nothing;
//   · every trade carries its id, so one the feed already recorded is refused
//     as a duplicate rather than counted twice (see MAX_SEEN_TX in the store).
//
// One job per chain, cancellable between units, spends nothing. The chain
// adapters live in scoutScanSources.ts; this runner takes a source as an
// argument so it can be driven by a fake and tested without a network.

import * as walletScout from './walletScout';
import type { ScoutChain, ScoutScanHours, ScoutScanStatus } from '@shared/walletScout';

export interface ScanTrade {
  address: string;
  /** The Scout's position key — mint on Solana, curve on Robinhood, token on BNB. */
  mint: string;
  isBuy: boolean;
  native: number;
  tokens: number;
  /** When the trade happened, so daily buckets land on the right day. */
  at: number;
  /** See `tradeId` in shared/walletScout. */
  tx: string;
}

/** One unit of work from a source — a token's trades, or a block chunk's. */
export interface ScanBatch {
  /** Any order; the runner sorts by `at` (stably, so log order inside a block survives). */
  trades: ScanTrade[];
  /** Calls spent producing this batch. */
  calls: number;
  /** How many units the source expects to yield in all, as best it knows now. */
  units?: number;
  /** Something the user should know — a chunk that could not be read, a parked provider. */
  note?: string;
}

export interface ScanContext {
  chain: ScoutChain;
  hours: ScoutScanHours;
  /** Trades older than this are out of scope. */
  sinceMs: number;
  now: number;
  cancelled: () => boolean;
}

export type ScanSource = (ctx: ScanContext) => AsyncIterable<ScanBatch>;

const jobs = new Map<ScoutChain, ScoutScanStatus>();
const running = new Map<ScoutChain, Promise<void>>();
const cancels = new Set<ScoutChain>();

function fresh(chain: ScoutChain, hours: ScoutScanHours): ScoutScanStatus {
  return {
    chain,
    running: false,
    startedAt: null,
    finishedAt: null,
    hours,
    units: 0,
    unitsDone: 0,
    read: 0,
    fed: 0,
    duplicates: 0,
    calls: 0,
    trackedBefore: 0,
    trackedAfter: 0,
    cancelled: false,
    message: '',
  };
}

export function status(chain: ScoutChain): ScoutScanStatus {
  return { ...(jobs.get(chain) ?? fresh(chain, 6)) };
}

export function isRunning(chain: ScoutChain): boolean {
  return running.has(chain);
}

/** Ask a running scan to stop after its current unit. Idempotent. */
export function cancel(chain: ScoutChain): boolean {
  if (!running.has(chain)) return false;
  cancels.add(chain);
  return true;
}

/**
 * Start a scan. Returns at once; `wait` resolves when it is done. One per
 * chain — a second request while one runs is refused rather than queued,
 * because two replays of the same hours would only find each other's
 * duplicates.
 */
export function start(chain: ScoutChain, hours: ScoutScanHours, source: ScanSource): { ok: boolean; message: string } {
  if (running.has(chain)) return { ok: false, message: 'A scan is already running on this chain' };
  const st = fresh(chain, hours);
  st.running = true;
  st.startedAt = Date.now();
  st.trackedBefore = walletScout.counts(chain).tracked;
  st.trackedAfter = st.trackedBefore;
  jobs.set(chain, st);
  cancels.delete(chain);
  const p = run(chain, st, source).finally(() => running.delete(chain));
  running.set(chain, p);
  return { ok: true, message: 'started' };
}

/** Resolves when the chain's scan finishes; immediately when none is running. */
export function wait(chain: ScoutChain): Promise<void> {
  return running.get(chain) ?? Promise.resolve();
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

async function run(chain: ScoutChain, st: ScoutScanStatus, source: ScanSource): Promise<void> {
  const now = st.startedAt ?? Date.now();
  const ctx: ScanContext = {
    chain,
    hours: st.hours,
    sinceMs: now - st.hours * 3_600_000,
    now,
    cancelled: () => cancels.has(chain),
  };
  try {
    for await (const batch of source(ctx)) {
      // A source may restate the total as it learns more (an EVM chunk that
      // had to be halved); the latest word is the honest one.
      if (batch.units !== undefined) st.units = batch.units;
      st.calls += batch.calls;
      // The first thing that went wrong is the one worth reading; later
      // notes are almost always the same thing again.
      if (batch.note && !st.message) st.message = batch.note;
      const trades = [...batch.trades].sort((a, b) => a.at - b.at);
      for (const t of trades) {
        st.read += 1;
        const r = walletScout.note(chain, t.address, t.mint, t.isBuy, t.native, t.tokens, t.at, t.tx);
        if (r === 'noted') st.fed += 1;
        else if (r === 'duplicate') st.duplicates += 1;
      }
      st.unitsDone += 1;
      st.trackedAfter = walletScout.counts(chain).tracked;
      if (ctx.cancelled()) {
        st.cancelled = true;
        break;
      }
      // A unit can be thousands of trades; give the main loop a turn between
      // them so the window stays responsive.
      await yieldToLoop();
    }
  } catch (e) {
    st.message = st.message || `Scan stopped — ${(e as Error).message ?? String(e)}`.slice(0, 200);
  } finally {
    st.running = false;
    st.finishedAt = Date.now();
    st.trackedAfter = walletScout.counts(chain).tracked;
    cancels.delete(chain);
    // The store persists on a 30 s debounce after a sell; a scan is one
    // deliberate act and its result should survive a crash a second later.
    walletScout.persist();
  }
}

/** Test seams. */
export const _store = walletScout;
export function _reset(): void {
  jobs.clear();
  running.clear();
  cancels.clear();
}
