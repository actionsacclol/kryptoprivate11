// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — measured rug rules (2026-08-30).
//
// Pure rules, no I/O. Every number in here was MEASURED on the held-out
// tape day 2026-07-27 (27,937 pump.fun launches with at least one trade,
// not graduated at +60 s) after the rules were chosen on 07-25/26 — see
// docs/rug-filter-2026-08-30.md. They are observed rates, not predictions,
// and they must be re-measured when the regime moves (docs/insight-swarm).
//
// Why these and not dev % / top-10 % / bundled % / sniper %: on the same
// held-out day every supply-share threshold has lift BELOW 1 for "dead or
// dumped" and, used together as a hide, they conceal 57 % of graduations.
// Concentration predicts VOLATILITY (both directions) and is reported by
// volatilityNotes() with both numbers — never as a hide.
//
// Honest-null rule: an input we do not know leaves its rule "unknown";
// unknown never fires and never counts as pass.
// ──────────────────────────────────────────────────────────────────────

import type { LaunchTrade } from './launchintel';

/** The day the rates below were measured on. Shown beside every number. */
export const RUG_RULES_MEASURED_ON = '2026-07-27';
/** The population every rate refers to. */
export const RUG_RULES_POPULATION =
  'pump.fun launches on 2026-07-27 with at least one trade in the first 60 s, not yet graduated (n = 27,937), from a feed that misses 10–20 % of trades';

export type RugRuleId =
  | 'one_buy_dominates' // R1
  | 'sells_over_buys' // R2
  | 'creator_sold_empty_curve' // R3
  | 'few_buyers_big_sol' // R4
  | 'factory_creator'; // R5

export type RugRuleState = 'fired' | 'clear' | 'unknown';

/** What the terminal knows about a launch at the evaluation window. */
export interface RugInputs {
  /** Seconds after the first trade the inputs were frozen at. Rates were
   *  measured at 60; other windows are shown with a caveat. */
  windowS: number;
  /** Trades observed inside the window. Counts are FLOORS on a lossy feed. */
  trades: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  /** SOL bought / sold inside the window (event SOL, fees excluded). */
  buySol: number;
  sellSol: number;
  /** Largest single buy inside the window, SOL. */
  largestBuySol: number;
  /** Creator has at least one sell inside the window. Null = creator unknown. */
  creatorSold: boolean | null;
  /** Token-side bonding-curve progress 0..1 at the window. Null = not read. */
  curveProgress: number | null;
  /** Creator's PRIOR launches and graduations (any source). Null = unknown. */
  creatorLaunches: number | null;
  creatorGraduations: number | null;
  /** True when the trade scan reached the token's genuine first trade. */
  complete: boolean;
}

export interface RugFlag {
  id: RugRuleId;
  /** Short badge text. */
  label: string;
  /** The full measured line, ready to render. */
  detail: string;
  /** Observed on the measured day, for the flagged set. */
  badPct: number;
  deadPct: number;
  gradPct: number;
  n: number;
  /** 'hide' = in the default Discover hide set (R1–R4); 'warn' = shown only. */
  severity: 'hide' | 'warn';
}

export interface RugReport {
  windowS: number;
  measuredOn: string;
  population: string;
  flags: RugFlag[];
  /** Per-rule state, so the UI can show "—" for what could not be judged. */
  states: Record<RugRuleId, RugRuleState>;
  /** True when at least one 'hide'-severity rule fired. */
  hide: boolean;
  /** Trades the judgement rests on; render "from N trades seen" on a live tape. */
  tradesSeen: number;
}

interface RuleSpec {
  id: RugRuleId;
  label: string;
  severity: 'hide' | 'warn';
  badPct: number;
  deadPct: number;
  gradPct: number;
  n: number;
  /** Plain-English condition, used in the detail line. */
  condition: string;
  test: (i: RugInputs) => RugRuleState;
}

const known = (v: number | boolean | null | undefined): boolean => v !== null && v !== undefined;

