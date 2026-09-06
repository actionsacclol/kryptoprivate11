// Launch intel — who bought the first blocks, and are they still holding.
//
// WHY THIS EXISTS. Until now `bundledPct` / `sniperPct` were only ever filled
// in for launches this install happened to watch live (see the old copy in
// `securityReport`: "only available for launches this install watched live").
// Search any contract address older than your session and every one of those
// rows rendered an em dash — the honest answer, but a useless one, and the
// single largest gap against the paid terminals.
//
// The gap turned out to be reachable without a key. Measured 2026-08-24:
//
//   • `swap-api.pump.fun/v2/coins/{mint}/trades` serves the FULL trade
//     history of any pump mint, newest-first, cursor-paginated. The cursor is
//     `<slotIndexId>-<timestampMs>` and it is a plain seek key — synthesising
//     one from the coin's creation timestamp lands directly on the launch, so
//     the first ~100 trades of a token that launched months ago cost ONE call.
//   • `slotIndexId.slice(0, 12)` is the Solana slot. Verified against
//     `getSlot` on the same trade: delta 0.
//   • The early buyers' CURRENT balances come from one keyless
//     `getMultipleAccounts` over their derived ATAs — the free RPC that
//     refuses `getTokenLargestAccounts` serves this happily.
//
// This file is the pure half: no network, no clock, no RPC. It takes trades
// in and produces cohorts, which is the part worth unit-testing, because the
// definitions below are judgement calls and a wrong one is a confident lie
// about someone's money.

/** One trade in a token's launch window, normalised away from any provider. */
export interface LaunchTrade {
  /** Solana slot. The whole analysis hangs off this. */
  slot: number;
  /** Epoch ms. */
  ts: number;
  /** Buyer/seller wallet (owner, not token account). */
  user: string;
  isBuy: boolean;
  /** Tokens, in UI units (decimals already applied). */
  base: number;
  /** SOL moved. */
  sol: number;
  /** 'pump' while on the bonding curve, 'pump_amm' after migration. */
  program: string;
  tx: string;
}

/**
 * How far past the launch slot a buy still counts as a snipe.
 *
 * 20 slots is about 8 seconds. The number is arbitrary in the way every
 * sniper metric is arbitrary — what matters is that it is STATED, applied
 * consistently, and shown to the user, rather than tuned until the output
 * looks alarming.
 */
export const SNIPER_WINDOW_SLOTS = 20;

/** A group of wallets that entered together. */
export interface LaunchCohort {
  wallets: number;
  /** Tokens bought during the window, UI units. */
  bought: number;
  /** % of total supply bought during the window. Null if supply is unknown. */
  boughtPct: number | null;
  /** SOL spent during the window. */
  sol: number;
  /** % of total supply these wallets hold NOW. Null until balances are priced. */
  heldPct: number | null;
  /** Of what they bought, the % they still hold. Null until priced. */
  retainedPct: number | null;
  /** How many of them still hold anything. Null until priced. */
  stillHolding: number | null;
}

export type Cohort = 'dev' | 'bundle' | 'sniper' | 'early';

export interface EarlyWallet {
  address: string;
  cohort: Cohort;
  /** Slot of this wallet's first buy. */
  firstSlot: number;
  /** Slots after the launch slot. 0 means the launch block itself. */
  slotOffset: number;
  bought: number;
  boughtPct: number | null;
  sol: number;
  /** Sold again inside the window we scanned. */
  soldInWindow: boolean;
  /** Current balance, UI units. Null until priced. */
  heldNow: number | null;
  heldPct: number | null;
}

export interface LaunchAnalysis {
  /** Slot of the first trade we saw. Null when there were no trades. */
  launchSlot: number | null;
  /** Epoch ms of the first trade. */
  launchTs: number | null;
  /** True when the scan reached the token's genuine first trade. */
  complete: boolean;
  tradesScanned: number;
  /** Slots spanned by the trades we analysed. */
  slotsSpanned: number;
  dev: LaunchCohort;
  bundle: LaunchCohort;
  snipers: LaunchCohort;
  /** Every wallet that bought in the window, largest first. */
  wallets: EarlyWallet[];
  /** True once balances have been applied. */
  priced: boolean;
  /**
   * Sum of the three largest NON-creator BOUGHT shares of supply, 0..100.
   * Null when supply is unknown or nobody but the creator bought. This is a
   * concentration (volatility) fact, never a hide criterion — see
   * shared/rugrules.ts volatilityNotes().
   */
  top3BuyersPct: number | null;
}

