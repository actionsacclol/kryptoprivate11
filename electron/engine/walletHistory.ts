// Wallet history — a Solana wallet's recent swaps, read straight from the
// chain into the Scout's record, for an address the feed has never seen.
//
// The Scout learns wallets from the pump curve firehose and from the manual
// scan, and the scan reads swap-api.pump.fun's per-TOKEN pages. Neither can
// answer "what did THIS wallet do?" for an address a user pastes in cold:
// pump's API has no per-wallet route (both candidates 404, 2026-09-11), and
// its per-token route is paced at one request every 2 s by a Cloudflare rule
// (measured 2026-09-21). The chain can. `getSignaturesForAddress` lists what
// a wallet signed, `getTransaction` reads each one, and walletSwap.ts decodes
// the swap from the wallet's own balance deltas — the same decoder the copier
// trusts for a followed wallet, so a trade read here and a trade watched live
// are the same trade by the same rules.
//
// What it fills in, and what it cannot. The wallet's OWN record — trips,
// profit, win rate, median hold, the too-fast flag: "what they did". The Copy
// score needs OTHER wallets' prints on those coins to place a follower's
// fills, which only the live feed and the scan supply; this read leaves it
// unmeasured rather than invented, and the drawer says so.
//
// Bounded: at most WALLET_READ_LIMIT signatures, nothing older than
// READ_MAX_AGE_MS (the Scout keeps a week, so older trades fall outside every
// window), read in batches of BATCH through rpcClient's per-method budget —
// four a second on a public endpoint, so 200 signatures is under a minute.
// Oldest first, always: a sell only scores against a buy already on the
// book. Every trade carries its signature as its id, so a second read, or the
// live feed having already seen the trade, is a duplicate and never a double
// count. One job per wallet; spends nothing.

import { getSignaturesForAddress, getTransactions } from '../chain/rpcClient';
import { decodeWalletSwap } from './walletSwap';
import * as walletScout from './walletScout';
import { WALLET_READ_LIMIT, tradeId, type WalletReadStatus } from '@shared/walletScout';

export const READ_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Transactions per `getTransactions` batch. Helius counts each element
 *  against its cap and rpcClient budgets the batch at its real cost. */
const BATCH = 10;
/** A wallet needs this many trades before the store keeps a record of it
 *  (walletScout PROMOTE_AFTER). Stated here so the status can say why a
 *  quiet wallet still shows nothing after a read. */
const PROMOTE_AFTER = 3;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const jobs = new Map<string, WalletReadStatus>();
const running = new Map<string, Promise<void>>();
const cancels = new Set<string>();

/** Where this module's lines go — see the note in scoutScan.ts. */
type Log = (level: 'info' | 'warn' | 'error', line: string) => void;
let log: Log = () => {};
export function attachLog(fn: Log): void {
  log = fn;
}

function fresh(address: string): WalletReadStatus {
  return {
    chain: 'solana',
    address,
    running: false,
    startedAt: null,
    finishedAt: null,
    signatures: 0,
    read: 0,
    swaps: 0,
    fed: 0,
    duplicates: 0,
    unreadable: 0,
    notSwap: 0,
    calls: 0,
    cancelled: false,
    message: '',
    oldestAt: null,
    newestAt: null,
  };
}

export function status(address: string): WalletReadStatus {
  return { ...(jobs.get(address) ?? fresh(address)) };
}

export function isRunning(address: string): boolean {
  return running.has(address);
}

/** Ask a running read to stop after its current batch. Idempotent. */
export function cancel(address: string): boolean {
  if (!running.has(address)) return false;
  cancels.add(address);
  return true;
}

/**
 * Start a read. Returns at once; `wait` resolves when it is done. One per
 * wallet — a second request while one runs is refused, not queued.
 */
export function start(address: string, httpUrl: string, now = Date.now()): { ok: boolean; message: string } {
  if (!BASE58.test(address)) return { ok: false, message: 'Not a Solana wallet address' };
  if (!httpUrl) return { ok: false, message: 'No Solana RPC endpoint is configured' };
  if (running.has(address)) return { ok: false, message: 'Already reading this wallet' };
  const st = fresh(address);
  st.running = true;
  st.startedAt = now;
  jobs.set(address, st);
  cancels.delete(address);
  log('info', `wallet read ${address.slice(0, 6)}…: asking the chain for its last ${WALLET_READ_LIMIT} transactions`);
  const p = run(address, httpUrl, st, now).finally(() => running.delete(address));
  running.set(address, p);
  return { ok: true, message: 'started' };
}

