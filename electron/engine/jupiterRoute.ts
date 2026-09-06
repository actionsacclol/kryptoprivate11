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

import { getJson, memo } from '../data/http';
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
 * unavailable — the quote then goes unrestricted and the signer's allowlist
 * is the (later, louder) gate.
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

export async function buildJupiterSwap(req: JupiterSwapRequest): Promise<JupiterSwapResult> {
  const isBuy = req.action === 'buy';
  const inputMint = isBuy ? WSOL : req.mint;
  const outputMint = isBuy ? req.mint : WSOL;
  const amount = isBuy ? BigInt(Math.round(Number(req.amount) * LAMPORTS_PER_SOL)) : BigInt(req.amount);
  if (amount <= 0n) return { ok: false, message: 'amount is zero' };
  const slippageBps = Math.max(1, Math.min(5_000, Math.round(req.slippagePct * 100)));

  const dexes = await allowedDexLabels();
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    // Intermediate hops through obscure tokens are where routes go wrong.
    restrictIntermediateTokens: 'true',
  });
  if (dexes) q.set('dexes', dexes.join(','));

  const quote = await getJson<QuoteResponse>('jupiter', `/swap/v1/quote?${q.toString()}`, { priority: true, timeoutMs: 6_000 });
  if (!quote.ok || !quote.data) return { ok: false, message: `quote: ${quote.message}` };
  const qd = quote.data;
  if (qd.error || !qd.outAmount) {
    return { ok: false, message: `quote: ${qd.error ?? 'no route'}${qd.errorCode ? ` (${qd.errorCode})` : ''}` };
  }

  // Priority fee: Jupiter sizes the compute budget itself; we cap what it may
  // spend at the SOL the caller would have paid on our own build.
  const maxLamports = Math.max(1_000, Math.min(20_000_000, Math.round(req.priorityFeeSol * LAMPORTS_PER_SOL)));
  const swap = await getJson<SwapResponse>('jupiter', '/swap/v1/swap', {
    priority: true,
    timeoutMs: 8_000,
    json: {
      quoteResponse: qd,
      userPublicKey: req.publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: 'high' } },
    },
  });
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
  const solValueLamports = Number(isBuy ? qd.inAmount : qd.outAmount);
  return {
    ok: true,
    message: `jupiter ${req.action} via ${route.join(' → ') || 'unknown route'}${qd.priceImpactPct ? ` (impact ${(Number(qd.priceImpactPct) * 100).toFixed(2)}%)` : ''}`,
    tx,
    lastValidBlockHeight: typeof swap.data.lastValidBlockHeight === 'number' ? swap.data.lastValidBlockHeight : undefined,
    solValueLamports: Number.isFinite(solValueLamports) ? solValueLamports : undefined,
    outAmount: qd.outAmount,
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
  const dexes = await allowedDexLabels();
  const q = new URLSearchParams({
    inputMint: mint,
    outputMint: WSOL,
    amount: raw.toString(),
    slippageBps: '1000',
    restrictIntermediateTokens: 'true',
  });
  if (dexes) q.set('dexes', dexes.join(','));
  const quote = await getJson<QuoteResponse>('jupiter', `/swap/v1/quote?${q.toString()}`, { priority: true, timeoutMs: 4_000 });
  if (!quote.ok || !quote.data || quote.data.error || !quote.data.outAmount) return null;
  const lamports = Number(quote.data.outAmount);
  if (!Number.isFinite(lamports) || lamports < 0) return null;
  return { lamports, route: (quote.data.routePlan ?? []).map((r) => r.swapInfo?.label ?? '?') };
}
