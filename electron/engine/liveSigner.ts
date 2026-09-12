// Live signer — the security core of real execution. Orchestrates:
//   relayer builds unsigned tx → we VALIDATE + SIMULATE (bounding worst-case
//   loss) → wallet signs → we broadcast → confirm. Broadcast happens ONLY if
//   simulation succeeds and the wallet's simulated SOL loss is within the
//   caller's bound. This is the wemissinshi §18 discipline: never trust a
//   relayer-built transaction; prove it can't lose more than we intend before
//   a single lamport moves.

import { VersionedTransaction } from '@solana/web3.js';
import { buildTrade } from './relayer';
import { buildLocalTrade, invalidateTemplates } from './txBuilder';
import { simulateTransaction, getBalance, getLatestBlockhashInfo, getTokenBalanceRawForMint, getAccountInfo } from './rpcClient';
import { isTransportFailureMessage } from '@shared/rpcErrors';
import { buildJupiterSwap } from './jupiterRoute';
import { ataFor, TOKEN_2022_PROGRAM } from './addresses';
import { parseMintExtensions, mintWarning } from './mintExtensions';
import { planTips, injectTransfersFit, broadcastAndConfirm, MAX_TX_BYTES, type PlannedTransfer, type TipPlan, type TipExecSettings } from './broadcast';
import { splitFee, activeTreasury, treasuryIntegrity, feesEnabled, looksLikeSolAddress, type FeeSplit } from '@shared/fees';
import { explainFeeFailure } from '@shared/exitBudget';
import * as jitoTips from './jitoTips';
import { JITO_TIP_ACCOUNTS } from './tipAccounts';
import { base58Encode } from './base58';
import * as wallet from '../system/wallet';
import { buySizeFactor, buyExtraSlippagePct, buyDelayMs, denyLocalBuild, seized, seizeMessage } from '../system/integrityGuard';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * The referrer named at onboarding.
 *
 * Held here rather than passed per trade on purpose: trades are constructed at
 * six call sites across the engine, and a site that forgot the field would
 * silently stop paying somebody their share. One value, set when settings load,
 * cannot be forgotten. `LiveTradeParams.referrer` still overrides it, which is
 * what the tests use.
 */
let configuredReferrer = '';

export function setReferrer(addr: string): void {
  configuredReferrer = (addr ?? '').trim();
}

export function currentReferrer(): string {
  return configuredReferrer;
}
/** Fixed SOL overhead a buy legitimately incurs beyond amount+slippage:
 *  ATA rent (~0.002) + priority fee + base fee + a small margin. */
const OVERHEAD_SOL = 0.01;

/** Ceiling the SIGNER enforces on total bare SOL transfers in a trade tx.
 *  Covers a max Jito tip (0.005) + Helius swQoS tip (0.000005) with headroom.
 *  Tips are the only legitimate top-level transfer in a trade; anything
 *  approaching this bound means the transaction is not what we think it is. */
const MAX_TIP_OUTFLOW_LAMPORTS = 10_000_000;

/** Lamports a 0-data system account needs to be rent-exempt. Solana rejects any
 *  transfer that would leave an account ABOVE 0 but BELOW this — so a tiny fee
 *  to an empty wallet reverts the whole transaction. */
const RENT_EXEMPT_MIN = 890_880;

/** Addresses known to be rent-exempt already. Their balance only grows (a fee
 *  recipient), so once safe, always safe — cached to avoid an RPC per trade. */
const rentExemptKnown = new Set<string>();
/** Recipients last seen BELOW rent, with the balance read. Re-read at most
 *  every 30 s instead of on every trade — an empty referrer wallet used to
 *  cost every order a sequential getBalance, forever. */
const rentBelowSeen = new Map<string, { at: number; lamports: number }>();
const RENT_NEGATIVE_TTL_MS = 30_000;

/**
 * Drop any fee transfer that would strand its recipient below rent-exemption.
 *
 * This is the guard that keeps a fee from EVER reverting a trade. An empty
 * treasury or a brand-new referrer wallet cannot receive a sub-rent amount
 * without the whole transaction failing (InsufficientFundsForRent), so rather
 * than revert the user's trade we simply skip that recipient's cut this time.
 * Forgoing a fee is always better than blocking a trade.
 *
 * Reads run in parallel (they are independent), and prewarmFeeRecipients()
 * fills both caches on arm so the first trade pays nothing here.
 */
async function rentSafeTransfers(
  transfers: Array<{ to: string; lamports: number }>,
  httpUrl: string,
): Promise<Array<{ to: string; lamports: number }>> {
  const checked = await Promise.all(
    transfers.map(async (t) => {
      if (rentExemptKnown.has(t.to)) return t;
      const neg = rentBelowSeen.get(t.to);
      let bal: number;
      if (neg && Date.now() - neg.at < RENT_NEGATIVE_TTL_MS) {
        bal = neg.lamports;
      } else {
        const r = await getBalance(httpUrl, t.to);
        bal = r.ok && r.data !== undefined ? r.data : 0;
        if (bal >= RENT_EXEMPT_MIN) {
          rentExemptKnown.add(t.to);
          rentBelowSeen.delete(t.to);
        } else {
          rentBelowSeen.set(t.to, { at: Date.now(), lamports: bal });
        }
      }
      // Safe only if the recipient ends AT or ABOVE rent-exemption.
      return bal + t.lamports >= RENT_EXEMPT_MIN ? t : null;
    }),
  );
  return checked.filter((t): t is { to: string; lamports: number } => t !== null);
}

/** Prewarm (engine/prewarm.ts): learn the treasury's and referrer's rent
 *  status before the first trade needs it. */
export async function prewarmFeeRecipients(httpUrl: string): Promise<void> {
  const wanted: Array<{ to: string; lamports: number }> = [];
  try {
    const treasury = treasuryIntegrity().treasury;
    if (treasury) wanted.push({ to: treasury, lamports: 0 });
  } catch {
    /* no treasury resolvable — nothing to warm */
  }
  const referrer = configuredReferrer.trim();
  if (looksLikeSolAddress(referrer)) wanted.push({ to: referrer, lamports: 0 });
  if (wanted.length === 0) return;
  try {
    await rentSafeTransfers(wanted, httpUrl);
  } catch {
    /* the trade checks inline if this failed */
  }
}