/** Resolves when the wallet's read finishes; immediately when none is running. */
export function wait(address: string): Promise<void> {
  return running.get(address) ?? Promise.resolve();
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

async function run(address: string, httpUrl: string, st: WalletReadStatus, now: number): Promise<void> {
  try {
    const listed = await getSignaturesForAddress(httpUrl, address, WALLET_READ_LIMIT);
    st.calls += 1;
    if (!listed.ok || !listed.data) {
      st.message = `Could not list the wallet's transactions — ${listed.message}`;
      return;
    }
    const floor = now - READ_MAX_AGE_MS;
    // Failed transactions are nothing; anything older than the window is
    // outside every Scout window and not worth a read. The RPC lists newest
    // first; the book must be fed oldest first.
    const wanted = listed.data.filter((x) => !x.err && (typeof x.blockTime !== 'number' || x.blockTime * 1_000 >= floor)).reverse();
    st.signatures = wanted.length;
    if (!wanted.length) {
      st.message = listed.data.length ? 'Nothing in the last week — every transaction listed is older, or failed.' : 'No transactions on record for this wallet.';
      return;
    }
    for (let i = 0; i < wanted.length; i += BATCH) {
      if (cancels.has(address)) {
        st.cancelled = true;
        break;
      }
      const slice = wanted.slice(i, i + BATCH);
      const res = await getTransactions(
        httpUrl,
        slice.map((x) => x.signature),
      );
      st.calls += 1;
      st.read += slice.length;
      if (!res.ok || !res.data) {
        // The whole batch is lost, said once, and the read goes on: a parked
        // endpoint should cost a batch, not the wallet.
        st.unreadable += slice.length;
        if (!st.message) st.message = `Some transactions could not be read — ${res.message}`;
        await yieldToLoop();
        continue;
      }
      for (let j = 0; j < slice.length; j++) {
        const tx = res.data[j];
        if (!tx) {
          st.unreadable += 1;
          continue;
        }
        const swap = decodeWalletSwap(tx, address);
        if (!swap) {
          st.notSwap += 1;
          continue;
        }
        st.swaps += 1;
        // When they traded, from the block — the listing's time when the
        // transaction lost its own, the read's clock only as a last resort.
        const blockTime = typeof tx.blockTime === 'number' && tx.blockTime > 0 ? tx.blockTime : slice[j].blockTime;
        const at = typeof blockTime === 'number' && blockTime > 0 ? blockTime * 1_000 : now;
        st.oldestAt = st.oldestAt === null ? at : Math.min(st.oldestAt, at);
        st.newestAt = st.newestAt === null ? at : Math.max(st.newestAt, at);
        const r = walletScout.note('solana', address, swap.mint, swap.isBuy, swap.sol, swap.tokens, at, tradeId(slice[j].signature, swap.mint, address, swap.isBuy));
        if (r === 'noted') st.fed += 1;
        else if (r === 'duplicate') st.duplicates += 1;
      }
      await yieldToLoop();
    }
    if (!st.message && st.swaps > 0 && st.swaps < PROMOTE_AFTER) {
      st.message = `Only ${st.swaps} swap${st.swaps === 1 ? '' : 's'} in the last week — a wallet needs ${PROMOTE_AFTER} before it gets a record.`;
    } else if (!st.message && st.swaps === 0) {
      st.message = 'No swaps in the last week — transfers, claims and mints are not trades.';
    }
  } catch (e) {
    st.message = st.message || `Read stopped — ${(e as Error).message ?? String(e)}`.slice(0, 200);
  } finally {
    st.running = false;
    st.finishedAt = Date.now();
    cancels.delete(address);
    log(
      st.message ? 'warn' : 'info',
      `wallet read ${address.slice(0, 6)}…: ${st.cancelled ? 'cancelled' : 'done'} — ${st.read}/${st.signatures} read, ${st.swaps} swap(s), ${st.fed} new, ${st.duplicates} known, ${st.notSwap} not trades, ${st.unreadable} unreadable, ${st.calls} call(s)${st.message ? ` · ${st.message}` : ''}`,
    );
    // A read is one deliberate act; its result should survive a crash a
    // second later (the store otherwise persists on a debounce).
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
