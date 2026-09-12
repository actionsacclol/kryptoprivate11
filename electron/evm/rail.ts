// The EVM rail — what ipc.ts calls, for Robinhood Chain and BNB Smart Chain.
//
// Owns the arm state PER CHAIN (going live on BNB does not go live on
// Robinhood, and neither arms the Solana engine), wires the settings into
// the clients, and builds each chain's portfolio from holdings + the
// ledger. Everything money-related delegates to trade.ts; everything
// key-related to evmWallet.ts (one wallet list, shared by both chains).

import { getAddress, type Address } from 'viem';
import type { AppSettings, EngineEvent } from '@shared/types';
import {
  EVM_CHAINS,
  EVM_CHAIN_META,
  evmFeesEnabled,
  isEvmAddress,
  NATIVE_ADDRESS,
  rawToAmount,
  weiToEth,
  type EvmChainKind,
  type EvmFill,
  type EvmHolding,
  type EvmLiveState,
  type EvmPortfolio,
  type EvmPosition,
  type EvmQuote,
  type EvmState,
  type EvmTradeResult,
  type EvmTradeStage,
  SELL_SLIPPAGE_FLOOR_PCT,
  type EvmVenue,
} from '@shared/evm';
import type { CandleInterval, CandleSeries, DiscoverColumn, TokenSummary } from '@shared/market';
import { configure, head, rpcHost, rpcStatus, usingKeyedRpc } from './client';
import * as evmWallet from './evmWallet';
import * as ledger from './ledger';
import * as trade from './trade';
import * as market from './market';
import * as discoverMod from './discover';
import { holdingsOf } from './erc20';
import { nativeUsd } from './prices';
import { resolveVenue } from './venue';
import { logger } from '../system/logger';

let getSettings: () => AppSettings = () => {
  throw new Error('evm rail not initialised');
};
let emit: (ev: EngineEvent) => void = () => undefined;
const live: Record<EvmChainKind, EvmLiveState> = {
  robinhood: { chain: 'robinhood', armed: false, armedAt: null, lastDisarmReason: 'restart' },
  bnb: { chain: 'bnb', armed: false, armedAt: null, lastDisarmReason: 'restart' },
};

export function init(opts: { userData: string; getSettings: () => AppSettings; emit: (ev: EngineEvent) => void }): void {
  getSettings = opts.getSettings;
  emit = opts.emit;
  configure((chain) => getSettings().evm[chain]);
  ledger.init(opts.userData);
  ledger.onSettled((fill) => emit({ kind: 'evmFill', fill, state: fill.state === 'reconciled' ? 'reconciled' : 'failed' }));
  trade.setEmitter((ev) => emit(ev));
  for (const chain of EVM_CHAINS) if (enabled(chain)) discoverMod.prewarm(chain);
  logger.info(`evm rail: ready (robinhood ${rpcHost('robinhood')}, bnb ${rpcHost('bnb')}${evmFeesEnabled() ? '' : ', fees off — no treasury'})`);
}

export function enabled(chain: EvmChainKind): boolean {
  return getSettings().evm[chain].enabled;
}

// ── Arm state ─────────────────────────────────────────────────────────

export function armed(chain: EvmChainKind): boolean {
  return live[chain].armed;
}

export function liveState(chain: EvmChainKind): EvmLiveState {
  return { ...live[chain] };
}

export function arm(chain: EvmChainKind): { ok: boolean; message: string } {
  const meta = EVM_CHAIN_META[chain];
  if (!enabled(chain)) return { ok: false, message: `${meta.name} is turned off in Settings` };
  if (!evmWallet.exists(chain)) return { ok: false, message: 'Create or import an EVM wallet first' };
  if (live[chain].armed) return { ok: true, message: `Already live on ${meta.name}` };
  live[chain] = { chain, armed: true, armedAt: Date.now(), lastDisarmReason: null };
  logger.warn(`evm rail ${chain}: LIVE — trades spend real ${meta.nativeSymbol} from ${evmWallet.address(chain)}`);
  void announce(chain);
  return { ok: true, message: `Live on ${meta.name} — trades spend real ${meta.nativeSymbol}` };
}

