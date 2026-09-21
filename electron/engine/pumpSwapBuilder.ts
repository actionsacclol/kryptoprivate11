// PumpSwap (pump-amm) local trade builder — graduated pump coins with no
// third party in the path.
//
// A pump coin that completes its curve trades on pump's own AMM from then
// on. Until now the app built those trades through Jupiter's keyless HTTP
// API (a 120 ms host gap, parked under load) and then PumpPortal (rate
// limited, refuses VPN exits) — two services between a user and a sell.
// The curve builder already showed the shape that needs neither: read the
// accounts a trade needs off the chain in one batch, derive every address
// from seeds, quote from the reserves, and hand the bytes to the same
// validate → simulate → loss-guard → sign pipeline. Nothing here touches a
// key, or any network but the RPC.
//
// Everything below was verified on mainnet 2026-09-19
// (docs/pumpswap-builder-2026-09-19.md):
//   • the buy/sell discriminators are Anchor's global:buy / global:sell —
//     the same bytes as the curve's, because Anchor hashes the NAME;
//   • the 25-account buy and 23-account sell layouts, read from direct
//     top-level trades, every slot matched to a derivation (a PDA, an ATA, or
//     a global-config field) and its writability to the message header;
//   • the pool of a graduated coin: index 0, creator = PDA(["pool-authority",
//     mint], pump), pool = PDA(["pool", 0u16, creator, mint, WSOL], pump-amm)
//     — 3 of 3 recent migrations, a mayhem coin among them;
//   • the quote math: exact constant product rounded against the user, fees
//     ADDED on a buy and SUBTRACTED on a sell — a BuyEvent's quote equalled
//     ceil(k / (base − out)) − quote to the lamport and its userQuote that
//     plus the lp and protocol fees; a SellEvent the mirror;
//   • fees come from a market-cap tier table in the pump-fees program's
//     fee_config (25 tiers): 125 bps at the bottom falling to 30 bps past
//     ~98k SOL of market cap, the coin creator's share included. Sizing uses
//     the WORST tier, so a buy may leave a fraction of a percent of its
//     budget unspent and a sell's floor sits a little low — the honest
//     direction, and the simulation's loss guard bounds the real cost.
//
// ─── Wrapped SOL ──────────────────────────────────────────────────────
//
// The AMM trades wrapped SOL, not SOL. A buy therefore wraps first — create
// the wallet's WSOL ATA if it is missing, transfer the budget into it,
// SyncNative — and closes that account after the swap so the change comes
// back as SOL. A sell creates the ATA to receive into and closes it the same
// way. The signer allows exactly this and nothing more: a transfer to the
// wallet's OWN WSOL ATA under a trade, SyncNative, and CloseAccount back to
// the wallet (signPolicy.ts).