function emptyCohort(): LaunchCohort {
  return {
    wallets: 0,
    bought: 0,
    boughtPct: null,
    sol: 0,
    heldPct: null,
    retainedPct: null,
    stillHolding: null,
  };
}

export function emptyAnalysis(): LaunchAnalysis {
  return {
    launchSlot: null,
    launchTs: null,
    complete: false,
    tradesScanned: 0,
    slotsSpanned: 0,
    dev: emptyCohort(),
    bundle: emptyCohort(),
    snipers: emptyCohort(),
    wallets: [],
    priced: false,
    top3BuyersPct: null,
  };
}

/**
 * Sum of the three largest non-creator bought shares. Pure, so the token
 * page and the rug filter agree by construction. Null without supply.
 */
export function top3BuyersPct(wallets: EarlyWallet[]): number | null {
  const shares = wallets
    .filter((w) => w.cohort !== 'dev' && w.boughtPct !== null)
    .map((w) => w.boughtPct as number)
    .sort((a, b) => b - a)
    .slice(0, 3);
  if (!shares.length) return null;
  return shares.reduce((s, v) => s + v, 0);
}

export interface AnalyseOptions {
  /** The mint's creator, so the dev buy is never counted as a bundle. */
  creator: string | null;
  /** Total supply in UI units. Null ⇒ every percentage stays null. */
  supply: number | null;
  /** True when the caller knows it reached the first ever trade. */
  complete: boolean;
  sniperWindowSlots?: number;
}

