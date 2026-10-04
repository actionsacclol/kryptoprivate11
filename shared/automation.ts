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

import type { AppSettings, LaunchRow, WalletHolding } from './types';
import type { OrderKind } from './orders';
import type { RunnerFlag } from './runners';
import type { AlertKind } from './alerts';
import { nativeSymbolOf, type ChainKind } from './evm';
import type { EvmLaunchWindow, EvmScanLaunch } from './evmScan';
import type { EvmRunnerFlag } from './evmRunners';
import { parseXLink, type XLinkKind } from './xLink';
import { launchpadSite } from './tokenLinks';
import type { SecurityReport, TokenSummary } from './market';
import { creatorVerdict, type LaunchIntelReport } from './launchintel';
import type { RugReport, VolatilityNote } from './rugrules';
import type { OddsReport } from './odds';
import type { XStats } from './xStats';
import { domainAgeDays, type LinkIntelFacts } from './linkIntel';
import { EVENT_HARD_MS, EVENT_TIMEOUT_MS, type ScriptStatValue } from './scriptProtocol';
import { SCRIPT_INPUT_TYPES } from './scriptInputs';
import { siteLinksX, type SiteRead } from './siteRead';

// ── Chains ────────────────────────────────────────────────────────────
//
// A script runs on ONE chain. That is not a limitation to route around, it is
// what the facts allow: the launch intel behind most rule fields is pump's,
// and the two EVM rails measure a different, smaller set of things about a
// launch. Pretending otherwise would ship rules that silently never fire,
// because an unknown fact never satisfies a rule (house rule 4).
//
// So the model says out loud which facts and which actions each chain can
// supply, the editor hides the rest, and validation refuses a rule built on a
// fact its chain cannot know.

/**
 * Fields only the Solana launch feed can fill.
 *
 * Most of these are pump-population intel with no EVM counterpart at all:
 * `evmScan.ts` is explicit that the Krypt score "describes pump's population
 * and nothing else". The rest — holder and creator history, smart-money
 * counts, risk flags — come from Solana-only sources.
 */
export const SOLANA_ONLY_FIELDS: ReadonlySet<RuleField> = new Set<RuleField>([
  'score',
  'sellVolumeSol',
  'buyerAcceleration',
  'distinctSellers',
  'topBuyerShare',
  'topHolderShare',
  'earlyBuyerShare',
  'creatorPriorLaunches',
  'creatorPriorRugs',
  'smartBuyerCount',
  'smartEarly',
  'riskFlags',
  // The provider summary's extras and the links (2026-09-20): the EVM host
  // answers cap and liquidity only.
  'kryptScore',
  'bondingCurvePct',
  'devHoldingPct',
  'top10Pct',
  'insiderPct',
  'bundledPct',
  'sniperPct',
  // The Launch tab's cohorts (2026-09-27): pump.fun's launch window, so
  // Solana only by construction.
  'launchDevPct',
  'launchDevHeldPct',
  'launchBundlePct',
  'launchBundleHeldPct',
  'launchBundleRetainedPct',
  'launchBundleWallets',
  'launchBundleStillHolding',
  'launchSniperPct',
  'launchSniperHeldPct',
  'launchSniperRetainedPct',
  'launchSniperWallets',
  'launchSniperStillHolding',
  'launchTop3BuyersPct',
  'smartHolders',
  'volume5mUsd',
  'buys5m',
  'sells5m',
  'priceChange5mPct',
  'curveRegime',
  'isMayhem',
  'hasTwitter',
  'hasWebsite',
  'hasTelegram',
  'dexPaid',
  'twitter',
  'website',
  'telegram',
  'xLinkKind',
  'xHandle',
  'xReuseCount',
  'xFollowers',
  'xFollowing',
  'xVerified',
  'xLikes',
  'xReposts',
  'xReplies',
  'xViews',
  'xStatsAgeSec',
  // Telegram's public preview, the website's registry record and what the
  // site says (2026-09-20): looked up / read for Solana tokens only.
  'tgMembers',
  'tgOnline',
  'tgKind',
  'domainAgeDays',
  'domainHostedOn',
  'siteNamesContract',
  'siteLinksX',
  'siteOutboundHosts',
  'siteMentionsConnectWallet',
  'hardRisk',
  'phase',
  'launchpad',
  // The EVM bridge's facts() carries liquidity and market cap and nothing
  // else, so these two have no source on those rails.
  'holders',
  'priceUsd',
  // Advanced orders and alerts are a Solana-side feature (shared/orders.ts and
  // shared/alerts.ts carry no chain), so a rule cannot read their state on an
  // EVM chain either.
  'orderKind',
  'orderState',
  'orderAmount',
  'alertKind',
  'alertThreshold',
]);

/**
 * Triggers that can only ever fire on Solana.
 *
 * `runner`, `order` and `alert` have no EVM event at all — an EVM chain's
 * runner call rides on its launch window rather than arriving separately, and
 * advanced orders and alerts are a Solana-side feature. `tick` has no EVM
 * price stream reaching automation.
 *
 * A rule on one of these would sit armed forever without firing once, which is
 * the failure this whole chain model exists to prevent.
 */
// 'runner' and 'tick' left this list on 2026-10-03: the EVM chain scanners
// raise both (runner flags since 09-29, price prints as ticks since 10-03).
export const SOLANA_ONLY_TRIGGERS: ReadonlySet<RuleTrigger> = new Set<RuleTrigger>(['order', 'alert']);

export function triggerAvailableOn(trigger: RuleTrigger, chain: ChainKind): boolean {
  return chain === 'solana' || !SOLANA_ONLY_TRIGGERS.has(trigger);
}

/** Actions only Solana can carry out, for the same reason. */
export const SOLANA_ONLY_ACTIONS: ReadonlySet<RuleActionType> = new Set<RuleActionType>([
  'stop_loss',
  'take_profit',
  'trailing_stop',
  'limit_buy',
  'limit_sell',
  'cancel_orders',
  'apply_template',
  'alert',
]);

/** A chain's name for a message. Kept here so shared/ has no UI import. */
export function chainLabel(chain: ChainKind): string {
  return chain === 'solana' ? 'Solana' : chain === 'bnb' ? 'BNB Smart Chain' : 'Robinhood Chain';
}

export function fieldAvailableOn(field: RuleField, chain: ChainKind): boolean {
  return chain === 'solana' || !SOLANA_ONLY_FIELDS.has(field);
}

export function actionAvailableOn(type: RuleActionType, chain: ChainKind): boolean {
  return chain === 'solana' || !SOLANA_ONLY_ACTIONS.has(type);
}

/** On an EVM chain the money is that chain's coin. The field IDS keep saying
 *  `Sol` because they are a stored rule's schema and renaming them would break
 *  every saved script; the LABELS follow the chain. */
export function nativeFieldLabel(label: string, chain: ChainKind, symbol: string): string {
  return chain === 'solana' ? label : label.replace(/\bSOL\b/g, symbol);
}

/**
 * Rewrite a line of prose so its money reads in the chain's own coin.
 *
 * The same rule as `nativeFieldLabel`, applied to sentences rather than
 * labels. A user on Robinhood Chain reading "spends real SOL" about a script
 * that spends ETH has been told something false about their own money — and
 * until 2026-09-15 that was every money string on the Scripts page, which is
 * how a user came to believe their EVM script was trading SOL.
 */
export function nativeText(text: string, chain: ChainKind): string {
  return chain === 'solana' ? text : nativeFieldLabel(text, chain, nativeSymbolOf(chain));
}

export type ScriptKind = 'rules' | 'code';
export type ScriptMode = 'paper' | 'live';

/** The walls around a script. Every one is checked in main, per action. */
export interface ScriptBudget {
  /**
   * Hard cap on one buy, SOL, and the ONLY cap on a script's size.
   *
   * The app's manual per-trade cap stopped applying to scripts on 2026-09-22:
   * two caps for one decision meant keeping them in step, with the smaller
   * winning silently to whoever set the other. This is the number a script's
   * author set on the same screen as its code, so it is the one enforced —
   * `testTrade` is handed it as `ownCapSol` and backstops against it.
   */
  maxSolPerTrade: number;
  /** Buys per calendar day. */
  maxBuysPerDay: number;
  /** Realised loss in a day that DISABLES the script, SOL. Counts EVERY
   *  exit — the script's own sells and the stop-loss / take-profit orders
   *  that sold its bags — priced from the chain. */
  maxLossSolPerDay: number;
  /**
   * The same stop as a share of the WALLET, whichever is smaller (2026-09-28).
   * A 0.5 SOL stop on a 0.36 SOL wallet could never bind, and a script ran
   * that wallet to dust overnight. Optional: a script saved before this
   * existed reads as DEFAULT_LOSS_PCT_OF_WALLET.
   */
  maxLossPctOfWallet?: number;
  /** Positions this script may hold open at once. */
  maxOpenPositions: number;
  /** Any action (buy, sell, order, notify…) per minute — the runaway guard.
   *  Charged once per rule action and once per `bot.*` call, so a single
   *  "sell everything" that closes N bags costs one, not N: exits are
   *  deliberately ungated. */
  maxActionsPerMinute: number;
}

export const BUDGET_BOUNDS = {
  maxSolPerTrade: { min: 0.001, max: 50 },
  maxBuysPerDay: { min: 1, max: 500 },
  maxLossSolPerDay: { min: 0.01, max: 100 },
  maxLossPctOfWallet: { min: 1, max: 100 },
  maxOpenPositions: { min: 1, max: 50 },
  maxActionsPerMinute: { min: 1, max: 120 },
} as const;

/** Budget fields a saved script may lack; the default applies then. */
const OPTIONAL_BUDGET_KEYS: ReadonlySet<keyof ScriptBudget> = new Set(['maxLossPctOfWallet']);

/** What `maxLossPctOfWallet` reads as when a script does not say. */
export const DEFAULT_LOSS_PCT_OF_WALLET = 25;