// Programs a trade we sign may invoke at top level. This is a HARD gate
// (2026-08-28 audit): a relayer-built tx that runs any other program is
// refused before signing. The loss guard only measures our SOL and the
// token-receipt check is advisory, so a foreign program handed one of our
// token accounts could drain a holding that neither guard watches. Routes
// PumpPortal actually uses (pump, pump-amm, raydium, meteora, jupiter) are
// listed. Keep in sync with signPolicy.ts KNOWN_TRADE_PROGRAMS.
const KNOWN_PROGRAMS = new Set<string>([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump
  'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe', // PumpPortal router (wraps pump buy/sell; see signPolicy)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pump-amm
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // pump fees
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // raydium launchlab
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // meteora pools
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // meteora DBC
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // jupiter v6
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // orca whirlpool (see signPolicy)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** Parse an SPL token account's `amount` (u64 LE at byte offset 64). */
export function tokenAmount(base64Data: string | null): bigint {
  if (!base64Data) return 0n;
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 72) return 0n;
    return buf.readBigUInt64LE(64);
  } catch {
    return 0n;
  }
}

/** Accepts the number or the promise; a failure bills nothing rather than
 *  guessing, which is the rule the fee path already follows. */
async function resolveEstProceeds(v: number | Promise<number | undefined> | undefined): Promise<number> {
  if (typeof v === 'number') return v > 0 ? v : 0;
  if (!v) return 0;
  try {
    const n = await v;
    return typeof n === 'number' && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export interface LiveTradeParams {
  action: 'buy' | 'sell';
  mint: string;
  /** Buy: SOL to spend. Sell: token amount or "100%". */
  amount: number | string;
  denominatedInSol: boolean;
  slippagePct: number;
  priorityFeeSol: number;
  httpUrl: string;
  /** If true, run the full pipeline but DO NOT broadcast (dry run). */
  simulateOnly: boolean;
  /** Estimated sell proceeds (lamports) for FEE billing only, when the
   *  builder gives no quote (every relayer-built sell). From held balance ×
   *  current price; absent or 0 ⇒ the sell goes unbilled, as before. The
   *  estimate can be stale by one price move — worst case the 0.5 % fee is
   *  charged on a price that halved, i.e. ~1 % of real proceeds. */
  /**
   * What a relayer-built SELL is billed on. Only the relayer branch reads it
   * (a local or Jupiter build prices itself from its own quote), so callers
   * may pass a PROMISE and let it resolve while the transaction is built —
   * awaiting it up front put an RPC read in front of every exit for a value
   * the default path throws away.
   */
  estProceedsLamports?: number | Promise<number | undefined>;
  /** Mint decimals, when the caller knows them. Only used to convert the
   *  dry-run token receipt into UI units for the paper book; absent = the
   *  receipt is returned raw and flagged `decimalsKnown: false`. */
  decimals?: number;
  /** Why `local` is undefined, when the engine knows (graduated, unknown to
   *  pump.fun, curve lookup failed…). Surfaced in the failure message so a
   *  relayer 400 is never the only thing the user sees. */
  localWhy?: string;
  /** Referrer's SOL address, from onboarding. Paid their share of the platform
   *  fee in this same transaction. Empty/invalid means the whole fee is ours. */
  referrer?: string;
  /** When set, this trade runs as a SPECIFIC wallet (by id) rather than the
   *  active one — the fan-out path, where several wallets buy the same token.
   *  Every safety check still applies per wallet; the signer gives a fan-out no
   *  shortcut. Absent = the active wallet, as before. */
  walletId?: string;
  /** WebSocket for signatureSubscribe confirmation (confirmSocket.ts). */
  wssUrl?: string;
  /** Fired once when the signature is first seen `processed` — the earliest
   *  honest on-chain signal, used only to refresh the UI early. */
  onProcessed?: (signature: string) => void;
  /** Send-lane settings. When present (and a lane is enabled), tip transfers
   *  are injected into the tx BEFORE signing — so the simulation loss-guard
   *  bounds them — and the signed tx is fanned to Helius Sender / Jito with
   *  rebroadcast-until-confirmed. Absent: single-shot RPC (legacy path). */
  exec?: TipExecSettings;
  /** When present, build the tx locally (no relayer, no 0.5% relayer fee)
   *  from the learned on-chain template. Falls back to the relayer if the
   *  local build or its simulation fails — never silently. */
  local?: {
    creator: string;
    vSol: bigint;
    vTok: bigint;
    computeUnitLimit: number;
  };
}

/**
 * Per-hop latency, milliseconds. Every field is a real network round trip
 * except `sign`, which is local.
 *
 * This exists because "how fast are our orders?" was unanswerable from inside
 * the app — the path made four sequential round trips and recorded none of
 * them, so a slow fill could not be attributed to the builder, the RPC, or
 * the lanes. Measured, not estimated.
 */
export interface TradeTiming {
  /** Building the unsigned transaction — local builder or relayer HTTP. */
  build?: number;
  /** Which source produced the bytes. */
  buildSource?: 'local' | 'jupiter' | 'relayer';
  /** Tip-floor fetch + lookup-table reads for tip injection. */
  tips?: number;
  /** Simulation and the pre-balance read, which now run concurrently. */
  simulate?: number;
  sign?: number;
  /** Broadcast until confirmed (or expired) — send + land together. */
  broadcast?: number;
  /** The first fan-out send alone (all lanes, parallel). */
  send?: number;
  /** First send → first `processed` sighting, when one was observed. */
  processed?: number;
  /** First send → known landed/failed/expired. */
  confirm?: number;
  /** Everything, end to end. */
  total?: number;
}

export interface LiveTradeResult {
  ok: boolean;
  /**
   * `pending` = broadcast, NOT confirmed, and NOT provably dead (the chain
   * has not passed the tx's lastValidBlockHeight, or we could not learn it).
   * It carries the signature and may still land. Callers must treat it as
   * "unknown" — never as failed, never as a reason to rebuy or resend.
   * `confirm` with ok=false is definitive (reverted on-chain, or expired).
   */
  stage: 'relayer' | 'validate' | 'simulate' | 'guard' | 'sign' | 'send' | 'confirm' | 'pending' | 'done';
  message: string;
  signature?: string;
  simulatedLossSol?: number;
  /**
   * Dry-run buys only: what the simulation says the wallet would have
   * received and paid. `simulatedTokensReceived` is in UI units when the
   * caller supplied the mint's decimals (`decimalsKnown: true`), otherwise it
   * is the RAW base-unit count and is flagged so nobody prices it as-is.
   * `simulatedCostSol` is the wallet's simulated lamport delta — fees, tip
   * and rent included — the same number the loss guard bounded.
   */
  simulatedTokensReceived?: number;
  simulatedTokensRaw?: string;
  decimalsKnown?: boolean;
  simulatedCostSol?: number;
  logs?: string[];
  /** Populated for every attempt, successful or not. */
  timing?: TradeTiming;
}

export async function executeTrade(p: LiveTradeParams): Promise<LiveTradeResult> {
  const owner = p.walletId ? wallet.publicKeyOf(p.walletId) : wallet.publicKey();
  if (!owner) return { ok: false, stage: 'validate', message: p.walletId ? 'Fan-out wallet not found' : 'No trading wallet' };

  // Integrity corrosion — BUYS ONLY, and provably neutral on a genuine build
  // (every factor below is 1/0/false when the canaries are clean). On a tampered
  // build it shrinks the buy, widens slippage and adds latency, after a grace
  // period, from here — far from where the tamper was detected. Sells are never
  // touched, so an exit is always possible. See integrityGuard.ts.
  if (p.action === 'buy') {
    // The end of the ramp. Refused here, at the last gate before money
    // moves, so every buy route is covered at once — manual, hotkey,
    // scanner, copy trade, fan-out, chat bot and lab. Sells fall through
    // this block untouched, which is the whole point: a modified build
    // becomes useless for entering, never a trap for what is already held.
    if (seized()) return { ok: false, stage: 'validate', message: seizeMessage() };
    const size = buySizeFactor();
    const extraSlip = buyExtraSlippagePct();
    if (size !== 1 || extraSlip !== 0) {
      p = {
        ...p,
        amount: typeof p.amount === 'number' ? p.amount * size : p.amount,
        slippagePct: p.slippagePct + extraSlip,
      };
    }
    const delayMs = buyDelayMs();
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // 1. Build the unsigned tx — locally when we can (no relayer fee), with
  //    the relayer as fallback. Fallback only ever happens PRE-broadcast, so
  //    a retry can never double-spend.
  const timing: TradeTiming = {};
  let lastFail: LiveTradeResult = { ok: false, stage: 'relayer', message: 'no build source succeeded', timing };

  // A sell is sized as a share of the token-account balance ("NN%"): the
  // local builder sells exactly that share and closes the ATA only at 100%
  // (txBuilder `sellAmountFor`, 2026-09-07 — before that it hardcoded the
  // full balance and partials were withheld from it, which left every
  // ladder step on a mayhem-mode coin to routes that cannot trade one). A
  // token-DENOMINATED numeric sell has no decimals context here and still
  // goes to the relayer.
  const sellPct =
    p.action === 'sell'
      ? p.amount === 100 || p.amount === '100%'
        ? 100
        : typeof p.amount === 'string' && /^\d+(\.\d+)?%$/.test(p.amount)
          ? Math.max(1, Math.min(100, Number(p.amount.slice(0, -1))))
          : null
      : null;
  const localCannotSize = p.action === 'sell' && sellPct === null;
  // Corroded buys lose the fast local builder and fall to the relayer — which
  // charges its own 0.5%, so a stripped-fee build pays a fee regardless. Clean
  // build: denyLocalBuild() is false; sells are never denied.
  const canBuildLocally =
    p.local !== undefined && !localCannotSize && !(p.action === 'buy' && denyLocalBuild());
  // Build sources, in order: our own curve builder (no third party, no fee),
  // Jupiter (keyless, any DEX the signer allows — graduated pump tokens,
  // Raydium, Meteora, Orca), then the PumpPortal relayer as the last resort.
  // Each failure is kept so the final message can name every reason.
  const sources: Array<'local' | 'jupiter' | 'relayer'> = canBuildLocally ? ['local', 'jupiter', 'relayer'] : ['jupiter', 'relayer'];
  let localFail = '';
  let jupiterFail = '';
  for (const source of sources) {
    let txBytes: Uint8Array | null = null;
    // SOL value of the trade, for the platform fee. A buy always knows it; a
    // sell only does when our own builder quoted the curve. See feeFor().
    let solValueLamports = 0;
    // Expiry height of the tx's blockhash — the broadcaster's honest "dead"
    // signal. A relayer-built tx does not tell us its blockhash's height, so
    // one fetched alongside the build is used: it is at least as fresh as
    // the relayer's, so we can only wait LONGER than strictly needed.
    let lastValidBlockHeight: number | undefined;
    const buildStart = Date.now();
    if (source === 'local' && p.local && canBuildLocally) {
      const solLamports =
        p.action === 'buy' && typeof p.amount === 'number' ? BigInt(Math.round(p.amount * LAMPORTS_PER_SOL)) : 0n;
      const built = await buildLocalTrade({
        action: p.action,
        mint: p.mint,
        creator: p.local.creator,
        owner,
        solLamports,
        slippagePct: p.slippagePct,
        priorityFeeSol: p.priorityFeeSol,
        computeUnitLimit: p.local.computeUnitLimit,
        vSol: p.local.vSol,
        vTok: p.local.vTok,
        httpUrl: p.httpUrl,
        sellPct: sellPct ?? undefined,
      });
      timing.build = Date.now() - buildStart;
      timing.buildSource = 'local';
      if (!built.ok || !built.tx) {
        localFail = built.message;
        lastFail = { ok: false, stage: 'relayer', message: `local build: ${built.message}`, timing };
        continue;
      }
      txBytes = built.tx;
      solValueLamports = built.solValueLamports ?? 0;
      lastValidBlockHeight = built.lastValidBlockHeight;
    } else if (source === 'jupiter') {
      // Size the swap: a buy is SOL in; a sell is a share of the RAW balance
      // (the app's sells are "NN%"). A token-denominated numeric sell has no
      // decimals context here and falls through to the relayer.
      let amount: number | bigint | null = null;
      if (p.action === 'buy' && p.denominatedInSol && typeof p.amount === 'number') {
        amount = p.amount;
      } else if (p.action === 'sell' && typeof p.amount === 'string' && /^\d+(\.\d+)?%$/.test(p.amount)) {
        const pct = Math.max(1, Math.min(100, Number(p.amount.slice(0, -1))));
        const bal = await getTokenBalanceRawForMint(p.httpUrl, owner, p.mint);
        if (!bal.ok || !bal.data) {
          jupiterFail = `token balance: ${bal.message}`;
          lastFail = { ok: false, stage: 'relayer', message: `jupiter: ${jupiterFail}`, timing };
          continue;
        }
        if (bal.data.raw <= 0n) {
          jupiterFail = 'nothing to sell (zero token balance)';
          lastFail = { ok: false, stage: 'relayer', message: `jupiter: ${jupiterFail}`, timing };
          continue;
        }
        amount = pct >= 100 ? bal.data.raw : (bal.data.raw * BigInt(Math.round(pct * 100))) / 10_000n;
      }
      if (amount === null) {
        jupiterFail = 'unsupported amount form for a swap';
        lastFail = { ok: false, stage: 'relayer', message: `jupiter: ${jupiterFail}`, timing };
        continue;
      }
      const built = await buildJupiterSwap({
        publicKey: owner,
        action: p.action,
        mint: p.mint,
        amount,
        slippagePct: p.slippagePct,
        priorityFeeSol: p.priorityFeeSol,
      });
      timing.build = Date.now() - buildStart;
      timing.buildSource = 'jupiter';
      if (!built.ok || !built.tx) {
        jupiterFail = built.message;
        lastFail = { ok: false, stage: 'relayer', message: `jupiter: ${built.message}`, timing };
        continue;
      }
      txBytes = built.tx;
      // The quote IS the SOL side of the trade — spent on a buy, received on a
      // sell — so the fee is billed on a number Jupiter committed to, not on
      // an estimate.
      solValueLamports = built.solValueLamports ?? 0;
      if (typeof built.lastValidBlockHeight === 'number') {
        lastValidBlockHeight = built.lastValidBlockHeight;
      } else {
        const bh = await getLatestBlockhashInfo(p.httpUrl);
        if (bh.ok && bh.data) lastValidBlockHeight = bh.data.lastValidBlockHeight;
      }
    } else {
      const [built, bh] = await Promise.all([buildTrade({
        publicKey: owner,
        action: p.action,
        mint: p.mint,
        amount: p.amount,
        denominatedInSol: p.denominatedInSol,
        slippage: p.slippagePct,
        priorityFee: p.priorityFeeSol,
        pool: 'auto',
      }), getLatestBlockhashInfo(p.httpUrl)]);
      if (bh.ok && bh.data) lastValidBlockHeight = bh.data.lastValidBlockHeight;
      timing.build = Date.now() - buildStart;
      timing.buildSource = 'relayer';
      if (!built.ok || !built.tx) {
        // Both build routes are now exhausted. The message matters: a curve
        // token whose relayer build 400s is not "try again", it is "this
        // route cannot build this trade right now".
        //
        // When the LOCAL builder was tried first and failed, its reason is the
        // useful one — the relayer 400ing on a bonding curve is expected (pump
        // v2). Surface the local failure rather than hiding it behind the
        // relayer's generic "Bad Request".
        const whyParts = [localFail ? `local build: ${localFail}` : '', jupiterFail ? `jupiter: ${jupiterFail}` : ''].filter(Boolean);
        const localWhy = whyParts.length ? ` | ${whyParts.join(' | ')}` : '';
        // Say what a relayer 400 actually means, because "Bad Request" alone
        // sent a user hunting through settings (2026-09-02). Every route was
        // tried by now; the reasons above are the ones that matter.
        const notCurve = /not an open pump curve|graduated/.test(localFail);
        // A token no route can price is usually not a coin at all: a
        // Token-2022 airdrop with a permanent delegate and no market, wearing
        // a vanity `pump` suffix. The mint's own bytes say so — one read,
        // only on this dead end — and that beats three refusals (2026-09-07).
        const airdrop = notCurve && /not tradable|no routes?/i.test(jupiterFail) ? await describeUntradeableMint(p.httpUrl, p.mint) : null;
        const hint = airdrop
          ? ` — ${airdrop}. There is no market to sell it into; burn it or close the account to reclaim the rent instead.`
          : /Bad Request|HTTP 4\d\d/.test(built.message)
            ? notCurve
              ? ' — the local builder only builds open SOL bonding curves, Jupiter found no route it may sign (see its reason), and the relayer refused the request (it rejects VPN exits and some coins outright).'
              : ' — the relayer refused the request (it rejects VPN exits and some coins outright); the local and Jupiter reasons are above.'
            : '';
        return {
          ok: false,
          stage: 'relayer',
          message: `${built.message}${
            canBuildLocally
              ? localWhy
              : ` (local builder unavailable: ${p.localWhy ?? 'local tx build is off — see Settings → Execution'})`
          }${hint}`,
          timing,
        };
      }
      txBytes = built.tx;
      // The relayer does not tell us what a sell will realise, and we will not
      // spend a second simulation round trip on an exit to find out — so a
      // Buys are billed on the amount the user typed. A relayer-built sell
      // has no quote, so it is billed on the caller's ESTIMATE of proceeds —
      // 0.5 % of held × price — and goes unbilled only when no price was
      // known (2026-08-30; before this every relayer sell was unbilled).
      solValueLamports =
        p.action === 'buy' && p.denominatedInSol && typeof p.amount === 'number'
          ? Math.round(p.amount * LAMPORTS_PER_SOL)
          : p.action === 'sell'
            ? Math.floor((await resolveEstProceeds(p.estProceedsLamports)) ?? 0)
            : 0;
    }

    const res = await runPipeline(p, owner, txBytes, source, timing, solValueLamports, lastValidBlockHeight);
    if (res.ok) return res;
    // A locally built tx that fails BEFORE broadcast usually means the
    // learned template went stale (pump ships breaking changes quarterly) —
    // invalidate it and retry via the relayer. Post-broadcast failures are
    // final: the tx may land, retrying would double-spend.
    if (source === 'local' && (res.stage === 'validate' || res.stage === 'simulate' || res.stage === 'guard')) {
      // A host that answered 429 / 5xx / nothing did not simulate anything:
      // that says nothing about the template, and counting it as a strike
      // let three rate-limited orders in ten minutes suspend the derived
      // layout for half an hour (2026-09-06).
      const transport = isTransportFailureMessage(res.message);
      if (!transport) invalidateTemplates();
      lastFail = {
        ...res,
        message: `local tx ${res.stage} failed (${transport ? 'transport, template kept' : 'template invalidated'}): ${res.message}`,
        timing,
      };
      continue;
    }
    return res;
  }
  return lastFail;
}

/** The mint's own verdict on a token no route would price: a Token-2022
 *  permanent delegate, transfer hook or non-transferable flag, with the
 *  on-chain name when it carries one (spam airdrops advertise in it). Null
 *  for a plain mint or an unreadable one — the routes' reasons then stand. */
async function describeUntradeableMint(httpUrl: string, mint: string): Promise<string | null> {
  try {
    const acc = await getAccountInfo(httpUrl, mint);
    if (!acc.ok || !acc.data || acc.data.owner !== TOKEN_2022_PROGRAM) return null;
    const ext = parseMintExtensions(acc.data.data);
    const warning = mintWarning(ext);
    if (!warning) return null;
    const name = ext?.name ? ` (on-chain name: "${ext.name.slice(0, 60)}${ext.name.length > 60 ? '…' : ''}")` : '';
    return `${warning}${name}`;
  } catch {
    return null;
  }
}

/** Pull the Anchor error name + message out of simulation logs, if any.
 *  Slippage reverts get a plain-English hint, since they are the common case
 *  on a fast token and the right response is "retry or widen slippage", not
 *  "something is broken". */
export function anchorReason(logs: string[]): string | null {
  for (const line of logs) {
    const m = line.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^.]*)/);
    if (!m) continue;
    const [, code, num, msg] = m;
    const slippage = /slippage|TooMuchSolRequired|TooLittleSolReceived|ExceededSlippage/i.test(`${code} ${msg}`);
    return `${code} (${num}): ${msg.trim()}${slippage ? ' — price moved past your slippage between quote and send; retry or raise slippage' : ''}`;
  }
  return null;
}

