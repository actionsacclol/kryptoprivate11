// Krypto Trader sessions — main process. The rules are pure, in
// shared/botStrategy.ts; the types and wording in shared/kryptoTrader.ts;
// the lock / loop / persistence machinery in ./botSession.ts. Design:
// docs/krypto-trader-2026-09-25.md (critic's corrections override it; the
// user's 09-25 decisions override both — pacing is the user's).
//
// Each session is one coin, ONE of the user's existing wallets, one budget:
//   • paper — fills modelled from the live price, 1.5 % a side, and the
//     session's own price impact against the pool depth when it is known;
//   • live  — every trade an ordinary buy/sell signed by that wallet through
//     the full pipeline (Krypt fee, breakers, per-trade cap, ledger). Its
//     book is built from the session's OWN confirmed fills in base units —
//     never from the wallet's balance, so tokens the wallet already held, or
//     bought by hand, are never the session's and never sold by it.
//
// The invariants this file keeps, each pinned in test/kryptotrader.test.mjs:
//   • Paper by default. `open` has no live flag to read; `goLive` is its own
//     call, and it re-checks everything `open` did.
//   • Exactly once. The in-flight record is written to disk SYNCHRONOUSLY
//     before a live trade is signed; found on restart, the session is paused
//     and the trade is never re-sent — Reconcile reads the chain for it, or
//     the user adopts the balance change. It covers THIS module's call only:
//     the engine's `sellWithRetry` may broadcast a 100 % sell twice (once
//     more after broadcast at wider slippage). That is safe because the
//     second send sells what remains, and 100 % is only ever sent when the
//     session's claim is at least the wallet's whole balance (critic #4).
//   • Breakers block buys, never sells. Exits need only "armed". A stop met
//     while the engine is disarmed is NOT consumed (critic #1): it stays
//     pending, warns once a minute, and sells on re-arm.
//   • A stale or unknown price never triggers a stop and never permits a buy.
//   • Sell session bag never marks the session stopped before the sell works.
//   • Restart pauses every running live session.
//   • An unreadable krypto-trader.json is not an empty one: read-only run —
//     and one malformed session entry makes the whole file unreadable.
//   • "Did not land" only on the chain's proof (meta.err, a reverted
//     receipt, or every signature read after the blockhash died). Anything
//     unprovable stays unsettled and pauses for Adopt; a session never
//     claims tokens it cannot prove it bought (review 2026-09-26).
//   • A latched stop keeps retrying, with backoff, even while paused.
//   • There is always a way out: an exit sells what the wallet holds and
//     writes off what it no longer holds; Fit to wallet shrinks the bag.

import {
  applyBuyFill,
  applySellFill,
  avgCostSol,
  big,
  checkTraderIntent,
  claimRawForPct,
  emptyBook,
  entryDone,
  EVM_SELL_DUST_RAW,
  exactSellRaw,
  KRYPT_FEE_PCT,
  NEAR_GRAD_PCT,
  oppositeFloorPct,
  paperBuyFill,
  paperSellFill,
  parseTraderAiReply,
  presetIntent,
  release,
  reserve,
  RESERVE_FACTOR,
  roomSol,
  roundTripCostPct,
  STALE_PRICE_MS,
  stopDue,
  stopPriceSol,
  traderAiDue,
  traderAiFacts,
  traderDerived,
  uiTokens,
  venueFeePct,
  type OtherFill,
  type TraderCheckContext,
  type TraderIntent,
  type TraderView,
} from '@shared/botStrategy';
import {
  EMPTY_MARKET_FACTS,
  emptyTraderAiState,
  PAPER_IMPACT_NOTE,
  TRADER_OWN_COIN_MESSAGE,
  traderAiStyleFor,
  traderFacts,
  traderMoney,
  traderNativeKeys,
  traderLimitsOf,
  traderOptionProblems,
  traderOptionsOf,
  type TraderAiFacts,
  type TraderDriver,
  type TraderFit,
  type TraderLimits,
  type TraderMarketFacts,
  type TraderOptions,
  type TraderRow,
  type TraderSession,
  type TraderTrade,
} from '@shared/kryptoTrader';
import { PAPER_SIDE_COST } from '@shared/paper';
import type { ChainKind, EvmChainKind } from '@shared/chainKind';
import { dueForWarning, SessionLocks, SessionStore, stepAll } from './botSession';

export type { TraderRow, TraderSession } from '@shared/kryptoTrader';

/** What the host knows about a coin's market right now. */
export interface TraderMarket {
  /** SOL per whole token, and when it was read (ms). */
  priceSol: number | null;
  priceAt: number | null;
  venue: 'curve' | 'pool' | null;
  curvePct: number | null;
  /** SOL side of the pool: the curve's virtual SOL, or the PumpSwap quote vault. */
  depthSol: number | null;
  decimals: number | null;
  /** The read succeeded and the pool/curve account no longer exists. */
  poolGone: boolean;
}

/** A settled ledger fill, as the session needs it. On an EVM chain the
 *  signature is the tx hash, the native delta is `nativeDeltaWei` (from the
 *  receipt, gas included — the EVM ledger's reconciliation) and `chain` says
 *  which chain: the same 0x address and token exist on both EVM chains, and a
 *  fill on one is never a trade on the other. */
export interface TraderLedgerFill {
  signature: string | null;
  wallet: string | null;
  mint: string;
  side: 'buy' | 'sell';
  at: number;
  state: 'pending' | 'reconciled' | 'unreconciled';
  tokenDeltaRaw: string | null;
  solDeltaLamports: number | null;
  decimals: number | null;
  feeLamports: number | null;
  /** Absent = Solana. */
  chain?: ChainKind;
  /** EVM: native wei in (+) or out (−), from the receipt. */
  nativeDeltaWei?: string | null;
  /** EVM: Krypt fee wei in this tx, when the ledger read it. */
  feeWei?: string | null;
  /** EVM: gas paid, wei (the network fee — Solana's feeLamports). */
  gasWei?: string | null;
  /** True ONLY when the chain proves the transaction did not land: a Solana
   *  meta.err, an EVM receipt with status reverted. Any other terminal
   *  `unreconciled` row is unprovable, never "did not land". */
  failed?: boolean;
  /** The ledger's own note on the row (why it is unreconciled). */
  note?: string | null;
}

/** Which trade Reconcile is looking for: the in-flight side, nearest its
 *  time, never a signature already booked or classified as not the session's. */
export interface TraderFindMatch {
  side: 'buy' | 'sell';
  near: number;
  skip: string[];
}

export interface TraderTradeResult {
  ok: boolean;
  message: string;
  signature: string | null;
  stage?: string | null;
}

export interface TraderHost {
  now(): number;
  /** One batched read for every mint the loop needs (the shared price cache). */
  markets(mints: string[]): Promise<Map<string, TraderMarket | null>>;
  /** The fit check for a coin at these settings, computed in main. */
  fit(mint: string, o: { budgetSol: number; limits: TraderLimits; walletId: string | null; params?: unknown; preset?: string }): Promise<TraderFit>;
  symbol(mint: string): string;
  /** Why a live BUY cannot run now (not armed, breaker…), or null. */
  buyBlocked(): string | null;
  /** Why a live SELL cannot run now — only "not armed"/"switched off". Breakers never block a sell. */
  exitBlocked(): string | null;
  /** The per-trade cap every trade meets (D5). */
  maxLiveSol(): number | null;
  walletAddress(walletId: string): string | null;
  activeWalletId(): string | null;
  /** A live buy. `sentSol` is what went out after the per-trade cap (critic #17). */
  buy(walletId: string, mint: string, sol: number): Promise<TraderTradeResult & { sentSol: number | null }>;
  /** A live sell of at most `claimRaw` base units — sized as a wallet % that
   *  rounds DOWN, never 100 unless claim ≥ balance, no sell on an unknown balance. */
  sellClaim(walletId: string, mint: string, claimRaw: string): Promise<TraderTradeResult & { walletPct: number | null; balanceRaw: string | null }>;
  /** A signature's confirmed fill (waits up to ~30 s), or null when it did not settle. */
  fill(signature: string): Promise<{ tokensRaw: string; decimals: number | null; solLamports: number; feeLamports: number | null } | null>;
  /** The ledger's record of a signature, no wait. */
  ledgerFill(signature: string): TraderLedgerFill | null;
  /** The wallet's balance of the coin in base units; null = unread. */
  tokenBalanceRaw(walletId: string, mint: string): Promise<string | null>;
  /** The in-flight trade of this coin by this wallet since `sinceMs`, found
   *  on chain (the crash-with-no-signature reconcile, critic #8): the trade on
   *  `match.side` closest in time to `match.near`, never one of `match.skip`.
   *  null = EVERY transaction since `sinceMs` was read and none matched;
   *  undefined = the chain could not be read, or there were too many to read
   *  them all — "not found yet", never "did not land". */
  findTrade(walletId: string, mint: string, sinceMs: number, match: TraderFindMatch): Promise<{ signature: string; side: 'buy' | 'sell'; tokensRaw: string; solLamports: number; decimals: number | null } | null | undefined>;
  /** M9: a message when this is the user's own coin, else null. */
  ownCoin(mint: string, walletId: string): Promise<string | null>;
  /** Other automation holding a claim on (wallet, mint): scripts, copy,
   *  orders, engine positions, Krypto Mode. Each a reason. */
  claims(walletId: string, mint: string): string[];
  /** Ledger fills of this coin since `sinceMs`, any wallet. */
  recentFills(mint: string, sinceMs: number): TraderLedgerFill[];
  watch(mint: string): void;
  /** Market numbers for the AI/MCP facts (no text field). */
  marketFacts(mint: string): Promise<TraderMarketFacts>;
  /** One AI ask with the user's key for this model (null = the session's
   *  default). Null = no key for it. Never given the session's goal: there is none. */
  askTrader(facts: string, model: string | null, style: string): Promise<TraderAiAnswer | null>;
  emit(rows: TraderRow[]): void;
  log(level: 'info' | 'warn', line: string): void;
  /** BNB and Robinhood Chain (stage 4): the EVM rail, every call chain-first.
   *  Absent = EVM sessions are refused. A Solana session never calls any of
   *  these, and an EVM session never calls the Solana methods above (pinned
   *  in test/kryptotrader.test.mjs). */
  evm?: TraderEvmHost | null;
}

/**
 * The EVM rail as a session needs it. Every amount of native coin is WHOLE
 * units (ETH / BNB) except the fill deltas, which stay wei strings until the
 * engine converts them. Every read answers null for "could not read", never
 * zero (honest-null), and a wallet is only ever one of THAT chain's wallets:
 * `walletAddress` answers null for a wallet made for the other chain
 * (evm-wallet-home-chain) — a chain never borrows the other's wallet.
 */
export interface TraderEvmHost {
  markets(chain: EvmChainKind, tokens: string[]): Promise<Map<string, TraderMarket | null>>;
  fit(chain: EvmChainKind, token: string, o: { budgetSol: number; limits: TraderLimits; walletId: string | null; params?: unknown; preset?: string }): Promise<TraderFit>;
  symbol(chain: EvmChainKind, token: string): string;
  /** Why a live buy cannot go on this chain (switched off, not armed), or null. */
  buyBlocked(chain: EvmChainKind): string | null;
  /** Why a live sell cannot go — only "switched off" / "not armed". */
  exitBlocked(chain: EvmChainKind): string | null;
  maxLive(chain: EvmChainKind): number | null;
  walletAddress(chain: EvmChainKind, walletId: string): string | null;
  buy(chain: EvmChainKind, walletId: string, token: string, amountNative: number): Promise<TraderTradeResult & { sentSol: number | null }>;
  /** Sell EXACTLY `amountRaw` base units (the rail's `amountRaw`, never a
   *  percent). `soldRaw` is what the rail actually put in — four.meme floors
   *  to its 1e9 quantum, so it can be less, never more. */
  sellExact(chain: EvmChainKind, walletId: string, token: string, amountRaw: string): Promise<TraderTradeResult & { soldRaw: string | null }>;
  /** A tx hash's reconciled fill from the EVM ledger (receipt-based, waits
   *  up to ~30 s), or null when it did not settle. */
  fill(chain: EvmChainKind, hash: string): Promise<{ tokensRaw: string; decimals: number | null; nativeDeltaWei: string; feeWei: string | null; gasWei?: string | null } | null>;
  ledgerFill(chain: EvmChainKind, hash: string): TraderLedgerFill | null;
  tokenBalanceRaw(chain: EvmChainKind, walletId: string, token: string): Promise<string | null>;
  /** The in-flight trade of this token by this wallet since `sinceMs` in the
   *  EVM ledger (hash + receipt): `match.side`, closest to `match.near`,
   *  never one of `match.skip`. null = none recorded; undefined = recorded
   *  but not provable yet (receipt not in, or unreadable); `failed: true` =
   *  its receipt says reverted — the one proof that it did not land. */
  findTrade(chain: EvmChainKind, walletId: string, token: string, sinceMs: number, match: TraderFindMatch): Promise<{ signature: string; side: 'buy' | 'sell'; tokensRaw: string; nativeDeltaWei: string; decimals: number | null; failed?: boolean } | null | undefined>;
  ownCoin(chain: EvmChainKind, token: string, walletId: string): Promise<string | null>;
  claims(chain: EvmChainKind, walletId: string, token: string): string[];
  recentFills(chain: EvmChainKind, token: string, sinceMs: number): TraderLedgerFill[];
  watch(chain: EvmChainKind, token: string): void;
  marketFacts(chain: EvmChainKind, token: string): Promise<TraderMarketFacts>;
}

