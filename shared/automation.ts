// User automation: rules built without code, and scripts written in
// JavaScript — both running under the same budget, the same gates and the
// same order pipeline as a hand-placed trade.
//
// The shape follows copy trading, for the same reasons: a script starts in
// PAPER mode and disabled; every trade it makes goes through the engine's
// buy/sell path (fees injected, signer policy, breakers, loss guard); a live
// script never survives a restart armed; and every refusal is recorded with
// its reason, so the paper record can inform a real decision.
//
// What a script can never do: touch a key, sign anything itself, spend past
// its own budget, or reach the network. Code runs in a sandboxed renderer
// with no Node, no network and a message channel whose every request is
// checked here, in the main process, against the script's budget.
//
// This file is the single source of truth for what a rule or script can
// see and do: the field guide, the API table and the AI prompt pack are all
// generated from the tables below, so they cannot drift from the code.

import type { LaunchRow } from './types';
import type { RunnerFlag } from './runners';
import type { AlertKind } from './alerts';

export type ScriptKind = 'rules' | 'code';
export type ScriptMode = 'paper' | 'live';

/** The walls around a script. Every one is checked in main, per action. */
export interface ScriptBudget {
  /** Hard cap on one buy, SOL. A live script is also capped by execution.maxLiveSol. */
  maxSolPerTrade: number;
  /** Buys per calendar day. */
  maxBuysPerDay: number;
  /** Realised loss in a day that DISABLES the script, SOL. */
  maxLossSolPerDay: number;
  /** Positions this script may hold open at once. */
  maxOpenPositions: number;
  /** Any action (buy, sell, order, notify…) per minute — the runaway guard. */
  maxActionsPerMinute: number;
}

export const BUDGET_BOUNDS = {
  maxSolPerTrade: { min: 0.001, max: 50 },
  maxBuysPerDay: { min: 1, max: 500 },
  maxLossSolPerDay: { min: 0.01, max: 100 },
  maxOpenPositions: { min: 1, max: 50 },
  maxActionsPerMinute: { min: 1, max: 120 },
} as const;

export const DEFAULT_BUDGET: ScriptBudget = {
  maxSolPerTrade: 0.05,
  maxBuysPerDay: 20,
  maxLossSolPerDay: 0.5,
  maxOpenPositions: 5,
  maxActionsPerMinute: 30,
};

// ── Triggers ──────────────────────────────────────────────────────────

/** What a rule reacts to. The code API's events are the same list. */
export type RuleTrigger =
  | 'launch'
  | 'launch_update'
  | 'runner'
  | 'position'
  | 'tick'
  | 'leader_trade'
  | 'order'
  | 'alert'
  | 'schedule';

export const RULE_TRIGGERS: Array<{ id: RuleTrigger; label: string; hint: string; event: string }> = [
  { id: 'launch', label: 'New launch', hint: 'A token was just created (first sight)', event: 'launch' },
  { id: 'launch_update', label: 'Launch update', hint: 'A tracked launch traded — its flow and score moved', event: 'launchUpdate' },
  { id: 'runner', label: 'Runner flagged', hint: 'The scanner flagged a launch as a potential runner', event: 'runner' },
  { id: 'position', label: 'Open position', hint: 'Checked every few seconds over what this script holds, and on every fill', event: 'position' },
  { id: 'tick', label: 'Price tick', hint: 'The price of a token this script holds or subscribed to moved (at most once a second per token)', event: 'tick' },
  { id: 'leader_trade', label: 'Followed wallet traded', hint: 'A wallet followed on the Copy Trading page bought or sold', event: 'leaderTrade' },
  { id: 'order', label: 'Order changed', hint: 'One of your advanced orders triggered, filled, failed, expired or was cancelled', event: 'order' },
  { id: 'alert', label: 'Alert fired', hint: 'One of your price / market-cap / volume alerts fired', event: 'alert' },
  { id: 'schedule', label: 'Daily at a time', hint: 'Once a day at HH:MM local time', event: 'schedule' },
];

// ── Fields ────────────────────────────────────────────────────────────

export type RuleField =
  // token (launch feed)
  | 'ageSec'
  | 'score'
  | 'priceSol'
  | 'curvePct'
  | 'uniqueBuyers'
  | 'buys'
  | 'sells'
  | 'netInflowSol'
  | 'buyVolumeSol'
  | 'sellVolumeSol'
  | 'buyerAcceleration'
  | 'distinctSellers'
  | 'topBuyerShare'
  | 'topHolderShare'
  | 'earlyBuyerShare'
  | 'creatorSold'
  | 'creatorPriorLaunches'
  | 'creatorPriorRugs'
  | 'smartBuyerCount'
  | 'smartEarly'
  | 'riskFlags'
  | 'hardRisk'
  | 'phase'
  | 'symbol'
  | 'name'
  // market (providers, when cached)
  | 'marketCapUsd'
  | 'liquidityUsd'
  | 'holders'
  | 'priceUsd'
  | 'launchpad'
  // runner
  | 'runnerOddsPct'
  // position
  | 'held'
  | 'pnlPct'
  | 'pnlSol'
  | 'holdMinutes'
  | 'drawdownFromPeakPct'
  | 'costSol'
  // followed wallet
  | 'leaderWallet'
  | 'leaderLabel'
  | 'leaderSide'
  | 'leaderSol'
  | 'leaderSoldPct'
  // order
  | 'orderKind'
  | 'orderState'
  | 'orderAmount'
  // alert
  | 'alertKind'
  | 'alertThreshold'
  // global
  | 'walletSol'
  | 'hourLocal'
  | 'minuteLocal'
  | 'weekday';

export type FieldKind = 'number' | 'boolean' | 'text' | 'list';
export type FieldScope = 'token' | 'market' | 'runner' | 'position' | 'leader' | 'order' | 'alert' | 'any';

export interface FieldSpec {
  id: RuleField;
  label: string;
  kind: FieldKind;
  scope: FieldScope;
  /** Unit or range, for the guide. */
  unit: string;
  hint: string;
  /** When the value is null (and a condition on it does not hold). */
  nullWhen: string;
}