export function disarm(chain: EvmChainKind, reason: EvmLiveState['lastDisarmReason']): { ok: boolean; message: string } {
  const was = live[chain].armed;
  live[chain] = { chain, armed: false, armedAt: null, lastDisarmReason: reason };
  if (was) logger.warn(`evm rail ${chain}: disarmed (${reason})`);
  void announce(chain);
  return { ok: true, message: `Paper on ${EVM_CHAIN_META[chain].name} — trades are simulated, nothing is broadcast` };
}

async function announce(chain: EvmChainKind): Promise<void> {
  try {
    emit({ kind: 'evmState', state: await state(chain) });
  } catch {
    /* renderer gone */
  }
}

async function announceAll(): Promise<void> {
  for (const chain of EVM_CHAINS) await announce(chain);
}

/** Last head/price we managed to read, per chain. A parked or slow endpoint
 *  then costs freshness, never the whole answer. */
const lastSeen: Record<EvmChainKind, { head: { block: number; at: number } | null; usd: number | null }> = {
  robinhood: { head: null, usd: null },
  bnb: { head: null, usd: null },
};

/** Resolve `p` within `ms`, else `fallback`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export async function state(chain: EvmChainKind): Promise<EvmState> {
  const on = enabled(chain);
  // The wallet, the arm bit and the endpoint are local facts and must answer
  // instantly: every EVM surface reads "no wallet / Paper" while this call is
  // outstanding, so blocking it behind a parked RPC turns a rate limit into a
  // wrong answer about the user's own wallet. The two network facts get one
  // second and otherwise fall back to the last known values.
  if (on) {
    // The first ask has nothing cached to fall back on, so it gets a real
    // round trip's worth of patience; later ones must not hold the UI.
    const budget = lastSeen[chain].head === null ? 6_000 : 1_000;
    const [h, usd] = await Promise.all([within(head(chain), budget, lastSeen[chain].head), within(nativeUsd(chain), budget, lastSeen[chain].usd)]);
    lastSeen[chain] = { head: h, usd };
  }
  const { head: h, usd } = on ? lastSeen[chain] : { head: null, usd: null };
  return {
    chain,
    nativeSymbol: EVM_CHAIN_META[chain].nativeSymbol,
    enabled: on,
    wallet: evmWallet.info(chain),
    live: liveState(chain),
    rpcHost: rpcHost(chain),
    usingKeyedRpc: usingKeyedRpc(chain),
    rpcStatus: rpcStatus(chain),
    feesEnabled: evmFeesEnabled(),
    head: h,
    nativeUsd: usd,
  };
}

/**
 * Let in-flight EVM trades finish and get their ledger rows on disk. Called
 * from before-quit with a bound: a fill that has been broadcast must be
 * recorded, but nothing may ever hold up an exit.
 */
export async function drain(maxMs: number): Promise<void> {
  try {
    await Promise.race([trade.inFlight(), new Promise((r) => setTimeout(r, maxMs))]);
  } catch {
    /* a failing trade is still a finished trade */
  }
  ledger.flushSync();
}

// ── Wallet (with the arm interlock) ───────────────────────────────────

