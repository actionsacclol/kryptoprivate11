// The launcher's gate, and the two-step it runs on Solana.
//
// Everything the Launch page checks, this checks again. The page's version is
// what greys out the button; this one is the rule, because the page is the
// renderer and the renderer is not where a spending decision gets made. Same
// shared function on both sides (`draftProblems`), so they cannot drift.
//
// ─── The three gates, in order ───────────────────────────────────────────
//
//  1. `launch.enabled`. Off means the launch intent is never constructed, so
//     the signer's ordinary one-signature rule refuses a create — the same
//     refusal a user who never opened the Launch page would get.
//  2. A wallet is named, per chain, and it is NOT the wallet you trade with.
//  3. The draft is valid, including a first buy.
//
// ─── Why Solana takes two transactions and Robinhood one ─────────────────
//
// Pons exposes `launchAndBuy`, so a Robinhood launch creates and buys in one
// call that nobody can get between. pump's create and buy are separate
// instructions, and bundling them would need a buy builder for a curve that
// does not exist yet — one that could not be pinned against a real
// transaction the way `create_v2` is. So the Solana buy goes through the
// ORDINARY trade path afterwards: verified, billed, and it books a real
// position. The window is a few seconds on a token nobody has heard of.
//
// Either way the creator's own buy is billed exactly like any other buy. A
// signing path that costs nothing is a thing to be exploited, not a feature.

import { kryptoOptionProblems } from '@shared/kryptoMode';
import { draftProblems, launchWalletId, type LaunchChain, type LaunchConfig, type LaunchDraft, type LaunchOutcome } from '@shared/launch';
import { getBalance } from '../chain/rpcClient';
import * as wallet from '../system/wallet';
import { launchSolana } from './launchSolana';
import { launchEvm } from '../evm/launch';

export interface LaunchDeps {
  cfg: LaunchConfig;
  httpUrl: string;
  /** Active SOLANA trading wallet id, or null. */
  activeSolanaWalletId: string | null;
  /** Active EVM trading wallet id, or null. */
  activeEvmWalletId: string | null;
  referrer: string;
  /**
   * Solana only: live execution is on AND the engine is armed.
   *
   * Checked BEFORE anything is created, because the failure it prevents is
   * the worst one this module can produce: a token that exists, on a chain,
   * with the creator's own buy refused by a gate that was already closed when
   * they pressed the button. Robinhood does not need it — Pons creates and
   * buys in one router call, so no part of that launch goes through the
   * engine.
   */
  liveReady: boolean;
  /**
   * Place the creator's first buy through the ordinary trade pipeline.
   *
   * Injected rather than imported so this module does not depend on the
   * engine: the engine's live gates (armed, live enabled, breakers) are the
   * caller's to apply, and they are the same gates every other buy passes.
   */
  devBuy: (mint: string, walletId: string, sol: number) => Promise<{ ok: boolean; message: string }>;
  /**
   * Why the creator's first buy would be REFUSED, or null — asked before the
   * token exists. The buy runs through the engine's gates (armed, live,
   * breakers, per-buy floor, live cap); `liveReady` covered the first two,
   * and every gap between it and the real gate produced exactly the outcome
   * this module names as the worst: a token that exists with its buy
   * refused. Found by audit 2026-09-11.
   */
  canBuy: (walletId: string, sol: number) => Promise<string | null>;
}

/** What a pump create costs the creator, measured 2026-09-11: 0.0067 SOL
 *  (0.0101 in mayhem mode), fees included. Rounded up for the balance check. */
const CREATE_COST_LAMPORTS = 12_000_000;
/** The first buy's own overhead: platform fee, a token account, tips. */
const BUY_OVERHEAD_LAMPORTS = 5_000_000;
/** The bot wallet's fee headroom (kryptoMode FEE_HEADROOM_LAMPORTS) + the transfer. */
const KRYPTO_FUND_OVERHEAD_LAMPORTS = 16_000_000;

/** Why this draft cannot be sent, or null when it can. Shared by both paths. */
export function refuse(draft: LaunchDraft, deps: LaunchDeps): string | null {
  if (!deps.cfg.enabled) return 'Launching is switched off for this install.';
  const chain: LaunchChain = draft.chain;
  const walletId = launchWalletId(deps.cfg, chain);
  if (!walletId) return 'No launch wallet is set for this chain.';
  const active = chain === 'solana' ? deps.activeSolanaWalletId : deps.activeEvmWalletId;
  if (active && walletId === active) {
    return 'The launch wallet is your active trading wallet. Launching needs its own.';
  }
  if (chain === 'solana' && !deps.liveReady) {
    return 'Your own first buy runs through the normal trade path, so turn live execution on and arm the engine before launching.';
  }
  const problems = [...draftProblems(draft), ...(draft.krypto ? kryptoOptionProblems(draft.krypto) : [])];
  if (problems.length > 0) return problems[0]!;
  return null;
}

