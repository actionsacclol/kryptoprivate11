// Bridging, end to end — quote, verify what can be verified, sign, send,
// and keep asking until the money lands.
//
// The two send paths are genuinely different and the difference is not
// cosmetic, so they are not forced into one shape:
//
//  · From an EVM chain we can CHECK the transaction. The target is a contract
//    address pinned in this file, the value must equal what the user asked to
//    send, and the recipient address appears in the calldata where we can find
//    it. All three were measured stable across independent quotes.
//
//  · From Solana we can check how much leaves and which program it leaves to,
//    and NOTHING about the far side. Measured: the destination address, the
//    destination chain, the expected amount and the minimum are none of them
//    present in the transaction — the far side rides on an opaque id that
//    changes between two identical quotes. So that leg is signed on trust,
//    and `assurance` says so all the way up to the screen.
//
// A route is only enabled once the thing it targets has been MEASURED. That is
// the launcher's BUILDER_VERIFIED pattern: a program id or contract address
// the quote supplies is attacker data, and a route we have not looked at is
// not a route this app signs for.

import { VersionedTransaction } from '@solana/web3.js';
import {
  assuranceOf,
  bridgeProblems,
  isEvmBridgeChain,
  routeId,
  sizeRefusal,
  type BridgeChain,
  type BridgeDraft,
  type BridgeQuote,
  type DestinationAssurance,
  type InFlight,
  STATUS_LABEL,
  LIFI_CHAIN_ID,
} from '@shared/bridge';
import * as wallet from '../system/wallet';
import * as evmWallet from '../evm/evmWallet';
import { logger } from '../system/logger';
import * as lifi from './lifi';
import * as store from './bridgeStore';
import { getAccountInfo, getBalance, getSignatureStatuses, isBlockhashValid, sendRawTransaction, simulateTransaction } from '../chain/rpcClient';
import { AddressLookupTableAccount, PublicKey, VersionedTransaction as VT } from '@solana/web3.js';
import { unknownBridgePrograms } from '../system/signPolicy';
import { anchorReason } from './liveSigner';
import { base58Decode, base58Encode } from '../chain/base58';
import { sendBuilt } from '../evm/trade';
import type { EvmPolicy } from '../evm/policy';
import type { Address, Hex } from 'viem';
import { CHAINS } from '../evm/chains';
import { client } from '../evm/client';

/**
 * LI.FI's contract, per chain, MEASURED 2026-09-11.
 *
 * There is no canonical address — 30 distinct ones across the chains LI.FI
 * serves, and Robinhood's is unique to it. The API will tell you the address,
 * but a contract address the API supplies is the same trust boundary as a
 * program id it supplies, so these are pinned and a mismatch refuses.
 */
/**
 * The Solana side of a route, as measured — every constant here is a byte
 * read off a real transaction, and a transaction that differs is refused.
 *
 * Relay (`relaydepository`), solana -> robinhood, 0.02 SOL, 2026-09-11:
 *   · one lookup table, `Hm9fUgcn…`, handing the depository its config
 *     (`Dodg2Hif…`, readonly) and its vault (`7uTT8Xi5…`, writable);
 *   · a bare transfer of 50,000 lamports to LI.FI's collector `34FKjAdV…`;
 *   · `DepositNative`, discriminator 0d9e0ddf5fd51c06, amount u64 LE at
 *     data offset 8 = fromAmount − the collector fee (19,950,000).
 * The table's authority is a plain keypair, so the table is resolved at
 * signing and its entries compared to these — resolution alone proves
 * nothing.
 */
const SOLANA_TOOLS: Record<string, { accounts: string[]; depositDisc: string }> = {
  relaydepository: {
    accounts: ['Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc', '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ'],
    depositDisc: '0d9e0ddf5fd51c06',
  },
};
/** LI.FI's integrator-fee collector on Solana, and the most it may take. */
const LIFI_FEE_COLLECTOR_SOL = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm';
/**
 * The most the collector may take: LI.FI's fee is PROPORTIONAL — 0.25 % of
 * the amount on every quote measured (50,000 lamports on 0.02 SOL,
 * 1,250,000 on 0.5 SOL). A flat ceiling sized from the small quote refused
 * every transfer above 0.2 SOL, live, on 2026-09-11. Twice the measured
 * rate, with a floor for amounts so small a fixed part could dominate.
 */
export function lifiFeeCeilingLamports(fromAmountRaw: string): number {
  const proportional = Number((BigInt(fromAmountRaw) * 50n) / 10_000n); // 0.5 %
  return Math.max(150_000, proportional);
}
const RELAY_DEPOSITORY = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Fees and rent a Solana transfer may cost beyond the amount: 0.001 SOL,
 *  about ten times the 97,226 lamports the measured transaction used. */
const SOLANA_COST_TOLERANCE_LAMPORTS = 1_000_000;
/** After this long, a signature the chain has never seen, on a blockhash
 *  that has expired, is a transaction that never landed. */
const SOLANA_DEAD_AFTER_MS = 3 * 60_000;

const LIFI_CONTRACT: Record<'robinhood' | 'bnb', string> = {
  bnb: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
  robinhood: '0xb477751b76cf82d00a686a1232f5fcd772414af3',
};

