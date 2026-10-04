// Compress: turn everything the All-in-One wallet holds into ONE coin on one
// chain — SOL, ETH (Robinhood) or BNB — so it can be sent out in one go
// (2026-10-03). Pure: what a user is shown before they confirm is pinned by a
// test, and the executor in main follows the same plan.
//
// The order is fixed: sell every token for its own chain's coin, then move
// each other chain's coin to the target through Relay. Nothing is hidden:
// a token that cannot be sold, or a coin that cannot be moved, is listed
// with the reason and stays where it is.

import { AIO_CHAIN_LABEL, type AioBalanceChain, type AioBalances, type AioChain } from './aio';
import { HARD_FLOOR_USD } from './bridge';

export const COMPRESS_TARGETS: AioChain[] = ['solana', 'robinhood', 'bnb'];
export const COMPRESS_COIN: Record<AioChain, string> = { solana: 'SOL', robinhood: 'ETH', bnb: 'BNB' };

/**
 * Left behind on a chain the money moves OFF, in its own coin: enough for a
 * later send or sell there, far less than the top-up reserve (CHAIN_RESERVE),
 * because the point of compressing is to empty the chain.
 */
export const COMPRESS_KEEP: Record<AioChain, number> = { solana: 0.003, bnb: 0.0002, robinhood: 0.00003 };

/** A move must clear Relay's refund floor with a margin for its own costs. */
export const COMPRESS_MIN_MOVE_USD = HARD_FLOOR_USD + 0.5;

/** Rough costs for the estimate only — the real ones are quoted at send time. */
const SELL_COST_SHARE = 0.015; // Krypt 0.5 % + a route's spread and gas
const MOVE_COST_SHARE = 0.0056; // Krypt 0.5 % + Relay's ~0.06 %
const MOVE_COST_FLAT_USD = 0.05; // Relay's flat part and destination gas

export interface CompressSell {
  chain: AioChain;
  token: string;
  symbol: string;
  amount: number;
  /** Null = no price: still sold if a route exists, but not in the estimate. */
  usd: number | null;
  /** Why it will NOT be sold; null = it will be. */
  blocked: string | null;
}

export interface CompressMove {
  from: AioChain;
  to: AioChain;
  /** In the FROM chain's coin, after its sells, less COMPRESS_KEEP. */
  estAmount: number | null;
  estUsd: number | null;
  blocked: string | null;
}

export interface CompressStay {
  chain: AioBalanceChain;
  symbol: string;
  amount: number;
  usd: number | null;
  why: string;
}

export interface CompressPlan {
  target: AioChain;
  coin: string;
  sells: CompressSell[];
  moves: CompressMove[];
  stays: CompressStay[];
  /** About what lands on the target, in USD (already there + arriving). */
  estFinalUsd: number | null;
  /** About what the sells and moves cost, in USD. */
  estCostUsd: number | null;
  /** Chains whose tokens wait on Live. */
  needsLive: AioChain[];
  /** True when there is nothing to sell and nothing to move. */
  nothingToDo: boolean;
  /** Chains that could not be read (or only partly): NOT in this plan. The
   *  estimate is then a floor, and the confirmation says so. */
  unread: AioBalanceChain[];
}

export interface CompressInput {
  bal: AioBalances;
  target: AioChain;
  /** Is the All-in-One wallet the signer on this chain? */
  signingOn: Record<AioChain, boolean>;
  /** Is this chain in Live (a real sell, not a paper one)? */
  live: Record<AioChain, boolean>;
  /** Is the chain switched on in Settings? */
  enabled: Record<AioChain, boolean>;
  /** Tokens left alone, keyed "chain:token" (lower-case on EVM) → why. */
  exclude?: Record<string, string>;
}

const isAioChain = (c: AioBalanceChain): c is AioChain => c === 'solana' || c === 'bnb' || c === 'robinhood';

/** A token's symbol as it may appear in a confirmation: untrusted, so
 *  control and direction characters go and it is kept short. */
export function safeSymbol(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return (clean.length > 24 ? `${clean.slice(0, 24)}…` : clean) || '?';
}

export function excludeKey(chain: AioChain, token: string): string {
  return `${chain}:${chain === 'solana' ? token : token.toLowerCase()}`;
}