export const RUG_RULES: readonly RuleSpec[] = [
  {
    id: 'one_buy_dominates',
    label: 'One buy is half the SOL',
    severity: 'hide',
    badPct: 90,
    deadPct: 90,
    gradPct: 0.2,
    n: 12_844,
    condition: "one wallet's single buy is ≥ 50 % of all SOL bought so far",
    test: (i) => {
      if (i.buys === 0 || i.buySol <= 0) return i.trades === 0 && !i.complete ? 'unknown' : 'clear';
      return i.largestBuySol / i.buySol >= 0.5 ? 'fired' : 'clear';
    },
  },
  {
    id: 'sells_over_buys',
    label: 'Sells outnumber buys',
    severity: 'hide',
    badPct: 93,
    deadPct: 95,
    gradPct: 0.7,
    n: 1_946,
    condition: 'sells ≥ 1.5× buys',
    test: (i) => {
      if (i.buys === 0) return i.sells > 0 ? 'fired' : i.trades === 0 && !i.complete ? 'unknown' : 'clear';
      return i.sells / i.buys >= 1.5 ? 'fired' : 'clear';
    },
  },
  {
    id: 'creator_sold_empty_curve',
    label: 'Creator sold, curve empty',
    severity: 'hide',
    badPct: 91,
    deadPct: 93,
    gradPct: 0.3,
    n: 9_163,
    condition: 'the creator has already sold and the curve is < 2 % filled',
    test: (i) => {
      if (!known(i.creatorSold) || !known(i.curveProgress)) return 'unknown';
      return i.creatorSold === true && (i.curveProgress as number) < 0.02 ? 'fired' : 'clear';
    },
  },
  {
    id: 'few_buyers_big_sol',
    label: 'Wash volume',
    severity: 'hide',
    badPct: 94,
    deadPct: 95,
    gradPct: 0.1,
    n: 944,
    condition: '≤ 2 buyers but ≥ 3 SOL bought',
    test: (i) => {
      if (i.trades === 0 && !i.complete) return 'unknown';
      return i.uniqueBuyers <= 2 && i.buySol >= 3 ? 'fired' : 'clear';
    },
  },
  {
    id: 'factory_creator',
    label: 'Launch factory',
    severity: 'warn',
    badPct: 92,
    deadPct: 93,
    gradPct: 0.5,
    n: 6_117,
    condition: 'the creator has ≥ 30 prior launches and none graduated',
    test: (i) => {
      if (!known(i.creatorLaunches) || !known(i.creatorGraduations)) return 'unknown';
      return (i.creatorLaunches as number) >= 30 && (i.creatorGraduations as number) === 0 ? 'fired' : 'clear';
    },
  },
];

function pctText(v: number): string {
  return v < 1 ? `${v.toFixed(1)} %` : `${Math.round(v)} %`;
}

export function ruleDetail(r: RuleSpec, windowS: number): string {
  const win = windowS === 60 ? '' : ` (measured at 60 s; you are seeing it at ${windowS} s)`;
  return `${r.condition[0].toUpperCase()}${r.condition.slice(1)} — ${pctText(r.badPct)} of such launches were dead or dumped, ${pctText(r.gradPct)} graduated (n = ${r.n.toLocaleString('en-US')}, ${RUG_RULES_MEASURED_ON})${win}`;
}

/**
 * Evaluate the rules. Never throws. Unknown inputs leave a rule 'unknown':
 * it does not fire and it does not count as clear.
 */
export function evaluateRugRules(i: RugInputs): RugReport {
  const states = {} as Record<RugRuleId, RugRuleState>;
  const flags: RugFlag[] = [];
  for (const r of RUG_RULES) {
    let st: RugRuleState = 'unknown';
    try {
      st = r.test(i);
    } catch {
      st = 'unknown';
    }
    states[r.id] = st;
    if (st === 'fired') {
      flags.push({
        id: r.id,
        label: r.label,
        detail: ruleDetail(r, i.windowS),
        badPct: r.badPct,
        deadPct: r.deadPct,
        gradPct: r.gradPct,
        n: r.n,
        severity: r.severity,
      });
    }
  }
  return {
    windowS: i.windowS,
    measuredOn: RUG_RULES_MEASURED_ON,
    population: RUG_RULES_POPULATION,
    flags,
    states,
    hide: flags.some((f) => f.severity === 'hide'),
    tradesSeen: i.trades,
  };
}

/** What hiding on R1–R4 costs and buys, for the filter bar. Held-out day. */
export const HIDE_TRADEOFF = {
  deadRemovedPct: 70,
  graduationsHiddenPct: 9.6,
  residualBadPct: 77,
  text: 'Hides launches matching the four measured rug rules: removes about 70 % of launches that die within 10 minutes and about 1 in 10 future graduations. What remains is still ~77 % dead or dumped — a filter, not a safety net.',
} as const;

/**
 * Build rule inputs from a launch's trade list (the same list
 * shared/launchintel.ts analyses), frozen at `windowS` seconds after the
 * first trade. `creator` null ⇒ creatorSold unknown.
 */