/**
 * Which routes this build has actually looked at.
 *
 * EVM sources are enabled by the pinned contract above. A SOLANA source needs
 * its bridge programs in signPolicy's BRIDGE_PROGRAMS, which means decoding a
 * real transaction for that route — done for Relay (solana to Robinhood) and
 * NOT yet for Mayan (solana to BNB). The unmeasured one refuses by name rather
 * than failing at the signer with something unreadable.
 */
export const ENABLED_ROUTES: ReadonlySet<string> = new Set<string>([
  'solana->robinhood',
  'robinhood->solana',
  'robinhood->bnb',
  'bnb->solana',
  'bnb->robinhood',
  // 'solana->bnb' — DECODED 2026-09-11, and deliberately still off.
  //
  // It is not a missing measurement any more. The route is Mayan, it needs
  // exactly ONE signature (so no collision with the app's strongest
  // invariant), and its programs are ComputeBudget, LI.FI's own
  // 3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br, System, Mayan's
  // D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa, and Jupiter — it swaps
  // before it bridges.
  //
  // What blocks it is that the transaction carries THREE address lookup
  // tables, and one of its System transfers — 750,000 lamports — sends to an
  // address that lives inside one of them. `checkBridge` refuses lookup
  // tables outright, because an account this signer cannot name is one it
  // cannot judge, and that transfer is exactly the case: we would be signing
  // a payment to an address we cannot read.
  //
  // The research swarm called this one in advance: relaxing the ALT refusal
  // to make a route work would be the actual loss event. So the route stays
  // off until the caller resolves the tables up front and passes the resolved
  // keys into the policy — `fetchAlt` in broadcast.ts already does the
  // resolving, so this is real work rather than a rewrite.
]);

export interface BridgeDeps {
  httpUrl: string;
}

/** Our own address on a chain — the only address a bridge may ever send to. */
function ownAddress(chain: BridgeChain): string | null {
  if (chain === 'solana') return wallet.publicKey();
  return evmWallet.address(chain);
}

function decimalsOf(chain: BridgeChain): number {
  return chain === 'solana' ? 9 : 18;
}

/** Human units to base units, through a string so no exponent is involved. */
function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const intDigits = Math.max(1, Math.floor(Math.log10(amount)) + 1);
  const places = Math.max(decimals, Math.min(20, 15 - intDigits));
  const [whole, frac = ''] = amount.toFixed(places).split('.');
  return BigInt(`${whole}${frac.slice(0, decimals).padEnd(decimals, '0')}` || '0');
}

export interface QuoteResult {
  ok: boolean;
  message: string;
  quote?: BridgeQuote;
  /** Present only on the way OUT — never persisted, never sent to the UI. */
  _raw?: lifi.LifiQuote;
}

/** The last quote per draft, so Check and Send act on what the page showed. */
const QUOTE_TTL_MS = 60_000;
const lastQuote = new Map<string, { at: number; quote: BridgeQuote; raw: lifi.LifiQuote; from: string; to: string }>();
const quoteKey = (d: BridgeDraft): string => `${d.from}>${d.to}:${d.amount}`;

/** Bridge events worth a desktop notification, injected by main. */
let notifier: ((title: string, body: string) => void) | null = null;
export function setNotifier(fn: (title: string, body: string) => void): void {
  notifier = fn;
}

/** Where the poll asks the Solana chain about its own signatures; injected by main. */
let depsProvider: (() => BridgeDeps) | null = null;
export function setDeps(fn: () => BridgeDeps): void {
  depsProvider = fn;
}

/**
 * Price one transfer.
 *
 * Expensive: it spends one of 75 tokens that refill over two hours, so the
 * caller quotes on demand and never on a timer.
 */
