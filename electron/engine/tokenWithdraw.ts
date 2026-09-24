// Withdraw USDC to a wallet's confirmed withdrawal address (2026-09-23).
//
// pump.fun pays callout rewards in USDC to the account's wallet. The app
// could see that USDC and swap it, but not move it — by design: the signer
// lets money leave only as a trade, or as SOL to the wallet's stored
// withdrawal address. This adds the USDC twin of that SOL withdrawal and
// nothing wider:
//
//   · the destination is the withdrawal address STORED on the wallet, read
//     by the signer itself — this module is handed no destination at all;
//   · the signer's 'withdraw-token' rule (signPolicy.ts) accepts exactly one
//     checked USDC transfer to that address's token account, plus at most one
//     idempotent create of that account, and refuses everything else;
//   · the signed bytes are simulated first, and nothing is sent unless the
//     full amount ARRIVES at the withdrawal address and no more SOL leaves
//     than the account rent and the network fee.

import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAccountInfo, getBalance, getLatestBlockhash, getSignatureStatuses, getTokenBalanceRawForMint, sendRawTransaction, simulateTransaction } from '../chain/rpcClient';
import { ATA_PROGRAM, TOKEN_PROGRAM, ataFor } from '../chain/addresses';
import { WITHDRAWABLE_TOKENS } from '../system/signPolicy';
import { tokenAmount } from './liveSigner';
import * as wallet from '../system/wallet';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
/** A token account's rent (165 bytes) is 2,039,280 lamports; the network fee
 *  and a small priority fee sit on top. Anything over this is refused. */
const MAX_SOL_SPEND_LAMPORTS = 2_039_280 + 50_000;

export interface TokenWithdrawResult {
  ok: boolean;
  message: string;
  signature?: string;
  /** Base units sent (USDC has 6 decimals). */
  amountRaw?: string;
  dest?: string | null;
}

/** What a wallet holds of USDC, in base units; null when it cannot be read. */
export async function usdcHeld(httpUrl: string, owner: string): Promise<bigint | null> {
  const r = await getTokenBalanceRawForMint(httpUrl, owner, USDC_MINT);
  return r.ok && r.data ? r.data.raw : null;
}

export async function withdrawUsdc(
  httpUrl: string,
  opts: { walletId?: string; amountRaw: bigint | 'max' },
): Promise<TokenWithdrawResult> {
  const mint = USDC_MINT;
  if (!WITHDRAWABLE_TOKENS.has(mint)) return { ok: false, message: 'USDC withdrawals are not enabled in this build.' };
  const owner = opts.walletId ? wallet.publicKeyOf(opts.walletId) : wallet.publicKey();
  if (!owner) return { ok: false, message: opts.walletId ? 'No such wallet' : 'No trading wallet' };
  const home = wallet.list().find((w) => w.publicKey === owner)?.homeAddress ?? null;
  if (!home) return { ok: false, message: 'Set a withdrawal address for this wallet first.', dest: null };

  const held = await usdcHeld(httpUrl, owner);
  if (held === null) return { ok: false, message: 'Could not read this wallet’s USDC balance — nothing was sent.', dest: home };
  const amount = opts.amountRaw === 'max' ? held : opts.amountRaw;
  if (amount <= 0n) return { ok: false, message: 'This wallet holds no USDC to withdraw.', dest: home };
  if (amount > held) {
    return { ok: false, message: `That is more than the ${(Number(held) / 10 ** USDC_DECIMALS).toFixed(2)} USDC this wallet holds.`, dest: home };
  }

  const source = ataFor(owner, mint, TOKEN_PROGRAM);
  const dest = ataFor(home, mint, TOKEN_PROGRAM);
  const destInfo = await getAccountInfo(httpUrl, dest);
  if (!destInfo.ok) return { ok: false, message: `Could not check the withdrawal address: ${destInfo.message}`, dest: home };
  const needCreate = destInfo.data === null;

  const bh = await getLatestBlockhash(httpUrl);
  if (!bh.ok || !bh.data) return { ok: false, message: `blockhash: ${bh.message}`, dest: home };

  const me = new PublicKey(owner);
  const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })];
  if (needCreate) {
    // The withdrawal address has no USDC account yet: create it, paid by us.
    instructions.push(
      new TransactionInstruction({
        programId: new PublicKey(ATA_PROGRAM),
        keys: [
          { pubkey: me, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(dest), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(home), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      }),
    );
  }
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = USDC_DECIMALS;
  instructions.push(
    new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM),
      keys: [
        { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(dest), isSigner: false, isWritable: true },
        { pubkey: me, isSigner: true, isWritable: false },
      ],
      data,
    }),
  );

  try {
    const msg = new TransactionMessage({ payerKey: me, recentBlockhash: bh.data, instructions }).compileToV0Message();
    const unsigned = new VersionedTransaction(msg).serialize();
    const policy = { intent: 'withdraw-token' as const, maxTransferLamports: 0, withdrawMint: mint };
    const signed = opts.walletId
      ? wallet.signVersionedTransactionForWallet(opts.walletId, unsigned, policy)
      : wallet.signVersionedTransaction(unsigned, policy);
    if (!signed.ok || !signed.signed) return { ok: false, message: signed.message, dest: home };
    const base64 = Buffer.from(signed.signed).toString('base64');

    // ── Simulate the SIGNED bytes: the amount must arrive, and SOL spend is bounded.
    const before = await getBalance(httpUrl, owner, 'processed');
    // A token account keeps its amount at byte 64 (u64, little-endian).
    const destData = destInfo.data?.data;
    const destBefore = needCreate || !destData || destData.length < 72 ? 0n : destData.readBigUInt64LE(64);
    const sim = await simulateTransaction(httpUrl, base64, [owner, dest]);
    if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the withdrawal: ${sim.message}`, dest: home };
    if (sim.data.err) return { ok: false, message: `The chain refused this withdrawal: ${JSON.stringify(sim.data.err)}. Nothing was sent.`, dest: home };
    const post = sim.data.postLamports[0];
    if (!before.ok || before.data === undefined || typeof post !== 'number') {
      return { ok: false, message: 'Could not read the balance for the safety check — nothing was sent.', dest: home };
    }
    if (before.data - post > MAX_SOL_SPEND_LAMPORTS) {
      return { ok: false, message: 'Refusing: the simulation spends more SOL than a withdrawal should. Nothing was sent.', dest: home };
    }
    const arrived = tokenAmount(sim.data.postData[1] ?? null) - destBefore;
    if (arrived < amount) {
      return { ok: false, message: 'Refusing: the simulation does not deliver the full amount to your withdrawal address. Nothing was sent.', dest: home };
    }

    const sent = await sendRawTransaction(httpUrl, base64);
    if (!sent.ok || !sent.data) return { ok: false, message: `broadcast: ${sent.message}`, dest: home };
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await getSignatureStatuses(httpUrl, [sent.data]);
      const s0 = st.ok && st.data ? st.data[0] : null;
      if (s0?.err) return { ok: false, message: 'The withdrawal failed on chain — nothing moved.', signature: sent.data, dest: home };
      if (s0?.confirmationStatus === 'confirmed' || s0?.confirmationStatus === 'finalized') {
        return { ok: true, message: 'confirmed', signature: sent.data, amountRaw: amount.toString(), dest: home };
      }
    }
    return { ok: true, message: 'submitted (confirmation pending)', signature: sent.data, amountRaw: amount.toString(), dest: home };
  } catch (err) {
    return { ok: false, message: (err as Error).message, dest: home };
  }
}
