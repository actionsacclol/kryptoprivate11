// ATA rent sweeper — reclaims the ~0.00203 SOL rent stranded in every
// token account left open after a sell. The 2026-07-24 swarm measured
// ~0.203 SOL already stranded across ~100 live buys: at a 0.03 SOL stake
// the rent is 6.8% of the position — bigger than pump fees. Local-built
// sells now close their ATA atomically (txBuilder); this sweeper recovers
// everything else: relayer-path sells, historical dust, crashed sessions.
//
// Only ZERO-balance accounts are ever closed (the token program rejects
// closing a funded account anyway, but we don't even try). Each batch is
// simulated before broadcast; closes only ADD lamports to the wallet, so
// there is nothing to loss-guard.

import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { getTokenAccountsByOwner, getLatestBlockhash, simulateTransaction } from './rpcClient';
import { broadcastAndConfirm } from './broadcast';
import { base58Encode } from './base58';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './addresses';
import * as wallet from '../system/wallet';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CLOSES_PER_TX = 10;
const RENT_PER_ATA_SOL = 0.00203928;

export interface SweepResult {
  ok: boolean;
  message: string;
  closed: number;
  recoveredSolEst: number;
}

/** Close every zero-balance token account the wallet owns (both token
 *  programs, wSOL excluded), in batches. Returns after all batches settle. */
export async function sweepAtaRent(httpUrl: string): Promise<SweepResult> {
  const owner = wallet.publicKey();
  if (!owner) return { ok: false, message: 'No trading wallet', closed: 0, recoveredSolEst: 0 };

  const accounts = await getTokenAccountsByOwner(httpUrl, owner);
  if (!accounts.ok || !accounts.data) {
    return { ok: false, message: `holdings fetch failed: ${accounts.message}`, closed: 0, recoveredSolEst: 0 };
  }
  // Zero balance only. Note uiAmount is 0 (not null) for empty accounts here
  // because rpcClient already coalesces null → 0.
  const empties = accounts.data.filter((h) => h.mint !== WSOL_MINT && BigInt(h.amountRaw) === 0n);
  if (empties.length === 0) return { ok: true, message: 'no empty token accounts', closed: 0, recoveredSolEst: 0 };

  // The account's owner PROGRAM executes the close — group batches by it.
  const byProgram = new Map<string, string[]>([
    [TOKEN_PROGRAM, []],
    [TOKEN_2022_PROGRAM, []],
  ]);
  for (const e of empties) byProgram.get(e.programId)?.push(e.tokenAccount);

  let closed = 0;
  const failures: string[] = [];
  for (const [programId, accts] of byProgram) {
    for (let i = 0; i < accts.length; i += CLOSES_PER_TX) {
      const batch = accts.slice(i, i + CLOSES_PER_TX);
      const res = await closeBatch(httpUrl, owner, programId, batch);
      if (res.ok) closed += batch.length;
      else failures.push(res.message);
    }
  }
  const msg =
    failures.length === 0
      ? `closed ${closed} empty token account(s), ~${(closed * RENT_PER_ATA_SOL).toFixed(4)} SOL reclaimed`
      : `closed ${closed}, ${failures.length} batch(es) failed: ${failures[0]}`;
  return { ok: failures.length === 0, message: msg, closed, recoveredSolEst: closed * RENT_PER_ATA_SOL };
}

async function closeBatch(
  httpUrl: string,
  owner: string,
  programId: string,
  tokenAccounts: string[],
): Promise<{ ok: boolean; message: string }> {
  const ownerKey = new PublicKey(owner);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 6_000 * tokenAccounts.length + 2_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ...tokenAccounts.map(
      (acct) =>
        new TransactionInstruction({
          programId: new PublicKey(programId),
          keys: [
            { pubkey: new PublicKey(acct), isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: false, isWritable: true },
            { pubkey: ownerKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]), // CloseAccount
        }),
    ),
  ];
  const bh = await getLatestBlockhash(httpUrl);
  if (!bh.ok || !bh.data) return { ok: false, message: `blockhash: ${bh.message}` };
  let unsigned: Uint8Array;
  try {
    const msg = MessageV0.compile({ payerKey: ownerKey, instructions, recentBlockhash: bh.data });
    unsigned = new VersionedTransaction(msg).serialize();
  } catch (err) {
    return { ok: false, message: `compile: ${(err as Error).message}` };
  }
  // Reclaiming ATA rent moves lamports INTO the wallet; a correct one has no
  // outgoing transfer at all, so the cap is zero.
  const signed = wallet.signVersionedTransaction(unsigned, {
    intent: 'rent-reclaim',
    maxTransferLamports: 0,
  });
  if (!signed.ok || !signed.signed) return { ok: false, message: signed.message };
  const base64 = Buffer.from(signed.signed).toString('base64');
  const sim = await simulateTransaction(httpUrl, base64, [owner]);
  if (!sim.ok || !sim.data) return { ok: false, message: `simulate: ${sim.message}` };
  if (sim.data.err) return { ok: false, message: `simulation reverted: ${JSON.stringify(sim.data.err).slice(0, 120)}` };
  const signature = base58Encode(VersionedTransaction.deserialize(signed.signed).signatures[0]);
  const cast = await broadcastAndConfirm({ httpUrl, base64, signature, lanes: ['rpc'], timeoutMs: 45_000 });
  if (cast.chainErr) return { ok: false, message: `reverted on-chain ${signature.slice(0, 12)}…` };
  if (!cast.landed) return { ok: false, message: `expired unconfirmed ${signature.slice(0, 12)}…` };
  return { ok: true, message: `landed ${signature.slice(0, 12)}…` };
}
