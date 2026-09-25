// Pump.fun bonding-curve math — INTEGER ONLY.
//
// Monetary quantities (lamports, token base units, reserves, fees) never
// touch floating point. All quote math is bigint with explicit rounding
// direction: division that determines what the USER RECEIVES rounds
// against the user (ceil on the divisor side), matching how on-chain
// programs round. Floats exist only at the display edge (spot price,
// progress %) where they are never fed back into a monetary calculation.
//
// The curve is constant-product over *virtual* reserves:
//   k = vSol * vTok ;  spot price = vSol / vTok
// Paper fills walk the curve (price impact included), pay the protocol fee
// and a modeled priority fee — a buy→sell round trip always loses money.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_FACTOR = 1_000_000; // pump tokens are 6 decimals

/** Pump protocol fee in basis points (1%), applied on both sides. */
export const FEE_BPS = 100n;
const BPS = 10_000n;

/** Modeled priority fee + tip per transaction, in lamports. */
export const MODELED_TX_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL

/** Curve completes around 85 real SOL; virtual start is 30 SOL / 1.073B tokens. */
export const INITIAL_VIRTUAL_SOL = 30n * BigInt(LAMPORTS_PER_SOL);
export const INITIAL_VIRTUAL_TOKENS = 1_073_000_000n * BigInt(TOKEN_FACTOR);
const COMPLETE_VIRTUAL_SOL = 115n * BigInt(LAMPORTS_PER_SOL); // 30 virtual + ~85 raised

/** Ceiling division for positive bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export interface BuyQuote {
  /** Token base units received. */
  tokensOut: bigint;
  /** Total modeled fees in lamports (protocol + tx fee). */
  feesLamports: bigint;
}

export interface SellQuote {
  /** Lamports received after all modeled fees. */
  solOutLamports: bigint;
  feesLamports: bigint;
}

/** Quote buying with `solInLamports` against current virtual reserves. */
export function buyQuote(solInLamports: bigint, vSol: bigint, vTok: bigint): BuyQuote {
  if (solInLamports <= 0n || vSol <= 0n || vTok <= 0n) {
    return { tokensOut: 0n, feesLamports: 0n };
  }
  const protocolFee = (solInLamports * FEE_BPS) / BPS; // floor — fee taken from input
  const effectiveIn = solInLamports - protocolFee;
  const k = vSol * vTok; // u128-scale intermediate — bigint handles it exactly
  const newVSol = vSol + effectiveIn;
  // Tokens the curve KEEPS rounds up, so tokens out rounds down (against user).
  const tokensOut = vTok - ceilDiv(k, newVSol);
  return {
    tokensOut: tokensOut > 0n ? tokensOut : 0n,
    feesLamports: protocolFee + MODELED_TX_FEE_LAMPORTS,
  };
}

/** Quote selling `tokensIn` base units against current virtual reserves. */
export function sellQuote(tokensIn: bigint, vSol: bigint, vTok: bigint): SellQuote {
  if (tokensIn <= 0n || vSol <= 0n || vTok <= 0n) {
    return { solOutLamports: 0n, feesLamports: 0n };
  }
  const k = vSol * vTok;
  const newVTok = vTok + tokensIn;
  // Lamports the curve KEEPS rounds up, so gross out rounds down.
  const grossOut = vSol - ceilDiv(k, newVTok);
  if (grossOut <= 0n) return { solOutLamports: 0n, feesLamports: 0n };
  const protocolFee = ceilDiv(grossOut * FEE_BPS, BPS); // fee rounds against user
  const net = grossOut - protocolFee - MODELED_TX_FEE_LAMPORTS;
  return {
    solOutLamports: net > 0n ? net : 0n,
    feesLamports: protocolFee + MODELED_TX_FEE_LAMPORTS,
  };
}

// ── Display-edge helpers (floats allowed, never fed back into money) ──

/** Spot price in SOL per (whole) token — display only. */
export function spotPriceSol(virtualSolReserves: bigint, virtualTokenReserves: bigint): number {
  const vSol = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
  const vTok = Number(virtualTokenReserves) / TOKEN_FACTOR;
  if (vTok <= 0) return 0;
  return vSol / vTok;
}

/** The curve is complete when its sellable supply (793.1 M tokens) is gone:
 *  vTok has fallen from 1.073 B to 279.9 M. This is the actual completion
 *  condition — the `complete` event and this floor coincided on 100 % of
 *  2,266 graduations in the July tape (launchset-2026-08-30 README §3). */
export const CURVE_SELLABLE_TOKENS = 793_100_000n * BigInt(TOKEN_FACTOR);
export const CURVE_COMPLETE_VIRTUAL_TOKENS = INITIAL_VIRTUAL_TOKENS - CURVE_SELLABLE_TOKENS;

/** Token-side curve progress, 0..100 — the share of the sellable supply
 *  already sold. Valid in every curve regime. The SOL-side version below is
 *  meaningless on "mixed" curves (vSol moves far more per SOL than constant
 *  product allows, and mostly sits BELOW 30 SOL): on the 07-27 runner flags
 *  it read 0 % on 70 % of them and 100 % on 2 %. Mixed curves were 76 % of
 *  those flags and 91 % of the live September ones. */
export function curveProgressTokenPct(virtualTokenReserves: bigint): number {
  const sold = Number(INITIAL_VIRTUAL_TOKENS - virtualTokenReserves);
  const pct = (sold / Number(CURVE_SELLABLE_TOKENS)) * 100;
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}

/** How far along the bonding curve is, 0..100 — display only. SOL-side:
 *  only meaningful on classic constant-product curves; prefer
 *  curveProgressTokenPct wherever vTok is at hand. */
export function curveProgressPct(virtualSolReserves: bigint): number {
  const num = Number(virtualSolReserves - INITIAL_VIRTUAL_SOL);
  const den = Number(COMPLETE_VIRTUAL_SOL - INITIAL_VIRTUAL_SOL);
  const pct = (num / den) * 100;
  return Math.max(0, Math.min(100, pct));
}

export function lamportsToSol(l: bigint): number {
  return Number(l) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function tokensToWhole(t: bigint): number {
  return Number(t) / TOKEN_FACTOR;
}
