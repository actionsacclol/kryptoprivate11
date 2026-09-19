// Collecting what a token you launched has earned you.
//
// The launcher shipped without this, which was the wrong order: a user could
// create a token on pump, watch it trade, accrue a creator fee — and have no
// way to collect it from inside the app. Shipping the earning half without
// the collecting half leaves money sitting in a PDA the user does not know
// exists.
//
// ─── Read from pump's own IDL, not from memory ───────────────────────────
//
// Same discipline as `pumpLaunch.ts`. The discriminator and all five accounts
// below came out of the on-chain Anchor IDL at
// `createWithSeed(<pump PDA>, 'anchor:idl', <pump>)`, read 2026-09-11. The
// IDL says `collect_creator_fee` takes NO arguments and five accounts, in
// this order, and that `creator` is not a required signer — which is why this
// is an ordinary one-signature transaction and never touches the launch
// intent.
//
// ─── The vault is per CREATOR, not per token ─────────────────────────────
//
// `["creator-vault", creator]`. Every coin that wallet has ever launched pays
// into the same account, so one claim collects everything at once and there
// is no per-token list to walk. That is why this module needs no mint.
//
// ─── What it does not do ─────────────────────────────────────────────────
//
// `collect_creator_fee_v2` (discriminator cf118af204221338) collects fees
// denominated in a QUOTE TOKEN rather than SOL, and needs four more accounts
// to do it. Coins this app launches are SOL-quoted, so v1 is the right
// instruction for them. A creator whose fees accrued in a quote token is not
// served here, and the UI says so rather than showing them a zero.

import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as wallet from '../system/wallet';
import { logger } from '../system/logger';
import { PUMP_PROGRAM } from './pumpLaunch';
import { getBalance, getBlockHeight, getLatestBlockhashInfo, getSignatureStatuses, sendRawTransaction, simulateTransaction } from '../chain/rpcClient';
import { anchorReason } from './liveSigner';
import { RENT_EXEMPT_LAMPORTS } from '@shared/lab';

/** sha256("global:collect_creator_fee")[0..8], per pump's on-chain IDL. */
export const COLLECT_CREATOR_FEE_DISCRIMINATOR = Buffer.from('1416567bc61cdb84', 'hex');
/** The quote-token variant. Recognised by the signer, not built here. */
export const COLLECT_CREATOR_FEE_V2_DISCRIMINATOR = Buffer.from('cf118af204221338', 'hex');

const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

const pda = (seeds: Buffer[]): PublicKey => PublicKey.findProgramAddressSync(seeds, PUMP_PROGRAM)[0];

/** Where this creator's fees accumulate, across every coin they launched. */
export const creatorVaultOf = (creator: PublicKey): PublicKey => pda([Buffer.from('creator-vault'), creator.toBuffer()]);

/**
 * `collect_creator_fee`'s five accounts, in IDL order.
 *
 * `creator` is writable and NOT a signer — pump lets anyone crank a
 * collection, and the lamports go to the creator either way. We are both the
 * creator and the fee payer, so it signs as slot 0 regardless.
 */
export function collectAccounts(creator: PublicKey): TransactionInstruction['keys'] {
  return [
    { pubkey: creator, isSigner: false, isWritable: true }, // 0 creator
    { pubkey: creatorVaultOf(creator), isSigner: false, isWritable: true }, // 1 creator_vault
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, // 2 system_program
    { pubkey: pda([Buffer.from('__event_authority')]), isSigner: false, isWritable: false }, // 3 event_authority
    { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false }, // 4 program
  ];
}

export function collectInstruction(creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: collectAccounts(creator),
    data: COLLECT_CREATOR_FEE_DISCRIMINATOR,
  });
}

/**
 * What a vault holds, and what of that can actually be taken.
 *
 * A PDA must keep its rent-exempt minimum to keep existing, so the claimable
 * amount is the balance ABOVE that — never the balance. Reporting the raw
 * balance would show a user 0.00089 SOL they can never have.
 */
export interface CreatorFees {
  vault: string;
  /** Lamports in the vault, or null when the chain could not be asked. */
  balanceLamports: number | null;
  /** Lamports that would actually arrive. Null when the balance is unknown. */
  claimableLamports: number | null;
  failure: string | null;
}

