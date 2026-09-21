// Raydium pool accounts, read straight from the chain.
//
// Two pool programs, one shape out. Raydium runs three AMMs on Solana; this
// rail covers the two that hold plain constant-product pools — AMM v4 (the
// OpenBook-backed original) and CPMM (the newer one with no order book,
// which is where a LaunchLab curve migrates to). CLMM is concentrated
// liquidity with its own event shape and is deliberately NOT here.
//
// ─── The layouts, and how they were established ───────────────────────
//
// NOT copied from documentation. Verified on mainnet 2026-09-19 by reading
// real pools and searching their bytes for accounts the chain had just
// named beside them:
//
// AMM v4 (`AmmInfo`, 752 bytes) — two fresh pools, found via the accounts of
// their own `initialize2` instruction:
//   0    status        u64
//   32   coinDecimals  u64
//   40   pcDecimals    u64
//   224  poolOpenTime  u64   equal to the InitLog `time` of the creation
//   336  coinVault     pubkey
//   368  pcVault       pubkey
//   400  coinMint      pubkey
//   432  pcMint        pubkey
//   464  lpMint        pubkey
//   528  market        pubkey (OpenBook)
//   592  targetOrders  pubkey
// "coin" is Raydium's word for the base token and "pc" for the quote; in
// every sampled memecoin pool pc was wrapped SOL, but nothing here assumes
// it — `solSide` says which side SOL is, or that neither is.
//
// CPMM (`PoolState`, 637 bytes) — found by locating the mints a SwapEvent
// had just reported and the vaults its balance changes moved:
//   8    ammConfig     pubkey
//   40   poolCreator   pubkey
//   72   token0Vault   pubkey
//   104  token1Vault   pubkey
//   136  lpMint        pubkey
//   168  token0Mint    pubkey
//   200  token1Mint    pubkey
//   328  authBump      u8    (253 on every pool seen)
//   329  status        u8
//   330  lpMintDecimals u8
//   331  mint0Decimals u8    matched the mint's own decimals (8) on the sample
//   332  mint1Decimals u8    matched (6)
//
// A pool whose account is not exactly the expected size is skipped rather
// than misread: a different length means a different layout.

import { base58Encode } from '../chain/base58';
import { getAccountInfo, getMultipleAccountInfo } from '../chain/rpcClient';

/** Raydium AMM v4 — the OpenBook-backed constant-product pool program. */
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
/** Raydium CPMM — constant-product pools with no order book. */
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const AMM_V4_LEN = 752;
const CPMM_LEN = 637;

/** SPL token account layout: the u64 amount sits at offset 64. */
const TOKEN_AMOUNT_OFFSET = 64;

export type RaydiumPoolKind = 'amm-v4' | 'cpmm';

export interface RaydiumPoolState {
  kind: RaydiumPoolKind;
  pool: string;
  /** The pool's two sides in ITS order: coin/pc for v4, token0/token1 for CPMM. */
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  vaultA: string;
  vaultB: string;
  /** Which side is wrapped SOL, or null when neither — the tape prices in
   *  SOL and refuses to price a pool it cannot. */
  solSide: 'A' | 'B' | null;
  /** The non-SOL mint, i.e. the token a page is about. Null for a pool with
   *  no SOL side (a USDC pair) or with SOL on both (never seen, but a layout
   *  that reads that way is not one to trust). */
  baseMint: string | null;
  baseDecimals: number | null;
  /** Raw status, passed through rather than interpreted. */
  status: number;
  /** Pool creator — CPMM stores one; AMM v4 does not. */
  creator: string | null;
  lpMint: string;
  /** OpenBook market for an AMM v4 pool; CPMM has none. */
  market: string | null;
}

function pk(data: Buffer, off: number): string {
  return base58Encode(data.subarray(off, off + 32));
}

function withSides(
  s: Omit<RaydiumPoolState, 'solSide' | 'baseMint' | 'baseDecimals'>,
): RaydiumPoolState {
  const aSol = s.mintA === WSOL_MINT;
  const bSol = s.mintB === WSOL_MINT;
  const solSide: 'A' | 'B' | null = aSol && !bSol ? 'A' : bSol && !aSol ? 'B' : null;
  return {
    ...s,
    solSide,
    baseMint: solSide === 'A' ? s.mintB : solSide === 'B' ? s.mintA : null,
    baseDecimals: solSide === 'A' ? s.decimalsB : solSide === 'B' ? s.decimalsA : null,
  };
}

