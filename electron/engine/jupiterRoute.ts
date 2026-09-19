// Jupiter swap route — the second build source, between the local curve
// builder and the PumpPortal relayer.
//
// Why (2026-09-02): PumpPortal's keyless `trade-local` began answering a bare
// `400 Bad Request` to every well-formed request — from a clean residential
// IP, with browser headers, for a token trading that minute — so graduated
// pump tokens (PumpSwap) had NO route, and tokens on Orca / Raydium CLMM /
// Meteora never had one. Jupiter's keyless swap API quotes and builds a
// versioned transaction for any of them. The bytes then go through exactly
// the pipeline a relayer build does: program allowlist, tip + fee injection,
// simulation, loss guard, signing, the confirmation socket. Nothing here
// touches a key.
//
// Routes are RESTRICTED to DEX programs the signer allowlists (via Jupiter's
// own program-id → label map), so a quote never names a program the signer
// would then refuse. Rate budget: the jupiter host gap is 120 ms and these
// calls carry `priority: true` — they never queue behind Discover.

import { getJson, memo, type FetchResult } from '../data/http';
import type { WalletHolding } from '@shared/types';
import { KNOWN_TRADE_PROGRAMS } from '../system/signPolicy';

const WSOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface JupiterSwapRequest {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  /** Buy: SOL to spend. Sell: RAW token units to sell (base units). */
  amount: number | bigint;
  slippagePct: number;
  /** SOL — converted to a lamport cap for Jupiter's prioritisation. */
  priorityFeeSol: number;
}

export interface JupiterSwapResult {
  ok: boolean;
  message: string;
  /** Raw serialized (unsigned) VersionedTransaction bytes. */
  tx?: Uint8Array;
  lastValidBlockHeight?: number;
  /** Quoted SOL side of the trade in lamports: spent on a buy, received on a
   *  sell — the honest basis for the platform fee. */
  solValueLamports?: number;
  /** Quoted token units out (buy) — informational. */
  outAmount?: string;
  /** The quote's own floor after slippage: the least that may arrive. The
   *  swap's receipt check holds the simulation to it. */
  otherAmountThreshold?: string;
  /** DEX labels on the route, for the log. */
  route?: string[];
}

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan?: Array<{ swapInfo?: { label?: string; ammKey?: string }; percent?: number }>;
  error?: string;
  errorCode?: string;
}

interface SwapResponse {
  swapTransaction?: string;
  lastValidBlockHeight?: number;
  error?: string;
}

/**
 * DEX labels Jupiter may route through: the signer's allowlisted programs,
 * translated with Jupiter's own map (memoised an hour). Null when the map is
 * unavailable — and the route is then REFUSED (see buildRoute), because the
 * `dexes` parameter is the only thing that restricts which venue Jupiter
 * uses: the DEX runs as a CPI under Jupiter's own program, invisible to the
 * signer's top-level check. Measured 2026-09-11: an unrestricted quote
 * routed SOL→USDC through GoonFi and USDC→USDT through BisonFi, neither on
 * the allowlist; the same request with `dexes` went through Whirlpool.
 */
async function allowedDexLabels(): Promise<string[] | null> {
  const map = await memo<Record<string, string>>('jup:program-labels', 60 * 60_000, async () => {
    const r = await getJson<Record<string, string>>('jupiter', '/swap/v1/program-id-to-label', { priority: true });
    return r.ok && r.data && typeof r.data === 'object' ? r.data : null;
  });
  if (!map) return null;
  const allowed = new Set(KNOWN_TRADE_PROGRAMS);
  const labels = new Set<string>();
  for (const [pid, label] of Object.entries(map)) if (allowed.has(pid) && label) labels.add(label);
  return labels.size ? [...labels] : null;
}

/**
 * One more try after a 429, a beat later. Jupiter is the only route for a
 * graduated token and for every partial sell, and a single refused quote
 * used to end the order (the relayer behind it 400s anonymous requests).
 * Bounded at one retry so an exit is delayed by ~1.2 s, never stalled.
 */
async function onceMoreOn429<T>(run: () => Promise<FetchResult<T>>): Promise<FetchResult<T>> {
  const first = await run();
  if (first.status !== 429) return first;
  await new Promise((r) => setTimeout(r, 1_200));
  return run();
}

export async function buildJupiterSwap(req: JupiterSwapRequest): Promise<JupiterSwapResult> {
  const isBuy = req.action === 'buy';
  return buildRoute({
    publicKey: req.publicKey,
    inputMint: isBuy ? WSOL : req.mint,
    outputMint: isBuy ? req.mint : WSOL,
    amountRaw: isBuy ? BigInt(Math.round(Number(req.amount) * LAMPORTS_PER_SOL)) : BigInt(req.amount),
    slippagePct: req.slippagePct,
    priorityFeeSol: req.priorityFeeSol,
    label: req.action,
  });
}