import { sha256 } from '@noble/hashes/sha256';
import { ComputeBudgetProgram, MessageV0, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { base58Encode } from '../chain/base58';
import {
  ATA_PROGRAM,
  PUMP_AMM_PROGRAM,
  PUMP_FEES_PROGRAM,
  PUMP_SWAP_BUYBACK_VAULT_FALLBACK,
  PUMP_FEE_RECIPIENT_FALLBACK,
  PUMP_RESERVED_FEE_RECIPIENT_FALLBACK,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  ataFor,
  bondingCurveFor,
  isOnCurve,
  pumpPoolAuthorityFor,
  pumpSwapCanonicalPoolFor,
  pumpSwapCreatorVaultAuthorityFor,
  pumpSwapEventAuthorityFor,
  pumpSwapFeeConfigFor,
  pumpSwapGlobalConfigFor,
  pumpSwapGlobalVolumeAccumulatorFor,
  pumpSwapPoolV2For,
  pumpSwapUserVolumeAccumulatorFor,
} from '../chain/addresses';
import { getMultipleAccountInfo, getTokenBalanceRaw } from '../chain/rpcClient';
import { parseCurve, recentBlockhash, sellAmountFor, sellPctOf, tokenAccountAmount, type LocalBuildResult } from './txBuilder';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const disc = (name: string): Buffer => Buffer.from(sha256(new TextEncoder().encode(name)).slice(0, 8));
/** `global:buy` / `global:sell` — 66063d1201daebea / 33e685a4017f83ad. */
export const PUMP_SWAP_BUY_DISC = disc('global:buy');
export const PUMP_SWAP_SELL_DISC = disc('global:sell');
const POOL_DISC = disc('account:Pool');
const GLOBAL_CONFIG_DISC = disc('account:GlobalConfig');

/**
 * The worst fee tier, in basis points, for sizing. fee_config on 2026-09-19:
 * lp 2 + protocol 93 + creator 30 at a market cap under 420 SOL, falling to
 * 30 bps past ~98k SOL. The tier a trade lands in is the program's call at
 * execution; sizing with the ceiling can only leave budget unspent.
 */
export const PUMP_SWAP_FEE_CEILING_BPS = 125n;
/** The program rounds each of its three fee components (lp, protocol,
 *  creator) UP separately: the real buy in the fixture paid 125 bps and
 *  3 lamports. Sizing keeps that many lamports back so a flat ceiling is
 *  still a ceiling. */
const FEE_ROUNDING_LAMPORTS = 3n;
/** Compute-unit floor for a wrapped buy or sell; measured by simulation in
 *  test/pumpswap.live.mjs (units consumed are printed there). */
export const PUMP_SWAP_MIN_COMPUTE_UNITS = 250_000;
const BPS = 10_000n;

// ── Pool ──────────────────────────────────────────────────────────────

/**
 * pump-amm `Pool`, 301 bytes on mainnet:
 *   8 bump u8 · 9 index u16 · 11 creator · 43 base_mint · 75 quote_mint ·
 *   107 lp_mint · 139 pool_base_token_account · 171 pool_quote_token_account ·
 *   203 lp_supply u64 · 211 coin_creator · 243 two bytes (0 on every pool
 *   seen) · 245 virtual quote reserve u64 · zeros.
 * Located by searching real pools for the accounts their own trades named;
 * PDA(["pool", index, creator, base, quote]) reproduced every sampled pool.
 *
 * The VIRTUAL QUOTE RESERVE is the fact that makes pricing work on a
 * pump-migrated pool. Its swaps do not price on the vaults alone: fitting
 * twelve consecutive real swaps on one pool, every one priced as constant
 * product with the quote vault PLUS a fixed 17.5845 SOL, to the lamport —
 * and that number is the u64 at 245 (0 on a third-party pool, whose swaps
 * priced on the bare vaults exactly). A migration seeds a fraction of a SOL
 * of real liquidity into some pools; the virtual reserve keeps the price
 * where the curve left it instead of letting the first trade move it 100×.
 */
export interface PumpSwapPool {
  pool: string;
  bump: number;
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseAta: string;
  poolQuoteAta: string;
  lpSupply: bigint;
  /** The coin's creator, whose vault takes the creator fee; the system
   *  program (all zeros) when there is none. */
  coinCreator: string;
  /** Added to the quote vault's balance in every quote. 0 on pools that
   *  price on their vaults alone. */
  virtualQuote: bigint;
}

export function parsePool(pool: string, data: Uint8Array): PumpSwapPool | null {
  const d = Buffer.from(data);
  if (d.length < 243 || !d.subarray(0, 8).equals(POOL_DISC)) return null;
  const pk = (o: number): string => base58Encode(d.subarray(o, o + 32));
  try {
    return {
      pool,
      bump: d[8],
      index: d.readUInt16LE(9),
      creator: pk(11),
      baseMint: pk(43),
      quoteMint: pk(75),
      lpMint: pk(107),
      poolBaseAta: pk(139),
      poolQuoteAta: pk(171),
      lpSupply: d.readBigUInt64LE(203),
      coinCreator: pk(211),
      virtualQuote: d.length >= 253 ? d.readBigUInt64LE(245) : 0n,
    };
  } catch {
    return null;
  }
}

// ── Global config ─────────────────────────────────────────────────────

/**
 * pump-amm `GlobalConfig`, 949 bytes on 2026-09-19:
 *   8 admin · 40 lp_fee_basis_points u64 · 48 protocol_fee_basis_points u64 ·
 *   56 disable_flags u8 · 57 protocol_fee_recipients [8 × 32] ·
 *   313 coin_creator_fee_basis_points u64 · … · 835 buyback vault.
 * The buyback vault is the pump-fees program's `BuybackVault` account
 * (disc sha256("account:BuybackVault")) that every buy and sell passes with
 * its WSOL ATA; found by searching the config for the account the trades
 * carried, the way the curve builder found its fee vault in Global.
 */
export interface PumpSwapGlobal {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  disableFlags: number;
  /** The eight recipients at 57, zeros dropped. A trade on a normal coin
   *  may name any of them (five different ones seen on one pool). */
  protocolFeeRecipients: string[];
  /**
   * The recipients a MAYHEM-mode coin's trades must name instead: one at
   * 385 and seven from 418, the same shape as the curve's Global (single
   * @483, then [7] @516 — a one-byte gap before the array, both places).
   * Naming a normal recipient on a mayhem pool reverts
   * `InvalidProtocolFeeRecipient (6013)` (measured 2026-09-19); the two
   * mayhem trades seen used @385 and @418+4×32.
   */
  reservedFeeRecipients: string[];
  coinCreatorFeeBps: bigint;
  /**
   * The pump-fees program's `BuybackVault` accounts — eight of them at
   * 643..875, one every 32 bytes, rotated across trades the way the fee
   * recipients are (two live trades on one pool named two different ones).
   * Every one seen was a 208-byte pfee-owned account with the BuybackVault
   * discriminator; the last is the account pump's curve Global names as its
   * fee vault too. Zeros and on-curve slots dropped.
   */
  buybackVaults: string[];
  /** False when a field fell back to a constant: pump reshaped the config. */
  fromChain: boolean;
}

const GLOBAL_BUYBACK_VAULTS_OFFSET = 643;
const GLOBAL_BUYBACK_VAULTS = 8;

export function parseGlobalConfig(data: Uint8Array): PumpSwapGlobal {
  const d = Buffer.from(data);
  const fallback: PumpSwapGlobal = {
    lpFeeBps: 25n,
    protocolFeeBps: 5n,
    disableFlags: 0,
    // pump's #0 recipient on 2026-09-19 — the curve's fee recipient too.
    protocolFeeRecipients: [PUMP_FEE_RECIPIENT_FALLBACK],
    // pump's reserved #0 — the same account the curve's mayhem trades name.
    reservedFeeRecipients: [PUMP_RESERVED_FEE_RECIPIENT_FALLBACK],
    coinCreatorFeeBps: 0n,
    buybackVaults: [PUMP_SWAP_BUYBACK_VAULT_FALLBACK],
    fromChain: false,
  };
  if (d.length < 321 || !d.subarray(0, 8).equals(GLOBAL_CONFIG_DISC)) return fallback;
  const keysAt = (offsets: number[]): string[] => {
    const out: string[] = [];
    for (const o of offsets) {
      if (d.length < o + 32) break;
      const b = d.subarray(o, o + 32);
      if (!b.every((x) => x === 0)) out.push(base58Encode(b));
    }
    return out;
  };
  const recipients = keysAt(Array.from({ length: 8 }, (_, i) => 57 + i * 32));
  const reserved = keysAt([385, ...Array.from({ length: 7 }, (_, i) => 418 + i * 32)]);
  // A PDA is off the curve; a slot that reads on-curve or zero is not a
  // vault. None readable → the constant stands in with `fromChain` false.
  const vaults: string[] = [];
  for (let i = 0; i < GLOBAL_BUYBACK_VAULTS; i++) {
    const o = GLOBAL_BUYBACK_VAULTS_OFFSET + i * 32;
    if (d.length < o + 32) break;
    const b = d.subarray(o, o + 32);
    if (!b.every((x) => x === 0) && !isOnCurve(b)) vaults.push(base58Encode(b));
  }
  return {
    lpFeeBps: d.readBigUInt64LE(40),
    protocolFeeBps: d.readBigUInt64LE(48),
    disableFlags: d[56],
    protocolFeeRecipients: recipients.length ? recipients : fallback.protocolFeeRecipients,
    reservedFeeRecipients: reserved.length ? reserved : fallback.reservedFeeRecipients,
    coinCreatorFeeBps: d.readBigUInt64LE(313),
    buybackVaults: vaults.length ? vaults : fallback.buybackVaults,
    fromChain: vaults.length > 0 && recipients.length > 0,
  };
}

// ── Quote math ────────────────────────────────────────────────────────

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Quote the pool takes for `baseOut` base units, BEFORE fees (exact). */
export function quoteNeededForBase(baseOut: bigint, poolBase: bigint, poolQuote: bigint): bigint | null {
  if (baseOut <= 0n || baseOut >= poolBase || poolQuote <= 0n) return null;
  return ceilDiv(poolBase * poolQuote, poolBase - baseOut) - poolQuote;
}

/** Quote the pool pays for `baseIn` base units, BEFORE fees (exact). */
export function quoteOutForBase(baseIn: bigint, poolBase: bigint, poolQuote: bigint): bigint | null {
  if (baseIn <= 0n || poolBase <= 0n || poolQuote <= 0n) return null;
  const out = poolQuote - ceilDiv(poolBase * poolQuote, poolBase + baseIn);
  return out > 0n ? out : null;
}

/**
 * Base units a buy of `budgetLamports` can ask for: the pool's answer to the
 * budget net of the fee ceiling, then the slippage margin. The instruction
 * carries this as `base_amount_out` and the whole budget as
 * `max_quote_amount_in`; the program charges what the reserves say at
 * execution, plus its tier's fee, and refuses past the max.
 */
export function baseOutForBudget(budgetLamports: bigint, poolBase: bigint, poolQuote: bigint, slippagePct: number): bigint {
  if (budgetLamports <= 0n || poolBase <= 0n || poolQuote <= 0n) return 0n;
  const quoteNet = (budgetLamports * BPS) / (BPS + PUMP_SWAP_FEE_CEILING_BPS) - FEE_ROUNDING_LAMPORTS;
  if (quoteNet <= 0n) return 0n;
  const baseOut = poolBase - ceilDiv(poolBase * poolQuote, poolQuote + quoteNet);
  if (baseOut <= 0n) return 0n;
  const margin = BigInt(Math.round((1 - slippagePct / 100) * 10_000));
  return (baseOut * margin) / BPS;
}

/** Lamports a sell of `baseIn` should net after the fee ceiling — the
 *  `min_quote_amount_out` before the slippage margin, and what the fee is
 *  billed on. */
export function netQuoteForSell(baseIn: bigint, poolBase: bigint, poolQuote: bigint): bigint {
  const gross = quoteOutForBase(baseIn, poolBase, poolQuote);
  if (gross === null) return 0n;
  const net = (gross * (BPS - PUMP_SWAP_FEE_CEILING_BPS)) / BPS - FEE_ROUNDING_LAMPORTS;
  return net > 0n ? net : 0n;
}

// ── Accounts ──────────────────────────────────────────────────────────

export interface PumpSwapFill {
  pool: PumpSwapPool;
  owner: string;
  /** The base mint's owner: Token-2022 for fresh pump mints, classic for old. */
  baseTokenProgram: string;
  protocolFeeRecipient: string;
  buybackVault: string;
}

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * The account list of a buy (25) or sell (23), in the program's order.
 * Exported so a test can pin every slot against a real trade offline.
 */
export function pumpSwapAccounts(action: 'buy' | 'sell', f: PumpSwapFill): AccountMeta[] {
  const w = (pubkey: string): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: string): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const { pool } = f;
  const vaultAuthority = pumpSwapCreatorVaultAuthorityFor(pool.coinCreator);
  const list: AccountMeta[] = [
    w(pool.pool),
    { pubkey: f.owner, isSigner: true, isWritable: true },
    r(pumpSwapGlobalConfigFor()),
    r(pool.baseMint),
    r(pool.quoteMint),
    w(ataFor(f.owner, pool.baseMint, f.baseTokenProgram)),
    w(ataFor(f.owner, pool.quoteMint, TOKEN_PROGRAM)),
    w(pool.poolBaseAta),
    w(pool.poolQuoteAta),
    r(f.protocolFeeRecipient),
    w(ataFor(f.protocolFeeRecipient, pool.quoteMint, TOKEN_PROGRAM)),
    r(f.baseTokenProgram),
    r(TOKEN_PROGRAM),
    r(SYSTEM_PROGRAM),
    r(ATA_PROGRAM),
    r(pumpSwapEventAuthorityFor()),
    r(PUMP_AMM_PROGRAM),
    w(ataFor(vaultAuthority, pool.quoteMint, TOKEN_PROGRAM)),
    r(vaultAuthority),
  ];
  if (action === 'buy') {
    list.push(r(pumpSwapGlobalVolumeAccumulatorFor()), w(pumpSwapUserVolumeAccumulatorFor(f.owner)));
  }
  list.push(r(pumpSwapFeeConfigFor()), r(PUMP_FEES_PROGRAM));
  // pool_v2: validated by address whether or not it exists (it did not, on
  // any coin sampled) — see addresses.pumpSwapPoolV2For.
  list.push(r(pumpSwapPoolV2For(pool.baseMint)));
  list.push(r(f.buybackVault), w(ataFor(f.buybackVault, pool.quoteMint, TOKEN_PROGRAM)));
  return list;
}

