// Retroactive launch intel — the orchestrator.
//
// Joins three sources into one answer to "who got in first, and did they
// leave":
//
//   swap-api trades   → the launch window            (providers/pumpswap)
//   pure cohort math  → dev / bundle / sniper        (@shared/launchintel)
//   one getMultipleAccounts → what they hold NOW     (keyless RPC)
//
// The third step is the one that turns a scary number into a useful one.
// "40% bought in the launch block" is meaningless on its own — that is normal
// for a bundled launch that then distributed. "40% bought in the launch block
// and 38% of supply is still sitting in those 12 wallets" is the reason not to
// buy. So the cohorts carry both, and neither is ever inferred from the other.
//
// Cost: 1–2 pump.fun calls + 1 RPC call for a token page, on providers whose
// rate budget is not the tight one (GeckoTerminal's is). Nothing here runs for
// Discover rows.

import { ataFor, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/addresses';
import { getMultipleAccountsRaw } from '../chain/rpcClient';
import * as pf from './providers/pumpfun';
import * as ps from './providers/pumpswap';
import { cached, memo } from './http';
import * as onchain from './onchain';
import {
  analyseLaunch,
  applyBalances,
  emptyAnalysis,
  summariseCreator,
  SNIPER_WINDOW_SLOTS,
  type CreatorHistory,
  type CreatorLaunch,
  type LaunchAnalysis,
  type LaunchIntelReport,
} from '@shared/launchintel';
import {
  evaluateRugRules,
  rugInputsFromTrades,
  volatilityNotes,
  type RugReport,
  type VolatilityNote,
} from '@shared/rugrules';
import { oddsFeaturesFromTrades, scoreOdds, type OddsReport } from '@shared/odds';

/** Wallets we will price in one RPC round trip. `getMultipleAccounts` caps at
 *  100 keys per call and one call is the budget. */
const PRICE_LIMIT = 100;

const TTL_MS = 45_000;

function empty(mint: string, note: string): LaunchIntelReport {
  return {
    mint,
    creator: null,
    supply: null,
    analysis: emptyAnalysis(),
    sniperWindowSlots: SNIPER_WINDOW_SLOTS,
    source: 'none',
    note,
    balancesNote: null,
    generatedAt: Date.now(),
  };
}

/**
 * SPL token account layout — `amount` is a little-endian u64 at offset 64,
 * and Token-2022 keeps the same first 165 bytes before its extensions, so one
 * reader serves both.
 */
function tokenAccountAmount(buf: Buffer): bigint | null {
  if (buf.length < 72) return null;
  try {
    return buf.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

/**
 * Current balances for the early wallets, in one call.
 *
 * Derives each wallet's associated token account rather than asking the RPC
 * to search — `getTokenAccountsByOwner` is one call PER WALLET and
 * `getTokenLargestAccounts` is refused outright by both free endpoints
 * (429/403, measured). Deriving lets 100 wallets cost a single
 * `getMultipleAccounts`, which the same free endpoint serves in ~150ms.
 *
 * Caveat, stated because it bounds the claim: a wallet holding the token in
 * something other than its ATA reads as zero. That is rare for launch-window
 * buyers (every pump client uses the ATA) but it is a floor, not a certainty.
 */
async function priceWallets(
  httpUrl: string,
  mint: string,
  tokenProgram: string,
  decimals: number,
  wallets: string[],
): Promise<{ balances: Map<string, number>; note: string | null }> {
  if (!wallets.length) return { balances: new Map(), note: null };

  const ataToOwner = new Map<string, string>();
  for (const w of wallets) {
    try {
      ataToOwner.set(ataFor(w, mint, tokenProgram), w);
    } catch {
      // An unparseable address from a provider — skip it rather than throw.
    }
  }
  if (!ataToOwner.size) return { balances: new Map(), note: 'no derivable token accounts' };

  const res = await getMultipleAccountsRaw(httpUrl, [...ataToOwner.keys()]);
  if (!res.ok || !res.data) {
    return { balances: new Map(), note: `balances unavailable — ${res.message}` };
  }

  // The call succeeded, so an ATA the RPC did not return genuinely does not
  // exist: that wallet closed it, which means it holds zero. This is the one
  // place a missing value is honestly a zero, and only because the request
  // itself came back ok.
  const balances = new Map<string, number>();
  const scale = 10 ** decimals;
  for (const [ata, owner] of ataToOwner) {
    const buf = res.data.get(ata);
    if (!buf) {
      balances.set(owner, 0);
      continue;
    }
    const raw = tokenAccountAmount(buf);
    if (raw === null) continue;
    balances.set(owner, Number(raw) / scale);
  }
  return { balances, note: null };
}

/**
 * Launch analysis for any pump.fun mint, live or long dead.
 *
 * Refuses to report cohorts when the scan could not prove it reached the
 * token's first trade: the bundle is defined relative to the launch slot, and
 * a launch slot picked from the middle of a busy launch would produce
 * confident, wrong, unfalsifiable numbers.
 */
export async function launchIntel(mint: string, httpUrl: string): Promise<LaunchIntelReport> {
  const hit = await memo<LaunchIntelReport>(`li:${mint}`, TTL_MS, () => build(mint, httpUrl));
  return hit ?? empty(mint, 'analysis failed');
}

// ── The shared launch source ──────────────────────────────────────────
//
// Both the token page (`launchIntel`) and the rug filter (`rugReportFor`)
// need the same two things: the pump.fun coin record and the first ~100
// trades from the seek. They are fetched ONCE here and memoised, so a
// Discover row that was just rug-checked does not pay the seek again when
// the user opens it.

/** Why a mint has no launch window here. Null when it does. */
interface Located {
  coin: pf.PumpCoin;
  creator: string | null;
  createdAt: number;
}

/**
 * The coin record for intel paths — `pf.coinForIntel`, which is answered
 * from the row the `/coins?` LIST route already returned whenever one is in
 * hand, and only buys a `/coins/{mint}` when it is not.
 *
 * This used to be a local 60 s memo over `pf.coin()`, which meant every
 * Discover row bought back a record the list read had already delivered:
 * 45 `/coins/{mint}` a minute measured, 100 % of them redundant.
 */
const coinForIntel = pf.coinForIntel;

async function locate(mint: string): Promise<{ located: Located | null; note: string }> {
  const coin = await coinForIntel(mint);
  if (!coin) {
    return {
      located: null,
      note: 'Launch analysis covers pump.fun mints. This token was not launched there, or pump.fun does not index it.',
    };
  }
  // pump.fun indexes mints it did NOT launch — USDC comes back as
  // `program: 'non_launchpad'` with a placeholder creation date of
  // 2024-07-15 (measured). Seeking a launch window from a fabricated
  // timestamp produces confident nonsense, so these are refused by name.
  const program = coin.program ?? coin.protocol ?? null;
  if (program !== null && program !== 'pump' && program !== 'pump_amm') {
    return {
      located: null,
      note: `Launch analysis covers pump.fun launches. pump.fun indexes this mint as “${program}”, so it has no launch window here.`,
    };
  }
  const createdAt = typeof coin.created_timestamp === 'number' ? coin.created_timestamp : null;
  if (createdAt === null) return { located: null, note: 'pump.fun did not report a creation time for this mint.' };
  const creator = typeof coin.creator === 'string' && coin.creator ? coin.creator : null;
  return { located: { coin, creator, createdAt }, note: '' };
}

/** The seek, memoised: one launch scan per mint per TTL, whoever asks. */
function launchScan(mint: string, createdAt: number): Promise<ps.LaunchScan> {
  return memo<ps.LaunchScan>(`ls:${mint}`, TTL_MS, () => ps.launchTrades(mint, createdAt)).then(
    (s) => s ?? { trades: [], complete: false, calls: 0, message: 'request failed' },
  );
}

async function build(mint: string, httpUrl: string): Promise<LaunchIntelReport> {
  const { located, note } = await locate(mint);
  if (!located) return empty(mint, note);
  const { coin, creator, createdAt } = located;

  // Supply and decimals from the CHAIN, not from the API: the percentages all
  // divide by this, and a wrong denominator is a wrong answer everywhere.
  const facts = await onchain.mintFacts(httpUrl, mint);
  const decimals = facts.decimals ?? coin.base_decimals ?? 6;
  const supply =
    facts.uiSupply ??
    (typeof coin.total_supply === 'number' && coin.total_supply > 0 ? coin.total_supply / 10 ** decimals : null);
  const tokenProgram = facts.isToken2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;

  const scan = await launchScan(mint, createdAt);
  if (!scan.trades.length) {
    return {
      ...empty(
        mint,
        scan.message === 'no trades'
          ? 'No trades yet — nobody has bought this token.'
          : scan.message === 'the trade index does not reach this launch'
            ? `pump.fun's trade history does not reach this token's launch (${new Date(createdAt).toISOString().slice(0, 10)}). Launch cohorts cannot be measured for it.`
            : `Launch window unavailable — ${scan.message}.`,
      ),
      creator,
      supply,
    };
  }
  if (!scan.complete) {
    // Deliberately NOT partial cohorts. See the doc comment.
    return {
      ...empty(
        mint,
        `Too much launch traffic to isolate the first block — ${scan.message}. Bundle and sniper shares are not reported rather than guessed.`,
      ),
      creator,
      supply,
      source: 'pumpswap',
      analysis: { ...emptyAnalysis(), tradesScanned: scan.trades.length },
    };
  }

  let analysis = analyseLaunch(scan.trades, { creator, supply, complete: true });

  const toPrice = analysis.wallets
    .filter((w) => w.cohort !== 'early')
    .slice(0, PRICE_LIMIT)
    .map((w) => w.address);
  const { balances, note: balancesNote } = await priceWallets(httpUrl, mint, tokenProgram, decimals, toPrice);
  if (balances.size) analysis = applyBalances(analysis, balances, supply);

  return {
    mint,
    creator,
    supply,
    analysis,
    sniperWindowSlots: SNIPER_WINDOW_SLOTS,
    source: 'pumpswap',
    note: null,
    balancesNote: balancesNote ?? null,
    generatedAt: Date.now(),
  };
}

// ── Creator track record ──────────────────────────────────────────────

/**
 * Every pump.fun launch by this wallet, summarised.
 *
 * Scope stated honestly in the UI: this is pump.fun only. A creator who
 * launched ten tokens on LetsBonk and one here looks like a first-timer, and
 * there is no free cross-launchpad index to fix that with.
 */
export async function creatorHistory(creator: string): Promise<CreatorHistory | null> {
  return memo<CreatorHistory>(`ch:${creator}`, 120_000, async () => {
    const { coins, truncated } = await pf.byCreator(creator);
    if (!coins.length) return null;
    const launches: CreatorLaunch[] = coins.map((c) => ({
      mint: c.mint,
      symbol: c.symbol ?? null,
      name: c.name ?? null,
      createdAt: typeof c.created_timestamp === 'number' ? c.created_timestamp : 0,
      graduated: c.complete === true,
      athUsd: typeof c.ath_market_cap === 'number' && c.ath_market_cap > 0 ? c.ath_market_cap : null,
      marketCapUsd: typeof c.usd_market_cap === 'number' ? c.usd_market_cap : null,
    }));
    return summariseCreator(creator, launches, truncated);
  });
}

// ── Measured rug rules (shared/rugrules.ts) ───────────────────────────
//
// Cold path: everything a rule needs is computable from the pump.fun coin
// record plus the seeked first trades — no RPC, no live tape, no key. Every
// input the rules cannot get stays null so its rule reads "unknown" rather
// than "clear" (honest-null rule).

export interface RugIntel {
  /** Null = not judged (no trades, or the scan did not reach the launch and
   *  saw too few trades to say anything). */
  rug: RugReport | null;
  volatility: VolatilityNote[];
  /** Sum of the three largest non-creator bought shares, 0..100. */
  top3Pct: number | null;
}

const RUG_TTL_MS = 90_000;
/** The window the rates were measured at. */
const RUG_WINDOW_S = 60;
/** Below this, an incomplete scan is not judged at all. */
const MIN_TRADES_INCOMPLETE = 3;

/** pump.fun's initial virtual token reserve and the tokens the curve sells
 *  before graduation, both in UI units (6 decimals). */
const CURVE_INITIAL_VTOK = 1.073e9;
const CURVE_SELLABLE_TOK = 793.1e6;

/**
 * Token-side curve progress 0..1 from the coin record. Token-side rather
 * than SOL-side because that is the axis the rules were measured on
 * (docs/rug-filter-2026-08-30.md). Null when the reserve is not readable.
 */
export function curveProgressFromCoin(c: {
  complete?: boolean;
  virtual_token_reserves?: number;
  base_decimals?: number;
}): number | null {
  if (c.complete === true) return 1;
  const raw = c.virtual_token_reserves;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  const vTok = raw / 10 ** (c.base_decimals ?? 6);
  const p = (CURVE_INITIAL_VTOK - vTok) / CURVE_SELLABLE_TOK;
  if (!Number.isFinite(p)) return null;
  return Math.min(1, Math.max(0, p));
}

/**
 * A creator record from JUPITER's batched audit block. Every Discover row
 * and every token-page summary already carries it (`providers/jupiter.ts`
 * sets `s.audit.devMints` / `s.audit.devMigrations` from a call already
 * made), so passing it in costs nothing at all.
 *
 * Both counts INCLUDE the mint being judged, exactly like pump.fun's own
 * creator list does; the subtraction below is the same on either side.
 */
export interface DevRecord {
  /** Mints this dev has created, cross-launchpad. Null = Jupiter silent. */
  mints: number | null;
  /** How many of those graduated — "the useful half of devMints". */
  migrations: number | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Creator's PRIOR launches and graduations, from whichever records the
 * caller could supply for free.
 *
 * Two sources, both FLOORS, so the larger wins and a missing one only ever
 * makes R5 fire less:
 *
 *   • Jupiter's `audit.devMints` / `audit.devMigrations` — cross-launchpad,
 *     already on the row, no request;
 *   • pump.fun's creator list — pump-only, one `/coins?creator=` per
 *     creator, and therefore only ever fetched for a SINGLE mint the user
 *     actually opened (see `rugReportFor`).
 *
 * Until 2026-09-09 this read `h.devMints` off a `CreatorHistory` widened at
 * the call site to reach a field that interface does not declare — nothing
 * populated it, so the branch was dead while the per-row `/coins?creator=`
 * it stood next to cost 38 requests a minute.
 */
function priorLaunches(
  h: CreatorHistory | null,
  dev: DevRecord | null,
  mint: string,
  thisGraduated: boolean,
): { launches: number | null; graduations: number | null } {
  let launches: number | null = null;
  let graduations: number | null = null;

  if (h) {
    // The list is newest-first and this mint is on pump.fun, so it is in the
    // list whenever the list is non-empty; `recent` only holds 12 rows, so the
    // membership check is a confirmation, not the test.
    const listed = h.launches > 0 || h.recent?.some((l) => l.mint === mint) === true;
    launches = Math.max(0, h.launches - (listed ? 1 : 0));
    graduations = Math.max(0, h.graduated - (listed && thisGraduated ? 1 : 0));
  }

  if (dev && finite(dev.mints)) {
    const prior = Math.max(0, dev.mints - 1);
    launches = launches === null ? prior : Math.max(launches, prior);
  }
  if (dev && finite(dev.migrations)) {
    const prior = Math.max(0, dev.migrations - (thisGraduated ? 1 : 0));
    graduations = graduations === null ? prior : Math.max(graduations, prior);
  }

  return { launches, graduations };
}

/**
 * The rug report for one pump.fun mint, cold.
 *
 * Returns null when the mint has no launch window here (not a pump launch,
 * request failed). Returns `rug: null` when there IS a window but nothing
 * can honestly be judged. Memoised 90 s per mint; a launch younger than
 * 60 s is judged at the window that exists so far (`rug.windowS` says
 * which) and re-judged at 60 s when the memo lapses.
 */
export async function rugReportFor(
  mint: string,
  opts?: { creator?: string | null; createdAt?: number | null; dev?: DevRecord; creatorLookup?: boolean },
): Promise<{ rug: RugReport | null; volatility: VolatilityNote[]; top3Pct: number | null } | null> {
  // `dev` is the creator record the caller already holds (Jupiter's batched
  // audit block, free on every row). `creatorLookup: false` says "and do NOT
  // buy a pump.fun creator history on top of it" — which is what a LIST
  // caller must say, because that lookup is per row and lands on the same
  // 55/min window Discover's own feeds compete for. A single-mint caller
  // leaves it alone and gets both floors.
  const dev = opts?.dev ?? null;
  const lookup = opts?.creatorLookup !== false;
  try {
    // A caller that already knows the creation time (every Discover row does)
    // lets the age gate run with NO request at all.
    if (typeof opts?.createdAt === 'number' && Number.isFinite(opts.createdAt)) {
      const ageS = (Date.now() - opts.createdAt) / 1000;
      if (ageS < RUG_WINDOW_S) return { rug: null, volatility: [], top3Pct: null };
      const r = await memo<RugIntel>(`rug:${mint}`, RUG_TTL_MS, () => buildRug(mint, opts?.creator ?? null, dev, lookup));
      return r;
    }
    // The rules were measured at +60 s. Judging a 7-second-old launch — when
    // the only buy is the dev's — fires "one buy dominates" on everything, so
    // nothing is judged before the window exists (Discover shows no badge
    // rather than a wrong one). `locate` is memoised, so this pre-check is
    // free and, unlike the 90 s memo below, re-asks every refresh until 60 s.
    const { located } = await locate(mint);
    if (!located) return null;
    const ageS = (Date.now() - located.createdAt) / 1000;
    if (Number.isFinite(ageS) && ageS < RUG_WINDOW_S) return { rug: null, volatility: [], top3Pct: null };
    const r = await memo<RugIntel>(`rug:${mint}`, RUG_TTL_MS, () => buildRug(mint, opts?.creator ?? null, dev, lookup));
    // Launch-window rules describe launches NOT yet graduated; a token that
    // has completed its curve is outside that population. Keep the
    // concentration facts, drop the verdict.
    if (r && located.coin.complete === true) return { ...r, rug: null };
    return r;
  } catch {
    return null;
  }
}

async function buildRug(
  mint: string,
  creatorHint: string | null,
  dev: DevRecord | null,
  lookupCreator: boolean,
): Promise<RugIntel | null> {
  const { located } = await locate(mint);
  if (!located) return null;
  const { coin, createdAt } = located;
  const creator = located.creator ?? creatorHint;

  const scan = await launchScan(mint, createdAt);
  const trades = scan.trades;
  if (!trades.length) return { rug: null, volatility: [], top3Pct: null };
  if (!scan.complete && trades.length < MIN_TRADES_INCOMPLETE) return { rug: null, volatility: [], top3Pct: null };

  // The window: 60 s after the first trade, or however much of it exists.
  const t0 = trades.reduce((m, t) => (t.ts < m ? t.ts : m), Number.POSITIVE_INFINITY);
  const elapsedS = Number.isFinite(t0) ? Math.floor((Date.now() - t0) / 1000) : RUG_WINDOW_S;
  const windowS = Math.max(1, Math.min(RUG_WINDOW_S, elapsedS));

  const curveProgress = curveProgressFromCoin(coin);

  // The creator's track record. A list caller says `creatorLookup: false`
  // and its record comes entirely from Jupiter's audit counts, at no request
  // cost — this is the 38 requests a minute the per-row `/coins?creator=`
  // used to spend on the same 55/min list window Discover's own feeds
  // compete for. A single-mint caller also buys the deeper pump-only
  // history, which on the token page is the very fetch the security report
  // has already started (same 120 s memo key, so the two share one request).
  let history: CreatorHistory | null = null;
  if (lookupCreator && creator) {
    try {
      history = await creatorHistory(creator);
    } catch {
      history = null;
    }
  }
  const prior = priorLaunches(history, dev, mint, coin.complete === true);

  const inputs = rugInputsFromTrades(trades, {
    creator,
    curveProgress,
    creatorLaunches: prior.launches,
    creatorGraduations: prior.graduations,
    complete: scan.complete,
    windowS,
  });
  const rug = evaluateRugRules(inputs);

  // Concentration facts. Cohorts hang off the launch slot, so they are only
  // meaningful when the scan proved it reached the first trade — otherwise
  // they stay null and the volatility row stays empty of them.
  let top3Pct: number | null = null;
  let bundlePct: number | null = null;
  let sniperPct: number | null = null;
  let creatorHoldsPct: number | null = null;
  if (scan.complete) {
    // Prefer the token page's priced analysis when it is already in cache.
    const priced = cached<LaunchIntelReport>(`li:${mint}`);
    let analysis: LaunchAnalysis;
    if (priced && priced.analysis.complete && priced.analysis.tradesScanned > 0) {
      analysis = priced.analysis;
    } else {
      const decimals = coin.base_decimals ?? 6;
      const supply =
        typeof coin.total_supply === 'number' && coin.total_supply > 0 ? coin.total_supply / 10 ** decimals : null;
      analysis = analyseLaunch(trades, { creator, supply, complete: true });
    }
    top3Pct = analysis.top3BuyersPct ?? null;
    bundlePct = analysis.bundle.boughtPct;
    sniperPct = analysis.snipers.boughtPct;
    creatorHoldsPct = analysis.priced && analysis.dev.heldPct !== null ? analysis.dev.heldPct : analysis.dev.boughtPct;
  }

  const volatility = volatilityNotes({
    top3Pct,
    bundlePct,
    sniperPct,
    creatorHoldsPct,
    creatorSold: inputs.creatorSold,
  });

  return { rug, volatility, top3Pct };
}

/**
 * Rug reports for many mints (Discover rows). Bounded concurrency on top of
 * the per-host gates in http.ts, so a 40-row column cannot stampede
 * pump.fun. Never throws; a mint that fails maps to null.
 */
export async function rugReportsFor(
  mints: string[],
  opts?: { maxConcurrent?: number },
): Promise<Map<string, Awaited<ReturnType<typeof rugReportFor>>>> {
  const out = new Map<string, Awaited<ReturnType<typeof rugReportFor>>>();
  const unique = [...new Set(mints.filter((m) => typeof m === 'string' && m))];
  const width = Math.max(1, Math.min(opts?.maxConcurrent ?? 3, unique.length || 1));
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const mint = unique[next++];
      try {
        out.set(mint, await rugReportFor(mint));
      } catch {
        out.set(mint, null);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// ── Graduation odds (shared/odds.ts) ─────────────────────────────────
//
// Same cold path as the rug rules: the pump.fun coin record plus the seeked
// first trades, nothing else. The model was measured at +60 s and +120 s
// after create (docs/runner-odds-2026-08-30.md §7), so a launch is judged
// once each window exists and never before — a 20-second-old launch has no
// odds, not "base rate" odds. The memo key carries the window so the +60 s
// answer is not served at +120 s.

export type OddsWindow = 60 | 120;

const ODDS_TTL_MS = 90_000;

/**
 * Which measured window a launch of this age falls in. Null under 60 s —
 * the model has no table for that, and the number it would produce is
 * exactly the kind of confident guess the honest-null rule forbids.
 */
export function oddsWindowForAge(ageS: number): OddsWindow | null {
  if (!Number.isFinite(ageS) || ageS < 60) return null;
  return ageS >= 120 ? 120 : 60;
}

/**
 * The scoring context a coin record can supply, in the units the model
 * wants: supply in UI units, reserves RAW (the k-consistency check is
 * defined on raw reserves), curve progress token-side via the same reader
 * the rug rules use. `hasTwitter` is null when the record has no `twitter`
 * field at all (metadata not resolved) and false when it is present but
 * empty — the model treats those differently and so must we.
 */
export function oddsCtxFromCoin(
  c: Pick<
    pf.PumpCoin,
    'complete' | 'total_supply' | 'base_decimals' | 'virtual_sol_reserves' | 'virtual_token_reserves' | 'twitter'
  >,
): {
  supply: number | null;
  curveProgress: number | null;
  virtualSolReserves: number | null;
  virtualTokenReserves: number | null;
  hasTwitter: boolean | null;
} {
  const decimals = typeof c.base_decimals === 'number' && Number.isFinite(c.base_decimals) ? c.base_decimals : 6;
  const supply =
    typeof c.total_supply === 'number' && Number.isFinite(c.total_supply) && c.total_supply > 0
      ? c.total_supply / 10 ** decimals
      : null;
  const raw = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  let hasTwitter: boolean | null;
  if (!('twitter' in c) || c.twitter === undefined) hasTwitter = null;
  else hasTwitter = typeof c.twitter === 'string' && c.twitter.trim().length > 0;
  return {
    supply,
    curveProgress: curveProgressFromCoin(c),
    virtualSolReserves: raw(c.virtual_sol_reserves),
    virtualTokenReserves: raw(c.virtual_token_reserves),
    hasTwitter,
  };
}

/**
 * The create slot: the earliest trade's slot, and only when the scan proved
 * it reached the first trade. An incomplete scan's earliest trade is just
 * the earliest one we happened to see, and the dev-buy and sniper features
 * hang off this slot — so they stay null rather than wrong.
 */
export function oddsCreateSlot(trades: readonly { slot: number }[], complete: boolean): number | null {
  if (!complete || !trades.length) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const t of trades) if (Number.isFinite(t.slot) && t.slot < min) min = t.slot;
  return Number.isFinite(min) ? min : null;
}

/**
 * Graduation odds for one pump.fun mint, cold.
 *
 * Null when: not a pump launch, the record could not be located, the token
 * has graduated (the population is launches NOT yet graduated), the launch
 * is younger than 60 s, there are no trades, or an incomplete scan saw
 * fewer than three. Judged at +60 s and re-judged at +120 s; memoised 90 s
 * per mint AND window (`odds:60:<mint>`, `odds:120:<mint>`). Never throws.
 */
export async function oddsFor(
  mint: string,
  opts?: { creator?: string | null; createdAt?: number | null },
): Promise<OddsReport | null> {
  try {
    if (typeof opts?.createdAt === 'number' && Number.isFinite(opts.createdAt)) {
      const w = oddsWindowForAge((Date.now() - opts.createdAt) / 1000);
      if (w === null) return null;
      return await memo<OddsReport | null>(`odds:${w}:${mint}`, RUG_TTL_MS, () => buildOdds(mint, w, opts?.creator ?? null));
    }
    const { located } = await locate(mint);
    if (!located) return null;
    if (located.coin.complete === true) return null;
    const windowS = oddsWindowForAge((Date.now() - located.createdAt) / 1000);
    if (windowS === null) return null;
    return await memo<OddsReport>(`odds:${windowS}:${mint}`, ODDS_TTL_MS, () =>
      buildOdds(mint, windowS, opts?.creator ?? null),
    );
  } catch {
    return null;
  }
}

async function buildOdds(mint: string, windowS: OddsWindow, creatorHint: string | null): Promise<OddsReport | null> {
  const { located } = await locate(mint);
  if (!located) return null;
  const { coin, createdAt } = located;
  const creator = located.creator ?? creatorHint;

  const scan = await launchScan(mint, createdAt);
  const trades = scan.trades;
  if (!trades.length) return null;
  if (!scan.complete && trades.length < MIN_TRADES_INCOMPLETE) return null;

  const features = oddsFeaturesFromTrades(trades, {
    creator,
    ...oddsCtxFromCoin(coin),
    createSlot: oddsCreateSlot(trades, scan.complete),
    windowS,
  });
  return scoreOdds(features) ?? null;
}

/**
 * Odds for many mints (Discover rows), bounded like `rugReportsFor`. Never
 * throws; a mint that fails maps to null.
 */
export async function oddsForMany(
  mints: string[],
  opts?: { maxConcurrent?: number },
): Promise<Map<string, OddsReport | null>> {
  const out = new Map<string, OddsReport | null>();
  const unique = [...new Set(mints.filter((m) => typeof m === 'string' && m))];
  const width = Math.max(1, Math.min(opts?.maxConcurrent ?? 3, unique.length || 1));
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const mint = unique[next++];
      try {
        out.set(mint, await oddsFor(mint));
      } catch {
        out.set(mint, null);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