/** A fill in the session's money: whole native coin. */
interface NormFill {
  state: TraderLedgerFill['state'];
  tokenDeltaRaw: string | null;
  native: number | null;
  decimals: number | null;
  feeNative: number | null;
  /** The chain proves it did not land (meta.err / reverted). */
  failed: boolean;
  note: string | null;
}

/**
 * One chain's rail, as the engine drives it. The Solana one is the host's own
 * methods; an EVM one binds `host.evm` to its chain. Built from the session's
 * chain, so a Solana session can only ever reach Solana methods and an EVM
 * session only its own chain's.
 */
interface Rail {
  chain: ChainKind;
  evm: boolean;
  unit: string;
  minBuy: number;
  /** Solana: a transaction whose blockhash died never lands, so Reconcile may
   *  conclude "did not land". EVM: a sent transaction has no such clock. */
  expiresUnlanded: boolean;
  markets(tokens: string[]): Promise<Map<string, TraderMarket | null>>;
  fit(token: string, o: { budgetSol: number; limits: TraderLimits; walletId: string | null; params?: unknown; preset?: string }): Promise<TraderFit>;
  symbol(token: string): string;
  buyBlocked(): string | null;
  exitBlocked(): string | null;
  maxLive(): number | null;
  walletAddress(walletId: string): string | null;
  buy(walletId: string, token: string, amount: number): Promise<TraderTradeResult & { sentSol: number | null }>;
  sell(walletId: string, token: string, claimRaw: bigint): Promise<TraderTradeResult & { walletPct: number | null; balanceRaw: string | null; soldRaw: string | null }>;
  fill(sig: string): Promise<{ tokensRaw: string; decimals: number | null; native: number; feeNative: number | null } | null>;
  ledgerFill(sig: string): NormFill | null;
  tokenBalanceRaw(walletId: string, token: string): Promise<string | null>;
  findTrade(walletId: string, token: string, sinceMs: number, match: TraderFindMatch): Promise<{ signature: string; side: 'buy' | 'sell'; tokensRaw: string; native: number; decimals: number | null; failed?: boolean } | null | undefined>;
  ownCoin(token: string, walletId: string): Promise<string | null>;
  claims(walletId: string, token: string): string[];
  recentFills(token: string, sinceMs: number): TraderLedgerFill[];
  watch(token: string): void;
  marketFacts(token: string): Promise<TraderMarketFacts>;
}

const weiToNative = (wei: string | null | undefined): number | null => {
  if (typeof wei !== 'string' || !/^-?\d+$/.test(wei)) return null;
  try {
    return Number(BigInt(wei)) / 1e18;
  } catch {
    return null;
  }
};

function normFill(f: TraderLedgerFill | null): NormFill | null {
  if (!f) return null;
  const evm = f.chain !== undefined && f.chain !== 'solana';
  return {
    state: f.state,
    tokenDeltaRaw: f.tokenDeltaRaw,
    native: evm ? weiToNative(f.nativeDeltaWei) : f.solDeltaLamports === null ? null : f.solDeltaLamports / 1e9,
    decimals: f.decimals,
    // The network fee: gas on EVM (feeWei there is the Krypt fee, which the
    // KRYPT_FEE_PCT estimate in bookFill already counts), lamports on Solana.
    feeNative: evm ? weiToNative(f.gasWei) : f.feeLamports === null ? null : f.feeLamports / 1e9,
    failed: f.failed === true,
    note: f.note ?? null,
  };
}

/** The rail for a chain, or null when this build has none for it. */
function railOf(chain: ChainKind): Rail | null {
  const h = host;
  if (!h) return null;
  const money = traderMoney(chain);
  if (chain === 'solana') {
    return {
      chain,
      evm: false,
      unit: money.symbol,
      minBuy: money.minBuy,
      expiresUnlanded: true,
      markets: (t) => h.markets(t),
      fit: (t, o) => h.fit(t, o),
      symbol: (t) => h.symbol(t),
      buyBlocked: () => h.buyBlocked(),
      exitBlocked: () => h.exitBlocked(),
      maxLive: () => h.maxLiveSol(),
      walletAddress: (w) => h.walletAddress(w),
      buy: (w, t, a) => h.buy(w, t, a),
      sell: async (w, t, claim) => ({ ...(await h.sellClaim(w, t, claim.toString())), soldRaw: null }),
      fill: async (sig) => {
        const f = await h.fill(sig);
        return f ? { tokensRaw: f.tokensRaw, decimals: f.decimals, native: f.solLamports / 1e9, feeNative: f.feeLamports === null ? null : f.feeLamports / 1e9 } : null;
      },
      ledgerFill: (sig) => normFill(h.ledgerFill(sig)),
      tokenBalanceRaw: (w, t) => h.tokenBalanceRaw(w, t),
      findTrade: async (w, t, since, match) => {
        const f = await h.findTrade(w, t, since, match);
        return f ? { signature: f.signature, side: f.side, tokensRaw: f.tokensRaw, native: f.solLamports / 1e9, decimals: f.decimals } : f;
      },
      ownCoin: (t, w) => h.ownCoin(t, w),
      claims: (w, t) => h.claims(w, t),
      recentFills: (t, since) => h.recentFills(t, since),
      watch: (t) => h.watch(t),
      marketFacts: (t) => h.marketFacts(t),
    };
  }
  const e = h.evm;
  if (!e) return null;
  const c = chain;
  return {
    chain,
    evm: true,
    unit: money.symbol,
    minBuy: money.minBuy,
    expiresUnlanded: false,
    markets: (t) => e.markets(c, t),
    fit: (t, o) => e.fit(c, t, o),
    symbol: (t) => e.symbol(c, t),
    buyBlocked: () => e.buyBlocked(c),
    exitBlocked: () => e.exitBlocked(c),
    maxLive: () => e.maxLive(c),
    walletAddress: (w) => e.walletAddress(c, w),
    buy: (w, t, a) => e.buy(c, w, t, a),
    // The EVM rail sells an EXACT base-unit amount: the session's claim, or
    // what the wallet holds if a hand sell left less. Never a percent of a
    // balance that also holds the user's own tokens (copy-sell-quantities).
    sell: async (w, t, claim) => {
      const bal = await e.tokenBalanceRaw(c, w, t);
      const amount = exactSellRaw(claim, bal === null ? null : big(bal));
      if (amount === null) {
        return { ok: false, message: bal === null ? 'the wallet’s balance of this coin could not be read — nothing sold' : 'the wallet holds none of this coin', signature: null, stage: 'validate', walletPct: null, balanceRaw: bal, soldRaw: null };
      }
      const r = await e.sellExact(c, w, t, amount.toString());
      const sold = r.soldRaw !== null && big(r.soldRaw) > 0n && big(r.soldRaw) <= amount ? r.soldRaw : amount.toString();
      return { ...r, walletPct: null, balanceRaw: bal, soldRaw: sold };
    },
    fill: async (hash) => {
      const f = await e.fill(c, hash);
      const n = f ? weiToNative(f.nativeDeltaWei) : null;
      return f && n !== null ? { tokensRaw: f.tokensRaw, decimals: f.decimals, native: n, feeNative: weiToNative(f.gasWei) } : null;
    },
    ledgerFill: (hash) => normFill(e.ledgerFill(c, hash)),
    tokenBalanceRaw: (w, t) => e.tokenBalanceRaw(c, w, t),
    findTrade: async (w, t, since, match) => {
      const f = await e.findTrade(c, w, t, since, match);
      if (!f) return f;
      if (f.failed) return { signature: f.signature, side: f.side, tokensRaw: '0', native: 0, decimals: f.decimals, failed: true };
      const n = weiToNative(f.nativeDeltaWei);
      return n === null ? undefined : { signature: f.signature, side: f.side, tokensRaw: f.tokensRaw, native: n, decimals: f.decimals };
    },
    ownCoin: (t, w) => e.ownCoin(c, t, w),
    claims: (w, t) => e.claims(c, w, t),
    recentFills: (t, since) => e.recentFills(c, t, since),
    watch: (t) => e.watch(c, t),
    marketFacts: (t) => e.marketFacts(c, t),
  };
}

function railFor(s: TraderSession): Rail | null {
  return railOf(s.options.chain ?? 'solana');
}

/** One address on two EVM chains is the same key, and an EVM address has no case. */
function sameAddress(chain: ChainKind, a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
}

function chainName(chain: ChainKind): string {
  return chain === 'solana' ? 'Solana' : chain === 'bnb' ? 'BNB Smart Chain' : 'Robinhood Chain';
}

const FILE = 'krypto-trader.json';
const MAX_SESSIONS = 50;
const MAX_TRADES_KEPT = 200;
const TICK_MS = 5_000;
/** Consecutive failed trades that pause a session (K6). */
const FAIL_PAUSE = 3;
/** Least time between two attempts at a pending exit, and its backoff cap. */
const EXIT_RETRY_MS = 30_000;
const EXIT_RETRY_MAX_MS = 300_000;
/** A transaction whose blockhash is this old and not on chain never will be. */
const BLOCKHASH_DEAD_MS = 120_000;

let host: TraderHost | null = null;
let loadedDir: string | null = null;
let sessions: TraderSession[] = [];
let timer: NodeJS.Timeout | null = null;
const locks = new SessionLocks();
const store = new SessionStore<{ version: 1; sessions: TraderSession[] }>(FILE, 'krypto trader');

// ─── persistence ───────────────────────────────────────────────────────────

/**
 * Read the sessions file. Called from electron/main.ts BEFORE the startup
 * dialog (so `failure()` is listed there) and again, harmlessly, by `init`.
 * Restart rules applied here: every running LIVE session is paused and its
 * peaks cleared (K2); a session with a trade in flight is paused with
 * "check chain" and the trade is never re-sent (K5).
 */
export function load(userDataDir: string, warn: (line: string) => void = () => {}): void {
  if (loadedDir === userDataDir && userDataDir) return;
  loadedDir = userDataDir;
  const data = store.load(
    userDataDir,
    (raw) => {
      const r = raw as { sessions?: unknown };
      if (!r || typeof r !== 'object') throw new Error('not an object');
      // A missing list is a file from before any session; anything else that
      // is not a list is damage — never served as empty and then overwritten.
      if (r.sessions === undefined) return { version: 1 as const, sessions: [] };
      if (!Array.isArray(r.sessions)) throw new Error('"sessions" is not a list');
      // One malformed entry makes the whole file unreadable (read-only run,
      // file kept byte for byte) — never a crash at startup, and never a
      // session silently dropped with its money state (review #13).
      r.sessions.forEach((x, i) => {
        const why = sessionShapeProblem(x);
        if (why) throw new Error(`session ${i + 1}: ${why}`);
      });
      return { version: 1 as const, sessions: r.sessions as TraderSession[] };
    },
    () => ({ version: 1 as const, sessions: [] }),
    warn,
  );
  sessions = data.sessions;
  for (const s of sessions) {
    // Forward-compatible: a limit added later reads as its default.
    s.options.limits = traderLimitsOf(s.options.limits);
    s.unsettled = s.unsettled ?? [];
    s.deferred = Array.isArray(s.deferred) ? s.deferred : [];
    s.foreignSigs = Array.isArray(s.foreignSigs) ? s.foreignSigs : [];
    s.ai = { ...emptyTraderAiState(), ...(s.ai ?? {}), lastAskAt: null, askPriceSol: null, askHighSol: null, askLowSol: null, lowPriceSol: null, nextCheckAt: null };
    s.aiSpend = s.aiSpend ?? { day: '', usd: 0 };
    s.peakPriceSol = null;
    s.peakEquitySol = null;
    if (s.inFlight) {
      if (s.mode === 'paper') s.inFlight = null;
      else {
        if (s.status !== 'stopped') s.status = 'paused';
        s.note = 'A trade was in flight when the app closed. It is never re-sent: press Reconcile to read the chain for it, or Adopt the balance change.';
        continue;
      }
    }
    if (s.mode === 'live' && s.status === 'running') {
      s.status = 'paused';
      s.note = 'Paused on restart — resume to continue.';
    }
  }
}

/** Why a stored session cannot be used as one, or null. The fields the
 *  loop dereferences without a check. */
function sessionShapeProblem(x: unknown): string | null {
  if (!x || typeof x !== 'object') return 'not an object';
  const s = x as Record<string, unknown>;
  const o = s.options as Record<string, unknown> | null | undefined;
  const b = s.book as Record<string, unknown> | null | undefined;
  if (typeof s.id !== 'string') return 'no id';
  if (!o || typeof o !== 'object' || typeof o.mint !== 'string' || typeof o.walletId !== 'string') return 'no coin or wallet';
  if (!b || typeof b !== 'object' || typeof b.tokensRaw !== 'string' || !/^\d+$/.test(b.tokensRaw) || !Array.isArray(b.signatures)) return 'no readable book';
  if (s.mode !== 'paper' && s.mode !== 'live') return 'unknown mode';
  if (s.status !== 'running' && s.status !== 'paused' && s.status !== 'stopped') return 'unknown status';
  if (!Array.isArray(s.trades)) return 'no trade log';
  if (s.unsettled !== undefined && !Array.isArray(s.unsettled)) return 'unreadable unsettled list';
  if (s.inFlight !== null && s.inFlight !== undefined && typeof s.inFlight !== 'object') return 'unreadable in-flight record';
  if (s.excludedRaw !== null && s.excludedRaw !== undefined && (typeof s.excludedRaw !== 'string' || !/^\d+$/.test(s.excludedRaw))) return 'unreadable excluded balance';
  return null;
}