export async function quote(draft: BridgeDraft, deps: BridgeDeps): Promise<QuoteResult> {
  const from = ownAddress(draft.from);
  const to = ownAddress(draft.to);
  if (!from) return { ok: false, message: `No wallet on ${draft.from} to send from.` };
  if (!to) return { ok: false, message: `No wallet on ${draft.to} to receive.` };

  // What the source wallet holds, so "more than you hold" is said HERE —
  // before a quote token is spent and before the chain refuses the deposit
  // with a bare {"Custom":1}. Unknown stays unknown (null): an unreadable
  // balance does not block the quote, the simulation still bounds the send.
  // Found live 2026-09-11: 0.5 SOL typed against 0.137 held.
  const held = await sourceBalance(draft.from, from, deps);
  const problems = bridgeProblems(draft, held, ENABLED_ROUTES);
  if (problems.length) return { ok: false, message: problems[0]! };

  const fromAmountRaw = toRaw(draft.amount, decimalsOf(draft.from)).toString();
  const r = await lifi.quote({ from: draft.from, to: draft.to, fromAmountRaw, fromAddress: from, toAddress: to });
  if (!r.ok) return { ok: false, message: r.message };
  const q = r.data;

  // What we can actually prove about THIS transaction, checked rather than
  // assumed from the chain it starts on. On an EVM source the check DECIDES
  // — and if it fails, the quote is refused outright, the same refusal the
  // send path applies, so the page never shows a quote it would then decline
  // to sign. Found by audit 2026-09-11: the first version fell back to
  // assuranceOf(source), which is 'verified' for an EVM chain, so a calldata
  // that did NOT name the recipient still got the green line.
  let assurance: DestinationAssurance = assuranceOf(draft.from);
  if (q.solanaTxBase64) {
    // The Solana leg cannot prove its destination, but it can refuse a
    // transaction this build has never measured before a token is spent on
    // checking it — the programs it calls and the bridge LI.FI picked are
    // both in the bytes. (Until 2026-09-11 nothing was inspected here.)
    const why = solanaQuoteProblem(q);
    if (why) {
      logger.error(`bridge quote refused: ${why}`);
      return { ok: false, message: `That quote cannot be signed: ${why}. Nothing was sent.` };
    }
  }
  if (q.evmCall) {
    const why = recipientProblem(draft.to, q.evmCall.data, to);
    if (why) {
      logger.error(`bridge quote refused: ${why}`);
      return { ok: false, message: `That quote cannot be signed: ${why}. Nothing was sent.` };
    }
    assurance = 'verified';
  }
  // The quote a Check or Send will act on is THIS one, for a minute: the
  // page shows one transaction and signs the same one, and a bridge costs
  // one quote token instead of three. Found by audit 2026-09-11.
  const result: QuoteResult = {
    ok: true,
    message: `via ${q.toolName}`,
    _raw: q,
    quote: {
      from: draft.from,
      to: draft.to,
      fromAmountRaw,
      toAmountRaw: q.toAmountRaw,
      toAmountMinRaw: q.toAmountMinRaw,
      toDecimals: q.toDecimals,
      fromUsd: q.fromUsd,
      toUsd: q.toUsd,
      tool: q.toolName,
      durationSec: q.durationSec,
      assurance,
      feeUsd: q.fromUsd !== null && q.toUsd !== null ? q.fromUsd - q.toUsd : null,
    },
  };
  // The quote a Check or Send will act on is THIS one, for a minute: the
  // page shows one transaction and signs the same one, and a bridge costs
  // one quote token instead of three. Found by audit 2026-09-11.
  if (result.quote) lastQuote.set(quoteKey(draft), { at: Date.now(), quote: result.quote, raw: q, from, to });
  return result;
}

/** LI.FI's `BridgeData.receiver` when the destination is not an EVM chain. */
export const NON_EVM_RECEIVER = '0x11f111f111f111f111f111f111f111f111f111f1';

/**
 * Read `BridgeData.receiver` and `BridgeData.destinationChainId` out of a
 * LI.FI diamond call.
 *
 * Every `startBridgeTokensVia*` / `swapAndStartBridgeTokensVia*` facet takes
 * `ILiFi.BridgeData` as its FIRST argument, and the struct carries strings,
 * so the head word is an offset to it; the receiver is its sixth field and
 * the destination chain its eighth. Measured on the two BNB quotes of
 * 2026-09-11 (Mayan to Solana: offset 0x60, receiver = the non-EVM
 * sentinel, chain 1151111081099710; Relay to Robinhood: offset 0x80,
 * receiver = ours, chain 4663).
 *
 * This replaces a byte SEARCH for our address, which a Relay call defeats
 * by design: it names the sender as `depositorAddress` too, and the first
 * wallet signs on every chain, so from == to and the search was satisfied
 * by the wrong field. Found by audit 2026-09-11. Null when the calldata is
 * not shaped like this — which is a refusal, never a pass.
 */
export function decodeBridgeData(dataHex: string): { receiver: string; destinationChainId: bigint } | null {
  const hex = dataHex.toLowerCase().replace(/^0x/, '');
  if (hex.length < 8 + 64 || !/^[0-9a-f]*$/.test(hex)) return null;
  const body = hex.slice(8);
  const word = (i: number): string | null => (body.length >= (i + 1) * 64 ? body.slice(i * 64, (i + 1) * 64) : null);
  const w0 = word(0);
  if (!w0) return null;
  const offset = BigInt(`0x${w0}`);
  if (offset % 32n !== 0n || offset > 1024n) return null;
  const base = Number(offset / 32n);
  const receiverWord = word(base + 5);
  const chainWord = word(base + 7);
  if (!receiverWord || !chainWord) return null;
  // An address is right-aligned in its word; the twelve bytes before it are zero.
  if (!/^0{24}/.test(receiverWord)) return null;
  return { receiver: `0x${receiverWord.slice(24)}`, destinationChainId: BigInt(`0x${chainWord}`) };
}

/**
 * Why this calldata may NOT be signed as a transfer to our own address on
 * `to` — or null when it may.
 */
