// Relay (api.relay.link), called directly — the All-in-One wallet's
// conversions and the Bridge (2026-10-01).
//
// Pure: shapes, the checks a signer needs, the fee split and the status map.
// The HTTP calls are electron/engine/relay.ts; signing is bridge.ts.
//
// EVERY CONSTANT BELOW WAS READ OFF A REAL QUOTE (2026-10-01, all six routes
// between Solana, BNB and Robinhood, plus EXACT_OUTPUT and appFees). A quote
// whose transaction differs from them is refused — a program id or contract
// the API supplies is attacker data, the same rule bridge.ts applies to
// LI.FI. What was measured:
//
//   Solana source — ONE instruction to the depository 99vQwt…, five keys:
//     config Dodg2H… (ro), the sender (signer, writable), the sender again
//     (ro: the depositor), vault 7uTT8X… (writable), System; data =
//     DepositNative discriminator 0d9e0ddf5fd51c06 + amount u64 LE + a 32-byte
//     commitment; one lookup table Hm9fUgcn… (the same table and accounts
//     this app already pinned for LI.FI's Relay route on 2026-09-11).
//
//   EVM source (BNB and Robinhood alike) — a call to 0x4cd00e…bc31 with
//     value = the amount and calldata depositNative(address depositor,
//     bytes32 id): selector 0x49290c1c, our address, a commitment.
//
// THE DESTINATION IS NOT IN EITHER. On both sides the far end — recipient,
// chain, amount — is bound only by Relay's request, behind a hash. So every
// Relay transfer is 'trusted' (shared/bridge.ts DestinationAssurance): this
// app proves how much leaves and where it goes on THIS chain, and that the
// request it asked for names its own address; it cannot prove what Relay
// will deliver. After the fact it checks: Relay's status must name our own
// deposit transaction.

import type { BridgeChain, BridgeStatus } from './bridge';

/** Relay's chain ids. Solana's is Relay's own number, not an EVM id. */
export const RELAY_CHAIN_ID: Record<BridgeChain, number> = {
  solana: 792703809,
  bnb: 56,
  robinhood: 4663,
};

/** What Relay calls each chain's native coin. */
export const RELAY_NATIVE: Record<BridgeChain, string> = {
  solana: '11111111111111111111111111111111',
  bnb: '0x0000000000000000000000000000000000000000',
  robinhood: '0x0000000000000000000000000000000000000000',
};

export const RELAY_SOLANA_DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const RELAY_SOLANA_CONFIG = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc';
export const RELAY_SOLANA_VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
export const RELAY_SOLANA_TABLE = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP';
export const RELAY_DEPOSIT_NATIVE_DISC = '0d9e0ddf5fd51c06';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export const RELAY_EVM_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const RELAY_EVM_DEPOSIT_SELECTOR = '0x49290c1c';

export interface RelayAppFee {
  /** Must be an EVM address — Relay accrues app fees as USDC to it. */
  recipient: string;
  /** Basis points, as a string. */
  fee: string;
}

export interface RelayQuoteRequest {
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  /** Base units: of the origin coin for EXACT_INPUT, of the destination coin for EXACT_OUTPUT. */
  amount: string;
  tradeType: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  appFees?: RelayAppFee[];
  /**
   * Where a refund goes on the ORIGIN chain if Relay cannot fill. Always
   * our own sending address. Relay's docs disagree with themselves (the
   * refunds page: without it "automatic refund is disabled"; the quote
   * schema: it falls back to the user) — so it is never left to the fallback.
   */
  refundTo: string;
}

export interface RelaySolanaIx {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  /** Instruction data, hex. */
  data: string;
}

