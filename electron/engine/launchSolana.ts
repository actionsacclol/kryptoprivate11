// Creating a token on pump.fun — the send half.
//
// `pumpLaunch.ts` builds the instruction and a fixture test pins it against
// three real launches. This assembles that instruction into a transaction,
// asks the chain whether it would work, signs it through the launch intent,
// and follows it until it has landed or provably cannot.
//
// ─── The mint's secret lives for about two seconds ───────────────────────
//
// A pump create needs the new mint to sign for itself. That keypair is
// generated here, used once, and zeroed in the `finally` below. It is never
// written to disk, never put on a SignPolicy (a policy gets logged and passed
// around; a secret has no business in one), and never crosses IPC. The only
// thing that leaves this module is the mint's PUBLIC key.
//
// ─── Why the creator's first buy is a separate transaction ───────────────
//
// pump's own site bundles create and buy into one transaction, which closes
// the window where somebody else buys first. Doing that here would mean a
// second instruction builder for a curve that does not exist yet — one that
// could not be checked against a real transaction the way `create_v2` was,
// because its inputs (the initial virtual reserves) only exist between the
// create and the buy. An unverified builder that signs is worse than a window
// of a few seconds, so the buy goes through the ORDINARY trade path, which is
// verified, billed, and books a real position. The UI says this plainly.

import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as wallet from '../system/wallet';
import { logger } from '../system/logger';
import { createV2Instruction, type CreateV2Args } from './pumpLaunch';
import { getBlockHeight, getLatestBlockhashInfo, getSignatureStatuses, sendRawTransaction, simulateTransaction, getBalance } from '../chain/rpcClient';
import { anchorReason } from './liveSigner';

/**
 * Compute budget for a create.
 *
 * Measured on the three launches the fixture test is built from: they consumed
 * between 118k and 141k units. 250k leaves room for pump changing the create
 * path without this becoming the reason a user's launch fails, and an unused
 * limit costs nothing — only units actually consumed are paid for.
 */
const CU_LIMIT = 250_000;
/** The most a create may cost the creator: 0.02 SOL, twice the mayhem measurement. */
const CREATE_SPEND_CEILING_LAMPORTS = 20_000_000;
/** 250k x 200k microlamports = 0.00005 SOL. A create is not a race. */
const CU_PRICE_MICRO = 200_000;

export interface LaunchSolanaRequest {
  httpUrl: string;
  /** The wallet the Launch page named. Never the active trading wallet. */
  walletId: string;
  name: string;
  symbol: string;
  /** Pinned metadata JSON. pump reads name, symbol and image out of it. */
  uri: string;
  mayhem: boolean;
  cashback: boolean;
}

export interface LaunchSolanaResult {
  ok: boolean;
  message: string;
  /** The new token, when one was created. */
  mint?: string;
  signature?: string;
}

/** Confirmed, failed, or provably dead — never "probably". */
async function confirm(httpUrl: string, signature: string, lastValidBlockHeight: number): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const st = await getSignatureStatuses(httpUrl, [signature]);
    const s0 = st.ok && st.data ? st.data[0] : null;
    if (s0?.confirmationStatus === 'confirmed' || s0?.confirmationStatus === 'finalized') {
      return s0.err ? { ok: false, message: 'The create failed on chain — no token was made.' } : { ok: true, message: 'confirmed' };
    }
    const h = await getBlockHeight(httpUrl);
    if (h.ok && h.data !== undefined && h.data > lastValidBlockHeight) {
      // A status can lag the height by a slot; look once more before calling it.
      const again = await getSignatureStatuses(httpUrl, [signature]);
      const a0 = again.ok && again.data ? again.data[0] : null;
      if (a0?.confirmationStatus === 'confirmed' || a0?.confirmationStatus === 'finalized') {
        return a0.err ? { ok: false, message: 'The create failed on chain — no token was made.' } : { ok: true, message: 'confirmed' };
      }
      return { ok: false, message: 'The create expired before it confirmed. Nothing was created; try again.' };
    }
  }
  return { ok: false, message: `Not confirmed after 90 s. Check ${signature.slice(0, 12)} on chain before trying again.` };
}

/**
 * Build, simulate, sign and send a pump create.
 *
 * `simulateOnly` runs everything up to the broadcast and stops — the Launch
 * page uses it to tell the user whether the chain would accept this launch
 * before they commit to it.
 */