export const wallet = {
  info: evmWallet.info,
  list: evmWallet.list,
  failure: evmWallet.failure,
  /**
   * A wallet made from a chain's page is made FOR that chain, and signs
   * there at once when the chain had no signer of its own. That switch is
   * refused while the chain is armed — the same interlock as `select`, and
   * the whole add is refused with it so nothing is half done.
   */
  generate: (label: string, forChain?: EvmChainKind) => {
    const r = evmWallet.generate(label, forChain, forChain ? !live[forChain].armed : true);
    if (r.ok) void announceAll();
    return r;
  },
  importSecret: (secret: string, label: string, forChain?: EvmChainKind) => {
    const r = evmWallet.importSecret(secret, label, forChain, forChain ? !live[forChain].armed : true);
    if (r.ok) void announceAll();
    return r;
  },
  /** Which chain a wallet belongs to. Changes what a page lists, never who signs. */
  assign: (chain: EvmChainKind, id: string) => {
    const r = evmWallet.assign(chain, id);
    if (r.ok) void announceAll();
    return r;
  },
  /**
   * Choose the signer for ONE chain.
   *
   * Refused while THAT chain is armed — a signer that changes identity under
   * its own broadcast is the hazard the Solana switcher refuses. The other
   * chain is no longer part of the question: since each chain has its own
   * active wallet, an armed BNB has nothing to say about who signs on
   * Robinhood, and blocking it would be a rule with no risk behind it.
   */
  select: (chain: EvmChainKind, id: string) => {
    if (live[chain].armed) {
      return { ok: false, message: `Switch ${EVM_CHAIN_META[chain].shortName} to Paper before changing its wallet.` };
    }
    const r = evmWallet.select(chain, id);
    if (r.ok) void announceAll();
    return r;
  },
  rename: evmWallet.rename,
  remove: (id?: string) => {
    // Disarm the chains this wallet was SIGNING for, and only once it is
    // actually gone: a remove that fails ("No such wallet") used to disarm
    // both chains anyway. Found by audit 2026-09-11.
    const signing = EVM_CHAINS.filter((c) => live[c].armed && (id === undefined || evmWallet.info(c).id === id));
    const r = evmWallet.remove(id);
    if (r.ok) for (const c of signing) disarm(c, 'wallet_removed');
    void announceAll();
    return r;
  },
  exportAll: evmWallet.exportAllToFile,
  refreshBalance: async (chain: EvmChainKind) => (enabled(chain) ? evmWallet.refreshBalance(chain) : { ok: false, message: offMessage(chain) }),
  refreshAll: async (chain: EvmChainKind) => {
    if (enabled(chain)) await evmWallet.refreshAll(chain);
  },
};

// ── Market ────────────────────────────────────────────────────────────

export async function discover(chain: EvmChainKind, column: DiscoverColumn, limit: number): Promise<{ rows: TokenSummary[]; message: string }> {
  if (!enabled(chain)) return { rows: [], message: `${EVM_CHAIN_META[chain].name} is turned off in Settings` };
  return discoverMod.discover(chain, column, limit);
}

// A chain switched off in Settings serves nothing and polls nothing — the
// settings copy promises exactly that, and these are the paths a watchlist pin
// or a still-open token page can otherwise keep alive.
function offError(chain: EvmChainKind): Error {
  return new Error(offMessage(chain));
}

export async function summary(chain: EvmChainKind, address: string, opts?: { holders?: boolean }): Promise<TokenSummary> {
  if (!enabled(chain)) throw offError(chain);
  return market.summary(chain, address, opts);
}

export async function detail(chain: EvmChainKind, address: string): Promise<ReturnType<typeof market.detail> extends Promise<infer R> ? R : never> {
  if (!enabled(chain)) throw offError(chain);
  return market.detail(chain, address);
}

export async function candles(chain: EvmChainKind, address: string, interval: CandleInterval, limit: number): Promise<CandleSeries> {
  if (!enabled(chain)) throw offError(chain);
  return market.candles(chain, address, interval, limit);
}

/** A chain the user has switched off does no work and takes no orders — the
 *  settings copy promises exactly that. */
function offMessage(chain: EvmChainKind): string {
  return `${EVM_CHAIN_META[chain].name} is turned off in Settings`;
}


// ── Trading ───────────────────────────────────────────────────────────

