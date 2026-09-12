// EVM fill ledger — cost basis from the chain, never from what was
// requested (the same rule as engine/ledger.ts), for every EVM chain.
//
// Each fill is reconciled against its receipt: the wallet's native balance
// at the receipt's block minus the block before (gas, fee and refund all
// included), and the token delta from the receipt's own Transfer logs. A
// fill that cannot be read is `unreconciled` and excluded from the basis —
// the portfolio says how many rows it could not read instead of averaging
// over a hole. Fills carry their chain; rows written before BNB existed are
// Robinhood's.

import fs from 'node:fs';
import path from 'node:path';
import type { Address, Hex } from 'viem';
import { isPrunedStateError, isRpcRefusal, receiptClient, stateClient } from './client';
import { TOPIC } from './chain';
import { logger } from '../system/logger';
import type { EvmChainKind, EvmFill, EvmVenue } from '@shared/evm';

const FILE = 'evm-fills.json';
const MAX_FILLS = 8_000;
const RECONCILE_ATTEMPTS = 5;
const MAX_ROUNDS = 6;
let reconcileDelayMs = 700;

interface LedgerFile {
  version: 2;
  fills: EvmFill[];
  /** Tokens the user asked to keep an eye on, per `${chain}:${wallet}`. */
  tracked: Record<string, string[]>;
}

let state: LedgerFile = { version: 2, fills: [], tracked: {} };
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when the file exists but could not be read: the ledger then serves
 *  nothing and REFUSES to write, so a locked or half-written file is never
 *  replaced by an empty one (every cost basis lives in it). */
let loadFailed: string | null = null;
let refusalLogged = false;
const listeners = new Set<(fill: EvmFill) => void>();

export function loadFailure(): string | null {
  return loadFailed;
}

export function onSettled(fn: (fill: EvmFill) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function settled(fill: EvmFill): void {
  for (const fn of listeners) {
    try {
      fn({ ...fill });
    } catch {
      /* a listener must never break the ledger */
    }
  }
}

/** Rows from the 2026-09-08 file: no chain, `ethDeltaWei`. */
function upgrade(raw: Record<string, unknown>): EvmFill {
  const f = raw as unknown as EvmFill & { ethDeltaWei?: string | null };
  const chain: EvmChainKind = f.chain === 'bnb' ? 'bnb' : 'robinhood';
  return {
    ...f,
    chain,
    nativeDeltaWei: f.nativeDeltaWei ?? f.ethDeltaWei ?? null,
  };
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  state = { version: 2, fills: [], tracked: {} };
  loadFailed = null;
  refusalLogged = false;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    // Absent is a first run. Anything else (locked, EACCES, a half-written
    // file) is NOT "no fills": fail closed, keep the file as it is.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    loadFailed = `${filePath} could not be read (${(e as Error).message})`;
    logger.error(`evm ledger: ${loadFailed} — cost basis unavailable and the file will not be overwritten this session`);
    return;
  }
  try {
    const raw = JSON.parse(text) as Partial<LedgerFile> & { version?: number };
    const fills = Array.isArray(raw?.fills) ? (raw.fills as unknown[]).filter((x) => x && typeof x === 'object').map((x) => upgrade(x as Record<string, unknown>)) : [];
    let tracked: Record<string, string[]> = {};
    if (raw?.tracked && typeof raw.tracked === 'object') {
      // v1 keyed tracked lists by wallet only; they were Robinhood's.
      for (const [k, v] of Object.entries(raw.tracked)) tracked[k.includes(':') ? k : `robinhood:${k}`] = Array.isArray(v) ? v : [];
    }
    state = { version: 2, fills, tracked };
  } catch (e) {
    loadFailed = `${filePath} is corrupt (${(e as Error).message})`;
    logger.error(`evm ledger: ${loadFailed} — cost basis unavailable and the file will not be overwritten this session`);
  }
}

function writeNow(): void {
  if (!filePath) return;
  if (loadFailed) {
    if (!refusalLogged) {
      refusalLogged = true;
      logger.warn(`evm ledger: not saving — ${loadFailed}`);
    }
    return;
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* memory stays authoritative this session */
  }
}

function persist(): void {
  if (!filePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 250);
}

/** Write a pending debounced save NOW — for before-quit, so a fill recorded
 *  in the last quarter second still reaches disk. */