export function init(userDataDir: string, h: TraderHost): void {
  host = h;
  load(userDataDir, (line) => h.log('warn', line));
}

export function failure(): string | null {
  return store.failure();
}

/** Write the file now. False = a file exists to write and the write
 *  failed (EPERM/EBUSY on Windows…): a live trade must not be signed on a
 *  record that is not on disk (review #10). No file configured = true. */
function persistNow(): boolean {
  return store.saveNow({ version: 1, sessions }) || !store.hasFile();
}

function changed(s?: TraderSession): void {
  if (s) s.seq += 1;
  persistNow();
  host?.emit(list());
}

// ─── reading ───────────────────────────────────────────────────────────────

export function list(): TraderRow[] {
  const now = host?.now() ?? Date.now();
  return sessions.map((s) => ({ ...s, trades: s.trades.slice(0, 30), derived: traderDerived(s, now) }));
}

function find(id: string): TraderSession | null {
  return sessions.find((s) => s.id === id) ?? null;
}

/** The session holding a claim on (chain, wallet address, coin), or null —
 *  the seam scripts, copy, orders and MCP consult before trading that pair.
 *  The chain is part of the key: one 0x address signs on both EVM chains and
 *  one token address can exist on both, and a claim on BNB is not a claim on
 *  Robinhood. */
export function claimOn(walletAddress: string, mint: string, chain: ChainKind = 'solana'): TraderSession | null {
  return (
    sessions.find(
      (s) =>
        (s.options.chain ?? 'solana') === chain &&
        sameAddress(chain, s.address, walletAddress) &&
        sameAddress(chain, s.options.mint, mint) &&
        s.mode === 'live' &&
        (s.status !== 'stopped' || big(s.book.tokensRaw) > 0n),
    ) ?? null
  );
}

/** `wallet:remove` / `evm:wallet:remove` ask this BEFORE they disarm anything
 *  (critic #16). Solana and EVM wallet ids are separate lists. */
export function walletRemoveBlocked(walletId: string, family: 'solana' | 'evm' = 'solana'): string | null {
  const s = sessions.find(
    (x) =>
      ((x.options.chain ?? 'solana') === 'solana') === (family === 'solana') &&
      x.options.walletId === walletId &&
      (x.status !== 'stopped' || (x.mode === 'live' && (big(x.book.tokensRaw) > 0n || x.inFlight || x.unsettled.length))),
  );
  return s ? `A Krypto Trader session (${s.symbol || s.options.mint.slice(0, 6)}) uses this wallet. Stop it and sell its bag first.` : null;
}

