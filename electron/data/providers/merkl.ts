// Merkl (api.merkl.xyz) — keyless. The data source behind the Rewards page.
//
// WHY THIS FILE EXISTS, AND WHAT IT REFUSES TO DO.
//
// A six-researcher swarm killed airdrop farming outright
// (docs/airdrop-research-2026-09-09.md): break-even needs a hit rate above
// 100% once labour is priced, eligibility rules are published after the block
// they measure, and two of our three chains have no reachable airdrop layer at
// all. What survived the swarm is the opposite shape — a PUBLISHED, FUNDED,
// ADDRESS-QUERYABLE rate you can verify before you act. This module serves
// that and only that. It states what is running and what a wallet has accrued.
// It never suggests, ranks or chases a maybe.
//
// Three rules are load-bearing, not stylistic:
//
//  1. NO URL EVER LEAVES THIS MODULE. Merkl puts a `depositUrl` and an
//     `explorerAddress` on every opportunity and neither is mapped, here or
//     anywhere downstream. The research is unambiguous about why: fake claim
//     domains for our own rail already exist (25 Pons-labelled in
//     ScamSniffer's blacklist, zero of them in MetaMask's), and checking the
//     domain does not help — BadgerDAO lost $120.3M to an `increaseAllowance`
//     injected into the CORRECT site. An app that holds keys must not hand a
//     user a link to click. Names are text.
//
//  2. "NONE" AND "WE COULD NOT ASK" ARE DIFFERENT FACTS. `rows: []` on a 200
//     is a real answer meaning zero. Anything else — a failure, a park, a body
//     this build cannot read — is `rows: null`, which the page renders as an
//     em dash. Jupiter's claim worker answers "not eligible" with HTTP 200,
//     JSON content-type and Content-Length 0; that is the exact trap, and here
//     it would not degrade a chart, it would make a factual claim about
//     whether someone has money waiting.
//
//  3. THE ADDRESS IS RESOLVED IN MAIN. Callers name a chain. The address comes
//     from this install's own EVM wallet store, never from the renderer —
//     the same rule the rest of the app follows for addresses and URLs.
//
// Everything goes through `http.ts`, so this module inherits the per-host
// queue, the 1.1 s gap, the escalating 429 park, the refusal classifier, the
// streaming size cap and the outright refusal to follow a redirect. There is
// no `fetch` in this file.
//
// Verified live 2026-09-09 (a handful of spaced requests, no polling):
//   GET /v4/opportunities?chainId=4663&status=LIVE&items=N
//        → 200, JSON array; x-ratelimit-limit: 4200, 4200;w=60
//   GET /v4/users/{address}/rewards?chainId=N
//        → 200 `[]` for an address with nothing; an array of
//          { chain, rewards[] } otherwise. A bad address is a real HTTP 400
//          with `application/problem+json` — Merkl does NOT refuse with a
//          success status, so it needs no entry in refusals.ts.

import { cached, getJson, putCache } from '../http';

// ── What the page is allowed to see ───────────────────────────────────
//
// These are the ONLY fields that exist downstream. `depositUrl`,
// `explorerAddress`, `icon` and the campaign `proofs` are absent by
// construction — you cannot render what was never mapped.

/** A live, funded reward campaign. Every number may be null: unknown is not
 *  zero, and a campaign whose APR Merkl did not state renders as an em dash. */
export interface RewardOpportunity {
  /** Merkl's own opaque id. Not an address and not a URL — a React key. */
  id: string;
  chainId: number;
  /** Human name of the pool/market, as text. */
  name: string;
  /** Protocol name ("Morpho", "Kittenswap"), as text. */
  protocol: string | null;
  /** What earns it: LEND, POOL, HOLD, … */
  action: string | null;
  /** Annualised percentage rate, 0..n. Null when Merkl did not state one. */
  aprPct: number | null;
  /** USD paid out per day across the whole campaign. */
  dailyRewardsUsd: number | null;
  /** USD deposited in the pool the campaign measures. */
  tvlUsd: number | null;
  /** Reward/pool token symbols, text only. */
  tokens: string[];
  /** Last campaign end, ms. Null when unstated. */
  endsAt: number | null;
}

/** One accrued reward for this wallet, in a single token, on one chain. */
export interface WalletReward {
  chainId: number;
  tokenSymbol: string;
  /** Token contract, for identification only — the page shows it shortened
   *  as text and never as a link. */
  tokenAddress: string;
  /** Cumulative earned, in human units. Null when the wire amount could not
   *  be read — never 0. */
  earned: number | null;
  /** Of `earned`, already claimed. */
  claimed: number | null;
  /** earned − claimed. Null when either side is unknown. */
  unclaimed: number | null;
  /** Accrued but not yet written into a distribution root. */
  pending: number | null;
}

