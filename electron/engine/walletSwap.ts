// A followed wallet's swap, read from its own balance deltas.
//
// Copy trading used to see a leader only on the pump.fun curve feed, so a
// wallet that trades through Jupiter into Raydium, Meteora or Orca was
// invisible — it was being "followed" and nothing ever happened
// (2026-09-06). Decoding every DEX's instruction layout is the wrong fix:
// there are dozens, they change, and the copier does not need to know HOW
// the swap happened. It needs to know that this wallet paid SOL and
// received a token, or the reverse, and at what price. That is fully
// determined by the transaction's pre/post balances for the wallet — the
// same source the ledger trusts for our own fills — and it is identical for
// every router and pool.
//
// Rules, each pinned by a test:
//   1. the wallet must have SIGNED the transaction — a transfer INTO it, an
//      airdrop or someone else's swap that merely touches it is not its trade;
//   2. a failed transaction is nothing;
//   3. SOL out + one token in = buy; one token out + SOL in = sell. Wrapped
//      SOL counts as SOL. The network fee is not part of the price;
//   4. token-for-token, or a move with no SOL leg, is not a copyable swap;
//   5. dust is ignored;
//   6. a BUY must be big enough to be a trade rather than a receipt.

import { resolveAccountKeys, type RawTransaction, type TokenBalanceEntry } from './rpcClient';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1_000_000_000;
/** Below this the "swap" is rent, a fee or a rounding artefact. */
const MIN_SOL = 0.0005;
/**
 * A BUY must clear this to be a trade at all (2026-09-09).
 *
 * The SOL a wallet spends creating one token account is 0.00203928 — above
 * MIN_SOL — so a claim, an LP or staking receipt, an NFT mint or a pump.fun
 * token creation decodes as "paid SOL, received a token", i.e. a buy. The
 * leader SIGNS those, so the signer rule does not catch them, and a copier
 * with `fixed` sizing then buys its full configured size of a token nobody
 * traded. A real buy is orders of magnitude larger than an account rent.
 *
 * This is a floor CHECK only — it is never subtracted from the reported
 * amount — and it does not apply to SELLS: an exit must never be missed.
 */
const MIN_BUY_SOL = 0.005;

export interface WalletSwap {
  mint: string;
  isBuy: boolean;
  /** SOL paid (buy) or received (sell), network fee excluded. */
  sol: number;
  /** Tokens received (buy) or sent (sell), UI units. */
  tokens: number;
  decimals: number;
  /** SOL per token at this fill. */
  priceSol: number;
  /** Tokens of `mint` the wallet held BEFORE this transaction, UI units. */
  heldBefore: number;
  /**
   * Sell only: the share of its holding the wallet sold, 0–1. This is what
   * a copier mirrors — "they sold 40 %" means "sell 40 % of ours", whatever
   * the two positions' sizes. Null on a buy, or when the pre-balance is
   * unknown (an old-format reply). Null is NOT "all of it": the copier
   * refuses to mirror a sell it cannot size and records the skip.
   */
  soldFraction: number | null;
  /** Top-level programs the transaction invoked, for the record ("via …"). */
  programs: string[];
}

/** Tokens of `mint` the wallet held before the transaction, UI units. */
function heldBeforeOf(pre: TokenBalanceEntry[] | undefined, wallet: string, mint: string): number {
  let raw = 0n;
  let decimals = 0;
  for (const e of pre ?? []) {
    if (e.owner !== wallet || e.mint !== mint) continue;
    try {
      raw += BigInt(e.uiTokenAmount.amount);
      decimals = e.uiTokenAmount.decimals;
    } catch {
      /* a malformed entry is not a balance */
    }
  }
  return Number(raw) / 10 ** decimals;
}

function tokenDeltas(
  pre: TokenBalanceEntry[] | undefined,
  post: TokenBalanceEntry[] | undefined,
  wallet: string,
): Map<string, { raw: bigint; decimals: number }> {
  const out = new Map<string, { raw: bigint; decimals: number }>();
  const add = (entries: TokenBalanceEntry[] | undefined, sign: 1n | -1n): void => {
    for (const e of entries ?? []) {
      // Entries without an owner are old-format replies; the wallet's own
      // accounts are the only ones that describe its trade.
      if (e.owner !== wallet) continue;
      let raw: bigint;
      try {
        raw = BigInt(e.uiTokenAmount.amount);
      } catch {
        continue;
      }
      const cur = out.get(e.mint) ?? { raw: 0n, decimals: e.uiTokenAmount.decimals };
      cur.raw += sign * raw;
      out.set(e.mint, cur);
    }
  };
  add(pre, -1n);
  add(post, 1n);
  return out;
}