// ─── opening ───────────────────────────────────────────────────────────────

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function newId(now: number): `kt_${string}` {
  return `kt_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function blank(o: TraderOptions, address: string, symbol: string, now: number, fit: TraderFit): TraderSession {
  return {
    id: newId(now),
    kind: 'trader',
    options: o,
    address,
    symbol,
    mode: 'paper',
    status: 'running',
    note: null,
    seq: 0,
    book: emptyBook(),
    excludedRaw: null,
    holdBaseline: { priceSol: null, solIn: o.budgetSol },
    peakEquitySol: null,
    peakPriceSol: null,
    anchorPriceSol: null,
    lastTrim: null,
    coreRaw: null,
    rounds: { day: dayKey(now), n: 0 },
    rungsDone: [],
    entrySolDone: 0,
    lotsBought: 0,
    inFlight: null,
    unsettled: [],
    deferred: [],
    foreignSigs: [],
    pendingExit: null,
    lastTradeAt: null,
    lastAttemptAt: null,
    lastBuyAt: null,
    lastSellAt: null,
    lastBuyPriceSol: null,
    lastSellPriceSol: null,
    tradeTimes: [],
    failStreak: 0,
    buysWindow: [],
    losingAdds: 0,
    startDepthSol: fit.depthSol,
    lastDepthSol: fit.depthSol,
    lastVenue: fit.venue === 'curve' ? 'curve' : fit.venue === 'pumpswap' || fit.venue === 'pool' ? 'pool' : null,
    venueChangedAt: null,
    lastPriceSol: null,
    lastPriceAt: null,
    aiSpend: { day: dayKey(now), usd: 0 },
    ai: emptyTraderAiState(),
    trades: [],
    createdAt: now,
    wentLiveAt: null,
    expiresAt: now + o.timeLimitH * 3_600_000,
  };
}

/**
 * Open a session — ALWAYS on paper. Unknown keys in `raw` go nowhere
 * (`traderOptionsOf`): there is no live flag, no goal, no target.
 */
export async function open(raw: unknown): Promise<{ ok: boolean; message: string; session?: TraderRow }> {
  if (!host) return { ok: false, message: 'Krypto Trader is not ready.' };
  if (store.failure()) return { ok: false, message: `Krypto Trader is read-only this run: ${store.failure()}` };
  const o = traderOptionsOf(raw);
  const problems = traderOptionProblems(o);
  if (problems.length) return { ok: false, message: problems.join(' ') };
  const rail = railOf(o.chain);
  if (!rail) return { ok: false, message: `Krypto Trader cannot reach ${chainName(o.chain)} in this build.` };
  // One session per coin — a coin is (chain, address): the same 0x address on
  // BNB and on Robinhood are two coins.
  // Only a session remove() would let go of is replaced: a stopped live one
  // with a buy still settling keeps its claim on those tokens (review #5).
  const clash = sessions.find((s) => sameCoin(s, o.chain, o.mint) && removeRefusal(s) !== null);
  if (clash) {
    return {
      ok: false,
      message: clash.status === 'stopped' ? `A stopped Krypto Trader session on this coin still holds tokens or has a trade settling. ${removeRefusal(clash)}` : 'A Krypto Trader session already runs on this coin (one per coin, across all wallets).',
    };
  }
  if (sessions.length >= MAX_SESSIONS) return { ok: false, message: `At most ${MAX_SESSIONS} Krypto Trader sessions are kept. Remove a stopped one first.` };
  const address = rail.walletAddress(o.walletId);
  if (!address) {
    return {
      ok: false,
      message: rail.evm
        ? `That wallet is not one of your ${chainName(o.chain)} wallets. A session trades from a wallet made for its chain (or one from before the chains were split) — never one made for the other chain.`
        : 'That wallet is not on your Wallet page.',
    };
  }
  const own = await rail.ownCoin(o.mint, o.walletId);
  if (own) return { ok: false, message: own };
  const claims = rail.claims(o.walletId, o.mint);
  if (claims.length) return { ok: false, message: `Something else already trades this coin from this wallet: ${claims.join('; ')}.` };
  const fit = await rail.fit(o.mint, { budgetSol: o.budgetSol, limits: o.limits, walletId: o.walletId, params: o.params, preset: o.preset });
  if (fit.refusals.length) return { ok: false, message: fit.refusals.join(' ') };
  if (fit.greyed[o.preset]) return { ok: false, message: `${o.preset} does not fit this coin: ${fit.greyed[o.preset]}` };
  const now = host.now();
  const clipped = fit.clippedBudgetSol !== null ? Math.min(o.budgetSol, fit.clippedBudgetSol) : o.budgetSol;
  const opts: TraderOptions = { ...o, budgetSol: Math.round(clipped * 1e6) / 1e6 };
  const s = blank(opts, address, rail.symbol(o.mint), now, fit);
  if (clipped < o.budgetSol) s.note = `Budget clipped to ${opts.budgetSol} ${rail.unit}: a full exit would move price more than 10%.`;
  // Drop a stopped, empty session on the same coin: one session per coin.
  sessions = sessions.filter((x) => !(sameCoin(x, o.chain, o.mint) && removeRefusal(x) === null));
  sessions.unshift(s);
  rail.watch(o.mint);
  changed(s);
  host.log('info', `krypto trader: ${s.symbol || o.mint.slice(0, 6)} opened on paper on ${chainName(o.chain)} (${o.preset}, ${o.driver}, budget ${opts.budgetSol} ${rail.unit}, wallet ${address})`);
  return { ok: true, message: `Krypto Trader is running on paper${s.note ? ` — ${s.note}` : '.'}`, session: list().find((x) => x.id === s.id) };
}

// ─── controls ──────────────────────────────────────────────────────────────

function note(s: TraderSession, text: string, level: 'info' | 'warn' | null = null): void {
  const changedNote = s.note !== text;
  s.note = text;
  if (level && changedNote) host?.log(level, `krypto trader ${s.symbol || s.options.mint.slice(0, 6)} (${s.mode}): ${text}`);
}

export function pause(id: string, why = 'Paused by you.'): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  if (s.status === 'stopped') return { ok: false, message: 'The session is stopped.' };
  s.status = 'paused';
  s.note = why;
  changed(s);
  return { ok: true, message: `${s.symbol || 'Session'}: paused.` };
}

export async function resume(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  if (store.failure()) return { ok: false, message: 'Krypto Trader is read-only this run.' };
  if (s.status === 'stopped') return { ok: false, message: 'The session is stopped.' };
  if (s.inFlight) return { ok: false, message: 'A trade was in flight: Reconcile or Adopt it first.' };
  if (host.now() >= s.expiresAt) return { ok: false, message: 'The time limit is up. Edit the envelope to extend it, or sell the bag.' };
  const rail = railFor(s);
  if (!rail) return { ok: false, message: `Krypto Trader cannot reach ${chainName(s.options.chain)} in this build.` };
  if (s.mode === 'live') {
    const claims = rail.claims(s.options.walletId, s.options.mint);
    if (claims.length) return { ok: false, message: `Something else trades this coin from this wallet: ${claims.join('; ')}.` };
  }
  s.status = 'running';
  s.failStreak = 0;
  s.note = null;
  rail.watch(s.options.mint);
  changed(s);
  return { ok: true, message: `${s.symbol || 'Session'}: running.` };
}

/** Both kill switches — the engine's and the scripts' — pause every session (critic #9). */
export function pauseAll(reason: string): number {
  let n = 0;
  for (const s of sessions) {
    if (s.status !== 'running') continue;
    s.status = 'paused';
    s.note = `Paused: ${reason}.`;
    s.seq += 1;
    n++;
  }
  if (n) {
    persistNow();
    host?.emit(list());
    host?.log('warn', `krypto trader: ${n} session(s) paused — ${reason}`);
  }
  return n;
}

/**
 * The active wallet changed. Orders and the engine's own positions sell the
 * ACTIVE wallet's balance (critic #6), so a live session whose wallet just
 * became active is paused if any of them now claims its coin.
 */
export function onWalletSwitched(activeWalletId: string | null): void {
  if (!host || !activeWalletId) return;
  for (const s of sessions) {
    // The Solana active wallet; EVM sessions have their own signers per chain.
    if ((s.options.chain ?? 'solana') !== 'solana') continue;
    if (s.mode !== 'live' || s.status !== 'running' || s.options.walletId !== activeWalletId) continue;
    const claims = host.claims(s.options.walletId, s.options.mint);
    if (claims.length) {
      s.status = 'paused';
      note(s, `Paused: this wallet is now the active one, and ${claims.join('; ')} would sell its balance of this coin.`, 'warn');
      changed(s);
    }
  }
}

/** The user edits the envelope: max loss, time limit, what happens at expiry, reinvest, thesis. */
export function setEnvelope(id: string, patch: unknown): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const next = traderOptionsOf({ ...s.options, ...pickEnvelope(p) });
  const problems = traderOptionProblems(next);
  if (problems.length) return { ok: false, message: problems.join(' ') };
  s.options = { ...s.options, maxLossPct: next.maxLossPct, timeLimitH: next.timeLimitH, atExpiry: next.atExpiry, reinvest: next.reinvest, thesis: next.thesis };
  s.expiresAt = (s.wentLiveAt ?? s.createdAt) + s.options.timeLimitH * 3_600_000;
  changed(s);
  return { ok: true, message: 'Envelope saved.' };
}

function pickEnvelope(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['maxLossPct', 'timeLimitH', 'atExpiry', 'reinvest', 'thesis']) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/** The user's pacing — each limit 0 = off, applied at once to a running session. */
export function setLimits(id: string, patch: unknown): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  if (!patch || typeof patch !== 'object') return { ok: false, message: 'Nothing to change.' };
  s.options.limits = traderLimitsOf(patch, s.options.limits);
  changed(s);
  return { ok: true, message: 'Limits saved.' };
}

/** Why a session cannot be let go of (removed, or replaced by a new one on
 *  its coin), or null. */
function removeRefusal(s: TraderSession): string | null {
  if (s.status !== 'stopped') return 'Stop the session first (Sell session bag stops it).';
  if (s.mode === 'live' && (big(s.book.tokensRaw) > 0n || s.inFlight || s.unsettled.length)) {
    return 'The session still holds tokens or has an unsettled trade. Sell its bag, Reconcile, or Adopt / Fit to wallet first.';
  }
  return null;
}

export function remove(id: string): { ok: boolean; message: string } {
  const s = find(id);
  if (!s) return { ok: false, message: 'No such session.' };
  const why = removeRefusal(s);
  if (why) return { ok: false, message: why };
  sessions = sessions.filter((x) => x.id !== id);
  changed();
  return { ok: true, message: 'Removed.' };
}

/**
 * Paper → live. A separate call the page confirms. It re-checks what `open`
 * did (M9, claims, the fit) plus what only live needs (armed, a known
 * creator), and reads the wallet's balance of the coin once: whatever it
 * holds now is EXCLUDED from the session forever (D4).
 */
export async function goLive(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  // Under the session's lock (review #6): a paper-era intent already inside
  // submit finishes on paper before this starts, and one queued behind it
  // meets the new seq and mode — never a paper decision executed live.
  return locks.run(s.id, async () => {
    if (!host) return { ok: false, message: 'No such session.' };
    if (store.failure()) return { ok: false, message: 'Krypto Trader is read-only this run.' };
    if (s.mode === 'live') return { ok: false, message: 'Already live.' };
    if (s.status === 'stopped') return { ok: false, message: 'The session is stopped. Open a new one.' };
    const rail = railFor(s);
    if (!rail) return { ok: false, message: `Krypto Trader cannot reach ${chainName(s.options.chain)} in this build.` };
    // The wallet must still be one of THIS chain's (a wallet reassigned to the
    // other EVM chain since the session opened is not borrowed back).
    const addr = rail.walletAddress(s.options.walletId);
    if (!addr || !sameAddress(s.options.chain, addr, s.address)) return { ok: false, message: `The session’s wallet is no longer one of your ${chainName(s.options.chain)} wallets.` };
    const blocked = rail.buyBlocked();
    if (blocked) return { ok: false, message: `Cannot go live: ${blocked}.` };
    const own = await rail.ownCoin(s.options.mint, s.options.walletId);
    if (own) return { ok: false, message: own };
    const claims = rail.claims(s.options.walletId, s.options.mint);
    if (claims.length) return { ok: false, message: `Something else trades this coin from this wallet: ${claims.join('; ')}.` };
    const fit = await rail.fit(s.options.mint, { budgetSol: s.options.budgetSol, limits: s.options.limits, walletId: s.options.walletId, params: s.options.params, preset: s.options.preset });
    const refused = [...fit.refusals, ...fit.liveRefusals];
    if (refused.length) return { ok: false, message: refused.join(' ') };
    const bal = await rail.tokenBalanceRaw(s.options.walletId, s.options.mint);
    if (bal === null) return { ok: false, message: 'Could not read this wallet’s balance of the coin, so the session cannot tell its own tokens from yours. Try again.' };
    // Re-checked after the awaits: the session may have been removed meanwhile.
    if (!find(s.id)) return { ok: false, message: 'The session changed while going live. Try again.' };
    const now = host.now();
    const keep = s.trades;
    const spend = s.aiSpend;
    Object.assign(s, blank(s.options, s.address, s.symbol, now, fit), { id: s.id, seq: s.seq, trades: keep, createdAt: s.createdAt, aiSpend: spend });
    s.mode = 'live';
    s.status = 'running';
    s.wentLiveAt = now;
    s.excludedRaw = bal;
    s.note = big(bal) > 0n ? 'Live. The wallet already held some of this coin — those tokens are not the session’s and are never sold by it.' : 'Live.';
    changed(s); // bumps seq: an MCP decision made on the paper session is stale
    host.log('info', `krypto trader: ${s.symbol || s.options.mint.slice(0, 6)} is LIVE on ${chainName(s.options.chain)} from ${s.address} (budget ${s.options.budgetSol} ${rail.unit}, per-trade cap ${rail.maxLive() ?? '—'} ${rail.unit})`);
    return { ok: true, message: `${s.symbol || 'Session'} is live.` };
  });
}

/**
 * "Sell session bag" — works in every state (paused, stopped, out of
 * budget, expired, turnover-capped): it is an exit, so no pacing limit holds
 * it. The session is marked stopped only AFTER the sell succeeds (critic #1);
 * a failed sell leaves it as it was, holding the bag, and says why.
 */
export async function sellAll(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  return locks.run(s.id, async () => {
    if (s.inFlight) return { ok: false, message: 'A trade is in flight: Reconcile or Adopt it first.' };
    if (s.unsettled.some((u) => u.side === 'sell' && u.unprovable)) return { ok: false, message: 'A sell’s result could not be proven from the chain: Adopt the wallet’s balance first.' };
    if (s.unsettled.some((u) => u.side === 'sell')) return { ok: false, message: 'A sell is still settling. Try again in a moment.' };
    if (big(s.book.tokensRaw) <= 0n) {
      s.status = 'stopped';
      s.pendingExit = null;
      note(s, s.unsettled.length ? 'Stopped. A buy is still settling; its tokens join the bag when it does.' : 'Stopped — nothing was held.');
      changed(s);
      return { ok: true, message: s.note! };
    }
    const r = await exitAll(s, 'sold by you', 'user', 'user');
    if (r.ok && big(s.book.tokensRaw) === 0n) {
      s.status = 'stopped';
      s.pendingExit = null;
      note(s, 'Sold the session’s bag and stopped.');
    }
    changed(s);
    return r;
  });
}

/** Signatures Reconcile must never book as the in-flight trade: already
 *  booked, still settling, or already classified as not the session's. */
function knownSignatures(s: TraderSession): string[] {
  return [...s.book.signatures, ...s.unsettled.map((u) => u.signature), ...s.foreignSigs];
}

/**
 * A trade was in flight with no signature on record (crash after broadcast,
 * critic #8). Read the wallet's trades of this coin since the in-flight time
 * for the one on the in-flight SIDE nearest its time — never a signature the
 * session already booked or called not its own (review #2/#15). Found →
 * booked from the chain. Proven not landed (EVM reverted), or on Solana every
 * transaction read and its blockhash expired → it did not land. Anything
 * else — unreadable, too many to read, not provable yet → nothing changes.
 */
export async function reconcile(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  return locks.run(s.id, async () => {
    const f = s.inFlight;
    if (!f) return { ok: false, message: 'Nothing is in flight.' };
    const rail = railFor(s);
    if (!rail) return { ok: false, message: `Krypto Trader cannot reach ${chainName(s.options.chain)} in this build.` };
    // Solana: the wallet's signatures back to the in-flight time. EVM: the
    // EVM ledger's record of the tx hash and its receipt (on BNB the receipt
    // comes from the receipts endpoint — publicnode serves none).
    const found = await rail.findTrade(s.options.walletId, s.options.mint, f.at - 5_000, { side: f.side, near: f.at, skip: knownSignatures(s) });
    if (found === undefined) {
      return {
        ok: false,
        message: rail.evm
          ? 'The trade is recorded but its receipt is not in yet (or not readable). Try again in a moment, or Adopt the balance change.'
          : 'Not found yet — the chain could not be read, or the wallet has more transactions since then than can be checked. Try again, or Adopt the balance change.',
      };
    }
    if (found && (found.side !== f.side || knownSignatures(s).some((x) => sameAddress(s.options.chain, x, found.signature)))) {
      return { ok: false, message: `The trade found (${found.signature.slice(0, 8)}…) is not the in-flight ${f.side}. Nothing was booked; use Adopt if the wallet’s balance changed.` };
    }
    if (found && found.failed) {
      if (f.side === 'buy' && f.sol) release(s.book, f.sol * RESERVE_FACTOR);
      s.inFlight = null;
      const others = await resolveDeferred(s, found.signature);
      note(s, `Reconciled: the ${f.side} did not land — its transaction reverted (${found.signature.slice(0, 8)}…).${others} Paused — resume when ready.`, 'info');
      changed(s);
      return { ok: true, message: s.note! };
    }
    if (found) {
      bookFill(s, found.side, { tokensRaw: found.tokensRaw, native: found.native, decimals: found.decimals, feeNative: null, signature: found.signature });
      if (f.side === 'buy' && f.sol) release(s.book, f.sol * RESERVE_FACTOR);
      s.inFlight = null;
      const others = await resolveDeferred(s, found.signature);
      note(s, `Reconciled: the ${found.side} landed (${found.signature.slice(0, 8)}…).${others} Paused — resume when ready.`, 'info');
      changed(s);
      return { ok: true, message: s.note! };
    }
    // An EVM transaction has no blockhash clock: "not found" never proves it
    // did not land, so nothing is released — Adopt is the way out.
    if (!rail.expiresUnlanded) return { ok: false, message: 'No trade of this coin from this wallet is in the ledger since then. Nothing was booked; if the wallet’s balance changed, use Adopt.' };
    if (host!.now() - f.at < BLOCKHASH_DEAD_MS) return { ok: false, message: 'No trade found yet. Its blockhash has not expired — try again in a minute.' };
    if (f.side === 'buy' && f.sol) release(s.book, f.sol * RESERVE_FACTOR);
    s.inFlight = null;
    const others = await resolveDeferred(s, null);
    note(s, `Reconciled: the trade did not land.${others} Paused — resume when ready.`, 'info');
    changed(s);
    return { ok: true, message: s.note! };
  });
}

/**
 * The user confirms the wallet's balance change as the session's (critic #8
 * fallback, and the way out for a fill the chain cannot prove either way).
 * The session's bag becomes the wallet's balance minus what was excluded; an
 * adopted buy's cost is the SOL it asked for (the room stays spent), an
 * adopted sell's proceeds are unknown and booked as nothing. Pessimistic on
 * purpose, and the trade log says so.
 *
 * With nothing in flight or settling it is "Fit to wallet" (review #3): the
 * bag only ever SHRINKS to what the wallet holds (tokens moved out, a sell
 * the ledger could not read) — a session never claims tokens it cannot prove
 * it bought.
 */
export async function adopt(id: string): Promise<{ ok: boolean; message: string }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  if (s.mode !== 'live') return { ok: false, message: 'Only a live session has a balance to adopt.' };
  return locks.run(s.id, async () => {
    const rail = railFor(s);
    if (!rail) return { ok: false, message: `Krypto Trader cannot reach ${chainName(s.options.chain)} in this build.` };
    const pending = s.inFlight !== null || s.unsettled.length > 0;
    if (!pending && big(s.book.tokensRaw) <= 0n) return { ok: false, message: 'Nothing to adopt.' };
    const bal = await rail.tokenBalanceRaw(s.options.walletId, s.options.mint);
    if (bal === null) return { ok: false, message: 'The wallet’s balance could not be read. Try again.' };
    // Fills that may have been the in-flight trade: the one on its side
    // nearest its time is the session's (the balance below counts it); the
    // rest are not, and are excluded first.
    const own = s.inFlight ? nearestDeferred(s.deferred, s.inFlight.side, s.inFlight.at) : null;
    const others = await resolveDeferred(s, own?.signature ?? null);
    const claim = big(bal) - big(s.excludedRaw);
    const want = claim > 0n ? claim : 0n;
    const held = big(s.book.tokensRaw);
    const now = host!.now();
    if (!pending) {
      if (want >= held) {
        if (others) changed(s);
        return { ok: false, message: `Nothing to adopt: the wallet holds the session’s whole bag.${others}` };
      }
      applySellFill(s.book, { tokensRaw: (held - want).toString(), proceedsSol: 0 });
      pushTrade(s, logLine(s, { side: 'sell', ok: true, message: 'fitted to the wallet: tokens the session booked are no longer in it (moved out or sold elsewhere) — proceeds unknown, booked as nothing', reason: 'fit to wallet by you', by: 'user', tokensRaw: (held - want).toString() }));
      if (s.status === 'running') s.status = 'paused';
      note(s, `Fitted to the wallet: the session’s bag is now what the wallet holds.${others} Paused — resume when ready.`, 'info');
      changed(s);
      return { ok: true, message: s.note! };
    }
    const buys = [...(s.inFlight?.side === 'buy' ? [s.inFlight.sol ?? 0] : []), ...s.unsettled.filter((u) => u.side === 'buy').map((u) => u.sol ?? 0)];
    const spent = buys.reduce((a, b) => a + b, 0);
    if (want > held) applyBuyFill(s.book, { tokensRaw: (want - held).toString(), costSol: spent, at: now, decimals: s.book.decimals });
    else if (want < held) applySellFill(s.book, { tokensRaw: (held - want).toString(), proceedsSol: 0 });
    s.book.pendingSol = 0;
    s.inFlight = null;
    s.unsettled = [];
    s.deferred = [];
    s.trades.unshift(logLine(s, { side: want >= held ? 'buy' : 'sell', ok: true, message: 'adopted the balance change (cost/proceeds not read from the chain)', reason: 'adopted by you', by: 'user', tokensRaw: (want > held ? want - held : held - want).toString(), sol: want > held ? spent : null }));
    if (s.status === 'running') s.status = 'paused';
    note(s, `Adopted the wallet’s balance change.${others} Paused — resume when ready.`, 'info');
    changed(s);
    return { ok: true, message: s.note! };
  });
}

// ─── the ledger: own fills settling, and hand trades on the pair ───────────

const FOREIGN_KEPT = 50;

function markForeign(s: TraderSession, sig: string | null): void {
  if (!sig) return;
  const chain = s.options.chain ?? 'solana';
  s.foreignSigs = [...s.foreignSigs.filter((x) => !sameAddress(chain, x, sig)), sig].slice(-FOREIGN_KEPT);
}

/** The deferred fill on `side` nearest `at`, or null. */
function nearestDeferred(list: TraderSession['deferred'], side: 'buy' | 'sell', at: number): TraderSession['deferred'][number] | null {
  let best: TraderSession['deferred'][number] | null = null;
  for (const d of list) if (d.side === side && (!best || Math.abs(d.at - at) < Math.abs(best.at - at))) best = d;
  return best;
}

/**
 * A fill on the session's (wallet, coin) that is not the session's: a hand
 * trade, the panic sell, another tool. A proven failure moved nothing. A buy
 * of known size is excluded; a sell (known size or not) shrinks the claim to
 * what the wallet still holds. Pauses the session (T23). The caller holds
 * the lock and persists.
 */
async function absorbForeign(s: TraderSession, f: { signature: string | null; side: 'buy' | 'sell'; state: TraderLedgerFill['state']; tokenDeltaRaw: string | null; failed?: boolean }): Promise<void> {
  if (f.failed) return;
  markForeign(s, f.signature);
  const known = f.state === 'reconciled' && f.tokenDeltaRaw !== null && /^-?\d+$/.test(f.tokenDeltaRaw);
  if (f.side === 'buy' && known) {
    const delta = BigInt(f.tokenDeltaRaw!);
    if (delta > 0n) s.excludedRaw = (big(s.excludedRaw) + delta).toString();
  }
  let fitted = false;
  if (f.side === 'sell') {
    const bal = (await railFor(s)?.tokenBalanceRaw(s.options.walletId, s.options.mint)) ?? null;
    if (bal !== null) {
      const b = big(bal);
      const held = big(s.book.tokensRaw);
      if (b < held) applySellFill(s.book, { tokensRaw: (held - b).toString(), proceedsSol: 0 });
      const ex = big(s.excludedRaw);
      const room = b > big(s.book.tokensRaw) ? b - big(s.book.tokensRaw) : 0n;
      s.excludedRaw = (ex < room ? ex : room).toString();
      fitted = true;
    }
  }
  if (s.status === 'running') s.status = 'paused';
  const tail =
    f.side === 'sell'
      ? fitted
        ? ' The session’s claim now fits what the wallet holds.'
        : ' The wallet’s balance could not be read — use Fit to wallet before selling.'
      : known
        ? ''
        : ' Its size could not be read.';
  note(s, `Paused: a ${f.side} of this coin from this wallet that was not the session’s (${(f.signature ?? '').slice(0, 8)}…).${tail}`, 'warn');
}

/** The in-flight trade is resolved (as `ownSig`, or as not landed): every
 *  other deferred fill was not the session's. Returns a sentence for the note. */
async function resolveDeferred(s: TraderSession, ownSig: string | null): Promise<string> {
  const rail = railFor(s);
  const chain = s.options.chain ?? 'solana';
  const rest = s.deferred.filter((d) => !(ownSig && sameAddress(chain, d.signature, ownSig)));
  s.deferred = [];
  let n = 0;
  for (const d of rest) {
    // As it settled; the ledger's row now, if that is all we have.
    const lf = d.state === 'reconciled' ? null : (rail?.ledgerFill(d.signature) ?? null);
    if (lf?.failed) continue;
    await absorbForeign(s, { signature: d.signature, side: d.side, state: lf?.state ?? d.state ?? 'unreconciled', tokenDeltaRaw: lf ? lf.tokenDeltaRaw : (d.tokenDeltaRaw ?? null) });
    n += 1;
  }
  return n ? ` ${n} other trade${n === 1 ? '' : 's'} of this coin since then ${n === 1 ? 'was' : 'were'} not the session’s — counted as yours.` : '';
}

/**
 * A fill settled in the ledger. For a live session on the same (wallet,
 * mint): its own unsettled trade is booked; any OTHER trade pauses it (T23)
 * — except while a trade from before a restart is still in flight, when a
 * fill since its time may BE that trade: it waits for Reconcile/Adopt
 * rather than being counted as a hand trade and then booked again
 * (review #2/#7).
 */
export function onLedgerFill(f: TraderLedgerFill): void {
  if (!host || f.state === 'pending') return;
  const chain: ChainKind = f.chain ?? 'solana';
  for (const s of sessions) {
    if ((s.options.chain ?? 'solana') !== chain) continue;
    if (s.mode !== 'live' || !sameAddress(chain, s.address, f.wallet) || !sameAddress(chain, s.options.mint, f.mint)) continue;
    if (s.wentLiveAt !== null && f.at < s.wentLiveAt) continue;
    void locks.run(s.id, async () => {
      // Under the lock, an execute in flight has finished and recorded its
      // signature — so "not ours" is decided on complete information.
      const mine = (x: string): boolean => sameAddress(chain, x, f.signature);
      if (f.signature && (s.book.signatures.some(mine) || s.unsettled.some((u) => mine(u.signature)))) {
        if (settleUnsettled(s)) changed(s);
        return;
      }
      if (f.signature && (s.foreignSigs.some(mine) || s.deferred.some((d) => mine(d.signature)))) return; // seen already
      if (f.failed) return; // proven not landed: nothing moved
      if (s.inFlight && f.signature && f.at >= s.inFlight.at - 5_000) {
        s.deferred.push({ signature: f.signature, side: f.side, at: f.at, state: f.state, tokenDeltaRaw: f.tokenDeltaRaw });
        note(s, `A ${f.side} of this coin settled (${f.signature.slice(0, 8)}…) while a trade from before the restart is unresolved — Reconcile or Adopt decides whether it was the session’s.`, 'info');
        changed(s);
        return;
      }
      await absorbForeign(s, f);
      changed(s);
    });
  }
}

/**
 * Book any unsettled trade the ledger has now settled. No RPC. Only a chain
 * proof (meta.err, a reverted receipt) says "did not land" (review #1/#14);
 * a terminal row with no proof either way stays unsettled, flagged, and
 * pauses the session for Adopt — its tokens are never booked on a guess and
 * its sold tokens never left on the book to be sold twice. True = changed.
 */
function settleUnsettled(s: TraderSession): boolean {
  const rail = railFor(s);
  if (!host || !rail || !s.unsettled.length) return false;
  let changedAny = false;
  const keep: typeof s.unsettled = [];
  for (const u of s.unsettled) {
    const f = rail.ledgerFill(u.signature);
    if (!f || f.state === 'pending') {
      keep.push(u);
      continue;
    }
    if (f.state === 'reconciled' && f.tokenDeltaRaw !== null && f.native !== null) {
      if (u.side === 'buy' && u.sol) release(s.book, u.sol * RESERVE_FACTOR);
      const raw = BigInt(f.tokenDeltaRaw);
      bookFill(s, u.side, { tokensRaw: (raw < 0n ? -raw : raw).toString(), native: f.native, decimals: f.decimals, feeNative: f.feeNative, signature: u.signature });
      note(s, `The ${u.side} ${u.signature.slice(0, 8)}… settled and is booked.`);
      changedAny = true;
    } else if (f.failed) {
      if (u.side === 'buy' && u.sol) release(s.book, u.sol * RESERVE_FACTOR);
      note(s, `The ${u.side} ${u.signature.slice(0, 8)}… failed on chain; nothing booked.`, 'info');
      changedAny = true;
    } else {
      // Landed or not, the ledger cannot say (an EVM sell whose proceeds
      // could not be read, a transaction never found…). Kept; the room a buy
      // reserved stays reserved.
      const why = f.note || 'the ledger could not read this fill';
      keep.push({ ...u, unprovable: why });
      if (!u.unprovable) {
        if (s.status === 'running') s.status = 'paused';
        note(s, `Paused: whether the ${u.side} ${u.signature.slice(0, 8)}… landed cannot be proven (${why}). Press Adopt to take the wallet’s balance change as the session’s.`, 'warn');
        changedAny = true;
      }
    }
  }
  s.unsettled = keep;
  return changedAny;
}

/** Book a confirmed fill. `native` is the chain's delta in whole coins (SOL
 *  from lamports, ETH/BNB from wei) — the chain's number, never the amount
 *  asked for (pnl-from-chain). */
function bookFill(s: TraderSession, side: 'buy' | 'sell', f: { tokensRaw: string; native: number; decimals: number | null; feeNative: number | null; signature: string }): void {
  const sol = Math.abs(f.native);
  const fees = sol * ((KRYPT_FEE_PCT + venueFeePct(s.lastVenue)) / 100) + (f.feeNative ?? 0);
  if (side === 'buy') applyBuyFill(s.book, { tokensRaw: f.tokensRaw, costSol: sol, at: host?.now() ?? Date.now(), decimals: f.decimals, feesSol: fees, signature: f.signature });
  else applySellFill(s.book, { tokensRaw: f.tokensRaw, proceedsSol: sol, feesSol: fees, signature: f.signature });
}

// ─── the loop ──────────────────────────────────────────────────────────────

export function startLoop(): void {
  if (timer) return;
  for (const s of sessions) if (s.status === 'running') railFor(s)?.watch(s.options.mint);
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
}

export function stopLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * One pass. ONE batched market read for every running session (the shared
 * price cache — no per-session RPC, no per-tick balance read, critic #18),
 * then every running session steps concurrently under its own lock.
 */
let ticking = false;

export async function tick(): Promise<void> {
  if (!host || store.failure()) return;
  // One pass at a time (review #12): a market read slower than the interval
  // must not stack another batch of reads on a provider already throttling.
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce(host);
  } finally {
    ticking = false;
  }
}

async function tickOnce(h: TraderHost): Promise<void> {
  for (const s of sessions) if (s.unsettled.length && !locks.busy(s.id) && settleUnsettled(s)) changed(s);
  // A paused session with a latched stop keeps trying to sell (review #4):
  // an exit is never abandoned — not to a failure streak, not to a pause.
  const running = sessions.filter((s) => (s.status === 'running' || (s.status === 'paused' && s.pendingExit !== null)) && !s.inFlight && !locks.busy(s.id));
  if (!running.length) return;
  // One batched read per chain; a coin is keyed by its chain too.
  const markets = new Map<string, TraderMarket | null>();
  const chains = [...new Set(running.map((s) => s.options.chain ?? 'solana'))];
  await Promise.all(
    chains.map(async (chain) => {
      const rail = railOf(chain);
      if (!rail) return;
      const mints = [...new Set(running.filter((s) => (s.options.chain ?? 'solana') === chain).map((s) => s.options.mint))];
      try {
        const got = await rail.markets(mints);
        for (const m of mints) markets.set(`${chain}:${m}`, got.get(m) ?? null);
      } catch {
        /* no read: every session on this chain sees no fresh price and holds */
      }
    }),
  );
  await stepAll(
    running.map((s) => s.id),
    (id) => {
      const s = find(id);
      if (!s) return Promise.resolve();
      return locks.run(id, () => step(s, markets.get(`${s.options.chain ?? 'solana'}:${s.options.mint}`) ?? null));
    },
    (id, e) => {
      const s = find(id);
      if (s) note(s, `error: ${e.message}`, 'warn');
    },
  );
  h.emit(list());
}

/** Take in a market read: price (only a fresh one moves the marks), venue, depth. */
function observe(s: TraderSession, m: TraderMarket | null, now: number): void {
  if (!m) return;
  if (m.venue !== null && s.lastVenue !== null && m.venue !== s.lastVenue) {
    // Graduation (or a pool move): no buy until a price is read from the
    // new venue AFTER this moment; exits stay allowed (T25). Depth resets —
    // the pool's quote vault is not comparable to the curve's virtual SOL.
    s.venueChangedAt = now;
    s.startDepthSol = m.depthSol;
    note(s, `The coin moved to ${m.venue === 'pool' ? 'its pool' : 'a curve'} — buys wait for a fresh price there.`, 'info');
  }
  if (m.venue !== null) s.lastVenue = m.venue;
  if (m.depthSol !== null) {
    s.lastDepthSol = m.depthSol;
    if (s.startDepthSol === null) s.startDepthSol = m.depthSol;
  }
  if (m.decimals !== null && s.book.decimals === null) s.book.decimals = m.decimals;
  if (m.priceSol !== null && m.priceSol > 0 && m.priceAt !== null && (s.lastPriceAt === null || m.priceAt >= s.lastPriceAt)) {
    s.lastPriceSol = m.priceSol;
    s.lastPriceAt = m.priceAt;
    if (now - m.priceAt <= STALE_PRICE_MS) {
      s.peakPriceSol = s.peakPriceSol === null ? m.priceSol : Math.max(s.peakPriceSol, m.priceSol);
      s.ai.lowPriceSol = s.ai.lowPriceSol === null ? m.priceSol : Math.min(s.ai.lowPriceSol, m.priceSol);
      if (s.holdBaseline.priceSol === null) s.holdBaseline.priceSol = m.priceSol;
    }
  }
}

function freshPrice(s: TraderSession, now: number): number | null {
  return s.lastPriceSol !== null && s.lastPriceAt !== null && now - s.lastPriceAt <= STALE_PRICE_MS ? s.lastPriceSol : null;
}

function viewOf(s: TraderSession, now: number): TraderView {
  if (s.rounds.day !== dayKey(now)) s.rounds = { day: dayKey(now), n: 0 };
  return {
    now,
    priceSol: freshPrice(s, now),
    venue: s.lastVenue,
    curvePct: s.lastVenue === 'curve' ? lastCurvePct.get(s.id) ?? null : null,
    budgetSol: s.options.budgetSol,
    roomSol: roomSol(s.book, s.options.budgetSol, s.options.reinvest),
    tokensRaw: s.book.tokensRaw,
    decimals: s.book.decimals,
    avgCostSol: avgCostSol(s.book),
    openCostSol: s.book.openCostSol,
    entrySolDone: s.entrySolDone,
    coreRaw: s.coreRaw,
    anchorPriceSol: s.anchorPriceSol,
    lastTrim: s.lastTrim,
    roundsToday: s.rounds.n,
    rungsDone: s.rungsDone,
    lotsBought: s.lotsBought,
    peakPriceSol: s.peakPriceSol,
    minBuy: traderMoney(s.options.chain).minBuy,
    unit: traderMoney(s.options.chain).symbol,
  };
}

/** Curve progress per session from the last read — display and the 95 % hold. */
const lastCurvePct = new Map<string, number | null>();

async function step(s: TraderSession, m: TraderMarket | null): Promise<void> {
  const h = host!;
  if (s.inFlight || s.status === 'stopped') return;
  if (s.status === 'paused') {
    // Paused: nothing new is decided, but a stop already latched still sells.
    if (!s.pendingExit) return;
    const now = h.now();
    observe(s, m, now);
    lastCurvePct.set(s.id, m?.curvePct ?? null);
    await runPendingExit(s, now);
    return;
  }
  const now = h.now();
  observe(s, m, now);
  lastCurvePct.set(s.id, m?.curvePct ?? null);

  // Stops — latched as a pending exit, never consumed while they cannot run.
  if (!s.pendingExit) {
    const due = stopDue({
      now,
      expiresAt: s.expiresAt,
      budgetSol: s.options.budgetSol,
      maxLossPct: s.options.maxLossPct,
      book: s.book,
      priceSol: s.lastPriceSol,
      priceAt: s.lastPriceAt,
      startDepthSol: s.startDepthSol,
      depthSol: m?.depthSol ?? null,
      poolGone: m?.poolGone === true,
      unit: traderMoney(s.options.chain).symbol,
    });
    if (due) {
      const held = big(s.book.tokensRaw) > 0n;
      if (due.kind === 'time_limit' && (!held || s.options.atExpiry === 'hold')) {
        s.status = 'stopped';
        note(s, held ? 'The time limit is up. Holding the bag, as you chose — Sell session bag sells it.' : 'The time limit is up. Stopped.', 'info');
        changed(s);
        return;
      }
      s.pendingExit = { ...due, since: now, lastWarnAt: null };
      note(s, `Stop: ${due.reason} — selling the session’s bag.`, 'warn');
    }
  }
  if (s.pendingExit) {
    await runPendingExit(s, now);
    return;
  }

  // Fix the trim core once the entry is done.
  const v = viewOf(s, now);
  if (s.coreRaw === null && entryDone(s.options.preset, s.options.params, v) && big(s.book.tokensRaw) > 0n && !s.unsettled.length) {
    const corePct = s.options.preset === 'trim' ? (s.options.params as { corePct: number }).corePct : 0;
    s.coreRaw = ((big(s.book.tokensRaw) * BigInt(Math.round(corePct * 100))) / 10_000n).toString();
    if (s.anchorPriceSol === null) s.anchorPriceSol = avgCostSol(s.book);
    v.coreRaw = s.coreRaw;
    v.anchorPriceSol = s.anchorPriceSol;
  }

  // The AI key is asked from here (outside the lock, answer through
  // `submit`); an MCP connection calls `submit` itself (trader_act). The
  // tick runs both drivers' stops above, whatever the driver says or doesn't.
  if (s.options.driver === 'ai') {
    maybeAsk(s, now);
    return;
  }
  if (s.options.driver !== 'strategy') return;
  const intent = presetIntent(s.options.preset, s.options.params, v);
  if (intent.action === 'hold') {
    if (s.note !== intent.reason) {
      s.note = intent.reason;
      s.seq += 1;
    }
    return;
  }
  // A refused intent (disarmed, no room, a limit…) changes only the note:
  // no full-file write and no extra emit every 5 s for as long as it lasts
  // (review #11) — the tick's one emit carries the note.
  const attemptBefore = s.lastAttemptAt;
  const noteBefore = s.note;
  await execute(s, intent, 'strategy');
  if (s.lastAttemptAt !== attemptBefore) changed(s);
  else if (s.note !== noteBefore) s.seq += 1;
}

/** Least time before a pending exit is tried again: 30 s, doubling with
 *  each failed attempt in a row, at most 5 minutes — never given up. */
function exitRetryMs(failStreak: number): number {
  return Math.min(EXIT_RETRY_MAX_MS, EXIT_RETRY_MS * 2 ** Math.max(0, Math.min(failStreak - 1, 10)));
}

async function runPendingExit(s: TraderSession, now: number): Promise<void> {
  const pe = s.pendingExit!;
  const finish = (): void => {
    s.status = pe.kind === 'liquidity' ? 'paused' : 'stopped';
    s.pendingExit = null;
    note(s, `${pe.reason} — the session’s bag is sold; ${s.status}.`, 'info');
    changed(s);
  };
  if (big(s.book.tokensRaw) <= 0n && !s.unsettled.some((u) => u.side === 'buy')) return finish();
  if (s.mode === 'live') {
    const rail = railFor(s);
    const blocked = rail ? rail.exitBlocked() : `${chainName(s.options.chain)} is not reachable in this build`;
    if (blocked) {
      if (dueForWarning(pe.lastWarnAt, now)) {
        pe.lastWarnAt = now;
        note(s, `Stop pending (${pe.reason}) — waiting: ${blocked}. It sells as soon as live execution is armed again.`, 'warn');
        changed(s);
      }
      return;
    }
  }
  if (s.lastAttemptAt !== null && now - s.lastAttemptAt < exitRetryMs(s.failStreak)) return;
  if (big(s.book.tokensRaw) <= 0n) return; // a buy is settling; its tokens join the exit when it does
  const r = await exitAll(s, pe.reason, 'stop', 'stop');
  if (r.ok && big(s.book.tokensRaw) === 0n && !s.unsettled.length) finish();
  else changed(s);
}

/**
 * Sell the whole session bag. A claim smaller than the wallet's balance is
 * sent as a percentage that rounds DOWN, so one pass can leave up to a basis
 * point of the pre-sale balance behind; the exit sells what remains, up to
 * three passes, and the last sub-basis-point dust is written off in doSell.
 */
async function exitAll(s: TraderSession, reason: string, tag: 'user' | 'stop', by: 'user' | 'stop'): Promise<{ ok: boolean; message: string }> {
  let r: { ok: boolean; message: string } = { ok: false, message: 'nothing to sell' };
  for (let pass = 0; pass < 3 && big(s.book.tokensRaw) > 0n; pass++) {
    r = await execute(s, { action: 'sell', pct: 100, reason: pass === 0 ? reason : `${reason} (the remainder)`, exit: true, tag }, by);
    if (!r.ok || s.unsettled.length) break;
  }
  return r;
}

// ─── one trade ─────────────────────────────────────────────────────────────

function checkContext(s: TraderSession, now: number, by: TraderDriver | 'user' | 'stop'): TraderCheckContext {
  const rail = railFor(s);
  const L = s.options.limits;
  const evm = (s.options.chain ?? 'solana') !== 'solana';
  const key = (x: string): string => (evm ? x.toLowerCase() : x);
  const mine = new Set([...s.book.signatures, ...s.unsettled.map((u) => u.signature)].map(key));
  const since = now - Math.max(L.crossWalletSec, 1) * 1000;
  const others: OtherFill[] =
    rail && (s.mode === 'live' || L.crossWalletSec > 0) ? rail.recentFills(s.options.mint, since).filter((f) => !(f.signature && mine.has(key(f.signature)))).map((f) => ({ side: f.side, at: f.at })) : [];
  const cap = rail ? rail.maxLive() : null;
  const per = Math.min(s.options.budgetSol, cap && cap > 0 ? cap : s.options.budgetSol);
  let buyHold: string | null = null;
  if (s.venueChangedAt !== null && (s.lastPriceAt === null || s.lastPriceAt <= s.venueChangedAt)) buyHold = 'the coin just changed venue — waiting for a fresh price there';
  const cp = lastCurvePct.get(s.id) ?? null;
  if (s.lastVenue === 'curve' && cp !== null && cp >= NEAR_GRAD_PCT) buyHold = `curve at ${Math.round(cp)}% — no buys near graduation`;
  return {
    now,
    driver: by === 'user' || by === 'stop' ? 'strategy' : by,
    limits: L,
    budgetSol: s.options.budgetSol,
    roomSol: roomSol(s.book, s.options.budgetSol, s.options.reinvest),
    depthSol: s.lastDepthSol,
    venue: s.lastVenue,
    priceSol: s.lastPriceSol,
    priceAt: s.lastPriceAt,
    tokensRaw: s.book.tokensRaw,
    avgCostSol: avgCostSol(s.book),
    lastTradeAt: s.lastTradeAt,
    lastAttemptAt: s.lastAttemptAt,
    lastBuyAt: s.lastBuyAt,
    lastSellAt: s.lastSellAt,
    lastBuyPriceSol: s.lastBuyPriceSol,
    lastSellPriceSol: s.lastSellPriceSol,
    tradeTimes: s.tradeTimes,
    buysWindow: s.buysWindow,
    losingAdds: s.losingAdds,
    maxLiveSol: cap,
    roundTripPct: roundTripCostPct(per, s.lastDepthSol, s.lastVenue),
    otherFills: others,
    buyHold: rail ? buyHold : `${chainName(s.options.chain)} is not reachable in this build`,
    unsettledSell: s.unsettled.some((u) => u.side === 'sell'),
    minBuy: traderMoney(s.options.chain).minBuy,
    unit: traderMoney(s.options.chain).symbol,
  };
}

function logLine(s: TraderSession, t: Partial<TraderTrade> & Pick<TraderTrade, 'side' | 'ok' | 'message' | 'reason' | 'by'>): TraderTrade {
  return {
    at: host?.now() ?? Date.now(),
    sol: null,
    tokensRaw: null,
    pct: null,
    walletPct: null,
    priceSol: s.lastPriceSol,
    mode: s.mode,
    signature: null,
    notes: [],
    ...t,
  };
}

function pushTrade(s: TraderSession, t: TraderTrade): void {
  s.ai.eventAt = t.at;
  s.trades.unshift(t);
  if (s.trades.length > MAX_TRADES_KEPT) s.trades.length = MAX_TRADES_KEPT;
}

/**
 * Run one intent through the guard, then the gates, then for real (or on
 * paper). The caller holds the session's lock.
 */
async function execute(s: TraderSession, raw: TraderIntent, by: TraderDriver | 'user' | 'stop'): Promise<{ ok: boolean; message: string }> {
  const now = host!.now();
  const c = checkTraderIntent(raw, checkContext(s, now, by));
  if (!c.ok) {
    note(s, `${raw.action} refused: ${c.reason}`);
    return { ok: false, message: s.note! };
  }
  const intent = c.intent;
  if (intent.action === 'hold') return { ok: true, message: intent.reason };
  if (s.mode === 'live') {
    // Two gates (K1): breakers block buys, never sells. Per chain: BNB's arm
    // switch is not Robinhood's, and neither is Solana's.
    const rail = railFor(s);
    const blocked = !rail ? `${chainName(s.options.chain)} is not reachable in this build` : intent.action === 'buy' ? rail.buyBlocked() : rail.exitBlocked();
    if (blocked) {
      note(s, `${intent.action} waiting: ${blocked}`);
      return { ok: false, message: s.note! };
    }
  }
  s.lastAttemptAt = now;
  s.tradeTimes = [...s.tradeTimes.filter((t) => now - t < 3_600_000), now];
  const r = intent.action === 'buy' ? await doBuy(s, intent, c.notes, by, now) : await doSell(s, intent, c.notes, by, now);
  if (!r.ok && r.counted) {
    s.failStreak += 1;
    if (s.failStreak >= FAIL_PAUSE && s.status === 'running') {
      s.status = 'paused';
      note(s, `${FAIL_PAUSE} failed trades in a row — paused.${s.pendingExit ? ' The stop keeps retrying its sell, backing off, until it works.' : ''} ${r.message}`, 'warn');
    }
  }
  return { ok: r.ok, message: r.message };
}

async function doBuy(s: TraderSession, intent: Extract<TraderIntent, { action: 'buy' }>, notes: string[], by: TraderDriver | 'user' | 'stop', now: number): Promise<{ ok: boolean; message: string; counted: boolean }> {
  const rail = railFor(s);
  const unit = traderMoney(s.options.chain).symbol;
  const px = s.lastPriceSol!;
  const underwater = (() => {
    const a = avgCostSol(s.book);
    return a !== null && px < a;
  })();
  const t = logLine(s, { side: 'buy', ok: false, message: '', reason: intent.reason, by, notes: [...notes] });
  let sent = intent.sol;
  let settledNow = false;
  if (!rail) return fail(s, t, `${chainName(s.options.chain)} is not reachable in this build`);
  if (s.mode === 'paper') {
    // Paper on an EVM chain is refused rather than invented when the token's
    // decimals are unknown: 18 is NOT assumed there (a wrong exponent is a
    // fill a million times off). pump coins are 6.
    const dec = s.book.decimals ?? (rail.evm ? null : 6);
    if (dec === null) return fail(s, t, 'the token’s decimals are not known yet — no paper fill is invented');
    const f = paperBuyFill(intent.sol, px, s.lastDepthSol, dec);
    if (!f) return fail(s, t, 'could not price the paper fill');
    applyBuyFill(s.book, { tokensRaw: f.tokensRaw, costSol: f.costSol, at: now, decimals: dec, feesSol: intent.sol * PAPER_SIDE_COST });
    if (!f.impactModelled) t.notes.push(PAPER_IMPACT_NOTE);
    t.ok = true;
    t.message = 'paper fill';
    t.sol = f.costSol;
    t.tokensRaw = f.tokensRaw;
    settledNow = true;
  } else {
    const reserved = reserve(s.book, intent.sol);
    s.inFlight = { intentId: `${now.toString(36)}b`, side: 'buy', at: now, sol: intent.sol, claimRaw: null };
    // On disk BEFORE the signature exists (K5) — or nothing is signed (review #10).
    if (!persistNow()) {
      release(s.book, reserved);
      s.inFlight = null;
      return fail(s, t, NOT_ON_DISK);
    }
    let r: TraderTradeResult & { sentSol: number | null };
    try {
      r = await rail.buy(s.options.walletId, s.options.mint, intent.sol);
    } catch (e) {
      r = { ok: false, message: (e as Error).message, signature: null, stage: null, sentSol: null };
    }
    // The engine may size a buy down to the per-trade cap and only log it:
    // give the room back down to what actually went out (critic #17).
    sent = r.sentSol !== null && r.sentSol > 0 && r.sentSol < intent.sol ? r.sentSol : intent.sol;
    if (sent < intent.sol) {
      release(s.book, reserved - sent * RESERVE_FACTOR);
      t.notes.push(`sized down to ${sent} ${unit} by the per-trade cap`);
    }
    t.message = r.message;
    t.signature = r.signature;
    if (r.signature && (r.ok || r.stage === 'pending')) {
      s.book.signatures.push(r.signature);
      const f = await rail.fill(r.signature);
      if (f) {
        release(s.book, sent * RESERVE_FACTOR);
        bookFill(s, 'buy', { tokensRaw: f.tokensRaw, native: f.native, decimals: f.decimals, feeNative: f.feeNative, signature: r.signature });
        t.sol = Math.abs(f.native);
        t.tokensRaw = f.tokensRaw;
        settledNow = true;
      } else {
        // Broadcast, not settled: the reservation stays, the tokens are not
        // the session's until the ledger says how many (never a guess).
        s.unsettled.push({ signature: r.signature, side: 'buy', at: now, sol: sent });
        t.notes.push('fill not settled yet — booked when the ledger reconciles it');
      }
      t.ok = true;
    } else {
      release(s.book, sent * RESERVE_FACTOR);
    }
    s.inFlight = null;
    if (!t.ok) {
      pushTrade(s, t);
      note(s, `buy failed: ${r.message}`, 'warn');
      return { ok: false, message: s.note!, counted: true };
    }
  }
  // Traded (pending counts as traded, K6).
  s.lastTradeAt = now;
  s.lastBuyAt = now;
  s.lastBuyPriceSol = px;
  s.failStreak = 0;
  s.buysWindow = [...s.buysWindow.filter((b) => now - b.at < 86_400_000), { at: now, sol: sent }];
  if (intent.tag === 'entry') s.entrySolDone += sent;
  if (intent.tag === 'lot') s.lotsBought += 1;
  if (intent.tag === 'rebuy') s.lastTrim = null;
  if ((by === 'ai' || by === 'mcp') && underwater) s.losingAdds += 1;
  if (s.holdBaseline.priceSol === null) s.holdBaseline.priceSol = px;
  pushTrade(s, t);
  note(s, `bought ${sent} ${unit} — ${intent.reason}${settledNow ? '' : ' (settling)'}`, 'info');
  return { ok: true, message: s.note!, counted: false };
}

async function doSell(s: TraderSession, intent: Extract<TraderIntent, { action: 'sell' }>, notes: string[], by: TraderDriver | 'user' | 'stop', now: number): Promise<{ ok: boolean; message: string; counted: boolean }> {
  const rail = railFor(s);
  const claim = claimRawForPct(s.book.tokensRaw, intent.pct);
  const t = logLine(s, { side: 'sell', ok: false, message: '', reason: intent.reason, by, notes: [...notes], pct: intent.pct });
  if (claim <= 0n) return fail(s, t, 'the sell rounds to nothing');
  if (!rail) return fail(s, t, `${chainName(s.options.chain)} is not reachable in this build`);
  const px = s.lastPriceSol;
  let proceeds: number | null = null;
  if (s.mode === 'paper') {
    if (!px) return fail(s, t, 'no price to fill a paper sell at');
    const dec = s.book.decimals ?? (rail.evm ? null : 6);
    if (dec === null) return fail(s, t, 'the token’s decimals are not known yet — no paper fill is invented');
    const f = paperSellFill(claim, dec, px, s.lastDepthSol);
    if (!f) return fail(s, t, 'could not price the paper fill');
    applySellFill(s.book, { tokensRaw: claim.toString(), proceedsSol: f.proceedsSol, feesSol: (f.proceedsSol / (1 - PAPER_SIDE_COST)) * PAPER_SIDE_COST });
    if (!f.impactModelled) t.notes.push(PAPER_IMPACT_NOTE);
    proceeds = f.proceedsSol;
    t.ok = true;
    t.message = 'paper fill';
    t.sol = f.proceedsSol;
    t.tokensRaw = claim.toString();
  } else {
    s.inFlight = { intentId: `${now.toString(36)}s`, side: 'sell', at: now, sol: null, claimRaw: claim.toString() };
    // On disk BEFORE the signature exists (K5) — or nothing is signed (review #10).
    if (!persistNow()) {
      s.inFlight = null;
      return fail(s, t, NOT_ON_DISK);
    }
    let r: TraderTradeResult & { walletPct: number | null; balanceRaw: string | null; soldRaw: string | null };
    try {
      // Solana: a wallet % that rounds DOWN (pctForClaim). EVM: exactly the
      // claim in base units (capped at what the wallet holds).
      r = await rail.sell(s.options.walletId, s.options.mint, claim);
    } catch (e) {
      r = { ok: false, message: (e as Error).message, signature: null, stage: null, walletPct: null, balanceRaw: null, soldRaw: null };
    }
    t.walletPct = r.walletPct;
    t.message = r.message;
    t.signature = r.signature;
    if (rail.evm && r.soldRaw !== null && big(r.soldRaw) < claim) t.notes.push(`sold ${r.soldRaw} of the ${claim} base units claimed (the rail's sell quantum or what the wallet held)`);
    if (r.balanceRaw !== null && big(r.balanceRaw) < claim) t.notes.push('the wallet held less than the session’s claim (a hand sell?) — sold what it held');
    if (r.signature && (r.ok || r.stage === 'pending')) {
      s.book.signatures.push(r.signature);
      const f = await rail.fill(r.signature);
      if (f) {
        bookFill(s, 'sell', { tokensRaw: f.tokensRaw, native: f.native, decimals: f.decimals, feeNative: f.feeNative, signature: r.signature });
        proceeds = Math.abs(f.native);
        t.sol = proceeds;
        t.tokensRaw = f.tokensRaw;
        // A sell that rounds DOWN leaves the session a remainder. Under one
        // basis point of what the wallet still holds, the rail can never
        // sell it without selling the user's tokens too — so after an exit
        // it is written off to the user's side (excluded, cost realised),
        // or the session could never finish. The log says so.
        const left = big(s.book.tokensRaw);
        const after = r.balanceRaw !== null ? big(r.balanceRaw) - big(f.tokensRaw) : null;
        if (!rail.evm && intent.exit && left > 0n && after !== null && left * 10_000n < after) {
          applySellFill(s.book, { tokensRaw: left.toString(), proceedsSol: 0 });
          s.excludedRaw = (big(s.excludedRaw) + left).toString();
          t.notes.push(`${left} base units of dust stay in the wallet (under 0.01% of its balance, which the sell rail cannot size) — now counted as yours`);
        }
        // EVM sells are exact, so only four.meme's 1e9 sell quantum can leave
        // a remainder — under 1e9 base units, which no sell can move.
        if (rail.evm && intent.exit && left > 0n && left < EVM_SELL_DUST_RAW) {
          applySellFill(s.book, { tokensRaw: left.toString(), proceedsSol: 0 });
          s.excludedRaw = (big(s.excludedRaw) + left).toString();
          t.notes.push(`${left} base units of dust stay in the wallet (under four.meme's 1e9 sell quantum) — now counted as yours`);
        }
        // The exit sold everything the wallet had and the book still claims
        // more: those tokens are not in the wallet (moved out, or a sell the
        // ledger could not read). Written off as gone — proceeds unknown,
        // booked as nothing — or the session could never finish (review #3).
        const rest = big(s.book.tokensRaw);
        if (intent.exit && rest > 0n && after !== null && after <= 0n) {
          applySellFill(s.book, { tokensRaw: rest.toString(), proceedsSol: 0 });
          t.notes.push(`${rest} base units the session had booked were not in the wallet — written off as gone (proceeds unknown, booked as nothing)`);
        }
      } else {
        s.unsettled.push({ signature: r.signature, side: 'sell', at: now, sol: null });
        t.notes.push('fill not settled yet — booked when the ledger reconciles it');
      }
      t.ok = true;
    }
    s.inFlight = null;
    // Nothing was sent, and an exit can never succeed as asked: the wallet
    // holds none of the coin, or the claim is dust the rail cannot size.
    // Written off so the session can finish — the user always has a way out
    // (review #3). Only on a balance actually READ; an unread one sells and
    // writes off nothing.
    if (!t.ok && !r.signature && intent.exit && r.balanceRaw !== null && /^\d+$/.test(r.balanceRaw)) {
      const bal = big(r.balanceRaw);
      if (bal === 0n) {
        applySellFill(s.book, { tokensRaw: claim.toString(), proceedsSol: 0 });
        t.ok = true;
        t.tokensRaw = claim.toString();
        t.notes.push(`the wallet holds none of this coin — the session’s ${claim} base units are written off as gone (moved out of the wallet or sold elsewhere; proceeds unknown, booked as nothing)`);
      } else if ((!rail.evm && claim * 10_000n < bal) || (rail.evm && claim < EVM_SELL_DUST_RAW)) {
        applySellFill(s.book, { tokensRaw: claim.toString(), proceedsSol: 0 });
        s.excludedRaw = (big(s.excludedRaw) + claim).toString();
        t.ok = true;
        t.tokensRaw = claim.toString();
        t.notes.push(`${claim} base units of dust stay in the wallet (too small for the sell rail to size) — now counted as yours`);
      }
    }
    if (!t.ok) {
      pushTrade(s, t);
      note(s, `sell failed: ${r.message}`, 'warn');
      return { ok: false, message: s.note!, counted: true };
    }
  }
  s.lastTradeAt = now;
  s.lastSellAt = now;
  s.lastSellPriceSol = px;
  s.failStreak = 0;
  if (intent.tag === 'trim' && px) {
    s.anchorPriceSol = Math.max(s.anchorPriceSol ?? px, px);
    s.lastTrim = { priceSol: px, solOut: proceeds ?? 0 };
    s.rounds.n += 1;
  }
  if (intent.tag === 'rung' && intent.rung !== undefined) s.rungsDone = [...s.rungsDone, intent.rung];
  pushTrade(s, t);
  note(s, `sold ${intent.pct}% of the bag — ${intent.reason}`, 'info');
  // A preset that never buys back is done once its bag is gone.
  if (s.options.driver === 'strategy' && !intent.exit && s.options.preset !== 'trim' && big(s.book.tokensRaw) === 0n && !s.unsettled.length) {
    s.status = 'stopped';
    note(s, `${intent.reason} — the bag is sold; session stopped.`, 'info');
  }
  return { ok: true, message: s.note!, counted: false };
}