/** Every fact a rule or script can see. The variable guide is this table. */
export const RULE_FIELDS: FieldSpec[] = [
  { id: 'ageSec', label: 'Age (s)', kind: 'number', scope: 'token', unit: 'seconds', hint: 'Seconds since the launch was first seen', nullWhen: 'the token was never on the launch feed' },
  { id: 'score', label: 'Krypt score', kind: 'number', scope: 'token', unit: '0–100', hint: 'The app’s composite score', nullWhen: 'the checks have not resolved yet, or the token was never on the launch feed' },
  { id: 'priceSol', label: 'Price (SOL)', kind: 'number', scope: 'token', unit: 'SOL per token', hint: 'Latest price the app knows', nullWhen: 'no price is known' },
  { id: 'curvePct', label: 'Curve progress %', kind: 'number', scope: 'token', unit: '0–100', hint: 'Bonding curve filled', nullWhen: 'not on the launch feed' },
  { id: 'uniqueBuyers', label: 'Unique buyers', kind: 'number', scope: 'token', unit: 'wallets', hint: 'Distinct wallets that bought in the window', nullWhen: 'not on the launch feed' },
  { id: 'buys', label: 'Buys', kind: 'number', scope: 'token', unit: 'count', hint: 'Buy count in the window', nullWhen: 'not on the launch feed' },
  { id: 'sells', label: 'Sells', kind: 'number', scope: 'token', unit: 'count', hint: 'Sell count in the window', nullWhen: 'not on the launch feed' },
  { id: 'netInflowSol', label: 'Net inflow (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: 'Buy volume minus sell volume', nullWhen: 'not on the launch feed' },
  { id: 'buyVolumeSol', label: 'Buy volume (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'sellVolumeSol', label: 'Sell volume (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'buyerAcceleration', label: 'Buyer acceleration', kind: 'number', scope: 'token', unit: 'ratio', hint: 'Second-half buyers over first-half', nullWhen: 'not on the launch feed' },
  { id: 'distinctSellers', label: 'Distinct sellers', kind: 'number', scope: 'token', unit: 'wallets', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'topBuyerShare', label: 'Top buyer share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Largest buyer’s share of buy volume', nullWhen: 'not on the launch feed' },
  { id: 'topHolderShare', label: 'Top holder share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Largest wallet’s share of circulating tokens', nullWhen: 'not on the launch feed' },
  { id: 'earlyBuyerShare', label: 'Early buyer share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Held by wallets that bought in the early window', nullWhen: 'not on the launch feed' },
  { id: 'creatorSold', label: 'Creator sold', kind: 'boolean', scope: 'token', unit: 'true/false', hint: 'The creator wallet has sold', nullWhen: 'not on the launch feed' },
  { id: 'creatorPriorLaunches', label: 'Creator prior launches', kind: 'number', scope: 'token', unit: 'count', hint: 'From the local creator history', nullWhen: 'not on the launch feed' },
  { id: 'creatorPriorRugs', label: 'Creator prior rugs', kind: 'number', scope: 'token', unit: 'count', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'smartBuyerCount', label: 'Smart buyers', kind: 'number', scope: 'token', unit: 'wallets', hint: 'Watched wallets that bought', nullWhen: 'not on the launch feed' },
  { id: 'smartEarly', label: 'Smart buyer early', kind: 'boolean', scope: 'token', unit: 'true/false', hint: 'A watched wallet bought in the early window', nullWhen: 'not on the launch feed' },
  { id: 'riskFlags', label: 'Risk flags', kind: 'list', scope: 'token', unit: 'flag ids', hint: 'e.g. creator_rug_history', nullWhen: 'never (empty when none)' },
  { id: 'hardRisk', label: 'Hard risk flag', kind: 'boolean', scope: 'token', unit: 'true/false', hint: 'Any hard-reject flag present', nullWhen: 'not on the launch feed' },
  { id: 'phase', label: 'Phase', kind: 'text', scope: 'token', unit: 'detected · evaluating · rejected · entered · flagged · completed', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'symbol', label: 'Symbol', kind: 'text', scope: 'token', unit: 'text', hint: '', nullWhen: 'never (empty when unknown)' },
  { id: 'name', label: 'Name', kind: 'text', scope: 'token', unit: 'text', hint: '', nullWhen: 'never (empty when unknown)' },
  { id: 'marketCapUsd', label: 'Market cap (USD)', kind: 'number', scope: 'market', unit: 'USD', hint: 'From the market providers', nullWhen: 'the providers have not priced this token yet' },
  { id: 'liquidityUsd', label: 'Liquidity (USD)', kind: 'number', scope: 'market', unit: 'USD', hint: 'Pool liquidity', nullWhen: 'unknown to the providers' },
  { id: 'holders', label: 'Holders', kind: 'number', scope: 'market', unit: 'wallets', hint: '', nullWhen: 'unknown to the providers' },
  { id: 'priceUsd', label: 'Price (USD)', kind: 'number', scope: 'market', unit: 'USD per token', hint: '', nullWhen: 'unknown to the providers' },
  { id: 'launchpad', label: 'Launchpad', kind: 'text', scope: 'market', unit: 'pumpfun · launchlab · dbc · boop · unknown…', hint: '', nullWhen: 'unknown' },
  { id: 'runnerOddsPct', label: 'Runner odds %', kind: 'number', scope: 'runner', unit: 'percent', hint: 'Observed graduation rate for the flag bucket', nullWhen: 'not a runner event' },
  { id: 'held', label: 'Held by this script', kind: 'boolean', scope: 'position', unit: 'true/false', hint: 'This script holds the token (in its mode)', nullWhen: 'never' },
  { id: 'pnlPct', label: 'PnL %', kind: 'number', scope: 'position', unit: 'percent', hint: '', nullWhen: 'not held, or the position cannot be priced' },
  { id: 'pnlSol', label: 'PnL (SOL)', kind: 'number', scope: 'position', unit: 'SOL', hint: '', nullWhen: 'not held, or the position cannot be priced' },
  { id: 'holdMinutes', label: 'Held (min)', kind: 'number', scope: 'position', unit: 'minutes', hint: 'Minutes since the position opened', nullWhen: 'not held' },
  { id: 'drawdownFromPeakPct', label: 'Drawdown from peak %', kind: 'number', scope: 'position', unit: 'percent, 0 or more', hint: 'How far price is below its peak since entry', nullWhen: 'not held, or no price' },
  { id: 'costSol', label: 'Cost (SOL)', kind: 'number', scope: 'position', unit: 'SOL', hint: 'Paid for what is still held', nullWhen: 'not held' },
  { id: 'leaderWallet', label: 'Followed wallet', kind: 'text', scope: 'leader', unit: 'address', hint: '', nullWhen: 'not a followed-wallet event' },
  { id: 'leaderLabel', label: 'Followed wallet label', kind: 'text', scope: 'leader', unit: 'text', hint: 'The label you gave it on Copy Trading', nullWhen: 'not a followed-wallet event' },
  { id: 'leaderSide', label: 'Followed wallet side', kind: 'text', scope: 'leader', unit: 'buy · sell', hint: '', nullWhen: 'not a followed-wallet event' },
  { id: 'leaderSol', label: 'Followed wallet SOL', kind: 'number', scope: 'leader', unit: 'SOL', hint: 'SOL they paid or received', nullWhen: 'not a followed-wallet event' },
  { id: 'leaderSoldPct', label: 'Followed wallet sold %', kind: 'number', scope: 'leader', unit: 'percent of their bag', hint: 'On a sell: the share of their holding they sold', nullWhen: 'a buy, or the share could not be read' },
  { id: 'orderKind', label: 'Order kind', kind: 'text', scope: 'order', unit: 'limit_buy · limit_sell · take_profit · stop_loss · trailing_stop · sell_on_dev_sell · sell_on_migration · buy_on_migration', hint: '', nullWhen: 'not an order event' },
  { id: 'orderState', label: 'Order state', kind: 'text', scope: 'order', unit: 'triggered · filled · failed · cancelled · expired · paused', hint: '', nullWhen: 'not an order event' },
  { id: 'orderAmount', label: 'Order amount', kind: 'number', scope: 'order', unit: 'SOL (buys) or % (sells)', hint: '', nullWhen: 'not an order event' },
  { id: 'alertKind', label: 'Alert kind', kind: 'text', scope: 'alert', unit: 'price_above · price_below · mcap_above · mcap_below · volume_above · liquidity_below · holders_above · curve_above', hint: '', nullWhen: 'not an alert event' },
  { id: 'alertThreshold', label: 'Alert threshold', kind: 'number', scope: 'alert', unit: 'in the alert’s own unit', hint: '', nullWhen: 'not an alert event' },
  { id: 'walletSol', label: 'Wallet SOL', kind: 'number', scope: 'any', unit: 'SOL', hint: 'The active trading wallet’s balance', nullWhen: 'the balance has not been read yet' },
  { id: 'hourLocal', label: 'Hour (local)', kind: 'number', scope: 'any', unit: '0–23', hint: '', nullWhen: 'never' },
  { id: 'minuteLocal', label: 'Minute (local)', kind: 'number', scope: 'any', unit: '0–59', hint: '', nullWhen: 'never' },
  { id: 'weekday', label: 'Weekday', kind: 'number', scope: 'any', unit: '0 = Sunday … 6 = Saturday', hint: '', nullWhen: 'never' },
];

/** Which scopes a trigger can see. `any` is always visible. */
export const SCOPES_FOR_TRIGGER: Record<RuleTrigger, FieldScope[]> = {
  launch: ['token', 'market', 'position', 'any'],
  launch_update: ['token', 'market', 'position', 'any'],
  runner: ['token', 'market', 'runner', 'position', 'any'],
  position: ['token', 'market', 'position', 'any'],
  tick: ['token', 'market', 'position', 'any'],
  leader_trade: ['token', 'market', 'leader', 'position', 'any'],
  order: ['token', 'market', 'order', 'position', 'any'],
  alert: ['token', 'market', 'alert', 'position', 'any'],
  schedule: ['any'],
};

export type RuleOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'is_true' | 'is_false';

export const OPS_FOR_KIND: Record<FieldKind, RuleOp[]> = {
  number: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'],
  boolean: ['is_true', 'is_false'],
  text: ['eq', 'neq', 'contains', 'not_contains'],
  list: ['contains', 'not_contains'],
};

export const OP_LABELS: Record<RuleOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  is_true: 'is true',
  is_false: 'is false',
};

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: number | string;
}