/** The swap this transaction was for `wallet`, or null when it was not one. */
export function decodeWalletSwap(tx: RawTransaction, wallet: string): WalletSwap | null {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const keys = resolveAccountKeys(tx);
  const signers = Math.max(0, tx.transaction?.message?.header?.numRequiredSignatures ?? 0);
  const idx = keys.indexOf(wallet);
  if (idx < 0 || idx >= signers) return null;

  // SOL leg: the wallet's lamport delta, with the fee it paid put back (the
  // fee is a cost of the transaction, not part of the price), plus any
  // wrapped-SOL movement on its token accounts.
  const pre = meta.preBalances?.[idx];
  const post = meta.postBalances?.[idx];
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;
  const feePaid = idx === 0 && Number.isFinite(meta.fee) ? (meta.fee as number) : 0;
  let solDelta = ((post as number) - (pre as number) + feePaid) / LAMPORTS;

  const deltas = tokenDeltas(meta.preTokenBalances, meta.postTokenBalances, wallet);
  const wsol = deltas.get(WSOL_MINT);
  if (wsol) {
    solDelta += Number(wsol.raw) / LAMPORTS;
    deltas.delete(WSOL_MINT);
  }

  // The token leg: the mint that moved the most. A second mint moving
  // materially the other way is a token-for-token swap — not SOL-priced,
  // not copied.
  let best: { mint: string; tokens: number; decimals: number } | null = null;
  let second = 0;
  for (const [mint, d] of deltas) {
    const tokens = Number(d.raw) / 10 ** d.decimals;
    if (!Number.isFinite(tokens) || tokens === 0) continue;
    if (!best || Math.abs(tokens) > Math.abs(best.tokens)) {
      if (best) second = Math.max(second, Math.abs(best.tokens));
      best = { mint, tokens, decimals: d.decimals };
    } else {
      second = Math.max(second, Math.abs(tokens));
    }
  }
  if (!best) return null;
  if (Math.abs(solDelta) < MIN_SOL) return null;

  const isBuy = best.tokens > 0 && solDelta < 0;
  const isSell = best.tokens < 0 && solDelta > 0;
  if (!isBuy && !isSell) return null;
  // A material opposite move in another mint with a small SOL leg is a
  // token-for-token route where SOL was only the hop; skip it.
  if (second > 0 && Math.abs(solDelta) < MIN_SOL * 10) return null;
  // Rule 6: a buy under the floor is a receipt, not a trade. Checked, never
  // subtracted; sells are deliberately exempt.
  if (isBuy && Math.abs(solDelta) < MIN_BUY_SOL) return null;

  const sol = Math.abs(solDelta);
  const tokens = Math.abs(best.tokens);
  // A one-sided LIQUIDITY ADD looks exactly like a buy from balance deltas:
  // SOL leaves, one token arrives. That token is a position NFT — zero
  // decimals, quantity one — and it has no market. Copied live, the follower
  // would try to buy an untradeable mint, and `trackLeader` would open a
  // leader round trip that can never close.
  //
  // MIN_BUY_SOL does not catch it: its comment already names "an LP receipt",
  // but it only stops rent-sized amounts, and a real liquidity add is orders
  // of magnitude above the floor.
  //
  // Both directions. The WITHDRAW side matters too: pulling liquidity sends
  // the position NFT out and SOL in, which decodes as a SELL — and sells are
  // deliberately ungated so an exit is never missed. That exemption is about
  // real holdings; a follower cannot be holding the leader's position NFT, so
  // there is no exit here to miss, only a phantom one to mirror.
  //
  // The test is exactly "one indivisible unit", not "zero decimals": a real
  // 0-decimal token trade of any other size still decodes.
  if (best.decimals === 0 && tokens === 1) return null;
  const priceSol = sol / tokens;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;

  const programs = [...new Set((tx.transaction.message.instructions ?? []).map((ix) => keys[ix.programIdIndex]).filter(Boolean))];
  const heldBefore = heldBeforeOf(meta.preTokenBalances, wallet, best.mint);
  const soldFraction = isSell && heldBefore > 0 ? Math.min(1, tokens / heldBefore) : null;
  return { mint: best.mint, isBuy, sol, tokens, decimals: best.decimals, priceSol, heldBefore, soldFraction, programs };
}
