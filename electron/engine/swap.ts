// The Wallet Utilities swapper — any token to any token.
//
// Routing is Jupiter's, the same source every buy and sell already uses, so
// this adds no new venue, no new program and no new trust. What it adds is
// the pair: until now one side was always SOL, so cashing a bag out to USDC
// meant two trades and two fees.
//
// ─── This is a utility, not a trade ──────────────────────────────────────
//
// It books no position, computes no PnL and never touches the strategy. A
// swap moves what you hold from one thing to another; calling it a trade
// would put a cost basis on a stablecoin and a "loss" on a consolidation.
// The ledger is not written here for the same reason.
//
// ─── Why the signing policy needed no new rule ───────────────────────────
//
// To the signer a swap IS a sell of the input mint: the input leaves our
// token account — permitted on a sell of the traded mint, and only into an
// account the route itself names — and the output merely arrives, which
// needs no permission because nothing of ours moves out. So this signs with
// `trade: { side: 'sell', mint: inputMint }` and every existing refusal is
// exactly as strict as it was. Nothing about the wallet's defences was
// loosened to add this.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  isKnownMint,
  nativeOf,
  nativeSymbol,
  SPEED_URGENCY,
  SWAP_SPEEDS,
  WSOL_MINT,
  fromRaw,
  priorityCapLamports,
  swapProblems,
  toRaw,
  type SwapDraft,
  type SwapQuote,
  type SwapSpeed,
} from '@shared/swap';
import * as feeEstimator from './feeEstimator';
import { FEE_BPS, activeTreasury, feesEnabled, looksLikeSolAddress, splitFee, treasuryIntegrity } from '@shared/fees';
import { holderFeeBps, holderRateApplies } from '@shared/krypto';
import { usableTokens as kryptoUsableTokens } from './kryptoHolding';
import * as wallet from '../system/wallet';
import { logger } from '../system/logger';
import { buildPairSwap, quoteSellLamports } from './jupiterRoute';
import { injectTransfersFit, broadcastAndConfirm, type PlannedTransfer } from './broadcast';
import { getAccountInfo, getBalance, getTokenBalanceRawForMint, simulateTransaction } from '../chain/rpcClient';
import { anchorReason, rentSafeTransfers, tokenAmount } from './liveSigner';
import { ataFor, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../chain/addresses';
import { KNOWN_TRADE_PROGRAMS, unknownTopLevelPrograms } from '../system/signPolicy';
import * as evmRail from '../evm/rail';
import * as evmWallet from '../evm/evmWallet';
import { balanceOf as erc20BalanceOf, tokenMeta as erc20Meta } from '../evm/erc20';
import { EVM_CHAIN_META, VENUE_LABEL, type EvmChainKind, type EvmVenue } from '@shared/evm';
import type { Address } from 'viem';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * What every speed preset would cost right now, measured.
 *
 * Scoped to the two mints rather than to the network at large, because
 * Solana's fee market is LOCAL to the accounts a transaction writes — the
 * same reason the trade path scopes its estimate to the bonding curve. A
 * fallback estimate is reported as such rather than passed off as a reading.
 */
async function priorityBySpeed(
  httpUrl: string,
  inputMint: string,
  outputMint: string,
): Promise<{ bySpeed: Record<SwapSpeed, number>; source: 'helius' | 'rpc' | 'fallback' }> {
  const est = await feeEstimator.estimate(httpUrl, [inputMint, outputMint]);
  const bySpeed = {} as Record<SwapSpeed, number>;
  for (const s of SWAP_SPEEDS) bySpeed[s] = priorityCapLamports(feeEstimator.priceFor(est, SPEED_URGENCY[s]));
  return { bySpeed, source: est.source };
}

/**
 * Ceiling on SOL leaving via bare transfers.
 *
 * A swap injects the platform fee and nothing else; there are no tips,
 * because there is nothing to win by landing a block earlier. So the bound is
 * the fee itself plus a small allowance for the rent of an output token
 * account the route may have to create.
 */
const MAX_RENT_ALLOWANCE_LAMPORTS = 10_000_000; // 0.01 SOL

export interface SwapDeps {
  httpUrl: string;
  referrer: string;
  /**
   * Live execution is on AND the engine is armed. A real Solana swap needs
   * both, exactly like a trade; a swap in Paper is refused, not pretended.
   * Found by audit 2026-09-11: the EVM branch refused while disarmed and the
   * Solana branch spent real SOL under the same switch.
   */
  live: boolean;
}

/** Mint decimals, read from the mint account itself. */
async function decimalsOf(httpUrl: string, mint: string): Promise<number | null> {
  if (mint === WSOL_MINT) return 9;
  const info = await getAccountInfo(httpUrl, mint);
  if (!info.ok || !info.data?.data) return null;
  // Only a MINT has decimals: an account owned by anything but a token
  // program, or shorter than a mint, is not one, and byte 44 of it is a
  // random number that would size the swap. (Found by audit 2026-09-11.)
  if (info.data.owner !== TOKEN_PROGRAM && info.data.owner !== TOKEN_2022_PROGRAM) return null;
  // SPL Mint layout: 4 mintAuthorityOption + 32 authority + 8 supply, then
  // one byte of decimals. Token-2022 keeps the same first 45 bytes, so this
  // reads both without asking which program owns the mint.
  const raw = info.data.data;
  return raw.length >= 82 ? raw[44]! : null;
}

/** What the wallet holds of a mint, in base units. Null = could not read. */
async function heldRaw(httpUrl: string, owner: string, mint: string): Promise<{ raw: bigint; decimals: number | null } | null> {
  if (mint === WSOL_MINT) {
    const bal = await getBalance(httpUrl, owner);
    return bal.ok && bal.data !== undefined ? { raw: BigInt(bal.data), decimals: 9 } : null;
  }
  const r = await getTokenBalanceRawForMint(httpUrl, owner, mint);
  return r.ok && r.data ? r.data : null;
}

/** Base units of `mint` held before the swap; ok:false when the chain could not say. */
async function outputHeld(httpUrl: string, owner: string, mint: string): Promise<{ ok: true; raw: bigint } | { ok: false }> {
  const r = await getTokenBalanceRawForMint(httpUrl, owner, mint);
  if (!r.ok) return { ok: false };
  return { ok: true, raw: r.data?.raw ?? 0n };
}

export interface SwapBalance {
  mint: string;
  decimals: number | null;
  amount: number | null;
  raw: string | null;
}

/** What the active wallet holds of one mint, for the amount field. */
export async function balanceOf(deps: SwapDeps, mint: string, chain: SwapDraft['chain'] = 'solana'): Promise<SwapBalance> {
  if (isEvm(chain)) {
    if (mint.toLowerCase() === nativeOf(chain).toLowerCase()) {
      const st = await evmRail.state(chain);
      return { mint, decimals: 18, amount: st.wallet.balanceNative, raw: null };
    }
    const holdings = await evmRail.holdings(chain);
    const held = holdings.find((h) => h.token.toLowerCase() === mint.toLowerCase());
    // Not in the holdings list is UNKNOWN, not zero: the list is what the
    // ledger has seen this wallet touch, never the whole chain.
    return { mint, decimals: held?.decimals ?? null, amount: held ? held.amount : null, raw: held?.raw ?? null };
  }
  const owner = wallet.publicKey();
  if (!owner) return { mint, decimals: null, amount: null, raw: null };
  const held = await heldRaw(deps.httpUrl, owner, mint);
  if (!held) return { mint, decimals: null, amount: null, raw: null };
  const decimals = held.decimals ?? (await decimalsOf(deps.httpUrl, mint));
  return {
    mint,
    decimals,
    raw: held.raw.toString(),
    amount: decimals === null ? null : fromRaw(held.raw.toString(), decimals),
  };
}

/**
 * What the platform fee would be on this swap, and where the number came from.
 *
 * The fee is 0.5 % of the SOL value, like everywhere else. When SOL is one
 * side of the swap that value is the quote's own SOL leg. When neither side
 * is SOL the input has to be priced in SOL separately — and when even that
 * fails the fee is ZERO, because a fee this app cannot justify on a number it
 * can show you is one it does not charge.
 */
async function feeFor(
  inputMint: string,
  outputMint: string,
  inRaw: bigint,
  solLegLamports: number | undefined,
): Promise<{ lamports: number; basis: SwapQuote['feeBasis'] }> {
  if (!feesEnabled()) return { lamports: 0, basis: 'unpriced' };
  if (typeof solLegLamports === 'number' && Number.isFinite(solLegLamports) && solLegLamports > 0) {
    return { lamports: solLegLamports, basis: inputMint === WSOL_MINT || outputMint === WSOL_MINT ? 'sol-leg' : 'quoted' };
  }
  const priced = await quoteSellLamports(inputMint, inRaw);
  if (priced && priced.lamports > 0) return { lamports: priced.lamports, basis: 'quoted' };
  return { lamports: 0, basis: 'unpriced' };
}

export interface SwapQuoteResult {
  ok: boolean;
  message: string;
  quote?: SwapQuote;
}

// ── The EVM chains ──────────────────────────────────────────────────────
//
// Their rail builds native-to-token and token-to-native calls and nothing
// else, so a swap there IS a buy or a sell on that chain and is routed
// through the path that is already verified, fee'd and ledgered rather than
// through a second one written tonight and tested by nobody.
//
// Two honest differences from the Solana swapper, both stated on the page:
// the chain has to be ARMED (it is the ordinary trade path, and that path
// refuses to broadcast while a chain is in Paper), and the swap is RECORDED
// as a fill, because on those chains it is one.

const isEvm = (c: SwapDraft['chain']): c is EvmChainKind => c === 'robinhood' || c === 'bnb';

/** Which side is the token, and whether we are buying or selling it. */
function evmLeg(draft: SwapDraft): { side: 'buy' | 'sell'; token: string } | null {
  const native = nativeOf(draft.chain).toLowerCase();
  if (draft.inputMint.toLowerCase() === native) return { side: 'buy', token: draft.outputMint };
  if (draft.outputMint.toLowerCase() === native) return { side: 'sell', token: draft.inputMint };
  return null;
}

/**
 * The size the EVM rail understands for a sell: a percent of the holding.
 *
 * Used by BOTH the quote and the execute, so the number on the card is the
 * number that leaves. Found by audit 2026-09-11: the quote passed the typed
 * token amount straight through AS a percent, so "sell 0.5 USDG" was quoted
 * as "sell 0.5 % of your USDG" while execute sized it differently.
 */
async function sellSize(chain: EvmChainKind, token: string, amount: number): Promise<{ amountRaw: string; decimals: number } | { error: string }> {
  // The ledger's list first (it has decimals and a price); the chain itself
  // when the ledger has never heard of the token. A bag bought elsewhere
  // and imported with the wallet is still a bag — "you do not hold that"
  // was the honest-null rule broken the other way. Found by audit 2026-09-11.
  const holdings = await evmRail.holdings(chain);
  const held = holdings.find((h) => h.token.toLowerCase() === token.toLowerCase());
  let heldRaw: bigint;
  let decimals: number;
  if (held && held.amount > 0) {
    decimals = held.decimals;
    heldRaw = toRaw(held.amount, decimals);
  } else {
    const owner = evmWallet.address(chain);
    if (!owner) return { error: `No wallet on ${EVM_CHAIN_META[chain].name}.` };
    try {
      const [raw, meta] = await Promise.all([erc20BalanceOf(chain, token as Address, owner), erc20Meta(chain, [token as Address])]);
      const d = meta.get(token.toLowerCase())?.decimals;
      if (raw <= 0n) return { error: 'This wallet holds none of that token on this chain.' };
      if (d === undefined) return { error: 'That token would not say how many decimals it has — nothing was sized.' };
      heldRaw = raw;
      decimals = d;
      // Now that it is known, the wallet page shows it too.
      try {
        evmRail.track(chain, token, true);
      } catch {
        /* the sell does not depend on the listing */
      }
    } catch (e) {
      return { error: `Could not read your balance of that token: ${(e as Error).message}` };
    }
  }
  const amountRaw = toRaw(amount, decimals);
  if (amountRaw <= 0n) return { error: `That is below one base unit of the token (${decimals} decimals).` };
  if (amountRaw > heldRaw) return { error: `That is more than you hold (${fromRaw(heldRaw.toString(), decimals)}).` };
  return { amountRaw: amountRaw.toString(), decimals };
}

/**
 * The venue each (chain, side, token) was last quoted on, so the execute
 * can refuse a route that changed underneath it. The card cannot swap
 * without a quote, and the quote is what it showed the user.
 */
const lastVenue = new Map<string, EvmVenue>();
const venueKey = (chain: EvmChainKind, side: 'buy' | 'sell', token: string): string => `${chain}:${side}:${token.toLowerCase()}`;

async function quoteEvm(draft: SwapDraft, chain: EvmChainKind): Promise<SwapQuoteResult> {
  const leg = evmLeg(draft);
  if (!leg) return { ok: false, message: `One side has to be ${nativeSymbol(chain)} on this chain.` };
  let amountRaw: string | undefined;
  if (leg.side === 'sell') {
    const s = await sellSize(chain, leg.token, draft.amount);
    if ('error' in s) return { ok: false, message: s.error };
    amountRaw = s.amountRaw;
  }
  const q = await evmRail.quote(chain, leg.side, leg.token, draft.amount, { slippagePct: draft.slippagePct, amountRaw });
  if ('error' in q) return { ok: false, message: q.error };
  lastVenue.set(venueKey(chain, leg.side, leg.token), q.venue);
  // A buy hands back RAW token units, whose precision belongs to that token;
  // a sell hands back wei. The known-mint list is consulted FIRST (it is
  // verified on chain), then the holdings list; a token in neither is left
  // null so the card shows a dash rather than a number off by a power of ten.
  // Found by audit 2026-09-11: the first version fell back to 18, and a
  // first-ever USDG buy would have shown its output a trillion times too small.
  let outDecimals: number | null = 18;
  if (leg.side === 'buy') {
    const known = isKnownMint(chain, leg.token)?.decimals;
    if (known !== undefined) outDecimals = known;
    else {
      const holdings = await evmRail.holdings(chain);
      const held = holdings.find((h) => h.token.toLowerCase() === leg.token.toLowerCase());
      outDecimals = held?.decimals ?? null;
    }
  }
  return {
    ok: true,
    message: `${leg.side} via ${q.venue}`,
    quote: {
      inputMint: draft.inputMint,
      outputMint: draft.outputMint,
      // The rail's own number for what goes in — for a four.meme sell that
      // is the typed amount floored to the curve's 1e9 quantum.
      inAmountRaw: q.amountIn ?? '0',
      outAmountRaw: q.amountOut ?? '0',
      inDecimals: leg.side === 'buy' ? 18 : (outDecimals ?? 18),
      outDecimals,
      route: [VENUE_LABEL[q.venue] ?? q.venue],
      priceImpactPct: null,
      // The EVM rail prices its own fee, at the same 0.5 %, and says where it
      // is taken (on top of a buy, in a second transfer, or out of a sell's
      // proceeds). Passed through, not re-derived, so the card cannot
      // disagree with the rail.
      feeLamports: 0,
      feeNative: Number(BigInt(q.feeWei ?? '0')) / 1e18,
      feeBasis: q.feeBasis,
      appliedSlippagePct: q.slippagePct,
      priorityLamports: 0,
      priorityBySpeed: { cheap: 0, normal: 0, fast: 0 },
      prioritySource: 'fallback',
    },
  };
}

async function executeEvm(draft: SwapDraft, chain: EvmChainKind, simulateOnly: boolean): Promise<SwapResult> {
  const leg = evmLeg(draft);
  if (!leg) return { ok: false, message: `One side has to be ${nativeSymbol(chain)} on this chain.` };
  // The rail would simulate a disarmed chain and answer ok. The card's own
  // text promises arming is required, so a swap in Paper is refused, not
  // pretended. Found by audit 2026-09-11 ("Swapped." over nothing).
  if (!simulateOnly && !evmRail.armed(chain)) {
    return { ok: false, message: `${EVM_CHAIN_META[chain].name} is in Paper. Arm it (Live) to swap — nothing was sent.` };
  }
  const expectVenue = lastVenue.get(venueKey(chain, leg.side, leg.token));
  const opts = { slippagePct: draft.slippagePct, expectVenue };
  if (leg.side === 'buy') {
    const r = await evmRail.buy(chain, leg.token, draft.amount, simulateOnly, opts);
    return { ok: r.ok, message: r.message };
  }
  // Sized in exact raw units, the same way the quote was, so what the card
  // showed is what leaves. (The percent argument is unused when `amountRaw`
  // is given; 100 is passed so a stale reader sees a harmless value.)
  const s = await sellSize(chain, leg.token, draft.amount);
  if ('error' in s) return { ok: false, message: s.error };
  const r = await evmRail.sell(chain, leg.token, 100, simulateOnly, { ...opts, amountRaw: s.amountRaw });
  return { ok: r.ok, message: r.message };
}

/** Price a swap. Touches no key and builds nothing that could be signed. */
export async function quote(draft: SwapDraft, deps: SwapDeps): Promise<SwapQuoteResult> {
  if (isEvm(draft.chain)) {
    const problems = swapProblems(draft, null);
    if (problems.length) return { ok: false, message: problems[0]! };
    return quoteEvm(draft, draft.chain);
  }
  const owner = wallet.publicKey();
  if (!owner) return { ok: false, message: 'No active wallet.' };
  const problems = swapProblems(draft, null);
  if (problems.length) return { ok: false, message: problems[0]! };

  const inDecimals = await decimalsOf(deps.httpUrl, draft.inputMint);
  if (inDecimals === null) return { ok: false, message: 'That input mint could not be read from the chain.' };
  const outDecimals = await decimalsOf(deps.httpUrl, draft.outputMint);
  if (outDecimals === null) return { ok: false, message: 'That output mint could not be read from the chain.' };

  const inRaw = toRaw(draft.amount, inDecimals);
  if (inRaw <= 0n) return { ok: false, message: 'That amount rounds to zero at this token’s precision.' };

  const priority = await priorityBySpeed(deps.httpUrl, draft.inputMint, draft.outputMint);
  const built = await buildPairSwap({
    publicKey: owner,
    inputMint: draft.inputMint,
    outputMint: draft.outputMint,
    amountRaw: inRaw,
    slippagePct: draft.slippagePct,
    priorityFeeSol: priority.bySpeed[draft.speed] / LAMPORTS_PER_SOL,
  });
  if (!built.ok || !built.outAmount) return { ok: false, message: built.message };

  const fee = await feeFor(draft.inputMint, draft.outputMint, inRaw, built.solValueLamports);
  // The same rate the execution below charges: a $KRYPTO holder pays half
  // (shared/krypto.ts). Found 2026-09-20: this path had never asked about the
  // holding, so the card said "waived" over a quote that was priced in full.
  const split = splitFee(fee.lamports, false, holderFeeBps(FEE_BPS, holderRateApplies(kryptoUsableTokens())));
  return {
    ok: true,
    message: built.message,
    quote: {
      inputMint: draft.inputMint,
      outputMint: draft.outputMint,
      inAmountRaw: inRaw.toString(),
      outAmountRaw: built.outAmount,
      inDecimals,
      outDecimals,
      route: built.route ?? [],
      priceImpactPct: null,
      feeLamports: split.totalLamports,
      feeBasis: fee.basis,
      feeNative: null,
      // What the Jupiter quote carries: whole basis points, at least one.
      appliedSlippagePct: Math.max(1, Math.min(5_000, Math.round(draft.slippagePct * 100))) / 100,
      priorityLamports: priority.bySpeed[draft.speed],
      priorityBySpeed: priority.bySpeed,
      prioritySource: priority.source,
    },
  };
}

export interface SwapResult {
  ok: boolean;
  message: string;
  signature?: string;
  outAmountRaw?: string;
}

/**
 * Build, fee, simulate, sign, send.
 *
 * `simulateOnly` runs everything up to the broadcast — the chain executes the
 * swap against current state and reports what it would do, and nothing is
 * sent. The card uses it so a user sees a real answer before committing.
 */
/**
 * `walletId` (2026-09-23): swap from one of the user's OTHER wallets — how
 * USDC callout rewards paid to an account's own wallet get turned into SOL
 * without first making that wallet the main one. Solana only. It changes
 * WHO signs and nothing else: the same policy, the same program gate, the
 * same simulation, loss guard and receipt check, and the same fee.
 */
export async function execute(draft: SwapDraft, deps: SwapDeps, simulateOnly: boolean, walletId?: string): Promise<SwapResult> {
  if (isEvm(draft.chain)) {
    if (walletId) return { ok: false, message: 'Swapping from another wallet is Solana only.' };
    const problems = swapProblems(draft, null);
    if (problems.length) return { ok: false, message: problems[0]! };
    return executeEvm(draft, draft.chain, simulateOnly);
  }
  const owner = walletId ? wallet.publicKeyOf(walletId) : wallet.publicKey();
  if (!owner) return { ok: false, message: walletId ? 'No such wallet.' : 'No active wallet.' };
  if (!simulateOnly && !deps.live) {
    return { ok: false, message: 'Switch to Live and arm the engine to swap — a swap in Paper is nothing. Nothing was sent.' };
  }

  const inDecimals = await decimalsOf(deps.httpUrl, draft.inputMint);
  if (inDecimals === null) return { ok: false, message: 'That input mint could not be read from the chain.' };
  let inRaw = toRaw(draft.amount, inDecimals);

  // Re-checked in MAIN against what the wallet actually holds, not against
  // what the card believed when it drew the button.
  const held = await heldRaw(deps.httpUrl, owner, draft.inputMint);
  const heldAmount = held && inDecimals !== null ? fromRaw(held.raw.toString(), inDecimals) : null;
  const problems = swapProblems(draft, heldAmount);
  if (problems.length) return { ok: false, message: problems[0]! };
  // "Max" travels as a Number, which above 2^53 base units cannot name the
  // holding exactly: the card's whole-balance amount came back a few base
  // units OVER and the chain refused the swap. A request within a billionth
  // of the holding IS the holding — clamped down to it, never up. Found by
  // audit 2026-09-11 (first overshoot at 9,007,199.25 tokens of 9 decimals).
  if (held && inRaw > held.raw && (inRaw - held.raw) * 1_000_000_000n <= held.raw) inRaw = held.raw;

  const priority = await priorityBySpeed(deps.httpUrl, draft.inputMint, draft.outputMint);
  const built = await buildPairSwap({
    publicKey: owner,
    inputMint: draft.inputMint,
    outputMint: draft.outputMint,
    amountRaw: inRaw,
    slippagePct: draft.slippagePct,
    priorityFeeSol: priority.bySpeed[draft.speed] / LAMPORTS_PER_SOL,
  });
  if (!built.ok || !built.tx) return { ok: false, message: built.message };

  // ── the platform fee ────────────────────────────────────────────────
  const fee = await feeFor(draft.inputMint, draft.outputMint, inRaw, built.solValueLamports);
  const treasury = treasuryIntegrity().treasury;
  const referrer = deps.referrer.trim();
  const hasReferrer = looksLikeSolAddress(referrer) && referrer !== treasury && referrer !== owner && !!treasury;
  const split = treasury && fee.lamports > 0 ? splitFee(fee.lamports, hasReferrer, holderFeeBps(FEE_BPS, holderRateApplies(kryptoUsableTokens()))) : { totalLamports: 0, treasuryLamports: 0, referrerLamports: 0 };

  // A referrer was named and refused (not an address, the treasury, or this
  // very wallet). The whole fee goes to the treasury, which is correct, but
  // saying nothing looks exactly like a working referral — see liveSigner.
  if (referrer && !hasReferrer) {
    logger.warn(
      `swap: referrer ignored (${!looksLikeSolAddress(referrer) ? 'not a Solana address' : referrer === owner ? 'it is this wallet' : 'it is the fee address'})`,
    );
  }

  let tx = built.tx;
  const planned: PlannedTransfer[] = [];
  if (split.totalLamports > 0 && treasury) {
    // Rent FIRST, size second. A sub-rent transfer to an empty wallet reverts
    // the whole transaction (InsufficientFundsForRent), so it has to be gone
    // before the size fit ever sees it. This path skipped the guard entirely
    // until 2026-09-21: a referral cut to a brand-new referrer wallet could
    // revert a swap, which is the one thing a fee must never do.
    const wanted = [{ to: treasury, lamports: split.treasuryLamports }];
    if (split.referrerLamports > 0) wanted.push({ to: referrer, lamports: split.referrerLamports });
    const safe = await rentSafeTransfers(wanted, deps.httpUrl);
    if (safe.length === 0) logger.warn('swap: fee skipped — every recipient is below rent-exemption');
    else if (split.referrerLamports > 0 && !safe.some((t) => t.to === referrer)) {
      logger.warn('swap: referrer not paid — their wallet is below rent-exemption, paying it would revert the swap');
    }
    for (const t of safe) planned.push({ ...t, priority: t.to === treasury ? 0 : 1 });
  }
  if (planned.length > 0) {
    const fit = await injectTransfersFit(tx, owner, planned, deps.httpUrl);
    // A fee that will not fit is dropped, never allowed to fail the swap.
    if (fit) {
      tx = fit.tx;
      if (fit.dropped.length) {
        logger.warn(`swap: ${fit.dropped.length} fee transfer(s) dropped to fit the transaction — that share is not paid`);
      }
    } else logger.warn('swap: platform fee could not be attached — swapping without it');
  }

  const policy = {
    intent: 'trade' as const,
    // A swap is a SELL of the input mint. See the header: this is what makes
    // the existing token rules cover it exactly, with nothing widened.
    trade: { side: 'sell' as const, mint: draft.inputMint },
    // No tips, so the only bare SOL leaving is the fee plus whatever rent the
    // route pays to open an output token account.
    maxTransferLamports: MAX_RENT_ALLOWANCE_LAMPORTS,
    feeAllowance:
      split.totalLamports > 0 && treasury
        ? [
            { address: activeTreasury(), maxLamports: split.treasuryLamports },
            ...(split.referrerLamports > 0 ? [{ address: referrer, maxLamports: split.referrerLamports }] : []),
          ]
        : undefined,
  };

  // ── The program gate ────────────────────────────────────────────────
  //
  // Added 2026-09-11 after the bridge swarm found this missing here. The
  // signing policy inspects top-level instructions and guards our TOKEN
  // accounts, but it does not stop an unrecognised program that has been
  // handed the wallet's own system account — writable, and a signer — from
  // moving SOL by CPI, because a CPI is not a top-level instruction. The loss
  // bound below measures magnitude and is blind to destination: a route that
  // sends exactly the amount being swapped, to somebody else, passes it.
  //
  // This sees TOP-LEVEL programs only. The venue itself runs as a CPI under
  // Jupiter's program and is invisible here; what restricts the venue is
  // the `dexes` list sent with the quote, and buildRoute refuses to quote
  // without it. The two together are the gate; neither alone is.
  const unknown = unknownTopLevelPrograms(VersionedTransaction.deserialize(tx), KNOWN_TRADE_PROGRAMS);
  if (unknown.length > 0) {
    // An ERROR, not a warning: the route came back running something this app
    // does not recognise, which is either a venue we should add deliberately
    // or a response that should not be trusted. Either way somebody needs to
    // look at it, so it goes on the live log and not just into a toast.
    logger.error(`swap refused: route runs unknown program(s) ${unknown.join(', ')}`);
    return {
      ok: false,
      message: `Refusing: this route runs ${unknown.length > 1 ? 'programs' : 'a program'} this app does not know (${unknown.map((p) => p.slice(0, 12)).join(', ')}). Nothing was sent.`,
    };
  }

  const signed = walletId ? wallet.signVersionedTransactionForWallet(walletId, tx, policy) : wallet.signVersionedTransaction(tx, policy);
  if (!signed.ok || !signed.signed) return { ok: false, message: signed.message };
  const base64 = Buffer.from(signed.signed).toString('base64');

  // Simulate the SIGNED bytes, and bound the loss: a swap must never cost
  // more SOL than its fee, its rent and the network's own charge.
  //
  // The output side is watched too — the token account(s) the swap should
  // fill, under either token program — so a route that spends the input and
  // delivers to somebody else is caught. The SOL guard alone is blind to
  // that: it bounds what leaves, not where the proceeds go. Found by audit
  // 2026-09-11 (the trade path had this check; the swap did not).
  const outIsSol = draft.outputMint === WSOL_MINT;
  const outAtas = outIsSol ? [] : [ataFor(owner, draft.outputMint, TOKEN_PROGRAM), ataFor(owner, draft.outputMint, TOKEN_2022_PROGRAM)];
  // Read at the commitment the simulation runs at, so a transaction landing
  // between the two reads does not skew the guard.
  const before = await getBalance(deps.httpUrl, owner, 'processed');
  const outBefore = outIsSol ? { ok: true as const, raw: 0n } : await outputHeld(deps.httpUrl, owner, draft.outputMint);
  const sim = await simulateTransaction(deps.httpUrl, base64, [owner, ...outAtas]);
  if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the swap: ${sim.message}` };
  if (sim.data.err) {
    const why = anchorReason(sim.data.logs) ?? JSON.stringify(sim.data.err);
    logger.warn(`swap refused by the chain: ${why}`);
    return { ok: false, message: `The chain refused this swap: ${why}. Nothing was sent.` };
  }
  const post = sim.data.postLamports[0];
  // A guard that cannot read its numbers refuses. Until 2026-09-11 a failed
  // balance read (a 429, an RPC that omitted the account) skipped the whole
  // check and the swap went on to broadcast — the trade path refused in the
  // same case; this one did not. Found by audit.
  if (!before.ok || before.data === undefined || typeof post !== 'number') {
    const why = !before.ok ? ` (${before.message})` : '';
    return { ok: false, message: `Could not read the balance for the loss guard${why} — nothing was sent.` };
  }
  if (!outBefore.ok) return { ok: false, message: `Could not read what you hold of the output token before the swap — nothing was sent.` };
  {
    const spentLamports = before.data - post;
    // Selling INTO SOL raises the balance, which is fine; the bound only
    // catches SOL going the wrong way by more than this swap can justify.
    // The priority ceiling the user picked is part of what this swap may
    // legitimately cost, so the bound has to include it — otherwise Fast
    // would refuse itself on a congested chain.
    const allowed =
      split.totalLamports +
      MAX_RENT_ALLOWANCE_LAMPORTS +
      priority.bySpeed[draft.speed] +
      (draft.inputMint === WSOL_MINT ? Number(inRaw) : 0);
    if (spentLamports > allowed) {
      // The loss guard firing is the single most important line this module
      // can produce: the simulation said this swap would spend more than it
      // should. Never let that be invisible.
      logger.error(
        `swap refused by the loss guard: simulation spends ${spentLamports} lamports, allowed ${allowed} — nothing was sent`,
      );
      return {
        ok: false,
        message: `Refusing: the simulation spends ${(spentLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL, more than this swap should cost. Nothing was sent.`,
      };
    }
    // ── The receipt: what the quote promised at minimum must ARRIVE ──
    const threshold = BigInt(built.otherAmountThreshold || '0');
    if (outIsSol) {
      // Proceeds land as SOL. The balance must rise by at least the quote's
      // floor less what this swap legitimately costs. Dust is not checked —
      // a limit never blocks an exit — the floor is 0.02 SOL, as the trade
      // path's is.
      const RECEIPT_FLOOR = 20_000_000n;
      if (threshold >= RECEIPT_FLOOR) {
        const gain = BigInt(post - before.data);
        const costs = BigInt(split.totalLamports + MAX_RENT_ALLOWANCE_LAMPORTS + priority.bySpeed[draft.speed]);
        if (gain + costs < threshold) {
          logger.error(`swap refused by the receipt check: expected at least ${threshold} lamports to arrive, balance moves ${gain}`);
          return { ok: false, message: 'Refusing: the simulation does not deliver the SOL this swap should pay out — the proceeds are not arriving in this wallet. Nothing was sent.' };
        }
      }
    } else {
      const outAfter = tokenAmount(sim.data.postData[1] ?? null) + tokenAmount(sim.data.postData[2] ?? null);
      const received = outAfter - outBefore.raw;
      if (received < threshold) {
        logger.error(`swap refused by the receipt check: expected at least ${threshold} base units to arrive, simulation delivers ${received}`);
        return { ok: false, message: 'Refusing: the simulation delivers less of the output token than the quote\'s minimum — the proceeds are not arriving in this wallet. Nothing was sent.' };
      }
    }
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this swap.', outAmountRaw: built.outAmount };

  const sig = bs58Signature(signed.signed);
  const sent = await broadcastAndConfirm({
    httpUrl: deps.httpUrl,
    base64,
    signature: sig,
    // One lane. Tips buy position in a block, and a user pressing Swap is not
    // racing anybody — paying for priority here would be a fee with nothing
    // on the other side of it.
    lanes: ['rpc'],
    lastValidBlockHeight: built.lastValidBlockHeight,
  });
  if (!sent.landed) {
    return {
      ok: false,
      message: sent.expired
        ? 'The swap expired before it confirmed. Nothing moved; try again.'
        : `Sent but not confirmed — check ${sig.slice(0, 12)} on chain before retrying.`,
      signature: sig,
    };
  }
  if (sent.chainErr) return { ok: false, message: 'The swap failed on chain — nothing moved.', signature: sig };
  logger.info(`swap: ${draft.amount} of ${draft.inputMint.slice(0, 8)} → ${draft.outputMint.slice(0, 8)} as ${sig}`);
  return { ok: true, message: 'Swapped.', signature: sig, outAmountRaw: built.outAmount };
}

/** The signature of a signed transaction, base58 — what an explorer wants. */
function bs58Signature(signedTx: Uint8Array): string {
  try {
    const tx = VersionedTransaction.deserialize(signedTx);
    const sig = tx.signatures[0];
    return sig ? new PublicKey(sig).toBase58() : '';
  } catch {
    return '';
  }
}
