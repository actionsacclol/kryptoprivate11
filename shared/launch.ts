// Launching a token from inside the app — the rules, in one place.
//
// The research swarm (docs/launch-research-2026-09-09.md) said do not build
// this as a "whole section", for two reasons: the economics are poor, and
// Solana's create forces a second signature, which meant relaxing the app's
// strongest invariant for everybody.
//
// The second objection is answered by making it opt-in with a wallet of its
// own, which is what this module describes. The first has not changed and is
// not a secret: EV on a launch with no audience is a couple of dollars, and
// this app's own `creatorVerdict` calls ten launches in a day a launch
// factory. It ships because people want the tool, not because it pays.
//
// ─── The three rules that make it safe to ship ───────────────────────────
//
//  1. OFF BY DEFAULT. With `enabled: false` the `launch` intent cannot be
//     constructed, so `numRequiredSignatures !== 1` refuses a create exactly
//     as it always has. A user who never opts in is not affected at all, and
//     a test pins that rather than a comment claiming it.
//
//  2. A WALLET OF ITS OWN. Launching signs from a dedicated wallet and the
//     main trading wallet is forbidden from the intent. A bug in the launch
//     path cannot reach the keys holding your positions, and your creator
//     address is not your trading address on chain.
//
//  3. THE SECOND SIGNER IS NAMED. Not "two signers allowed" — exactly two,
//     where the second is the ephemeral mint this app generated seconds ago
//     for this launch. See signPolicy.checkLaunchSigners.

export type LaunchChain = 'solana' | 'robinhood';

export const LAUNCH_CHAINS: LaunchChain[] = ['solana', 'robinhood'];

export interface LaunchConfig {
  /** Master switch. False = the launch intent does not exist. */
  enabled: boolean;
  /**
   * SOLANA wallet id that signs launches. Empty until the user picks one.
   *
   * Must never be the active trading wallet — `readiness` refuses that, and
   * so does the main process before it signs anything.
   */
  walletId: string;
  /**
   * EVM wallet id that signs Robinhood launches.
   *
   * A separate field because the two chains keep separate wallet files with
   * separate ids, and one id cannot address both. The rule is the same on
   * each: not the wallet you trade with.
   */
  evmWalletId: string;
}

export const DEFAULT_LAUNCH_CONFIG: LaunchConfig = { enabled: false, walletId: '', evmWalletId: '' };

/** The wallet id that signs on this chain, or '' when none is picked. */
export function launchWalletId(cfg: LaunchConfig, chain: LaunchChain): string {
  return chain === 'solana' ? cfg.walletId : cfg.evmWalletId;
}

/** Why a chain cannot launch yet, or null when it can. */
export type LaunchBlocker =
  | 'disabled'
  | 'no-wallet'
  | 'wallet-is-trading-wallet'
  | 'wallet-empty'
  | 'builder-unverified'
  | 'live-off';

export const BLOCKER_TEXT: Record<LaunchBlocker, string> = {
  disabled: 'Launching is switched off. Turn it on below — while it is off, this app cannot co-sign anything.',
  'no-wallet': 'Pick a wallet to launch from. It must not be the wallet you trade with.',
  'wallet-is-trading-wallet': 'That is your active trading wallet. Launching needs its own, so a mistake here cannot touch your positions.',
  'wallet-empty': 'The launch wallet has no balance. Send it enough for the create fee and your first buy.',
  'builder-unverified':
    'The create instruction for this chain has not been verified against the chain yet, so the app will not build one. See the note below.',
  // Solana only, and it is not bureaucracy: the creator's first buy goes
  // through the ordinary trade path, so a launch with live execution off
  // would create the token and then fail to buy it — the one outcome worth
  // refusing BEFORE the token exists rather than after.
  'live-off': 'Your own first buy runs through the normal trade path, so live execution must be on and the engine armed before you launch.',
};

export interface ChainReadiness {
  chain: LaunchChain;
  ready: boolean;
  blocker: LaunchBlocker | null;
}

/**
 * Whether a chain can launch right now.
 *
 * `builderVerified` is supplied by the caller rather than assumed here: it is
 * false until a chain's create instruction has been decoded from a REAL
 * transaction and pinned by a test, the same bar the trade decoders had to
 * clear. Guessing an account list would produce a transaction that either
 * fails or does something other than what the user asked for, and one of those
 * is much worse than the other.
 */
export function readiness(
  cfg: LaunchConfig,
  chain: LaunchChain,
  facts: {
    activeWalletId: string | null;
    walletBalance: number | null;
    builderVerified: boolean;
    /**
     * Solana only: live execution on AND the engine armed.
     *
     * Robinhood does not need it — Pons creates and buys in one router call,
     * so no part of a Robinhood launch goes through the engine.
     */
    liveReady?: boolean;
  },
): ChainReadiness {
  const blocked = (blocker: LaunchBlocker): ChainReadiness => ({ chain, ready: false, blocker });

  const walletId = launchWalletId(cfg, chain);
  if (!cfg.enabled) return blocked('disabled');
  if (!walletId) return blocked('no-wallet');
  if (facts.activeWalletId && walletId === facts.activeWalletId) return blocked('wallet-is-trading-wallet');
  if (!facts.builderVerified) return blocked('builder-unverified');
  if (chain === 'solana' && facts.liveReady === false) return blocked('live-off');
  // A null balance is UNKNOWN, not empty: an unreadable balance must not be
  // reported as "you have no money", and it is the chain that refuses a
  // transaction it cannot pay for, not this screen.
  if (facts.walletBalance !== null && facts.walletBalance <= 0) return blocked('wallet-empty');
  return { chain, ready: true, blocker: null };
}