// ── Actions ───────────────────────────────────────────────────────────

export type OrderBasis = 'mcap_usd' | 'price_sol';

export type RuleAction =
  | { type: 'buy'; sol: number }
  | { type: 'sell'; pct: number }
  | { type: 'sell_all' }
  | { type: 'stop_loss'; pct: number }
  | { type: 'take_profit'; gainPct: number; sellPct: number }
  | { type: 'trailing_stop'; pct: number }
  | { type: 'limit_buy'; basis: OrderBasis; value: number; sol: number }
  | { type: 'limit_sell'; basis: OrderBasis; value: number; pct: number }
  | { type: 'cancel_orders' }
  | { type: 'apply_template'; templateId: string }
  | { type: 'alert'; kind: AlertKind; threshold: number }
  | { type: 'watch' }
  | { type: 'unwatch' }
  | { type: 'notify'; message: string }
  | { type: 'log'; message: string }
  | { type: 'disable_self' };

export type RuleActionType = RuleAction['type'];

export interface ActionSpec {
  id: RuleActionType;
  label: string;
  hint: string;
  /** Needs a token in the event (every trigger but schedule). */
  needsMint: boolean;
  /** Counts as opening a position (budget: buys per day, open positions). */
  isBuy: boolean;
}

export const RULE_ACTIONS: ActionSpec[] = [
  { id: 'buy', label: 'Buy', hint: 'SOL amount, under the script’s per-trade cap', needsMint: true, isBuy: true },
  { id: 'sell', label: 'Sell', hint: '% of what is held', needsMint: true, isBuy: false },
  { id: 'sell_all', label: 'Sell everything this script holds', hint: '100 % of every position in its mode', needsMint: false, isBuy: false },
  { id: 'stop_loss', label: 'Place stop loss', hint: 'Sell all when down N % from the price now', needsMint: true, isBuy: false },
  { id: 'take_profit', label: 'Place take profit', hint: 'Sell a share when up N % from the price now', needsMint: true, isBuy: false },
  { id: 'trailing_stop', label: 'Place trailing stop', hint: 'Sell all when N % below the peak since placing', needsMint: true, isBuy: false },
  { id: 'limit_buy', label: 'Place limit buy', hint: 'Buy when market cap or price falls to a level', needsMint: true, isBuy: true },
  { id: 'limit_sell', label: 'Place limit sell', hint: 'Sell a share when market cap or price rises to a level', needsMint: true, isBuy: false },
  { id: 'cancel_orders', label: 'Cancel orders', hint: 'Every open order on the token', needsMint: true, isBuy: false },
  { id: 'apply_template', label: 'Apply order template', hint: 'Arm the stops and take profits of a saved template', needsMint: true, isBuy: false },
  { id: 'alert', label: 'Create alert', hint: 'A price / market cap / volume alert on the token', needsMint: true, isBuy: false },
  { id: 'watch', label: 'Watch', hint: 'Pin to the Watchlist and stream its price to this script', needsMint: true, isBuy: false },
  { id: 'unwatch', label: 'Unwatch', hint: 'Unpin and stop streaming', needsMint: true, isBuy: false },
  { id: 'notify', label: 'Notify', hint: 'Desktop notification and toast', needsMint: false, isBuy: false },
  { id: 'log', label: 'Log', hint: 'A line on this script’s log', needsMint: false, isBuy: false },
  { id: 'disable_self', label: 'Turn this script off', hint: 'The script disables itself', needsMint: false, isBuy: false },
];

export const ALERT_KINDS: AlertKind[] = ['price_above', 'price_below', 'mcap_above', 'mcap_below', 'volume_above', 'liquidity_below', 'holders_above', 'curve_above'];

export interface RuleSet {
  trigger: RuleTrigger;
  /** All must hold (AND). An unknown value never satisfies a condition. */
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Fire at most once per mint, ever (for this script). */
  oncePerMint: boolean;
  /** Seconds before this rule may fire again for the same mint. */
  cooldownSec: number;
  /** `schedule` trigger: local time, "HH:MM". */
  atHHMM?: string;
}

export const MAX_CONDITIONS = 20;
export const MAX_ACTIONS = 8;
export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_SCRIPTS = 20;
export const MAX_STATE_BYTES = 16 * 1024;

export interface UserScript {
  id: string;
  name: string;
  kind: ScriptKind;
  enabled: boolean;
  mode: ScriptMode;
  /** kind = code. */
  code: string;
  /** kind = rules. */
  rules: RuleSet;
  budget: ScriptBudget;
  createdAt: number;
  updatedAt: number;
}

export function defaultRules(): RuleSet {
  return {
    trigger: 'launch_update',
    conditions: [
      { field: 'score', op: 'gte', value: 70 },
      { field: 'hardRisk', op: 'is_false', value: '' },
      { field: 'uniqueBuyers', op: 'gte', value: 15 },
    ],
    actions: [{ type: 'buy', sol: 0.02 }],
    oncePerMint: true,
    cooldownSec: 60,
  };
}

export function defaultScript(kind: ScriptKind): Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: kind === 'rules' ? 'New rule' : 'New script',
    kind,
    enabled: false,
    mode: 'paper',
    code: kind === 'code' ? SCRIPT_EXAMPLES[0].code : '',
    rules: defaultRules(),
    budget: { ...DEFAULT_BUDGET },
  };
}

// ── The facts a rule or script sees ───────────────────────────────────

/** A position as a script sees it — paper book or real holding, same shape.
 *  Unknown is null: a position whose decimals could not be read has no
 *  price, no PnL, and a rule on either does not fire. */
