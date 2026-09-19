// Profit sweep / user withdrawal — a plain SystemProgram transfer from a
// trading wallet to the user's withdrawal (home) address. Signed through the
// same hardened wallet signer as trades: fee payer must be our wallet, exactly
// one signature, key decrypted transiently and scrubbed.

import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getLatestBlockhash, sendRawTransaction, getSignatureStatuses } from '../chain/rpcClient';
import * as wallet from '../system/wallet';

export interface SweepResult {
  ok: boolean;
  message: string;
  signature?: string;
}

/** Rent-exempt minimum for a 0-data system account (mainnet, 2026). A wallet
 *  drained below this is garbage-collected and any later deposit-by-transfer
 *  still works, but a subsequent trade would fail on rent. We keep it. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880;
/** Headroom for the transfer's own signature fee (5,000) plus a margin. */
export const WITHDRAW_FEE_HEADROOM_LAMPORTS = 10_000;

/**
 * The most a user may withdraw from a balance: everything except the
 * rent-exempt minimum and fee headroom. Floored at 0; an unknown balance is
 * the caller's problem (honest-null: pass null and get null back).
 */
export function maxWithdrawableLamports(balanceLamports: number | null | undefined): number | null {
  if (balanceLamports === null || balanceLamports === undefined || !Number.isFinite(balanceLamports)) return null;
  const n = Math.floor(balanceLamports) - RENT_EXEMPT_MIN_LAMPORTS - WITHDRAW_FEE_HEADROOM_LAMPORTS;
  return n > 0 ? n : 0;
}

export interface SweepOptions {
  /** Sign with a specific wallet (multi-wallet withdraw). Defaults to the
   *  ACTIVE wallet — the historical single-signer path. */
  walletId?: string;
}

export async function sweepLamports(
  httpUrl: string,
  dest: string,
  lamports: number,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  // Mirror liveSigner: an explicit walletId picks that wallet's key, else the
  // active one. The policy below is identical either way.
  const owner = opts.walletId ? wallet.publicKeyOf(opts.walletId) : wallet.publicKey();
  if (!owner) return { ok: false, message: opts.walletId ? 'No such wallet' : 'No trading wallet' };
  if (!Number.isFinite(lamports) || !(lamports >= 10_000)) return { ok: false, message: 'Sweep amount too small' };

  const bh = await getLatestBlockhash(httpUrl);
  if (!bh.ok || !bh.data) return { ok: false, message: `blockhash: ${bh.message}` };

  try {
    const from = new PublicKey(owner);
    const msg = new TransactionMessage({
      payerKey: from,
      recentBlockhash: bh.data,
      instructions: [
        SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(dest), lamports: Math.floor(lamports) }),
      ],
    }).compileToV0Message();
    const unsigned = new VersionedTransaction(msg);

    // The signer independently re-checks that this is a single transfer to the
    // STORED withdrawal address of THAT wallet — `dest` being passed in is not
    // enough, and a walletId gets no shortcut around the policy.
    const policy = { intent: 'sweep' as const, maxTransferLamports: Math.floor(lamports) };
    const signed = opts.walletId
      ? wallet.signVersionedTransactionForWallet(opts.walletId, unsigned.serialize(), policy)
      : wallet.signVersionedTransaction(unsigned.serialize(), policy);
    if (!signed.ok || !signed.signed) return { ok: false, message: signed.message };

    const sent = await sendRawTransaction(httpUrl, Buffer.from(signed.signed).toString('base64'));
    if (!sent.ok || !sent.data) return { ok: false, message: `broadcast: ${sent.message}` };

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await getSignatureStatuses(httpUrl, [sent.data]);
      const s0 = st.ok && st.data ? st.data[0] : null;
      if (s0?.confirmationStatus === 'confirmed' || s0?.confirmationStatus === 'finalized') {
        return { ok: true, message: 'confirmed', signature: sent.data };
      }
      if (s0?.err) return { ok: false, message: 'transfer failed on-chain', signature: sent.data };
    }
    return { ok: true, message: 'submitted (confirmation pending)', signature: sent.data };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