// ─────────────────────────────────────────────────────────────────────────
// The draft, and what makes one sendable.
//
// A launch is the least reversible thing this app can do: the token exists
// forever, under your name, and nothing can un-create it. So the draft is
// validated in SHARED code — the form greys out the button, and the main
// process refuses the same draft for the same reasons. The UI check is a
// courtesy; the main-process one is the rule.
// ─────────────────────────────────────────────────────────────────────────

export const MAX_NAME = 32;
export const MAX_SYMBOL = 10;
export const MAX_DESCRIPTION = 500;

/**
 * The first buy is REQUIRED, and not for the reason it looks like.
 *
 * Every other path that signs with your key is billed — the platform fee is
 * injected before signing and a test pins the treasury. A create with no buy
 * would be the one signing path that is free, and a free signing path is a
 * thing to be exploited rather than a feature. Requiring a buy means the
 * launch is billed exactly like any other trade, through the ordinary trade
 * pipeline, with the ordinary fee.
 *
 * It is also what a launch is for. A token whose creator did not buy it is a
 * token nobody bought.
 */
export const MIN_DEV_BUY: Record<LaunchChain, number> = {
  // Enough to be a real first position rather than dust the curve rounds away.
  solana: 0.01,
  // Robinhood's native leg, on top of the router's flat 0.0005 launch fee.
  robinhood: 0.002,
};

/** Creator fee a Pons launch pays its creator, in basis points. Pons's own
 *  interface offers a range; this is the span we accept. */
export const MAX_CREATOR_TAX_BPS = 500;

export interface LaunchDraft {
  chain: LaunchChain;
  name: string;
  symbol: string;
  description: string;
  /** Pinned image URL, filled in by the upload step. Never a local path. */
  imageUrl: string;
  /**
   * Solana only: the metadata JSON the mint points at. Produced by the same
   * upload step; pump reads the token's name, symbol and image from it.
   */
  metadataUri: string;
  twitter: string;
  telegram: string;
  website: string;
  /** Native units (SOL / ETH) for the creator's own first buy. */
  devBuy: number;
  /** Solana: trade against inflated virtual reserves, fee to a reserved
   *  recipient. Off unless asked for. */
  mayhem: boolean;
  /**
   * Solana: redirect the creator fee to traders, PERMANENTLY.
   *
   * Off by default and it stays off unless the user turns it on. 44 % of pump
   * launches use it, which is why the modal successful launch pays its creator
   * nothing — the choice is irreversible and belongs to the person making it.
   */
  cashback: boolean;
  /** Robinhood: creator fee in basis points, 0–MAX_CREATOR_TAX_BPS. */
  creatorTaxBps: number;
}

export function emptyDraft(chain: LaunchChain): LaunchDraft {
  return {
    chain,
    name: '',
    symbol: '',
    description: '',
    imageUrl: '',
    metadataUri: '',
    twitter: '',
    telegram: '',
    website: '',
    devBuy: MIN_DEV_BUY[chain],
    mayhem: false,
    cashback: false,
    creatorTaxBps: 100,
  };
}

/**
 * Everything wrong with this draft, in the order a person would fix it.
 *
 * Returns an empty array when the draft can be sent. Callers on both sides of
 * the IPC boundary use this same function, so "the button was enabled" can
 * never mean something different from "the main process will accept it".
 */
export function draftProblems(d: LaunchDraft): string[] {
  const out: string[] = [];
  const name = d.name.trim();
  const symbol = d.symbol.trim();
  if (name.length === 0) out.push('Give the token a name.');
  else if (name.length > MAX_NAME) out.push(`The name is ${name.length} characters; ${MAX_NAME} is the maximum.`);
  if (symbol.length === 0) out.push('Give the token a ticker.');
  else if (symbol.length > MAX_SYMBOL) out.push(`The ticker is ${symbol.length} characters; ${MAX_SYMBOL} is the maximum.`);
  else if (!/^[A-Za-z0-9]+$/.test(symbol)) out.push('The ticker may only contain letters and digits.');
  if (d.description.length > MAX_DESCRIPTION) out.push(`The description is ${d.description.length} characters; ${MAX_DESCRIPTION} is the maximum.`);
  if (!d.imageUrl) out.push('Add an image. It is the only thing most people will ever see of this token.');
  if (d.chain === 'solana' && !d.metadataUri) out.push('The metadata has not been uploaded yet.');
  // A URL we are about to write into a token that exists forever: it must at
  // least be a URL, and it must not be a local path we would be publishing by
  // accident.
  for (const [label, v] of [['image', d.imageUrl], ['metadata', d.metadataUri]] as const) {
    if (v && !/^https:\/\//.test(v)) out.push(`The ${label} link must be an https URL.`);
  }
  const min = MIN_DEV_BUY[d.chain];
  if (!Number.isFinite(d.devBuy) || d.devBuy < min) {
    out.push(`Your own first buy must be at least ${min} — a launch nobody bought, including you, is not a launch.`);
  }
  if (d.chain === 'robinhood') {
    const bps = d.creatorTaxBps;
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_CREATOR_TAX_BPS) {
      out.push(`The creator fee must be a whole number of basis points between 0 and ${MAX_CREATOR_TAX_BPS}.`);
    }
  }
  return out;
}