/** Instruction data: discriminator · base amount u64 · quote limit u64. */
export function encodePumpSwapData(action: 'buy' | 'sell', baseAmount: bigint, quoteLimit: bigint): Buffer {
  const u64 = (v: bigint): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v < 0n ? 0n : v);
    return b;
  };
  return Buffer.concat([action === 'buy' ? PUMP_SWAP_BUY_DISC : PUMP_SWAP_SELL_DISC, u64(baseAmount), u64(quoteLimit)]);
}

/** Which of a config list (fee recipients, buyback vaults) a pool's trades
 *  name: spread across pools by the pool address so write locks do not pile
 *  on one account, but fixed per pool so a retry names the same one. */
export function pickRotating(list: string[], pool: string): string | null {
  if (!list.length) return null;
  const first = pool.charCodeAt(0) + pool.charCodeAt(1);
  return list[first % list.length];
}
export const pickProtocolFeeRecipient = pickRotating;

// ── The build ─────────────────────────────────────────────────────────

export interface PumpSwapBuildParams {
  action: 'buy' | 'sell';
  mint: string;
  owner: string;
  /** Buy: lamports to spend. Sell: ignored. */
  solLamports: bigint;
  /** Sell: share of the token balance, 0.01–100 (default 100). */
  sellPct?: number;
  slippagePct: number;
  priorityFeeSol: number;
  computeUnitLimit: number;
  httpUrl: string;
}