/**
 * Any mint to any mint — the Wallet Utilities swapper.
 *
 * The trade path above is this with one side pinned to wrapped SOL. Splitting
 * them apart rather than adding a third `action` keeps the trade path's
 * signature exactly as it was: a swap is a NEW caller of the same route
 * builder, not a new branch inside the one every buy and sell goes through.
 *
 * ─── Why the signer needs no new rule for this ─────────────────────────
 *
 * A token-to-token swap is, to the signing policy, a SELL of the input mint:
 * the input leaves our token account (permitted on a sell of the traded
 * mint, into an account the route itself names) and the output merely
 * arrives, which needs no permission at all because nothing of ours moves
 * out. So `swap.ts` signs with `trade: { side: 'sell', mint: inputMint }`
 * and every existing refusal stays exactly as strict as it was.
 */
export async function buildPairSwap(req: {
  publicKey: string;
  inputMint: string;
  outputMint: string;
  /** Base units of the INPUT mint. */
  amountRaw: bigint;
  slippagePct: number;
  priorityFeeSol: number;
}): Promise<JupiterSwapResult> {
  if (req.inputMint === req.outputMint) return { ok: false, message: 'a swap needs two different tokens' };
  return buildRoute({ ...req, label: 'swap' });
}

interface RouteRequest {
  publicKey: string;
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippagePct: number;
  priorityFeeSol: number;
  label: string;
}

async function buildRoute(req: RouteRequest): Promise<JupiterSwapResult> {
  const { inputMint, outputMint } = req;
  const isBuy = inputMint === WSOL;
  const amount = req.amountRaw;
  if (amount <= 0n) return { ok: false, message: 'amount is zero' };
  const slippageBps = Math.max(1, Math.min(5_000, Math.round(req.slippagePct * 100)));

  const dexes = await allowedDexLabels();
  // The quote that becomes a SIGNED transaction is never unrestricted. (The
  // display quote in quoteSellLamports below may be — it prices a holding
  // and signs nothing.)
  if (!dexes) return { ok: false, message: 'Could not read the venue list that restricts this route — nothing was sent. Try again in a moment.' };
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    // Intermediate hops through obscure tokens are where routes go wrong.
    restrictIntermediateTokens: 'true',
  });
  q.set('dexes', dexes.join(','));

  const quote = await onceMoreOn429(() =>
    getJson<QuoteResponse>('jupiter', `/swap/v1/quote?${q.toString()}`, { priority: true, timeoutMs: 6_000 }),
  );
  if (!quote.ok || !quote.data) return { ok: false, message: `quote: ${quote.message}` };
  const qd = quote.data;
  if (qd.error || !qd.outAmount) {
    return { ok: false, message: `quote: ${qd.error ?? 'no route'}${qd.errorCode ? ` (${qd.errorCode})` : ''}` };
  }

  // Priority fee: Jupiter sizes the compute budget itself; we cap what it may
  // spend at the SOL the caller would have paid on our own build.
  const maxLamports = Math.max(1_000, Math.min(20_000_000, Math.round(req.priorityFeeSol * LAMPORTS_PER_SOL)));
  const swap = await onceMoreOn429(() =>
    getJson<SwapResponse>('jupiter', '/swap/v1/swap', {
      priority: true,
      timeoutMs: 8_000,
      json: {
        quoteResponse: qd,
        userPublicKey: req.publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: 'high' } },
      },
    }),
  );
  if (!swap.ok || !swap.data) return { ok: false, message: `swap: ${swap.message}` };
  if (swap.data.error || !swap.data.swapTransaction) return { ok: false, message: `swap: ${swap.data.error ?? 'no transaction returned'}` };

  let tx: Uint8Array;
  try {
    tx = new Uint8Array(Buffer.from(swap.data.swapTransaction, 'base64'));
  } catch {
    return { ok: false, message: 'swap: transaction was not valid base64' };
  }
  if (tx.length < 64) return { ok: false, message: 'swap: implausibly small transaction' };

  const route = (qd.routePlan ?? []).map((r) => r.swapInfo?.label ?? '?');
  // The SOL leg, whichever side it is on. A token-to-token pair has NO SOL
  // leg, so this stays undefined rather than reporting a token amount as
  // lamports — swap.ts prices those separately and says where the number
  // came from.
  //
  // ─── A SELL is valued at the QUOTE, and that is deliberate ──────────
  //
  // This is what the platform fee is charged on, and on Solana the fee
  // transfer is injected into the same transaction BEFORE signing — so unlike
  // the EVM rail, which sends its fee afterwards and rebases on the actual
  // fill, there is no later moment here in which to correct an estimate.
  //
  // The quote is the right estimate anyway: it is UNBIASED. Fills land near
  // it, sometimes above and sometimes below, so the fee averages to the
  // published 0.5 %. Measured on a real round trip 2026-09-11 the fill came in
  // 11 % under quote and the fee worked out at 0.556 % of what arrived — which
  // looks like an overcharge in isolation and is simply the other tail of the
  // same distribution.
  //
  // Switching to `otherAmountThreshold` (the slippage floor) was considered
  // and rejected: the floor sits a full slippage tolerance below the quote —
  // 12 % on this app's default — so it would undercharge SYSTEMATICALLY on
  // every sell, forever, to correct an occasional few thousand lamports. An
  // unbiased estimate beats a deliberately pessimistic one.
  const solLeg = isBuy ? qd.inAmount : outputMint === WSOL ? qd.outAmount : null;
  const solValueLamports = solLeg === null ? Number.NaN : Number(solLeg);
  return {
    ok: true,
    message: `jupiter ${req.label} via ${route.join(' → ') || 'unknown route'}${qd.priceImpactPct ? ` (impact ${(Number(qd.priceImpactPct) * 100).toFixed(2)}%)` : ''}`,
    tx,
    lastValidBlockHeight: typeof swap.data.lastValidBlockHeight === 'number' ? swap.data.lastValidBlockHeight : undefined,
    solValueLamports: Number.isFinite(solValueLamports) ? solValueLamports : undefined,
    outAmount: qd.outAmount,
    otherAmountThreshold: qd.otherAmountThreshold,
    route,
  };
}