/**
 * An answer, or the honest absence of one.
 *
 * `rows === null` is UNKNOWN and MUST render as an em dash. An empty array is
 * a real answer meaning none. The type is `T[] | null` rather than a flag
 * beside an always-present array precisely so a renderer cannot map straight
 * over it and print "no rewards" for a failure — the compiler stops it.
 */
export interface MerklAnswer<T> {
  rows: T[] | null;
  /** Why, when `rows` is null. 'ok' otherwise. */
  message: string;
  /** When this was fetched, ms. Null when it never was. */
  at: number | null;
}

function unknown<T>(message: string): MerklAnswer<T> {
  return { rows: null, message, at: null };
}

function answer<T>(rows: T[], at = Date.now()): MerklAnswer<T> {
  return { rows, message: 'ok', at };
}

// ── Reading the wire, defensively ─────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Merkl sends some timestamps as decimal strings.
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * A base-units integer string ("9076071563221601707") to human units.
 *
 * BigInt, not Number: a wei-scale amount is far past 2^53 and parsing it as a
 * float silently rewrites the last digits of somebody's balance. Anything
 * unparseable comes back null — an unreadable amount is unknown, not zero.
 */
export function fromBaseUnits(raw: unknown, decimals: unknown): number | null {
  const d = num(decimals);
  if (d === null || !Number.isInteger(d) || d < 0 || d > 36) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  try {
    const v = BigInt(raw);
    const scale = 10n ** BigInt(d);
    const whole = v / scale;
    const frac = v % scale;
    // Number(whole) is exact to 2^53 units of the token, which is past any
    // plausible reward; the fraction is rebuilt from a padded string so no
    // precision is lost on the way through.
    const n = Number(whole) + Number(frac) / Number(scale);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Seconds or milliseconds since the epoch → ms. Null when neither. */
function toMs(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/**
 * Map one opportunity. Returns null for a row this build cannot make sense
 * of, which is dropped rather than rendered half-blank. Note what is NOT
 * read: `depositUrl`, `explorerAddress`, `icon`, `howToSteps`.
 */
function toOpportunity(raw: unknown, chainId: number): RewardOpportunity | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const protocol = isObj(raw.protocol) ? str(raw.protocol.name) : null;
  const tokens: string[] = [];
  if (Array.isArray(raw.tokens)) {
    for (const t of raw.tokens) {
      if (!isObj(t)) continue;
      const sym = str(t.displaySymbol) ?? str(t.symbol);
      if (sym && !tokens.includes(sym)) tokens.push(sym);
      if (tokens.length >= 4) break;
    }
  }
  return {
    id,
    chainId: num(raw.chainId) ?? chainId,
    name,
    protocol,
    action: str(raw.action),
    aprPct: num(raw.apr),
    dailyRewardsUsd: num(raw.dailyRewards),
    tvlUsd: num(raw.tvl),
    tokens,
    endsAt: toMs(raw.latestCampaignEnd),
  };
}

/**
 * Merkl's rewards document is `[{ chain, rewards: [...] }]`, one entry per
 * chain asked for. `proofs` — a merkle proof, i.e. the thing a claim UI would
 * need — is present on every row and is never read.
 */
function toWalletRewards(raw: unknown, chainId: number): { rows: WalletReward[]; groups: number } {
  if (!Array.isArray(raw)) return { rows: [], groups: 0 };
  const out: WalletReward[] = [];
  // How many per-chain groups this build recognised. A recognised group with
  // an EMPTY rewards array is a real "nothing accrued"; zero recognised groups
  // out of a non-empty document is a schema change, which is an unknown.
  let groups = 0;
  for (const group of raw) {
    if (!isObj(group) || !Array.isArray(group.rewards)) continue;
    groups += 1;
    const groupChain = isObj(group.chain) ? num(group.chain.id) : null;
    for (const r of group.rewards) {
      if (!isObj(r) || !isObj(r.token)) continue;
      const token = r.token;
      const symbol = str(token.displaySymbol) ?? str(token.symbol) ?? '?';
      const address = str(token.address) ?? '';
      const decimals = token.decimals;
      const earned = fromBaseUnits(r.amount, decimals);
      const claimed = fromBaseUnits(r.claimed, decimals);
      out.push({
        chainId: groupChain ?? num(token.chainId) ?? chainId,
        tokenSymbol: symbol,
        tokenAddress: address,
        earned,
        claimed,
        // Unknown on either side makes the difference unknown too. Treating a
        // missing `claimed` as 0 would overstate what someone can collect.
        unclaimed: earned === null || claimed === null ? null : Math.max(0, earned - claimed),
        pending: fromBaseUnits(r.pending, decimals),
      });
    }
  }
  return { rows: out, groups };
}

// ── The two routes ────────────────────────────────────────────────────

/** Campaigns change on the order of hours; the list is a page-load read. */
const TTL_OPPORTUNITIES = 5 * 60_000;
/** Short, so a second click re-reads, but a double click does not. */
const TTL_REWARDS = 30_000;

/** Merkl pages this route; the Rewards page shows the biggest campaigns, not
 *  a catalogue. 50 is well inside one response and one screen of scrolling. */
const MAX_OPPORTUNITIES = 50;

function validChainId(chainId: number): boolean {
  return Number.isInteger(chainId) && chainId > 0 && chainId < 1e12;
}

/**
 * Live campaigns on a chain. Needs no address and discloses nothing about
 * this install, so the page may load it freely.
 *
 * Sorted by daily rewards, descending — the funded, published USD-per-day is
 * the one number on the row that is a fact about the campaign rather than a
 * projection about the user, and it is what the research quoted. A campaign
 * whose daily rate Merkl did not state sorts LAST rather than as zero.
 */
export async function opportunities(chainId: number, limit = MAX_OPPORTUNITIES): Promise<MerklAnswer<RewardOpportunity>> {
  if (!validChainId(chainId)) return unknown('internal: bad chain id');
  const items = Math.max(1, Math.min(MAX_OPPORTUNITIES, Math.floor(limit)));
  const key = `merkl:opps:${chainId}:${items}`;
  const hit = cached<RewardOpportunity[]>(key);
  if (hit) return answer(hit);

  const r = await getJson<unknown>('merkl', `/v4/opportunities?chainId=${chainId}&status=LIVE&items=${items}`);
  // A park, a timeout, a 4xx, a refusal classified out of a 200 body — all of
  // them mean the same thing to a reader: we do not know. Never [].
  if (!r.ok) return unknown(r.message);
  if (!Array.isArray(r.data)) return unknown('merkl: unreadable response');

  let rows: RewardOpportunity[];
  try {
    rows = r.data.map((x) => toOpportunity(x, chainId)).filter((x): x is RewardOpportunity => x !== null);
  } catch {
    // A shape change must not take the page down with an exception.
    return unknown('merkl: unreadable response');
  }
  // Merkl answered with rows and NONE of them survived the mapper: that is a
  // schema change, not an empty chain. Saying "no live campaigns" here would
  // be the same lie as saying "no rewards" for a failed request.
  if (r.data.length > 0 && rows.length === 0) return unknown('merkl: unreadable response');
  rows.sort((a, b) => {
    if (a.dailyRewardsUsd === b.dailyRewardsUsd) return a.name.localeCompare(b.name);
    if (a.dailyRewardsUsd === null) return 1;
    if (b.dailyRewardsUsd === null) return -1;
    return b.dailyRewardsUsd - a.dailyRewardsUsd;
  });
  putCache(key, rows, TTL_OPPORTUNITIES);
  return answer(rows);
}

/** 0x + 40 hex. Merkl answers a malformed address with a real HTTP 400; this
 *  catches it a request earlier and keeps a junk string out of a URL. */
export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * What one address has accrued on one chain.
 *
 * THIS SENDS THE ADDRESS TO MERKL. It is called only from an explicit user
 * action, and the page says so in plain words before the click — an app that
 * quietly hands a third party the address of the wallet it is holding keys
 * for has not told the truth about what it does.
 *
 * `[]` here is a real, useful answer: nothing accrued. A failure is null.
 */
export async function walletRewards(chainId: number, address: string): Promise<MerklAnswer<WalletReward>> {
  if (!validChainId(chainId)) return unknown('internal: bad chain id');
  if (!isAddress(address)) return unknown('internal: bad address');
  const key = `merkl:rewards:${chainId}:${address.toLowerCase()}`;
  const hit = cached<WalletReward[]>(key);
  if (hit) return answer(hit);

  const r = await getJson<unknown>('merkl', `/v4/users/${encodeURIComponent(address)}/rewards?chainId=${chainId}`);
  if (!r.ok) return unknown(r.message);
  if (!Array.isArray(r.data)) return unknown('merkl: unreadable response');

  let rows: WalletReward[];
  try {
    const read = toWalletRewards(r.data, chainId);
    // Same rule as the campaign list: Merkl sent something and this build
    // recognised none of it, so we do not know what this wallet has — which
    // is not the same as knowing it has nothing.
    if (r.data.length > 0 && read.groups === 0) return unknown('merkl: unreadable response');
    rows = read.rows;
  } catch {
    return unknown('merkl: unreadable response');
  }
  putCache(key, rows, TTL_REWARDS);
  return answer(rows);
}