export interface ScriptPosition {
  mint: string;
  symbol: string;
  name: string;
  openedAt: number;
  /** SOL paid for what is still held (average cost). */
  costSol: number;
  tokens: number | null;
  entryPriceSol: number | null;
  currentPriceSol: number | null;
  /** Highest price seen since entry, when tracked. */
  peakPriceSol: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
}

/** Market facts from the providers, when the app has them cached. */
export interface MarketFacts {
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  launchpad: string | null;
  symbol?: string;
  name?: string;
}

export interface LeaderFacts {
  wallet: string;
  label: string;
  side: 'buy' | 'sell';
  sol: number;
  priceSol: number;
  soldFraction: number | null;
}

export interface OrderFacts {
  kind: string;
  state: string;
  amount: number;
}

export interface AlertFacts {
  kind: string;
  threshold: number | null;
}

export interface GlobalFacts {
  walletSol: number | null;
  now: number;
}

/**
 * The flattened, honest view of one event. Every field a rule can name is
 * here; unknown is null and a condition on null does not hold. Scripts
 * receive this same object — never an internal one.
 */
export type RuleContext = { [K in RuleField]: K extends 'riskFlags' ? string[] : K extends 'creatorSold' | 'smartEarly' | 'hardRisk' | 'held' ? boolean | null : K extends 'phase' | 'symbol' | 'name' | 'launchpad' | 'leaderWallet' | 'leaderLabel' | 'leaderSide' | 'orderKind' | 'orderState' | 'alertKind' ? string | null : number | null } & {
  mint: string;
  symbol: string;
  name: string;
  /** Rolling price history when the launch feed has one (oldest first). */
  priceHistory: number[];
};