const lamports = (sol: number): number => Math.round(sol * 1e9);
const wei = (native: number): bigint => BigInt(Math.round(native * 1e18));

/**
 * Run a launch, or tell the chain to pretend.
 *
 * `simulateOnly` never broadcasts anything on either chain and never places a
 * buy — it answers "would this work", which is the only question worth asking
 * before making something that cannot be unmade.
 */
export async function launch(draft: LaunchDraft, deps: LaunchDeps, simulateOnly: boolean): Promise<LaunchOutcome> {
  const no = refuse(draft, deps);
  if (no) return { ok: false, message: no };
  const walletId = launchWalletId(deps.cfg, draft.chain);

  if (draft.chain === 'robinhood') {
    const r = await launchEvm(
      {
        walletId,
        name: draft.name.trim(),
        symbol: draft.symbol.trim(),
        image: draft.imageUrl,
        website: draft.website.trim(),
        twitter: draft.twitter.trim(),
        telegram: draft.telegram.trim(),
        quoteInWei: wei(draft.devBuy),
        creatorTaxBps: draft.creatorTaxBps,
        referrer: deps.referrer,
      },
      simulateOnly,
    );
    return { ok: r.ok, message: r.message, token: r.token, hash: r.hash };
  }

  if (!simulateOnly) {
    // The gate the buy will meet, met now — and the wallet has to be able to
    // pay for BOTH halves, or the create lands and the buy bounces. Anything
    // that goes wrong in here is a refusal, never a throw across the IPC.
    try {
      const cannot = await deps.canBuy(walletId, draft.devBuy);
      if (cannot) return { ok: false, message: `Your first buy would be refused (${cannot}), so nothing is created.` };
      const pub = wallet.publicKeyOf(walletId);
      if (!pub) return { ok: false, message: 'The launch wallet no longer exists. Pick one on the Launch page.' };
      const bal = await getBalance(deps.httpUrl, pub);
      if (!bal.ok || bal.data === undefined) return { ok: false, message: `Could not read the launch wallet's balance: ${bal.message}. Nothing is created.` };
      // A Krypto Mode bot that starts live is funded from this same wallet
      // straight after the launch — so it has to be affordable NOW, or the
      // coin exists with a bot that silently fell back to paper.
      const bot = draft.krypto?.enabled && draft.krypto.live ? lamports(draft.krypto.budgetSol) + KRYPTO_FUND_OVERHEAD_LAMPORTS : 0;
      const need = lamports(draft.devBuy) + CREATE_COST_LAMPORTS + BUY_OVERHEAD_LAMPORTS + bot;
      if (bal.data < need) {
        return {
          ok: false,
          message: `The launch wallet holds ${(bal.data / 1e9).toFixed(4)} SOL; the create plus your ${draft.devBuy} SOL first buy${bot ? ` and the ${draft.krypto.budgetSol} SOL Krypto Mode budget` : ''} needs about ${(need / 1e9).toFixed(4)}. Nothing is created.`,
        };
      }
    } catch (e) {
      return { ok: false, message: `Could not check the launch wallet before creating: ${(e as Error).message}. Nothing is created.` };
    }
  }

  const r = await launchSolana(
    {
      httpUrl: deps.httpUrl,
      walletId,
      name: draft.name.trim(),
      symbol: draft.symbol.trim(),
      uri: draft.metadataUri,
      mayhem: draft.mayhem,
      cashback: draft.cashback,
    },
    simulateOnly,
  );
  // The signature travels on every path — a create that timed out waiting
  // for confirmation is a token that may exist, and the signature is how the
  // user finds out. (Until 2026-09-11 only the Robinhood path carried it.)
  if (!r.ok || simulateOnly || !r.mint) return { ok: r.ok, message: r.message, token: r.mint, hash: r.signature };

  // The token exists from here on, whatever happens next. Every path below
  // reports ok:true with the mint, because "the launch failed" would be false
  // and would send someone to create a second token they already own.
  const buy = await deps.devBuy(r.mint, walletId, draft.devBuy);
  if (!buy.ok) {
    return {
      ok: true,
      message: `${draft.symbol.trim()} is live, but your own first buy did not go through.`,
      token: r.mint,
      hash: r.signature,
      buyFailed: buy.message,
    };
  }
  return { ok: true, message: `${draft.symbol.trim()} is live and you hold the first ${draft.devBuy} SOL of it.`, token: r.mint, hash: r.signature };
}

/** Exported for the tests that pin the sizing conversions. */
export const _conv = { lamports, wei };
