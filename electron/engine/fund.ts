// Wallet Lab funding — SOL between the user's OWN wallets.
//
// fundWallets: transactions from the active wallet with one transfer per
// target, twelve targets per transaction. collectToActive: each listed
// wallet sends its spare SOL back to the active wallet, one transaction each
// (they are different signers). A chunk counts only once it has CONFIRMED;
// an expired or unconfirmed chunk is reported as not sent.
//
// The signer sees intent 'fund' with an explicit allowlist of destinations
// — the public keys of wallets this install holds — and refuses anything
// else in the transaction. A destination is never taken from the caller's
// word alone: ipc.ts resolves wallet IDS to keys from the store.

import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as wallet from '../system/wallet';
import { getBalance, getBlockHeight, getLatestBlockhashInfo, getSignatureStatuses, sendRawTransaction } from './rpcClient';
import { RENT_EXEMPT_LAMPORTS } from '@shared/lab';

const TX_FEE_HEADROOM_LAMPORTS = 10_000;
/** Transfers per transaction — well under the 1232-byte cap. */
const MAX_TRANSFERS_PER_TX = 12;
/** A small priority fee so a base-fee-only transfer is not the first thing
 *  dropped under load: 20k CU × 100k µlamports = 2 000 lamports, inside the
 *  per-transaction headroom above. */
const CU_LIMIT = 20_000;
const CU_PRICE_MICRO = 100_000;

export interface FundOutcome {
  ok: boolean;
  message: string;
  signature?: string;
  sentLamports: number;
  count: number;
}

/**
 * Confirmed, failed, or expired — never "probably". A transfer that has not
 * confirmed by the time its blockhash expires cannot land later, so it is
 * reported as NOT sent; nothing here rebroadcasts, and the caller's counts
 * only include confirmed chunks.
 */
async function confirm(httpUrl: string, signature: string, lastValidBlockHeight: number): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const st = await getSignatureStatuses(httpUrl, [signature]);
    const s0 = st.ok && st.data ? st.data[0] : null;
    if (s0?.confirmationStatus === 'confirmed' || s0?.confirmationStatus === 'finalized') return { ok: true, message: 'confirmed' };
    if (s0?.err) return { ok: false, message: 'transfer failed on-chain' };
    const h = await getBlockHeight(httpUrl);
    if (h.ok && h.data !== undefined && h.data > lastValidBlockHeight) {
      // One last look: a status can lag the block height by a slot.
      const again = await getSignatureStatuses(httpUrl, [signature]);
      const a0 = again.ok && again.data ? again.data[0] : null;
      if (a0?.confirmationStatus === 'confirmed' || a0?.confirmationStatus === 'finalized') return { ok: true, message: 'confirmed' };
      return { ok: false, message: 'expired before it confirmed — nothing moved; try again' };
    }
  }
  return { ok: false, message: `not confirmed after 90 s — check the signature ${signature.slice(0, 12)}… on chain before retrying` };
}

async function sendTransfers(
  httpUrl: string,
  signer: { walletId?: string; publicKey: string },
  targets: Array<{ publicKey: string; lamports: number }>,
): Promise<FundOutcome> {
  const total = targets.reduce((a, t) => a + t.lamports, 0);
  const bh = await getLatestBlockhashInfo(httpUrl);
  if (!bh.ok || !bh.data) return { ok: false, message: `blockhash: ${bh.message}`, sentLamports: 0, count: 0 };
  const from = new PublicKey(signer.publicKey);
  const msg = new TransactionMessage({
    payerKey: from,
    recentBlockhash: bh.data.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO }),
      ...targets.map((t) => SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(t.publicKey), lamports: t.lamports })),
    ],
  }).compileToV0Message();
  const unsigned = new VersionedTransaction(msg).serialize();
  const policy = { intent: 'fund' as const, maxTransferLamports: total, fundTargets: targets.map((t) => t.publicKey) };
  const signed = signer.walletId
    ? wallet.signVersionedTransactionForWallet(signer.walletId, unsigned, policy)
    : wallet.signVersionedTransaction(unsigned, policy);
  if (!signed.ok || !signed.signed) return { ok: false, message: signed.message, sentLamports: 0, count: 0 };
  const sent = await sendRawTransaction(httpUrl, Buffer.from(signed.signed).toString('base64'));
  if (!sent.ok || !sent.data) return { ok: false, message: `broadcast: ${sent.message}`, sentLamports: 0, count: 0 };
  const c = await confirm(httpUrl, sent.data, bh.data.lastValidBlockHeight);
  return { ok: c.ok, message: c.message, signature: sent.data, sentLamports: c.ok ? total : 0, count: c.ok ? targets.length : 0 };
}

/** Active wallet → own wallets. Chunks past MAX_TRANSFERS_PER_TX go out as
 *  further transactions; the outcome reports the total that landed. */