/** Parse an AMM v4 `AmmInfo` account. Exported for tests — it is pure. */
export function parseAmmV4Pool(pool: string, data: Buffer): RaydiumPoolState | null {
  if (data.length !== AMM_V4_LEN) return null;
  try {
    const coinDecimals = Number(data.readBigUInt64LE(32));
    const pcDecimals = Number(data.readBigUInt64LE(40));
    // A decimals field past 18 is not decimals; the layout has moved.
    if (coinDecimals > 18 || pcDecimals > 18) return null;
    return withSides({
      kind: 'amm-v4',
      pool,
      mintA: pk(data, 400),
      mintB: pk(data, 432),
      decimalsA: coinDecimals,
      decimalsB: pcDecimals,
      vaultA: pk(data, 336),
      vaultB: pk(data, 368),
      status: Number(data.readBigUInt64LE(0)),
      creator: null,
      lpMint: pk(data, 464),
      market: pk(data, 528),
    });
  } catch {
    return null;
  }
}

/** Parse a CPMM `PoolState` account. Exported for tests — it is pure. */
export function parseCpmmPool(pool: string, data: Buffer): RaydiumPoolState | null {
  if (data.length !== CPMM_LEN) return null;
  try {
    const dec0 = data.readUInt8(331);
    const dec1 = data.readUInt8(332);
    if (dec0 > 18 || dec1 > 18) return null;
    return withSides({
      kind: 'cpmm',
      pool,
      mintA: pk(data, 168),
      mintB: pk(data, 200),
      decimalsA: dec0,
      decimalsB: dec1,
      vaultA: pk(data, 72),
      vaultB: pk(data, 104),
      status: data.readUInt8(329),
      creator: pk(data, 40),
      lpMint: pk(data, 136),
      market: null,
    });
  } catch {
    return null;
  }
}

/** Parse by OWNER, which is the only thing that says which layout applies. */
export function parsePool(pool: string, owner: string, data: Buffer): RaydiumPoolState | null {
  if (owner === RAYDIUM_AMM_V4_PROGRAM) return parseAmmV4Pool(pool, data);
  if (owner === RAYDIUM_CPMM_PROGRAM) return parseCpmmPool(pool, data);
  return null;
}

/** True when this program owns pools this rail can tape. */
export function isRaydiumPoolProgram(owner: string): boolean {
  return owner === RAYDIUM_AMM_V4_PROGRAM || owner === RAYDIUM_CPMM_PROGRAM;
}

/**
 * Read one pool. Null for an address that is not a Raydium v4/CPMM pool —
 * which is the right answer for a pump, DBC or LaunchLab pool and means the
 * caller needs no label guesswork.
 */
export async function readPool(httpUrl: string, pool: string): Promise<RaydiumPoolState | null> {
  const r = await getAccountInfo(httpUrl, pool);
  if (!r.ok || !r.data) return null;
  return parsePool(pool, r.data.owner, r.data.data);
}

export interface PoolReserves {
  /** Raw base units in each vault. */
  reserveA: bigint;
  reserveB: bigint;
}

/** Parse the two vault balances out of their token accounts. Pure. */
export function parseReserves(vaultA: Buffer | null, vaultB: Buffer | null): PoolReserves | null {
  if (!vaultA || !vaultB) return null;
  if (vaultA.length < TOKEN_AMOUNT_OFFSET + 8 || vaultB.length < TOKEN_AMOUNT_OFFSET + 8) return null;
  try {
    return {
      reserveA: vaultA.readBigUInt64LE(TOKEN_AMOUNT_OFFSET),
      reserveB: vaultB.readBigUInt64LE(TOKEN_AMOUNT_OFFSET),
    };
  } catch {
    return null;
  }
}

/** The pool's current reserves — one request for both vaults. */
export async function readReserves(httpUrl: string, state: RaydiumPoolState): Promise<PoolReserves | null> {
  const r = await getMultipleAccountInfo(httpUrl, [state.vaultA, state.vaultB]);
  if (!r.ok || !r.data) return null;
  return parseReserves(r.data[0]?.data ?? null, r.data[1]?.data ?? null);
}

/**
 * Mid price in SOL per whole token from the reserves, or null when the pool
 * has no SOL side or an empty vault. A ratio of reserves is the pool's
 * quoted price, not a fill — fine for a list row, and the tape marks from
 * the trades themselves.
 */
export function priceSolFromReserves(state: RaydiumPoolState, reserves: PoolReserves): number | null {
  if (state.solSide === null || state.baseDecimals === null) return null;
  const sol = state.solSide === 'A' ? reserves.reserveA : reserves.reserveB;
  const tok = state.solSide === 'A' ? reserves.reserveB : reserves.reserveA;
  if (sol <= 0n || tok <= 0n) return null;
  const price = Number(sol) / 1e9 / (Number(tok) / 10 ** state.baseDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** SOL in the pool, from the reserves, or null when there is no SOL side. */
export function solInPool(state: RaydiumPoolState, reserves: PoolReserves): number | null {
  if (state.solSide === null) return null;
  const sol = state.solSide === 'A' ? reserves.reserveA : reserves.reserveB;
  return Number(sol) / 1e9;
}