export function flushSync(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}

let seq = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How many fills this session could not be priced from a balance diff. The
 * whole point of routing state reads to an archival endpoint is that this stays
 * at zero; if it climbs, the endpoint choice in chains.ts is wrong and the
 * evidence is here rather than in a shrug.
 */
let pricingFallbacks = 0;
export function statePricingFallbacks(): number {
  return pricingFallbacks;
}

export function recordFill(input: {
  chain: EvmChainKind;
  token: string;
  symbol: string;
  side: 'buy' | 'sell';
  hash: Hex;
  requested: number;
  decimals: number | null;
  wallet: Address;
  venue: EvmVenue;
  feeWei: bigint | null;
}): EvmFill {
  // Idempotent on the hash: the trade path records a fill the moment it is
  // broadcast (so a crash before the receipt cannot lose it) and again once
  // the receipt is in hand, with the fee it learned. One row, updated.
  const h = input.hash.toLowerCase();
  const existing = state.fills.find((f) => f.hash.toLowerCase() === h);
  if (existing) {
    if (input.feeWei !== null) existing.feeWei = input.feeWei.toString();
    if (!existing.symbol && input.symbol) existing.symbol = input.symbol;
    if (!existing.venue && input.venue) existing.venue = input.venue;
    persist();
    return existing;
  }
  const fill: EvmFill = {
    id: `ef_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    chain: input.chain,
    token: input.token.toLowerCase(),
    symbol: input.symbol,
    side: input.side,
    at: Date.now(),
    hash: input.hash,
    requested: input.requested,
    nativeDeltaWei: null,
    tokenDeltaRaw: null,
    decimals: input.decimals,
    gasWei: null,
    feeWei: input.feeWei === null ? null : input.feeWei.toString(),
    state: 'pending',
    note: null,
    wallet: input.wallet.toLowerCase(),
    venue: input.venue,
    attempts: 0,
  };
  state.fills.push(fill);
  if (state.fills.length > MAX_FILLS) state.fills = state.fills.slice(-MAX_FILLS);
  persist();
  void reconcile(fill);
  return fill;
}

/** Read the receipt and the balance diff. Retries a few times: the receipt
 *  is usually there within a block or two. */
export async function reconcile(fill: EvmFill): Promise<void> {
  // The receipt and the state around it are DIFFERENT capabilities and, on BNB,
  // different endpoints. The receipt endpoint (a dataseed) holds only geth's
  // 128-block trie — measured at 110–119 blocks ≈ 50 s against a 60 s receipt
  // timeout — so a fill that took 40 s to confirm had ten seconds of usable
  // window and a fill reconciled after a restart had none. Balances therefore
  // go through `stateClient`, which the chain config points at an archival
  // endpoint. See client.endpointFor.
  const c = receiptClient(fill.chain);
  const sc = stateClient(fill.chain);
  const wallet = fill.wallet as Address;
  fill.attempts = (fill.attempts ?? 0) + 1;
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    let receipt: Awaited<ReturnType<typeof c.getTransactionReceipt>> | null = null;
    try {
      receipt = await c.getTransactionReceipt({ hash: fill.hash as Hex });
    } catch (e) {
      receipt = null;
      if (isRpcRefusal(e)) {
        // The endpoint will not serve it at all — retrying for a minute only
        // hides the reason. Say so and let the next round try again.
        fill.note = 'the RPC endpoint refuses receipts — set your own BNB endpoint in Settings';
        break;
      }
    }
    if (!receipt) {
      await sleep(reconcileDelayMs);
      continue;
    }
    try {
      const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
      if (receipt.status !== 'success') {
        fill.state = 'unreconciled';
        fill.note = 'transaction reverted';
        fill.gasWei = gasWei.toString();
        persist();
        settled(fill);
        return;
      }
      const bn = receipt.blockNumber;
      // The native delta is the balance diff across the fill's block — the
      // same rule as the Solana rail's lamport delta. When the endpoint will
      // not serve historical balances (a full node keeps ~128 blocks of
      // state), fall back to what the receipt itself proves: the value sent
      // plus gas. That is exact for a buy with no refund and never invents a
      // number it cannot see.
      let delta: bigint | null = null;
      // A note that must SURVIVE a successful reconcile: the disclosure that a
      // fill was priced from the transaction rather than a balance diff was
      // being written to fill.note and then cleared three lines later by the
      // `fill.note = null` that ends the happy path, so the user was never told.
      let priceNote: string | null = null;
      try {
        const [before, after] = await Promise.all([sc.getBalance({ address: wallet, blockNumber: bn - 1n }), sc.getBalance({ address: wallet, blockNumber: bn })]);
        delta = after - before;
      } catch (e) {
        if (!isRpcRefusal(e)) throw e;
        pricingFallbacks += 1;
        const pruned = isPrunedStateError(e);
        // A BUY with no in-transaction refund is exactly `value + gas`, so the
        // transaction itself is an honest (if slightly optimistic) basis and the
        // note says so. A SELL is not: its `value` is zero, so this would record
        // the sale as having brought in NOTHING and cost gas — a wrong number
        // that silently deepens the loss. PnL basis is the on-chain delta; when
        // the chain will not give it, the answer is unknown, which the portfolio
        // renders as an em dash. It is never zero.
        if (fill.side === 'buy') {
          try {
            const tx = await c.getTransaction({ hash: fill.hash as Hex });
            delta = -(tx.value + gasWei);
            priceNote = pruned
              ? 'priced from the transaction — the endpoint no longer holds state for that block, so any in-transaction refund is not counted'
              : 'priced from the transaction, not a balance diff — any in-transaction refund is not counted';
          } catch {
            delta = null;
          }
        } else {
          delta = null;
          priceNote = pruned
            ? 'the endpoint no longer holds state for that block, so what this sale brought in cannot be read — set an archival endpoint in Settings'
            : 'the RPC endpoint would not serve the balances needed to price this sale';
        }
      }
      if (delta === null) {
        fill.state = 'unreconciled';
        fill.note = priceNote ?? fill.note ?? 'the RPC endpoint would not serve the balances needed to price this fill';
        persist();
        settled(fill);
        return;
      }
      fill.nativeDeltaWei = delta.toString();
      fill.gasWei = gasWei.toString();
      let tokenDelta = 0n;
      const me = wallet.toLowerCase();
      for (const l of receipt.logs) {
        if (l.address.toLowerCase() !== fill.token) continue;
        if (l.topics[0] !== TOPIC.erc20Transfer || l.topics.length < 3) continue;
        const from = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
        const to = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
        const value = BigInt(l.data);
        if (to === me) tokenDelta += value;
        if (from === me) tokenDelta -= value;
      }
      fill.tokenDeltaRaw = tokenDelta.toString();
      fill.state = 'reconciled';
      fill.note = priceNote;
      persist();
      settled(fill);
      return;
    } catch (e) {
      fill.note = `reconcile: ${(e as Error).message}`;
      await sleep(reconcileDelayMs);
    }
  }
  if ((fill.attempts ?? 0) >= MAX_ROUNDS) {
    fill.state = 'unreconciled';
    fill.note = fill.note ?? 'receipt never appeared';
    settled(fill);
  }
  persist();
}

let reconciling = false;

/** Retry pending fills, a few per pass. */
export async function reconcilePending(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const pending = state.fills.filter((f) => f.state === 'pending').slice(0, 10);
    for (const f of pending) await reconcile(f);
  } finally {
    reconciling = false;
  }
}

export function all(): EvmFill[] {
  return state.fills.map((f) => ({ ...f }));
}

export function forWallet(chain: EvmChainKind, wallet: string): EvmFill[] {
  const w = wallet.toLowerCase();
  return state.fills.filter((f) => f.chain === chain && f.wallet === w).map((f) => ({ ...f }));
}

export interface TokenBasis {
  token: string;
  symbol: string;
  spentWei: bigint;
  receivedWei: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  buys: number;
  sells: number;
  firstAt: number | null;
  lastAt: number | null;
  unreconciled: number;
  decimals: number | null;
  gasWei: bigint;
  feeWei: bigint;
}

/** Per-token basis from RECONCILED fills of one wallet on one chain. Fee
 *  transfers are recorded with the trade's side and a zero token delta on
 *  the same token, so they land in the same bucket. */
export function basisByToken(chain: EvmChainKind, wallet: string): Map<string, TokenBasis> {
  const out = new Map<string, TokenBasis>();
  const w = wallet.toLowerCase();
  for (const f of state.fills) {
    if (f.chain !== chain || f.wallet !== w) continue;
    let b = out.get(f.token);
    if (!b) {
      b = { token: f.token, symbol: f.symbol, spentWei: 0n, receivedWei: 0n, tokensBought: 0n, tokensSold: 0n, buys: 0, sells: 0, firstAt: null, lastAt: null, unreconciled: 0, decimals: f.decimals, gasWei: 0n, feeWei: 0n };
      out.set(f.token, b);
    }
    if (f.symbol && !b.symbol) b.symbol = f.symbol;
    if (f.decimals !== null) b.decimals = f.decimals;
    if (f.state !== 'reconciled' || f.nativeDeltaWei === null || f.tokenDeltaRaw === null) {
      if (f.state !== 'reconciled') b.unreconciled += 1;
      continue;
    }
    const nat = BigInt(f.nativeDeltaWei);
    const tok = BigInt(f.tokenDeltaRaw);
    b.gasWei += f.gasWei ? BigInt(f.gasWei) : 0n;
    b.feeWei += f.feeWei ? BigInt(f.feeWei) : 0n;
    if (f.side === 'buy') {
      b.spentWei += nat < 0n ? -nat : 0n;
      b.tokensBought += tok > 0n ? tok : 0n;
      if (tok > 0n) b.buys += 1;
    } else if (tok === 0n && f.requested === 0 && f.feeWei) {
      // A sell's follow-up fee transfer (curve venues bill after the fill):
      // it reduces what the sale brought in; it is not a cost of entry, so
      // it must not move the average entry price of what is still held.
      const cost = nat < 0n ? -nat : 0n;
      b.receivedWei = b.receivedWei > cost ? b.receivedWei - cost : 0n;
    } else {
      b.receivedWei += nat > 0n ? nat : 0n;
      b.spentWei += nat < 0n ? -nat : 0n;
      b.tokensSold += tok < 0n ? -tok : 0n;
      if (tok < 0n) b.sells += 1;
    }
    b.firstAt = b.firstAt === null ? f.at : Math.min(b.firstAt, f.at);
    b.lastAt = b.lastAt === null ? f.at : Math.max(b.lastAt, f.at);
  }
  return out;
}

export function stats(chain: EvmChainKind, wallet: string): { fills: number; unreconciled: number; gasWei: bigint; feeWei: bigint } {
  const w = wallet.toLowerCase();
  let fills = 0, unreconciled = 0, gasWei = 0n, feeWei = 0n;
  for (const f of state.fills) {
    if (f.chain !== chain || f.wallet !== w) continue;
    fills += 1;
    if (f.state !== 'reconciled') unreconciled += 1;
    if (f.gasWei) gasWei += BigInt(f.gasWei);
    if (f.feeWei) feeWei += BigInt(f.feeWei);
  }
  return { fills, unreconciled, gasWei, feeWei };
}

// ── Tracked tokens (holdings the user wants listed) ───────────────────

const tkey = (chain: EvmChainKind, wallet: string): string => `${chain}:${wallet.toLowerCase()}`;

export function tracked(chain: EvmChainKind, wallet: string): string[] {
  return [...(state.tracked[tkey(chain, wallet)] ?? [])];
}

export function track(chain: EvmChainKind, wallet: string, token: string, on: boolean): string[] {
  const k = tkey(chain, wallet);
  const t = token.toLowerCase();
  const cur = new Set(state.tracked[k] ?? []);
  if (on) cur.add(t);
  else cur.delete(t);
  state.tracked[k] = [...cur].slice(-200);
  persist();
  return [...cur];
}

/** Tokens this wallet has ever filled on the chain, plus the tracked ones. */
export function knownTokens(chain: EvmChainKind, wallet: string): string[] {
  const w = wallet.toLowerCase();
  const set = new Set<string>(state.tracked[tkey(chain, wallet)] ?? []);
  for (const f of state.fills) if (f.chain === chain && f.wallet === w) set.add(f.token);
  return [...set];
}

export function _reset(): void {
  state = { version: 2, fills: [], tracked: {} };
  pricingFallbacks = 0;
}

export function _setReconcileDelayMs(ms: number): void {
  reconcileDelayMs = ms;
}