export function recipientProblem(to: BridgeChain, dataHex: string, ours: string | null): string | null {
  if (!ours) return `no wallet on ${to}`;
  const bd = decodeBridgeData(dataHex);
  if (!bd) return 'the calldata is not a LI.FI bridge call this app can read';
  if (bd.destinationChainId !== BigInt(LIFI_CHAIN_ID[to])) return `it is addressed to chain ${bd.destinationChainId}, not ${to}`;
  if (to === 'solana') {
    if (bd.receiver !== NON_EVM_RECEIVER) return 'it names an EVM receiver for a Solana transfer';
    if (!containsAddress(dataHex, ours)) return 'it does not carry your Solana address';
    return null;
  }
  if (bd.receiver !== ours.toLowerCase()) return `its receiver is ${bd.receiver}, not your address`;
  return null;
}

/**
 * Is our own address written into this calldata?
 *
 * Since 2026-09-11 this is the SOLANA-destination half of `recipientProblem`
 * (the pubkey lives in a bridge-specific struct whose layout varies); an EVM
 * recipient is decoded from BridgeData instead, because a byte search is
 * satisfied by the wrong field — see `decodeBridgeData`.
 *
 * A plain byte search rather than a fixed word offset, because the offset
 * depends on which bridge LI.FI picked and this has to be true or false for
 * the transaction in hand, not for a layout measured once. Finding it proves
 * the recipient is us. NOT finding it, on the EVM leg, is a refusal (quote
 * and send alike, since 2026-09-11): every bridge LI.FI has returned for
 * these routes carries the recipient in the calldata, so its absence means a
 * transaction we cannot vouch for, not a layout we have not seen. The Solana
 * leg cannot run this check at all — its destination is not in the bytes —
 * and is labelled 'trusted' for that reason.
 */
export function containsAddress(dataHex: string, address: string): boolean {
  const hay = dataHex.toLowerCase();
  // An EVM recipient: 20 bytes, written as 40 hex characters.
  // Case-blind, prefix included: an upper-cased `0X…` is still that address.
  if (/^0x[0-9a-fA-F]{40}$/i.test(address)) return hay.includes(address.slice(2).toLowerCase());
  // A Solana recipient: a 32-byte pubkey in base58. Found 2026-09-11 by
  // audit — the first version handled only the EVM shape, so every
  // ->solana bridge would have failed this check and been refused.
  try {
    const bytes = base58Decode(address);
    if (bytes.length !== 32) return false;
    return hay.includes(Buffer.from(bytes).toString('hex'));
  } catch {
    return false;
  }
}

export interface SendResult {
  ok: boolean;
  message: string;
  txHash?: string;
}

/**
 * Send it.
 *
 * `simulateOnly` runs everything up to the broadcast: on Solana the chain
 * executes the signed bytes and reports what would happen; on EVM the gas
 * estimate IS that simulation.
 */
export async function send(draft: BridgeDraft, deps: BridgeDeps, simulateOnly: boolean): Promise<SendResult> {
  // The record has to be writable BEFORE anything moves. Money this app
  // cannot write down must not leave: a user would see it gone from one side,
  // nothing on the other, and have nothing to chase.
  const storeFailure = store.failure();
  if (!simulateOnly && storeFailure) {
    return { ok: false, message: `Refusing to bridge: the in-flight record cannot be written (${storeFailure}).` };
  }

  const key = quoteKey(draft);
  const cached = lastQuote.get(key);
  const fresh = cached && Date.now() - cached.at < QUOTE_TTL_MS ? cached : null;
  // The wallets the quote was made FOR. A Robinhood wallet can be switched
  // while its chain is disarmed, and the cached transaction would still
  // deliver to the old one; the bytes cannot tell (the destination is not in
  // them on the Solana leg). Found by audit 2026-09-11.
  if (fresh && (fresh.from !== ownAddress(draft.from) || fresh.to !== ownAddress(draft.to))) {
    lastQuote.delete(key);
    return { ok: false, message: 'A wallet changed since that quote. Quote again — nothing was sent.' };
  }
  // A real send acts on the quote the page showed and the user checked, or
  // not at all: a silent re-quote here would sign bytes nobody has seen.
  if (!simulateOnly && !fresh) {
    return { ok: false, message: 'That quote has expired. Check it again — nothing was sent.' };
  }
  const q = fresh ? { ok: true, message: 'cached', quote: fresh.quote, _raw: fresh.raw } : await quote(draft, deps);
  if (!q.ok || !q.quote || !q._raw) return { ok: false, message: q.message };

  // Size is judged on the QUOTE, because only the quote knows the dollars.
  const refusal = sizeRefusal(q.quote);
  if (refusal) return { ok: false, message: refusal };

  const r = isEvmBridgeChain(draft.from)
    ? await sendFromEvm(draft, q.quote, q._raw, simulateOnly)
    : await sendFromSolana(draft, q.quote, q._raw, deps, simulateOnly);
  // A sent quote is spent. A refused one is KEPT for its minute unless the
  // refusal says the quote itself is stale: the same bytes refuse the same
  // way, and a re-quote costs a token and waits behind the aggregator's
  // pacing — which read as a hung "Check it first" on 2026-09-11.
  if (r.ok && !simulateOnly) {
    lastQuote.delete(key);
    // Relay delivers in seconds; main's timer asks every two minutes. Ask
    // soon after a send so the page says "Arrived" while the user is still
    // looking (measured 2026-09-11: landed in ~3 s, shown 65 s later).
    // Status has its own lane and budget, so these cost nothing that matters.
    for (const ms of [8_000, 25_000, 60_000]) setTimeout(() => void poll(), ms).unref?.();
  } else if (!r.ok && /expired|changed since/i.test(r.message)) lastQuote.delete(key);
  return r;
}