const NOT_ON_DISK = 'the in-flight record could not be written to disk, so nothing was signed (a live trade is never sent without it) — it is tried again next time';

function fail(s: TraderSession, t: TraderTrade, why: string): { ok: boolean; message: string; counted: boolean } {
  t.message = why;
  pushTrade(s, t);
  note(s, `${t.side} failed: ${why}`, 'warn');
  return { ok: false, message: s.note!, counted: true };
}

// ─── drivers outside the tick (stage 3 seam) ───────────────────────────────

/**
 * An intent from the AI or MCP driver, run under the session's lock through
 * the same guard. Stage 3 wraps this: the AI loop and `trader_act` (which
 * checks `expected_seq` against `seq` first). No goal, no prompt here.
 */
export async function submit(id: string, intent: TraderIntent, by: 'ai' | 'mcp', expectedSeq?: number, opts: { askedAt?: number; mode?: TraderSession['mode'] } = {}): Promise<{ ok: boolean; message: string; seq?: number }> {
  const s = find(id);
  if (!s || !host) return { ok: false, message: 'No such session.' };
  return locks.run(s.id, async () => {
    if (s.options.driver !== by) return { ok: false, message: `That session is driven by ${s.options.driver}, not ${by}.` };
    if (s.status !== 'running') return { ok: false, message: `That session is ${s.status}.` };
    if (s.inFlight) return { ok: false, message: 'A trade is in flight.' };
    if (expectedSeq !== undefined && expectedSeq !== s.seq) return { ok: false, message: `Stale: the session is at seq ${s.seq}, not ${expectedSeq}.`, seq: s.seq };
    // A decision made on paper is never executed live (review #6/#18).
    if (opts.mode !== undefined && opts.mode !== s.mode) return { ok: false, message: `Stale: the session went ${s.mode} after this was decided — dropped.`, seq: s.seq };
    // An AI answer to facts older than the session's last trade is stale:
    // the book it reasoned about is gone. It is dropped, never re-asked here.
    if (opts.askedAt !== undefined && Math.max(s.lastAttemptAt ?? 0, s.lastTradeAt ?? 0) > opts.askedAt) {
      return { ok: false, message: 'Stale: the session traded after the AI looked — its answer is dropped.', seq: s.seq };
    }
    if (intent.action === 'hold') {
      note(s, `hold — ${intent.reason}`);
      changed(s);
      return { ok: true, message: s.note!, seq: s.seq };
    }
    // A driver outside the tick trades on a market read of its own moment.
    const seq0 = s.seq;
    const mode0 = s.mode;
    try {
      const rail = railFor(s);
      if (rail) observe(s, (await rail.markets([s.options.mint])).get(s.options.mint) ?? null, host!.now());
    } catch {
      /* no read: the guard refuses on the stale price */
    }
    // Re-checked after the read: nothing that changes the session outside
    // this lock (pause, a driver or mode change) may slip under the decision.
    if (s.mode !== mode0 || s.seq !== seq0 || s.status !== 'running' || s.options.driver !== by) {
      return { ok: false, message: 'Stale: the session changed while the market was read — dropped.', seq: s.seq };
    }
    const r = await execute(s, intent, by);
    changed(s);
    return { ...r, seq: s.seq };
  });
}