export interface RelayQuote {
  requestId: string;
  solana: { instructions: RelaySolanaIx[]; lookupTables: string[] } | null;
  evm: { to: string; data: string; value: string; chainId: number } | null;
  amountInRaw: string;
  amountOutRaw: string;
  minOutRaw: string;
  outDecimals: number;
  inUsd: number | null;
  outUsd: number | null;
  timeEstimateSec: number | null;
  relayerFeeUsd: number | null;
  appFeeUsd: number | null;
  /** What Relay says the request delivers, and to whom — read from the
   *  quote's own details. The deposit bytes do not bind any of it, so these
   *  are checked against what was asked (`destinationProblem`): a mis-routed
   *  answer must never reach the signer. */
  recipient: string | null;
  outChainId: number | null;
  outCurrency: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const rawInt = (v: unknown): string | null => (typeof v === 'string' && /^\d+$/.test(v) ? v : null);

/**
 * Relay's answer, or why it is not one this app signs for. Exactly one step,
 * a `deposit` of kind `transaction`, with exactly one item — the only shape
 * measured. More steps (an approval, a signature) means a route nobody has
 * looked at.
 */
export function parseRelayQuote(raw: unknown): { ok: true; quote: RelayQuote } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'Relay returned nothing readable' };
  const j = raw as Record<string, any>;
  const steps = Array.isArray(j.steps) ? j.steps : null;
  if (!steps || steps.length !== 1) return { ok: false, why: `Relay returned ${steps?.length ?? 0} steps; this app signs only a single deposit` };
  const step = steps[0];
  if (step?.id !== 'deposit' || step?.kind !== 'transaction') return { ok: false, why: `Relay asked for a "${step?.id}" step this app has not measured` };
  if (!Array.isArray(step.items) || step.items.length !== 1) return { ok: false, why: 'Relay returned a deposit with more than one transaction' };
  const requestId = typeof step.requestId === 'string' && /^0x[0-9a-f]{64}$/i.test(step.requestId) ? step.requestId : null;
  if (!requestId) return { ok: false, why: 'Relay returned no request id' };
  const d = step.items[0]?.data ?? {};

  let solana: RelayQuote['solana'] = null;
  let evm: RelayQuote['evm'] = null;
  if (Array.isArray(d.instructions)) {
    const instructions: RelaySolanaIx[] = [];
    for (const ix of d.instructions) {
      if (typeof ix?.programId !== 'string' || !Array.isArray(ix.keys) || typeof ix.data !== 'string' || !/^[0-9a-f]*$/i.test(ix.data)) {
        return { ok: false, why: 'Relay returned a Solana instruction this app cannot read' };
      }
      instructions.push({
        programId: ix.programId,
        keys: ix.keys.map((k: any) => ({ pubkey: String(k?.pubkey ?? ''), isSigner: k?.isSigner === true, isWritable: k?.isWritable === true })),
        data: ix.data.toLowerCase(),
      });
    }
    const tables = Array.isArray(d.addressLookupTableAddresses) ? d.addressLookupTableAddresses.filter((t: unknown) => typeof t === 'string') : [];
    solana = { instructions, lookupTables: tables };
  } else if (typeof d.to === 'string' && typeof d.data === 'string') {
    const value = rawInt(typeof d.value === 'number' ? String(d.value) : d.value);
    const chainId = num(d.chainId);
    if (value === null || chainId === null) return { ok: false, why: 'Relay returned a transaction without a value or chain' };
    evm = { to: d.to.toLowerCase(), data: d.data.toLowerCase(), value, chainId };
  } else {
    return { ok: false, why: 'Relay returned a transaction of a kind this app has not measured' };
  }

  const det = j.details ?? {};
  const fees = j.fees ?? {};
  const amountInRaw = rawInt(det.currencyIn?.amount);
  const amountOutRaw = rawInt(det.currencyOut?.amount);
  const minOutRaw = rawInt(det.currencyOut?.minimumAmount);
  const outDecimals = num(det.currencyOut?.currency?.decimals);
  if (!amountInRaw || !amountOutRaw || !minOutRaw || outDecimals === null) return { ok: false, why: 'Relay returned a quote without its amounts' };
  return {
    ok: true,
    quote: {
      requestId,
      solana,
      evm,
      amountInRaw,
      amountOutRaw,
      minOutRaw,
      outDecimals,
      inUsd: num(det.currencyIn?.amountUsd),
      outUsd: num(det.currencyOut?.amountUsd),
      timeEstimateSec: num(det.timeEstimate),
      relayerFeeUsd: num(fees.relayer?.amountUsd),
      appFeeUsd: num(fees.app?.amountUsd),
      recipient: typeof det.recipient === 'string' ? det.recipient : null,
      outChainId: num(det.currencyOut?.currency?.chainId),
      outCurrency: typeof det.currencyOut?.currency?.address === 'string' ? det.currencyOut.currency.address : null,
    },
  };
}

/**
 * Why Relay's quote does not describe the transfer that was asked for, or
 * null: our own address on the destination, on the destination chain, in
 * its native coin. EVM addresses compare case-blind; a Solana address is
 * case-sensitive base58 and compares exactly. Catches an API that routed
 * the request somewhere else — not a malicious API, which could lie here
 * too (that is what 'trusted' means).
 */