export function planCompress(input: CompressInput): CompressPlan {
  const { bal, target, signingOn, live, enabled } = input;
  const exclude = input.exclude ?? {};
  const sells: CompressSell[] = [];
  const stays: CompressStay[] = [];
  const needsLive = new Set<AioChain>();
  let cost = 0;
  let costKnown = true;
  // What each chain will hold in its own coin, in USD, once its sells land.
  const afterSellsUsd: Record<AioChain, number> = { solana: 0, bnb: 0, robinhood: 0 };
  const nativeUsdPer: Record<AioChain, number | null> = { solana: null, bnb: null, robinhood: null };
  const nativeAmount: Record<AioChain, number> = { solana: 0, bnb: 0, robinhood: 0 };

  for (const a of bal.assets) {
    if (!(a.amount > 0)) continue;
    if (!isAioChain(a.chain)) {
      stays.push({ chain: a.chain, symbol: a.symbol, amount: a.amount, usd: a.usd, why: `${AIO_CHAIN_LABEL[a.chain]} is read for the total only — the app does not trade or move from it` });
      continue;
    }
    const c = a.chain;
    if (a.kind === 'native') {
      nativeAmount[c] = a.amount;
      if (a.usd !== null && a.amount > 0) nativeUsdPer[c] = a.usd / a.amount;
      afterSellsUsd[c] += a.usd ?? 0;
      continue;
    }
    if (!a.token) continue;
    let blocked: string | null = exclude[excludeKey(c, a.token)] ?? null;
    // Under a cent: the sale costs more in fees than it returns (10-03, the
    // test wallet held eight such leftovers). Listed as staying, not sold.
    if (blocked) {
      /* excluded by the caller ($KRYPTO, a running bot's coin) */
    } else if (a.dust) blocked = 'worth under a cent — selling would cost more in fees than it returns';
    else if (!enabled[c]) blocked = `${AIO_CHAIN_LABEL[c]} is turned off in Settings`;
    else if (!signingOn[c]) blocked = `the All-in-One wallet is not the signer on ${AIO_CHAIN_LABEL[c]}`;
    else if (!live[c]) {
      blocked = `${AIO_CHAIN_LABEL[c]} is in Paper — a sell there would be simulated`;
      needsLive.add(c);
    }
    sells.push({ chain: c, token: a.token, symbol: a.symbol, amount: a.amount, usd: a.usd, blocked });
    if (blocked) {
      stays.push({ chain: c, symbol: a.symbol, amount: a.amount, usd: a.usd, why: blocked });
      continue;
    }
    if (a.usd !== null) {
      afterSellsUsd[c] += a.usd * (1 - SELL_COST_SHARE);
      cost += a.usd * SELL_COST_SHARE;
    } else {
      costKnown = false;
    }
  }

  const moves: CompressMove[] = [];
  let arriving = 0;
  for (const from of COMPRESS_TARGETS) {
    if (from === target) continue;
    const px = nativeUsdPer[from];
    const keepUsd = px !== null ? COMPRESS_KEEP[from] * px : null;
    const estUsd = keepUsd !== null ? Math.max(0, afterSellsUsd[from] - keepUsd) : null;
    const estAmount = estUsd !== null && px ? estUsd / px : null;
    // Nothing there at all: not a move, not worth a line.
    if (afterSellsUsd[from] <= 0 && nativeAmount[from] <= 0) continue;
    let blocked: string | null = null;
    if (!enabled[from] || !enabled[target]) blocked = `${AIO_CHAIN_LABEL[!enabled[from] ? from : target]} is turned off in Settings`;
    else if (!signingOn[from] || !signingOn[target]) blocked = 'the All-in-One wallet is not the signer on every chain';
    else if (estUsd === null) blocked = `no ${COMPRESS_COIN[from]} price right now`;
    else if (estUsd < COMPRESS_MIN_MOVE_USD) blocked = `about $${estUsd.toFixed(2)} — under Relay's $${HARD_FLOOR_USD} minimum`;
    moves.push({ from, to: target, estAmount, estUsd, blocked });
    if (blocked) {
      if (estUsd !== null && estUsd > 0.01) stays.push({ chain: from, symbol: COMPRESS_COIN[from], amount: estAmount ?? 0, usd: estUsd, why: blocked });
      continue;
    }
    const moveCost = (estUsd as number) * MOVE_COST_SHARE + MOVE_COST_FLAT_USD;
    cost += moveCost;
    arriving += (estUsd as number) - moveCost;
  }

  // A chain that could not be read is NOT empty: its funds are simply not in
  // this plan, and the dialog must say so (v6 audit 2026-10-03).
  const unread = bal.chains.filter((c) => !c.ok || c.partial === true).map((c) => c.chain);
  for (const c of unread) {
    stays.push({ chain: c, symbol: '—', amount: 0, usd: null, why: `${AIO_CHAIN_LABEL[c]} could not be read just now — whatever is there is not included` });
  }
  const sellsToDo = sells.filter((s) => !s.blocked).length;
  const movesToDo = moves.filter((m) => !m.blocked).length;
  const allPriced = bal.totalUsd !== null && nativeUsdPer[target] !== null;
  return {
    target,
    coin: COMPRESS_COIN[target],
    sells,
    moves,
    stays,
    estFinalUsd: allPriced ? Math.round((afterSellsUsd[target] + arriving) * 100) / 100 : null,
    estCostUsd: costKnown ? Math.round(cost * 100) / 100 : null,
    needsLive: COMPRESS_TARGETS.filter((c) => needsLive.has(c)),
    nothingToDo: sellsToDo === 0 && movesToDo === 0,
    unread,
  };
}

/** The plan in words, for the native confirmation (main) and the page. */
export function describeCompress(p: CompressPlan): string {
  const lines: string[] = [];
  for (const s of p.sells.filter((x) => !x.blocked)) {
    lines.push(`Sell ${fmtAmt(s.amount)} ${safeSymbol(s.symbol)} on ${AIO_CHAIN_LABEL[s.chain]}${s.usd !== null ? ` (about $${s.usd.toFixed(2)})` : ' (no price)'}`);
  }
  for (const m of p.moves.filter((x) => !x.blocked)) {
    lines.push(`Move about ${fmtAmt(m.estAmount ?? 0)} ${COMPRESS_COIN[m.from]} from ${AIO_CHAIN_LABEL[m.from]} to ${AIO_CHAIN_LABEL[m.to]} (about $${(m.estUsd ?? 0).toFixed(2)})`);
  }
  return lines.join('\n');
}

function fmtAmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return Number(v.toPrecision(3)).toString();
}