/** Human units of the source chain's coin the wallet holds, or null if unreadable. */
async function sourceBalance(chain: BridgeChain, address: string, deps: BridgeDeps): Promise<number | null> {
  try {
    if (chain === 'solana') {
      const r = await getBalance(deps.httpUrl, address);
      return r.ok && r.data !== undefined ? r.data / 1e9 : null;
    }
    const wei = await client(chain).getBalance({ address: address as Address });
    return Number(wei) / 1e18;
  } catch {
    return null;
  }
}

/**
 * Why the chain refused, in words. Anchor errors carry their own message;
 * a System-program failure inside a CPI does not, and the one that matters
 * here — "insufficient lamports" — is printed by the runtime in the logs.
 */
export function chainRefusal(err: unknown, logs: string[]): string {
  const anchor = anchorReason(logs);
  if (anchor) return anchor;
  for (const line of logs) {
    const m = line.match(/insufficient lamports (\d+), need (\d+)/);
    if (m) return `the wallet holds ${(Number(m[1]) / 1e9).toFixed(6)} SOL and this transfer needs ${(Number(m[2]) / 1e9).toFixed(6)} — more than you hold`;
  }
  const last = [...logs].reverse().find((l) => /^Program log: /.test(l) && !/Instruction:/.test(l));
  return last ? `${last.replace(/^Program log: /, '')} (${JSON.stringify(err)})` : JSON.stringify(err);
}

/**
 * What is wrong with a Solana-source quote, from its bytes alone: an
 * unmeasured bridge, an unmeasured program, or a transaction that cannot
 * be read. Null when the signer could go on to check it properly.
 */
function solanaQuoteProblem(q: lifi.LifiQuote): string | null {
  if (!q.solanaTxBase64) return 'the bridge returned no Solana transaction';
  if (!SOLANA_TOOLS[q.tool]) return `LI.FI picked a bridge this build has not measured on Solana (${q.toolName || q.tool})`;
  let tx: VersionedTransaction;
  try {
    tx = VT.deserialize(new Uint8Array(Buffer.from(q.solanaTxBase64, 'base64')));
  } catch (e) {
    return `the bridge returned bytes that are not a transaction (${(e as Error).message})`;
  }
  const unknown = unknownBridgePrograms(tx);
  if (unknown.length) return `it calls a program this build has not measured (${unknown.map((p) => p.slice(0, 8)).join(', ')})`;
  return null;
}

/**
 * The deposit instruction's own amount, plus every bare transfer, must add
 * up to exactly what was quoted. The signer bounds transfers and pins
 * programs but cannot read program data; this reads the one field that
 * carries the money and refuses a transaction whose deposit is not the one
 * the page showed. Found by audit 2026-09-11 — until then the only bound
 * on the deposit was the simulation loss guard, which failed open when the
 * balance read failed.
 */
export function relayDepositProblem(tx: VersionedTransaction, tool: string, fromAmountRaw: string): string | null {
  const spec = SOLANA_TOOLS[tool];
  if (!spec) return `unmeasured bridge ${tool}`;
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  let deposit: bigint | null = null;
  let transfers = 0n;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (program === RELAY_DEPOSITORY) {
      const data = Buffer.from(ix.data);
      if (data.length < 16) return 'the deposit instruction is too short to carry an amount';
      if (data.subarray(0, 8).toString('hex') !== spec.depositDisc) return `the deposit instruction is not DepositNative (${data.subarray(0, 8).toString('hex')})`;
      if (deposit !== null) return 'the transaction deposits twice';
      deposit = data.readBigUInt64LE(8);
    } else if (program === SYSTEM_PROGRAM) {
      const data = Buffer.from(ix.data);
      if (data.length >= 12 && data.readUInt32LE(0) === 2) transfers += data.readBigUInt64LE(4);
    }
  }
  if (deposit === null) return 'the transaction carries no deposit';
  const total = deposit + transfers;
  if (total !== BigInt(fromAmountRaw)) return `the transaction moves ${total} lamports, not the ${fromAmountRaw} quoted`;
  return null;
}

// ── Solana source ────────────────────────────────────────────────────────