export function rugInputsFromTrades(
  trades: LaunchTrade[],
  opts: {
    creator: string | null;
    curveProgress: number | null;
    creatorLaunches: number | null;
    creatorGraduations: number | null;
    complete: boolean;
    windowS?: number;
  },
): RugInputs {
  const windowS = opts.windowS ?? 60;
  const sorted = [...trades].sort((a, b) => a.ts - b.ts || a.slot - b.slot);
  const t0 = sorted[0]?.ts ?? null;
  const inWindow = t0 === null ? [] : sorted.filter((t) => t.ts - t0 <= windowS * 1000);
  const buyers = new Set<string>();
  let buys = 0;
  let sells = 0;
  let buySol = 0;
  let sellSol = 0;
  let largest = 0;
  let creatorSold: boolean | null = opts.creator ? false : null;
  for (const t of inWindow) {
    if (t.isBuy) {
      buys += 1;
      buySol += t.sol;
      if (t.sol > largest) largest = t.sol;
      buyers.add(t.user);
    } else {
      sells += 1;
      sellSol += t.sol;
      if (opts.creator && t.user === opts.creator) creatorSold = true;
    }
  }
  return {
    windowS,
    trades: inWindow.length,
    buys,
    sells,
    uniqueBuyers: buyers.size,
    buySol,
    sellSol,
    largestBuySol: largest,
    creatorSold,
    curveProgress: opts.curveProgress,
    creatorLaunches: opts.creatorLaunches,
    creatorGraduations: opts.creatorGraduations,
    complete: opts.complete,
  };
}

// ── Volatility (concentration) — shown with BOTH numbers, never a hide ──

export interface VolatilityNote {
  id: 'top3' | 'bundle' | 'sniper' | 'creator_holds' | 'creator_sold';
  label: string;
  detail: string;
  /** Of launches still alive at 60 s (≥ 10 buyers, ≥ 1 SOL net; n = 3,603). */
  dumpedPct: number;
  gradPct: number;
  n: number;
}

/** Population for the volatility lines. */
export const VOLATILITY_POPULATION =
  'launches still alive at 60 s on 2026-07-27 (≥ 10 buyers, ≥ 1 SOL net in the curve; n = 3,603; base: 31 % dumped, 7.4 % graduated)';

/**
 * Concentration facts with their measured two-sided rates. Inputs are
 * percentages of supply (0..100) or null when unknown.
 */
export function volatilityNotes(i: {
  top3Pct: number | null;
  bundlePct: number | null;
  sniperPct: number | null;
  creatorHoldsPct: number | null;
  creatorSold: boolean | null;
}): VolatilityNote[] {
  const out: VolatilityNote[] = [];
  if (i.top3Pct !== null && i.top3Pct >= 25) {
    out.push({
      id: 'top3',
      label: 'Top-3 hold ≥ 25 %',
      detail: 'Top-3 wallets hold ≥ 25 % — of launches alive at 60 s, 75 % dumped within 30 min and 22 % graduated (n = 207). Volatile both ways.',
      dumpedPct: 75,
      gradPct: 22,
      n: 207,
    });
  }
  if (i.bundlePct !== null && i.bundlePct >= 40) {
    out.push({
      id: 'bundle',
      label: '≥ 40 % bundled',
      detail: '≥ 40 % of supply bought in the launch block — of alive launches, 63 % dumped, 20 % graduated (n = 212).',
      dumpedPct: 63,
      gradPct: 20,
      n: 212,
    });
  }
  if (i.sniperPct !== null && i.sniperPct >= 25) {
    out.push({
      id: 'sniper',
      label: '≥ 25 % sniped',
      detail: '≥ 25 % sniped in the first 20 slots — of alive launches, 38 % dumped vs 26 % otherwise; 9 % graduated (n = 1,662). Weak signal.',
      dumpedPct: 38,
      gradPct: 9,
      n: 1_662,
    });
  }
  if (i.creatorHoldsPct !== null && i.creatorHoldsPct >= 10) {
    out.push({
      id: 'creator_holds',
      label: 'Creator holds ≥ 10 %',
      detail: 'Creator holds ≥ 10 % — of alive launches, 39 % dumped, 21 % graduated (n = 141).',
      dumpedPct: 39,
      gradPct: 21,
      n: 141,
    });
  }
  if (i.creatorSold === true) {
    out.push({
      id: 'creator_sold',
      label: 'Creator sold',
      detail: 'Creator sold within 60 s — 87 % of such launches died or dumped, but so did 85 % of all launches; 1.6 % graduated (n = 18,762). Baseline on its own.',
      dumpedPct: 87,
      gradPct: 1.6,
      n: 18_762,
    });
  }
  return out;
}

/** Signals that carry no measured edge and must never enter a score. */
export const NO_EDGE_NOTE =
  'Socials, DEX-paid and KOL / "smart money" buys have no measured edge here: socials show no effect on dying (84 % vs 85 %) and hide half of graduations if used as a filter; watched "smart" wallets were under water 83 % of the time at 5 min. Shown as facts, excluded from every score.';