/** Mint → token program, immutable, so read once per process. */
const mintOwnerCache = new Map<string, string>();
const MINT_OWNER_CAP = 2_048;
let globalCache: { value: PumpSwapGlobal; at: number } | null = null;
const GLOBAL_TTL_MS = 60_000;

function rememberMintOwner(mint: string, owner: string): void {
  if (mintOwnerCache.size >= MINT_OWNER_CAP) {
    const oldest = mintOwnerCache.keys().next().value;
    if (oldest !== undefined) mintOwnerCache.delete(oldest);
  }
  mintOwnerCache.set(mint, owner);
}

function globalFresh(): boolean {
  return globalCache !== null && Date.now() - globalCache.at < GLOBAL_TTL_MS;
}

/** The pool a graduated pump coin trades in, and whether it is one. */
export function canonicalPoolFor(mint: string): string {
  return pumpSwapCanonicalPoolFor(mint);
}

export async function buildPumpSwapTrade(p: PumpSwapBuildParams): Promise<LocalBuildResult> {
  const pool = canonicalPoolFor(p.mint);
  const knownOwner = mintOwnerCache.get(p.mint);
  const globalConfig = pumpSwapGlobalConfigFor();
  const wantGlobal = !globalFresh();
  const poolQuoteAta = ataFor(pool, WSOL_MINT, TOKEN_PROGRAM);

  // ONE round trip for what the build reads, when the mint's token program
  // is already known (every trade after the first of a mint): the pool, the
  // config when its cache is cold, both vaults for the reserves, and on a
  // sell our own balance. The first build of a mint learns the program from
  // the mint account and reads the base-side accounts in a second, smaller
  // batch — the vault addresses depend on it.
  // The bonding curve rides along: it outlives graduation, and its
  // `is_mayhem_mode` byte decides which fee-recipient list the swap must
  // name (a mayhem coin on a normal recipient reverts 6013).
  const curveAddr = bondingCurveFor(p.mint);
  const addrs = [pool, poolQuoteAta, curveAddr];
  if (!knownOwner) addrs.push(p.mint);
  if (wantGlobal) addrs.push(globalConfig);
  const poolBaseAtaKnown = knownOwner ? ataFor(pool, p.mint, knownOwner) : null;
  const userBaseAtaKnown = knownOwner ? ataFor(p.owner, p.mint, knownOwner) : null;
  if (poolBaseAtaKnown) addrs.push(poolBaseAtaKnown);
  if (p.action === 'sell' && userBaseAtaKnown) addrs.push(userBaseAtaKnown);
  const multi = await getMultipleAccountInfo(p.httpUrl, addrs, 'processed');
  if (!multi.ok || !multi.data) return { ok: false, message: `account read: ${multi.message}` };
  const byAddr = new Map(addrs.map((a, i) => [a, multi.data?.[i] ?? null]));

  const poolInfo = byAddr.get(pool) ?? null;
  if (!poolInfo) return { ok: false, message: 'no PumpSwap pool for this mint — not a graduated pump coin' };
  if (poolInfo.owner !== PUMP_AMM_PROGRAM) return { ok: false, message: `the pool address is owned by ${poolInfo.owner.slice(0, 8)}…, not pump-amm` };
  const state = parsePool(pool, poolInfo.data);
  if (!state) return { ok: false, message: 'PumpSwap pool account is not the layout this builder knows' };
  if (state.baseMint !== p.mint) return { ok: false, message: 'PumpSwap pool names a different base mint' };
  if (state.quoteMint !== WSOL_MINT) return { ok: false, message: `PumpSwap pool is quoted in ${state.quoteMint.slice(0, 6)}…, not SOL — the local builder only builds SOL pools` };
  if (state.creator !== pumpPoolAuthorityFor(p.mint)) return { ok: false, message: 'PumpSwap pool was not created by pump’s migration — not the canonical pool' };

  let tokenProgram = knownOwner;
  if (!tokenProgram) {
    const mintAcc = byAddr.get(p.mint);
    if (!mintAcc) return { ok: false, message: 'mint account: not found' };
    tokenProgram = mintAcc.owner;
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) {
      return { ok: false, message: `mint owner ${tokenProgram.slice(0, 8)} is not a token program` };
    }
    rememberMintOwner(p.mint, tokenProgram);
  }
  if (wantGlobal) {
    const g = byAddr.get(globalConfig);
    globalCache = { value: parseGlobalConfig(g?.data ?? new Uint8Array(0)), at: Date.now() };
  }
  const global = (globalCache as { value: PumpSwapGlobal }).value;
  // Mayhem-mode coins (curve byte 81) must pay a RESERVED recipient, as on
  // the curve. A curve that cannot be read is treated as not mayhem: a wrong
  // guess costs a simulation revert and a fall to Jupiter, never a trade.
  const curveInfo = byAddr.get(curveAddr) ?? null;
  const curve = curveInfo ? parseCurve(curveInfo.data) : null;
  const mayhem = curve?.mayhem === true;
  const recipient = pickRotating(mayhem ? global.reservedFeeRecipients : global.protocolFeeRecipients, pool);
  const buybackVault = pickRotating(global.buybackVaults, pool);
  if (!recipient || !buybackVault) return { ok: false, message: 'PumpSwap global config lists no protocol fee recipient or buyback vault' };

  // Base-side accounts: derived from the token program, which may only now
  // be known. The pool's own vault address is checked against the derivation
  // — a mismatch means a pool this builder should not be sizing from.
  const poolBaseAta = ataFor(pool, p.mint, tokenProgram);
  if (state.poolBaseAta !== poolBaseAta) return { ok: false, message: 'PumpSwap pool base vault is not the pool’s ATA — unexpected pool' };
  if (state.poolQuoteAta !== poolQuoteAta) return { ok: false, message: 'PumpSwap pool quote vault is not the pool’s ATA — unexpected pool' };
  const userBaseAta = ataFor(p.owner, p.mint, tokenProgram);
  const userWsolAta = ataFor(p.owner, WSOL_MINT, TOKEN_PROGRAM);
  let poolBaseInfo = byAddr.get(poolBaseAta) ?? null;
  let userBaseInfo = byAddr.get(userBaseAta) ?? null;
  if (!poolBaseAtaKnown || (p.action === 'sell' && !userBaseAtaKnown)) {
    const more = [poolBaseAta, ...(p.action === 'sell' ? [userBaseAta] : [])];
    const second = await getMultipleAccountInfo(p.httpUrl, more, 'processed');
    if (!second.ok || !second.data) return { ok: false, message: `account read: ${second.message}` };
    poolBaseInfo = second.data[0] ?? null;
    if (p.action === 'sell') userBaseInfo = second.data[1] ?? null;
  }
  const poolQuoteInfo = byAddr.get(poolQuoteAta) ?? null;
  const poolBase = poolBaseInfo ? tokenAccountAmount(poolBaseInfo.data, poolBaseInfo.owner) : 0n;
  // The quote side the program prices on: the vault plus the pool's virtual
  // reserve (see PumpSwapPool.virtualQuote). Sizing on the vault alone
  // asked for 1.4–1.8× the tokens the pool would give, which the program
  // refused as slippage (measured 2026-09-19).
  const poolQuote = (poolQuoteInfo ? tokenAccountAmount(poolQuoteInfo.data, poolQuoteInfo.owner) : 0n) + state.virtualQuote;
  if (poolBase <= 0n || poolQuote <= 0n) return { ok: false, message: 'PumpSwap pool has empty reserves' };

  let baseAmount: bigint;
  let quoteLimit: bigint;
  let solValueLamports = 0;
  if (p.action === 'buy') {
    if (p.solLamports <= 0n) return { ok: false, message: 'buy amount is zero' };
    baseAmount = baseOutForBudget(p.solLamports, poolBase, poolQuote, p.slippagePct);
    if (baseAmount <= 0n) return { ok: false, message: 'buy quote is zero tokens' };
    quoteLimit = p.solLamports;
    solValueLamports = Number(p.solLamports);
  } else {
    let raw: bigint;
    if (userBaseInfo !== null || userBaseAtaKnown) {
      raw = userBaseInfo ? tokenAccountAmount(userBaseInfo.data, userBaseInfo.owner) : 0n;
    } else {
      const bal = await getTokenBalanceRaw(p.httpUrl, userBaseAta);
      if (!bal.ok || bal.data === undefined) return { ok: false, message: `token balance: ${bal.message}` };
      raw = bal.data;
    }
    if (raw <= 0n) return { ok: false, message: 'nothing to sell (zero token balance)' };
    baseAmount = sellAmountFor(raw, p.sellPct);
    if (baseAmount <= 0n) return { ok: false, message: `nothing to sell (${sellPctOf(p.sellPct)}% of ${raw} is zero)` };
    const net = netQuoteForSell(baseAmount, poolBase, poolQuote);
    if (net <= 0n) return { ok: false, message: 'sell quote is zero SOL' };
    quoteLimit = (net * BigInt(Math.round((1 - p.slippagePct / 100) * 10_000))) / BPS;
    solValueLamports = Number(net);
  }

  const metas = pumpSwapAccounts(p.action, {
    pool: state,
    owner: p.owner,
    baseTokenProgram: tokenProgram,
    protocolFeeRecipient: recipient,
    buybackVault,
  });
  let keys;
  try {
    keys = metas.map((m) => ({ pubkey: new PublicKey(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable }));
  } catch (err) {
    return { ok: false, message: `account derivation failed: ${(err as Error).message}` };
  }
  const tradeIx = new TransactionInstruction({
    programId: new PublicKey(PUMP_AMM_PROGRAM),
    keys,
    data: encodePumpSwapData(p.action, baseAmount, quoteLimit),
  });

  const owner = new PublicKey(p.owner);
  const createIdempotent = (ata: string, mint: string, program: string): TransactionInstruction =>
    new TransactionInstruction({
      programId: new PublicKey(ATA_PROGRAM),
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(program), isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
  const closeAccount = (ata: string, program: string): TransactionInstruction =>
    new TransactionInstruction({
      programId: new PublicKey(program),
      keys: [
        { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]), // CloseAccount
    });

  // A wrapped buy is two ATA creates, a transfer, a sync, the swap and a
  // close: more than the curve trade the execution setting is sized for
  // (120k). The floor keeps the priority fee the user chose in SOL terms —
  // the price per unit falls as the limit rises.
  const units = Math.max(p.computeUnitLimit, PUMP_SWAP_MIN_COMPUTE_UNITS);
  const microLamports = Math.max(1, Math.floor((p.priorityFeeSol * 1e9 * 1e6) / Math.max(units, 1)));
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
  if (p.action === 'buy') {
    instructions.push(createIdempotent(userBaseAta, p.mint, tokenProgram));
    instructions.push(createIdempotent(userWsolAta, WSOL_MINT, TOKEN_PROGRAM));
    // Wrap the budget: SOL into our own WSOL account, then SyncNative so the
    // token program sees the balance. The swap pulls from this account.
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(userWsolAta), lamports: p.solLamports }));
    instructions.push(
      new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM),
        keys: [{ pubkey: new PublicKey(userWsolAta), isSigner: false, isWritable: true }],
        data: Buffer.from([17]), // SyncNative
      }),
    );
    instructions.push(tradeIx);
    // Unwrap what the swap did not take — the change comes back as SOL.
    instructions.push(closeAccount(userWsolAta, TOKEN_PROGRAM));
  } else {
    instructions.push(createIdempotent(userWsolAta, WSOL_MINT, TOKEN_PROGRAM));
    instructions.push(tradeIx);
    instructions.push(closeAccount(userWsolAta, TOKEN_PROGRAM));
    if (sellPctOf(p.sellPct) >= 100) {
      // A full sell empties the token account — reclaim its rent in the
      // same transaction, as the curve builder does. A partial keeps it.
      instructions.push(closeAccount(userBaseAta, tokenProgram));
    }
  }

  const bh = await recentBlockhash(p.httpUrl);
  if (!bh) return { ok: false, message: 'blockhash: could not fetch' };
  try {
    const message = MessageV0.compile({ payerKey: owner, instructions, recentBlockhash: bh.value });
    return {
      ok: true,
      message: `PumpSwap ${p.action} built locally (${metas.length}-account layout${global.fromChain ? '' : ', config fallback'})`,
      tx: new VersionedTransaction(message).serialize(),
      solValueLamports,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    };
  } catch (err) {
    return { ok: false, message: `tx compile failed: ${(err as Error).message}` };
  }
}

/** Test seam. */
export function _resetPumpSwapCaches(): void {
  mintOwnerCache.clear();
  globalCache = null;
}