async function sendFromSolana(
  draft: BridgeDraft,
  quoted: BridgeQuote,
  raw: lifi.LifiQuote,
  deps: BridgeDeps,
  simulateOnly: boolean,
): Promise<SendResult> {
  if (!raw.solanaTxBase64) return { ok: false, message: 'The bridge returned no Solana transaction.' };
  const owner = wallet.publicKey();
  if (!owner) return { ok: false, message: 'No active Solana wallet.' };

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(raw.solanaTxBase64, 'base64')));
  } catch (e) {
    return { ok: false, message: `The bridge returned bytes that are not a transaction (${(e as Error).message}).` };
  }

  const spec = SOLANA_TOOLS[raw.tool];
  if (!spec) return { ok: false, message: `Refusing: LI.FI picked a bridge this build has not measured on Solana (${raw.toolName || raw.tool}). Nothing was sent.` };

  // The money field, read directly: the deposit plus every bare transfer
  // must be exactly the quoted amount.
  const depositWhy = relayDepositProblem(tx, raw.tool, quoted.fromAmountRaw);
  if (depositWhy) {
    logger.error(`bridge refused: ${depositWhy}`);
    return { ok: false, message: `Refusing: ${depositWhy}. Nothing was sent.` };
  }

  // Every lookup table the transaction uses, read from the chain NOW and
  // handed to the signer by name. A table that cannot be read is a refusal.
  const resolvedTables: Array<{ key: string; addresses: string[] }> = [];
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const key = lookup.accountKey.toBase58();
    const info = await getAccountInfo(deps.httpUrl, key);
    if (!info.ok || !info.data) return { ok: false, message: `Could not read a lookup table this transfer uses (${key.slice(0, 8)}…). Nothing was sent.` };
    try {
      const table = new AddressLookupTableAccount({ key: new PublicKey(key), state: AddressLookupTableAccount.deserialize(info.data.data) });
      resolvedTables.push({ key, addresses: table.state.addresses.map((a) => a.toBase58()) });
    } catch (e) {
      return { ok: false, message: `A lookup table this transfer uses could not be decoded (${(e as Error).message}). Nothing was sent.` };
    }
  }

  // A transaction built on a blockhash that has already expired can never
  // land; broadcasting it returns a signature and nothing else, and the
  // record would sit at "unknown" forever. The cache serves a quote for a
  // minute, which is about the life of a blockhash.
  const hashOk = await isBlockhashValid(deps.httpUrl, tx.message.recentBlockhash);
  if (!hashOk.ok) return { ok: false, message: `Could not check whether this transfer can still land: ${hashOk.message}. Nothing was sent.` };
  if (!hashOk.data) return { ok: false, message: 'That quote has expired (its blockhash is no longer valid). Quote again — nothing was sent.' };

  const before = await getBalance(deps.httpUrl, owner);
  // The loss guard below needs this number; without it the guard would be
  // skipped, and a guard that fails open is not a guard.
  if (!before.ok || before.data === undefined) return { ok: false, message: `Could not read your balance before the transfer: ${before.message}. Nothing was sent.` };

  const signed = wallet.signVersionedTransaction(tx.serialize(), {
    intent: 'bridge',
    // Nothing may leave by a bare transfer except LI.FI's own fee, to its
    // pinned collector, under a ceiling; the signer's program pinning is
    // what allows the bridge call itself, and the resolved table names
    // every account that call is handed.
    maxTransferLamports: 0,
    feeAllowance: [{ address: LIFI_FEE_COLLECTOR_SOL, maxLamports: lifiFeeCeilingLamports(quoted.fromAmountRaw) }],
    resolvedTables,
    bridgeAccounts: spec.accounts,
  });
  if (!signed.ok || !signed.signed) {
    logger.error(`bridge refused by the signer: ${signed.message}`);
    return { ok: false, message: `${signed.message.replace(/\.?$/, '.')} Nothing was sent.` };
  }
  const base64 = Buffer.from(signed.signed).toString('base64');

  const sim = await simulateTransaction(deps.httpUrl, base64, [owner]);
  if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the transfer: ${sim.message}` };
  if (sim.data.err) {
    const why = chainRefusal(sim.data.err, sim.data.logs);
    logger.warn(`bridge refused by the chain: ${why}`);
    return { ok: false, message: `The chain refused this transfer: ${why}. Nothing was sent.` };
  }

  // The loss bound. It cannot see WHERE the money goes — that is the whole
  // point of `assurance` — but it can prove no more leaves than was asked for
  // plus a little for fees and rent.
  const post = sim.data.postLamports[0];
  if (typeof post !== 'number') return { ok: false, message: 'The simulation did not report your balance afterwards. Nothing was sent.' };
  {
    const spent = before.data - post;
    // The amount, plus what fees and rent can honestly cost — not a flat
    // 0.01 SOL, which was half of a 0.02 SOL transfer.
    const allowed = Number(quoted.fromAmountRaw) + SOLANA_COST_TOLERANCE_LAMPORTS;
    if (spent > allowed) {
      logger.error(`bridge refused by the loss guard: simulation spends ${spent} lamports, allowed ${allowed}`);
      return { ok: false, message: 'Refusing: the simulation spends more than this transfer should cost. Nothing was sent.' };
    }
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this transfer.' };

  const signature = solanaSignature(signed.signed);
  if (!signature) return { ok: false, message: 'Could not read the signature of the signed transfer.' };

  // Written BEFORE the broadcast. A crash between here and the send leaves a
  // record of something that may or may not have gone out, which is the
  // honest state — and far better than money gone with no trace.
  store.record({ ...inFlightFrom(draft, quoted, signature), blockhash: tx.message.recentBlockhash });
  logger.info(`bridge: sending ${draft.amount} from ${draft.from} to ${draft.to} via ${quoted.tool} — ${signature}`);

  const sent = await sendRawTransaction(deps.httpUrl, base64);
  if (!sent.ok) {
    // Could not send is not "did not send": the reply may simply be lost.
    store.update(signature, { status: 'unknown', note: `broadcast did not confirm: ${sent.message}` });
    return { ok: false, message: `Could not send the transfer: ${sent.message}. Check the Bridge panel before retrying.`, txHash: signature };
  }
  return { ok: true, message: 'On its way.', txHash: signature };
}

function solanaSignature(signedTx: Uint8Array): string | null {
  try {
    const tx = VersionedTransaction.deserialize(signedTx);
    const sig = tx.signatures[0];
    if (!sig) return null;
    // This app's own base58, not a `require` into a bundled main process.
    return base58Encode(sig);
  } catch {
    return null;
  }
}

// ── EVM source ───────────────────────────────────────────────────────────

async function sendFromEvm(
  draft: BridgeDraft,
  quoted: BridgeQuote,
  raw: lifi.LifiQuote,
  simulateOnly: boolean,
): Promise<SendResult> {
  if (!raw.evmCall) return { ok: false, message: 'The bridge returned no transaction to send.' };
  const chain = draft.from as 'robinhood' | 'bnb';
  const owner = evmWallet.address(chain);
  if (!owner) return { ok: false, message: `No wallet on ${chain}.` };

  // ── The recipient has to be OURS, and on this rail that is checkable ──
  //
  // The EVM leg is the verified one; that is its whole value next to the
  // Solana leg, which cannot be. So where the Solana path downgrades to
  // "trusted" when it cannot find the recipient, this path REFUSES: our own
  // address on the destination chain must appear in the calldata we are
  // about to sign, or the money is being sent somewhere we did not ask for.
  const why = recipientProblem(draft.to, raw.evmCall.data, ownAddress(draft.to));
  if (why) {
    logger.error(`bridge refused: ${why}`);
    return { ok: false, message: `Refusing: ${why}. Nothing was sent.` };
  }
  // The transaction says which chain it is for; it had better be this one.
  if (raw.evmCall.chainId !== CHAINS[chain].viem.id) {
    return { ok: false, message: `Refusing: that transaction is for chain ${raw.evmCall.chainId}, not ${chain}. Nothing was sent.` };
  }

  // Pinned, not accepted. A contract address the API supplies is the same
  // trust boundary as a program id it supplies.
  const expected = LIFI_CONTRACT[chain];
  if (raw.evmCall.to.toLowerCase() !== expected) {
    logger.error(`bridge refused: quote targets ${raw.evmCall.to}, not ${chain}'s known bridge contract`);
    return { ok: false, message: 'Refusing: that quote points at a contract this app does not know. Nothing was sent.' };
  }
  // The value must be exactly what the user asked to send. Native bridging
  // attaches the whole amount; anything else is a different transfer.
  const value = BigInt(raw.evmCall.value);
  if (value !== BigInt(quoted.fromAmountRaw)) {
    logger.error(`bridge refused: quote attaches ${value} wei, asked to send ${quoted.fromAmountRaw}`);
    return { ok: false, message: 'Refusing: that quote moves a different amount than you asked for. Nothing was sent.' };
  }

  // The selector is taken from the quote we are checking, so on its own it
  // pins nothing — it is here so the policy has a well-formed entry, not as
  // a bound. The bounds on this leg are the pinned contract, the exact value,
  // and the recipient check above. Said plainly rather than implied.
  const policy: EvmPolicy = {
    chainId: CHAINS[chain].viem.id,
    intent: 'bridge',
    allow: [{ to: expected, selectors: [selectorOf(raw.evmCall.data)], maxValueWei: value }],
    maxGas: 3_000_000n,
    maxFeePerGasWei: 100_000_000_000n,
    maxGasCostWei: 10_000_000_000_000_000n,
    approveSpenders: [],
    permit2Spenders: [],
  };

  // The record is written from INSIDE the send, the moment the hash is known
  // and BEFORE the bytes go out — the same ordering the Solana path has. The
  // first version recorded after `sendBuilt` returned, so a crash in the
  // gap, or a reply lost after the node had accepted the transaction, left
  // money gone with no trace. Found by audit 2026-09-11.
  let recorded = false;
  const out = await sendBuilt(
    chain,
    owner,
    { to: expected as Address, data: raw.evmCall.data as Hex, value },
    policy,
    {
      simulateOnly,
      wait: false,
      onSent: (hash) => {
        if (simulateOnly) return;
        store.record(inFlightFrom(draft, quoted, hash));
        recorded = true;
        logger.info(`bridge: sending ${draft.amount} from ${chain} to ${draft.to} via ${quoted.tool} — ${hash}`);
      },
    },
  );
  if (!out.ok) {
    logger.warn(`bridge send failed on ${chain}: ${out.message}`);
    // Could not send is not "did not send". If the hash exists the bytes may
    // have reached the node; the record stays, marked unknown, to be asked.
    if (recorded && out.hash) store.update(out.hash, { status: 'unknown', note: `broadcast did not confirm: ${out.message}` });
    // A refusal that happened before any signature says so — the policy's
    // own wording ("exceeds the … this trade allows") does not.
    const sent = recorded && out.hash;
    return { ok: false, message: sent ? out.message : `${out.message.replace(/\.?$/, '.')} Nothing was sent.`, txHash: out.hash ?? undefined };
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this transfer.' };
  if (!out.hash || !recorded) return { ok: false, message: 'Sent, but no transaction hash came back — check the chain before retrying.' };
  return { ok: true, message: 'On its way.', txHash: out.hash };
}

