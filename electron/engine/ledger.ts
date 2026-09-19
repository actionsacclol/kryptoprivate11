// Real-fill ledger — the basis for the portfolio's cost basis and PnL.
//
// WHY NOT THE RECORDER. `recorder.record('live_trade', …)` writes what we
// ASKED for: "buy 0.1 SOL of this mint". That is not what the trade cost.
// The real number includes the priority fee, the Jito tip, the relayer's
// cut, the ATA rent, and whatever slippage the fill actually took. Building
// a PnL page on the requested amount would produce a number that is wrong in
// the user's favour on every single row — which is precisely the dishonesty
// this product exists to not do.
//
// So each fill is reconciled against the CHAIN: fetch the confirmed
// transaction, diff our own wallet's pre/post lamport balance, and diff the
// token balance for the mint. That gives the true SOL out (or in) and the
// true token amount received (or sold), fees included, from the ledger the
// network itself keeps.
//
// A fill that cannot be reconciled is stored as `unreconciled` and is
// EXCLUDED from cost basis rather than guessed at. The portfolio then says
// how many rows it could not read, instead of quietly averaging over a hole.

import fs from 'node:fs';
import path from 'node:path';
import { getTransaction, resolveAccountKeys } from '../chain/rpcClient';

const FILE = 'fills.json';
const MAX_FILLS = 5_000;
/** A confirmed tx is usually queryable within a second or two; give it room. */
const RECONCILE_ATTEMPTS = 4;
let reconcileDelayMs = 2_500;
/**
 * A fill still `pending` after this many reconcile ROUNDS (each round is
 * RECONCILE_ATTEMPTS reads) is given up on and marked terminal. Rounds run at
 * record time and then once per reconcilePending() pass, so a tx that never
 * landed stops being asked about after a handful of portfolio polls instead
 * of on every one of them forever.
 */
const MAX_RECONCILE_ROUNDS = 6;
/** Fills touched per reconcilePending pass. */
const RECONCILE_BATCH = 10;

export interface Fill {
  id: string;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  at: number;
  signature: string | null;
  /** What we asked for: SOL for a buy, percent for a sell. */
  requested: number;
  /**
   * Net lamports the wallet lost (buy) or gained (sell), from the chain.
   * Negative means SOL left the wallet. Null until reconciled.
   */
  solDeltaLamports: number | null;
  /** Token base units gained (buy) or lost (sell). Null until reconciled. */
  tokenDeltaRaw: string | null;
  decimals: number | null;
  /** Network fee in lamports, as reported by the transaction. */
  feeLamports: number | null;
  state: 'pending' | 'reconciled' | 'unreconciled';
  note: string | null;
  /**
   * The wallet that made this fill.
   *
   * Several trading wallets can be held and the active one can change between
   * trades, so a history that does not say WHICH wallet bought is a history
   * that silently mixes them — and the reconciliation below diffs balances
   * for a specific owner. Null on fills recorded before multi-wallet.
   */
  wallet: string | null;
  /** Reconcile rounds spent so far. Absent on fills from before the counter. */
  attempts?: number;
}

let fills: Fill[] = [];
/** Fired when a fill reaches a terminal state (reconciled/unreconciled). */
const listeners = new Set<(fill: Fill) => void>();