export async function launchSolana(req: LaunchSolanaRequest, simulateOnly: boolean): Promise<LaunchSolanaResult> {
  const creatorKey = wallet.publicKeyOf(req.walletId);
  if (!creatorKey) return { ok: false, message: 'The launch wallet no longer exists. Pick one on the Launch page.' };

  // ONE copy of the secret. `Keypair.generate().secretKey` hands back a
  // copy, so zeroing that left the keypair's own bytes intact (found by
  // audit 2026-09-11); a keypair built FROM the bytes shares them, and the
  // `finally` below zeroes the only array that exists.
  const secret = Keypair.generate().secretKey;
  const mintKp = Keypair.fromSecretKey(secret);
  const mint = mintKp.publicKey;
  try {
    const bh = await getLatestBlockhashInfo(req.httpUrl);
    if (!bh.ok || !bh.data) return { ok: false, message: `Could not reach the chain: ${bh.message}` };

    const creator = new PublicKey(creatorKey);
    const args: CreateV2Args = {
      name: req.name,
      symbol: req.symbol,
      uri: req.uri,
      creator,
      mayhem: req.mayhem,
      cashback: req.cashback,
    };
    const msg = new TransactionMessage({
      payerKey: creator,
      recentBlockhash: bh.data.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO }),
        createV2Instruction(mint, args),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);

    // The signer's launch rule checks that slot 1 IS this mint. Assert the
    // same thing here so a web3.js change to signer ordering surfaces as a
    // clear message rather than as a refusal from the policy.
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    if (msg.header.numRequiredSignatures !== 2 || keys[1] !== mint.toBase58()) {
      return { ok: false, message: 'The create did not compile to the two signatures a launch needs — nothing was sent.' };
    }

    const unsigned = tx.serialize();
    const signed = wallet.signLaunchForWallet(
      req.walletId,
      unsigned,
      // A create moves no SOL through a top-level transfer: everything it
      // spends is rent, paid by CPI inside pump's own program. So the outflow
      // ceiling is zero, and a transfer smuggled in beside the create is
      // refused by the policy rather than by review.
      { intent: 'launch', launchMint: mint.toBase58(), maxTransferLamports: 0 },
      secret,
    );
    if (!signed.ok || !signed.signed) {
      logger.error(`launch refused by the signer: ${signed.message}`);
      return { ok: false, message: signed.message };
    }
    const base64 = Buffer.from(signed.signed).toString('base64');

    // Simulate the SIGNED bytes. A launch is the least reversible thing this
    // app does, so it is never broadcast without the chain having agreed to
    // it first — and a simulation of something other than what would be sent
    // is not a simulation.
    // The creator's balance is watched: a create pays rent by CPI inside
    // pump's program, which the signer's transfer ceiling cannot see, so the
    // simulation is what bounds it. Measured 2026-09-11: 0.0067 SOL, 0.0101
    // in mayhem mode. A read that fails refuses — a guard that cannot read
    // its numbers is not a guard.
    const before = await getBalance(req.httpUrl, creatorKey, 'processed');
    if (!before.ok || before.data === undefined) return { ok: false, message: `Could not read the launch wallet's balance: ${before.message}. Nothing was created.` };
    const sim = await simulateTransaction(req.httpUrl, base64, [creatorKey]);
    if (!sim.ok || !sim.data) return { ok: false, message: `Could not simulate the launch: ${sim.message}` };
    if (sim.data.err) {
      const why = anchorReason(sim.data.logs) ?? JSON.stringify(sim.data.err);
      logger.warn(`launch refused by the chain: ${why}`);
      return { ok: false, message: `The chain refused this launch: ${why}. Nothing was created.` };
    }
    const post = sim.data.postLamports[0];
    if (typeof post !== 'number') return { ok: false, message: 'The simulation did not report the launch wallet afterwards. Nothing was created.' };
    if (before.data - post > CREATE_SPEND_CEILING_LAMPORTS) {
      logger.error(`launch refused by the loss guard: the create would spend ${before.data - post} lamports, ceiling ${CREATE_SPEND_CEILING_LAMPORTS}`);
      return { ok: false, message: `Refusing: the create would spend ${((before.data - post) / 1e9).toFixed(4)} SOL, more than a create should cost. Nothing was created.` };
    }
    if (simulateOnly) {
      return { ok: true, message: 'The chain accepts this launch.', mint: mint.toBase58() };
    }

    const sent = await sendRawTransaction(req.httpUrl, base64);
    if (!sent.ok || !sent.data) return { ok: false, message: `Could not send the launch: ${sent.message}` };
    logger.info(`launch: pump create ${mint.toBase58()} sent as ${sent.data}`);
    const c = await confirm(req.httpUrl, sent.data, bh.data.lastValidBlockHeight);
    return { ok: c.ok, message: c.message, mint: mint.toBase58(), signature: sent.data };
  } catch (e) {
    return { ok: false, message: `The launch could not be built: ${(e as Error).message}` };
  } finally {
    // The only array holding the mint's secret — the keypair shares it.
    secret.fill(0);
  }
}
