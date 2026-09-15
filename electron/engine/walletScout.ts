// Wallet Scout — the book behind the leaderboard.
//
// One book per chain, never merged. Every trade the app already decodes names
// its trader (pump's `user`, Pons's `recipient`, four.meme's `account`), so
// this is aggregation of data already flowing past rather than new polling: it
// costs no RPC calls at all.
//
// ─── Bounds, because this is the whole chain ─────────────────────────────
//
// pump alone does tens of thousands of launches a day and far more trades, and
// most of the addresses in that flow buy once and are never seen again. Keeping
// a position book for every one of them would be unbounded memory for no
// benefit, so:
//
//   · a wallet is only PROMOTED to a tracked book once it has been seen
//     `PROMOTE_AFTER` times — one-trade addresses cost a counter, not a book;
//   · tracked wallets are capped and the least recently active is evicted;
//   · open positions per wallet are capped, and daily buckets roll off at
//     `SCOUT_RETENTION_DAYS`.
//
// ─── What it records ─────────────────────────────────────────────────────
//
// Cost basis per wallet per mint, and a closed round trip when a position goes
// flat — the same construction copyTrade uses for a followed wallet, which is
// the one already trusted with real money. Realised PnL is proceeds minus the
// cost of what was sold. Unrealised is NOT claimed anywhere: pricing every open
// position of every tracked wallet would be a guess at scale, and an honest
// gap beats a confident number.

import fs from 'node:fs';
import path from 'node:path';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_CHAINS,
  SCOUT_MAX_TRACKED,
  dayOf,
  rotate,
  type ScoutChain,
  type ScoutDay,
  type ScoutWallet,
} from '@shared/walletScout';

const FILE = 'wallet-scout.json';

/** Seen this many times before we start keeping a position book. */
const PROMOTE_AFTER = 3;
/** Tracked wallets per chain — see `SCOUT_MAX_TRACKED` for the eviction order. */
const MAX_TRACKED = SCOUT_MAX_TRACKED;
/** Sightings kept for un-promoted addresses, per chain. */
const MAX_SIGHTINGS = 60_000;
/** Open positions kept per wallet. */
const MAX_OPEN = 60;
/** Hold times kept per wallet, for the median. */
const MAX_HOLDS = 200;
/**
 * Trade ids remembered per chain, so the same trade cannot be recorded twice.
 *
 * Two feeds can carry one trade: the live decoder while the collector runs,
 * and a manual scan replaying the same hours from a historical source. Without
 * this a scan over the last hour would double every round trip the feed
 * already scored. Insertion-ordered, oldest dropped first; 40k covers well
 * over an hour of pump's whole-chain flow, which is the overlap that matters.
 */
const MAX_SEEN_TX = 40_000;

/** What `note` did with a trade — a scan reports these back to the user. */
export type NoteResult = 'noted' | 'duplicate' | 'own' | 'ignored';

interface Pos {
  /** Native still committed to this mint. */
  cost: number;
  tokens: number;
  openedAt: number;
}

interface Book {
  address: string;
  firstSeen: number;
  lastSeen: number;
  days: Map<number, ScoutDay>;
  positions: Map<string, Pos>;
  holds: number[];
}

interface ChainState {
  tracked: Map<string, Book>;
  /** Address → times seen, for everything not yet promoted. */
  sightings: Map<string, number>;
  /**
   * Wallets the user saved.
   *
   * Saved is not followed: it is a bookmark, kept so a wallet worth a second
   * look survives eviction and a restart. It lives here rather than in
   * localStorage because it is the user's own data and belongs with their
   * profile, next to the records it points at.
   */
  saved: Set<string>;
  /** Trade ids already recorded — see MAX_SEEN_TX. */
  seenTx: Set<string>;
}

const freshState = (): ChainState => ({ tracked: new Map(), sightings: new Map(), saved: new Set(), seenTx: new Set() });

const state = new Map<ScoutChain, ChainState>();
for (const c of SCOUT_CHAINS) state.set(c, freshState());

/**
 * The user's own addresses, per chain.
 *
 * The Scout exists to find someone ELSE worth following. Your own wallets in a
 * "top traders" list are noise at best — and with the Warmer running they are
 * manufactured noise: warming buys and sells on a schedule, so it produces
 * exactly the round trips this page ranks on. Recording them would mean
 * presenting our own generated activity back to the user as a measurement.
 *
 * Injected rather than imported so this module keeps no dependency on the
 * wallet stores, and refreshed whenever wallets change.
 */