export const DEFAULT_BUDGET: ScriptBudget = {
  maxSolPerTrade: 0.05,
  maxBuysPerDay: 20,
  maxLossSolPerDay: 0.5,
  maxLossPctOfWallet: DEFAULT_LOSS_PCT_OF_WALLET,
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
  // market — the rest of the provider summary (2026-09-20: "any data we can
  // get, scripts should have"). Solana only: the EVM rails' host answers
  // cap and liquidity and nothing else, and a null there would be a lie.
  | 'kryptScore'
  | 'bondingCurvePct'
  | 'devHoldingPct'
  | 'top10Pct'
  | 'insiderPct'
  | 'bundledPct'
  | 'sniperPct'
  | 'smartHolders'
  | 'volume5mUsd'
  | 'buys5m'
  | 'sells5m'
  | 'priceChange5mPct'
  | 'curveRegime'
  | 'isMayhem'
  // launch cohorts — the Launch tab's dev / bundle / sniper shares, bought
  // AND still held (2026-09-27). Filled when the app has the coin's launch
  // scan cached: after bot.launchIntel(mint), or while its page is open.
  | 'launchDevPct'
  | 'launchDevHeldPct'
  | 'launchBundlePct'
  | 'launchBundleHeldPct'
  | 'launchBundleRetainedPct'
  | 'launchBundleWallets'
  | 'launchBundleStillHolding'
  | 'launchSniperPct'
  | 'launchSniperHeldPct'
  | 'launchSniperRetainedPct'
  | 'launchSniperWallets'
  | 'launchSniperStillHolding'
  | 'launchTop3BuyersPct'
  // links — what the token's creator published, and what the X link IS
  | 'hasTwitter'
  | 'hasWebsite'
  | 'hasTelegram'
  | 'dexPaid'
  | 'twitter'
  | 'website'
  | 'telegram'
  | 'xLinkKind'
  | 'xHandle'
  | 'xReuseCount'
  | 'xFollowers'
  | 'xFollowing'
  | 'xVerified'
  | 'xLikes'
  | 'xReposts'
  | 'xReplies'
  | 'xViews'
  | 'xStatsAgeSec'
  | 'tgMembers'
  | 'tgOnline'
  | 'tgKind'
  | 'domainAgeDays'
  | 'domainHostedOn'
  | 'siteNamesContract'
  | 'siteLinksX'
  | 'siteOutboundHosts'
  | 'siteMentionsConnectWallet'
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
  {
    id: 'score',
    label: 'Krypt score',
    kind: 'number',
    scope: 'token',
    unit: '0–100',
    // SET ONCE AND NEVER AGAIN, and the one fact a script author must know
    // about it. A user waited seven hours across 1,770 launch updates for a
    // score above 80 to appear (2026-09-21); it is computed exactly once per
    // launch, so every one of those updates carried the same number. Typical
    // values, measured live: median 47, 90th percentile 63, about one launch
    // in thirty-six above 80 — and a first-time creator caps near 91, or 79
    // while the mint check is still outstanding.
    hint: 'The app’s composite score, fixed once when the launch is decided — it never moves afterwards, so do not wait for it to rise. Typically 40–65; above 80 is roughly 1 launch in 36.',
    nullWhen: 'the checks have not resolved yet, or the token was never on the launch feed',
  },
  { id: 'priceSol', label: 'Price (SOL)', kind: 'number', scope: 'token', unit: 'SOL per token', hint: 'Latest price the app knows', nullWhen: 'no price is known' },
  { id: 'curvePct', label: 'Curve progress %', kind: 'number', scope: 'token', unit: '0–100', hint: 'Bonding curve filled', nullWhen: 'not on the launch feed' },
  { id: 'uniqueBuyers', label: 'Unique buyers', kind: 'number', scope: 'token', unit: 'wallets', hint: 'Distinct wallet addresses that bought since the launch was detected. Raw addresses: linked wallets, bundles and wash trades are not merged — pair it with earlyBuyerShare or bundledPct. Stops rising after the 15 s decision unless the coin stays tracked (held, runner-flagged or subscribed). On BNB and Robinhood it is the scanner’s latest 60 s or 120 s window.', nullWhen: 'not on the launch feed' },
  { id: 'buys', label: 'Buys', kind: 'number', scope: 'token', unit: 'count', hint: 'Buys since the launch was detected (BNB/Robinhood: the latest 60 s or 120 s window)', nullWhen: 'not on the launch feed' },
  { id: 'sells', label: 'Sells', kind: 'number', scope: 'token', unit: 'count', hint: 'Sells since the launch was detected (BNB/Robinhood: the latest 60 s or 120 s window)', nullWhen: 'not on the launch feed' },
  { id: 'netInflowSol', label: 'Net inflow (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: 'Buy volume minus sell volume', nullWhen: 'not on the launch feed' },
  { id: 'buyVolumeSol', label: 'Buy volume (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'sellVolumeSol', label: 'Sell volume (SOL)', kind: 'number', scope: 'token', unit: 'SOL', hint: '', nullWhen: 'not on the launch feed' },
  { id: 'buyerAcceleration', label: 'Buyer acceleration', kind: 'number', scope: 'token', unit: 'ratio', hint: 'Distinct buyers in the second half of the evaluation window (15 s by default, split at its midpoint) over the first half; a wallet buying in both halves counts in each. 2 when only the second half has buyers. Fixed once the window closes. Solana only.', nullWhen: 'not on the launch feed' },
  { id: 'distinctSellers', label: 'Distinct sellers', kind: 'number', scope: 'token', unit: 'wallets', hint: 'Distinct wallet addresses that sold since the launch was detected', nullWhen: 'not on the launch feed' },
  { id: 'topBuyerShare', label: 'Top buyer share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Largest buyer’s share of buy volume', nullWhen: 'not on the launch feed' },
  { id: 'topHolderShare', label: 'Top holder share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Largest wallet’s share of circulating tokens', nullWhen: 'not on the launch feed' },
  { id: 'earlyBuyerShare', label: 'Early buyer share', kind: 'number', scope: 'token', unit: '0–1', hint: 'Held by wallets that bought in the early window', nullWhen: 'not on the launch feed' },
  {
    id: 'creatorSold',
    label: 'Creator sold',
    kind: 'boolean',
    scope: 'token',
    unit: 'true/false',
    // What FALSE means, which is not what it looks like. It is the starting
    // value and flips only when a creator sell is actually seen inside the
    // window, so false is "none seen yet", never "they will not". Roughly one
    // launch in six flips to true (measured live, 2026-09-21).
    hint: 'True once the creator wallet is seen selling. False is the starting value and means no sell has been seen YET, not that there will not be one — about 1 launch in 6 turns true.',
    nullWhen: 'not on the launch feed',
  },
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
  { id: 'kryptScore', label: 'Krypt score (providers)', kind: 'number', scope: 'market', unit: '0–100', hint: 'The token page’s score: liquidity, sellability, the creator’s record, a pump ban', nullWhen: 'the checks have not resolved, or no provider answered' },
  { id: 'bondingCurvePct', label: 'Bonding curve % (providers)', kind: 'number', scope: 'market', unit: '0–100', hint: '100 = graduated to a DEX', nullWhen: 'unknown to the providers' },
  { id: 'devHoldingPct', label: 'Dev holding %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'What the creator wallet holds', nullWhen: 'unknown to the providers' },
  { id: 'top10Pct', label: 'Top 10 holders %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: '', nullWhen: 'unknown to the providers' },
  { id: 'insiderPct', label: 'Insiders %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'Held by wallets the providers tag as insiders', nullWhen: 'unknown to the providers' },
  { id: 'bundledPct', label: 'Bundled %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'Bought in the launch bundle, as the providers report it — null on nearly every new pump.fun coin. Falls back to launchBundlePct once the launch scan is cached (see bot.launchIntel).', nullWhen: 'unknown to the providers and no launch scan is cached' },
  { id: 'sniperPct', label: 'Snipers %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'As the providers report it; falls back to launchSniperPct once the launch scan is cached', nullWhen: 'unknown to the providers and no launch scan is cached' },
  // The Launch tab's cohorts (2026-09-27). The provider shares above are
  // null on nearly every new pump.fun coin — the providers index a launch
  // minutes later, if at all — while the app had already measured these
  // itself from pump's swap-api launch window plus one RPC batch
  // (shared/launchintel.ts) and shown them on the token page. Scripts could
  // not see them. Bought and still-held travel together on purpose: a 40 %
  // bundle that has left is history; one that still holds 38 % is the
  // reason not to buy, and one number cannot say which.
  { id: 'launchDevPct', label: 'Launch: dev bought %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'What the creator wallet bought in the launch window — the Launch tab’s dev cohort. Filled for 45 s after bot.launchIntel(mint) or bot.security(mint), or after someone opens the coin’s page; null once that memo ages out.', nullWhen: 'the launch scan is not cached, the launch block could not be isolated, or the supply is unknown' },
  { id: 'launchDevHeldPct', label: 'Launch: dev holds %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'What the creator wallet holds NOW, of supply — read from the chain with the scan', nullWhen: 'the launch scan is not cached, or the balances could not be read' },
  { id: 'launchBundlePct', label: 'Launch: bundle bought %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'Bought in the launch block itself by wallets other than the creator — the number people mean by “bundled”. Same-slot buys were arranged in advance: nobody can react to a block they cannot yet see. 0 is a real zero (the block was scanned and held no other buyer).', nullWhen: 'the launch scan is not cached, the launch block could not be isolated, or the supply is unknown' },
  { id: 'launchBundleHeldPct', label: 'Launch: bundle holds %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'What the bundle wallets hold NOW, of supply. Read next to launchBundlePct: bought 40 % and holds 2 % has distributed; bought 40 % and holds 38 % has not.', nullWhen: 'the launch scan is not cached, or the balances could not be read' },
  { id: 'launchBundleRetainedPct', label: 'Launch: bundle kept %', kind: 'number', scope: 'market', unit: 'percent of what they bought', hint: 'Of what the bundle wallets bought, the share still held — 100 means nobody has sold', nullWhen: 'the launch scan is not cached, the balances could not be read, or nothing was bought' },
  { id: 'launchBundleWallets', label: 'Launch: bundle wallets', kind: 'number', scope: 'market', unit: 'wallets', hint: 'How many non-creator wallets bought in the launch block', nullWhen: 'the launch scan is not cached, or the launch block could not be isolated' },
  { id: 'launchBundleStillHolding', label: 'Launch: bundle wallets still in', kind: 'number', scope: 'market', unit: 'wallets', hint: 'Of the bundle wallets, how many still hold anything', nullWhen: 'the launch scan is not cached, or the balances could not be read' },
  { id: 'launchSniperPct', label: 'Launch: snipers bought %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'Bought within 20 slots (about 8 s) AFTER the launch block by wallets that were not in it — fast, but reactive rather than pre-arranged, so kept apart from the bundle', nullWhen: 'the launch scan is not cached, the launch block could not be isolated, or the supply is unknown' },
  { id: 'launchSniperHeldPct', label: 'Launch: snipers hold %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'What the sniper wallets hold NOW, of supply', nullWhen: 'the launch scan is not cached, or the balances could not be read' },
  { id: 'launchSniperRetainedPct', label: 'Launch: snipers kept %', kind: 'number', scope: 'market', unit: 'percent of what they bought', hint: 'Of what the snipers bought, the share still held', nullWhen: 'the launch scan is not cached, the balances could not be read, or nothing was bought' },
  { id: 'launchSniperWallets', label: 'Launch: sniper wallets', kind: 'number', scope: 'market', unit: 'wallets', hint: 'How many wallets sniped inside the window', nullWhen: 'the launch scan is not cached, or the launch block could not be isolated' },
  { id: 'launchSniperStillHolding', label: 'Launch: sniper wallets still in', kind: 'number', scope: 'market', unit: 'wallets', hint: 'Of the sniper wallets, how many still hold anything', nullWhen: 'the launch scan is not cached, or the balances could not be read' },
  { id: 'launchTop3BuyersPct', label: 'Launch: top 3 buyers %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'The three largest non-creator buys in the launch window, summed — a concentration (volatility) fact, not a verdict', nullWhen: 'the launch scan is not cached, the launch block could not be isolated, or nobody but the creator bought' },
  { id: 'smartHolders', label: 'Smart-money holders', kind: 'number', scope: 'market', unit: 'wallets', hint: 'Per the providers’ smart-money lists', nullWhen: 'unknown to the providers' },
  { id: 'volume5mUsd', label: 'Volume 5m (USD)', kind: 'number', scope: 'market', unit: 'USD', hint: '', nullWhen: 'no 5-minute window from the providers' },
  { id: 'buys5m', label: 'Buys 5m', kind: 'number', scope: 'market', unit: 'count', hint: '', nullWhen: 'no 5-minute window from the providers' },
  { id: 'sells5m', label: 'Sells 5m', kind: 'number', scope: 'market', unit: 'count', hint: '', nullWhen: 'no 5-minute window from the providers' },
  { id: 'priceChange5mPct', label: 'Price change 5m %', kind: 'number', scope: 'market', unit: 'percent', hint: '', nullWhen: 'no 5-minute window from the providers' },
  { id: 'hasTwitter', label: 'Has X link', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'The creator published an X (Twitter) link', nullWhen: 'no provider has answered for socials' },
  { id: 'hasWebsite', label: 'Has website', kind: 'boolean', scope: 'market', unit: 'true/false', hint: '', nullWhen: 'no provider has answered for socials' },
  { id: 'hasTelegram', label: 'Has Telegram', kind: 'boolean', scope: 'market', unit: 'true/false', hint: '', nullWhen: 'no provider has answered for socials' },
  { id: 'dexPaid', label: 'DexScreener paid', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'Someone paid for the enhanced listing — a weak but real filter', nullWhen: 'no provider has answered for socials' },
  { id: 'twitter', label: 'X link', kind: 'text', scope: 'market', unit: 'URL', hint: 'As published; the app never visits it', nullWhen: 'none published, or no provider answered' },
  { id: 'website', label: 'Website', kind: 'text', scope: 'market', unit: 'URL', hint: 'As published; the app never visits it', nullWhen: 'none published, or no provider answered' },
  { id: 'telegram', label: 'Telegram link', kind: 'text', scope: 'market', unit: 'URL', hint: '', nullWhen: 'none published, or no provider answered' },
  { id: 'xLinkKind', label: 'X link kind', kind: 'text', scope: 'market', unit: 'profile · post · community · search · other-x · not-x · none', hint: 'What the X link IS — an account, one post, a room, a search. A post is not an account.', nullWhen: 'no provider has answered for socials' },
  { id: 'xHandle', label: 'X handle', kind: 'text', scope: 'market', unit: 'handle without @', hint: 'The account the X link names', nullWhen: 'the link names no account' },
  { id: 'xReuseCount', label: 'X link reused by', kind: 'number', scope: 'market', unit: 'other launches', hint: 'Launches the scanner has in view pointing at the SAME account or post — a farm from the outside', nullWhen: 'not counted (no X link, or the scanner is not running)' },
  { id: 'xFollowers', label: 'X followers (read)', kind: 'number', scope: 'market', unit: 'followers', hint: 'Read off the X profile in the Links panel when someone opened it there — never fetched', nullWhen: 'nobody opened the profile in the Links panel, or the page could not be read' },
  { id: 'xFollowing', label: 'X following (read)', kind: 'number', scope: 'market', unit: 'accounts', hint: 'Read off the X profile in the Links panel', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xVerified', label: 'X verified (read)', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'The badge on the X profile, as read in the Links panel', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xLikes', label: 'X post likes (read)', kind: 'number', scope: 'market', unit: 'likes', hint: 'When the linked X page is a post', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xReposts', label: 'X post reposts (read)', kind: 'number', scope: 'market', unit: 'reposts', hint: '', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xReplies', label: 'X post replies (read)', kind: 'number', scope: 'market', unit: 'replies', hint: '', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xViews', label: 'X post views (read)', kind: 'number', scope: 'market', unit: 'views', hint: '', nullWhen: 'nobody opened the page in the Links panel, or the page did not show it' },
  { id: 'xStatsAgeSec', label: 'X read age (s)', kind: 'number', scope: 'market', unit: 'seconds', hint: 'How long ago the Links panel read the page — gate on it so a stale number does not decide', nullWhen: 'nobody opened the page in the Links panel' },
  { id: 'tgMembers', label: 'Telegram members', kind: 'number', scope: 'market', unit: 'members', hint: 'Subscribers (a channel) or members (a group) as Telegram’s public preview page shows anyone — fetched from t.me when a person opened the token or a script asked about it', nullWhen: 'no Telegram link, nobody asked about the token yet, a private invite (Telegram shows no count), or t.me did not answer' },
  { id: 'tgOnline', label: 'Telegram online', kind: 'number', scope: 'market', unit: 'members', hint: 'Members online right now, as the preview shows for a group', nullWhen: 'a channel (Telegram shows none), or no preview read' },
  { id: 'tgKind', label: 'Telegram link kind', kind: 'text', scope: 'market', unit: 'channel · group · account · invite · unknown', hint: 'What the Telegram link IS. An account is a person or bot, not a room; a private invite shows no count.', nullWhen: 'no Telegram link, or no preview read' },
  { id: 'domainAgeDays', label: 'Website domain age (days)', kind: 'number', scope: 'market', unit: 'days', hint: 'Days since the website’s domain was registered, from the registry’s public RDAP record (via data.iana.org) — fetched when a person opened the token or a script asked', nullWhen: 'no website, hosted on a shared platform (see domainHostedOn), the registry publishes no RDAP (.io, .me, .co), or not looked up yet' },
  { id: 'domainHostedOn', label: 'Website hosted on', kind: 'text', scope: 'market', unit: 'platform', hint: 'The shared platform the site sits on — Vercel, GitHub Pages, Carrd… — when it has no domain of its own', nullWhen: 'the site has its own domain, or no website' },
  { id: 'siteNamesContract', label: 'Site names the contract', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'The token’s own website mentions this contract address in its text or links, as read in the Links panel when someone opened it there — a site made for another coin, or for every coin, does not', nullWhen: 'nobody opened the site in the Links panel' },
  { id: 'siteLinksX', label: 'Site links the token’s X', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'The website links the same X account the launch published', nullWhen: 'nobody opened the site in the Links panel, or the token has no X account to compare' },
  { id: 'siteOutboundHosts', label: 'Site outbound hosts', kind: 'number', scope: 'market', unit: 'hosts', hint: 'Distinct other sites the page links to — how much of a site it is', nullWhen: 'nobody opened the site in the Links panel' },
  { id: 'siteMentionsConnectWallet', label: 'Site asks to connect a wallet', kind: 'boolean', scope: 'market', unit: 'true/false', hint: 'The page text asks visitors to connect a wallet or claim tokens / an airdrop — the words a drainer page uses; the words, not a verdict', nullWhen: 'nobody opened the site in the Links panel' },
  { id: 'runnerOddsPct', label: 'Runner odds %', kind: 'number', scope: 'runner', unit: 'percent', hint: 'Observed graduation rate for the flag bucket', nullWhen: 'not a runner event' },
  // The single most decision-relevant fact we have about a flag, and it was
  // not reachable from a rule or a script until 2026-09-22. Buying every flag
  // loses under every exit rule tested — but the loss lives almost entirely in
  // MIXED curves (91 % of live flags), and classic-curve flags were
  // indistinguishable from break-even. See docs/runner-outcome-2026-09-11.md.
  { id: 'curveRegime', label: 'Curve regime', kind: 'text', scope: 'runner', unit: 'classic / mixed / unknown', hint: 'Mixed curves are the population that carries the loss after a flag', nullWhen: 'not a runner event, or the reserves could not be read' },
  // A mayhem coin trades against inflated virtual reserves (hundreds of SOL
  // at create, not 30) and needs a reserved fee recipient to trade — the same
  // create-event test the scanner's mayhem filter uses. Added 09-22 so a
  // script can refuse them.
  { id: 'isMayhem', label: 'Mayhem coin', kind: 'boolean', scope: 'runner', unit: 'true/false', hint: 'A pump mayhem-mode coin, told from its create-event reserves', nullWhen: 'not a runner event, or the create event carried no reserves' },
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
  | { type: 'cancel_orders'; kinds?: OrderKind[] }
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
// There is no script size cap (removed 2026-09-26, user's call). It was 64 KB,
// then 256 KB; it only ever protected the live update, which carried every
// script's full code on every log line. Live updates now leave code out
// (`codeOmitted`, mergeSnapshot), and the code reaches the sandbox as a
// message, not a URL, so nothing downstream needs a bound.
export const MAX_SCRIPTS = 20;
export const MAX_STATE_BYTES = 16 * 1024;

export interface UserScript {
  id: string;
  name: string;
  kind: ScriptKind;
  /** The chain this script watches and trades on. Absent on scripts saved
   *  before 2026-09-14, which were all Solana — `scriptChain` reads it. */
  chain?: ChainKind;
  enabled: boolean;
  mode: ScriptMode;
  /** kind = code. */
  code: string;
  /**
   * Answers to the settings the code declares in its `@inputs` block, read by
   * the script as `bot.input`. Absent on every script written before
   * 2026-09-22 and on any script that asks for nothing.
   */
  inputs?: import('./scriptInputs').ScriptInputValues;
  /** kind = rules. */
  rules: RuleSet;
  budget: ScriptBudget;
  createdAt: number;
  updatedAt: number;
  /**
   * Set on a script that ships with the app (bundled/scripts/*.js), never by
   * the window. `sha` is the shipped code it was last given; `edited` goes
   * true when the user saves different code, after which updates stop
   * replacing it (Reset to shipped version brings it back).
   */
  bundled?: { key: string; sha: string; edited?: boolean };
}

/** A script the app ships to every user (see electron/engine/bundledScripts.ts). */
export interface BundledScript {
  key: string;
  name: string;
  code: string;
}

export function defaultRules(chain: ChainKind = 'solana'): RuleSet {
  // The Solana default leans on the launch feed's intel. An EVM chain has no
  // score and no risk flags, so its starter rule is built only from what its
  // scanner actually measures — otherwise the first rule a user sees would be
  // one that can never fire.
  const conditions: RuleCondition[] =
    chain === 'solana'
      ? [
          { field: 'score', op: 'gte', value: 70 },
          { field: 'hardRisk', op: 'is_false', value: '' },
          { field: 'uniqueBuyers', op: 'gte', value: 15 },
        ]
      : [
          { field: 'uniqueBuyers', op: 'gte', value: 15 },
          { field: 'creatorSold', op: 'is_false', value: '' },
          { field: 'netInflowSol', op: 'gt', value: 0 },
        ];
  return {
    trigger: 'launch_update',
    conditions,
    actions: [{ type: 'buy', sol: 0.02 }],
    oncePerMint: true,
    cooldownSec: 60,
  };
}

/** The chain a script runs on. A script stored before chains existed is
 *  Solana — the same "absent = solana" reading copy trading uses. */
export function scriptChain(s: { chain?: ChainKind }): ChainKind {
  return s.chain ?? 'solana';
}

export function defaultScript(kind: ScriptKind, chain: ChainKind = 'solana'): Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: kind === 'rules' ? 'New rule' : 'New script',
    kind,
    chain,
    enabled: false,
    mode: 'paper',
    code: kind === 'code' ? SCRIPT_EXAMPLES[0].code : '',
    rules: defaultRules(chain),
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
  /** Paid for what is still held (average cost), in the chain's own coin.
   *  NULL when the basis is genuinely unknown — an unreconciled buy — rather
   *  than 0, which would read as "free" and satisfy a rule about cost. */
  costSol: number | null;
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
  /** The token's image as the providers serve it — for a script's Discord
   *  embed thumbnail. Null or absent when unknown (and on the EVM rails). */
  imageUrl?: string | null;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  launchpad: string | null;
  symbol?: string;
  name?: string;
  // The rest of the provider summary (2026-09-20). All optional: the EVM
  // rails' host does not answer them, and an absent field reads as null.
  kryptScore?: number | null;
  bondingCurvePct?: number | null;
  devHoldingPct?: number | null;
  top10Pct?: number | null;
  insiderPct?: number | null;
  bundledPct?: number | null;
  sniperPct?: number | null;
  smartHolders?: number | null;
  volume5mUsd?: number | null;
  buys5m?: number | null;
  sells5m?: number | null;
  priceChange5mPct?: number | null;
  socials?: { twitter: string | null; website: string | null; telegram: string | null; dexPaid: boolean } | null;
  /** Other launches in view linking the same X account or post; null = not counted. */
  xReuseCount?: number | null;
  /** What the Links panel read off the X page when a person opened it
   *  there, with when; null until then. Flattened into the x* variables. */
  xStats?: { stats: XStats; readAt: number } | null;
  /** Telegram's public preview and the website's registry record, when
   *  looked up (main does it when a person or a script asks about the token). */
  linkIntel?: LinkIntelFacts | null;
  /** What the Links panel read off the token's own website, when a person opened it there. */
  siteRead?: { read: SiteRead; readAt: number } | null;
}

/** The token's links, as `bot.links()` hands them to a script. */
export interface ScriptLinks {
  twitter: string | null;
  website: string | null;
  telegram: string | null;
  launchpadLabel: string | null;
  launchpadUrl: string | null;
  x: {
    kind: XLinkKind;
    handle: string | null;
    postId: string | null;
    label: string;
    /** Other launches in view that link the same account / the same post. */
    accountReuse: number;
    postReuse: number;
    /** What the Links panel read off the X page when a person opened it
     *  there (followers, likes, …); null when nobody has. Never fetched. */
    stats: XStats | null;
    statsReadAt: number | null;
  };
  /** Telegram's public preview of the linked room; null until looked up. */
  telegramStats: LinkIntelFacts['telegram'];
  /** The website's registry record (or the shared platform it sits on); null until looked up. */
  domain: LinkIntelFacts['domain'];
  /** What the Links panel read off the website when a person opened it there; null until then. */
  site: (SiteRead & { readAt: number }) | null;
}

/**
 * The security report, as `bot.security()` hands it to a script.
 *
 * Until 2026-09-27 this was the score, the checks and the warnings — the
 * report's concentration block (dev / bundle / sniper shares, and what those
 * wallets STILL hold), the measured rug rules, the graduation odds and the
 * creator record were computed for the token page and dropped at this
 * wall. Now the whole report crosses, on the rule that any data the app has,
 * a script may have. Every share is % of supply; null is unknown, never 0.
 */
export interface ScriptSecurity {
  score: number | null;
  checksResolved: number;
  checksTotal: number;
  checks: Array<{ id: string; label: string; verdict: string; detail: string; source: string; weight: number; kind: 'gate' | 'fact' }>;
  warnings: string[];
  /** The supply-share block the token page charts. bundledPct / sniperPct
   *  are the provider's when it has them, else the launch scan's; the
   *  *HeldPct are what those wallets hold NOW and are never inferred. */
  concentration: SecurityReport['concentration'];
  creator: {
    address: string | null;
    /** Launches / rugs this install itself observed. */
    priorLaunches: number | null;
    priorRugs: number | null;
    /** pump.fun-wide record, when the source answered. */
    launches: number | null;
    graduated: number | null;
    graduationRate: number | null;
    launchesInBusiestDay: number | null;
    /** Jupiter's cross-launchpad counts (include this mint). */
    devMints: number | null;
    devMigrations: number | null;
    /** RugCheck's "creator history of rugged tokens" risk. Null when silent. */
    rugcheckCreatorRugs: boolean | null;
    /** The one-line verdict the token page shows: pass · warn · fail, null without a record. */
    verdict: 'pass' | 'warn' | 'fail' | null;
    detail: string;
  };
  /** Measured rug rules for the launch window. Null when no window exists. */
  rug: RugReport | null;
  /** Two-sided concentration notes — what each supply-share row has meant historically. */
  volatility: VolatilityNote[];
  /** Graduation odds for the launch window (+60 s / +120 s). Null when unjudged. */
  odds: OddsReport | null;
  /** DexScreener's paid listing, boosts and community takeover — descriptive, never scored. */
  dexPaid: { paid: boolean | null; paidAt: number | null; boosts: number | null; communityTakeover: boolean | null };
  generatedAt: number;
}

/**
 * One token the active wallet holds, as `bot.holdings()` hands it over. The
 * same shape on every chain: the Solana fields the EVM rails cannot fill
 * (token account, raw units, decimals, program) are null there, not
 * invented. `warning` says why a bag may not be sellable; null means the
 * mint was checked and carries nothing suspicious.
 */
export interface ScriptHolding {
  mint: string;
  symbol: string | null;
  uiAmount: number;
  amountRaw: string | null;
  decimals: number | null;
  tokenAccount: string | null;
  programId: string | null;
  warning: string | null;
}

/** A wallet holding as the engine reads it → what a script gets. Absent
 *  `warning` means the mint could not be read — unknown is not "fine". */
export function scriptHoldingFromWallet(h: WalletHolding): ScriptHolding {
  return {
    mint: h.mint,
    symbol: h.symbol,
    uiAmount: h.uiAmount,
    amountRaw: h.amountRaw,
    decimals: h.decimals,
    tokenAccount: h.tokenAccount,
    programId: h.programId ?? null,
    warning: h.warning === undefined ? 'unknown — the mint could not be read' : h.warning,
  };
}

/**
 * The app's settings as `bot.settings()` hands them over — read-only, and
 * scrubbed (2026-09-27).
 *
 * A script may want to know the slippage it will trade at, whether live is
 * on, the per-trade cap, which providers are switched on, the scanner's
 * thresholds. It must never learn a key or an endpoint: the Helius key is
 * embedded in the RPC URLs, the AI key sits in `ai`, the bots' tokens in
 * `bots`, the MCP bearer in `mcp`. So the whole tree is copied through one
 * scrub — any field whose NAME says key / token / secret / password / url /
 * wss / http goes, and any string VALUE that reads as a URL goes — and then
 * only the blocks a script has a use for are handed back. A field that was
 * scrubbed is absent, never blanked, so `undefined` reads as "not shown".
 */
export interface ScriptSettingsView {
  /** 'live' or 'paper': the app's own switch, not this script's mode. */
  mode: 'live' | 'paper';
  execution: Record<string, unknown>;
  strategy: Record<string, unknown>;
  data: Record<string, unknown> & { hasBirdeyeKey: boolean; hasJupiterKey: boolean };
  alerts: Record<string, unknown>;
  evm: Record<string, unknown>;
}

const SECRET_KEY = /key|token|secret|password|passphrase|bearer|url|wss|http|referrer/i;
/** Names the pattern catches that are plainly not secrets (audit 2026-09-27). */
const SAFE_KEYS = new Set(['loadTokenImages']);
const LOOKS_LIKE_URL = /^(https?|wss?):\/\//i;

/** A deep copy with every secret-shaped field and URL-shaped value removed. */
export function scrubForScript(v: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => scrubForScript(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && !SAFE_KEYS.has(k)) continue;
      const s = scrubForScript(val, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  if (typeof v === 'string' && LOOKS_LIKE_URL.test(v.trim())) return undefined;
  if (typeof v === 'function') return undefined;
  return v;
}

export function scriptSettingsView(s: AppSettings): ScriptSettingsView {
  const pick = (block: unknown): Record<string, unknown> => (scrubForScript(block) as Record<string, unknown> | undefined) ?? {};
  const data = pick(s.data);
  return {
    mode: s.execution?.liveEnabled ? 'live' : 'paper',
    execution: pick(s.execution),
    strategy: pick(s.strategy),
    data: { ...data, hasBirdeyeKey: !!(s.data?.birdeyeApiKey ?? '').trim(), hasJupiterKey: !!(s.data?.jupiterApiKey ?? '').trim() },
    alerts: pick(s.alerts),
    evm: pick(s.evm),
  };
}

/** One launch cohort (dev / bundle / snipers), as `bot.launchIntel()` hands it over. */
export interface ScriptLaunchCohort {
  /** Wallets in the cohort. */
  wallets: number;
  /** Tokens bought during the window, UI units. */
  bought: number;
  /** % of total supply bought during the window. Null when supply is unknown. */
  boughtPct: number | null;
  /** SOL spent during the window. */
  sol: number;
  /** % of total supply these wallets hold NOW. Null until balances are read. */
  heldPct: number | null;
  /** Of what they bought, the % still held. Null until read, or when nothing was bought. */
  retainedPct: number | null;
  /** How many of them still hold anything. Null until read. */
  stillHolding: number | null;
}

export interface ScriptLaunchWallet {
  address: string;
  cohort: 'dev' | 'bundle' | 'sniper' | 'early';
  /** Slots after the launch slot; 0 is the launch block itself. */
  slotOffset: number;
  bought: number;
  boughtPct: number | null;
  sol: number;
  /** Sold again inside the window that was scanned. */
  soldInWindow: boolean;
  /** Current balance, UI units. Null until read. */
  heldNow: number | null;
  heldPct: number | null;
}

/**
 * The Launch tab's answer for one pump.fun mint — who bought the first
 * blocks and what they hold now — as `bot.launchIntel()` hands it over. The
 * token page's LaunchIntelReport with its analysis lifted to the top level.
 */
export interface ScriptLaunchIntel {
  mint: string;
  creator: string | null;
  /** Total supply, UI units. Null ⇒ every percentage in here is null. */
  supply: number | null;
  /** True when the scan reached the token's genuine first trade. False means
   *  the launch block could not be isolated: every cohort is empty, the
   *  counts null, and `note` says why. Never an approximation. */
  complete: boolean;
  launchSlot: number | null;
  launchTs: number | null;
  tradesScanned: number;
  slotsSpanned: number;
  /** How many slots after the launch block still count as a snipe (20 ≈ 8 s). */
  sniperWindowSlots: number;
  /** True once the wallets' current balances were read; the held figures stay null before that. */
  priced: boolean;
  dev: ScriptLaunchCohort;
  bundle: ScriptLaunchCohort;
  snipers: ScriptLaunchCohort;
  /** Sum of the three largest NON-creator bought shares, of supply. */
  top3BuyersPct: number | null;
  /** Every wallet that bought in the window, largest first. */
  wallets: ScriptLaunchWallet[];
  source: 'pumpswap' | 'engine' | 'none';
  /** Why the analysis is missing or partial. Null when it is whole. */
  note: string | null;
  /** Why current balances are missing. Null when they were read. */
  balancesNote: string | null;
  generatedAt: number;
}

/** The creator's record, as `bot.creator()` hands it to a script. */
export interface ScriptCreator {
  address: string;
  launches: number;
  graduated: number;
  graduationRate: number | null;
  medianAthUsd: number | null;
  bestAthUsd: number | null;
  firstLaunchAt: number | null;
  lastLaunchAt: number | null;
  /** True when the source paginated out — `launches` is then a floor. */
  truncated: boolean;
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
export type RuleContext = { [K in RuleField]: K extends 'riskFlags' ? string[] : K extends 'creatorSold' | 'smartEarly' | 'hardRisk' | 'held' | 'isMayhem' | 'hasTwitter' | 'hasWebsite' | 'hasTelegram' | 'dexPaid' | 'xVerified' | 'siteNamesContract' | 'siteLinksX' | 'siteMentionsConnectWallet' ? boolean | null : K extends 'phase' | 'curveRegime' | 'symbol' | 'name' | 'launchpad' | 'leaderWallet' | 'leaderLabel' | 'leaderSide' | 'orderKind' | 'orderState' | 'alertKind' | 'twitter' | 'website' | 'telegram' | 'xLinkKind' | 'xHandle' | 'tgKind' | 'domainHostedOn' ? string | null : number | null } & {
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

/**
 * A rule context from an EVM chain's scanner.
 *
 * Only the facts that chain actually measures are filled. Everything else is
 * left NULL rather than defaulted, so a condition on it cannot hold — which is
 * the point, and is why the editor refuses to build one in the first place.
 *
 * `netInflowSol` / `buyVolumeSol` keep their Solana-era ids but carry the
 * CHAIN'S OWN COIN, and they stay null when the curve is not quoted in it.
 * On 2026-09-11 only 22 % of live BNB launches were BNB-quoted (evmScan.ts),
 * so summing the rest as if they were BNB is exactly the bug that audit found.
 * A rule that asks about money on a non-native curve therefore gets an unknown
 * and does not fire, which is the honest answer.
 */
export function contextFromEvmLaunch(launch: EvmScanLaunch, now: number): RuleContext {
  const c = emptyContext(launch.token, launch.symbol ?? '', launch.name ?? '');
  // Newest closed window — the chain measures in 60 s / 120 s blocks.
  const w: EvmLaunchWindow | undefined = Array.isArray(launch.windows) && launch.windows.length
    ? launch.windows[launch.windows.length - 1]
    : undefined;
  c.ageSec = num(launch.seenAt) !== null ? Math.max(0, (now - launch.seenAt) / 1000) : null;
  if (w) {
    c.uniqueBuyers = num(w.uniqueBuyers);
    c.buys = num(w.buys);
    c.sells = num(w.sells);
    c.curvePct = num(w.curvePct);
    c.creatorSold = typeof w.creatorSold === 'boolean' ? w.creatorSold : null;
    // Native-quoted only. `netNative` is already null otherwise; num() keeps it null.
    c.netInflowSol = num(w.netNative);
    c.buyVolumeSol = num(w.volumeNative);
  }
  // This chain's own record of how launches that started like this one went.
  c.runnerOddsPct = launch.call ? num(launch.call.ratePct) : null;
  return c;
}

export function contextFromRunner(flag: RunnerFlag, launch: LaunchRow | null, now: number): RuleContext {
  const c = launch ? contextFromLaunch(launch, now) : emptyContext(flag.mint, flag.symbol ?? '', flag.name ?? '');
  c.runnerOddsPct = num(flag.observedPct);
  // Carried from the flag, which is the only place it is measured. A launch
  // that was never flagged has no regime here and reads as null — unknown,
  // which a filter should treat as "not classic" rather than as permission.
  c.curveRegime = flag.regime ?? null;
  c.isMayhem = typeof flag.mayhem === 'boolean' ? flag.mayhem : null;
  return c;
}

/**
 * A runner flag from an EVM chain's scanner (Robinhood, BNB) as a script sees
 * it — the chain's launch facts when it still has the launch, else the flag's
 * own. Solana-only facts (curve regime, mayhem) stay null.
 */
export function contextFromEvmRunner(flag: EvmRunnerFlag, launch: EvmScanLaunch | null, now: number): RuleContext {
  const c = launch ? contextFromEvmLaunch(launch, now) : emptyContext(flag.token, flag.symbol ?? '', flag.name ?? '');
  if (c.uniqueBuyers === null) c.uniqueBuyers = num(flag.uniqueBuyers);
  c.runnerOddsPct = num(flag.ratePct);
  c.curveRegime = null;
  c.isMayhem = null;
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
  // The rest of the summary: absent (an EVM host) stays null.
  c.kryptScore = num(m.kryptScore);
  c.bondingCurvePct = num(m.bondingCurvePct);
  c.devHoldingPct = num(m.devHoldingPct);
  c.top10Pct = num(m.top10Pct);
  c.insiderPct = num(m.insiderPct);
  c.bundledPct = num(m.bundledPct);
  c.sniperPct = num(m.sniperPct);
  c.smartHolders = num(m.smartHolders);
  c.volume5mUsd = num(m.volume5mUsd);
  c.buys5m = num(m.buys5m);
  c.sells5m = num(m.sells5m);
  c.priceChange5mPct = num(m.priceChange5mPct);
  // Links. "No provider answered" (socials absent) is unknown, not "none":
  // every link field stays null. A provider that answered with no links is
  // a real "none": false and empty.
  const so = m.socials ?? null;
  if (so) {
    c.twitter = so.twitter || null;
    c.website = so.website || null;
    c.telegram = so.telegram || null;
    c.hasTwitter = !!so.twitter;
    c.hasWebsite = !!so.website;
    c.hasTelegram = !!so.telegram;
    c.dexPaid = so.dexPaid === true;
    const x = parseXLink(so.twitter);
    c.xLinkKind = x.kind;
    c.xHandle = x.handle;
    c.xReuseCount = num(m.xReuseCount);
  }
  // The X page, as read in the Links panel: every number the page showed,
  // and how old the read is. Nothing read = every one null.
  const xs = m.xStats ?? null;
  c.xFollowers = xs ? num(xs.stats.followers) : null;
  c.xFollowing = xs ? num(xs.stats.following) : null;
  c.xVerified = xs ? xs.stats.verified : null;
  c.xLikes = xs ? num(xs.stats.likes) : null;
  c.xReposts = xs ? num(xs.stats.reposts) : null;
  c.xReplies = xs ? num(xs.stats.replies) : null;
  c.xViews = xs ? num(xs.stats.views) : null;
  c.xStatsAgeSec = xs ? Math.max(0, Math.round((Date.now() - xs.readAt) / 1000)) : null;
  // Telegram's preview and the domain's record, when looked up; the site
  // read, when a person opened the site. Not looked up / not read = null.
  const li = m.linkIntel ?? null;
  c.tgMembers = li?.telegram ? num(li.telegram.members) : null;
  c.tgOnline = li?.telegram ? num(li.telegram.online) : null;
  c.tgKind = li?.telegram ? li.telegram.kind : null;
  c.domainAgeDays = li?.domain ? domainAgeDays(li.domain.registeredAt) : null;
  c.domainHostedOn = li?.domain ? li.domain.hostedOn : null;
  const sr = m.siteRead ?? null;
  c.siteNamesContract = sr ? sr.read.namesContract : null;
  c.siteLinksX = sr ? siteLinksX(sr.read, c.xHandle) : null;
  c.siteOutboundHosts = sr ? num(sr.read.outboundHosts) : null;
  c.siteMentionsConnectWallet = sr ? sr.read.mentionsConnectWallet : null;
  return c;
}

/** Which links a launch's own metadata file published, as the scanner read it
 *  at create time. Null = the file has not resolved (or never did). */
export interface LaunchLinks {
  twitter: boolean;
  website: boolean;
  telegram: boolean;
  /** The addresses as the creator wrote them, when the file is cached. */
  twitterUrl?: string | null;
  websiteUrl?: string | null;
  telegramUrl?: string | null;
}

/**
 * Fill the has-link fields from the scanner's own metadata read when no
 * provider has answered for socials yet. A freshly flagged runner is usually
 * not in any provider's cache, but the scanner fetched its metadata file the
 * moment it launched — without this, `hasTwitter`/`hasWebsite` sat null on
 * exactly the coins a runner script acts on. A provider's answer, when there
 * is one, is left alone. The addresses come from the same metadata file
 * when it is cached, and fill only what the provider left empty.
 */
export function withLaunchLinks(c: RuleContext, l: LaunchLinks | null): RuleContext {
  if (!l) return c;
  // The file is what every provider copies its links from, so a link IN the
  // file beats a provider's "none" — pump.fun's own record says null for a
  // coin's first minutes (2026-09-30: SRI, HANDLE and SIVSAI were skipped as
  // "no X linked" with both links in their files). A provider's link where
  // the file has none is left alone.
  if (c.hasTwitter === null || (c.hasTwitter === false && l.twitter)) c.hasTwitter = l.twitter;
  if (c.hasWebsite === null || (c.hasWebsite === false && l.website)) c.hasWebsite = l.website;
  if (c.hasTelegram === null || (c.hasTelegram === false && l.telegram)) c.hasTelegram = l.telegram;
  if (c.twitter === null && l.twitterUrl) {
    c.twitter = l.twitterUrl;
    const x = parseXLink(l.twitterUrl);
    c.xLinkKind = x.kind;
    c.xHandle = x.handle;
  }
  if (c.website === null && l.websiteUrl) c.website = l.websiteUrl;
  if (c.telegram === null && l.telegramUrl) c.telegram = l.telegramUrl;
  return c;
}

/**
 * The Launch tab's cohorts onto a context (2026-09-27).
 *
 * Filled only from a scan that reached the launch block (`complete`): an
 * incomplete report carries empty cohorts whose counts read 0, and 0 wallets
 * would be a confident answer about a block nobody isolated. The held figures
 * stay null until the balances were read — `applyBalances` in
 * shared/launchintel.ts never infers them, and neither does this.
 *
 * The provider's bundledPct / sniperPct are left alone when present and
 * filled from the scan when null — the same fallback the token page's
 * security report makes — so a script written against `bundledPct` starts
 * seeing a number on new pump.fun coins once the scan is cached.
 */
export function withLaunchIntel(c: RuleContext, li: ScriptLaunchIntel | null): RuleContext {
  if (!li || !li.complete) return c;
  c.launchDevPct = num(li.dev.boughtPct);
  c.launchDevHeldPct = num(li.dev.heldPct);
  c.launchBundlePct = num(li.bundle.boughtPct);
  c.launchBundleHeldPct = num(li.bundle.heldPct);
  c.launchBundleRetainedPct = num(li.bundle.retainedPct);
  c.launchBundleWallets = num(li.bundle.wallets);
  c.launchBundleStillHolding = num(li.bundle.stillHolding);
  c.launchSniperPct = num(li.snipers.boughtPct);
  c.launchSniperHeldPct = num(li.snipers.heldPct);
  c.launchSniperRetainedPct = num(li.snipers.retainedPct);
  c.launchSniperWallets = num(li.snipers.wallets);
  c.launchSniperStillHolding = num(li.snipers.stillHolding);
  c.launchTop3BuyersPct = num(li.top3BuyersPct);
  if (c.bundledPct === null) c.bundledPct = c.launchBundlePct;
  if (c.sniperPct === null) c.sniperPct = c.launchSniperPct;
  return c;
}

/** The token page's LaunchIntelReport → what a script gets: the analysis
 *  lifted to the top level, nothing dropped, nothing invented. */
export function scriptLaunchIntelFromReport(r: LaunchIntelReport): ScriptLaunchIntel {
  const a = r.analysis;
  const cohort = (c: LaunchIntelReport['analysis']['dev']): ScriptLaunchCohort => ({
    wallets: c.wallets,
    bought: c.bought,
    boughtPct: c.boughtPct,
    sol: c.sol,
    heldPct: c.heldPct,
    retainedPct: c.retainedPct,
    stillHolding: c.stillHolding,
  });
  return {
    mint: r.mint,
    creator: r.creator,
    supply: r.supply,
    complete: a.complete,
    launchSlot: a.launchSlot,
    launchTs: a.launchTs,
    tradesScanned: a.tradesScanned,
    slotsSpanned: a.slotsSpanned,
    sniperWindowSlots: r.sniperWindowSlots,
    priced: a.priced,
    dev: cohort(a.dev),
    bundle: cohort(a.bundle),
    snipers: cohort(a.snipers),
    top3BuyersPct: a.top3BuyersPct,
    wallets: a.wallets.map((w) => ({
      address: w.address,
      cohort: w.cohort,
      slotOffset: w.slotOffset,
      bought: w.bought,
      boughtPct: w.boughtPct,
      sol: w.sol,
      soldInWindow: w.soldInWindow,
      heldNow: w.heldNow,
      heldPct: w.heldPct,
    })),
    source: r.source,
    note: r.note,
    balancesNote: r.balancesNote,
    generatedAt: r.generatedAt,
  };
}

/**
 * The token page's SecurityReport → what a script gets. One mapping, so the
 * page and `bot.security()` say the same thing about the same coin. The
 * creator's verdict follows the Launch tab: a first launch is the ABSENCE of
 * a record, not a pass, so it reads null rather than green.
 */
export function scriptSecurityFromReport(r: SecurityReport, warnings: string[]): ScriptSecurity {
  const h = r.creator.history;
  const firstLaunch = !h || h.launches <= 1;
  const v = firstLaunch ? { verdict: null, detail: h ? 'First launch from this wallet on pump.fun — no record.' : 'Creator history unavailable.' } : creatorVerdict(h);
  return {
    score: r.score,
    checksResolved: r.checksResolved,
    checksTotal: r.checksTotal,
    checks: r.checks.map((c) => ({ id: c.id, label: c.label, verdict: c.verdict, detail: c.detail, source: c.source, weight: c.weight, kind: c.kind ?? 'gate' })),
    warnings,
    concentration: { ...r.concentration },
    creator: {
      address: r.creator.address,
      priorLaunches: r.creator.priorLaunches,
      priorRugs: r.creator.priorRugs,
      launches: h?.launches ?? r.creatorRecord.launches,
      graduated: h?.graduated ?? r.creatorRecord.graduated,
      graduationRate: h?.graduationRate ?? null,
      launchesInBusiestDay: h?.launchesInBusiestDay ?? null,
      devMints: r.creatorRecord.devMints,
      devMigrations: r.creatorRecord.devMigrations,
      rugcheckCreatorRugs: r.creatorRecord.rugcheckCreatorRugs,
      verdict: v.verdict,
      detail: v.detail,
    },
    rug: r.rug,
    volatility: r.volatility,
    odds: r.odds,
    dexPaid: {
      paid: r.descriptive.dexPaid.paid,
      paidAt: r.descriptive.dexPaid.paidAt,
      boosts: r.descriptive.dexPaid.boosts,
      communityTakeover: r.descriptive.dexPaid.communityTakeover,
    },
    generatedAt: r.generatedAt,
  };
}

/**
 * One provider summary → the facts a script gets. The single place the
 * mapping lives, so the cached read and the fetched read agree field for
 * field. `xReuseCount` is the engine's count of other launches in view on
 * the same X account or post; null when it did not count.
 */
export function marketFactsFromSummary(
  s: TokenSummary,
  xReuseCount: number | null = null,
  xStats: { stats: XStats; readAt: number } | null = null,
  linkIntel: LinkIntelFacts | null = null,
  siteRead: { read: SiteRead; readAt: number } | null = null,
): MarketFacts {
  const win = s.stats['5m'] ?? null;
  return {
    imageUrl: s.imageUrl ?? null,
    priceSol: s.priceSol,
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd,
    liquidityUsd: s.liquidityUsd,
    holders: s.holders,
    launchpad: s.launchpad ?? null,
    symbol: s.symbol,
    name: s.name,
    kryptScore: s.kryptScore ?? null,
    bondingCurvePct: s.bondingCurvePct,
    devHoldingPct: s.devHoldingPct,
    top10Pct: s.top10Pct,
    insiderPct: s.insiderPct,
    bundledPct: s.bundledPct,
    sniperPct: s.sniperPct,
    smartHolders: s.smartHolders,
    volume5mUsd: win?.volumeUsd ?? null,
    buys5m: win?.buys ?? null,
    sells5m: win?.sells ?? null,
    priceChange5mPct: win?.priceChangePct ?? null,
    // Socials only when someone answered for them: a source named in
    // `sources.socials`, or a link in hand. An untouched summary carries an
    // empty socials object, which used to read as "no links" (2026-09-30:
    // a runner's link rule skipped coins whose metadata file had both).
    socials:
      (s.sources?.socials !== undefined && s.sources.socials !== 'none') || s.socials.twitter || s.socials.website || s.socials.telegram
        ? { twitter: s.socials.twitter, website: s.socials.website, telegram: s.socials.telegram, dexPaid: s.socials.dexPaid }
        : null,
    xReuseCount,
    xStats,
    linkIntel,
    siteRead,
  };
}

/** The `bot.links()` answer from a summary plus the engine's reuse count. */
export function scriptLinksFromSummary(
  chain: string,
  s: TokenSummary,
  reuse: { handle: number; post: number },
  xStats: { stats: XStats; readAt: number } | null = null,
  linkIntel: LinkIntelFacts | null = null,
  siteRead: { read: SiteRead; readAt: number } | null = null,
): ScriptLinks {
  const x = parseXLink(s.socials.twitter);
  const lp = launchpadSite(chain, s.launchpad, s.mint);
  return {
    twitter: s.socials.twitter || null,
    website: s.socials.website || null,
    telegram: s.socials.telegram || null,
    launchpadLabel: lp?.label ?? null,
    launchpadUrl: lp?.url ?? null,
    x: { kind: x.kind, handle: x.handle, postId: x.postId, label: x.label, accountReuse: reuse.handle, postReuse: reuse.post, stats: xStats?.stats ?? null, statsReadAt: xStats?.readAt ?? null },
    telegramStats: linkIntel?.telegram ?? null,
    domain: linkIntel?.domain ?? null,
    site: siteRead ? { ...siteRead.read, readAt: siteRead.readAt } : null,
  };
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
    if (v === undefined) {
      if (OPTIONAL_BUDGET_KEYS.has(key)) continue;
      return { ok: false, message: key + " is missing" };
    }
    const { min, max } = BUDGET_BOUNDS[key];
    if (!Number.isFinite(v) || v < min || v > max) return { ok: false, message: `${key} must be between ${min} and ${max}` };
  }
  return { ok: true, message: 'ok' };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateAction(a: RuleAction, trigger: RuleTrigger, chain: ChainKind = 'solana'): { ok: boolean; message: string } {
  const spec = RULE_ACTIONS.find((x) => x.id === a.type);
  if (!spec) return { ok: false, message: 'Unknown action' };
  if (spec.needsMint && trigger === 'schedule') return { ok: false, message: `${spec.label}: a daily schedule has no token — use "Sell everything", notify or log` };
  switch (a.type) {
    case 'buy':
    case 'limit_buy':
      if (trigger === 'position') return { ok: false, message: 'A position rule cannot buy — it acts on what is already held' };
      if (!Number.isFinite(a.sol) || a.sol <= 0) return { ok: false, message: nativeText(`${spec.label}: enter a SOL amount`, chain) };
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

export function validateRules(r: RuleSet, chain: ChainKind = 'solana'): { ok: boolean; message: string } {
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
    const v = validateAction(a, r.trigger, chain);
    if (!v.ok) return v;
  }
  if (!Number.isFinite(r.cooldownSec) || r.cooldownSec < 0 || r.cooldownSec > 86_400) return { ok: false, message: 'Cooldown: 0–86400 s' };
  return { ok: true, message: 'ok' };
}

/**
 * Why this script cannot be saved, or ok.
 *
 * It took the app's manual per-trade cap until 2026-09-22, to refuse a rule
 * sized above it once rather than at every placement. That cap no longer
 * applies to scripts — a script's own budget is the authority on its size —
 * so the parameter is gone rather than left unread.
 */
export function validateScript(
  s: Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'>,
): { ok: boolean; message: string } {
  if (!s.name || !s.name.trim() || s.name.length > 60) return { ok: false, message: 'Name: 1–60 characters' };
  if (s.kind !== 'rules' && s.kind !== 'code') return { ok: false, message: 'Unknown script kind' };
  if (s.mode !== 'paper' && s.mode !== 'live') return { ok: false, message: 'Mode must be paper or live' };
  const b = validateBudget(s.budget);
  if (!b.ok) return b;
  if (s.kind === 'code') {
    if (typeof s.code !== 'string' || !s.code.trim()) return { ok: false, message: 'The script is empty' };
  } else {
    const r = validateRules(s.rules, scriptChain(s));
    if (!r.ok) return r;
    // A condition its chain cannot answer is refused HERE rather than left to
    // fail quietly at runtime. An unknown fact never satisfies a rule, so such
    // a rule would look armed, cost nothing, and never once fire — the worst
    // failure this feature has, because it is invisible.
    const chain = scriptChain(s);
    if (!triggerAvailableOn(s.rules.trigger, chain)) {
      const t = RULE_TRIGGERS.find((x) => x.id === s.rules.trigger);
      return {
        ok: false,
        message: `"${t?.label ?? s.rules.trigger}" never happens on ${chainLabel(chain)} — that rule could not fire. Pick another trigger or move this script to Solana.`,
      };
    }
    for (const cond of s.rules.conditions) {
      if (fieldAvailableOn(cond.field, chain)) continue;
      const spec = RULE_FIELDS.find((f) => f.id === cond.field);
      return {
        ok: false,
        message: `${spec?.label ?? cond.field} is not measured on ${chainLabel(chain)} — a rule on it could never fire. Remove the condition or move this script to Solana.`,
      };
    }
    for (const a of s.rules.actions) {
      if (actionAvailableOn(a.type, chain)) continue;
      const spec = RULE_ACTIONS.find((x) => x.id === a.type);
      return {
        ok: false,
        message: `${spec?.label ?? a.type} is Solana-only — ${chainLabel(chain)} has no advanced orders or alerts yet.`,
      };
    }
    for (const a of s.rules.actions) {
      if (a.type !== 'buy' && a.type !== 'limit_buy') continue;
      if (a.sol > s.budget.maxSolPerTrade) {
        return { ok: false, message: nativeText(`Buy ${a.sol} SOL is above this script's max per trade (${s.budget.maxSolPerTrade})`, chain) };
      }
      // The app's MANUAL per-trade cap is deliberately NOT checked here
      // (2026-09-22): the script's own budget, just above, is the authority on
      // its size, so a rule sized within it saves whatever the manual cap is.
    }
  }
  return { ok: true, message: 'ok' };
}

export function describeAction(a: RuleAction, chain: ChainKind = 'solana'): string {
  return nativeText(describeActionSol(a), chain);
}

function describeActionSol(a: RuleAction): string {
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
      return a.kinds?.length ? `cancel ${a.kinds.join(', ')} orders` : 'cancel orders';
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

export function describeRules(r: RuleSet, chain: ChainKind = 'solana'): string {
  const trig = RULE_TRIGGERS.find((t) => t.id === r.trigger)?.label ?? r.trigger;
  const when = r.trigger === 'schedule' && r.atHHMM ? `${trig} ${r.atHHMM}` : trig;
  const symbol = nativeSymbolOf(chain);
  const conds = r.conditions.map((c) => {
    const f = RULE_FIELDS.find((x) => x.id === c.field);
    const label = nativeFieldLabel(f?.label ?? c.field, chain, symbol);
    return f?.kind === 'boolean' ? `${label} ${OP_LABELS[c.op]}` : `${label} ${OP_LABELS[c.op]} ${c.value}`;
  });
  return `On ${when}${conds.length ? ` when ${conds.join(' and ')}` : ''}: ${r.actions.map((a) => describeAction(a, chain)).join(', ')}`;
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
  /** Realised today, SOL (paper: exact; live: every settled sell of a bag
   *  the script opened, priced from the chain — orders included). */
  realizedSolToday: number;
  /** The loss stop in force: the SOL figure or the wallet share, whichever is smaller. */
  lossCapSol?: number;
  /** Losing exits in a row (live). */
  lossStreak?: number;
  /** While set, the script's buys are refused: the cool-off after a losing streak. */
  coolOffUntil?: number | null;
  errorsInARow: number;
  lastRunAt: number | null;
  lastError: string | null;
  /**
   * WHEN the last error happened (2026-09-21).
   *
   * `lastError` is sticky: it stays on the card until the next one replaces
   * it. Shown without a time, an error from six hours ago reads as one
   * happening now — which is exactly how a user reported "the app displays
   * sandbox gone, there's no timestamp". Absent on a snapshot built before
   * this field existed.
   */
  lastErrorAt?: number | null;
  /** Positions this script opened and still holds. */
  openCount: number;
  /** Mints this script has ever fired on (once-per-mint memory). */
  firedMints: number;
  /** Code scripts: the sandbox is up and listening. */
  running: boolean;
  /** Paused after its own errors and restarting by itself at this time
   *  (ms); null or absent when not paused (2026-09-27). */
  pausedUntil?: number | null;
}

export interface ScriptSnapshot {
  scripts: UserScript[];
  /**
   * Live-update snapshots leave every script's `code` empty (it can be a
   * quarter of a megabyte, per script, per log line). The window keeps the
   * code it already has — see mergeSnapshot. Absent on a full read.
   */
  codeOmitted?: boolean;
  stats: Record<string, ScriptStats>;
  logs: Record<string, ScriptLogLine[]>;
  /**
   * What each script chose to show on its widget (bot.stat / bot.stats), in
   * the order it first set them. Not the budget numbers above — those are
   * the app's; these are the script's own. Reset when a script starts, so a
   * value on screen is always from the run that is going. Optional so a
   * snapshot built before the field still satisfies the type.
   */
  metrics?: Record<string, Array<{ name: string; value: ScriptStatValue; at: number }>>;
  /** Solana's, kept for callers written before scripts had chains. */
  liveBlockedReason: string | null;
  /**
   * Why a LIVE script on each chain cannot execute right now, or null.
   *
   * Per chain since 2026-09-15. The single reason above was always Solana's,
   * so a live script on Robinhood Chain whose rail was not armed showed a
   * page with nothing wrong on it and did nothing — which is how a user came
   * to ask whether EVM scripting worked at all. Optional so a snapshot built
   * before the field still satisfies the type.
   */
  blockedByChain?: Partial<Record<ChainKind, string | null>>;
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
  /**
   * A READ that leaves the machine (a provider round trip), so the dispatcher
   * charges it against actions-per-minute exactly like an action — while it
   * is still a read, not a side effect. Rendered as its own group in the
   * reference so the cost is not undersold (audit 2026-09-27).
   */
  charged?: true;
  /**
   * Answered inside the sandbox, so it is NOT one of SCRIPT_METHODS and never
   * crosses the wire. Handlers, the logger, the clock, and the two facts about
   * the script's own chain, which ride along with the code in `init`.
   */
  local?: true;
}

/** The whole `bot` object. The harness, the dispatcher and the docs all
 *  follow this table. */
export const SCRIPT_API: ApiSpec[] = [
  { local: true, method: 'on', signature: "bot.on(event, async (payload) => {})", returns: 'void', notes: 'Register a handler. Events: launch, launchUpdate, runner, position, tick, leaderTrade, order, alert, fill, schedule, interval, migration, curveHigh, devSell, holdings, copyFill, runnerExpired. Handlers for one script run one at a time. One is checked at 3 s; if it is still awaiting bot calls it gets more time, up to 30 s — a stuck one is killed and counts as an error.', action: false },
  { method: 'every', signature: 'bot.every(seconds, async () => {})', returns: 'Promise<number> (the seconds used)', notes: 'A timer. 5 s minimum, 3600 max.', action: false },
  { method: 'at', signature: "bot.at('HH:MM', async () => {})", returns: 'Promise<string>', notes: 'Once a day at that local time.', action: false },
  { method: 'buy', signature: 'await bot.buy(mint, sol, address? | { wallet?, slippagePct?, lane?, topUp? })', returns: '{ok, message}', notes: '{topUp: true}: fund a short chain from the All-in-One wallet first (live, max 3 % cost). EVM: 0x address, no {lane}, keeps gas to sell. {lane: \x27lean\x27} (2026-09-29) sends THIS trade at the live median priority with no fee floor, no Jito or Helius tip and the public lane only: about 0.00001 SOL a side instead of the 0.001 / 0.002 floors, which on a 0.02 SOL bag were most of the loss. It lands in seconds, not the first slot, so it suits timed exits and patient entries, never a snipe or a rug exit. A lean sell that fails to land is retried once on the fast lane. The smallest live buy is 0.03 SOL on the fast lane and 0.0025 SOL on the lean one. Trading wallet only. Through the app’s own pipeline in the script’s mode (paper or live). Refused (ok:false, with the reason) when over THIS SCRIPT’S budget — max per trade, buys per day, open positions, actions per minute — or while live is blocked (not armed, execution off, a breaker). The app’s manual per-trade cap does NOT apply: a script’s own budget is the authority on its size. The third argument is either another of your own wallet ADDRESSES (see bot.wallets) to buy with that wallet — refused until you accept “Trading from your other wallets” on the Scripts page — or an options object: {wallet} is that same address, {slippagePct} (0.1–50) replaces the execution setting’s slippage for THIS buy only (also on BNB / Robinhood); the other wallets keep the setting, so slippagePct together with wallet is refused rather than silently dropped. The app does not space these out or cap how many of your wallets touch a coin: the script does what it is written to, inside its own budget. Paper spends nothing.', action: true },
  { method: 'sell', signature: 'await bot.sell(mint, pct | { pct?, tokens?, slippagePct?, wallet?, lane? }, address?)', returns: '{ok, message, realizedSol?}', notes: 'EVM: a 0x address; {lane} refused. {lane: \x27lean\x27} (2026-09-29) sends THIS trade at the live median priority with no fee floor, no Jito or Helius tip and the public lane only: about 0.00001 SOL a side instead of the 0.001 / 0.002 floors, which on a 0.02 SOL bag were most of the loss. It lands in seconds, not the first slot, so it suits timed exits and patient entries, never a snipe or a rug exit. A lean sell that fails to land is retried once on the fast lane. The smallest live buy is 0.03 SOL on the fast lane and 0.0025 SOL on the lean one. Trading wallet only. realizedSol (2026-09-29): what the sell realised in the chain’s coin — exact on paper, null on a live sell until its fill settles (the script’s own stats carry it then). pct 1–100 of what this script holds in its mode. Or an options object: {tokens} sells that many tokens (UI units) instead of a percent — converted against the position the app can see, so it is refused while a fresh buy is not in the holdings read yet, and capped at what this script itself bought when the bag also holds hand-bought tokens; {slippagePct} (0.1–50) replaces the slippage setting for this sell only (trading wallet, Solana) — a LIVE sell never runs below the app’s 15 % exit floor, so asking for less runs at 15; {wallet} names another of your own wallet ADDRESSES to sell from that one — only a mint this script opened WITH that wallet, only as a percent (tokens with wallet is refused), at the execution setting’s slippage (slippagePct with wallet is refused). Name the wallet once: in the options or as the third argument, not both. Refused when nothing is held.', action: true },
  { method: 'sellAll', signature: 'await bot.sellAll()', returns: '{ok, message, sold: number}', notes: 'Sell 100 % of every position this script holds.', action: true },
  { method: 'order', signature: "await bot.order({ mint, kind, triggerBasis, triggerValue, amount })", returns: '{ok, message}', notes: "Solana only. kind: stop_loss | take_profit | trailing_stop | limit_buy | limit_sell | sell_on_dev_sell | sell_on_migration | buy_on_migration. triggerBasis: 'pct' (from the price now) | 'mcap_usd' | 'price_sol'. amount: SOL for buys, % for sells. Placed as a real advanced order. 'pct' is measured from your position's fill price (fees and the token-account deposit excluded), or from the price now when nothing is held. An app restart brings every armed order back PAUSED and never resumes it by itself: the script gets an 'order' event with orderState 'paused' for its coins, and must cancelOrders + order again to re-arm.", action: true },
  { method: 'cancelOrders', signature: 'await bot.cancelOrders(mint, kinds?)', returns: '{ok, message, cancelled: number}', notes: "Cancel every open order on the token — or, with kinds (e.g. ['stop_loss', 'trailing_stop']), only those kinds, leaving the rest armed: a moonbag can drop its stop and keep its take-profit rungs. An app build before 5.3.0 ignores the list and cancels every order.", action: true },
  { method: 'clearCompletedOrders', signature: 'await bot.clearCompletedOrders()', returns: '{ok, message, cleared: number}', notes: 'Prune every FINISHED order (filled, cancelled, expired, failed) from the Orders list. Finished orders otherwise pile up against the 200-order cap and eventually get new orders (your take-profit rungs) refused, so a long-running script that places orders should call this each loop. Housekeeping — costs no action, touches no open order. Solana only.', action: false },
  { method: 'cancelOrder', signature: 'await bot.cancelOrder(orderId)', returns: '{ok, message}', notes: 'Cancel ONE order by the id bot.orders() shows — any armed or paused order, whoever placed it, the same as the Orders page’s cancel button. An order that is executing cannot be recalled and is refused. Refused on a paper script (orders are live-only; a rehearsal must not pull a real stop). Costs an action. Solana only.', action: true },
  { method: 'resumeOrders', signature: 'await bot.resumeOrders()', returns: '{ok, message}', notes: 'Re-arm every order an app restart left PAUSED — the Orders page’s Resume button. Orders that were mid-execution when the app stopped are NOT re-armed (their trade may have landed) and the message says how many need a human to check the wallet. Refused on a paper script (orders are live-only) and while live is blocked. Costs an action. Solana only.', action: true },
  { method: 'removeAlert', signature: 'await bot.removeAlert(alertId)', returns: '{ok, message}', notes: 'Delete one alert by the id bot.alerts() shows — yours or a script’s. Costs an action. Solana only.', action: true },
  { method: 'muteAlert', signature: 'await bot.muteAlert(alertId, muted = true)', returns: '{ok, message}', notes: 'Silence (or un-silence with false) one alert without deleting it. Costs an action. Solana only.', action: true },
  { method: 'clearFiredAlerts', signature: 'await bot.clearFiredAlerts()', returns: '{ok, message}', notes: 'Remove every alert that has already fired and does not repeat. Housekeeping — free. Solana only.', action: false },
  { method: 'saveTemplate', signature: "await bot.saveTemplate({ id?, name, stopLossPct, takeProfits: [{gainPct, sellPct}], trailingPct, sellOnDevSell })", returns: '{ok, message, templates}', notes: 'Create or update an order template — the same shape the Templates page saves: name (≤ 40 chars), stopLossPct (percent below entry, or null), up to 3 takeProfits each {gainPct, sellPct of what remains}, trailingPct (or null), sellOnDevSell (true/false). Pass an existing id to update it; leave it out for a new one; a built-in id saves a copy you own. At most 8 templates. Validated the page’s way and refused with the reason. Returns the list afterwards. Refused on a paper script: templates arm REAL orders on the user’s manual buys. Costs an action. Solana only.', action: true },
  { method: 'deleteTemplate', signature: 'await bot.deleteTemplate(templateId)', returns: '{ok, message, templates}', notes: 'Delete one of your templates. The built-in ones cannot be deleted. Refused on a paper script. Costs an action. Solana only.', action: true },
  { method: 'setActiveTemplate', signature: 'await bot.setActiveTemplate(templateId | null)', returns: '{ok, message}', notes: 'Choose the template the app arms on every MANUAL buy (the Templates page’s “auto-arm” pick), or null to turn that off. It changes what happens when the user clicks Buy, so say so in the script’s description. Refused on a paper script. Costs an action. Solana only.', action: true },
  { method: 'settings', signature: 'await bot.settings()', returns: 'Settings', notes: 'The app’s settings, read-only and SCRUBBED: {mode: live · paper, execution: {liveEnabled, maxLiveSol, liveSlippagePct, mevMode, feeUrgency, useJito, jitoTipPercentile, autoSellOnExit, maxLiveSessionLossSol, maxLiveConsecutiveLosses, …}, strategy: {the scanner’s thresholds}, data: {networkDataEnabled, providers: {jupiter, dexscreener, pumpfun, …}, hasBirdeyeKey, hasJupiterKey, …}, alerts, evm}. Every field whose name says key, token, secret, password, url or http is removed before it crosses, and so is any value that is a URL — a script can learn THAT a key is set, never the key. Nothing here can be changed from a script: settings writes stay with the user. Free.', action: false },
  { method: 'templates', signature: 'await bot.templates()', returns: 'Array<{id, name}>', notes: 'Saved order templates.', action: false },
  { method: 'applyTemplate', signature: 'await bot.applyTemplate(mint, templateId)', returns: '{ok, message}', notes: 'Arm a template’s stops and take profits on a token.', action: true },
  { method: 'alert', signature: "await bot.alert({ mint, kind, threshold, repeat })", returns: '{ok, message}', notes: 'kind: price_above | price_below | mcap_above | mcap_below | volume_above | liquidity_below | holders_above | curve_above. Fires an alert event back to scripts.', action: true },
  { method: 'watch', signature: 'await bot.watch(mint)', returns: '{ok, message}', notes: 'Pin to the Watchlist and stream tick events for the token to this script.', action: true },
  { method: 'unwatch', signature: 'await bot.unwatch(mint)', returns: '{ok, message}', notes: 'Unpin and stop the ticks.', action: true },
  { method: 'subscribe', signature: 'await bot.subscribe(mint)', returns: '{ok, message}', notes: 'Stream tick events for the token without pinning it. Positions the script holds are always streamed.', action: false },
  { method: 'unsubscribe', signature: 'await bot.unsubscribe(mint)', returns: '{ok, message}', notes: '', action: false },
  { method: 'notify', signature: "await bot.notify('text')", returns: '{ok, message}', notes: 'Desktop notification and a toast.', action: true },
  { method: 'callout', signature: "await bot.callout(mint, 'text', address?)", returns: '{ok, message, thesis, address, calloutId, link}', notes: 'Post a pump.fun callout on a coin. `link` is the callout’s public pump.fun page (null when pump did not say its id). PUBLIC, under that account’s name, and pump shows its position beside it. By default it posts from the pump.fun account belonging to this chain’s trading wallet; pass the ADDRESS of another of your own signed-in accounts (see bot.pumpAccounts) to post from that one instead — an address with no session is refused, never swapped for a different account. Leave the text out to use a random line from Automation → Auto-callout. Every one ends with a line of its own, “Called with krypt.cc/bot”, so readers know a tool posted it. pump decides whether it is allowed: the account must hold at least $1 of the coin, there are three attempts per coin, and there is a cooldown — a refusal comes back as ok:false with pump’s own reason and is not retried. One script may call one coin from at most 5 accounts, once each, matching the wallets-per-coin cap. A paper script posts nothing and says so. Solana only.', action: true },
  { method: 'pumpAccounts', signature: 'await bot.pumpAccounts()', returns: 'Array<{address, username, active}>', notes: 'Your signed-in pump.fun accounts (Wallet page → pump.fun accounts), newest first; `active` marks the one belonging to the current trading wallet. Addresses and names only — no session token ever reaches a script. Use an address with bot.callout to post from that account.', action: false },
  { method: 'calloutReply', signature: "await bot.calloutReply(mint, 'text', address?)", returns: '{ok, message, thesis, address, calloutId, replyId, link}', notes: 'Reply to a callout this account already made on the coin. `link` is the reply’s public page (or the callout’s when pump did not say the reply id). A callout is ONE per coin per account, so once it exists this is how it is followed up as the coin moves — there is no edit. PUBLIC, under that account’s name, and ends with “Called with krypt.cc/bot” on its own line, like a callout. Same third argument as bot.callout: leave it out for this chain’s trading wallet, or pass another of your own signed-in addresses. Refused when that account has not called the coin, and while pump’s reply cooldown is running — its reason comes back as ok:false and is not retried. A paper script posts nothing. Solana only.', action: true },
  { method: 'follow', signature: "await bot.follow(user, address?)", returns: '{ok, message}', notes: 'Follow a pump.fun user as one of your accounts. `user` is their wallet address, their pump user id, or a pump.fun/profile link. PUBLIC: it shows on their follower list. Same second argument as bot.callout’s third: leave it out for this chain’s trading wallet’s account, or pass another of your signed-in addresses (bot.pumpAccounts). Following someone already followed is fine. Calls from one account are spaced about a second apart. A paper script follows nobody. Solana only.', action: true },
  { method: 'unfollow', signature: "await bot.unfollow(user, address?)", returns: '{ok, message}', notes: 'Stop following a pump.fun user. Same arguments as bot.follow.', action: true },
  { method: 'discord', signature: "await bot.discord('webhookSetting', { title, description, url, color, fields, thumbnail, footer })", returns: '{ok, message, messageId}', notes: 'Post an embed to a Discord channel. The first argument is the NAME of one of this script’s own settings declared with "type": "webhook" in @inputs — never a URL; the app looks the URL up, and only Discord webhook addresses are accepted there. bot.input shows that setting redacted. Fields are capped to Discord’s limits, only https links are kept, mentions never ping, and the footer always names the script (and says PAPER on a paper script). Allowed on paper: it spends nothing. Costs one action.', action: true },
  { method: 'discordEdit', signature: "await bot.discordEdit('webhookSetting', messageId, { title, description, color, fields, … })", returns: '{ok, message}', notes: 'Replace the embed on a message this script posted with bot.discord — pass the messageId that call returned. Made for showing how a call ENDED on the call itself (stopped out, closed, took profit). Edit only: there is no delete, on purpose — a channel that removes its losing calls tells its readers a better record than it has. Same webhook-setting rule as bot.discord; a paper script changes nothing.', action: true },
  { method: 'like', signature: "await bot.like(calloutId, address?)", returns: '{ok, message}', notes: 'Like a pump.fun callout by its id (a pasted link containing the id works too). PUBLIC, under that account. Liking twice is fine. An id pump does not know comes back ok:false “callout not found”. A paper script likes nothing. Solana only.', action: true },
  { method: 'unlike', signature: "await bot.unlike(calloutId, address?)", returns: '{ok, message}', notes: 'Take a like back. Same arguments as bot.like.', action: true },
  { local: true, method: 'log', signature: "bot.log('text') / bot.warn('text') / bot.error('text')", returns: 'void', notes: 'A line on this script’s log at that level (400 chars max). bot.error does not stop the script — it is just a red line.', action: false },
  { local: true, method: 'stat', signature: "bot.stat('Callouts', 12)", returns: 'void', notes: 'Show a live number (or short text, or true/false) on this script’s own widget — add the Script monitor widget and pick the script. The same name again replaces the value; names show in the order first set. null shows as unknown (—), never 0. Up to 24 stats, names up to 32 characters, text up to 80. Costs no action and nothing waits on it, so it is fine on every tick. The widget starts empty each time the script starts — re-send totals kept in bot.setState if they should carry over.', action: false },
  { local: true, method: 'stats', signature: "bot.stats({ 'Callouts': 12, 'Likes': 30, 'PnL (SOL)': 0.42 })", returns: 'void', notes: 'Set several widget stats at once — same rules as bot.stat.', action: false },
  { local: true, method: 'clearStats', signature: 'bot.clearStats()', returns: 'void', notes: 'Empty this script’s widget.', action: false },
  { method: 'price', signature: 'await bot.price(mint)', returns: 'number | null', notes: 'The chain coin per token, from what the app already knows (EVM: the scanner\x27s last print). Null when unknown.', action: false },
  { method: 'token', signature: 'await bot.token(mint)', returns: 'Token | null', notes: 'The same facts a rule sees (see the variable guide), from the launch feed and the cached market data — and, for 45 s after bot.launchIntel(mint) or bot.security(mint) (or after someone opens the coin’s page), the Launch tab’s cohorts (launchDevPct, launchBundlePct, launchSniperPct, their *HeldPct, wallet counts, launchTop3BuyersPct). Null when the app has never seen the token.', action: false },
  { method: 'market', signature: 'await bot.market(mint)', returns: 'Market | null', notes: 'Asks the market providers (a network round trip inside the app): priceSol, priceUsd, marketCapUsd, liquidityUsd, holders, launchpad, symbol, name, imageUrl. Slow — a second or more; not for every tick.', action: false, charged: true },
  { method: 'links', signature: 'await bot.links(mint)', returns: 'Links | null', notes: 'The token’s published links and what its X link IS, from cached facts — free, costs no action (the first call for a token starts its Telegram and domain lookups; their answers appear on later calls): {twitter, website, telegram, launchpadLabel, launchpadUrl, x: {kind, handle, postId, label, accountReuse, postReuse, stats, statsReadAt}, telegramStats, domain, site}. stats is what the Links panel read off the X page when a person opened it there — {page, handle, followers, following, joined, verified, likes, reposts, replies, views, bookmarks, loginWall} — else null; nothing is fetched for it. telegramStats is what t.me’s public preview says about the Telegram link — {kind: channel · group · account · invite · unknown, members, countWord, online, title, readAt} — else null (a private invite shows no count). domain is the website’s registry record — {name, registeredAt, registrar, hostedOn, readAt} — hostedOn naming a shared platform (Vercel, GitHub Pages…) when the site has no domain of its own; else null. site is what the Links panel read off the website when a person opened it there — {namesContract, xHandles, telegramLinks, outboundHosts, wordCount, generator, mentionsConnectWallet, readAt} — else null; the app never fetches a token’s website itself. kind is profile · post · community · search · other-x · not-x · none; accountReuse / postReuse count OTHER launches in view on the same account or post. Null when the app has no cached facts for the token (call bot.market first). The app never visits the links. Solana only.', action: false },
  { method: 'security', signature: 'await bot.security(mint)', returns: 'Security | null', notes: 'The token page’s WHOLE security report (a round trip inside the app; costs an action like market): {score, checksResolved, checksTotal, checks: [{id, label, verdict, detail, source, weight, kind}], warnings, concentration: {devPct, top10Pct, top20Pct, insiderPct, bundledPct, bundledHeldPct, sniperPct, sniperHeldPct, source}, creator: {address, priorLaunches, priorRugs, launches, graduated, graduationRate, launchesInBusiestDay, devMints, devMigrations, rugcheckCreatorRugs, verdict, detail}, rug: {windowS, hide, tradesSeen, flags: [{id, label, detail, severity}], states} | null, volatility: [{id, label, detail, dumpedPct, gradPct, n}], odds: {windowS, regime, graduate: {bucket, observedPct, basePct, n, line} | null, mult3, mult5, footer} | null, dexPaid: {paid, paidAt, boosts, communityTakeover}, generatedAt}. checks[].verdict is pass · warn · fail · unknown; creator.verdict is pass · warn · fail, or null when there is no record (a first launch is the absence of a record, not a pass). Every share is % of supply and null means unknown, never 0. concentration.bundledPct / sniperPct are the provider’s when it has them, else the launch scan’s (bot.launchIntel); the *HeldPct are what those wallets hold NOW and are never inferred from what they bought. Null when it could not be read. Solana only.', action: false, charged: true },
  { method: 'creator', signature: 'await bot.creator(mint)', returns: 'Creator | null', notes: 'The creator wallet’s launch record from pump.fun (a round trip; costs an action): {address, launches, graduated, graduationRate, medianAthUsd, bestAthUsd, firstLaunchAt, lastLaunchAt, truncated}. Null when the creator is unknown or the source did not answer. Solana only.', action: false, charged: true },
  { method: 'launchIntel', signature: 'await bot.launchIntel(mint)', returns: 'LaunchIntel | null', notes: 'The Launch tab for a pump.fun coin — who bought the first blocks and what they hold NOW (a round trip: 1–2 pump.fun swap-api calls plus one RPC batch, cached 45 s; costs an action): {mint, creator, supply, complete, launchSlot, launchTs, tradesScanned, slotsSpanned, sniperWindowSlots, priced, dev, bundle, snipers, top3BuyersPct, wallets, source, note, balancesNote, generatedAt}. dev / bundle / snipers are each {wallets, bought, boughtPct, sol, heldPct, retainedPct, stillHolding}: boughtPct = % of supply bought in the window, heldPct = % of supply those wallets hold now, retainedPct = of what they bought, the % kept, stillHolding = how many still hold anything. dev is the creator wallet; bundle is every other wallet whose FIRST buy landed in the launch block itself (pre-arranged — nobody can react to a block they cannot yet see); snipers bought within sniperWindowSlots (20 ≈ 8 s) after it. wallets lists every early buyer largest first: {address, cohort, slotOffset, bought, boughtPct, sol, soldInWindow, heldNow, heldPct}. complete=false means the launch block could not be isolated: every cohort is empty and note says why — never a guess. Once fetched, the same numbers ride into the facts object for 45 s as launchDevPct, launchBundlePct, launchSniperPct, launchBundleHeldPct… (see the variable guide) and fill bundledPct / sniperPct where no provider had them. NOT fetched on every launch by itself: pump’s swap-api blocks the app for ~35 s past ~20 quick calls, so ask for the few coins you are about to act on. pump.fun coins only (anything else answers complete=false with a note). Solana only.', action: false, charged: true },
  { method: 'holders', signature: 'await bot.holders(mint, limit?)', returns: 'Holders | null', notes: 'The Holders panel: {mint, totalSupply, holderCount, rows: [{address, owner, amount, pct, tags, label}], source, note}, largest first, up to 100 (default 50). tags are dev · insider · sniper · bundle · smart · fresh · whale · lp · unknown. pct is of total supply and null when the supply is unknown. A round trip (Birdeye with a key, else the RPC’s top 20 accounts, else RugCheck); costs an action. Null when nothing could answer. Solana only.', action: false, charged: true },
  { method: 'trades', signature: 'await bot.trades(mint, limit?)', returns: 'Trades | null', notes: 'The Trades panel: {rows: [{signature, at, side, wallet, walletLabel, sol, tokens, priceSol, priceUsd, mcapUsd, program, …}], source, note}, newest first, up to 200 (default 60). The app’s own live tape when it has one for the coin, else a provider’s list. A round trip; costs an action. Solana only.', action: false, charged: true },
  { method: 'candles', signature: "await bot.candles(mint, interval?, limit?)", returns: 'Candles | null', notes: 'The chart: {mint, interval, candles: [{time, open, high, low, close, volume}], source, …}, oldest first, 10–500 bars (default 120). interval is 1s · 5s · 15s · 1m · 5m · 15m · 1h · 4h (default 1m). Built from the app’s own tape merged with its providers, so the recent bars are what this install saw. A round trip; costs an action. Solana only.', action: false, charged: true },
  { method: 'search', signature: "await bot.search('text or mint')", returns: 'Market[]', notes: 'Token search (Jupiter), up to 100 characters of text: the same summary objects bot.market returns, best match first; a pasted mint returns that coin. A round trip; costs an action. Empty when nothing matched or the provider is off. Solana only.', action: false, charged: true },
  { method: 'discover', signature: "await bot.discover('new' | 'graduating' | 'migrated' | 'trending', limit?)", returns: 'Market[]', notes: 'The Discover page’s columns, as the app is showing them right now: brand-new launches, coins nearing graduation, coins that migrated to a pool, and trending. Up to 80 rows (default 20), same summary objects as bot.market. On BNB and Robinhood the chain’s own Discover. A round trip; costs an action. What the app is watching, not a recommendation.', action: false, charged: true },
  { method: 'callouts', signature: 'await bot.callouts(limit?)', returns: 'Callout[] | null', notes: 'pump.fun’s public callouts feed, newest first, up to 50 (default 20): [{id, mint, chain, name, symbol, at, thesis, calledAtMcapUsd, mcapUsdNow, calloutPriceUsd, multiple, caller: {address, username, …}, coinCallouts, …}]. pump’s own feed, as it stands — the numbers are the callers’ claims about themselves; coinCallouts is how many callouts the COIN has, not the caller’s record. Null (not an empty list) when pump is not answering. A round trip; costs an action. Solana only.', action: false, charged: true },
  { method: 'coinCallouts', signature: 'await bot.coinCallouts(mint)', returns: 'Callout[] | null', notes: 'Every callout on ONE pump.fun coin, newest first: callers still holding (up to 100) plus callers who fully sold (up to 50), each the same Callout shape as bot.callouts with the caller’s own position in caller (holds, costUsd, realizedUsd…) and `at` = when they called. Your own calls are in it too — filter on caller.wallet. multiple is null (pump serves no current cap here). Null (not an empty list) when pump is not answering; [] means nobody has called it. A round trip (cached 30 s); costs an action. Solana only.', action: false, charged: true },
  { method: 'history', signature: 'await bot.history(limit?)', returns: 'Fill[]', notes: 'Every fill this install has made — by hand, by orders, by copy trading, by any script — newest first, up to 200 (default 50): [{at, mint, symbol, side, requested, solDelta, tokenDelta, feeSol, signature, state, …}]. solDelta is the chain’s own lamport delta (fees, tips and slippage included), null while unreconciled; paper fills are included and marked. Free. On BNB / Robinhood: that chain’s fills as {at, mint, symbol, side, hash, requested, nativeDelta, state}.', action: false },
  { method: 'holdings', signature: 'await bot.holdings()', returns: 'Holding[]', notes: 'Every token the active trading wallet holds right now — including bags this script did not open and cannot sell: [{mint, tokenAccount, amountRaw, uiAmount, decimals, symbol, programId, warning}]. warning names why a bag may not be sellable (a Token-2022 permanent delegate, a transfer hook); null means the mint was checked and carries nothing suspicious. Answered from the last chain read when it is under 2 s old, else a fresh one. REJECTS (throws) when the wallet could not be read — unknown is not empty, the same rule as bot.positions — so wrap it in try/catch and try again next pass. Costs an action. On BNB and Robinhood it is that chain’s own holdings, with amountRaw, decimals, tokenAccount and programId null and warning "not checked on this chain".', action: false, charged: true },
  { method: 'solUsd', signature: 'await bot.solUsd()', returns: 'number | null', notes: 'SOL in USD, as the app’s price provider last said it (shared, cached). Null when no provider answered. Free.', action: false },
  { method: 'nativeUsd', signature: 'await bot.nativeUsd()', returns: 'number | null', notes: 'SOL, ETH or BNB in USD (this chain). Free.', action: false },
  {
    method: 'aioInfo',
    signature: 'await bot.aio.info()',
    returns: '{exists, activeEverywhere, solanaAddress, evmAddress}',
    notes: 'activeEverywhere: needed by {topUp} and aio.move. Free.',
    action: false,
  },
  {
    method: 'aioBalances',
    signature: 'await bot.aio.balances()',
    returns: 'AioBalances | null',
    notes: 'Per chain + USD. partial=true: a chain went unread, totalUsd is a floor.',
    action: false,
    charged: true,
  },
  {
    method: 'aioMove',
    signature: "await bot.aio.move(from, to, amount)",
    returns: '{ok, message}',
    notes: "FROM's coin to your wallet on another chain ('solana'|'bnb'|'robinhood'); Relay cost + 0.5 %. Live; 20/day.",
    action: true,
  },
  { method: 'walletScores', signature: "await bot.walletScores({ window?, limit?, onlyWorthALook? })", returns: '{onRecord, filtered, rows: ScoutRow[]}', notes: 'The Wallet Scout board for this script’s chain, ranked by Copy score — what a FOLLOWER would have realised mirroring each wallet at a 2 s lag and 1.5 %/side, not what the wallet made. window: day · week · month · all (default week); limit up to 50 (default 20); onlyWorthALook applies the board’s five filters. Rows: {address, buys, sells, roundTrips, wins, losses, pnl, volume, returnPct, winRatePct, medianHoldMs, lastSeen, ranked, looksAutomated, fTrips, fPnl, copyScore, …}. The app’s own research found no group of wallets profitable to copy: this ranks least-bad, and is not an edge. Free (in memory).', action: false },
  { method: 'walletRecord', signature: 'await bot.walletRecord(address)', returns: '{wallet, saved} | null', notes: 'One wallet’s Scout record on this script’s chain — its trades, trips, and the checks behind its Copy score — plus whether it is saved. Null when the app has never seen the address. Free.', action: false },
  { method: 'copyConfigs', signature: 'await bot.copyConfigs()', returns: '{configs, stats, liveExecutable, liveBlockedReason}', notes: 'The Copy Trading page’s configs — who is followed, direction, paper or live, armed or not — and each one’s record. Read only: arming one starts unattended spending and stays something the user does in the app. Free.', action: false },
  { method: 'alerts', signature: 'await bot.alerts()', returns: 'Alert[]', notes: 'Every alert on the Alerts page — yours and the ones scripts created — with kind, threshold, whether it repeats, and when it last fired. Free. Solana only.', action: false },
  { method: 'analyze', signature: 'await bot.analyze(mint)', returns: 'Analysis', notes: 'The AI second opinion from the token page: {score, verdict, summary, bullish, bearish, provider, model, at}. It spends YOUR key (Settings → AI) on every uncached call, so it is capped at 20 per hour per script and cached 10 minutes per token, and it counts as an action. Only public on-chain facts about the token are sent — never a wallet or a key. Rejects with the reason when AI is off or capped. Solana only.', action: true },
  { method: 'positions', signature: 'await bot.positions()', returns: 'Position[]', notes: 'Every position THIS SCRIPT opened, in its mode, as the same facts object plus held=true, pnlPct, pnlSol, holdMinutes, drawdownFromPeakPct, costSol. Bags the user opened by hand are not listed and cannot be sold.', action: false },
  { method: 'orders', signature: 'await bot.orders(mint?)', returns: 'Order[]', notes: 'Solana only ([] on EVM). {id, mint, symbol, kind, state, triggerBasis, triggerValue, amount, interrupted}. All orders, or the token’s. interrupted = paused because the app stopped while it was executing (its trade may have landed): never re-place one without checking the wallet.', action: false },
  { method: 'runners', signature: 'await bot.runners()', returns: 'Token[]', notes: 'Launches the scanner currently flags as runners.', action: false },
  { method: 'leaders', signature: 'await bot.leaders()', returns: 'Array<{wallet, label, enabled, mode}>', notes: 'Wallets followed on the Copy Trading page.', action: false },
  { method: 'wallet', signature: 'await bot.wallet()', returns: '{sol: number | null, address: string | null}', notes: "This script's chain's trading wallet — `sol` is that chain's own coin. Null when unknown.", action: false },
  { method: 'wallets', signature: 'await bot.wallets()', returns: 'Array<{address, label, active}>', notes: 'This chain\x27s wallets. Every wallet this app holds a key for (at most ten, the main one included — the Wallet list), so a script can name one to trade with. `active` marks the main wallet. Addresses and labels only — never a key or an id.', action: false },
  { method: 'getState', signature: 'await bot.getState()', returns: 'object', notes: 'This script’s saved state.', action: false },
  { method: 'setState', signature: 'await bot.setState(obj)', returns: 'true', notes: 'Replace the saved state. 16 KB of JSON, survives restarts.', action: false },
  { method: 'disable', signature: "await bot.disable('reason')", returns: 'true', notes: 'The script turns itself off.', action: false },
  { local: true, method: 'now', signature: 'bot.now()', returns: 'number', notes: 'Milliseconds since the epoch.', action: false },
  { local: true, method: 'chain', signature: 'bot.chain', returns: "'solana' | 'robinhood' | 'bnb'", notes: 'The chain this script runs on. Not a call — a property, known before the first event.', action: false },
  { local: true, method: 'nativeSymbol', signature: 'bot.nativeSymbol', returns: 'string', notes: "The coin every amount here is in: SOL, ETH or BNB. Use it in logs so a script reads correctly on whichever chain it is on.", action: false },
  { local: true, method: 'input', signature: 'bot.input.<name>', returns: 'the answers to this script’s own settings', notes: 'Whatever the script asked for in its @inputs block at the top of the file, as the form answered it — so one script can be pointed at a different coin, wallet or range without editing code. Types: text, lines (an array of non-empty strings), number, range (always two numbers, low first), mint, wallet (an address), pumpAccounts (addresses of signed-in pump.fun accounts), select, toggle (true/false). Every value arrives already in its declared shape. Empty object when the script declares nothing. Not a call — a property, known before the first event.', action: false },
];

export interface EventSpec {
  event: string;
  payload: string;
  when: string;
}

export const SCRIPT_EVENTS_DOC: EventSpec[] = [
  { event: 'launch', payload: 'Token', when: 'a token was just created and the feed saw it (score usually still null)' },
  {
    event: 'launchUpdate',
    payload: 'Token',
    // The "score is fixed" clause used to be the tail of one long sentence and
    // was missed by a user who then waited seven hours for it to change. It
    // leads now.
    when:
      'a tracked launch traded; at most once per 2 s per token. THE SCORE DOES NOT CHANGE between updates — it is set once when the launch is decided, so read it on the first update and never wait for it to rise; the FLOW fields (buyers, inflow, sells, curve %) are what move. Flows while the launch is being evaluated (the first 15 s by default), then only while it is a flagged runner (15 min from the flag), held by a position, or subscribed with bot.subscribe/bot.watch — call bot.subscribe(mint) on a runner you intend to act on and both tick and launchUpdate keep coming',
  },
  { event: 'runner', payload: 'Token + runnerOddsPct', when: 'the scanner flagged a potential runner' },
  { event: 'position', payload: 'Token + position fields (held=true)', when: 'every ~5 s for each position the script holds, and on every fill' },
  { event: 'tick', payload: 'Token + position fields; priceSol is the tick', when: 'the price moved on a token the script holds, watched or subscribed to; at most once a second per token' },
  { event: 'leaderTrade', payload: 'Token + leaderWallet, leaderLabel, leaderSide, leaderSol, leaderSoldPct', when: 'a wallet followed on Copy Trading bought or sold' },
  { event: 'order', payload: 'Token + orderKind, orderState, orderAmount', when: 'one of your advanced orders triggered, filled, failed, expired, was cancelled or was paused — including, when the script starts, each order on a coin it holds that came back paused from a restart' },
  { event: 'alert', payload: 'Token + alertKind, alertThreshold', when: 'one of your alerts fired' },
  { event: 'fill', payload: '{mint, side, ok}', when: 'one of this script’s own trades landed or failed' },
  { event: 'schedule', payload: '{at: "HH:MM"}', when: 'the time set with bot.at' },
  { event: 'interval', payload: '{at: ms}', when: 'the timer set with bot.every' },
  // The engine's other moments (2026-09-27). Until now a script could only
  // infer a graduation from curvePct reaching 100 on a launchUpdate it might
  // not be receiving, and a dev sell from creatorSold flipping.
  { event: 'migration', payload: 'Token + migrated: true, isMayhem: true | false | null', when: 'a coin’s bonding curve completed and it migrated to a pool (pump.fun and Meteora DBC) — every Solana script hears every migration, whether it holds the coin or not. isMayhem is read from the create event (null = the app could not tell); the pool itself may print a few seconds later — subscribe and wait for a tick' },
  { event: 'curveHigh', payload: 'Token + curvePct, curveLevel (90 | 93 | 95 | 97), priceSol (this trade), isMayhem', when: 'a pump.fun curve first reached 90, 93, 95 or 97 % (SOL side, the same scale as curvePct) — every Solana script hears every coin, held or not, at most four times per coin. The coin you want to be holding when its curve completes (2026-09-30). isMayhem null = the app could not tell; a mayhem curve’s percentage is not a completion measure' },
  { event: 'devSell', payload: 'Token + devSoldSol, devSoldTokens', when: 'the creator wallet SOLD on a coin this script holds or subscribed to (bot.subscribe / bot.watch); creatorSold on the facts is true from then on. Solana (pump.fun curve) only' },
  { event: 'holdings', payload: '{at, holdings: Holding[]}', when: 'the trading wallet’s token accounts were re-read and differ from the last read — after any fill, yours or a script’s (the same rows bot.holdings returns). Solana only' },
  { event: 'copyFill', payload: '{id, configId, wallet, mint, symbol, side, mode, state, theirSol, ourSol, pnlSol, reason, direction, at}', when: 'copy trading opened, closed or skipped a copy (state open · closed · skipped; side buy, or sell for a mirrored exit) — the leader’s own trade is the separate leaderTrade event. Scripts on the copy’s chain only' },
  { event: 'runnerExpired', payload: 'Token', when: 'a runner flag aged off the list (15 minutes after the flag) — the last moment a runner script still has the flag’s facts' },
];

/** Rendered beside the editor. Generated, so it is always the truth about `bot`. */
export const SCRIPT_API_DOC: string = [
  '// Events',
  ...SCRIPT_EVENTS_DOC.map((e) => `bot.on('${e.event}', (x) => {})  // ${e.when}`),
  '',
  '// Actions — every one is checked against your budget in the app, not here.',
  ...SCRIPT_API.filter((a) => a.action).map((a) => `${a.signature}  // -> ${a.returns}`),
  '',
  '// Reads that leave the machine — each counts against your actions-per-minute like an action does.',
  ...SCRIPT_API.filter((a) => !a.action && a.charged).map((a) => `${a.signature}  // -> ${a.returns}`),
  '',
  '// Reads and timers — free.',
  ...SCRIPT_API.filter((a) => !a.action && !a.charged && a.method !== 'on').map((a) => `${a.signature}  // -> ${a.returns}`),
  '',
  '// Not available: fetch, XMLHttpRequest, WebSocket, require, keys, files.',
  '// Unknown facts are null — never treat null as zero.',
  `// A handler is checked at ${EVENT_TIMEOUT_MS / 1000} s: one still awaiting bot calls gets more time, up to ${EVENT_HARD_MS / 1000} s;`,
  '// a stuck one is killed and counts as an error. Five errors in a row pause the script (it restarts by itself; the 4th pause in 24 h turns it off).',
  '// Past 60 calls a second the excess calls REJECT with "dropped: ..." — price many coins in batches, not all at once.',
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
    name: 'Skip bundled runners',
    description: 'On a runner flag, read the Launch tab’s cohorts and pass only when the bundle has left and nobody early still sits on the supply.',
    code: `// Runner flags, filtered by who bought the first block — and whether they are still in.
bot.on('runner', async (t) => {
  if (t.isMayhem) return;
  const li = await bot.launchIntel(t.mint);          // costs an action; a few per minute is fine
  if (!li || !li.complete) return;                    // the launch block could not be isolated: unknown, not clean
  bot.log(\`\${t.symbol}: bundle \${li.bundle.boughtPct?.toFixed(1) ?? '—'}% bought, holds \${li.bundle.heldPct?.toFixed(1) ?? '—'}% · snipers \${li.snipers.boughtPct?.toFixed(1) ?? '—'}%\`);
  if (li.bundle.heldPct === null || li.snipers.heldPct === null) return;   // balances unread — do not guess
  if (li.bundle.heldPct + li.snipers.heldPct > 15) return;                  // early wallets still hold > 15 % of supply
  if (li.dev.heldPct !== null && li.dev.heldPct > 5) return;
  const r = await bot.buy(t.mint, 0.02);
  bot.log(\`buy \${t.symbol}: \${r.message}\`);
  if (r.ok) await bot.order({ mint: t.mint, kind: 'stop_loss', triggerBasis: 'pct', triggerValue: 30, amount: 100 });
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
  {
    name: 'All-in-One: any chain, one wallet',
    description: 'Run a copy on each chain. Buys $5 of a runner with money from ANY chain (topUp), and sends what piles up on BNB / Robinhood home to Solana. Needs the All-in-One wallet signing on every chain.',
    code: `// All-in-One: one wallet, every chain. Run a copy on Solana, BNB and Robinhood.
bot.on('runner', async (t) => {
  const usd = await bot.nativeUsd();
  if (!usd || (t.runnerOddsPct ?? 0) < 20) return; // unknown never qualifies
  // $5 in this chain's coin (Solana's smallest unattended buy is 0.03 SOL),
  // funded from the other chains if this one is short.
  const size = bot.chain === 'solana' ? Math.max(5 / usd, 0.03) : 5 / usd;
  const r = await bot.buy(t.mint, size, { topUp: true });
  bot.log(\`buy \${t.symbol}: \${r.message}\`);
});

// Hourly: over $200 here (not Solana) → move the excess home.
bot.every(3600, async () => {
  if (bot.chain === 'solana') return;
  const [usd, w] = [await bot.nativeUsd(), await bot.wallet()];
  if (!usd || w.sol === null) return;
  const extra = w.sol - 200 / usd;
  if (extra * usd > 25) bot.log((await bot.aio.move(bot.chain, 'solana', extra)).message);
});`,
  },
];

/** The variable guide as text, generated from the field table. */
export function fieldGuideText(): string {
  const groups: Array<[FieldScope, string]> = [
    ['token', 'Launch feed (any token the app saw launch)'],
    ['market', 'Market data — the providers, the Launch tab’s scan and the Links panel (when cached)'],
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
      // A hint that already ends in a full stop must not get a second one.
      out.push(`- ${f.id} (${f.kind}, ${f.unit}) — ${(f.hint || f.label).replace(/\.$/, '')}. null when ${f.nullWhen}.`);
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

You are writing a JavaScript automation script for **Krypto Bot**, a memecoin trading terminal for Solana, Robinhood Chain and BNB Chain. The script runs inside the app, in a sandbox, against a small API called \`bot\`. Each script runs on ONE chain, chosen by the user: read it from \`bot.chain\`, and write amounts in \`bot.nativeSymbol\` (SOL, ETH or BNB). Methods marked "Solana only" below are refused on the other chains when they ACT, and answer null or an empty list when they READ — so one script body can run on any chain if it checks for null. Follow every rule below; the app enforces them and a script that ignores them simply gets refused.

## What you are writing

- Plain JavaScript (ES2022). No imports, no \`require\`, no \`fetch\`, no \`WebSocket\`, no \`XMLHttpRequest\`, no DOM, no files, no timers other than \`bot.every\` / \`bot.at\`. Top-level \`await\` is allowed.
- The script body runs once at load. Register handlers with \`bot.on(...)\`; everything happens in handlers.
- Only \`bot\` and \`console\` (which logs to the script's own log) are available. \`Math\`, \`Date\`, \`JSON\`, \`Set\`, \`Map\` etc. are normal JavaScript.
- Handlers run one at a time per script. A handler is checked at **${EVENT_TIMEOUT_MS / 1000} seconds**: one that is still awaiting \`bot\` calls is given more time, up to **${EVENT_HARD_MS / 1000} seconds**; one that is stuck, or past that, is killed and counted as an error. Five errors in a row PAUSE the script: it restarts by itself after 5, then 15, then 60 minutes (you get a notification each time), and a fourth pause within 24 hours turns it off. Past 60 calls a second the excess calls reject with "dropped: …" — price many coins in batches of ~15, not a hundred at once. Keep handlers short — do a few network calls (\`bot.market\`, \`bot.callout\`, a trade) per handler, not a loop of them; spread work across \`bot.every\` ticks with a queue in \`bot.setState\`. Never loop forever or busy-wait.
- The script's memory resets when it restarts. To remember across restarts use \`bot.getState()\` / \`bot.setState(obj)\` (16 KB of JSON).

## Money rules the app enforces (you cannot bypass them; design for them)

- The script has a **budget** set by the user in the app: max SOL per buy, buys per day, open positions, actions per minute, and a daily realised-loss stop that turns the script off. Any \`bot.buy\` over the cap is **refused**, not shrunk — check \`r.ok\` and \`r.message\`.
- The script runs in **paper** (simulated fills into a paper book) or **live** mode, chosen by the user. The code is identical; do not branch on mode.
- Buys and sells go through the app's own pipeline. Sells are a percentage — or, with \`{tokens}\`, a token count — of what is held in the script's mode.
- **Public actions** — \`bot.callout\`, \`bot.calloutReply\`, \`bot.follow\`, \`bot.like\` and their undo methods — post under the user's own pump.fun account for anyone to see, and every callout ends with a "Called with krypt.cc/bot" line the app adds. On paper they send nothing and return ok with a "paper:" message, so paper tests the trading and filters, not the posting.
- Treat \`null\` as **unknown, never as zero**. Every numeric fact can be null; write \`if (t.score === null || t.score < 70) return;\` not \`if (t.score < 70)\`.

## Events

${events}

## The \`bot\` API

${api}

## The facts object ("Token" / "Position")

Every event except \`fill\`, \`schedule\`, \`interval\`, \`holdings\` and \`copyFill\` (whose payloads are described in the events list above) receives one object with these fields (null = unknown):

${fieldGuideText()}

## A settings form (optional)

A script can ask the user for settings with an \`@inputs\` block — a block comment holding one JSON object — at the top of the file. The app shows it as a form before the script runs, and the answers arrive as \`bot.input.<name>\`, already in their declared shape. Use it for anything the user might want to change without editing code (sizes, thresholds, lines of text, an account address).

\`\`\`js
/* @inputs
{
  "minBuyers": { "type": "number", "label": "Minimum unique buyers", "default": 25, "min": 0, "max": 5000 },
  "buySol":    { "type": "range",  "label": "Buy size", "default": [0.01, 0.03], "min": 0.001, "max": 5, "step": 0.001 },
  "lines":     { "type": "lines",  "label": "Callout lines", "default": ["{ticker} looking strong"], "optional": true },
  "curve":     { "type": "select", "label": "Curve", "options": ["classic only", "any"] },
  "needX":     { "type": "toggle", "label": "Must have an X link" }
}
*/
\`\`\`

- Types: ${SCRIPT_INPUT_TYPES.join(', ')}. Each field takes \`type\` and \`label\`; optional \`help\`, \`default\`, \`min\`/\`max\`/\`step\` (number, range), \`options\` (select) and \`optional: true\` (blank allowed — every other field must be answered before Run).
- A range is always \`[low, high]\`; lines is an array of non-empty strings; toggle is true/false.

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

/**
 * Fold a live-update snapshot (code left out) into the one on screen.
 *
 * Each script keeps the code the window already holds; a script the window
 * has never seen, or one saved since (a different updatedAt), marks the result
 * `stale` so the caller re-reads the full list. It errs toward KEEPING code:
 * a blank editor that someone then saves would wipe a script.
 */
export function mergeSnapshot(prev: ScriptSnapshot | null, next: ScriptSnapshot): { snap: ScriptSnapshot; stale: boolean } {
  if (!next.codeOmitted) return { snap: next, stale: false };
  let stale = false;
  const had = new Map((prev?.scripts ?? []).map((s) => [s.id, s]));
  const scripts = next.scripts.map((s) => {
    const old = had.get(s.id);
    if (!old || old.updatedAt !== s.updatedAt) stale = true;
    return { ...s, code: old?.code ?? '' };
  });
  return { snap: { ...next, scripts, codeOmitted: stale }, stale };
}