// ─── the AI driver (stage 3) ───────────────────────────────────────────────
//
// The AI key proposes; the guard disposes. An ask is decided in the tick
// (traderAiDue: a real move, an own fill/fail, a new high/low, near the stop,
// the model's own next_check_sec, a 5-minute heartbeat — held back by the
// user's AI pacing with a 5 s floor and by the day's spend cap). The ask slot
// is reserved BEFORE the await; the HTTP call runs outside the session's lock
// (so Sell session bag never waits 30 s behind a model); the answer comes
// back through `submit(…, 'ai')` under the lock, into the same guard every
// driver meets. A refusal, a cut-off or an unusable reply is a hold. The
// spend cap pauses ASKS only: stops, the time limit and Sell session bag keep
// working. Nothing here imports Krypto Mode: its prompts never reach a trader
// session (T20).

const aiRuns = new Map<string, Promise<void>>();

function roundTripFor(s: TraderSession): number | null {
  const cap = railFor(s)?.maxLive() ?? null;
  const per = Math.min(s.options.budgetSol, cap && cap > 0 ? cap : s.options.budgetSol);
  return roundTripCostPct(per, s.lastDepthSol, s.lastVenue);
}

function rollAiDay(s: TraderSession, now: number): void {
  const day = dayKey(now);
  if (s.aiSpend.day !== day) {
    s.aiSpend = { day, usd: 0 };
    s.ai.asksToday = 0;
    s.ai.pausedReason = null;
  }
}