/**
 * What selling `raw` units of `mint` would fetch RIGHT NOW, in lamports, on
 * the routes the signer allows — the honest value of a holding. Spot price ×
 * amount is not: on 2026-09-02 a DBC token with a live curve pool and a dead
 * $1 pool was valued off the dead pool at −90 % while an actual sell returned
 * the cost back. Null when Jupiter has no route (then the caller falls back
 * to spot and says so).
 */
export async function quoteSellLamports(mint: string, raw: bigint): Promise<{ lamports: number; route: string[] } | null> {
  if (raw <= 0n) return null;
  // A DISPLAY value, so: not on the priority lane (six of these fired
  // together used to bypass Jupiter's park and re-park it while a real sell
  // waited), and memoised 20 s so the three portfolio pollers share one.
  return memo(`jup:liq:${mint}:${raw.toString()}`, 20_000, async () => {
    const dexes = await allowedDexLabels();
    const q = new URLSearchParams({
      inputMint: mint,
      outputMint: WSOL,
      amount: raw.toString(),
      slippageBps: '1000',
      restrictIntermediateTokens: 'true',
    });
    if (dexes) q.set('dexes', dexes.join(','));
    const quote = await getJson<QuoteResponse>('jupiter', `/swap/v1/quote?${q.toString()}`, { timeoutMs: 4_000 });
    if (!quote.ok || !quote.data || quote.data.error || !quote.data.outAmount) return null;
    const lamports = Number(quote.data.outAmount);
    if (!Number.isFinite(lamports) || lamports < 0) return null;
    return { lamports, route: (quote.data.routePlan ?? []).map((r) => r.swapInfo?.label ?? '?') };
  });
}

/**
 * What each holding would actually FETCH if sold right now, in lamports.
 *
 * Not the spot price times the balance: a real exit walks the book, and on a
 * thin memecoin those are different numbers. A mint with no quote is absent
 * from the map and the caller falls back to spot rather than reporting zero.
 *
 * Six lanes, each quote capped at 2.5 s: a wallet with thirty dead tokens in
 * it must not hold the whole portfolio build hostage to the slowest router.
 *
 * Lived in engine.ts as a private method with no `this` in it (2026-09-18).
 * It belongs beside the quote it calls, not in portfolio.ts: that module is
 * pure assembly, and giving it a network call made its test bundle drag in
 * web3.js to compute arithmetic.
 */
export async function liquidationQuotes(holdings: WalletHolding[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const targets = holdings.filter((h) => {
    try {
      return BigInt(h.amountRaw) > 0n;
    } catch {
      return false;
    }
  });
  const CONCURRENCY = 6;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async (_, lane) => {
      for (let i = lane; i < targets.length; i += CONCURRENCY) {
        const h = targets[i];
        try {
          const q = await Promise.race([
            quoteSellLamports(h.mint, BigInt(h.amountRaw)),
            new Promise<null>((r) => setTimeout(() => r(null), 2_500)),
          ]);
          if (q) out.set(h.mint, q.lamports);
        } catch {
          /* no quote → spot fallback */
        }
      }
    }),
  );
  return out;
}

