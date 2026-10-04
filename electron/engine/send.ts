// Send on Solana — SOL or any SPL / Token-2022 token, to an address the user
// typed (2026-10-03). See shared/send.ts for why this exists next to
// Withdraw.
//
// Two steps, and the second never trusts the first:
//
//   plan()    reads the chain and says exactly what would happen — or why it
//             cannot (a token account pasted as a wallet, a brand-new address
//             below rent, a token whose program runs on every transfer).
//   execute() builds THAT plan, signs it under an approval the IPC handler
//             filed after the native dialog (signPolicy.ts checkSolSend /
//             checkTokenSend), simulates the SIGNED bytes, and sends only if
//             the full amount arrives and no more SOL leaves than it should.

import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAccountInfo, getBalance, getLatestBlockhashInfo, getTokenBalanceRaw, simulateTransaction } from '../chain/rpcClient';
import { broadcastAndConfirm } from './broadcast';
import { ATA_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ataFor, isOnCurve } from '../chain/addresses';
import { base58Decode, base58Encode } from '../chain/base58';
import { parseMintExtensions } from './mintExtensions';
import { tokenAmount } from './liveSigner';
import { RENT_EXEMPT_MIN_LAMPORTS, maxWithdrawableLamports } from './sweep';
import * as wallet from '../system/wallet';
import { SOLANA_EXPLORER_TX, formatUnits, parseUnits, type SendRequest, type SendResult, type SendReview } from '@shared/send';

/** A token account (165 bytes) costs this much rent to open. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
/** The signature fee plus the small priority price a token send carries. */
const NETWORK_FEE_LAMPORTS = 5_000;
const TOKEN_SEND_PRIORITY_MICROLAMPORTS = 10_000;
/** About what a sell costs to land (exit reserve, as the buy path keeps). */
const SELL_ROOM_LAMPORTS = 10_000_000;
/** Most SOL a token send may spend beyond the rent it declared. */
const TOKEN_SEND_SOL_SLACK_LAMPORTS = 50_000;
const LOADERS = new Set([
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
]);

export type SolanaSendBuild =
  | { kind: 'sol'; lamports: bigint }
  | {
      kind: 'token';
      mint: string;
      program: string;
      decimals: number;
      amount: bigint;
      destAta: string;
      needCreate: boolean;
      destBefore: bigint;
      transferFeeBps: number;
    };

export interface SolanaSendPlan {
  owner: string;
  review: SendReview;
  build: SolanaSendBuild;
}

type Planned = { ok: true; plan: SolanaSendPlan } | { ok: false; message: string };

