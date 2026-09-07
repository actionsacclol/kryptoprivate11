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
//   5. dust is ignored.

import { resolveAccountKeys, type RawTransaction, type TokenBalanceEntry } from './rpcClient';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1_000_000_000;
/** Below this the "swap" is rent, a fee or a rounding artefact. */
const MIN_SOL = 0.0005;

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
  /** Top-level programs the transaction invoked, for the record ("via …"). */
  programs: string[];
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

  const sol = Math.abs(solDelta);
  const tokens = Math.abs(best.tokens);
  const priceSol = sol / tokens;
  if (!Number.isFinite(priceSol) || priceSol <= 0) return null;

  const programs = [...new Set((tx.transaction.message.instructions ?? []).map((ix) => keys[ix.programIdIndex]).filter(Boolean))];
  return { mint: best.mint, isBuy, sol, tokens, decimals: best.decimals, priceSol, programs };
}