function referrer(): string {
  const r = getSettings().evm.referrer;
  // The zero address burns the share (and the curve router refuses it
  // outright); a mixed-case address that fails EIP-55 is a typo, and paying a
  // typo forever is worse than paying nobody. trade.ts drops a referrer that
  // is the trader or the treasury, and one that cannot receive native.
  if (!isEvmAddress(r)) return '';
  if (r.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) return '';
  if (r !== r.toLowerCase() && r !== r.toUpperCase()) {
    try {
      if (getAddress(r) !== r) return '';
    } catch {
      return '';
    }
  }
  return r;
}

function offResult(chain: EvmChainKind): EvmTradeResult {
  return {
    ok: false,
    chain,
    stage: 'route',
    message: offMessage(chain),
    hash: null,
    venue: null,
    quote: null,
    amountIn: null,
    amountOut: null,
    gasUsed: null,
    feeHash: null,
    simulated: false,
    timing: { totalMs: 0, buildMs: null, simulateMs: null, sendMs: null, confirmMs: null },
  };
}

/**
 * What a caller may add to a trade beyond the chain, side, token and size.
 *
 * `slippagePct` is the caller's own number (the Swap page has a field for
 * it); absent, the EVM setting applies. Until 2026-09-11 the field on the
 * Swap page was read, validated, and then ignored on this rail.
 */
export interface TradeOpts {
  slippagePct?: number;
  /** Exact raw units for a sell. Wins over the percent. */
  amountRaw?: string;
  /** Refuse if the route is no longer the one that was quoted. */
  expectVenue?: EvmVenue;
  /** Sign as this wallet instead of the chain's active one (copy trading, 2026-09-11). */
  walletId?: string;
}

/** The slippage a sell actually carries: never under the floor. */
const sellSlippage = (want: number): number => Math.max(want, SELL_SLIPPAGE_FLOOR_PCT);

export async function quote(chain: EvmChainKind, side: 'buy' | 'sell', token: string, amount: number, opts: TradeOpts = {}): Promise<EvmQuote | { error: string; stage: EvmTradeStage }> {
  if (!enabled(chain)) return { error: offMessage(chain), stage: 'route' };
  const s = getSettings().evm;
  const want = opts.slippagePct ?? s.slippagePct;
  // Sells execute at the wider of the setting and the floor (below), so the
  // quote must be taken at the SAME floor or the panel labels a tighter
  // minimum than the transaction will actually carry.
  const slippagePct = side === 'sell' ? sellSlippage(want) : want;
  return trade.quote({
    chain,
    side,
    token: token as Address,
    amountNative: side === 'buy' ? amount : undefined,
    pct: side === 'sell' && opts.amountRaw === undefined ? amount : undefined,
    amountRaw: side === 'sell' ? opts.amountRaw : undefined,
    simulateOnly: true,
    slippagePct,
    referrer: referrer(),
  });
}

export async function buy(chain: EvmChainKind, token: string, amountNative: number, simulateOnly: boolean, opts: TradeOpts = {}): Promise<EvmTradeResult> {
  if (!enabled(chain)) return offResult(chain);
  const s = getSettings().evm;
  // Never broadcast while disarmed, whatever the caller asked.
  const sim = simulateOnly || !live[chain].armed;
  return trade.execute({
    chain,
    side: 'buy',
    token: token as Address,
    amountNative,
    simulateOnly: sim,
    slippagePct: opts.slippagePct ?? s.slippagePct,
    expectVenue: opts.expectVenue,
    walletId: opts.walletId,
    // A rehearsal on an armed chain is a rehearsal of the real thing.
    honestBalance: live[chain].armed,
    referrer: referrer(),
  });
}