function pct(part: number, whole: number | null): number | null {
  if (whole === null || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/**
 * Split a launch window into dev / bundle / sniper cohorts.
 *
 * The definitions, stated once so the UI can repeat them verbatim:
 *
 *   dev     — the creator's own wallet, whenever it bought inside the window.
 *   bundle  — wallets whose FIRST buy landed in the same slot as the very
 *             first trade. That slot is atomic: nobody reacted to a launch
 *             they could not yet see, so same-slot buys were arranged in
 *             advance. This is the number people mean by "bundled".
 *   sniper  — wallets whose first buy landed within SNIPER_WINDOW_SLOTS
 *             AFTER the launch slot. Fast, but reactive rather than
 *             pre-arranged. Kept separate because they are not the same
 *             accusation.
 *
 * A wallet is classified by its FIRST buy and keeps that label for the whole
 * window, so a bundler adding a second buy three slots later does not
 * silently become a sniper too. Trades are accepted in any order.
 */
export function analyseLaunch(trades: LaunchTrade[], opts: AnalyseOptions): LaunchAnalysis {
  const out = emptyAnalysis();
  out.complete = opts.complete;
  out.tradesScanned = trades.length;
  if (!trades.length) return out;

  const window = opts.sniperWindowSlots ?? SNIPER_WINDOW_SLOTS;
  const sorted = [...trades].sort((a, b) => a.slot - b.slot || a.ts - b.ts);
  const launchSlot = sorted[0].slot;
  out.launchSlot = launchSlot;
  out.launchTs = sorted[0].ts;
  out.slotsSpanned = sorted[sorted.length - 1].slot - launchSlot;

  interface Acc {
    firstSlot: number;
    bought: number;
    sol: number;
    sold: boolean;
  }
  const acc = new Map<string, Acc>();

  for (const t of sorted) {
    if (!t.user) continue;
    let a = acc.get(t.user);
    if (!a) {
      // A wallet whose first appearance is a SELL held before the window we
      // scanned — which means the scan is not really at the launch. Record it
      // so its sale is visible, but do not invent a purchase for it.
      a = { firstSlot: t.isBuy ? t.slot : Number.POSITIVE_INFINITY, bought: 0, sol: 0, sold: false };
      acc.set(t.user, a);
    }
    if (t.isBuy) {
      if (a.firstSlot === Number.POSITIVE_INFINITY) a.firstSlot = t.slot;
      a.bought += t.base;
      a.sol += t.sol;
    } else {
      a.sold = true;
    }
  }

  const creator = opts.creator;
  const wallets: EarlyWallet[] = [];

  for (const [address, a] of acc) {
    if (a.bought <= 0) continue;
    const isDev = creator !== null && address === creator;
    const offset = a.firstSlot - launchSlot;
    const cohort: Cohort = isDev
      ? 'dev'
      : offset <= 0
        ? 'bundle'
        : offset <= window
          ? 'sniper'
          : 'early';
    wallets.push({
      address,
      cohort,
      firstSlot: a.firstSlot,
      slotOffset: offset,
      bought: a.bought,
      boughtPct: pct(a.bought, opts.supply),
      sol: a.sol,
      soldInWindow: a.sold,
      heldNow: null,
      heldPct: null,
    });
  }

  wallets.sort((x, y) => y.bought - x.bought);
  out.wallets = wallets;
  out.top3BuyersPct = top3BuyersPct(wallets);

  for (const key of ['dev', 'bundle', 'sniper'] as const) {
    const group = wallets.filter((w) => w.cohort === key);
    const target = key === 'dev' ? out.dev : key === 'bundle' ? out.bundle : out.snipers;
    target.wallets = group.length;
    target.bought = group.reduce((s, w) => s + w.bought, 0);
    target.sol = group.reduce((s, w) => s + w.sol, 0);
    target.boughtPct = pct(target.bought, opts.supply);
  }

  return out;
}

/**
 * Fold current balances into an analysis.
 *
 * Separate from `analyseLaunch` because it comes from a different system (an
 * RPC, which can fail on its own) and because "bought 40% of supply in the
 * launch block" and "still holds 2% of it" are different claims with
 * different failure modes. A missing balance stays null; it is NOT read as
 * zero, which would turn an RPC hiccup into "they dumped everything".
 *
 * `balances` maps wallet address → current token balance in UI units.
 * Addresses absent from the map are unknown; a wallet with a genuinely
 * closed/empty account must be passed explicitly as 0.
 */
export function applyBalances(
  analysis: LaunchAnalysis,
  balances: Map<string, number>,
  supply: number | null,
): LaunchAnalysis {
  const wallets = analysis.wallets.map((w) => {
    const bal = balances.get(w.address);
    if (bal === undefined) return w;
    return { ...w, heldNow: bal, heldPct: pct(bal, supply) };
  });

  const out: LaunchAnalysis = { ...analysis, wallets, priced: true };

  for (const key of ['dev', 'bundle', 'sniper'] as const) {
    const group = wallets.filter((w) => w.cohort === key);
    const known = group.filter((w) => w.heldNow !== null);
    const src = key === 'dev' ? analysis.dev : key === 'bundle' ? analysis.bundle : analysis.snipers;
    const target: LaunchCohort = { ...src };
    if (!group.length || !known.length) {
      // Nothing priced — leave the held figures null rather than reporting a
      // confident 0% for a cohort we simply could not look up.
      target.heldPct = group.length ? null : 0;
      target.retainedPct = null;
      target.stillHolding = group.length ? null : 0;
    } else {
      const held = known.reduce((s, w) => s + (w.heldNow ?? 0), 0);
      target.heldPct = pct(held, supply);
      target.stillHolding = known.filter((w) => (w.heldNow ?? 0) > 0).length;
      const boughtByKnown = known.reduce((s, w) => s + w.bought, 0);
      target.retainedPct = boughtByKnown > 0 ? Math.min(100, (held / boughtByKnown) * 100) : null;
    }
    if (key === 'dev') out.dev = target;
    else if (key === 'bundle') out.bundle = target;
    else out.snipers = target;
  }

  return out;
}

/**
 * The whole answer for one mint, as it crosses IPC.
 *
 * `source` is deliberately its own narrow union rather than the terminal's
 * `DataSource`: these three are the only things that can ever produce this
 * report, and keeping it local avoids a type cycle with `shared/market.ts`.
 */
export type LaunchIntelSource = 'pumpswap' | 'engine' | 'none';

export interface LaunchIntelReport {
  mint: string;
  creator: string | null;
  /** Total supply, UI units. Null ⇒ every percentage in here is null. */
  supply: number | null;
  analysis: LaunchAnalysis;
  /** Stated so the UI can show the definition it is applying. */
  sniperWindowSlots: number;
  source: LaunchIntelSource;
  /** Why the analysis is missing or partial. Null when it is whole. */
  note: string | null;
  /** Why current balances are missing. Null when they were priced. */
  balancesNote: string | null;
  generatedAt: number;
}

// ── Creator track record ──────────────────────────────────────────────

export interface CreatorLaunch {
  mint: string;
  symbol: string | null;
  name: string | null;
  createdAt: number;
  graduated: boolean;
  /** All-time-high market cap in USD where the source reports it. */
  athUsd: number | null;
  marketCapUsd: number | null;
}

export interface CreatorHistory {
  address: string;
  /** Launches the SOURCE knows about, which is pump.fun only. */
  launches: number;
  graduated: number;
  /** 0..100, null when there are no launches to divide by. */
  graduationRate: number | null;
  firstLaunchAt: number | null;
  lastLaunchAt: number | null;
  /** Median ATH market cap in USD across launches that report one. */
  medianAthUsd: number | null;
  bestAthUsd: number | null;
  /** Most recent launches, newest first, for the table. */
  recent: CreatorLaunch[];
  /** True when the source paginated out — `launches` is then a floor. */
  truncated: boolean;
  /** Launches in the 24h before the newest one. Spam factories stand out. */
  launchesInBusiestDay: number;
}

export function summariseCreator(address: string, launches: CreatorLaunch[], truncated: boolean): CreatorHistory {
  const sorted = [...launches].sort((a, b) => b.createdAt - a.createdAt);
  const aths = sorted.map((l) => l.athUsd).filter((v): v is number => typeof v === 'number' && v > 0);
  aths.sort((a, b) => a - b);

  let busiest = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cutoff = sorted[i].createdAt - 86_400_000;
    let n = 0;
    for (let k = i; k < sorted.length && sorted[k].createdAt >= cutoff; k++) n++;
    if (n > busiest) busiest = n;
  }

  return {
    address,
    launches: sorted.length,
    graduated: sorted.filter((l) => l.graduated).length,
    graduationRate: sorted.length ? (sorted.filter((l) => l.graduated).length / sorted.length) * 100 : null,
    firstLaunchAt: sorted.length ? sorted[sorted.length - 1].createdAt : null,
    lastLaunchAt: sorted.length ? sorted[0].createdAt : null,
    medianAthUsd: aths.length ? aths[Math.floor(aths.length / 2)] : null,
    bestAthUsd: aths.length ? aths[aths.length - 1] : null,
    recent: sorted.slice(0, 12),
    truncated,
    launchesInBusiestDay: busiest,
  };
}

/**
 * The one-line verdict shown next to a creator.
 *
 * Deliberately conservative: a creator with a handful of launches and no
 * graduations is COMMON and not evidence of fraud, so that case says so
 * plainly instead of shouting. What earns a hard verdict is volume — dozens
 * of launches in a day is a factory, and that is a fact about behaviour
 * rather than an inference about intent.
 */
export function creatorVerdict(h: CreatorHistory | null): { verdict: 'pass' | 'warn' | 'fail' | null; detail: string } {
  if (!h) return { verdict: null, detail: 'Creator history unavailable.' };
  if (h.launches <= 1) {
    return { verdict: 'pass', detail: 'First launch from this wallet on pump.fun.' };
  }
  const grad = h.graduated;
  const rate = h.graduationRate ?? 0;
  if (h.launchesInBusiestDay >= 10) {
    return {
      verdict: 'fail',
      detail: `Launch factory — ${h.launchesInBusiestDay} launches inside 24h, ${grad} graduated of ${h.launches}.`,
    };
  }
  if (h.launches >= 8 && grad === 0) {
    return { verdict: 'fail', detail: `${h.launches} launches, none graduated.` };
  }
  if (grad === 0) {
    return { verdict: 'warn', detail: `${h.launches} prior launches, none graduated yet.` };
  }
  if (rate >= 20) {
    return { verdict: 'pass', detail: `${grad} of ${h.launches} launches graduated (${rate.toFixed(0)}%).` };
  }
  return { verdict: 'warn', detail: `${grad} of ${h.launches} launches graduated (${rate.toFixed(0)}%).` };
}
