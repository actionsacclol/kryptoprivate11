// PumpPortal "Local" relayer client. Returns an UNSIGNED serialized
// transaction — our private key never leaves the app. We deserialize,
// validate, simulate, sign and send it ourselves (see liveSigner.ts).
//
// This is the safer path chosen over hand-building the volatile 27-account
// buy_v2 instruction: PumpPortal maintains the instruction against Pump's
// frequent (sometimes unannounced) redeploys, and our signer's simulation
// guard bounds the worst case regardless of what it returns.

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

export interface RelayerTradeRequest {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  /** Buy (denominatedInSol=true): SOL amount. Sell: token amount, or the
   *  string "100%" to sell the entire balance (avoids dust/rounding). */
  amount: number | string;
  denominatedInSol: boolean;
  /** Percent, e.g. 10. */
  slippage: number;
  /** SOL, e.g. 0.005. */
  priorityFee: number;
  /** 'auto' lets PumpPortal pick pump / pump-amm / raydium. */
  pool: 'auto' | 'pump' | 'pump-amm' | 'raydium' | 'raydium-cpmm' | 'launchlab' | 'bonk';
}

export interface RelayerResult {
  ok: boolean;
  message: string;
  /** Raw serialized (unsigned) VersionedTransaction bytes. */
  tx?: Uint8Array;
}

// PumpPortal 400/429s anonymous requests in bursts. Retry a transient
// streak, but briefly: the old 6 × 10 s with growing backoff meant a user
// could stare at a spinning Buy for ~70 s before hearing anything, when the
// honest answer after a few seconds is "this route cannot build it right
// now". A build normally answers in 200–400 ms.
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 4_000;
const RETRY_GAP_MS = 250;

export async function buildTrade(req: RelayerTradeRequest): Promise<RelayerResult> {
  const body = JSON.stringify({
    publicKey: req.publicKey,
    action: req.action,
    mint: req.mint,
    amount: req.amount,
    denominatedInSol: req.denominatedInSol ? 'true' : 'false',
    slippage: req.slippage,
    priorityFee: req.priorityFee,
    pool: req.pool,
  });
  // PumpPortal intermittently 400/429s anonymous requests (rate limiting), so
  // a single failure must not strand a position. Retry transient errors with
  // backoff; only give up after several attempts.
  let lastDetail = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(TRADE_LOCAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length < 64) {
          lastDetail = 'implausibly small transaction';
        } else {
          return { ok: true, message: attempt > 1 ? `ok (after ${attempt} tries)` : 'ok', tx: buf };
        }
      } else {
        let detail = `HTTP ${res.status}`;
        try {
          detail = (await res.text()).slice(0, 160) || detail;
        } catch {
          /* keep status */
        }
        lastDetail = detail;
        // 4xx other than 429 is usually permanent (bad params) — but PumpPortal
        // returns bare "Bad Request" for transient rate limits too, so we still
        // retry a couple of times before trusting it.
      }
    } catch (err) {
      lastDetail = (err as Error).message;
    }
    // A short fixed gap: a 429 burst that outlasts three quick tries is not
    // going to clear inside a click, and the local builder is the primary
    // route anyway.
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
  }
  return { ok: false, message: `Relayer rejected trade after ${MAX_ATTEMPTS} tries: ${lastDetail}` };
}