const ownAddresses = new Map<ScoutChain, Set<string>>();

let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;
/** Set when the store existed but could not be read; persisting stays off. */
let loadFailure: string | null = null;

export function failure(): string | null {
  return loadFailure;
}

/**
 * Tell the Scout which addresses belong to the user.
 *
 * Also PURGES anything already recorded for them: a build that started
 * recording before this existed has the user's own wallets in its history, and
 * leaving them in would keep them on the leaderboard forever.
 */
export function setOwnAddresses(chain: ScoutChain, addresses: readonly string[]): void {
  const set = new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean));
  ownAddresses.set(chain, set);
  const st = chainState(chain);
  let purged = 0;
  for (const a of set) {
    if (st.tracked.delete(a)) purged += 1;
    st.sightings.delete(a);
    st.saved.delete(a);
  }
  if (purged > 0) persist();
}

export function isOwn(chain: ScoutChain, address: string): boolean {
  return ownAddresses.get(chain)?.has(address.toLowerCase()) ?? false;
}

function chainState(chain: ScoutChain): ChainState {
  let s = state.get(chain);
  if (!s) {
    s = freshState();
    state.set(chain, s);
  }
  return s;
}

/** Closed round trips across every day a book still holds. */
function totalTrips(b: Book): number {
  let n = 0;
  for (const d of b.days.values()) n += d.roundTrips;
  return n;
}

function emptyDay(day: number): ScoutDay {
  return { day, buys: 0, sells: 0, roundTrips: 0, wins: 0, losses: 0, pnl: 0, volume: 0 };
}

function dayBucket(b: Book, at: number): ScoutDay {
  const d = dayOf(at);
  let bucket = b.days.get(d);
  if (!bucket) {
    bucket = emptyDay(d);
    b.days.set(d, bucket);
  }
  return bucket;
}

/**
 * Record one trade.
 *
 * `native` is what MOVED — SOL/ETH/BNB in on a buy, out on a sell — and
 * `tokens` the token side. A sell with no matching position is counted as a
 * sell and nothing more: we did not see the buy, so we cannot price the round
 * trip, and inventing a basis is how a leaderboard starts lying.
 *
 * `tx` is the trade's id (signature, or hash:logIndex on EVM). When given, a
 * trade seen before is refused as a duplicate — the guard that lets a manual
 * scan replay hours the live feed may already have recorded. Feeding must be
 * OLDEST-FIRST: a sell only scores against a buy already on the book.
 */
export function note(
  chain: ScoutChain,
  address: string,
  mint: string,
  isBuy: boolean,
  native: number,
  tokens: number,
  at = Date.now(),
  tx?: string,
): NoteResult {
  if (!address || !Number.isFinite(native) || native <= 0) return 'ignored';
  const s = chainState(chain);
  const key = address.toLowerCase();
  // Never record the user's own wallets — see ownAddresses.
  if (ownAddresses.get(chain)?.has(key)) return 'own';
  if (tx) {
    if (s.seenTx.has(tx)) return 'duplicate';
    s.seenTx.add(tx);
    while (s.seenTx.size > MAX_SEEN_TX) {
      const oldest = s.seenTx.values().next().value;
      if (oldest === undefined) break;
      s.seenTx.delete(oldest);
    }
  }

  let b = s.tracked.get(key);
  if (!b) {
    // Not promoted yet: one counter, no book. Most addresses stop here.
    const seen = (s.sightings.get(key) ?? 0) + 1;
    if (seen < PROMOTE_AFTER) {
      if (s.sightings.size >= MAX_SIGHTINGS) s.sightings.clear();
      s.sightings.set(key, seen);
      return 'noted';
    }
    s.sightings.delete(key);
    b = { address: key, firstSeen: at, lastSeen: at, days: new Map(), positions: new Map(), holds: [] };
    s.tracked.set(key, b);
    evict(s);
  }

  // A scan can arrive out of order against the live feed: neither edge moves
  // the wrong way.
  if (at > b.lastSeen) b.lastSeen = at;
  if (at < b.firstSeen) b.firstSeen = at;
  const bucket = dayBucket(b, at);

  if (isBuy) {
    bucket.buys += 1;
    bucket.volume += native;
    const p = b.positions.get(mint);
    if (p) {
      p.cost += native;
      p.tokens += tokens;
    } else {
      if (b.positions.size >= MAX_OPEN) return 'noted';
      b.positions.set(mint, { cost: native, tokens, openedAt: at });
    }
    return 'noted';
  }

  bucket.sells += 1;
  const p = b.positions.get(mint);
  // A sell we have no basis for: counted, never priced.
  if (!p || p.tokens <= 0) return 'noted';

  const share = Math.min(1, tokens / p.tokens);
  const costOut = p.cost * share;
  const pnl = native - costOut;
  p.cost -= costOut;
  p.tokens -= Math.min(tokens, p.tokens);

  // Flat, or so close that what is left is dust — the trip is closed and
  // scored on the day it CLOSED, which is what makes a daily window mean
  // "what did this wallet make today".
  if (p.tokens <= 0 || p.cost <= 1e-9) {
    b.positions.delete(mint);
    bucket.roundTrips += 1;
    if (pnl > 0) bucket.wins += 1;
    else if (pnl < 0) bucket.losses += 1;
    b.holds.push(Math.max(0, at - p.openedAt));
    if (b.holds.length > MAX_HOLDS) b.holds.shift();
  }
  bucket.pnl += pnl;
  schedulePersist();
  return 'noted';
}