export async function sell(chain: EvmChainKind, token: string, pct: number, simulateOnly: boolean, opts: TradeOpts = {}): Promise<EvmTradeResult> {
  if (!enabled(chain)) return offResult(chain);
  const s = getSettings().evm;
  const sim = simulateOnly || !live[chain].armed;
  // Exits get the wider of the configured slippage and the floor, like
  // Solana: refusing a sell over a tight cap is the trap the order engine
  // avoids. SELL_SLIPPAGE_FLOOR_PCT is named so the page can say so.
  return trade.execute({
    chain,
    side: 'sell',
    token: token as Address,
    pct,
    amountRaw: opts.amountRaw,
    simulateOnly: sim,
    slippagePct: sellSlippage(opts.slippagePct ?? s.slippagePct),
    expectVenue: opts.expectVenue,
    walletId: opts.walletId,
    honestBalance: live[chain].armed,
    referrer: referrer(),
  });
}

/**
 * Sell everything this chain holds, one position at a time.
 *
 * Solana has had `sellAll` and a panic hotkey since the beginning; the EVM
 * chains had neither, so a user holding five positions who wanted out sold
 * them one at a time, by hand, while the price moved. Against the house rule
 * that nothing blocks an exit, that asymmetry was indefensible.
 *
 * ─── It does not stop on a failure ─────────────────────────────────────
 *
 * The whole point is to get out of everything. One token with no route, a
 * revert, a wallet that cannot cover gas on one position — none of those may
 * abandon the positions that WOULD have sold. So every holding is attempted,
 * failures are collected, and the result says exactly which ones did not go.
 *
 * Sequential rather than parallel, because `trade.execute` serialises per
 * chain anyway: two sells built against the same pending nonce are one sell
 * on chain.
 */
export async function sellAll(chain: EvmChainKind): Promise<{
  ok: boolean;
  message: string;
  results: Array<{ token: string; symbol: string; ok: boolean; message: string; hash: string | null }>;
}> {
  if (!enabled(chain)) return { ok: false, message: offResult(chain).message, results: [] };
  // Refused outright while disarmed. `sell()` would silently simulate each
  // one and report ok, and this would then count them as SOLD — found by
  // audit 2026-09-11. A panic button that says "Sold 5" over five
  // simulations is worse than one that says no.
  if (!live[chain].armed) {
    return { ok: false, message: `${EVM_CHAIN_META[chain].name} is in Paper. Arm it to actually sell — nothing was sold.`, results: [] };
  }
  const held = await holdings(chain);
  // A holding with a zero balance is not a position: the ledger remembers
  // tokens that were sold to nothing, and trying to sell those would produce
  // a screen of failures that mean nothing.
  const positions = held.filter((h) => h.raw !== '0' && h.amount > 0);
  if (!positions.length) return { ok: true, message: `Nothing held on ${EVM_CHAIN_META[chain].name}.`, results: [] };

  // Biggest first. If something goes wrong partway — a chain that stops
  // answering, a user who quits — the money that got out is the money that
  // mattered most.
  positions.sort((a, b) => (b.valueNative ?? 0) - (a.valueNative ?? 0));

  const results: Array<{ token: string; symbol: string; ok: boolean; message: string; hash: string | null; stage: EvmTradeStage | null }> = [];
  let pendingLeg: string | null = null;
  for (const h of positions) {
    const name = h.symbol || h.token.slice(0, 8);
    // A disarm that lands mid-way — the kill switch, a wallet removed — turns
    // every later `sell()` into a simulation that answers ok. Those are not
    // sales, and "Sold 5" over three simulations is the worst thing a panic
    // button can say. Found by audit 2026-09-11.
    if (!live[chain].armed) {
      results.push({ token: h.token, symbol: h.symbol, ok: false, message: 'Disarmed part-way — not sold', hash: null, stage: null });
      continue;
    }
    // A leg that was broadcast but has no receipt yet holds the nonce: the
    // next leg would queue behind it, unconfirmed, with no way to cancel.
    // Stop here and say so; the rest are still held and still sellable.
    if (pendingLeg) {
      results.push({ token: h.token, symbol: h.symbol, ok: false, message: `Not attempted — ${pendingLeg} is still unconfirmed ahead of it`, hash: null, stage: null });
      continue;
    }
    try {
      const r = await sell(chain, h.token, 100, false);
      const sold = r.ok && !r.simulated;
      results.push({ token: h.token, symbol: h.symbol, ok: sold, message: r.simulated ? 'Disarmed part-way — simulated, not sold' : r.message, hash: r.hash ?? null, stage: r.stage });
      if (r.stage === 'pending') pendingLeg = name;
    } catch (e) {
      results.push({ token: h.token, symbol: h.symbol, ok: false, message: (e as Error).message, hash: null, stage: null });
    }
  }
  const sold = results.filter((r) => r.ok).length;
  const pending = results.filter((r) => r.stage === 'pending');
  const failed = results.length - sold;
  logger.warn(`evm ${chain}: sell-all — ${sold} sold, ${pending.length} sent but unconfirmed, ${failed - pending.length} failed`);
  const stillHeld = results.filter((r) => !r.ok && r.stage !== 'pending').map((r) => r.symbol || r.token.slice(0, 8));
  return {
    // Anything that got out is worth reporting as a partial success rather
    // than as a failure; the message names what did not, and separates
    // "sent, waiting" from "still held" — they are not the same thing.
    ok: sold > 0 || failed === 0,
    message:
      failed === 0
        ? `Sold ${sold} position(s) on ${EVM_CHAIN_META[chain].name}.`
        : `Sold ${sold} of ${results.length}.` +
          (pending.length ? ` Sent, unconfirmed: ${pending.map((r) => r.symbol || r.token.slice(0, 8)).join(', ')}.` : '') +
          (stillHeld.length ? ` Still held: ${stillHeld.join(', ')}.` : ''),
    results,
  };
}