/** What a launch attempt did. Shared so the page and the main process agree. */
export interface LaunchOutcome {
  ok: boolean;
  message: string;
  /** The new token — a mint on Solana, a contract address on Robinhood. */
  token?: string;
  /**
   * The transaction, whenever one was sent — INCLUDING on failure. A receipt
   * that times out is not a launch that did not happen: the token may exist,
   * and the hash is the only way to find out. Found by audit 2026-09-11:
   * the first version dropped it, so "find it by the transaction hash"
   * pointed at a hash the user had never been shown.
   */
  hash?: string;
  /**
   * Set when the token WAS created but the creator's own buy did not land.
   *
   * `ok` stays true in that case, because it is: the token exists. Reporting
   * a failure would send someone to create a second token they already own.
   */
  buyFailed?: string;
}

// ── The watermark ─────────────────────────────────────────────────────
//
// Every coin launched from this app carries a line at the end of its
// description saying where it was made. It goes into the metadata JSON that
// the mint points at, so it travels with the token rather than living in our
// own records: anyone reading the coin anywhere sees it.
//
// It is NOT hidden. The form shows the description exactly as it will be
// written, watermark included, and the character budget below is what is
// left for the user's own words. A watermark someone discovers after the
// fact, on a token that exists forever under their name, is the kind of
// surprise this app does not do.

// ROTATED (2026-09-24), same reason as the callout mark: an identical line on
// every launched coin reads as templated. Each variation still names Krypto
// Bot or its URL, so every one discloses the coin was launched with the tool.
export const LAUNCH_WATERMARKS = [
  'Launched with krypt.cc/bot',
  'launched via Krypto Bot',
  'made with Krypto Bot',
  'Launched on Krypto Bot',
  'launched with krypt.cc/bot',
  'Krypto Bot · krypt.cc/bot',
];

/** Canonical mark, for the one place a fixed string is needed (the Launch
 *  page label). Live descriptions rotate — see below. */
export const LAUNCH_WATERMARK = LAUNCH_WATERMARKS[0];

/** A random launch mark. Every variation discloses the tool. */
export function pickLaunchWatermark(): string {
  return LAUNCH_WATERMARKS[Math.floor(Math.random() * LAUNCH_WATERMARKS.length)];
}

/** Separator between the user's words and the line: a new line, so it stands
 *  on its own under the description (asked 09-22). */
const WATERMARK_SEP = '\n';

/** Every mark this app has used — current variations and the legacy one — so a
 *  draft stamped with ANY of them is re-stamped rather than carrying two. */
const ALL_LAUNCH_MARKS = [...LAUNCH_WATERMARKS, 'Launched using krypt.cc/tools/krypto'];

/** Longest mark, so the budget reserves room for whichever is picked. */
const LAUNCH_WATERMARK_MAX = Math.max(...ALL_LAUNCH_MARKS.map((m) => m.length));

/**
 * The description as it will actually be written.
 *
 * Structurally idempotent: any existing mark is stripped before a fresh one is
 * appended, so a re-run or a re-edit never stacks two — the wording just
 * changes per write.
 */
export function withWatermark(description: string): string {
  let body = (description ?? '').trim();
  for (const old of ALL_LAUNCH_MARKS) {
    if (body.endsWith(old)) {
      body = body.slice(0, -old.length).trim();
      break;
    }
  }
  const mark = pickLaunchWatermark();
  if (!body) return mark;
  return `${body}${WATERMARK_SEP}${mark}`;
}

/** Whether this text already carries the watermark (any variation or legacy). */
export function hasWatermark(description: string): boolean {
  // Coins launched under the old mark keep it forever; they are still ours.
  const d = (description ?? '').trim();
  return ALL_LAUNCH_MARKS.some((m) => d.endsWith(m));
}

/**
 * How many characters are left for the user's own words.
 *
 * The watermark counts against pump's limit like any other text, so the form
 * counts down from this (reserving the LONGEST mark) rather than from
 * MAX_DESCRIPTION — otherwise someone fills 500 characters and the stamped
 * version is refused.
 */
export const DESCRIPTION_BUDGET = MAX_DESCRIPTION - (LAUNCH_WATERMARK_MAX + WATERMARK_SEP.length);