/** Decide in the tick; ask outside the lock. */
function maybeAsk(s: TraderSession, now: number): void {
  if (aiRuns.has(s.id) || !host) return;
  rollAiDay(s, now);
  const due = traderAiDue({
    now,
    limits: s.options.limits,
    ai: s.ai,
    priceSol: freshPrice(s, now),
    peakPriceSol: s.peakPriceSol,
    stopPriceSol: stopPriceSol(s.book, s.options.budgetSol, s.options.maxLossPct),
    floorPct: oppositeFloorPct(s.options.limits, s.lastVenue, roundTripFor(s)),
    spentTodayUsd: s.aiSpend.usd,
    dailyCapUsd: s.options.aiDailyUsdCap,
  });
  if (!due.ask) {
    const paused = due.why && due.why.startsWith('AI paused') ? due.why : null;
    if (paused !== s.ai.pausedReason) {
      s.ai.pausedReason = paused;
      if (paused) note(s, paused, 'info');
      s.seq += 1;
    }
    return;
  }
  // The slot is taken BEFORE the await: a second tick cannot ask again.
  const a = s.ai;
  a.pausedReason = null;
  a.lastAskAt = now;
  a.askTimes = [...a.askTimes.filter((t) => now - t < 3_600_000), now];
  a.askPriceSol = freshPrice(s, now) ?? a.askPriceSol;
  a.askHighSol = s.peakPriceSol;
  a.askLowSol = a.lowPriceSol;
  a.nextCheckAt = null;
  // Seen by this ask; a trade that lands after it (the answer's own) sets it again.
  a.eventAt = null;
  a.lastTrigger = due.trigger;
  a.asksToday += 1;
  const run = askAi(s.id, now, s.mode).finally(() => {
    aiRuns.delete(s.id);
  });
  aiRuns.set(s.id, run);
}