// ── Holdings and portfolio ────────────────────────────────────────────

export function fills(chain: EvmChainKind): EvmFill[] {
  const owner = evmWallet.address(chain);
  return owner ? ledger.forWallet(chain, owner) : [];
}

export function track(chain: EvmChainKind, token: string, on: boolean): string[] {
  const owner = evmWallet.address(chain);
  if (!owner) return [];
  return ledger.track(chain, owner, token, on);
}

async function readHoldings(chain: EvmChainKind, owner: Address): Promise<EvmHolding[]> {
  const tokens = ledger.knownTokens(chain, owner).slice(-60) as Address[];
  if (!tokens.length) return [];
  const held = await holdingsOf(chain, owner, tokens);
  const out: EvmHolding[] = [];
  for (const [token, h] of held) {
    out.push({ chain, token, symbol: h.symbol, name: h.name, decimals: h.decimals, raw: h.raw.toString(), amount: rawToAmount(h.raw, h.decimals), priceNative: null, valueNative: null, valueSource: null, venue: 'unknown' });
  }
  return out;
}

async function priceHoldings(chain: EvmChainKind, holdings: EvmHolding[]): Promise<void> {
  await Promise.all(
    holdings.slice(0, 30).map(async (h) => {
      try {
        const [v, s] = await Promise.all([resolveVenue(chain, h.token as Address), market.summary(chain, h.token)]);
        h.venue = v.venue;
        h.priceNative = s.priceSol;
        if (s.priceSol !== null) {
          h.valueNative = s.priceSol * h.amount;
          h.valueSource = 'spot';
        }
        if (!h.symbol && s.symbol) h.symbol = s.symbol;
      } catch {
        /* unpriced holding stays a dash */
      }
    }),
  );
}

export async function holdings(chain: EvmChainKind): Promise<EvmHolding[]> {
  const owner = evmWallet.address(chain);
  if (!owner || !enabled(chain)) return [];
  const h = await readHoldings(chain, owner);
  await priceHoldings(chain, h);
  return h;
}

