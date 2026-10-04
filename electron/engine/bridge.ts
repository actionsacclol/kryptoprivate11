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
  chainLabel,
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
import { broadcastAndConfirm } from './broadcast';
import * as feeEstimator from './feeEstimator';
import { SOLANA_DEPOSIT_CU_LIMIT, evmFeeMultiplier, solanaDepositPrice, type AioSpeed } from '@shared/aioSpeed';
import { base58Decode, base58Encode } from '../chain/base58';
import { evmFeePlan, sendBuilt, sendFeeLegs } from '../evm/trade';
import type { FeePlan } from '../evm/uniswap';
import type { EvmPolicy } from '../evm/policy';
import type { Address, Hex } from 'viem';
import { CHAINS } from '../evm/chains';
import { client, feeFields, waitForReceipt } from '../evm/client';
import * as relay from './relay';
import { rentSafeTransfers } from './liveSigner';
import { holderRateApplies } from './kryptoHolding';
import { ComputeBudgetProgram, SystemProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { getLatestBlockhashInfo } from '../chain/rpcClient';
import { FEE_BPS, REFERRAL_SHARE_BPS, feesEnabled, looksLikeSolAddress, splitFee, treasuryIntegrity } from '@shared/fees';
import { holderFeeBps } from '@shared/krypto';
import { evmFeesEnabled, weiToEth } from '@shared/evm';
import {
  RELAY_CHAIN_ID,
  RELAY_EVM_DEPOSITORY,
  RELAY_EVM_DEPOSIT_SELECTOR,
  RELAY_NATIVE,
  destinationProblem,
  evmDepositProblem,
  solanaDepositProblem,
  type RelayQuote,
} from '@shared/relay';
import { QUOTE_LIFE_MS, nativeSymbolOf, type BridgeRail, type BridgeStatus } from '@shared/bridge';

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
  // 2026-10-01: every route is RELAY, called directly (shared/relay.ts), and
  // all six were measured that day — including solana->bnb, which LI.FI
  // could only offer through Mayan's unreadable lookup tables (below).
  'solana->bnb',
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
  /** The Solana referrer from Settings, for Krypt's fee on a Solana-source
   *  transfer (a fifth of it, exactly as on a trade). */
  referrer?: string;
  /** The EVM referrer from Settings, for an EVM-source transfer. */
  evmReferrer?: string;
  /** All-in-One speed tier (shared/aioSpeed.ts). Absent = Normal. */
  speed?: AioSpeed;
}

/**
 * Which rail carries a NEW transfer. Relay since 2026-10-01: all six routes,
 * keyless quotes in about a second, fills in about a second, and no 75-a-
 * two-hours quote budget. LI.FI stays wired behind this one constant as the
 * way back, and its in-flight records are still followed through LI.FI.
 *
 * What the switch costs: LI.FI's EVM calldata names the receiver, so those
 * sources were 'verified'; Relay's names only the depositor and a
 * commitment, so every Relay transfer is 'trusted' (shared/relay.ts).
 */
const NEW_TRANSFER_RAIL: BridgeRail = 'relay';

/** Relay's deposit compiled here, so the compute budget is ours. MEASURED
 *  2026-10-01 (mainnet simulation, fee transfer included): 13,701 units —
 *  the limit is about three times that, because the priority paid is
 *  limit × price whether the units are used or not. */

/** Krypt's fee on a Solana-source Relay transfer: the bare transfers that go
 *  in the same transaction as the deposit, rent-safe. */
interface SolanaFee {
  transfers: Array<{ to: string; lamports: number }>;
  totalLamports: number;
}

type RawQuote =
  | { rail: 'lifi'; q: lifi.LifiQuote }
  | { rail: 'relay'; q: RelayQuote; depositRaw: string; fee: SolanaFee | null; evmFee: FeePlan | null };

/** Our own address on a chain — the only address a bridge may ever send to. */
function ownAddress(chain: BridgeChain): string | null {
  if (chain === 'solana') return wallet.publicKey();
  return evmWallet.address(chain);
}

function decimalsOf(chain: BridgeChain): number {
  return chain === 'solana' ? 9 : 18;
}

/**
 * Human units to base units, through the SHORTEST decimal that round-trips:
 * 0.0085 is "0.0085", never toFixed(18)'s "0.008500000000000001" (which sent
 * 8500000000000001 wei in the 2026-10-03 live test). No exponent either.
 */