export async function readCreatorFees(httpUrl: string, creatorKey: string): Promise<CreatorFees> {
  let creator: PublicKey;
  try {
    creator = new PublicKey(creatorKey);
  } catch {
    return { vault: '', balanceLamports: null, claimableLamports: null, failure: 'That is not a valid wallet address.' };
  }
  const vault = creatorVaultOf(creator);
  const bal = await getBalance(httpUrl, vault.toBase58());
  if (!bal.ok || bal.data === undefined) {
    // Unknown is not zero. A user whose RPC hiccuped must not be told they
    // have earned nothing.
    return { vault: vault.toBase58(), balanceLamports: null, claimableLamports: null, failure: bal.message };
  }
  return {
    vault: vault.toBase58(),
    balanceLamports: bal.data,
    claimableLamports: Math.max(0, bal.data - RENT_EXEMPT_LAMPORTS),
    failure: null,
  };
}

const CU_LIMIT = 40_000;
const CU_PRICE_MICRO = 100_000;

export interface ClaimResult {
  ok: boolean;
  message: string;
  signature?: string;
  claimedLamports?: number;
}

/** Confirmed, failed, or provably dead — the shape every send in this app uses. */
async function confirm(httpUrl: string, signature: string, lastValidBlockHeight: number): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const st = await getSignatureStatuses(httpUrl, [signature]);
    const s0 = st.ok && st.data ? st.data[0] : null;
    if (s0?.confirmationStatus === 'confirmed' || s0?.confirmationStatus === 'finalized') {
      return s0.err ? { ok: false, message: 'The claim failed on chain — nothing moved.' } : { ok: true, message: 'confirmed' };
    }
    const h = await getBlockHeight(httpUrl);
    if (h.ok && h.data !== undefined && h.data > lastValidBlockHeight) {
      const again = await getSignatureStatuses(httpUrl, [signature]);
      const a0 = again.ok && again.data ? again.data[0] : null;
      if (a0?.confirmationStatus === 'confirmed' || a0?.confirmationStatus === 'finalized') {
        return a0.err ? { ok: false, message: 'The claim failed on chain — nothing moved.' } : { ok: true, message: 'confirmed' };
      }
      return { ok: false, message: 'The claim expired before it confirmed. Nothing moved; try again.' };
    }
  }
  return { ok: false, message: `Not confirmed after 90 s. Check ${signature.slice(0, 12)} on chain before retrying.` };
}

/**
 * Claim this wallet's creator fees.
 *
 * Ordinary one-signature transaction under its own intent, so the signer can
 * tell a fee claim from a trade in a log and can hold it to a tighter rule
 * than either: see `checkCollectFees` in signPolicy.ts.
 */
export async function claimCreatorFees(httpUrl: string, walletId: string): Promise<ClaimResult> {
  const creatorKey = wallet.publicKeyOf(walletId);
  if (!creatorKey) return { ok: false, message: 'That wallet no longer exists.' };

  const fees = await readCreatorFees(httpUrl, creatorKey);
  if (fees.failure) return { ok: false, message: `Could not read your creator vault: ${fees.failure}` };
  if (!fees.claimableLamports) {
    return { ok: false, message: 'There is nothing to claim — this wallet has no creator fees above the vault rent.' };
  }

  const bh = await getLatestBlockhashInfo(httpUrl);
  if (!bh.ok || !bh.data) return { ok: false, message: `Could not reach the chain: ${bh.message}` };

  const creator = new PublicKey(creatorKey);
  const msg = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: bh.data.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO }),
      collectInstruction(creator),
    ],
  }).compileToV0Message();

  const unsigned = new VersionedTransaction(msg).serialize();
  // A claim moves lamports INTO this wallet and nothing out of it at top
  // level, so the outflow ceiling is zero: a transfer smuggled in beside the
  // collect is refused by the policy rather than by review.
  const signed = wallet.signVersionedTransactionForWallet(walletId, unsigned, { intent: 'collect-fees', maxTransferLamports: 0 });
  if (!signed.ok || !signed.signed) {
    logger.error(`creator-fee claim refused by the signer: ${signed.message}`);
    return { ok: false, message: signed.message };
  }
  const base64 = Buffer.from(signed.signed).toString('base64');

  const sim = await simulateTransaction(httpUrl, base64, []);
  if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the claim: ${sim.message}` };
  if (sim.data.err) {
    const why = anchorReason(sim.data.logs) ?? JSON.stringify(sim.data.err);
    return { ok: false, message: `The chain refused this claim: ${why}. Nothing moved.` };
  }

  const sent = await sendRawTransaction(httpUrl, base64);
  if (!sent.ok || !sent.data) return { ok: false, message: `Could not send the claim: ${sent.message}` };
  logger.info(`creator fees: claiming ${fees.claimableLamports} lamports for ${creatorKey.slice(0, 8)} as ${sent.data}`);
  const c = await confirm(httpUrl, sent.data, bh.data.lastValidBlockHeight);
  return { ok: c.ok, message: c.message, signature: sent.data, claimedLamports: c.ok ? fees.claimableLamports : 0 };
}