const selectorOf = (data: string): Hex => (data.slice(0, 10) as Hex);

function inFlightFrom(draft: BridgeDraft, q: BridgeQuote, txHash: string): InFlight {
  return {
    id: txHash,
    from: draft.from,
    to: draft.to,
    txHash,
    fromAmountRaw: q.fromAmountRaw,
    toAmountMinRaw: q.toAmountMinRaw,
    toDecimals: q.toDecimals,
    tool: q.tool,
    startedAt: Date.now(),
    status: 'pending',
    deliveredRaw: null,
    note: null,
  };
}

// ── Following it ─────────────────────────────────────────────────────────

/**
 * Ask about everything still in flight.
 *
 * Never on the priority lane and never contending with an exit: PHASE2's rule
 * is that exit processing outranks everything, and a transfer that is already
 * gone can wait a few seconds longer. A status that cannot be read leaves the
 * record UNKNOWN — which still counts as in flight, because it is.
 */
let polling: Promise<number> | null = null;

export function poll(): Promise<number> {
  // One at a time: main's timer does not await this, and the status calls
  // are gated per provider, so a second poll behind a slow first one only
  // queued the same questions again. Found by audit 2026-09-11.
  if (polling) return polling;
  polling = pollOnce().finally(() => {
    polling = null;
  });
  return polling;
}