export function emptyContext(mint: string, symbol = '', name = ''): RuleContext {
  const c: Record<string, unknown> = { mint, symbol, name, priceHistory: [], riskFlags: [] };
  for (const f of RULE_FIELDS) if (!(f.id in c)) c[f.id] = null;
  c.symbol = symbol;
  c.name = name;
  return c as RuleContext;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function contextFromLaunch(row: LaunchRow, now: number): RuleContext {
  const c = emptyContext(row.mint, row.symbol ?? '', row.name ?? '');
  const f = row.flow;
  c.ageSec = num(row.detectedAt) !== null ? Math.max(0, (now - row.detectedAt) / 1000) : null;
  c.score = row.score ? num(row.score.total) : null;
  c.priceSol = num(row.priceSol) !== null && row.priceSol > 0 ? row.priceSol : null;
  if (f) {
    c.curvePct = num(f.curveProgressPct);
    c.uniqueBuyers = num(f.uniqueBuyers);
    c.buys = num(f.buys);
    c.sells = num(f.sells);
    c.netInflowSol = num(f.netInflowSol);
    c.buyVolumeSol = num(f.buyVolumeSol);
    c.sellVolumeSol = num(f.sellVolumeSol);
    c.buyerAcceleration = num(f.buyerAcceleration);
    c.distinctSellers = num(f.distinctSellers);
    c.topBuyerShare = num(f.topBuyerShare);
    c.topHolderShare = num(f.topHolderTokenShare);
    c.earlyBuyerShare = num(f.earlyBuyerShare);
    c.creatorSold = typeof f.creatorSold === 'boolean' ? f.creatorSold : null;
  }
  c.creatorPriorLaunches = num(row.creatorPriorLaunches);
  c.creatorPriorRugs = num(row.creatorPriorRugs);
  c.smartBuyerCount = num(row.smartBuyerCount);
  c.smartEarly = typeof row.smartEarly === 'boolean' ? row.smartEarly : null;
  c.riskFlags = Array.isArray(row.riskFlags) ? row.riskFlags.map((r) => r.id).filter(Boolean) : [];
  c.hardRisk = Array.isArray(row.riskFlags) ? row.riskFlags.some((r) => r.hard) : null;
  c.phase = row.phase ?? null;
  c.priceHistory = Array.isArray(row.priceHistory) ? row.priceHistory.slice(-120) : [];
  return c;
}

export function contextFromRunner(flag: RunnerFlag, launch: LaunchRow | null, now: number): RuleContext {
  const c = launch ? contextFromLaunch(launch, now) : emptyContext(flag.mint, flag.symbol ?? '', flag.name ?? '');
  c.runnerOddsPct = num(flag.observedPct);
  return c;
}

/** Position facts onto a context (from the launch row when there is one). */
export function withPosition(c: RuleContext, pos: ScriptPosition | null, now: number): RuleContext {
  if (!pos) {
    c.held = false;
    return c;
  }
  c.held = true;
  if (!c.symbol && pos.symbol) c.symbol = pos.symbol;
  c.pnlPct = num(pos.pnlPct);
  c.pnlSol = num(pos.pnlSol);
  c.holdMinutes = num(pos.openedAt) !== null && pos.openedAt > 0 ? Math.max(0, (now - pos.openedAt) / 60_000) : null;
  c.costSol = num(pos.costSol);
  const peak = num(pos.peakPriceSol);
  const cur = num(pos.currentPriceSol);
  c.drawdownFromPeakPct = peak !== null && cur !== null && peak > 0 ? Math.max(0, ((peak - cur) / peak) * 100) : null;
  if (cur !== null && cur > 0) c.priceSol = cur;
  return c;
}

export function contextFromPosition(pos: ScriptPosition, launch: LaunchRow | null, now: number): RuleContext {
  const c = launch ? contextFromLaunch(launch, now) : emptyContext(pos.mint, pos.symbol ?? '', pos.name ?? '');
  return withPosition(c, pos, now);
}

export function withMarket(c: RuleContext, m: MarketFacts | null): RuleContext {
  if (!m) return c;
  c.marketCapUsd = num(m.marketCapUsd);
  c.liquidityUsd = num(m.liquidityUsd);
  c.holders = num(m.holders);
  c.priceUsd = num(m.priceUsd);
  c.launchpad = m.launchpad ?? null;
  if (c.priceSol === null && num(m.priceSol) !== null && (m.priceSol as number) > 0) c.priceSol = m.priceSol;
  if (!c.symbol && m.symbol) c.symbol = m.symbol;
  if (!c.name && m.name) c.name = m.name;
  return c;
}

export function withLeader(c: RuleContext, l: LeaderFacts): RuleContext {
  c.leaderWallet = l.wallet;
  c.leaderLabel = l.label;
  c.leaderSide = l.side;
  c.leaderSol = num(l.sol);
  c.leaderSoldPct = l.side === 'sell' && l.soldFraction !== null && Number.isFinite(l.soldFraction) ? Math.round(l.soldFraction * 100) : null;
  if (c.priceSol === null && l.priceSol > 0) c.priceSol = l.priceSol;
  return c;
}

export function withOrder(c: RuleContext, o: OrderFacts): RuleContext {
  c.orderKind = o.kind;
  c.orderState = o.state;
  c.orderAmount = num(o.amount);
  return c;
}

export function withAlert(c: RuleContext, a: AlertFacts): RuleContext {
  c.alertKind = a.kind;
  c.alertThreshold = num(a.threshold);
  return c;
}

export function withGlobals(c: RuleContext, g: GlobalFacts): RuleContext {
  c.walletSol = num(g.walletSol);
  const d = new Date(g.now);
  c.hourLocal = d.getHours();
  c.minuteLocal = d.getMinutes();
  c.weekday = d.getDay();
  return c;
}

/** A position's PnL from what is held, what it cost and the price now. */
export function positionPnl(costSol: number, tokens: number | null, priceSol: number | null): { pnlSol: number | null; pnlPct: number | null } {
  if (tokens === null || priceSol === null || !(priceSol > 0) || !(tokens >= 0)) return { pnlSol: null, pnlPct: null };
  const pnlSol = tokens * priceSol - costSol;
  return { pnlSol, pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : null };
}

// ── Evaluation ────────────────────────────────────────────────────────

const fieldKind = (id: RuleField): FieldKind => RULE_FIELDS.find((f) => f.id === id)?.kind ?? 'number';

/** Does one condition hold? Unknown (null) never holds — a rule that buys on
 *  "score ≥ 70" must not buy while the score is still being computed. */
export function conditionHolds(cond: RuleCondition, ctx: RuleContext): { ok: boolean; why: string } {
  const kind = fieldKind(cond.field);
  const raw = (ctx as unknown as Record<string, unknown>)[cond.field];
  const label = RULE_FIELDS.find((f) => f.id === cond.field)?.label ?? cond.field;
  if (raw === null || raw === undefined) return { ok: false, why: `${label} unknown` };
  if (kind === 'number') {
    const v = raw as number;
    const want = Number(cond.value);
    if (!Number.isFinite(want)) return { ok: false, why: `${label}: bad value` };
    const ok =
      cond.op === 'gt' ? v > want
        : cond.op === 'gte' ? v >= want
          : cond.op === 'lt' ? v < want
            : cond.op === 'lte' ? v <= want
              : cond.op === 'eq' ? v === want
                : cond.op === 'neq' ? v !== want
                  : false;
    return { ok, why: ok ? '' : `${label} ${fmt(v)} not ${OP_LABELS[cond.op]} ${want}` };
  }
  if (kind === 'boolean') {
    const v = raw as boolean;
    const ok = cond.op === 'is_true' ? v === true : cond.op === 'is_false' ? v === false : false;
    return { ok, why: ok ? '' : `${label} is ${v}` };
  }
  if (kind === 'text') {
    const v = String(raw).toLowerCase();
    const want = String(cond.value).toLowerCase();
    const ok =
      cond.op === 'eq' ? v === want
        : cond.op === 'neq' ? v !== want
          : cond.op === 'contains' ? v.includes(want)
            : cond.op === 'not_contains' ? !v.includes(want)
              : false;
    return { ok, why: ok ? '' : `${label} "${String(raw)}" ${OP_LABELS[cond.op]} "${cond.value}" fails` };
  }
  // list
  const list = (raw as string[]).map((s) => s.toLowerCase());
  const want = String(cond.value).toLowerCase();
  const has = list.includes(want);
  const ok = cond.op === 'contains' ? has : cond.op === 'not_contains' ? !has : false;
  return { ok, why: ok ? '' : `${label} [${list.join(', ')}] ${OP_LABELS[cond.op]} "${cond.value}" fails` };
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

/** All conditions hold → fire. `why` names the first one that did not. */
export function evaluateRules(rules: RuleSet, ctx: RuleContext): { fire: boolean; why: string } {
  for (const cond of rules.conditions) {
    const r = conditionHolds(cond, ctx);
    if (!r.ok) return { fire: false, why: r.why };
  }
  return { fire: true, why: '' };
}

// ── Validation ────────────────────────────────────────────────────────

export function validateBudget(b: ScriptBudget): { ok: boolean; message: string } {
  for (const key of Object.keys(BUDGET_BOUNDS) as Array<keyof ScriptBudget>) {
    const v = b[key];
    const { min, max } = BUDGET_BOUNDS[key];
    if (!Number.isFinite(v) || v < min || v > max) return { ok: false, message: `${key} must be between ${min} and ${max}` };
  }
  return { ok: true, message: 'ok' };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateAction(a: RuleAction, trigger: RuleTrigger): { ok: boolean; message: string } {
  const spec = RULE_ACTIONS.find((x) => x.id === a.type);
  if (!spec) return { ok: false, message: 'Unknown action' };
  if (spec.needsMint && trigger === 'schedule') return { ok: false, message: `${spec.label}: a daily schedule has no token — use "Sell everything", notify or log` };
  switch (a.type) {
    case 'buy':
    case 'limit_buy':
      if (trigger === 'position') return { ok: false, message: 'A position rule cannot buy — it acts on what is already held' };
      if (!Number.isFinite(a.sol) || a.sol <= 0) return { ok: false, message: `${spec.label}: enter a SOL amount` };
      if (a.type === 'limit_buy' && !(Number.isFinite(a.value) && a.value > 0)) return { ok: false, message: 'Limit buy: enter the level' };
      return { ok: true, message: 'ok' };
    case 'sell':
    case 'limit_sell': {
      const pct = a.type === 'sell' ? a.pct : a.pct;
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) return { ok: false, message: `${spec.label}: 1–100 %` };
      if (a.type === 'limit_sell' && !(Number.isFinite(a.value) && a.value > 0)) return { ok: false, message: 'Limit sell: enter the level' };
      return { ok: true, message: 'ok' };
    }
    case 'stop_loss':
    case 'trailing_stop':
      if (!Number.isFinite(a.pct) || a.pct < 1 || a.pct > 99) return { ok: false, message: `${spec.label}: 1–99 %` };
      return { ok: true, message: 'ok' };
    case 'take_profit':
      if (!Number.isFinite(a.gainPct) || a.gainPct < 1 || a.gainPct > 100_000) return { ok: false, message: 'Take profit: gain 1–100000 %' };
      if (!Number.isFinite(a.sellPct) || a.sellPct < 1 || a.sellPct > 100) return { ok: false, message: 'Take profit: sell 1–100 %' };
      return { ok: true, message: 'ok' };
    case 'apply_template':
      if (!a.templateId) return { ok: false, message: 'Pick a template' };
      return { ok: true, message: 'ok' };
    case 'alert':
      if (!ALERT_KINDS.includes(a.kind)) return { ok: false, message: 'Alert: pick a kind' };
      if (!Number.isFinite(a.threshold) || a.threshold <= 0) return { ok: false, message: 'Alert: enter a threshold' };
      return { ok: true, message: 'ok' };
    case 'notify':
    case 'log':
      if (!a.message || a.message.length > 200) return { ok: false, message: `${a.type}: 1–200 characters` };
      return { ok: true, message: 'ok' };
    default:
      return { ok: true, message: 'ok' };
  }
}

export function validateRules(r: RuleSet): { ok: boolean; message: string } {
  if (!RULE_TRIGGERS.some((t) => t.id === r.trigger)) return { ok: false, message: 'Pick a trigger' };
  if (!Array.isArray(r.conditions) || r.conditions.length > MAX_CONDITIONS) return { ok: false, message: `At most ${MAX_CONDITIONS} conditions` };
  if (!Array.isArray(r.actions) || r.actions.length === 0) return { ok: false, message: 'Add at least one action' };
  if (r.actions.length > MAX_ACTIONS) return { ok: false, message: `At most ${MAX_ACTIONS} actions` };
  if (r.trigger === 'schedule' && !(typeof r.atHHMM === 'string' && HHMM.test(r.atHHMM))) return { ok: false, message: 'Schedule: enter a time as HH:MM' };
  const scopes = SCOPES_FOR_TRIGGER[r.trigger];
  for (const c of r.conditions) {
    const f = RULE_FIELDS.find((x) => x.id === c.field);
    if (!f) return { ok: false, message: `Unknown field ${String(c.field)}` };
    if (!OPS_FOR_KIND[f.kind].includes(c.op)) return { ok: false, message: `${f.label}: "${OP_LABELS[c.op] ?? c.op}" does not apply` };
    if (f.kind === 'number' && !Number.isFinite(Number(c.value))) return { ok: false, message: `${f.label}: enter a number` };
    if ((f.kind === 'text' || f.kind === 'list') && !String(c.value).trim()) return { ok: false, message: `${f.label}: enter a value` };
    if (!scopes.includes(f.scope)) return { ok: false, message: `${f.label} is not known on the "${RULE_TRIGGERS.find((t) => t.id === r.trigger)?.label}" trigger` };
  }
  for (const a of r.actions) {
    const v = validateAction(a, r.trigger);
    if (!v.ok) return v;
  }
  if (!Number.isFinite(r.cooldownSec) || r.cooldownSec < 0 || r.cooldownSec > 86_400) return { ok: false, message: 'Cooldown: 0–86400 s' };
  return { ok: true, message: 'ok' };
}

export function validateScript(s: Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'>): { ok: boolean; message: string } {
  if (!s.name || !s.name.trim() || s.name.length > 60) return { ok: false, message: 'Name: 1–60 characters' };
  if (s.kind !== 'rules' && s.kind !== 'code') return { ok: false, message: 'Unknown script kind' };
  if (s.mode !== 'paper' && s.mode !== 'live') return { ok: false, message: 'Mode must be paper or live' };
  const b = validateBudget(s.budget);
  if (!b.ok) return b;
  if (s.kind === 'code') {
    if (typeof s.code !== 'string' || !s.code.trim()) return { ok: false, message: 'The script is empty' };
    if (new TextEncoder().encode(s.code).length > MAX_CODE_BYTES) return { ok: false, message: `Script is over ${MAX_CODE_BYTES / 1024} KB` };
  } else {
    const r = validateRules(s.rules);
    if (!r.ok) return r;
    for (const a of s.rules.actions) {
      if ((a.type === 'buy' || a.type === 'limit_buy') && a.sol > s.budget.maxSolPerTrade) return { ok: false, message: `Buy ${a.sol} SOL is above this script's max per trade (${s.budget.maxSolPerTrade})` };
    }
  }
  return { ok: true, message: 'ok' };
}

export function describeAction(a: RuleAction): string {
  switch (a.type) {
    case 'buy':
      return `buy ${a.sol} SOL`;
    case 'sell':
      return `sell ${a.pct}%`;
    case 'sell_all':
      return 'sell everything';
    case 'stop_loss':
      return `stop loss −${a.pct}%`;
    case 'take_profit':
      return `take profit +${a.gainPct}% sell ${a.sellPct}%`;
    case 'trailing_stop':
      return `trailing stop ${a.pct}%`;
    case 'limit_buy':
      return `limit buy ${a.sol} SOL at ${a.basis === 'mcap_usd' ? `$${a.value} mcap` : `${a.value} SOL`}`;
    case 'limit_sell':
      return `limit sell ${a.pct}% at ${a.basis === 'mcap_usd' ? `$${a.value} mcap` : `${a.value} SOL`}`;
    case 'cancel_orders':
      return 'cancel orders';
    case 'apply_template':
      return 'apply template';
    case 'alert':
      return `alert ${a.kind} ${a.threshold}`;
    case 'watch':
      return 'watch';
    case 'unwatch':
      return 'unwatch';
    case 'notify':
      return `notify "${a.message}"`;
    case 'log':
      return `log "${a.message}"`;
    case 'disable_self':
      return 'turn itself off';
  }
}

export function describeRules(r: RuleSet): string {
  const trig = RULE_TRIGGERS.find((t) => t.id === r.trigger)?.label ?? r.trigger;
  const when = r.trigger === 'schedule' && r.atHHMM ? `${trig} ${r.atHHMM}` : trig;
  const conds = r.conditions.map((c) => {
    const f = RULE_FIELDS.find((x) => x.id === c.field);
    const label = f?.label ?? c.field;
    return f?.kind === 'boolean' ? `${label} ${OP_LABELS[c.op]}` : `${label} ${OP_LABELS[c.op]} ${c.value}`;
  });
  return `On ${when}${conds.length ? ` when ${conds.join(' and ')}` : ''}: ${r.actions.map(describeAction).join(', ')}`;
}

// ── Runtime views ─────────────────────────────────────────────────────

export interface ScriptLogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  line: string;
}

export interface ScriptStats {
  buysToday: number;
  sellsToday: number;
  /** Realised today, SOL (paper: exact; live: from the position's PnL at the sell). */
  realizedSolToday: number;
  errorsInARow: number;
  lastRunAt: number | null;
  lastError: string | null;
  /** Positions this script opened and still holds. */
  openCount: number;
  /** Mints this script has ever fired on (once-per-mint memory). */
  firedMints: number;
  /** Code scripts: the sandbox is up and listening. */
  running: boolean;
}

export interface ScriptSnapshot {
  scripts: UserScript[];
  stats: Record<string, ScriptStats>;
  logs: Record<string, ScriptLogLine[]>;
  liveBlockedReason: string | null;
  /** Everything disabled at once, by the user or by a breaker. */
  killSwitch: boolean;
  /** Saved order templates, for the apply-template action. */
  templates: Array<{ id: string; name: string }>;
}

// ── Code scripts: the API, the examples, the AI pack ──────────────────

export interface ApiSpec {
  method: string;
  signature: string;
  returns: string;
  notes: string;
  /** Counts as an action against the budget. */
  action: boolean;
}

/** The whole `bot` object. The harness, the dispatcher and the docs all
 *  follow this table. */
export const SCRIPT_API: ApiSpec[] = [
  { method: 'on', signature: "bot.on(event, async (payload) => {})", returns: 'void', notes: 'Register a handler. Events: launch, launchUpdate, runner, position, tick, leaderTrade, order, alert, fill, schedule, interval. Handlers for one script run one at a time; one that runs past 3 s is killed and counts as an error.', action: false },
  { method: 'every', signature: 'bot.every(seconds, async () => {})', returns: 'Promise<number> (the seconds used)', notes: 'A timer. 5 s minimum, 3600 max.', action: false },
  { method: 'at', signature: "bot.at('HH:MM', async () => {})", returns: 'Promise<string>', notes: 'Once a day at that local time.', action: false },
  { method: 'buy', signature: 'await bot.buy(mint, sol)', returns: '{ok, message}', notes: 'Through the app’s own pipeline in the script’s mode (paper or live). Refused (ok:false, with the reason) when over the per-trade cap, the daily buy cap, the open-position cap, the actions-per-minute cap, the execution cap, or while live is blocked.', action: true },
  { method: 'sell', signature: 'await bot.sell(mint, pct)', returns: '{ok, message}', notes: 'pct 1–100 of what is held in the script’s mode. Refused when nothing is held.', action: true },
  { method: 'sellAll', signature: 'await bot.sellAll()', returns: '{ok, message, sold: number}', notes: 'Sell 100 % of every position this script holds.', action: true },
  { method: 'order', signature: "await bot.order({ mint, kind, triggerBasis, triggerValue, amount })", returns: '{ok, message}', notes: "kind: stop_loss | take_profit | trailing_stop | limit_buy | limit_sell | sell_on_dev_sell | sell_on_migration | buy_on_migration. triggerBasis: 'pct' (from the price now) | 'mcap_usd' | 'price_sol'. amount: SOL for buys, % for sells. Placed as a real advanced order (paused if the app cannot execute right now).", action: true },
  { method: 'cancelOrders', signature: 'await bot.cancelOrders(mint)', returns: '{ok, message, cancelled: number}', notes: 'Cancel every open order on the token.', action: true },
  { method: 'templates', signature: 'await bot.templates()', returns: 'Array<{id, name}>', notes: 'Saved order templates.', action: false },
  { method: 'applyTemplate', signature: 'await bot.applyTemplate(mint, templateId)', returns: '{ok, message}', notes: 'Arm a template’s stops and take profits on a token.', action: true },
  { method: 'alert', signature: "await bot.alert({ mint, kind, threshold, repeat })", returns: '{ok, message}', notes: 'kind: price_above | price_below | mcap_above | mcap_below | volume_above | liquidity_below | holders_above | curve_above. Fires an alert event back to scripts.', action: true },
  { method: 'watch', signature: 'await bot.watch(mint)', returns: '{ok, message}', notes: 'Pin to the Watchlist and stream tick events for the token to this script.', action: true },
  { method: 'unwatch', signature: 'await bot.unwatch(mint)', returns: '{ok, message}', notes: 'Unpin and stop the ticks.', action: true },
  { method: 'subscribe', signature: 'await bot.subscribe(mint)', returns: '{ok, message}', notes: 'Stream tick events for the token without pinning it. Positions the script holds are always streamed.', action: false },
  { method: 'unsubscribe', signature: 'await bot.unsubscribe(mint)', returns: '{ok, message}', notes: '', action: false },
  { method: 'notify', signature: "await bot.notify('text')", returns: '{ok, message}', notes: 'Desktop notification and a toast.', action: true },
  { method: 'log', signature: "bot.log('text') / bot.warn('text')", returns: 'void', notes: 'A line on this script’s log (400 chars max).', action: false },
  { method: 'price', signature: 'await bot.price(mint)', returns: 'number | null', notes: 'SOL per token from what the app already knows. Null when nothing local knows it.', action: false },
  { method: 'token', signature: 'await bot.token(mint)', returns: 'Token | null', notes: 'The same facts a rule sees (see the variable guide), from the launch feed and the cached market data. Null when the app has never seen the token.', action: false },
  { method: 'market', signature: 'await bot.market(mint)', returns: 'Market | null', notes: 'Asks the market providers (a network round trip inside the app): priceSol, priceUsd, marketCapUsd, liquidityUsd, holders, launchpad, symbol, name. Slow — a second or more; not for every tick.', action: false },
  { method: 'positions', signature: 'await bot.positions()', returns: 'Position[]', notes: 'Every position held in the script’s mode, as the same facts object plus held=true, pnlPct, pnlSol, holdMinutes, drawdownFromPeakPct, costSol.', action: false },
  { method: 'orders', signature: 'await bot.orders(mint?)', returns: 'Order[]', notes: '{id, mint, symbol, kind, state, triggerBasis, triggerValue, amount}. All orders, or the token’s.', action: false },
  { method: 'runners', signature: 'await bot.runners()', returns: 'Token[]', notes: 'Launches the scanner currently flags as runners.', action: false },
  { method: 'leaders', signature: 'await bot.leaders()', returns: 'Array<{wallet, label, enabled, mode}>', notes: 'Wallets followed on the Copy Trading page.', action: false },
  { method: 'wallet', signature: 'await bot.wallet()', returns: '{sol: number | null, address: string | null}', notes: 'The active trading wallet.', action: false },
  { method: 'getState', signature: 'await bot.getState()', returns: 'object', notes: 'This script’s saved state.', action: false },
  { method: 'setState', signature: 'await bot.setState(obj)', returns: 'true', notes: 'Replace the saved state. 16 KB of JSON, survives restarts.', action: false },
  { method: 'disable', signature: "await bot.disable('reason')", returns: 'true', notes: 'The script turns itself off.', action: false },
  { method: 'now', signature: 'bot.now()', returns: 'number', notes: 'Milliseconds since the epoch.', action: false },
];

export interface EventSpec {
  event: string;
  payload: string;
  when: string;
}

export const SCRIPT_EVENTS_DOC: EventSpec[] = [
  { event: 'launch', payload: 'Token', when: 'a token was just created and the feed saw it (score usually still null)' },
  { event: 'launchUpdate', payload: 'Token', when: 'a tracked launch traded; at most once per 2 s per token' },
  { event: 'runner', payload: 'Token + runnerOddsPct', when: 'the scanner flagged a potential runner' },
  { event: 'position', payload: 'Token + position fields (held=true)', when: 'every ~5 s for each position the script holds, and on every fill' },
  { event: 'tick', payload: 'Token + position fields; priceSol is the tick', when: 'the price moved on a token the script holds, watched or subscribed to; at most once a second per token' },
  { event: 'leaderTrade', payload: 'Token + leaderWallet, leaderLabel, leaderSide, leaderSol, leaderSoldPct', when: 'a wallet followed on Copy Trading bought or sold' },
  { event: 'order', payload: 'Token + orderKind, orderState, orderAmount', when: 'one of your advanced orders triggered, filled, failed, expired or was cancelled' },
  { event: 'alert', payload: 'Token + alertKind, alertThreshold', when: 'one of your alerts fired' },
  { event: 'fill', payload: '{mint, side, ok}', when: 'one of this script’s own trades landed or failed' },
  { event: 'schedule', payload: '{at: "HH:MM"}', when: 'the time set with bot.at' },
  { event: 'interval', payload: '{at: ms}', when: 'the timer set with bot.every' },
];

/** Rendered beside the editor. Generated, so it is always the truth about `bot`. */
export const SCRIPT_API_DOC: string = [
  '// Events',
  ...SCRIPT_EVENTS_DOC.map((e) => `bot.on('${e.event}', (x) => {})  // ${e.when}`),
  '',
  '// Actions — every one is checked against your budget in the app, not here.',
  ...SCRIPT_API.filter((a) => a.action).map((a) => `${a.signature}  // -> ${a.returns}`),
  '',
  '// Reads and timers',
  ...SCRIPT_API.filter((a) => !a.action && a.method !== 'on').map((a) => `${a.signature}  // -> ${a.returns}`),
  '',
  '// Not available: fetch, XMLHttpRequest, WebSocket, require, keys, files.',
  '// Unknown facts are null — never treat null as zero.',
  '// A handler that runs longer than 3 s is killed and counts as an error;',
  '// five errors in a row disable the script.',
].join('\n');

export const SCRIPT_EXAMPLES: Array<{ name: string; description: string; code: string }> = [
  {
    name: 'Buy strong launches',
    description: 'Buy once per token when the score and buyer count clear a bar and no hard risk flag is set, then arm a stop and a take profit.',
    code: `// Buy strong launches — once per token — and protect the position.
const seen = new Set();

bot.on('launchUpdate', async (t) => {
  if (seen.has(t.mint)) return;
  if (t.score === null || t.score < 70) return;      // unknown never qualifies
  if (t.hardRisk) return;
  if ((t.uniqueBuyers ?? 0) < 15) return;
  if ((t.ageSec ?? 0) > 180) return;                  // not after the first 3 minutes
  seen.add(t.mint);
  const r = await bot.buy(t.mint, 0.02);
  bot.log(\`buy \${t.symbol}: \${r.message}\`);
  if (!r.ok) return;
  await bot.order({ mint: t.mint, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
  await bot.order({ mint: t.mint, kind: 'take_profit', triggerBasis: 'pct', triggerValue: 100, amount: 50 });
});`,
  },
  {
    name: 'Trailing exit',
    description: 'Sell all when a position falls 25% from its peak, or half when it doubles.',
    code: `// Trailing exit over what this script holds.
const tookHalf = new Set();

bot.on('position', async (p) => {
  if (p.drawdownFromPeakPct !== null && p.drawdownFromPeakPct >= 25) {
    const r = await bot.sell(p.mint, 100);
    bot.log(\`stop \${p.symbol}: \${r.message}\`);
    return;
  }
  if (p.pnlPct !== null && p.pnlPct >= 100 && !tookHalf.has(p.mint)) {
    tookHalf.add(p.mint);
    const r = await bot.sell(p.mint, 50);
    bot.log(\`take half \${p.symbol}: \${r.message}\`);
  }
});`,
  },
  {
    name: 'Mirror a followed wallet, my size',
    description: 'When a wallet you follow buys, buy a fixed size; when it sells, sell the same share of yours.',
    code: `// Follow one wallet's buys and sells at my own size.
const LEADER = 'PasteTheWalletAddressHere';

bot.on('leaderTrade', async (t) => {
  if (t.leaderWallet !== LEADER) return;
  if (t.leaderSide === 'buy') {
    if (t.held) return;                                  // one position per token
    const r = await bot.buy(t.mint, 0.03);
    bot.log(\`copied buy \${t.symbol}: \${r.message}\`);
  } else if (t.held && t.leaderSoldPct !== null) {
    const r = await bot.sell(t.mint, t.leaderSoldPct);
    bot.log(\`copied sell \${t.leaderSoldPct}% \${t.symbol}: \${r.message}\`);
  }
});`,
  },
  {
    name: 'Runner alert to watchlist',
    description: 'When the scanner flags a runner with strong odds, pin it and notify — no trade.',
    code: `// Watch and notify on strong runner flags. Buys nothing.
bot.on('runner', async (t) => {
  if ((t.runnerOddsPct ?? 0) < 20) return;
  await bot.watch(t.mint);
  await bot.notify(\`Runner: \${t.symbol} — \${t.runnerOddsPct}% odds, score \${t.score ?? '—'}\`);
});`,
  },
  {
    name: 'Daily housekeeping',
    description: 'At 23:55 sell everything the script still holds and report the day.',
    code: `// Flat by midnight.
bot.at('23:55', async () => {
  const open = await bot.positions();
  const r = await bot.sellAll();
  await bot.notify(\`End of day: closed \${r.sold} of \${open.length} positions — \${r.message}\`);
});`,
  },
];

/** The variable guide as text, generated from the field table. */
export function fieldGuideText(): string {
  const groups: Array<[FieldScope, string]> = [
    ['token', 'Launch feed (any token the app saw launch)'],
    ['market', 'Market providers (when cached)'],
    ['position', 'Position (when held by this script)'],
    ['runner', 'Runner flag'],
    ['leader', 'Followed wallet'],
    ['order', 'Advanced order'],
    ['alert', 'Alert'],
    ['any', 'Always'],
  ];
  const out: string[] = [];
  for (const [scope, title] of groups) {
    out.push(`## ${title}`);
    for (const f of RULE_FIELDS.filter((x) => x.scope === scope)) {
      out.push(`- ${f.id} (${f.kind}, ${f.unit}) — ${f.hint || f.label}. null when ${f.nullWhen}.`);
    }
    out.push('');
  }
  out.push('## Always present');
  out.push('- mint (string) — the token address.');
  out.push('- symbol, name (string) — empty when unknown.');
  out.push('- priceHistory (number[]) — the launch feed’s rolling prices in SOL, oldest first; empty when none.');
  return out.join('\n');
}

/**
 * A self-contained prompt to paste into any AI assistant to get a script
 * written. Generated from the same tables the app runs on, so a method or
 * field it names is one that exists.
 */
export function aiPromptPack(): string {
  const events = SCRIPT_EVENTS_DOC.map((e) => `- \`${e.event}\` → payload: ${e.payload}. Fires when ${e.when}.`).join('\n');
  const api = SCRIPT_API.map((a) => `- \`${a.signature}\` → ${a.returns}. ${a.notes}`).join('\n');
  const examples = SCRIPT_EXAMPLES.map((e) => `### ${e.name}\n${e.description}\n\n\`\`\`js\n${e.code}\n\`\`\``).join('\n\n');
  return `# Write a Krypto Bot script

You are writing a JavaScript automation script for **Krypto Bot**, a Solana memecoin trading terminal. The script runs inside the app, in a sandbox, against a small API called \`bot\`. Follow every rule below; the app enforces them and a script that ignores them simply gets refused.

## What you are writing

- Plain JavaScript (ES2022). No imports, no \`require\`, no \`fetch\`, no \`WebSocket\`, no \`XMLHttpRequest\`, no DOM, no files, no timers other than \`bot.every\` / \`bot.at\`. Top-level \`await\` is allowed.
- The script body runs once at load. Register handlers with \`bot.on(...)\`; everything happens in handlers.
- Only \`bot\` and \`console\` (which logs to the script's own log) are available. \`Math\`, \`Date\`, \`JSON\`, \`Set\`, \`Map\` etc. are normal JavaScript.
- Handlers run one at a time per script. A handler that runs longer than **3 seconds** is killed and counted as an error; five errors in a row turn the script off. Keep handlers short; never loop forever or busy-wait.
- The script's memory resets when it restarts. To remember across restarts use \`bot.getState()\` / \`bot.setState(obj)\` (16 KB of JSON).

## Money rules the app enforces (you cannot bypass them; design for them)

- The script has a **budget** set by the user in the app: max SOL per buy, buys per day, open positions, actions per minute, and a daily realised-loss stop that turns the script off. Any \`bot.buy\` over the cap is **refused**, not shrunk — check \`r.ok\` and \`r.message\`.
- The script runs in **paper** (simulated fills into a paper book) or **live** mode, chosen by the user. The code is identical; do not branch on mode.
- Buys and sells go through the app's own pipeline. Sells are a percentage of what is held in the script's mode.
- Treat \`null\` as **unknown, never as zero**. Every numeric fact can be null; write \`if (t.score === null || t.score < 70) return;\` not \`if (t.score < 70)\`.

## Events

${events}

## The \`bot\` API

${api}

## The facts object ("Token" / "Position")

Every event except \`fill\`, \`schedule\` and \`interval\` receives one object with these fields (null = unknown):

${fieldGuideText()}

## Style

- Start with a one-line comment saying what the script does.
- Keep state in \`const\` Sets/Maps at the top of the script; use \`bot.setState\` only for things that must survive a restart.
- Log what you do: \`bot.log(\\\`buy \${t.symbol}: \${r.message}\\\`)\`.
- Prefer few, clear conditions. Do not invent fields or methods that are not listed above.
- Output only the script, as a single JavaScript code block, with no explanation before or after.

## Examples

${examples}

## Now write the script

The user will describe what they want below. Write it.
`;
}