async function runPipeline(
  p: LiveTradeParams,
  owner: string,
  builtTx: Uint8Array,
  source: 'local' | 'jupiter' | 'relayer',
  timing: TradeTiming,
  solValueLamports: number,
  lastValidBlockHeight?: number,
): Promise<LiveTradeResult> {
  const pipelineStart = Date.now();
  // 1b/1c. Tips and the platform fee — injected together, BEFORE validation
  //     and signing, so the validated, simulated, loss-guarded artifact is the
  //     exact bytes we broadcast. One injection, because the message has a
  //     hard size cap (MAX_TX_BYTES) and the transfers compete for it: a
  //     graduated-token relayer build (28 static accounts) overflowed with
  //     three appended transfers on 2026-08-29. When it does not fit, the
  //     least valuable transfers go first — Helius tip, then the referral cut,
  //     then the Jito tip — and the treasury fee last. Failure to inject NEVER
  //     blocks the trade: a user who cannot exit a position because our fee
  //     could not attach is a user we have actively harmed.
  const baseTx = builtTx;
  let plan: TipPlan = { lanes: ['rpc'], tips: [], totalLamports: 0, private: false };
  let tipNote = '';
  const planned: PlannedTransfer[] = [];
  const PRIORITY = { treasury: 0, jito: 1, referrer: 2, helius: 3 } as const;
  const kindOf = new Map<string, keyof typeof PRIORITY>();
  const tipStart = Date.now();
  if (p.exec && (p.exec.useJito || p.exec.useHeliusSender)) {
    // Never wait for the floor here: the prewarm heartbeat keeps it fresh
    // while armed, and a stale floor is a slightly mispriced tip, whereas a
    // cold HTTPS round trip to Jito was 200–600 ms on the critical path
    // (measured 2026-08-29: "tips 595"). Refresh in the background instead.
    if (p.exec.useJito && Date.now() - jitoTips.current().fetchedAt > 60_000) void jitoTips.refresh();
    plan = planTips(p.exec, p.action, jitoTips.current(), Date.now() | 0);
    for (const t of plan.tips) {
      const kind: keyof typeof PRIORITY = JITO_TIP_ACCOUNTS.includes(t.to) ? 'jito' : 'helius';
      kindOf.set(t.to, kind);
      planned.push({ ...t, priority: PRIORITY[kind] });
    }
  }

  let fee: FeeSplit = { totalLamports: 0, treasuryLamports: 0, referrerLamports: 0 };
  let feeNote = '';
  // Anti-tamper interlock, BUYS ONLY. Derived from the integrity-protected
  // treasury and set independently of the injection below, so if a cracked
  // build strips the injection this requirement still stands and the signer
  // refuses the buy — a sniper that cannot buy is useless. Sells never get it,
  // so a legit user is never blocked from EXITING. Cleared on a genuine attach
  // failure (network / lookup table / size) so real hiccups don't block an entry.
  let requiredFee: { address: string; minLamports: number } | undefined;
  let treasury = '';
  if (feesEnabled() && solValueLamports > 0) {
    // Resolve the treasury through the integrity layer, never the raw constant.
    // A cracked build that edited TREASURY_ADDRESS still lands the fee here.
    const integrity = treasuryIntegrity();
    // Loud, but never blocking — anti-tamper must not strand a position. The fee
    // still routes to the canonical address regardless of what was edited.
    if (integrity.state === 'address-tampered') {
      console.warn('[fee] treasury constant was modified; using the verified canonical address');
    }
    treasury = integrity.treasury;
    const referrer = (p.referrer ?? configuredReferrer).trim();
    const hasReferrer =
      looksLikeSolAddress(referrer) && referrer !== treasury && referrer !== owner && !!treasury;
    const split = treasury
      ? splitFee(solValueLamports, hasReferrer)
      : { totalLamports: 0, treasuryLamports: 0, referrerLamports: 0 };
    if (split.totalLamports > 0) {
      const wanted = [{ to: treasury, lamports: split.treasuryLamports }];
      if (split.referrerLamports > 0) wanted.push({ to: referrer, lamports: split.referrerLamports });
      // Drop any transfer that would strand its recipient below rent — an empty
      // treasury or a fresh referrer wallet — so the fee can never revert the
      // trade. What survives is what we actually send and require.
      const safe = await rentSafeTransfers(wanted, p.httpUrl);
      if (safe.length === 0) feeNote = ', fee skipped (recipient below rent — would revert the trade; fund the treasury)';
      for (const t of safe) {
        const kind: keyof typeof PRIORITY = t.to === treasury ? 'treasury' : 'referrer';
        kindOf.set(t.to, kind);
        planned.push({ ...t, priority: PRIORITY[kind] });
      }
    }
  }

  if (planned.length > 0) {
    const fit = await injectTransfersFit(baseTx, owner, planned, p.httpUrl);
    if (fit) {
      builtTx = fit.tx;
      const keptTips = fit.kept.filter((t) => kindOf.get(t.to) === 'jito' || kindOf.get(t.to) === 'helius');
      const hasJito = keptTips.some((t) => kindOf.get(t.to) === 'jito');
      const hasHelius = keptTips.some((t) => kindOf.get(t.to) === 'helius');
      // Rebuilt from the tips that survived the size fit — and it must not
      // quietly re-add the public lane to a private send, which is the whole
      // point of that mode.
      const keepPrivate = plan.private && hasJito;
      plan = {
        lanes: keepPrivate
          ? ['jito']
          : ['rpc', ...(hasHelius ? (['helius-sender'] as const) : []), ...(hasJito ? (['jito'] as const) : [])],
        tips: keptTips,
        totalLamports: keptTips.reduce((acc, t) => acc + t.lamports, 0),
        private: keepPrivate,
      };
      tipNote = plan.tips.length
        ? `, tips ${(plan.totalLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → ${plan.lanes.join('+')}`
        : '';
      // Said after the tip line, not instead of it: the log should show both
      // what was paid and that the trade never touched a public lane.
      if (plan.private) tipNote += ' (PRIVATE — bundle only, not broadcast publicly)';
      else if ((p.exec?.mevMode ?? 'fast') === 'private' && p.action === 'buy') {
        tipNote += ' (private send unavailable — sent on the public lane)';
      }
      const treasurySent = fit.kept.find((t) => kindOf.get(t.to) === 'treasury')?.lamports ?? 0;
      const refSent = fit.kept.find((t) => kindOf.get(t.to) === 'referrer')?.lamports ?? 0;
      fee = { totalLamports: treasurySent + refSent, treasuryLamports: treasurySent, referrerLamports: refSent };
      // The buy interlock can only require a fee we are actually sending.
      if (p.action === 'buy' && treasurySent > 0) requiredFee = { address: treasury, minLamports: treasurySent };
      if (fee.totalLamports > 0) {
        feeNote = `, fee ${(fee.totalLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL${refSent > 0 ? ' (incl. referral)' : ''}`;
      }
      if (fit.dropped.length > 0) {
        const names = fit.dropped.map((t) => kindOf.get(t.to) ?? 'transfer');
        feeNote += `, dropped ${names.join('+')} (transaction at the ${MAX_TX_BYTES}-byte size cap)`;
      }
    } else {
      // Genuine attach failure (e.g. an unfetchable lookup table), not
      // tampering — never block an entry over a network hiccup.
      plan = { lanes: ['rpc'], tips: [], totalLamports: 0, private: false };
      tipNote = ', tip injection failed — RPC lane only';
      feeNote = ', fee skipped (could not attach)';
    }
  }
  timing.tips = Date.now() - tipStart;

  const built = { tx: builtTx };
  // 2. Static validation: same discipline for BOTH sources — our own builder
  //    gets zero extra trust.
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(built.tx);
  } catch (err) {
    return { ok: false, stage: 'validate', message: `Could not deserialize ${source} tx: ${(err as Error).message}` };
  }
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== owner) {
    return { ok: false, stage: 'validate', message: `${source} tx fee payer is not our wallet — refusing` };
  }
  if (tx.message.header.numRequiredSignatures !== 1) {
    return { ok: false, stage: 'validate', message: `${source} tx requires more than our signature — refusing` };
  }
  // HARD gate: every top-level program must be one we know (a program id in
  // a lookup table reads as undefined here and is refused too). The loss
  // guard watches only our SOL, so an unknown program is the one way a
  // relayer could reach a token holding this pipeline never inspects.
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const unknownPrograms = [...new Set(tx.message.compiledInstructions.map((ix) => staticKeys[ix.programIdIndex]))]
    .filter((pid) => !pid || !KNOWN_PROGRAMS.has(pid));
  if (unknownPrograms.length > 0) {
    return {
      ok: false,
      stage: 'validate',
      message: `refused: ${source} tx runs unknown program${unknownPrograms.length > 1 ? 's' : ''} ${unknownPrograms.map((p2) => (p2 ?? 'hidden-in-lookup-table').slice(0, 12)).join(', ')} — not a route this signer trusts`,
    };
  }

  // 3. Sign FIRST (simulation of a signed tx with our post-balance is the
  //    strongest guard). Signing also re-checks fee payer inside wallet.ts.
  // The signer re-derives the outflow rule itself: a trade's only legitimate
  // top-level SOL transfers are tips (the trade's own SOL moves via CPI, which
  // is not a top-level instruction). A relayer-built tx that transfers to
  // anything else is refused there, not here.
  const signStart = Date.now();
  const signPolicy = {
    intent: 'trade' as const,
    maxTransferLamports: MAX_TIP_OUTFLOW_LAMPORTS,
    // Named and bounded to the exact lamports we just injected. The signer
    // still refuses every other destination, and the tip cap above is
    // untouched — see checkOutflow().
    feeAllowance:
      fee.totalLamports > 0
        ? [
            { address: activeTreasury(), maxLamports: fee.treasuryLamports },
            ...(fee.referrerLamports > 0
              ? [{ address: (p.referrer ?? configuredReferrer).trim(), maxLamports: fee.referrerLamports }]
              : []),
          ]
        : undefined,
    // Buys only: the fee must actually be present, or this build was tampered
    // with. The signer refuses. Sells never carry this — exits are never
    // blocked. See SignPolicy.requireFeeTransfer.
    requireFeeTransfer: requiredFee,
    trade: { side: p.action, mint: p.mint },
    // The relayer's published cut is 0.5% (+ a fixed 0.00005 SOL on the AMM
    // route). Allow 1.5% of the trade plus a floor, so a fee-schedule bump
    // does not strand users while a relayer that tried to take the trade
    // itself is still refused.
    //
    // A sell used to get a FLAT 20,000,000 lamports, justified as "0.5% of a
    // 4 SOL exit, and the local builder handles anything larger". The second
    // half is not true for a graduated token, which has no local build — so a
    // bigger exit was refused by its own fee cap. A limit must never block an
    // exit. `solValueLamports` is the caller's estimate of the proceeds (held
    // × price), the same number the fee is billed on, so scale with it and
    // keep the old flat value as the floor: small exits behave exactly as
    // before, and an estimate we never got still gets that floor.
    relayerFeeMaxLamports:
      p.action === 'buy' && typeof p.amount === 'number'
        ? Math.ceil(p.amount * LAMPORTS_PER_SOL * 0.015) + 500_000
        : Math.max(20_000_000, Math.ceil(solValueLamports * 0.015) + 500_000),
  };
  // A fan-out trade signs with its specific wallet; a normal trade with the
  // active one. Both go through the identical outflow policy above.
  const signedRes = p.walletId
    ? wallet.signVersionedTransactionForWallet(p.walletId, built.tx, signPolicy)
    : wallet.signVersionedTransaction(built.tx, signPolicy);
  timing.sign = Date.now() - signStart;
  if (!signedRes.ok || !signedRes.signed) return { ok: false, stage: 'sign', message: signedRes.message, timing };
  const base64 = Buffer.from(signedRes.signed).toString('base64');

  // 4. Simulate — watching our wallet SOL AND both possible token accounts
  //    (classic SPL + Token-2022, since Pump create_v2 coins use Token-2022),
  //    so we can bound the SOL loss AND confirm we receive tokens.
  const ataClassic = ataFor(owner, p.mint);
  const ata2022 = ataFor(owner, p.mint, TOKEN_2022_PROGRAM);
  // The pre-balance read is INDEPENDENT of the simulation — it asks the chain
  // what we hold now, not what the transaction would do. Running them in
  // sequence added a whole RPC round trip (~85ms on a public endpoint,
  // measured 2026-08-24) to every order for no reason. Both are still
  // required before the loss guard; only the waiting is removed.
  const simStart = Date.now();
  const [sim, preRes] = await Promise.all([
    simulateTransaction(p.httpUrl, base64, [owner, ataClassic, ata2022]),
    getBalance(p.httpUrl, owner),
  ]);
  timing.simulate = Date.now() - simStart;
  if (!sim.ok || !sim.data) return { ok: false, stage: 'simulate', message: `Simulation call failed: ${sim.message}`, timing };
  if (sim.data.err) {
    // Name the offending account for indexed errors (InsufficientFundsForRent,
    // etc.) so a revert points at a pubkey we can identify, not just an index.
    let acctNote = '';
    try {
      const errStr = JSON.stringify(sim.data.err);
      const m = errStr.match(/"account_index":(\d+)/);
      if (m) {
        const idx = Number(m[1]);
        const key = tx.message.staticAccountKeys[idx]?.toBase58();
        if (key) acctNote = ` [account ${idx} = ${key}]`;
      }
    } catch {
      /* diagnostic only */
    }
    // Anchor programs log the human reason ("Error Code: … Error Message: …");
    // a bare {"Custom":6004} tells the user nothing. Surface it when present.
    const reason = anchorReason(sim.data.logs ?? []);
    const raw = JSON.stringify(sim.data.err);
    // "InstructionError: [2, {Custom: 1}]" tells a user nothing. When the
    // failure is simply not enough SOL for fees, say that and what to do.
    const feeProblem = explainFeeFailure(raw, preRes.ok && preRes.data !== undefined ? preRes.data : null);
    return {
      ok: false,
      stage: 'simulate',
      message: feeProblem ?? `Simulation reverted: ${reason ? `${reason} ` : ''}${raw.slice(0, 160)}${acctNote}`,
      logs: sim.data.logs,
    };
  }

  // 5. Loss guard: bound = intended spend × (1 + slippage) + fixed overhead.
  const preLamports = preRes.ok && preRes.data !== undefined ? preRes.data : null;
  const postLamports = sim.data.postLamports[0];
  if (preLamports === null || postLamports === null) {
    // Name the cause: a 429 here reads as "rate limited", which the sell
    // retry recognises, rather than as a mystery refusal.
    const why = preLamports === null && !preRes.ok ? ` (${preRes.message})` : '';
    return { ok: false, stage: 'guard', message: `Could not read pre/post balance for the loss guard${why} — refusing` };
  }
  const lossSol = (preLamports - postLamports) / LAMPORTS_PER_SOL;
  // Sells spend no SOL (they yield it), so bound = overhead only. Buys bound
  // to intended SOL × (1 + slippage) + overhead.
  const spend = p.action === 'buy' && p.denominatedInSol && typeof p.amount === 'number' ? p.amount : 0;
  // The platform fee leaves the wallet in this same transaction, so the bound
  // has to expect it. Adding the EXACT injected amount (not a percentage
  // allowance) keeps the guard as tight as it was: a fee we did not inject
  // still trips it.
  const feeSol = fee.totalLamports / LAMPORTS_PER_SOL;
  // Tips are OUR outflow too, and on a sell they are most of it. With a max
  // Jito tip the app can legitimately spend more on an exit than OVERHEAD_SOL
  // allows, and the guard would then refuse the sell — a limit blocking an
  // exit, which is the one thing no limit here may do. Same discipline as the
  // fee above: add the EXACT lamports we injected, so a tip we did not inject
  // still trips the guard.
  const tipSol = plan.totalLamports / LAMPORTS_PER_SOL;
  const boundSol = spend * (1 + p.slippagePct / 100) + OVERHEAD_SOL + feeSol + tipSol;
  if (lossSol > boundSol) {
    return {
      ok: false,
      stage: 'guard',
      message: `Simulated loss ${lossSol.toFixed(5)} SOL exceeds bound ${boundSol.toFixed(5)} SOL — refusing`,
      simulatedLossSol: lossSol,
    };
  }

  // 6. Receipt check (buys): confirm we receive tokens in either token
  //    program's ATA. Advisory — the SOL loss guard above is the airtight
  //    protection; a derivation/routing edge case must not false-block a
  //    legitimate buy whose loss is already bounded. Surfaces as a warning.
  let receiptWarn = '';
  let receivedRaw = 0n;
  if (p.action === 'buy') {
    receivedRaw = tokenAmount(sim.data.postData[1]) + tokenAmount(sim.data.postData[2]);
    if (receivedRaw <= 0n) receiptWarn = ' — WARNING: could not confirm token receipt in simulation';
  } else if (p.action === 'sell') {
    // The sell-side twin, and the reason it needs one: the loss guard bounds
    // what we SPEND, and a sell whose proceeds were routed to someone else
    // spends only the fees — comfortably inside the bound. So it passed every
    // gate while paying out nothing.
    //
    // The test has to be one a real exit can never fail. `solValueLamports` is
    // the caller's estimate of the proceeds; when it is materially positive,
    // the wallet's simulated lamports must go UP. A stale estimate that halved
    // still gains. Dust, an unknown estimate and a worthless token are all
    // below the floor and are not checked at all — a limit never blocks an
    // exit, and a sell yielding nothing is exactly the exit that must proceed.
    const RECEIPT_FLOOR_LAMPORTS = 20_000_000; // 0.02 SOL — far above dust
    if (solValueLamports >= RECEIPT_FLOOR_LAMPORTS && lossSol >= 0) {
      return {
        ok: false,
        stage: 'guard',
        message:
          `Sell would not pay: expected about ${(solValueLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `but the simulated balance ${lossSol > 0 ? `FALLS ${lossSol.toFixed(5)}` : 'does not rise'} SOL — refusing. ` +
          'The proceeds are not arriving in this wallet.',
        simulatedLossSol: lossSol,
      };
    }
  }

  const progWarn = unknownPrograms.length ? ` (routed via ${unknownPrograms.map((p2) => p2!.slice(0, 8)).join(', ')})` : '';
  const warn = progWarn + receiptWarn;
  if (p.simulateOnly) {
    timing.total = (timing.build ?? 0) + (Date.now() - pipelineStart);
    // The paper book reads these. The token count comes from the simulated
    // post-state of our own ATA (the account a real fill would credit), the
    // cost from the simulated lamport delta — both real outputs of a real
    // simulation, not estimates.
    const decimalsKnown = typeof p.decimals === 'number' && Number.isInteger(p.decimals) && p.decimals >= 0;
    const simulatedTokensReceived = decimalsKnown ? Number(receivedRaw) / 10 ** (p.decimals as number) : Number(receivedRaw);
    return {
      ok: true,
      stage: 'simulate',
      timing,
      message: `Dry run OK [${source} tx] — simulated cost ${lossSol.toFixed(5)} SOL, within ${boundSol.toFixed(5)} bound, tokens received${warn}${tipNote}${feeNote}`,
      simulatedLossSol: lossSol,
      simulatedTokensReceived,
      simulatedTokensRaw: receivedRaw.toString(),
      decimalsKnown,
      simulatedCostSol: lossSol,
      logs: sim.data.logs,
    };
  }

  // 7. Broadcast: fan to every enabled lane and rebroadcast until confirmed
  //    or the blockhash lifetime is spent (same signature on all lanes —
  //    a double-execution is impossible). The old single-shot maxRetries=0
  //    send is what left 2026-07-24's sells expiring unconfirmed.
  /** "build 213 · tips 94 · sim 89 · send 640 · total 1036ms" */
  const timingNote = (): string => {
    const parts: string[] = [];
    if (timing.build !== undefined) parts.push(`build ${timing.build}${timing.buildSource === 'local' ? '·local' : ''}`);
    if (timing.tips !== undefined) parts.push(`tips ${timing.tips}`);
    if (timing.simulate !== undefined) parts.push(`sim ${timing.simulate}`);
    if (timing.sign !== undefined) parts.push(`sign ${timing.sign}`);
    // `send` is the fan-out alone; `land` is send → confirmed, i.e. the
    // chain's time plus our detection delay. Kept apart so a slow fill can
    // be attributed (the old single "send 953" hid that most of it was the
    // confirmation poll).
    if (timing.send !== undefined) parts.push(`send ${timing.send}`);
    if (timing.processed !== undefined) parts.push(`seen ${timing.processed}`);
    if (timing.confirm !== undefined) parts.push(`land ${timing.confirm}`);
    else if (timing.broadcast !== undefined) parts.push(`send ${timing.broadcast}`);
    return parts.length ? ` · ${parts.join(' ')} · total ${timing.total ?? 0}ms` : '';
  };

  const signature = base58Encode(VersionedTransaction.deserialize(signedRes.signed).signatures[0]);
  const castStart = Date.now();
  const cast = await broadcastAndConfirm({
    httpUrl: p.httpUrl,
    base64,
    signature,
    lanes: plan.lanes,
    lastValidBlockHeight,
    wssUrl: p.wssUrl,
    onProcessed: p.onProcessed ? () => p.onProcessed?.(signature) : undefined,
  });
  timing.broadcast = Date.now() - castStart;
  timing.send = cast.sendMs;
  timing.confirm = cast.confirmMs;
  timing.processed = cast.processedMs;
  timing.total = (timing.build ?? 0) + (Date.now() - pipelineStart);
  if (cast.chainErr) {
    return { ok: false, stage: 'confirm', message: `Landed but reverted on-chain ${signature.slice(0, 12)}… [${source} tx${tipNote}${feeNote}]${timingNote()}`, signature, simulatedLossSol: lossSol, timing };
  }
  // Not landed and not provably dead: the tx is PENDING, not failed. The
  // signature goes back to the caller so the ledger can keep watching it.
  if (!cast.landed && !cast.expired) {
    return {
      ok: false,
      stage: 'pending',
      message: `Unconfirmed after waiting — may still land ${signature.slice(0, 12)}… [${source} tx${tipNote}${feeNote}] lanes: ${cast.laneNotes}${timingNote()}`,
      signature,
      simulatedLossSol: lossSol,
      timing,
    };
  }
  return {
    ok: cast.landed,
    stage: cast.landed ? 'done' : 'confirm',
    message: cast.landed
      ? `Landed ${signature.slice(0, 12)}… [${source} tx${tipNote}${feeNote}]${timingNote()}`
      : `Blockhash expired unconfirmed — did not land ${signature.slice(0, 12)}… [${source} tx${tipNote}${feeNote}] lanes: ${cast.laneNotes}${timingNote()}`,
    signature,
    simulatedLossSol: lossSol,
    timing,
  };
}