async function pollOnce(): Promise<number> {
  const live = store.pending();
  let changed = 0;
  for (const t of live) {
    const r = await lifi.status(t.txHash, t.from, t.to);
    if (!r.ok) continue; // could not ask is not an answer
    if (r.data.status === t.status || (r.data.status === 'unknown' && t.status === 'pending')) {
      // The aggregator has nothing new. On a Solana source the chain itself
      // can still settle the question: a signature it has never seen, on a
      // blockhash that has expired, is a transaction that never landed.
      const dead = await solanaNeverLanded(t);
      if (dead) {
        store.update(t.id, { status: 'failed', note: dead });
        logger.warn(`bridge: ${t.txHash.slice(0, 16)}… never landed — ${dead}`);
        notifier?.(`Bridge: ${STATUS_LABEL.failed}`, `${t.from} → ${t.to} via ${t.tool}: ${dead}`);
        changed += 1;
      }
      continue;
    }
    store.update(t.id, { status: r.data.status, deliveredRaw: r.data.deliveredRaw, note: r.data.detail });
    logger.info(`bridge: ${t.from} to ${t.to} via ${t.tool} is now "${r.data.status}"${r.data.detail ? ` (${r.data.detail})` : ''}`);
    // A transfer that ENDED is told to the user, not only to the log —
    // a refund lands as a stablecoin on the chain it left, and until
    // 2026-09-11 the row simply vanished from the page. Found by audit.
    if (notifier && r.data.status !== 'pending') {
      const amount = Number(BigInt(t.fromAmountRaw)) / 10 ** decimalsOf(t.from);
      notifier(
        `Bridge: ${STATUS_LABEL[r.data.status]}`,
        `${amount} ${t.from === 'solana' ? 'SOL' : t.from === 'bnb' ? 'BNB' : 'ETH'} ${t.from} → ${t.to} via ${t.tool}${r.data.detail ? ` — ${r.data.detail}` : ''}. Open Bridge to see it.`,
      );
    }
    changed += 1;
  }
  return changed;
}

/**
 * "Never landed", with the proof, or null. Only for a Solana-source transfer
 * old enough to be sure of: the signature is absent from the chain's history
 * AND its blockhash has expired, so it can never appear.
 */
async function solanaNeverLanded(t: InFlight): Promise<string | null> {
  if (t.from !== 'solana' || !t.blockhash || !depsProvider) return null;
  if (Date.now() - t.startedAt < SOLANA_DEAD_AFTER_MS) return null;
  const deps = depsProvider();
  const st = await getSignatureStatuses(deps.httpUrl, [t.txHash], { searchTransactionHistory: true });
  if (!st.ok) return null;
  const status = st.data?.[0] ?? null;
  if (status) {
    // Landed (or landed and failed) — LI.FI's word on the rest stands.
    const err = (status as { err?: unknown }).err;
    return err ? `the transaction landed but failed on chain (${JSON.stringify(err)}); nothing left your wallet` : null;
  }
  const valid = await isBlockhashValid(deps.httpUrl, t.blockhash);
  if (!valid.ok || valid.data) return null; // still could land, or could not tell
  return 'the transaction never landed — its blockhash expired before a validator included it. Nothing left your wallet.';
}

export const inFlight = store.pending;
export const history = store.all;
export const recordFailure = store.failure;