export async function portfolio(chain: EvmChainKind): Promise<EvmPortfolio> {
  const owner = evmWallet.address(chain);
  const now = Date.now();
  const meta = EVM_CHAIN_META[chain];
  if (!owner || !enabled(chain)) {
    return { chain, nativeSymbol: meta.nativeSymbol, address: null, nativeBalance: null, nativeUsd: null, positions: [], realizedPnlNative: null, unrealizedPnlNative: null, gasPaidNative: null, feesPaidNative: null, fills: 0, unreconciled: 0, generatedAt: now };
  }
  void ledger.reconcilePending();
  const [held, usd] = await Promise.all([readHoldings(chain, owner), nativeUsd(chain), evmWallet.refreshBalance(chain)]);
  await priceHoldings(chain, held);
  const basis = ledger.basisByToken(chain, owner);
  const positions: EvmPosition[] = [];
  let unrealized: number | null = null;
  let realized: number | null = null;
  for (const h of held) {
    const b = basis.get(h.token);
    const bought = b ? rawToAmount(b.tokensBought, h.decimals) : 0;
    const avgCost = b && b.tokensBought > 0n ? weiToEth(b.spentWei) / bought : null;
    const basisKnown = avgCost !== null && h.amount <= bought * 1.02;
    const costNative = basisKnown && avgCost !== null ? avgCost * h.amount : null;
    const unreal = basisKnown && h.valueNative !== null && costNative !== null ? h.valueNative - costNative : null;
    const sold = b ? rawToAmount(b.tokensSold, h.decimals) : 0;
    // Tokens sold that this install never bought (an airdrop, a transfer in)
    // have no cost here, so an average entry applied to them would invent a
    // loss. Unknown is an em dash, never a number.
    const soldBeyondBasis = b ? sold > bought * 1.02 : false;
    const real = b && avgCost !== null && sold > 0 && !soldBeyondBasis ? weiToEth(b.receivedWei) - avgCost * sold : null;
    if (unreal !== null) unrealized = (unrealized ?? 0) + unreal;
    if (real !== null) realized = (realized ?? 0) + real;
    positions.push({
      ...h,
      basisKnown,
      costNative,
      avgEntryPriceNative: basisKnown ? avgCost : null,
      unrealizedPnlNative: unreal,
      unrealizedPnlPct: unreal !== null && costNative ? (unreal / costNative) * 100 : null,
      realizedPnlNative: real,
      firstBuyAt: b?.firstAt ?? null,
      lastFillAt: b?.lastAt ?? null,
      unreconciledFills: b?.unreconciled ?? 0,
    });
  }
  for (const [token, b] of basis) {
    if (held.some((h) => h.token === token)) continue;
    const bought = rawToAmount(b.tokensBought, b.decimals ?? 18);
    const sold = rawToAmount(b.tokensSold, b.decimals ?? 18);
    if (bought <= 0 || sold <= 0) continue;
    if (sold > bought * 1.02) continue; // sold more than this install bought — no basis to price it with
    const avg = weiToEth(b.spentWei) / bought;
    realized = (realized ?? 0) + (weiToEth(b.receivedWei) - avg * sold);
  }
  const st = ledger.stats(chain, owner);
  const info = evmWallet.info(chain);
  positions.sort((a, b) => (b.valueNative ?? 0) - (a.valueNative ?? 0));
  return {
    chain,
    nativeSymbol: meta.nativeSymbol,
    address: owner,
    nativeBalance: info.balanceNative,
    nativeUsd: usd,
    positions,
    realizedPnlNative: realized,
    unrealizedPnlNative: unrealized,
    // 0 is only a fact when something was actually priced: with fills that
    // never reconciled the honest answer is "unknown", not "nothing paid".
    gasPaidNative: st.fills && (st.gasWei > 0n || st.unreconciled === 0) ? weiToEth(st.gasWei) : null,
    feesPaidNative: st.fills && (st.feeWei > 0n || st.unreconciled === 0) ? weiToEth(st.feeWei) : null,
    fills: st.fills,
    unreconciled: st.unreconciled,
    generatedAt: now,
  };
}