export function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const s = amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  const [whole, frac = ''] = s.split('.');
  return BigInt(`${whole}${frac.slice(0, decimals).padEnd(decimals, '0')}` || '0');
}

export interface QuoteResult {
  ok: boolean;
  message: string;
  quote?: BridgeQuote;
  /** Present only on the way OUT — never persisted, never sent to the UI. */
  _raw?: RawQuote;
}

/** The last quote per draft, so Check and Send act on what the page showed.
 *  Its life is QUOTE_LIFE_MS (shared/bridge.ts), per rail. */
const lastQuote = new Map<string, { at: number; quote: BridgeQuote; raw: RawQuote; from: string; to: string }>();

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

  if (NEW_TRANSFER_RAIL === 'relay') return quoteRelay(draft, deps, from, to);

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
    _raw: { rail: 'lifi', q },
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
      rail: 'lifi',
      quoteId: `lifi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    },
  };
  // The quote a Check or Send will act on is THIS one, for a minute: the
  // page shows one transaction and signs the same one, and a bridge costs
  // one quote token instead of three. Found by audit 2026-09-11.
  if (result.quote && result._raw) lastQuote.set(quoteKey(draft), { at: Date.now(), quote: result.quote, raw: result._raw, from, to });
  return result;
}

// ── Relay ──────────────────────────────────────────────────────────────

/**
 * Price one transfer on Relay, Krypt's fee included, and check the bytes
 * NOW — so the page never shows a quote the send would refuse to sign.
 *
 *  · From Solana the fee is two bare transfers in the deposit's own
 *    transaction (treasury + referrer, rent-safe, exactly as on a trade),
 *    and Relay is quoted for what is left.
 *  · From BNB / Robinhood it is collected the way an EVM curve buy pays it:
 *    plain native transfers straight to the treasury and the referrer,
 *    sent right after the deposit (an EVM wallet cannot put two payments in
 *    one transaction). Relay is quoted for what is left. Never a Relay "app
 *    fee": that accrued as USDC at Relay for the owner — and every referrer —
 *    to go and claim, which is not how this app pays anyone (2026-10-02).
 */
/** Worst-case gas for a Relay deposit and for one fee leg (the 'fee' policy's
 *  own ceiling), held back from an EVM-source move so the fee can be paid. */
const EVM_DEPOSIT_GAS = 80_000n;
const EVM_FEE_LEG_GAS = 60_000n;

async function quoteRelay(draft: BridgeDraft, deps: BridgeDeps, from: string, to: string): Promise<QuoteResult> {
  const amountRaw = toRaw(draft.amount, decimalsOf(draft.from));
  if (amountRaw <= 0n) return { ok: false, message: 'Enter an amount.' };
  // Unknown holding is not a holder: the same rule as every other fee.
  const holder = holderRateApplies();
  let depositRaw = amountRaw;
  let fee: SolanaFee | null = null;
  let evmFee: FeePlan | null = null;
  let feeNote: string | null = null;
  const pct = (bps: number): string => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

  if (draft.from === 'solana') {
    const treasury = feesEnabled() ? treasuryIntegrity().treasury : '';
    if (treasury) {
      const ref = (deps.referrer ?? '').trim();
      const hasRef = looksLikeSolAddress(ref) && ref !== treasury && ref !== from;
      const bps = holderFeeBps(FEE_BPS, holder);
      const split = splitFee(Number(amountRaw), hasRef, bps);
      if (split.totalLamports > 0) {
        const wanted = [{ to: treasury, lamports: split.treasuryLamports }];
        if (split.referrerLamports > 0) wanted.push({ to: ref, lamports: split.referrerLamports });
        // A transfer that would leave an empty recipient below rent reverts
        // the whole transaction — dropped, never allowed to block the move.
        const safe = await rentSafeTransfers(wanted, deps.httpUrl);
        const total = safe.reduce((a, t) => a + t.lamports, 0);
        if (total > 0) {
          fee = { transfers: safe, totalLamports: total };
          depositRaw = amountRaw - BigInt(total);
          feeNote = `Krypt fee ${pct(bps)}${holder ? ' (halved: $KRYPTO holder)' : ''}${safe.some((t) => t.to === ref) ? ', a fifth of it to your referrer' : ''}`;
        }
      }
    }
  } else if (evmFeesEnabled()) {
    // The ordinary EVM fee (trade.ts feePlanFor): rate, holder discount and
    // referrer rules are the trade path's own, not re-implemented here.
    const plan = evmFeePlan(amountRaw, deps.evmReferrer ?? '', from as `0x${string}`);
    if (plan.totalWei > 0n && plan.treasury && plan.totalWei < amountRaw) {
      evmFee = plan;
      depositRaw = amountRaw - plan.totalWei;
      // Hundredths of a basis point: a 1-wei rounding must not read "0.49%".
      const bps = Number((plan.totalWei * 1_000_000n) / amountRaw) / 100;
      feeNote = `Krypt fee ${pct(bps)}${holder ? ' (halved: $KRYPTO holder)' : ''}${plan.referrerWei > 0n ? ', a fifth of it to your referrer' : ''}, paid straight to them right after the deposit`;
    }
  }

  // From an EVM chain the deposit AND its fee legs each pay gas on top of the
  // amount. A move of the whole balance passed the deposit's own check and
  // left nothing for the legs — they were refused and no fee was paid
  // (swarm 2026-10-03, MS-4). Worst-case gas for all of them stays behind.
  if (draft.from !== 'solana') {
    const chain = draft.from;
    try {
      const [held, fees] = await Promise.all([client(chain).getBalance({ address: from as `0x${string}` }), feeFields(chain)]);
      const legs = evmFee ? (evmFee.referrerWei > 0n ? 2n : 1n) : 0n;
      const gasReserve = (EVM_DEPOSIT_GAS + legs * EVM_FEE_LEG_GAS) * fees.maxFeePerGas;
      if (amountRaw + gasReserve > held) {
        const room = held > gasReserve ? held - gasReserve : 0n;
        const sym = nativeSymbolOf(chain);
        return {
          ok: false,
          message: `Leave about ${weiToEth(gasReserve).toPrecision(2)} ${sym} for network fees — at most ${weiToEth(room).toFixed(6)} ${sym} can move.`,
        };
      }
    } catch {
      // Unread: the send's own "value + gas" check still refuses a deposit the
      // wallet cannot pay for. Never block a quote on a read.
    }
  }

  const r = await relay.quote({
    user: from,
    recipient: to,
    originChainId: RELAY_CHAIN_ID[draft.from],
    destinationChainId: RELAY_CHAIN_ID[draft.to],
    originCurrency: RELAY_NATIVE[draft.from],
    destinationCurrency: RELAY_NATIVE[draft.to],
    amount: depositRaw.toString(),
    tradeType: 'EXACT_INPUT',
    // A failed fill comes back to the wallet it left, explicitly.
    refundTo: from,
  });
  if (!r.ok) return { ok: false, message: r.message };
  const q = r.data;
  const why =
    draft.from === 'solana'
      ? solanaDepositProblem(q, from, depositRaw.toString())
      : evmDepositProblem(q, from, depositRaw.toString(), CHAINS[draft.from as 'bnb' | 'robinhood'].viem.id);
  if (why) {
    logger.error(`bridge quote refused (relay): ${why}`);
    return { ok: false, message: `That quote cannot be signed: ${why}. Nothing was sent.` };
  }
  // What Relay says it will deliver must be what was asked: our own address,
  // that chain, its native coin. The deposit bytes cannot say; the quote can.
  const dest = destinationProblem(q, draft.to, to);
  if (dest) {
    logger.error(`bridge quote refused (relay): ${dest}`);
    return { ok: false, message: `That quote cannot be signed: ${dest}. Nothing was sent.` };
  }

  // Relay prices the DEPOSIT; on Solana the user's amount is the deposit
  // plus Krypt's fee, so dollars scale from the deposit's own rate.
  const usdPerRaw = q.inUsd !== null && depositRaw > 0n ? q.inUsd / Number(depositRaw) : null;
  const fromUsd = usdPerRaw !== null ? usdPerRaw * Number(amountRaw) : null;
  // Krypt's share, in dollars at the deposit's own rate.
  const feeRaw = fee ? BigInt(fee.totalLamports) : evmFee ? evmFee.totalWei : 0n;
  const kryptFeeUsd = feeRaw > 0n ? (usdPerRaw !== null ? usdPerRaw * Number(feeRaw) : null) : 0;
  const quoted: BridgeQuote = {
    from: draft.from,
    to: draft.to,
    fromAmountRaw: amountRaw.toString(),
    toAmountRaw: q.amountOutRaw,
    toAmountMinRaw: q.minOutRaw,
    toDecimals: q.outDecimals,
    fromUsd,
    toUsd: q.outUsd,
    tool: 'Relay',
    durationSec: q.timeEstimateSec,
    assurance: assuranceOf(draft.from, 'relay'),
    feeUsd: fromUsd !== null && q.outUsd !== null ? fromUsd - q.outUsd : null,
    rail: 'relay',
    quoteId: q.requestId,
    kryptFeeUsd,
    kryptFeeNote: feeNote,
  };
  const raw: RawQuote = { rail: 'relay', q, depositRaw: depositRaw.toString(), fee, evmFee };
  lastQuote.set(quoteKey(draft), { at: Date.now(), quote: quoted, raw, from, to });
  return { ok: true, message: 'via Relay', quote: quoted, _raw: raw };
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
export async function send(draft: BridgeDraft, deps: BridgeDeps, simulateOnly: boolean, quoteId?: string): Promise<SendResult> {
  // The record has to be writable BEFORE anything moves. Money this app
  // cannot write down must not leave: a user would see it gone from one side,
  // nothing on the other, and have nothing to chase.
  const storeFailure = store.failure();
  if (!simulateOnly && storeFailure) {
    return { ok: false, message: `Refusing to bridge: the in-flight record cannot be written (${storeFailure}).` };
  }

  const key = quoteKey(draft);
  const cached = lastQuote.get(key);
  const ttl = QUOTE_LIFE_MS[cached?.raw.rail ?? 'lifi'];
  const fresh = cached && Date.now() - cached.at < ttl ? cached : null;
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
    return { ok: false, message: 'That quote has expired. Get a new one — nothing was sent.' };
  }
  // The quote the page SHOWED, by name. Two pages share this cache, and a
  // quote made on one must never be sent from the other (review 2026-10-02).
  if (fresh && quoteId !== undefined && fresh.quote.quoteId !== quoteId) {
    return { ok: false, message: 'That quote was replaced by a newer one. Get a new quote — nothing was sent.' };
  }
  if (!simulateOnly && quoteId === undefined) {
    return { ok: false, message: 'internal: a send must name the quote it acts on — nothing was sent.' };
  }
  const q = fresh ? { ok: true, message: 'cached', quote: fresh.quote, _raw: fresh.raw } : await quote(draft, deps);
  if (!q.ok || !q.quote || !q._raw) return { ok: false, message: q.message };
  if (!simulateOnly) {
    // SINGLE USE, taken before anything awaits. A Relay send rebuilds its
    // transaction every time (fresh blockhash, fresh nonce), so a quote that
    // survived a lost broadcast reply was a SECOND deposit one click away
    // (review 2026-10-02). Whatever happens next, this quote is spent.
    lastQuote.delete(key);
    // And one deposit per Relay request, whatever the cache says.
    if (q._raw.rail === 'relay') {
      const requestId = q._raw.q.requestId;
      if (store.all().some((t) => t.requestId === requestId)) {
        return { ok: false, message: 'This quote was already sent once. Get a new quote — nothing more was sent.' };
      }
    }
  }

  // Size is judged on the QUOTE, because only the quote knows the dollars.
  const refusal = sizeRefusal(q.quote);
  if (refusal) return { ok: false, message: refusal };

  const raw = q._raw;
  const r =
    raw.rail === 'relay'
      ? isEvmBridgeChain(draft.from)
        ? await sendFromEvmRelay(draft, q.quote, raw, simulateOnly, deps.speed)
        : await sendFromSolanaRelay(draft, q.quote, raw, deps, simulateOnly)
      : isEvmBridgeChain(draft.from)
        ? await sendFromEvm(draft, q.quote, raw.q, simulateOnly)
        : await sendFromSolana(draft, q.quote, raw.q, deps, simulateOnly);
  // A real send spent its quote above, sent or not. A refused CHECK keeps
  // the quote for its life unless the refusal says the quote is stale.
  if (r.ok && !simulateOnly) {
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

// ── Relay: top-ups that fund a buy (All-in-One "buy anywhere") ───────────
//
// EXACT_OUTPUT: the destination receives exactly what the buy needs (plus
// its reserve, at least the minimum top-up). No Krypt fee — the owner's call
// (2026-10-02): one fee per order, and the buy pays it. Kept in their OWN
// single-use store, keyed by Relay's request id, so a fee-free top-up can
// never be sent as an ordinary move through bridge:send or aio:moveSend.

const topUps = new Map<string, { at: number; quote: BridgeQuote; raw: Extract<RawQuote, { rail: 'relay' }>; from: string; to: string }>();

export interface TopUpRequest {
  from: BridgeChain;
  to: BridgeChain;
  /** Base units of the DESTINATION coin that must arrive. */
  outRaw: bigint;
}

/** Quote one top-up. The page shows it; `sendTopUp` sends it by id. */
export async function quoteTopUp(t: TopUpRequest, deps: BridgeDeps): Promise<QuoteResult> {
  void deps;
  if (t.from === t.to) return { ok: false, message: 'A top-up moves between two chains.' };
  if (!ENABLED_ROUTES.has(routeId(t.from, t.to))) return { ok: false, message: `${chainLabel(t.from)} to ${chainLabel(t.to)} is not enabled.` };
  if (t.outRaw <= 0n) return { ok: false, message: 'Nothing to top up.' };
  const from = ownAddress(t.from);
  const to = ownAddress(t.to);
  if (!from || !to) return { ok: false, message: 'A wallet is missing on one of the two chains.' };
  const r = await relay.quote({
    user: from,
    recipient: to,
    originChainId: RELAY_CHAIN_ID[t.from],
    destinationChainId: RELAY_CHAIN_ID[t.to],
    originCurrency: RELAY_NATIVE[t.from],
    destinationCurrency: RELAY_NATIVE[t.to],
    amount: t.outRaw.toString(),
    tradeType: 'EXACT_OUTPUT',
    refundTo: from,
  });
  if (!r.ok) return { ok: false, message: r.message };
  const q = r.data;
  const why =
    (t.from === 'solana'
      ? solanaDepositProblem(q, from, q.amountInRaw)
      : evmDepositProblem(q, from, q.amountInRaw, CHAINS[t.from as 'bnb' | 'robinhood'].viem.id)) ??
    destinationProblem(q, t.to, to) ??
    (BigInt(q.amountOutRaw) < t.outRaw ? `Relay would deliver ${q.amountOutRaw}, less than the ${t.outRaw} asked` : null);
  if (why) {
    logger.error(`top-up quote refused (relay): ${why}`);
    return { ok: false, message: `That top-up cannot be signed: ${why}. Nothing was sent.` };
  }
  const quoted: BridgeQuote = {
    from: t.from,
    to: t.to,
    fromAmountRaw: q.amountInRaw,
    toAmountRaw: q.amountOutRaw,
    toAmountMinRaw: q.minOutRaw,
    toDecimals: q.outDecimals,
    fromUsd: q.inUsd,
    toUsd: q.outUsd,
    tool: 'Relay',
    durationSec: q.timeEstimateSec,
    assurance: assuranceOf(t.from, 'relay'),
    feeUsd: q.inUsd !== null && q.outUsd !== null ? q.inUsd - q.outUsd : null,
    rail: 'relay',
    quoteId: q.requestId,
    kryptFeeUsd: 0,
    kryptFeeNote: 'No Krypt fee on this top-up — the buy it funds pays the fee',
  };
  const raw: Extract<RawQuote, { rail: 'relay' }> = { rail: 'relay', q, depositRaw: q.amountInRaw, fee: null, evmFee: null };
  // Old entries go: a quote is good for half a minute.
  for (const [k, v] of topUps) if (Date.now() - v.at > QUOTE_LIFE_MS.relay) topUps.delete(k);
  topUps.set(q.requestId, { at: Date.now(), quote: quoted, raw, from, to });
  return { ok: true, message: 'via Relay', quote: quoted, _raw: raw };
}

/** Send a top-up quoted by `quoteTopUp`. Single use; real, never simulated
 *  separately — the Solana path simulates and loss-guards before it sends,
 *  the EVM path estimates gas, exactly as for any move. */
export async function sendTopUp(quoteId: string, deps: BridgeDeps): Promise<SendResult> {
  const entry = topUps.get(quoteId);
  topUps.delete(quoteId); // single use, taken before anything awaits
  if (!entry) return { ok: false, message: 'That top-up quote is gone (already used, or never made). Nothing was sent.' };
  if (Date.now() - entry.at >= QUOTE_LIFE_MS.relay) return { ok: false, message: 'That top-up quote has expired. Nothing was sent.' };
  const storeFailure = store.failure();
  if (storeFailure) return { ok: false, message: `Refusing to move funds: the in-flight record cannot be written (${storeFailure}).` };
  const { quote: quoted, raw } = entry;
  if (entry.from !== ownAddress(quoted.from) || entry.to !== ownAddress(quoted.to)) {
    return { ok: false, message: 'A wallet changed since that quote. Nothing was sent.' };
  }
  if (store.all().some((r) => r.requestId === raw.q.requestId)) return { ok: false, message: 'That top-up was already sent once. Nothing more was sent.' };
  const refusal = sizeRefusal(quoted);
  if (refusal) return { ok: false, message: refusal };
  const draft: BridgeDraft = { from: quoted.from, to: quoted.to, amount: Number(BigInt(quoted.fromAmountRaw)) / 10 ** decimalsOf(quoted.from) };
  const r = isEvmBridgeChain(quoted.from)
    ? await sendFromEvmRelay(draft, quoted, raw, false, deps.speed)
    : await sendFromSolanaRelay(draft, quoted, raw, deps, false);
  if (r.ok) for (const ms of [5_000, 15_000, 45_000]) setTimeout(() => void poll(), ms).unref?.();
  return r;
}

// ── Relay: Solana source ─────────────────────────────────────────────────

/**
 * Compile Relay's deposit HERE — its one instruction, with the compute
 * budget and Krypt's fee transfers around it — and sign it under the bridge
 * policy. No lookup table: every account is in the static keys, where the
 * signer can name it (Relay's table only shortens the transaction).
 */
async function sendFromSolanaRelay(
  draft: BridgeDraft,
  quoted: BridgeQuote,
  raw: Extract<RawQuote, { rail: 'relay' }>,
  deps: BridgeDeps,
  simulateOnly: boolean,
): Promise<SendResult> {
  const owner = wallet.publicKey();
  if (!owner) return { ok: false, message: 'No active Solana wallet.' };
  const why = solanaDepositProblem(raw.q, owner, raw.depositRaw);
  if (why) {
    logger.error(`bridge refused (relay): ${why}`);
    return { ok: false, message: `Refusing: ${why}. Nothing was sent.` };
  }
  const ix = raw.q.solana!.instructions[0]!;
  const payer = new PublicKey(owner);
  // Independent reads, together (they were one after the other). The fee
  // estimate is the tier's input; unread, the tier's floor applies.
  const [bh, before, est] = await Promise.all([
    getLatestBlockhashInfo(deps.httpUrl),
    getBalance(deps.httpUrl, owner),
    feeEstimator.estimate(deps.httpUrl, [owner]).catch(() => null),
  ]);
  const cuPrice = solanaDepositPrice(deps.speed ?? 'normal', est);
  if (!bh.ok || !bh.data) return { ok: false, message: `Could not read a recent blockhash: ${bh.message}. Nothing was sent.` };
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bh.data.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: SOLANA_DEPOSIT_CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
        ...(raw.fee?.transfers ?? []).map((t) => SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(t.to), lamports: t.lamports })),
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
          data: Buffer.from(ix.data, 'hex'),
        }),
      ],
    }).compileToV0Message(),
  );
  // The money, read off the COMPILED bytes: deposit + every bare transfer
  // must be exactly what the user asked to move — the fee included.
  const moneyWhy = relayDepositProblem(tx, 'relaydepository', quoted.fromAmountRaw);
  if (moneyWhy) {
    logger.error(`bridge refused (relay): ${moneyWhy}`);
    return { ok: false, message: `Refusing: ${moneyWhy}. Nothing was sent.` };
  }

  if (!before.ok || before.data === undefined) return { ok: false, message: `Could not read your balance before the transfer: ${before.message}. Nothing was sent.` };

  const signed = wallet.signVersionedTransaction(tx.serialize(), {
    intent: 'bridge',
    // Nothing leaves by a bare transfer except Krypt's fee, to the two
    // addresses quoted, at exactly the amounts quoted.
    maxTransferLamports: 0,
    feeAllowance: (raw.fee?.transfers ?? []).map((t) => ({ address: t.to, maxLamports: t.lamports })),
  });
  if (!signed.ok || !signed.signed) {
    logger.error(`bridge refused by the signer (relay): ${signed.message}`);
    return { ok: false, message: `${signed.message.replace(/\.?$/, '.')} Nothing was sent.` };
  }
  const base64 = Buffer.from(signed.signed).toString('base64');
  const sim = await simulateTransaction(deps.httpUrl, base64, [owner]);
  if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the transfer: ${sim.message}` };
  if (sim.data.err) {
    const reason = chainRefusal(sim.data.err, sim.data.logs);
    logger.warn(`bridge refused by the chain (relay): ${reason}`);
    return { ok: false, message: `The chain refused this transfer: ${reason}. Nothing was sent.` };
  }
  const post = sim.data.postLamports[0];
  if (typeof post !== 'number') return { ok: false, message: 'The simulation did not report your balance afterwards. Nothing was sent.' };
  const spent = before.data - post;
  const allowed = Number(quoted.fromAmountRaw) + SOLANA_COST_TOLERANCE_LAMPORTS;
  if (spent > allowed) {
    logger.error(`bridge refused by the loss guard (relay): simulation spends ${spent} lamports, allowed ${allowed}`);
    return { ok: false, message: 'Refusing: the simulation spends more than this transfer should cost. Nothing was sent.' };
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this transfer.' };

  const signature = solanaSignature(signed.signed);
  if (!signature) return { ok: false, message: 'Could not read the signature of the signed transfer.' };
  // Written BEFORE the broadcast, as on every other path.
  store.record({ ...inFlightFrom(draft, quoted, signature), blockhash: bh.data.blockhash, rail: 'relay', requestId: raw.q.requestId });
  logger.info(`bridge: sending ${draft.amount} from ${draft.from} to ${draft.to} via Relay — ${signature} (request ${raw.q.requestId})`);
  const sent = await sendRawTransaction(deps.httpUrl, base64);
  // Either way the SAME bytes keep going out until they confirm or can no
  // longer land: a dropped packet is retried, a lost reply is followed by
  // signature. Background — the move is "On its way" from the first accept.
  const lastValidBlockHeight = bh.data.lastValidBlockHeight;
  void broadcastAndConfirm({ httpUrl: deps.httpUrl, base64, signature, lanes: ['rpc'], lastValidBlockHeight })
    .then((r) => {
      if (r.chainErr) store.update(signature, { status: 'failed', note: 'the deposit failed on chain — nothing was moved but the network fee' });
      else if (r.expired) store.update(signature, { status: 'failed', note: 'the deposit expired before it landed — nothing was moved' });
    })
    .catch((e) => logger.warn(`bridge: deposit rebroadcast stopped — ${(e as Error).message}`));
  if (!sent.ok) {
    store.update(signature, { status: 'unknown', note: `broadcast did not confirm: ${sent.message}` });
    return { ok: false, message: `Could not send the transfer: ${sent.message}. Check the Bridge panel before retrying.`, txHash: signature };
  }
  return { ok: true, message: 'On its way.', txHash: signature };
}