function evict(s: ChainState): void {
  if (s.tracked.size <= MAX_TRACKED) return;
  // Thin records first — a wallet with fewer closed trips than the rank floor
  // has no record the board can show — and among equals the least recently
  // active. This used to be last-seen alone, which meant pump's flood of
  // three-trade addresses pushed a wallet with a real week-long record off the
  // book the moment it went quiet for a day or two: the cap ate exactly the
  // rows the page exists to find. A SAVED wallet is never evicted: the user
  // asked to keep it, and losing a bookmark to a cache bound would be the app
  // quietly undoing a decision they made.
  const order = [...s.tracked.values()]
    .filter((b) => !s.saved.has(b.address))
    .map((b) => ({ b, ranked: totalTrips(b) >= MIN_TRIPS_FOR_RANK }))
    .sort((x, y) => (x.ranked !== y.ranked ? (x.ranked ? 1 : -1) : x.b.lastSeen - y.b.lastSeen));
  for (const { b } of order) {
    if (s.tracked.size <= MAX_TRACKED) break;
    s.tracked.delete(b.address);
  }
}

/** Wallets the user saved on a chain. */
export function savedList(chain: ScoutChain): string[] {
  return [...chainState(chain).saved];
}

export function isSaved(chain: ScoutChain, address: string): boolean {
  return chainState(chain).saved.has(address.toLowerCase());
}

export function setSaved(chain: ScoutChain, address: string, on: boolean): { ok: boolean; message: string } {
  const key = String(address ?? '').toLowerCase();
  if (!key) return { ok: false, message: 'No wallet given' };
  const s = chainState(chain);
  if (on) s.saved.add(key);
  else s.saved.delete(key);
  persist();
  return { ok: true, message: on ? 'Saved' : 'Removed' };
}

