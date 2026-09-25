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
import { nativeSymbolOf, type ChainKind } from './evm';
import type { EvmLaunchWindow, EvmScanLaunch } from './evmScan';
import { parseXLink, type XLinkKind } from './xLink';
import { launchpadSite } from './tokenLinks';
import type { TokenSummary } from './market';
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
export const SOLANA_ONLY_TRIGGERS: ReadonlySet<RuleTrigger> = new Set<RuleTrigger>(['runner', 'tick', 'order', 'alert']);

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
  /** Realised loss in a day that DISABLES the script, SOL. */
  maxLossSolPerDay: number;
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
  { id: 'bundledPct', label: 'Bundled %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: 'Bought in the launch bundle', nullWhen: 'unknown to the providers' },
  { id: 'sniperPct', label: 'Snipers %', kind: 'number', scope: 'market', unit: 'percent of supply', hint: '', nullWhen: 'unknown to the providers' },
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

/** The security report, as `bot.security()` hands it to a script. */
export interface ScriptSecurity {
  score: number | null;
  checksResolved: number;
  checksTotal: number;
  checks: Array<{ id: string; label: string; verdict: string; detail: string }>;
  warnings: string[];
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
  if (c.hasTwitter === null) c.hasTwitter = l.twitter;
  if (c.hasWebsite === null) c.hasWebsite = l.website;
  if (c.hasTelegram === null) c.hasTelegram = l.telegram;
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
    socials: { twitter: s.socials.twitter, website: s.socials.website, telegram: s.socials.telegram, dexPaid: s.socials.dexPaid },
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
  // Outside the branch on purpose: a RULES script carries a `code` field too,
  // and the whole file is re-serialised on every save, so an unbounded body
  // there is the same cost whether or not anything ever runs it.
  if (typeof s.code === 'string' && new TextEncoder().encode(s.code).length > MAX_CODE_BYTES) {
    return { ok: false, message: `Script is over ${MAX_CODE_BYTES / 1024} KB` };
  }
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
  /** Realised today, SOL (paper: exact; live: from the position's PnL at the sell). */
  realizedSolToday: number;
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
}

export interface ScriptSnapshot {
  scripts: UserScript[];
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
   * Answered inside the sandbox, so it is NOT one of SCRIPT_METHODS and never
   * crosses the wire. Handlers, the logger, the clock, and the two facts about
   * the script's own chain, which ride along with the code in `init`.
   */
  local?: true;
}

/** The whole `bot` object. The harness, the dispatcher and the docs all
 *  follow this table. */
export const SCRIPT_API: ApiSpec[] = [
  { local: true, method: 'on', signature: "bot.on(event, async (payload) => {})", returns: 'void', notes: 'Register a handler. Events: launch, launchUpdate, runner, position, tick, leaderTrade, order, alert, fill, schedule, interval. Handlers for one script run one at a time. One is checked at 3 s; if it is still awaiting bot calls it gets more time, up to 30 s — a stuck one is killed and counts as an error.', action: false },
  { method: 'every', signature: 'bot.every(seconds, async () => {})', returns: 'Promise<number> (the seconds used)', notes: 'A timer. 5 s minimum, 3600 max.', action: false },
  { method: 'at', signature: "bot.at('HH:MM', async () => {})", returns: 'Promise<string>', notes: 'Once a day at that local time.', action: false },
  { method: 'buy', signature: 'await bot.buy(mint, sol, address?)', returns: '{ok, message}', notes: 'Through the app’s own pipeline in the script’s mode (paper or live). Refused (ok:false, with the reason) when over THIS SCRIPT’S budget — max per trade, buys per day, open positions, actions per minute — or while live is blocked (not armed, execution off, a breaker). The app’s manual per-trade cap does NOT apply: a script’s own budget is the authority on its size. Pass another of your own wallet ADDRESSES (see bot.wallets) to buy with that wallet instead — refused until you accept “Trading from your other wallets” on the Scripts page. The app does not space these out or cap how many of your wallets touch a coin: the script does what it is written to, inside its own budget. Solana only, and paper spends nothing.', action: true },
  { method: 'sell', signature: 'await bot.sell(mint, pct, address?)', returns: '{ok, message}', notes: 'pct 1–100 of what is held in the script’s mode. Refused when nothing is held. Pass another of your own wallet ADDRESSES to sell from that one instead — only a mint this script opened, and only on Solana.', action: true },
  { method: 'sellAll', signature: 'await bot.sellAll()', returns: '{ok, message, sold: number}', notes: 'Sell 100 % of every position this script holds.', action: true },
  { method: 'order', signature: "await bot.order({ mint, kind, triggerBasis, triggerValue, amount })", returns: '{ok, message}', notes: "kind: stop_loss | take_profit | trailing_stop | limit_buy | limit_sell | sell_on_dev_sell | sell_on_migration | buy_on_migration. triggerBasis: 'pct' (from the price now) | 'mcap_usd' | 'price_sol'. amount: SOL for buys, % for sells. Placed as a real advanced order (paused if the app cannot execute right now).", action: true },
  { method: 'cancelOrders', signature: 'await bot.cancelOrders(mint)', returns: '{ok, message, cancelled: number}', notes: 'Cancel every open order on the token.', action: true },
  { method: 'clearCompletedOrders', signature: 'await bot.clearCompletedOrders()', returns: '{ok, message, cleared: number}', notes: 'Prune every FINISHED order (filled, cancelled, expired, failed) from the Orders list. Finished orders otherwise pile up against the 200-order cap and eventually get new orders (your take-profit rungs) refused, so a long-running script that places orders should call this each loop. Housekeeping — costs no action, touches no open order. Solana only.', action: false },
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
  { method: 'discord', signature: "await bot.discord('webhookSetting', { title, description, url, color, fields, thumbnail, footer })", returns: '{ok, message}', notes: 'Post an embed to a Discord channel. The first argument is the NAME of one of this script’s own settings declared with "type": "webhook" in @inputs — never a URL; the app looks the URL up, and only Discord webhook addresses are accepted there. bot.input shows that setting redacted. Fields are capped to Discord’s limits, only https links are kept, mentions never ping, and the footer always names the script (and says PAPER on a paper script). Allowed on paper: it spends nothing. Costs one action.', action: true },
  { method: 'like', signature: "await bot.like(calloutId, address?)", returns: '{ok, message}', notes: 'Like a pump.fun callout by its id (a pasted link containing the id works too). PUBLIC, under that account. Liking twice is fine. An id pump does not know comes back ok:false “callout not found”. A paper script likes nothing. Solana only.', action: true },
  { method: 'unlike', signature: "await bot.unlike(calloutId, address?)", returns: '{ok, message}', notes: 'Take a like back. Same arguments as bot.like.', action: true },
  { local: true, method: 'log', signature: "bot.log('text') / bot.warn('text') / bot.error('text')", returns: 'void', notes: 'A line on this script’s log at that level (400 chars max). bot.error does not stop the script — it is just a red line.', action: false },
  { local: true, method: 'stat', signature: "bot.stat('Callouts', 12)", returns: 'void', notes: 'Show a live number (or short text, or true/false) on this script’s own widget — add the Script monitor widget and pick the script. The same name again replaces the value; names show in the order first set. null shows as unknown (—), never 0. Up to 24 stats, names up to 32 characters, text up to 80. Costs no action and nothing waits on it, so it is fine on every tick. The widget starts empty each time the script starts — re-send totals kept in bot.setState if they should carry over.', action: false },
  { local: true, method: 'stats', signature: "bot.stats({ 'Callouts': 12, 'Likes': 30, 'PnL (SOL)': 0.42 })", returns: 'void', notes: 'Set several widget stats at once — same rules as bot.stat.', action: false },
  { local: true, method: 'clearStats', signature: 'bot.clearStats()', returns: 'void', notes: 'Empty this script’s widget.', action: false },
  { method: 'price', signature: 'await bot.price(mint)', returns: 'number | null', notes: 'SOL per token from what the app already knows. Null when nothing local knows it.', action: false },
  { method: 'token', signature: 'await bot.token(mint)', returns: 'Token | null', notes: 'The same facts a rule sees (see the variable guide), from the launch feed and the cached market data. Null when the app has never seen the token.', action: false },
  { method: 'market', signature: 'await bot.market(mint)', returns: 'Market | null', notes: 'Asks the market providers (a network round trip inside the app): priceSol, priceUsd, marketCapUsd, liquidityUsd, holders, launchpad, symbol, name, imageUrl. Slow — a second or more; not for every tick.', action: false },
  { method: 'links', signature: 'await bot.links(mint)', returns: 'Links | null', notes: 'The token’s published links and what its X link IS, from cached facts — free, costs no action (the first call for a token starts its Telegram and domain lookups; their answers appear on later calls): {twitter, website, telegram, launchpadLabel, launchpadUrl, x: {kind, handle, postId, label, accountReuse, postReuse, stats, statsReadAt}, telegramStats, domain, site}. stats is what the Links panel read off the X page when a person opened it there — {page, handle, followers, following, joined, verified, likes, reposts, replies, views, bookmarks, loginWall} — else null; nothing is fetched for it. telegramStats is what t.me’s public preview says about the Telegram link — {kind: channel · group · account · invite · unknown, members, countWord, online, title, readAt} — else null (a private invite shows no count). domain is the website’s registry record — {name, registeredAt, registrar, hostedOn, readAt} — hostedOn naming a shared platform (Vercel, GitHub Pages…) when the site has no domain of its own; else null. site is what the Links panel read off the website when a person opened it there — {namesContract, xHandles, telegramLinks, outboundHosts, wordCount, generator, mentionsConnectWallet, readAt} — else null; the app never fetches a token’s website itself. kind is profile · post · community · search · other-x · not-x · none; accountReuse / postReuse count OTHER launches in view on the same account or post. Null when the app has no cached facts for the token (call bot.market first). The app never visits the links. Solana only.', action: false },
  { method: 'security', signature: 'await bot.security(mint)', returns: 'Security | null', notes: 'The token page’s security report (a round trip inside the app; costs an action like market): {score, checksResolved, checksTotal, checks: [{id, label, verdict, detail}], warnings}. verdict is pass · warn · fail · unknown. Null when it could not be read. Solana only.', action: false },
  { method: 'creator', signature: 'await bot.creator(mint)', returns: 'Creator | null', notes: 'The creator wallet’s launch record from pump.fun (a round trip; costs an action): {address, launches, graduated, graduationRate, medianAthUsd, bestAthUsd, firstLaunchAt, lastLaunchAt, truncated}. Null when the creator is unknown or the source did not answer. Solana only.', action: false },
  { method: 'analyze', signature: 'await bot.analyze(mint)', returns: 'Analysis', notes: 'The AI second opinion from the token page: {score, verdict, summary, bullish, bearish, provider, model, at}. It spends YOUR key (Settings → AI) on every uncached call, so it is capped at 20 per hour per script and cached 10 minutes per token, and it counts as an action. Only public on-chain facts about the token are sent — never a wallet or a key. Rejects with the reason when AI is off or capped. Solana only.', action: true },
  { method: 'positions', signature: 'await bot.positions()', returns: 'Position[]', notes: 'Every position THIS SCRIPT opened, in its mode, as the same facts object plus held=true, pnlPct, pnlSol, holdMinutes, drawdownFromPeakPct, costSol. Bags the user opened by hand are not listed and cannot be sold.', action: false },
  { method: 'orders', signature: 'await bot.orders(mint?)', returns: 'Order[]', notes: '{id, mint, symbol, kind, state, triggerBasis, triggerValue, amount}. All orders, or the token’s.', action: false },
  { method: 'runners', signature: 'await bot.runners()', returns: 'Token[]', notes: 'Launches the scanner currently flags as runners.', action: false },
  { method: 'leaders', signature: 'await bot.leaders()', returns: 'Array<{wallet, label, enabled, mode}>', notes: 'Wallets followed on the Copy Trading page.', action: false },
  { method: 'wallet', signature: 'await bot.wallet()', returns: '{sol: number | null, address: string | null}', notes: "This script's chain's trading wallet — `sol` is that chain's own coin. Null when unknown.", action: false },
  { method: 'wallets', signature: 'await bot.wallets()', returns: 'Array<{address, label, active}>', notes: 'Every wallet this app holds a key for (at most ten, the main one included — the Wallet list), so a script can name one to trade with. `active` marks the main wallet. Addresses and labels only — never a key or an id. Solana only.', action: false },
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
  `// A handler is checked at ${EVENT_TIMEOUT_MS / 1000} s: one still awaiting bot calls gets more time, up to ${EVENT_HARD_MS / 1000} s;`,
  '// a stuck one is killed and counts as an error. Five errors in a row disable the script.',
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

You are writing a JavaScript automation script for **Krypto Bot**, a memecoin trading terminal for Solana, Robinhood Chain and BNB Chain. The script runs inside the app, in a sandbox, against a small API called \`bot\`. Each script runs on ONE chain, chosen by the user: read it from \`bot.chain\`, and write amounts in \`bot.nativeSymbol\` (SOL, ETH or BNB). Methods marked "Solana only" below are refused on the other chains. Follow every rule below; the app enforces them and a script that ignores them simply gets refused.

## What you are writing

- Plain JavaScript (ES2022). No imports, no \`require\`, no \`fetch\`, no \`WebSocket\`, no \`XMLHttpRequest\`, no DOM, no files, no timers other than \`bot.every\` / \`bot.at\`. Top-level \`await\` is allowed.
- The script body runs once at load. Register handlers with \`bot.on(...)\`; everything happens in handlers.
- Only \`bot\` and \`console\` (which logs to the script's own log) are available. \`Math\`, \`Date\`, \`JSON\`, \`Set\`, \`Map\` etc. are normal JavaScript.
- Handlers run one at a time per script. A handler is checked at **${EVENT_TIMEOUT_MS / 1000} seconds**: one that is still awaiting \`bot\` calls is given more time, up to **${EVENT_HARD_MS / 1000} seconds**; one that is stuck, or past that, is killed and counted as an error. Five errors in a row turn the script off. Keep handlers short — do a few network calls (\`bot.market\`, \`bot.callout\`, a trade) per handler, not a loop of them; spread work across \`bot.every\` ticks with a queue in \`bot.setState\`. Never loop forever or busy-wait.
- The script's memory resets when it restarts. To remember across restarts use \`bot.getState()\` / \`bot.setState(obj)\` (16 KB of JSON).

## Money rules the app enforces (you cannot bypass them; design for them)

- The script has a **budget** set by the user in the app: max SOL per buy, buys per day, open positions, actions per minute, and a daily realised-loss stop that turns the script off. Any \`bot.buy\` over the cap is **refused**, not shrunk — check \`r.ok\` and \`r.message\`.
- The script runs in **paper** (simulated fills into a paper book) or **live** mode, chosen by the user. The code is identical; do not branch on mode.
- Buys and sells go through the app's own pipeline. Sells are a percentage of what is held in the script's mode.
- **Public actions** — \`bot.callout\`, \`bot.calloutReply\`, \`bot.follow\`, \`bot.like\` and their undo methods — post under the user's own pump.fun account for anyone to see, and every callout ends with a "Called with krypt.cc/bot" line the app adds. On paper they send nothing and return ok with a "paper:" message, so paper tests the trading and filters, not the posting.
- Treat \`null\` as **unknown, never as zero**. Every numeric fact can be null; write \`if (t.score === null || t.score < 70) return;\` not \`if (t.score < 70)\`.

## Events

${events}

## The \`bot\` API

${api}

## The facts object ("Token" / "Position")

Every event except \`fill\`, \`schedule\` and \`interval\` receives one object with these fields (null = unknown):

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