async function askAi(id: string, askedAt: number, askedMode: TraderSession['mode']): Promise<void> {
  const h = host;
  const s0 = find(id);
  const rail = s0 ? railFor(s0) : null;
  if (!h || !s0 || !rail) return;
  let mf: TraderMarketFacts = EMPTY_MARKET_FACTS;
  try {
    mf = await rail.marketFacts(s0.options.mint);
  } catch {
    /* numbers the market read could not give are nulls, never zeros */
  }
  const facts = traderAiFacts(s0, mf, { now: h.now(), maxLiveSol: rail.maxLive(), roundTripPct: roundTripFor(s0), curvePct: lastCurvePct.get(id) ?? null });
  let r: TraderAiAnswer | null;
  try {
    // The facts' money keys and the style line name the session's coin.
    r = await h.askTrader(traderFacts(facts), s0.options.aiModel, traderAiStyleFor(s0.options.preset, s0.options.chain ?? 'solana'));
  } catch (e) {
    r = { ok: false, message: `AI request failed: ${(e as Error).message}`, model: s0.options.aiModel, usd: null, refusal: false, cutOff: false };
  }
  const out: { intent: TraderIntent | null } = { intent: null };
  await locks.run(id, async () => {
    const s = find(id);
    if (!s) return;
    const now = h.now();
    rollAiDay(s, now);
    if (r === null) {
      s.ai.lastError = 'No AI key is set (Settings → AI) — the session holds; its stops keep running.';
      s.ai.lastAction = 'hold';
      changed(s);
      return;
    }
    // Billed whatever the answer was: count it first.
    if (r.usd !== null && r.usd > 0) s.aiSpend.usd = Math.round((s.aiSpend.usd + r.usd) * 1e6) / 1e6;
    s.ai.lastModel = r.model;
    if (!r.ok || typeof r.text !== 'string') {
      s.ai.lastError = r.refusal ? 'The model declined to answer (refusal) — holding.' : r.cutOff ? 'The reply was cut off at the token limit — holding.' : `AI: ${r.message} — holding.`;
      s.ai.lastAction = 'hold';
      changed(s);
      return;
    }
    const parsed = parseTraderAiReply(r.text);
    if (!parsed) {
      s.ai.lastError = 'The AI reply was not the exact JSON asked for — holding.';
      s.ai.lastAction = 'hold';
      changed(s);
      return;
    }
    s.ai.lastError = null;
    s.ai.lastAction = parsed.intent.action;
    s.ai.lastReason = parsed.intent.reason;
    s.ai.nextCheckAt = now + parsed.nextCheckSec * 1000;
    out.intent = parsed.intent;
    changed(s);
  });
  if (out.intent) await submit(id, out.intent, 'ai', undefined, { askedAt, mode: askedMode });
}

/** What the AI host answers. `null` from `askTrader` = no key for this model. */
export interface TraderAiAnswer {
  ok: boolean;
  message: string;
  text?: string;
  model: string | null;
  /** USD this call cost (from its usage), or null when it never reached the provider. */
  usd: number | null;
  refusal: boolean;
  cutOff: boolean;
}

/** The facts a driver sees for this session, now (the MCP read tool's view too). */
export async function factsFor(id: string): Promise<TraderAiFacts | null> {
  const s = find(id);
  const rail = s ? railFor(s) : null;
  if (!s || !host) return null;
  let mf: TraderMarketFacts = EMPTY_MARKET_FACTS;
  try {
    if (rail) mf = await rail.marketFacts(s.options.mint);
  } catch {
    /* nulls */
  }
  return traderAiFacts(s, mf, { now: host.now(), maxLiveSol: rail ? rail.maxLive() : null, roundTripPct: roundTripFor(s), curvePct: lastCurvePct.get(id) ?? null });
}

/** The session as an MCP read tool reports it: no secret, no creator text.
 *  The chain and its coin are named, and on BNB / Robinhood every money key
 *  says that coin (`budget_bnb`…) — trader_act's `sol` means it there too. */
export function mcpSummary(s: TraderSession): Record<string, unknown> {
  const d = traderDerived(s, host?.now() ?? Date.now());
  return traderNativeKeys(mcpSummaryRaw(s, d), s.options.chain);
}

function mcpSummaryRaw(s: TraderSession, d: ReturnType<typeof traderDerived>): Record<string, unknown> {
  return {
    session_id: s.id,
    seq: s.seq,
    chain: s.options.chain ?? 'solana',
    money_unit: traderMoney(s.options.chain).symbol,
    mint: s.options.mint,
    wallet: s.address,
    driver: s.options.driver,
    preset: s.options.preset,
    mode: s.mode,
    status: s.status,
    budget_sol: s.options.budgetSol,
    tokens: d.tokens,
    open_cost_sol: s.book.openCostSol,
    realised_sol: s.book.realisedSol,
    unrealised_sol: d.unrealisedSol,
    room_sol: d.roomSol,
    takes_trader_act: s.options.driver === 'mcp' && s.status === 'running',
  };
}

export function mcpList(): Record<string, unknown>[] {
  return sessions.map(mcpSummary);
}

/** One session for get_trader_session: facts, envelope, seq, the last 20 fills, what is left of its budgets. */
export async function mcpDetail(id: string): Promise<Record<string, unknown> | null> {
  const s = find(id);
  if (!s || !host) return null;
  const facts = await factsFor(id);
  const now = host.now();
  const L = s.options.limits;
  const buys24h = s.buysWindow.filter((b) => now - b.at < 86_400_000).reduce((a, b) => a + b.sol, 0);
  return traderNativeKeys({
    ...mcpSummary(s),
    note: s.note,
    facts,
    envelope: {
      budget_sol: s.options.budgetSol,
      max_loss_pct: s.options.maxLossPct,
      time_limit_h: s.options.timeLimitH,
      expires_at: new Date(s.expiresAt).toISOString(),
      at_expiry: s.options.atExpiry,
      reinvest_profit: s.options.reinvest,
      limits: L,
    },
    last_fills: s.trades.slice(0, 20).map((t) => ({ at: new Date(t.at).toISOString(), side: t.side, sol: t.sol, pct_of_bag: t.pct, price_sol: t.priceSol, ok: t.ok, by: t.by, reason: t.reason, notes: t.notes })),
    session_budget: {
      room_sol: roomSol(s.book, s.options.budgetSol, s.options.reinvest),
      buys_24h_sol: buys24h,
      buys_24h_left_sol: L.maxDailyBuysX > 0 ? Math.max(0, s.options.budgetSol * L.maxDailyBuysX - buys24h) : null,
    },
  }, s.options.chain);
}

/** A coin is (chain, address): one 0x address on BNB and on Robinhood is two coins. */
function sameCoin(s: TraderSession, chain: ChainKind, mint: string): boolean {
  return (s.options.chain ?? 'solana') === chain && sameAddress(chain, s.options.mint, mint);
}

/** The driver/status/mode/seq an MCP trade is checked against, in order (design §8). */
export function mcpGate(id: string): { driver: TraderDriver; status: TraderSession['status']; mode: TraderSession['mode']; seq: number } | null {
  const s = find(id);
  return s ? { driver: s.options.driver, status: s.status, mode: s.mode, seq: s.seq } : null;
}

/** For the tests: wait until no AI ask is in flight. */
export async function _aiIdle(): Promise<void> {
  while (aiRuns.size) await Promise.all([...aiRuns.values()]);
}

/** For the tests. */
export function _reset(): void {
  stopLoop();
  aiRuns.clear();
  host = null;
  loadedDir = null;
  sessions = [];
  locks.clear();
  lastCurvePct.clear();
  ticking = false;
  store.reset();
}

/** For the tests: the stored object, not a copy. */
export function _session(id: string): TraderSession | null {
  return find(id);
}

export { TRADER_OWN_COIN_MESSAGE };