// ── Relay: EVM source ────────────────────────────────────────────────────

async function sendFromEvmRelay(
  draft: BridgeDraft,
  quoted: BridgeQuote,
  raw: Extract<RawQuote, { rail: 'relay' }>,
  simulateOnly: boolean,
  speed: AioSpeed = 'normal',
): Promise<SendResult> {
  const chain = draft.from as 'robinhood' | 'bnb';
  const owner = evmWallet.address(chain);
  if (!owner) return { ok: false, message: `No wallet on ${chain}.` };
  const why = evmDepositProblem(raw.q, owner, raw.depositRaw, CHAINS[chain].viem.id);
  if (why) {
    logger.error(`bridge refused (relay): ${why}`);
    return { ok: false, message: `Refusing: ${why}. Nothing was sent.` };
  }
  const call = raw.q.evm!;
  const value = BigInt(call.value);
  const policy: EvmPolicy = {
    chainId: CHAINS[chain].viem.id,
    intent: 'bridge',
    // The one call, to the pinned depository, with the measured selector and
    // exactly the value asked for.
    allow: [{ to: RELAY_EVM_DEPOSITORY, selectors: [RELAY_EVM_DEPOSIT_SELECTOR as Hex], maxValueWei: value }],
    maxGas: 3_000_000n,
    maxFeePerGasWei: 100_000_000_000n,
    maxGasCostWei: 10_000_000_000_000_000n,
    approveSpenders: [],
    permit2Spenders: [],
  };
  let recorded = false;
  let recordedHash: string | null = null;
  const out = await sendBuilt(chain, owner, { to: RELAY_EVM_DEPOSITORY as Address, data: call.data as Hex, value }, policy, {
    simulateOnly,
    wait: false,
    feeMultiplier: evmFeeMultiplier(speed, chain),
    onSent: (hash) => {
      if (simulateOnly) return;
      store.record({ ...inFlightFrom(draft, quoted, hash), rail: 'relay', requestId: raw.q.requestId });
      recorded = true;
      recordedHash = hash;
      logger.info(`bridge: sending ${draft.amount} from ${chain} to ${draft.to} via Relay — ${hash} (request ${raw.q.requestId})`);
    },
  });
  if (!out.ok) {
    logger.warn(`bridge send failed on ${chain} (relay): ${out.message}`);
    if (recorded && out.hash) store.update(out.hash, { status: 'unknown', note: `broadcast did not confirm: ${out.message}` });
    // No hash back = the node definitively refused it (the nonce went to
    // another transaction): nothing left the wallet, so the record must not
    // sit "On its way" forever (swarm 2026-10-03, MS-8).
    else if (recorded && recordedHash) store.update(recordedHash, { status: 'failed', note: `nothing was sent: ${out.message}` });
    const sent = recorded && out.hash;
    return { ok: false, message: sent ? out.message : `${out.message.replace(/\.?$/, '.')} Nothing was sent.`, txHash: out.hash ?? undefined };
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this transfer.' };
  if (!out.hash || !recorded) return { ok: false, message: 'Sent, but no transaction hash came back — check the chain before retrying.' };
  // Krypt's fee, the way an EVM curve buy pays it: straight to the treasury
  // and the referrer, right after the deposit went out. Only once the
  // deposit has gone — no move, no fee — and never able to fail the move.
  // After the deposit's RECEIPT, not merely its broadcast: a reverted
  // deposit moved nothing and owes nothing, and two sends a moment apart is
  // how the fee once collided with the deposit's nonce (2026-10-03).
  if (raw.evmFee) {
    const fee = raw.evmFee;
    const walletId = evmWallet.info(chain).id ?? undefined;
    const hash = out.hash;
    void waitForReceipt(chain, hash)
      .then((r) => {
        if (!r) return logger.warn(`bridge: Krypt fee not sent — the deposit ${hash} has no receipt yet`);
        if (r.status !== 'success') return logger.warn(`bridge: Krypt fee not sent — the deposit ${hash} reverted`);
        return sendFeeLegs(chain, walletId, owner, fee, 'move').then((h) => {
          if (h) logger.info(`bridge: Krypt fee ${weiToEth(fee.totalWei).toFixed(6)} sent after the move — ${h}`);
        });
      })
      .catch((e) => logger.warn(`bridge: Krypt fee after the move failed — ${(e as Error).message}`));
  }
  return { ok: true, message: 'On its way.', txHash: out.hash };
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

/** What the record of one transfer says now (by its id / tx hash), or null
 *  when there is no record. Local — no request. */
export function statusOf(id: string): BridgeStatus | null {
  return store.all().find((t) => t.id === id || t.txHash === id)?.status ?? null;
}

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
    const r = t.rail === 'relay' ? await relayStatusFor(t) : await lifi.status(t.txHash, t.from, t.to);
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
 * A Relay transfer's status, in the shape LI.FI's poll already reads.
 *
 * "Done" is only believed when Relay's record names OUR deposit: the request
 * id is Relay's, and a success on a request whose deposit is someone else's
 * transaction says nothing about ours. Until it does, it stays unknown.
 */
async function relayStatusFor(t: InFlight): Promise<{ ok: true; data: { status: BridgeStatus; deliveredRaw: string | null; detail: string | null } } | { ok: false }> {
  if (!t.requestId) return { ok: false };
  const r = await relay.status(t.requestId);
  if (!r.ok) return { ok: false };
  // Solana signatures are case-sensitive base58; EVM hashes are hex.
  const ours = r.data.inTxHashes.some((h) => (t.from === 'solana' ? h === t.txHash : h.toLowerCase() === t.txHash.toLowerCase()));
  // An ENDED request is believed only when it names our deposit — filled,
  // refunded or failed alike; each one stops the polling for good.
  if ((r.data.status === 'done' || r.data.status === 'refunded' || r.data.status === 'failed' || r.data.status === 'partial') && !ours) {
    return { ok: true, data: { status: 'unknown', deliveredRaw: null, detail: `Relay reports the request ${r.data.raw}, but its record does not name this app's deposit` } };
  }
  const fill = r.data.outTxHashes[0];
  return {
    ok: true,
    data: {
      status: r.data.status,
      deliveredRaw: null,
      detail: r.data.detail ?? (r.data.status === 'done' && fill ? `filled in ${fill.slice(0, 14)}…` : null),
    },
  };
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