export function destinationProblem(q: RelayQuote, to: BridgeChain, toAddress: string): string | null {
  const same = (a: string | null, b: string): boolean =>
    a !== null && (to === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());
  if (!same(q.recipient, toAddress)) return `Relay's request delivers to ${q.recipient ?? 'nobody it names'}, not your address`;
  if (q.outChainId !== RELAY_CHAIN_ID[to]) return `Relay's request delivers on chain ${q.outChainId ?? '?'}, not ${to}`;
  if (!same(q.outCurrency, RELAY_NATIVE[to])) return `Relay's request delivers ${q.outCurrency ?? 'an unnamed token'}, not ${to}'s native coin`;
  return null;
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);

function u64le(bytes: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

/**
 * Why this Solana deposit may NOT be signed, or null. The instruction must
 * be the measured one exactly: the pinned program, the pinned accounts in
 * their pinned roles, our own wallet as the only signer, and a deposit of
 * exactly `amountRaw` lamports.
 */
export function solanaDepositProblem(q: RelayQuote, owner: string, amountRaw: string): string | null {
  if (!q.solana) return 'no Solana transaction in the quote';
  const { instructions, lookupTables } = q.solana;
  if (instructions.length !== 1) return `Relay sent ${instructions.length} instructions; the measured deposit is one`;
  const ix = instructions[0];
  if (ix.programId !== RELAY_SOLANA_DEPOSITORY) return `the deposit goes to ${ix.programId.slice(0, 8)}…, not Relay's depository`;
  const want = [
    { pubkey: RELAY_SOLANA_CONFIG, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: RELAY_SOLANA_VAULT, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ];
  if (ix.keys.length !== want.length) return `the deposit names ${ix.keys.length} accounts, not the measured ${want.length}`;
  for (let i = 0; i < want.length; i++) {
    const k = ix.keys[i];
    const w = want[i];
    if (k.pubkey !== w.pubkey || k.isSigner !== w.isSigner || k.isWritable !== w.isWritable) {
      return `account ${i + 1} of the deposit is ${k.pubkey.slice(0, 8)}… (${k.isSigner ? 'signer' : ''}${k.isWritable ? ' writable' : ''}) — not the measured one`;
    }
  }
  if (!ix.data.startsWith(RELAY_DEPOSIT_NATIVE_DISC)) return 'the instruction is not DepositNative';
  const data = hexToBytes(ix.data);
  if (data.length !== 48) return `the deposit data is ${data.length} bytes, not the measured 48`;
  const amount = u64le(data, 8);
  if (amount !== BigInt(amountRaw)) return `the deposit moves ${amount} lamports, not the ${amountRaw} asked for`;
  if (lookupTables.some((t) => t !== RELAY_SOLANA_TABLE)) return 'the deposit uses a lookup table this app has not measured';
  return null;
}

/**
 * Why this EVM deposit may NOT be signed, or null: the pinned contract, the
 * measured selector, OUR address as the depositor, exactly `amountRaw` wei,
 * on `chainId`.
 */
export function evmDepositProblem(q: RelayQuote, owner: string, amountRaw: string, chainId: number): string | null {
  if (!q.evm) return 'no EVM transaction in the quote';
  const { to, data, value } = q.evm;
  if (q.evm.chainId !== chainId) return `the transaction is for chain ${q.evm.chainId}, not ${chainId}`;
  if (to !== RELAY_EVM_DEPOSITORY) return `it calls ${to}, not Relay's depository`;
  if (!data.startsWith(RELAY_EVM_DEPOSIT_SELECTOR)) return 'it is not depositNative';
  if (data.length !== 2 + 8 + 64 * 2) return 'the calldata is not the measured depositNative(address, bytes32)';
  const depositor = `0x${data.slice(10 + 24, 10 + 64)}`;
  if (!/^0{24}$/.test(data.slice(10, 10 + 24))) return 'the depositor word is malformed';
  if (depositor !== owner.toLowerCase()) return `the depositor is ${depositor}, not your address`;
  if (BigInt(value) !== BigInt(amountRaw)) return `it sends ${value} wei, not the ${amountRaw} asked for`;
  return null;
}

/** Relay's status, in the Bridge's words. */
export function bridgeStatusOfRelay(status: unknown): BridgeStatus {
  switch (status) {
    case 'success':
      return 'done';
    case 'refund':
    case 'refunded':
      return 'refunded';
    case 'failure':
      return 'failed';
    case 'waiting':
    case 'pending':
    case 'delayed':
    case 'submitted':
      return 'pending';
    default:
      return 'unknown';
  }
}

/**
 * Relay's free-text reason, made safe to show: it reaches an OS notification,
 * the bot pushes, the record and the log. No control or bidi characters (they
 * can reorder what a notification appears to say), no links, one line, short.
 */
export function cleanRelayReason(raw: string): string | null {
  const t = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link removed]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}