export function onSettled(fn: (fill: Fill) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fills already announced, by id. A fill settles ONCE.
 *
 * Two reconcile paths can run against the same fill at the same time:
 * `recordFill` kicks off one round itself, and `reconcilePending` sweeps
 * anything still `pending` — which that first round's fill is, for the
 * seconds it spends sleeping and fetching. `reconcileInFlight` guards
 * `reconcilePending` against ITSELF, not against the other path, so both
 * could reach `settled()` for one sale.
 *
 * Every listener then ran twice: the realised PnL was logged twice and the
 * losing-streak counter advanced twice for a single sell. A user saw exactly
 * that — "−0.0073 SOL ... appeared twice in loss-accounting logs, despite
 * only one sell signature" — followed by an unearned `loss_limit` disarm
 * (2026-09-13).
 */
const announced = new Set<string>();

function settled(fill: Fill): void {
  if (announced.has(fill.id)) return;
  announced.add(fill.id);
  // Bounded: this only ever grows by one per fill, and fills themselves are
  // capped, but a long session should not hold ids forever.
  if (announced.size > 5_000) {
    const oldest = announced.values().next().value;
    if (oldest !== undefined) announced.delete(oldest);
  }
  for (const fn of listeners) {
    try {
      fn({ ...fill });
    } catch {
      /* a listener must never break the ledger */
    }
  }
}

/** Fills with a reconcile round in flight RIGHT NOW, by id. A second round
 *  for the same fill reads the same transaction to reach the same answer —
 *  wasted requests against `getTransaction`, on an endpoint the user is
 *  already being rate-limited by. */
const reconciling = new Set<string>();
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when fills.json exists but could not be read: the file then holds
 *  the only copy of every cost basis, so this session must NOT overwrite
 *  it (the same rule as the wallet file). Absent file = fresh install. */
let loadFailure: string | null = null;

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  loadFailure = null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    fills = [];
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${filePath} could not be read (${(e as Error).message})`;
      console.warn(`[sniper] ledger: ${loadFailure} — fills are read-only this session`);
    }
    return;
  }
  try {
    const raw = JSON.parse(text) as { version: 1; fills: Fill[] };
    fills = Array.isArray(raw?.fills) ? raw.fills : [];
  } catch (e) {
    fills = [];
    loadFailure = `${filePath} is corrupt (${(e as Error).message})`;
    console.warn(`[sniper] ledger: ${loadFailure} — fills are read-only this session`);
  }
}

/** Why the ledger file is read-only this session, or null. */
export function failure(): string | null {
  return loadFailure;
}

function writeNow(): void {
  if (!filePath || loadFailure) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, fills }, null, 2), 'utf8');
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

/** Write a pending debounced save NOW — called on the way out of the
 *  process, so a fill recorded in the last 250 ms is not lost. */
export function flushSync(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}

let seq = 0;

/**
 * Record a fill that we believe landed, then reconcile it against the chain
 * in the background. Returns immediately — nothing in the trading path waits
 * on this.
 */
export function recordFill(
  input: {
    mint: string;
    symbol: string;
    side: 'buy' | 'sell';
    requested: number;
    signature: string | null;
  },
  ctx: { httpUrl: string; owner: string | null },
): Fill {
  seq += 1;
  const fill: Fill = {
    id: `fill_${Date.now().toString(36)}_${seq.toString(36)}`,
    mint: input.mint,
    symbol: input.symbol,
    side: input.side,
    at: Date.now(),
    signature: input.signature,
    requested: input.requested,
    solDeltaLamports: null,
    tokenDeltaRaw: null,
    decimals: null,
    feeLamports: null,
    state: 'pending',
    note: null,
    wallet: ctx.owner,
    attempts: 0,
  };
  fills.unshift(fill);
  if (fills.length > MAX_FILLS) fills.length = MAX_FILLS;
  persist();

  if (input.signature && ctx.owner) {
    void reconcile(fill, ctx.httpUrl, ctx.owner);
  } else {
    fill.state = 'unreconciled';
    fill.note = input.signature ? 'No wallet address to reconcile against' : 'No signature returned';
    persist();
  }
  return fill;
}

async function reconcile(fill: Fill, httpUrl: string, owner: string): Promise<void> {
  if (reconciling.has(fill.id)) return;
  reconciling.add(fill.id);
  try {
    await reconcileOnce(fill, httpUrl, owner);
  } finally {
    reconciling.delete(fill.id);
  }
}

async function reconcileOnce(fill: Fill, httpUrl: string, owner: string): Promise<void> {
  fill.attempts = (fill.attempts ?? 0) + 1;
  for (let attempt = 1; attempt <= RECONCILE_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, reconcileDelayMs));
    const res = await getTransaction(httpUrl, fill.signature as string);
    if (!res.ok || !res.data) continue;

    const tx = res.data;
    const meta = tx.meta;
    if (!meta) continue;
    if (meta.err) {
      fill.state = 'unreconciled';
      fill.note = 'Transaction failed on chain';
      persist();
      settled(fill);
      return;
    }

    // preBalances/postBalances index the FULL account list (static + ALT),
    // so the wallet must be located in that list, not the static one.
    const keys = resolveAccountKeys(tx);
    const idx = keys.indexOf(owner);
    if (idx >= 0 && meta.preBalances && meta.postBalances) {
      const pre = meta.preBalances[idx];
      const post = meta.postBalances[idx];
      if (Number.isFinite(pre) && Number.isFinite(post)) {
        fill.solDeltaLamports = post - pre;
      }
    }
    fill.feeLamports = Number.isFinite(meta.fee) ? (meta.fee as number) : null;

    // Token delta for this mint, summed across the owner's token accounts.
    const sumFor = (entries: typeof meta.preTokenBalances): bigint => {
      let total = 0n;
      for (const e of entries ?? []) {
        if (e.mint !== fill.mint) continue;
        if (e.owner && e.owner !== owner) continue;
        try {
          total += BigInt(e.uiTokenAmount.amount);
        } catch {
          /* unparseable amount — skip rather than corrupt the total */
        }
        if (fill.decimals === null) fill.decimals = e.uiTokenAmount.decimals;
      }
      return total;
    };
    const before = sumFor(meta.preTokenBalances);
    const after = sumFor(meta.postTokenBalances);
    fill.tokenDeltaRaw = (after - before).toString();

    fill.state = fill.solDeltaLamports === null ? 'unreconciled' : 'reconciled';
    if (fill.state === 'unreconciled') fill.note = 'Wallet not found in the transaction';
    persist();
    settled(fill);
    return;
  }
  // Not readable yet. A tx that was broadcast but not confirmed when we
  // recorded it (a `pending` trade result) can still land minutes later, so
  // the fill STAYS pending for later passes — up to a bounded number of
  // rounds, after which it is terminal and never polled again.
  if ((fill.attempts ?? 0) < MAX_RECONCILE_ROUNDS) {
    fill.note = `Not on chain yet (round ${fill.attempts})`;
    persist();
    return;
  }
  fill.state = 'unreconciled';
  fill.note = `Transaction not found after ${MAX_RECONCILE_ROUNDS} rounds — it did not land`;
  persist();
  settled(fill);
}

let reconcileInFlight = false;

/**
 * Retry fills still `pending` — the RPC may have been down at the time, or
 * the tx landed after the broadcaster stopped waiting for it.
 *
 * Only PENDING fills: `unreconciled` is terminal (failed on chain, wallet not
 * in the tx, gave up) and re-reading it can never change the answer. At most
 * one pass runs at a time; the portfolio page polls every 30s and a pass can
 * take longer than that, so without the guard passes piled up on the RPC.
 * Each fill reconciles against the wallet that MADE it, not the active one.
 */
export async function reconcilePending(httpUrl: string, owner: string | null): Promise<number> {
  if (reconcileInFlight) return 0;
  reconcileInFlight = true;
  try {
    const stale = fills.filter((f) => f.state === 'pending' && f.signature && (f.wallet ?? owner));
    let fixed = 0;
    for (const f of stale.slice(0, RECONCILE_BATCH)) {
      await reconcile(f, httpUrl, (f.wallet ?? owner) as string);
      if (f.state === 'reconciled') fixed += 1;
    }
    return fixed;
  } finally {
    reconcileInFlight = false;
  }
}

/** Is a reconcile pass running right now? */
export function reconcileBusy(): boolean {
  return reconcileInFlight;
}

export function all(): Fill[] {
  return fills.map((f) => ({ ...f }));
}

const LAMPORTS = 1_000_000_000;

export interface MintBasis {
  mint: string;
  symbol: string;
  // ── The CURRENT position (this episode) ─────────────────────────────
  //
  // Everything below is scoped to the run of fills since the wallet last
  // held none of this mint. A trader who buys at 29k, sells the lot, and
  // buys back at 93k is in a NEW position: their entry is 93k, and both the
  // position card and every percentage order anchored on "entry" must say
  // so. Averaging the two rounds together reported an entry the user had
  // not taken and put a Runner ladder's take-profit below the current price
  // (user reports, 2026-09-13).
  /** SOL actually spent on buys in this episode, fees included. */
  spentSol: number;
  /** SOL actually received from sells in this episode, fees deducted. */
  receivedSol: number;
  /** Tokens bought in this episode, in whole units. */
  tokensBought: number;
  /** Tokens sold in this episode, in whole units. */
  tokensSold: number;
  buys: number;
  sells: number;
  /** First fill of THIS episode — when the position now held was opened. */
  firstAt: number | null;
  lastAt: number | null;
  /** Fills we could not read off the chain — excluded from every number above. */
  unreconciled: number;

  // ── Lifetime, across every episode ──────────────────────────────────
  //
  // What the closed-trade history and the all-time PnL read. Never used to
  // price a position that is open right now.
  lifetimeSpentSol: number;
  lifetimeReceivedSol: number;
  lifetimeTokensBought: number;
  lifetimeTokensSold: number;
  lifetimeBuys: number;
  lifetimeSells: number;
  /** The very first fill on this mint, whatever episode it belonged to. */
  firstEverAt: number | null;
  /** Completed round trips: how many times the position went flat. */
  roundTrips: number;
}

/** A sell that leaves no more than this share of the episode's tokens behind
 *  closed the position. Pure dust (rounding, a trailing lamport of a token)
 *  must not keep an episode open, or the next buy would average into it. */
const FLAT_DUST_FRACTION = 0.005;

/**
 * Cost basis per mint, from reconciled fills only.
 *
 * Unreconciled fills are counted but NOT included in the money, and the count
 * is surfaced so the portfolio can say "3 fills could not be read" instead of
 * presenting a total that quietly omits them.
 */
export function basisByMint(
  wallet?: string | null,
  /** Stop the walk just BEFORE this fill — the basis as it stood when that
   *  fill was about to be applied. Used to price a sell against the position
   *  it actually closed, which the post-walk basis no longer describes once
   *  the sell emptied the bag. */
  stopBefore?: Fill,
): Map<string, MintBasis> {
  const out = new Map<string, MintBasis>();
  // Episode detection needs the fills in the order they happened; the array
  // is append-on-arrival and a late reconcile can leave it out of order.
  const ordered = [...fills].sort((a, b) => a.at - b.at);
  /** mint -> tokens the wallet holds according to the fills walked so far. */
  const running = new Map<string, number>();
  for (const f of ordered) {
    // `id` is the fill's own identity, not the transaction's: one signature
    // can carry several fills, so matching on the signature would stop the
    // walk at the wrong one (or, when every fill shares a stub signature, at
    // the first). Identity is checked too, for a caller holding the original.
    if (stopBefore && (f === stopBefore || f.id === stopBefore.id)) break;
    // Per-wallet basis: several wallets are held and only the active one's
    // holdings are on the page, so another wallet's buys must not price
    // them. Fills from before multi-wallet carry no wallet and are treated
    // as the active wallet's — the only wallet that existed then.
    if (wallet && (f.wallet ?? wallet) !== wallet) continue;
    let b = out.get(f.mint);
    if (!b) {
      b = {
        mint: f.mint, symbol: f.symbol, spentSol: 0, receivedSol: 0,
        tokensBought: 0, tokensSold: 0, buys: 0, sells: 0,
        firstAt: null, lastAt: null, unreconciled: 0,
        lifetimeSpentSol: 0, lifetimeReceivedSol: 0,
        lifetimeTokensBought: 0, lifetimeTokensSold: 0,
        lifetimeBuys: 0, lifetimeSells: 0,
        firstEverAt: null, roundTrips: 0,
      };
      out.set(f.mint, b);
    }
    if (f.symbol && !b.symbol) b.symbol = f.symbol;
    b.firstEverAt = b.firstEverAt === null ? f.at : Math.min(b.firstEverAt, f.at);
    b.firstAt = b.firstAt === null ? f.at : Math.min(b.firstAt, f.at);
    b.lastAt = b.lastAt === null ? f.at : Math.max(b.lastAt, f.at);

    if (f.state !== 'reconciled' || f.solDeltaLamports === null) {
      b.unreconciled += 1;
      continue;
    }
    const sol = f.solDeltaLamports / LAMPORTS;
    const tokens =
      f.tokenDeltaRaw !== null && f.decimals !== null
        ? Number(BigInt(f.tokenDeltaRaw)) / 10 ** f.decimals
        : 0;

    if (f.side === 'buy') {
      b.buys += 1;
      b.lifetimeBuys += 1;
      // solDelta is negative on a buy; spend is its magnitude.
      b.spentSol += Math.max(0, -sol);
      b.tokensBought += Math.max(0, tokens);
      b.lifetimeSpentSol += Math.max(0, -sol);
      b.lifetimeTokensBought += Math.max(0, tokens);
      running.set(f.mint, (running.get(f.mint) ?? 0) + Math.max(0, tokens));
    } else {
      b.sells += 1;
      b.lifetimeSells += 1;
      b.receivedSol += Math.max(0, sol);
      b.tokensSold += Math.max(0, -tokens);
      b.lifetimeReceivedSol += Math.max(0, sol);
      b.lifetimeTokensSold += Math.max(0, -tokens);
      const left = (running.get(f.mint) ?? 0) - Math.max(0, -tokens);
      running.set(f.mint, Math.max(0, left));

      // ── Did this sell close the position? ────────────────────────────
      //
      // Only a sell can, and only when the episode actually bought
      // something we could price: a wallet whose buys are all unreconciled
      // has an unknown balance, and declaring it flat would throw away the
      // basis of a position it still holds. Dust left behind does not keep
      // the episode alive — see FLAT_DUST_FRACTION.
      if (b.tokensBought > 0 && left <= b.tokensBought * FLAT_DUST_FRACTION) {
        b.roundTrips += 1;
        running.set(f.mint, 0);
        b.spentSol = 0;
        b.receivedSol = 0;
        b.tokensBought = 0;
        b.tokensSold = 0;
        b.buys = 0;
        b.sells = 0;
        b.firstAt = null;
        // `unreconciled` deliberately survives: a fill we could not read may
        // belong to either side of the line, and the portfolio uses the
        // count only to say "some fills could not be read".
      }
    }
  }
  return out;
}

/**
 * Realised SOL PnL of one reconciled SELL fill, against the average cost of
 * the same wallet's reconciled buys of that mint. Null when the basis is not
 * known (no reconciled buys, or the sell itself is unreconciled) — a breaker
 * fed by this must then do NOTHING, not count a "0".
 */
export interface CashDelta {
  /** Net lamports across the signatures that COULD be priced. */
  solLamports: number;
  /**
   * How many of the asked-for signatures could not be priced at all: the fill
   * is still `pending`, is terminally `unreconciled`, or no fill was ever
   * recorded for it.
   *
   * This count is the whole point of the type. `pending` is the normal state
   * of a fresh fill and reconciliation is demand-driven, so a caller handed
   * only the sum would read a run that has really lost SOL as "0.000
   * realised" and would never trip a loss cap (Wallet Lab audit, lab-1). A
   * caller must treat `unknown > 0` as "I do not know", never as zero.
   */
  unknown: number;
}

/** Net SOL that moved in the wallet across these fills (reconciled only):
 *  sells positive, buys negative, fees and tips included — plus how many of
 *  the signatures could not be priced. The Wallet Lab's loss cap reads this
 *  — cash, not a mark. */
export function cashDeltaFor(signatures: string[]): CashDelta {
  if (!signatures.length) return { solLamports: 0, unknown: 0 };
  const want = new Set(signatures);
  const priced = new Set<string>();
  let lamports = 0;
  for (const f of fills) {
    if (!f.signature || !want.has(f.signature)) continue;
    if (f.state !== 'reconciled' || f.solDeltaLamports === null) continue;
    lamports += f.solDeltaLamports;
    priced.add(f.signature);
  }
  let unknown = 0;
  for (const sig of want) if (!priced.has(sig)) unknown += 1;
  return { solLamports: lamports, unknown };
}

export function realizedPnlForSell(fill: Fill): number | null {
  if (fill.side !== 'sell' || fill.state !== 'reconciled' || fill.solDeltaLamports === null) return null;
  if (fill.tokenDeltaRaw === null || fill.decimals === null) return null;
  // As it stood BEFORE this sell: a sell that emptied the bag closes the
  // episode, and the basis after the walk has nothing left to price it with.
  const b = basisByMint(fill.wallet ?? undefined, fill).get(fill.mint);
  if (!b || b.tokensBought <= 0 || b.spentSol <= 0) return null;
  const sold = Math.max(0, -Number(BigInt(fill.tokenDeltaRaw)) / 10 ** fill.decimals);
  if (!(sold > 0)) return null;
  const avgCost = b.spentSol / b.tokensBought;
  return fill.solDeltaLamports / LAMPORTS - avgCost * sold;
}

export function stats(): { total: number; reconciled: number; unreconciled: number; pending: number } {
  return {
    total: fills.length,
    reconciled: fills.filter((f) => f.state === 'reconciled').length,
    unreconciled: fills.filter((f) => f.state === 'unreconciled').length,
    pending: fills.filter((f) => f.state === 'pending').length,
  };
}

/** Test seam. */
export function _reset(): void {
  fills = [];
  filePath = '';
  announced.clear();
  reconciling.clear();
}

export function _load(list: Fill[]): void {
  fills = list;
}

export function _setReconcileDelayMs(ms: number): void {
  reconcileDelayMs = ms;
}