function validAddress(s: string): boolean {
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

const sol = (lamports: bigint | number): string => `${formatUnits(BigInt(lamports), 9)} SOL`;

/** Read the chain and decide exactly what a send would do. Signs nothing. */
export async function plan(
  httpUrl: string,
  owner: string,
  req: SendRequest,
  symbolHint: string | null,
  /** Tokens the wallet holds (null = unknown): a SOL send that leaves too
   *  little to SELL them says so (swarm 2026-10-03, UX-9). */
  openPositions: number | null = null,
): Promise<Planned> {
  const to = req.to;
  if (!validAddress(to)) return { ok: false, message: 'That is not a Solana address.' };
  if (to === owner) return { ok: false, message: 'That is this wallet’s own address.' };
  const warnings: string[] = [];

  const [toInfo, balance] = await Promise.all([getAccountInfo(httpUrl, to), getBalance(httpUrl, owner, 'processed')]);
  if (!toInfo.ok) return { ok: false, message: `Could not check that address: ${toInfo.message}` };
  if (!balance.ok || balance.data === undefined) return { ok: false, message: `Could not read this wallet’s balance: ${balance.message}` };
  const recipient = toInfo.data;
  if (recipient && LOADERS.has(recipient.owner)) return { ok: false, message: 'That address is a program, not a wallet.' };
  if (recipient && (recipient.owner === TOKEN_PROGRAM || recipient.owner === TOKEN_2022_PROGRAM)) {
    return {
      ok: false,
      message: 'That address is a token account (or a token’s mint), not a wallet. Ask for their wallet address — the one their wallet app shows — not a token address.',
    };
  }
  const onCurve = isOnCurve(base58Decode(to));
  if (!onCurve) warnings.push('This address is not a normal wallet key — it belongs to a program. Make sure that program can receive this.');
  else if (recipient && recipient.owner !== SystemProgram.programId.toBase58()) {
    warnings.push(`This address is owned by a program (${recipient.owner.slice(0, 6)}…), not a plain wallet.`);
  }
  // No account = nothing there right now: brand new, or emptied. Either way
  // nothing proves it is the address they meant.
  if (!recipient) warnings.push('This address holds nothing on Solana right now (new or emptied). Double-check it — a typo cannot be undone.');

  // ── SOL ──────────────────────────────────────────────────────────────
  if (req.token === null) {
    const max = maxWithdrawableLamports(balance.data) ?? 0;
    const lamports = req.amount === 'max' ? BigInt(max) : parseUnits(req.amount, 9);
    if (lamports === null || lamports <= 0n) return { ok: false, message: 'Enter an amount.' };
    if (lamports > BigInt(max)) {
      return { ok: false, message: `That is more than this wallet can send — at most ${sol(max)} (a little stays behind for rent and the fee).` };
    }
    if (!recipient && lamports < BigInt(RENT_EXEMPT_MIN_LAMPORTS)) {
      return { ok: false, message: `A brand-new address must receive at least ${sol(RENT_EXEMPT_MIN_LAMPORTS)} — Solana refuses less.` };
    }
    const left = BigInt(balance.data) - lamports - BigInt(NETWORK_FEE_LAMPORTS);
    if (openPositions !== null && openPositions > 0 && left < BigInt(SELL_ROOM_LAMPORTS)) {
      warnings.push(`This leaves ${sol(left > 0n ? left : 0n)} — about ${sol(SELL_ROOM_LAMPORTS)} is needed to sell the ${openPositions} token${openPositions === 1 ? '' : 's'} this wallet holds.`);
    }
    return {
      ok: true,
      plan: {
        owner,
        build: { kind: 'sol', lamports },
        review: {
          chain: 'solana',
          from: owner,
          to,
          token: null,
          symbol: 'SOL',
          decimals: 9,
          amountRaw: lamports.toString(),
          amountText: sol(lamports),
          networkFeeText: sol(NETWORK_FEE_LAMPORTS),
          extraCostText: null,
          warnings,
        },
      },
    };
  }

  // ── A token ──────────────────────────────────────────────────────────
  const mint = req.token;
  if (!validAddress(mint)) return { ok: false, message: 'That is not a token address.' };
  const mintInfo = await getAccountInfo(httpUrl, mint);
  if (!mintInfo.ok) return { ok: false, message: `Could not read the token: ${mintInfo.message}` };
  const m = mintInfo.data;
  if (!m || (m.owner !== TOKEN_PROGRAM && m.owner !== TOKEN_2022_PROGRAM) || m.data.length < 82) {
    return { ok: false, message: 'That is not a token this wallet can send.' };
  }
  const program = m.owner;
  const decimals = m.data[44] ?? 0;
  const ext = program === TOKEN_2022_PROGRAM ? parseMintExtensions(m.data) : null;
  if (ext?.nonTransferable) return { ok: false, message: 'This token cannot be transferred at all — its issuer made it non-transferable.' };
  if (ext?.transferHook) {
    return { ok: false, message: 'This token runs its own program on every transfer, and Krypto Bot does not send through it. Export the key to a full wallet to move it.' };
  }
  const transferFeeBps = ext?.transferFeeBps ?? 0;
  if (transferFeeBps >= 10_000) return { ok: false, message: 'This token keeps 100% of every transfer — nothing would arrive.' };
  if (transferFeeBps > 0) warnings.push(`This token keeps ${transferFeeBps / 100}% of every transfer, so they receive that much less.`);
  if (ext?.permanentDelegate) warnings.push('This token’s issuer can move it out of any wallet at will (a permanent delegate).');
  if (ext?.defaultFrozen) warnings.push('This token freezes new accounts — if they have never held it, the send may fail.');
  const symbol = (ext?.symbol || symbolHint || '').trim().slice(0, 16) || `${mint.slice(0, 4)}…`;

  const source = ataFor(owner, mint, program);
  const destAta = ataFor(to, mint, program);
  const [held, destInfo] = await Promise.all([getTokenBalanceRaw(httpUrl, source), getAccountInfo(httpUrl, destAta)]);
  if (!held.ok || held.data === undefined) return { ok: false, message: `Could not read how much of it this wallet holds: ${held.message}` };
  if (!destInfo.ok) return { ok: false, message: `Could not check their token account: ${destInfo.message}` };
  if (held.data <= 0n) return { ok: false, message: `This wallet holds no ${symbol} in its main account for it.` };
  const amount = req.amount === 'max' ? held.data : parseUnits(req.amount, decimals);
  if (amount === null || amount <= 0n) return { ok: false, message: 'Enter an amount.' };
  if (amount > held.data) return { ok: false, message: `That is more than the ${formatUnits(held.data, decimals)} ${symbol} this wallet holds.` };

  const needCreate = destInfo.data === null;
  const solNeeded = BigInt(NETWORK_FEE_LAMPORTS + 10_000 + (needCreate ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0));
  if (BigInt(balance.data) < solNeeded + BigInt(RENT_EXEMPT_MIN_LAMPORTS)) {
    return {
      ok: false,
      message: `Not enough SOL to send it: this needs about ${sol(solNeeded)}${needCreate ? ' (most of it opens their account for this token)' : ''} and the wallet has ${sol(balance.data)}.`,
    };
  }
  const destData = destInfo.data?.data;
  const destBefore = !destData || destData.length < 72 ? 0n : destData.readBigUInt64LE(64);

  return {
    ok: true,
    plan: {
      owner,
      build: { kind: 'token', mint, program, decimals, amount, destAta, needCreate, destBefore, transferFeeBps },
      review: {
        chain: 'solana',
        from: owner,
        to,
        token: mint,
        symbol,
        decimals,
        amountRaw: amount.toString(),
        amountText: `${formatUnits(amount, decimals)} ${symbol}`,
        networkFeeText: sol(NETWORK_FEE_LAMPORTS + 2_000),
        extraCostText: needCreate ? `${sol(TOKEN_ACCOUNT_RENT_LAMPORTS)} to open their account for this token (they have never held it)` : null,
        warnings,
      },
    },
  };
}

function buildInstructions(owner: string, to: string, b: SolanaSendBuild): TransactionInstruction[] {
  const me = new PublicKey(owner);
  if (b.kind === 'sol') {
    return [SystemProgram.transfer({ fromPubkey: me, toPubkey: new PublicKey(to), lamports: b.lamports })];
  }
  const out: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TOKEN_SEND_PRIORITY_MICROLAMPORTS })];
  if (b.needCreate) {
    out.push(
      new TransactionInstruction({
        programId: new PublicKey(ATA_PROGRAM),
        keys: [
          { pubkey: me, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(b.destAta), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(to), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(b.mint), isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(b.program), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      }),
    );
  }
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(b.amount, 1);
  data[9] = b.decimals;
  out.push(
    new TransactionInstruction({
      programId: new PublicKey(b.program),
      keys: [
        { pubkey: new PublicKey(ataFor(owner, b.mint, b.program)), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(b.mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(b.destAta), isSigner: false, isWritable: true },
        { pubkey: me, isSigner: true, isWritable: false },
      ],
      data,
    }),
  );
  return out;
}

/**
 * Build, sign (under `approvalId`), simulate and send a plan. The approval
 * was filed for exactly this plan's address and amount; anything else is
 * refused by the signer before the key is decrypted.
 */
export async function execute(httpUrl: string, p: SolanaSendPlan, approvalId: string): Promise<SendResult> {
  const { owner, build: b } = p;
  const to = p.review.to;
  const fail = (message: string, txid: string | null = null): SendResult => ({ ok: false, message, txid, explorerUrl: txid ? SOLANA_EXPLORER_TX + txid : null });
  if (wallet.publicKey() !== owner) return fail('The active wallet changed — nothing was sent.');

  const bh = await getLatestBlockhashInfo(httpUrl);
  if (!bh.ok || !bh.data) return fail(`Could not reach Solana: ${bh.message}`);
  let base64: string;
  let sig = '';
  try {
    const msg = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: bh.data.blockhash, instructions: buildInstructions(owner, to, b) }).compileToV0Message();
    const unsigned = new VersionedTransaction(msg).serialize();
    const policy =
      b.kind === 'sol'
        ? { intent: 'send' as const, maxTransferLamports: Number(b.lamports), sendApprovalId: approvalId }
        : { intent: 'send-token' as const, maxTransferLamports: 0, sendApprovalId: approvalId };
    const signed = wallet.signVersionedTransaction(unsigned, policy);
    if (!signed.ok || !signed.signed) return fail(signed.message);
    base64 = Buffer.from(signed.signed).toString('base64');
    // Known BEFORE the broadcast: a lost reply must never read as "not sent".
    const first = VersionedTransaction.deserialize(signed.signed).signatures[0];
    sig = first ? base58Encode(first) : '';
    if (!sig) return fail('Could not read the signed send’s signature — nothing was sent.');
  } catch (err) {
    return fail((err as Error).message);
  }

  // ── Simulate the SIGNED bytes before anything leaves.
  const before = await getBalance(httpUrl, owner, 'processed');
  const watch = b.kind === 'sol' ? [owner, to] : [owner, b.destAta];
  const sim = await simulateTransaction(httpUrl, base64, watch);
  if (!sim.ok || !sim.data) return fail(`Could not check the send first: ${sim.message}. Nothing was sent.`);
  if (sim.data.err) return fail(`Solana refused this send: ${JSON.stringify(sim.data.err)}. Nothing was sent.`);
  const post = sim.data.postLamports[0];
  if (!before.ok || before.data === undefined || typeof post !== 'number') return fail('Could not read the balance for the safety check — nothing was sent.');
  const spent = BigInt(before.data - post);
  if (b.kind === 'sol') {
    if (spent > b.lamports + 10_000n) return fail('Refusing: the check spends more SOL than this send. Nothing was sent.');
  } else {
    const rent = b.needCreate ? BigInt(TOKEN_ACCOUNT_RENT_LAMPORTS) : 0n;
    if (spent > rent + BigInt(TOKEN_SEND_SOL_SLACK_LAMPORTS)) return fail('Refusing: the check spends more SOL than a token send should. Nothing was sent.');
    const arrived = tokenAmount(sim.data.postData[1] ?? null) - b.destBefore;
    const fee = b.transferFeeBps > 0 ? (b.amount * BigInt(b.transferFeeBps) + 9_999n) / 10_000n : 0n;
    if (arrived < b.amount - fee) return fail('Refusing: the check does not deliver the full amount to that address. Nothing was sent.');
  }

  // Same bytes re-sent every 2.5 s until confirmed or the blockhash dies: a
  // dropped packet is retried, and a lost reply is just followed by signature.
  const r = await broadcastAndConfirm({ httpUrl, base64, signature: sig, lanes: ['rpc'], lastValidBlockHeight: bh.data.lastValidBlockHeight });
  if (r.landed) return { ok: true, message: `Sent ${p.review.amountText}`, txid: sig, explorerUrl: SOLANA_EXPLORER_TX + sig };
  if (r.chainErr) return fail('The send failed on chain — nothing moved but the network fee.', sig);
  if (r.expired) return fail('The send expired before Solana confirmed it, so it can no longer land — nothing moved. You can send again.', sig);
  // Stopped waiting while it might still land: NOT a failure, and not a reason
  // to send again until the explorer says what happened.
  return fail(`Sent, but not confirmed yet — check the explorer link before sending ${p.review.amountText} again.`, sig);
}