function median(xs: readonly number[]): number | null {
  if (xs.length < 4) return null; // too few to call a median
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function toWallet(chain: ScoutChain, b: Book): ScoutWallet {
  let openCost = 0;
  for (const p of b.positions.values()) openCost += p.cost;
  return {
    chain,
    address: b.address,
    firstSeen: b.firstSeen,
    lastSeen: b.lastSeen,
    days: rotate([...b.days.values()]),
    openCount: b.positions.size,
    openCost,
    medianHoldMs: median(b.holds),
  };
}

/** Every tracked wallet on a chain. The caller windows and ranks. */
export function wallets(chain: ScoutChain): ScoutWallet[] {
  const s = chainState(chain);
  return [...s.tracked.values()].map((b) => toWallet(chain, b));
}

/**
 * Forget every tracked wallet on a chain.
 *
 * The population here is built by WATCHING — the live feed and any scan the
 * user runs — so it only grows, and the only way to start a fresh hunt was to
 * delete a file by hand. Nothing ships with wallets in it; this is the user's
 * own accumulation, and it has to be theirs to throw away.
 *
 * SAVED wallets survive. Saving is a deliberate act — the one signal on this
 * page that the user, not the scanner, put there — and a "clear" that threw it
 * away would make the bookmark useless. They are returned to a blank record
 * rather than deleted, so a saved wallet still appears and simply has nothing
 * measured about it yet.
 */
export function clearTracked(chain: ScoutChain): { ok: boolean; message: string; cleared: number } {
  const s = chainState(chain);
  const before = s.tracked.size;
  const keep = new Set(s.saved);
  for (const [addr] of [...s.tracked]) {
    if (!keep.has(addr)) s.tracked.delete(addr);
  }
  // Sightings and open positions are session state about wallets that no longer
  // have a record; leaving them would let the next trade resurrect a half-row.
  s.sightings.clear();
  persist();
  const cleared = before - s.tracked.size;
  return {
    ok: true,
    message: cleared
      ? `Forgot ${cleared.toLocaleString()} wallet${cleared === 1 ? '' : 's'}${keep.size ? `, kept ${keep.size} saved` : ''}`
      : 'Nothing tracked to clear',
    cleared,
  };
}

export function counts(chain: ScoutChain): { tracked: number; watching: number; cap: number } {
  const s = chainState(chain);
  return { tracked: s.tracked.size, watching: s.sightings.size, cap: MAX_TRACKED };
}

// ── Persistence ───────────────────────────────────────────────────────
//
// Long-term is the point: a leaderboard that forgets on restart cannot answer
// "this week". Only the daily buckets are saved — open positions and sighting
// counters are session state, and a position book restored across a restart
// would price a sell against a buy from days ago.

interface StoredWallet {
  address: string;
  firstSeen: number;
  lastSeen: number;
  days: ScoutDay[];
  medianHoldMs: number | null;
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
    }
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // An unreadable history is NOT an empty history: fail closed and never
    // write over it, so a corrupt file can be recovered by hand.
    loadFailure = `${filePath} is not valid JSON (${(e as Error).message})`;
    return;
  }
  const obj = raw as { chains?: Record<string, StoredWallet[]>; saved?: Record<string, string[]> };
  if (!obj || typeof obj !== 'object' || !obj.chains || typeof obj.chains !== 'object') {
    loadFailure = `${filePath} is not a wallet-scout file this version understands`;
    return;
  }
  for (const chain of SCOUT_CHAINS) {
    const marks = obj.saved?.[chain];
    if (Array.isArray(marks)) {
      const s2 = chainState(chain);
      for (const a of marks) if (typeof a === 'string' && a) s2.saved.add(a.toLowerCase());
    }
    const rows = obj.chains[chain];
    if (!Array.isArray(rows)) continue;
    const s = chainState(chain);
    for (const r of rows) {
      if (!r || typeof r.address !== 'string' || !Array.isArray(r.days)) continue;
      const days = new Map<number, ScoutDay>();
      for (const d of rotate(r.days.filter((d) => d && typeof d.day === 'number'))) days.set(d.day, d);
      if (days.size === 0) continue;
      s.tracked.set(r.address, {
        address: r.address,
        firstSeen: typeof r.firstSeen === 'number' ? r.firstSeen : Date.now(),
        lastSeen: typeof r.lastSeen === 'number' ? r.lastSeen : Date.now(),
        days,
        positions: new Map(),
        holds: typeof r.medianHoldMs === 'number' ? [r.medianHoldMs, r.medianHoldMs, r.medianHoldMs, r.medianHoldMs] : [],
      });
    }
  }
}

function schedulePersist(): void {
  if (!filePath || loadFailure || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 30_000);
}

export function persist(): void {
  if (!filePath || loadFailure) return;
  const chains: Record<string, StoredWallet[]> = {};
  const saved: Record<string, string[]> = {};
  for (const chain of SCOUT_CHAINS) {
    const s = chainState(chain);
    saved[chain] = [...s.saved];
    chains[chain] = [...s.tracked.values()]
      .map((b) => ({
        address: b.address,
        firstSeen: b.firstSeen,
        lastSeen: b.lastSeen,
        days: rotate([...b.days.values()]),
        medianHoldMs: median(b.holds),
      }))
      .filter((w) => w.days.length > 0);
  }
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chains, saved }), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* a failed save costs history, never a trade */
  }
}

export function flushSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persist();
}

/** Test seam. */
export function _reset(): void {
  for (const c of SCOUT_CHAINS) state.set(c, freshState());
  ownAddresses.clear();
  filePath = '';
  loadFailure = null;
}
