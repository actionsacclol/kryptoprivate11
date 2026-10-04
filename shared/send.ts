// Send — move coins or tokens from a wallet to any address (2026-10-03).
//
// The owner, after a withdrawal went to an old saved address: "we should also
// add a sending section … so its not a cached withdrawl address. so its easy
// to send like a phantom wallet". Withdraw (the saved address, which profit
// sweeps also use) stays; Send is the everyday "pay this address" button.
//
// The page only ever ASKS. Main re-reads every balance, builds the
// transaction, shows a NATIVE confirmation with the exact address and amount,
// and only then can the signer sign — see ApprovedSend in signPolicy.ts and
// tokenTransfer in evm/policy.ts. Krypt takes no fee on a send.

import { isChainKind, type ChainKind } from './chainKind';

export type SendChain = ChainKind;

export interface SendRequest {
  chain: SendChain;
  /** The recipient's WALLET address (never a token account). */
  to: string;
  /** null = the chain's own coin (SOL / ETH / BNB); else a mint / token contract. */
  token: string | null;
  /** A decimal amount in the coin's own units, or 'max'. */
  amount: string;
}

export interface SendReview {
  chain: SendChain;
  from: string;
  to: string;
  token: string | null;
  symbol: string;
  decimals: number;
  /** Base units, as a decimal string (u64/u256-safe). */
  amountRaw: string;
  /** "0.05 SOL" — what arrives (before any token's own transfer fee). */
  amountText: string;
  /** The network fee, roughly, in the chain's coin. Null when unknown. */
  networkFeeText: string | null;
  /** A one-off cost on top, e.g. opening the recipient's token account. */
  extraCostText: string | null;
  /** Things worth reading before pressing Send; never blocking on their own. */
  warnings: string[];
  /** The name the user saved this exact address under, if any. */
  contactLabel?: string | null;
}

export interface SendResult {
  ok: boolean;
  message: string;
  /** Signature / hash once one exists — even on a failure after broadcast. */
  txid: string | null;
  explorerUrl: string | null;
}

/** Validate an IPC payload. Null when it is not a send request at all. */
export function sendRequestOf(raw: unknown): SendRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isChainKind(o.chain)) return null;
  if (typeof o.to !== 'string' || o.to.length > 100) return null;
  if (o.token !== null && (typeof o.token !== 'string' || o.token.length > 100)) return null;
  if (typeof o.amount !== 'string' || o.amount.length > 60) return null;
  return { chain: o.chain, to: o.to.trim(), token: o.token === null ? null : o.token.trim(), amount: o.amount.trim() };
}

/**
 * "1.5" → 1500000 at 6 decimals. Exact (no floating point): a send moves
 * exactly what was typed or is refused. Null for anything that is not a plain
 * positive decimal, or that has more fraction digits than the coin has.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  // A comma is ambiguous — "0,05" is 0.05 in half the app's languages and
  // "1,000" is a thousand in the other half. Stripping it multiplied amounts
  // 10–100× (swarm 2026-10-03). The fields turn a typed comma into a dot;
  // one that still arrives here is refused, never guessed.
  if (text.includes(',')) return null;
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return null;
  const raw = BigInt((whole || '0') + frac.padEnd(decimals, '0'));
  return raw > 0n ? raw : null;
}

/** 1500000 at 6 decimals → "1.5"; trims trailing zeros, keeps `maxFrac`. */
export function formatUnits(raw: bigint, decimals: number, maxFrac = 9): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = decimals > 0 ? (v % base).toString().padStart(decimals, '0').slice(0, maxFrac) : '';
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

export const SOLANA_EXPLORER_TX = 'https://solscan.io/tx/';