export async function fundWallets(
  httpUrl: string,
  targets: Array<{ publicKey: string; lamports: number }>,
  /** Which of this install's wallets the SOL leaves; the active one if absent. */
  fromWalletId?: string,
): Promise<FundOutcome> {
  const owner = fromWalletId ? wallet.publicKeyOf(fromWalletId) : wallet.publicKey();
  if (!owner) return { ok: false, message: fromWalletId ? 'No such wallet to fund from' : 'No active wallet', sentLamports: 0, count: 0 };
  const own = new Set(wallet.list().map((w) => w.publicKey));
  for (const t of targets) {
    if (!own.has(t.publicKey)) return { ok: false, message: `${t.publicKey.slice(0, 8)}… is not one of this install's wallets`, sentLamports: 0, count: 0 };
    if (t.publicKey === owner) return { ok: false, message: 'The source wallet cannot fund itself', sentLamports: 0, count: 0 };
    if (!(t.lamports >= RENT_EXEMPT_LAMPORTS)) return { ok: false, message: 'Every target must receive at least the rent-exempt minimum', sentLamports: 0, count: 0 };
  }
  const total = targets.reduce((a, t) => a + t.lamports, 0);
  const bal = await getBalance(httpUrl, owner);
  if (!bal.ok || bal.data === undefined) return { ok: false, message: `balance: ${bal.message}`, sentLamports: 0, count: 0 };
  if (bal.data - total < RENT_EXEMPT_LAMPORTS + TX_FEE_HEADROOM_LAMPORTS * Math.ceil(targets.length / MAX_TRANSFERS_PER_TX)) {
    return { ok: false, message: 'The source wallet would be left below rent + fees', sentLamports: 0, count: 0 };
  }
  let sent = 0;
  let count = 0;
  let last: string | undefined;
  for (let i = 0; i < targets.length; i += MAX_TRANSFERS_PER_TX) {
    const chunk = targets.slice(i, i + MAX_TRANSFERS_PER_TX);
    if (i > 0) {
      // The earlier chunk waited on confirmation; other paths may have
      // spent from this wallet meanwhile, so the balance is read again.
      const chunkTotal = chunk.reduce((a, t) => a + t.lamports, 0);
      const now = await getBalance(httpUrl, owner);
      if (!now.ok || now.data === undefined) return { ok: false, message: `balance: ${now.message} (after ${count} wallet(s) funded)`, signature: last, sentLamports: sent, count };
      if (now.data - chunkTotal < RENT_EXEMPT_LAMPORTS + TX_FEE_HEADROOM_LAMPORTS) {
        return { ok: false, message: `the source wallet no longer covers the next batch (after ${count} wallet(s) funded)`, signature: last, sentLamports: sent, count };
      }
    }
    const r = await sendTransfers(httpUrl, { walletId: fromWalletId, publicKey: owner }, chunk);
    if (!r.ok) return { ok: false, message: `${r.message} (after ${count} wallet(s) funded)`, signature: r.signature ?? last, sentLamports: sent, count };
    sent += r.sentLamports;
    count += r.count;
    last = r.signature;
  }
  return { ok: true, message: `${count} wallet(s) funded`, signature: last, sentLamports: sent, count };
}

export interface CollectOutcome {
  walletId: string;
  ok: boolean;
  message: string;
  lamports: number;
  signature: string | null;
}

/** Each wallet sends everything above rent + fee back to the ACTIVE wallet. */
export async function collectToActive(httpUrl: string, walletIds: string[], toWalletId?: string): Promise<CollectOutcome[]> {
  // "Active" in the name is the default, not the rule: since 2026-09-11 the
  // destination can be any of this install's wallets.
  const active = toWalletId ? wallet.publicKeyOf(toWalletId) : wallet.publicKey();
  const out: CollectOutcome[] = [];
  if (!active) return walletIds.map((walletId) => ({ walletId, ok: false, message: toWalletId ? 'No such wallet to collect to' : 'No active wallet', lamports: 0, signature: null }));
  for (const walletId of walletIds) {
    const pk = wallet.publicKeyOf(walletId);
    if (!pk) {
      out.push({ walletId, ok: false, message: 'No such wallet', lamports: 0, signature: null });
      continue;
    }
    if (pk === active) {
      out.push({ walletId, ok: false, message: 'This is the destination wallet', lamports: 0, signature: null });
      continue;
    }
    const bal = await getBalance(httpUrl, pk);
    if (!bal.ok || bal.data === undefined) {
      out.push({ walletId, ok: false, message: `balance: ${bal.message}`, lamports: 0, signature: null });
      continue;
    }
    const spare = bal.data - RENT_EXEMPT_LAMPORTS - TX_FEE_HEADROOM_LAMPORTS;
    if (spare < 10_000) {
      out.push({ walletId, ok: false, message: 'Nothing to collect above rent', lamports: 0, signature: null });
      continue;
    }
    const r = await sendTransfers(httpUrl, { walletId, publicKey: pk }, [{ publicKey: active, lamports: spare }]);
    out.push({ walletId, ok: r.ok, message: r.message, lamports: r.ok ? spare : 0, signature: r.signature ?? null });
  }
  return out;
}
