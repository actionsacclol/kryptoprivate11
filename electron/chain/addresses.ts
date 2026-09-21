// PDA / address prewarm — research action #2. At launch detection we
// derive every account the buy path will need, so the hot path never
// blocks on a derivation.
//
// Implemented with pure @noble primitives (sha256 + ed25519 point check)
// instead of @solana/web3.js: web3.js pulls in rpc-websockets → uuid, an
// ESM-only chain that breaks require() in the CommonJS Electron main
// process (ERR_REQUIRE_ESM). We only need PDA math, and it's ~30 lines.
//
// Seeds are from pump-public-docs (verified in the July 2026 research swarm):
//   bonding_curve            ["bonding-curve", base_mint]
//   creator_vault            ["creator-vault", creator]
//   sharing_config           ["sharing-config", base_mint]   (fees program)
//   user_volume_accumulator  ["user_volume_accumulator", user]
//
// This derives addresses only. It never signs, never submits. The full v2
// account list is intentionally NOT hardcoded — the report flags it as
// volatile config that must be validated against a live IDL before arming.

import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { base58Encode, base58Decode } from './base58';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const enc = new TextEncoder();

/** True if the 32 bytes decode to a valid ed25519 curve point. A PDA must
 *  be OFF the curve (no private key can exist for it). Exported for the tx
 *  builder, which uses it to spot wallet pubkeys inside account data. */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Derived addresses, by their own inputs.
 *
 * A PDA is a pure function of (seeds, program), so this is a memo and never
 * a guess. It is here because the derivation is genuinely expensive:
 * MEASURED 2026-09-15, `prewarm` (three PDAs) costs **922 µs**, against 19 µs
 * to decode a whole log notification. Each `findProgramAddress` walks bumps
 * from 255 down, sha256-ing and then decompressing an ed25519 point per
 * attempt until one is off-curve.
 *
 * The inputs repeat far more than they look like they do: the same creator
 * launches again and again (creator history is a whole feature), and the
 * volume accumulator and fee PDAs for OUR OWN wallet are re-derived on every
 * single trade build.
 *
 * Bounded, because the mint-keyed entries never repeat and would otherwise
 * grow with the tape.
 */
const pdaCache = new Map<string, string>();
const PDA_CACHE_MAX = 4_096;

/** Solana findProgramAddressSync: walk bump 255→0 until the hash is off-curve. */
function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): string {
  // The seeds and the program ARE the identity of the result. Latin-1 keeps
  // each byte one character, so the key is exact and costs no base58 pass.
  // Length-prefixed, so two different seed splits can never collide into
  // one key. Latin-1 keeps each byte one character and costs no base58.
  let k = '';
  for (const s of seeds) k += `${s.length}:${Buffer.from(s).toString('latin1')}`;
  k += `|${Buffer.from(programId).toString('latin1')}`;
  const hit = pdaCache.get(k);
  if (hit !== undefined) {
    // Re-insert on a hit, so eviction below is LEAST RECENTLY USED rather
    // than first-in. It matters: the mint-keyed entries never repeat and
    // churn the cache — at 20 launches a second the whole 4,096 cycles in
    // about a minute — so under plain FIFO the entries that are hit on
    // EVERY trade build (our own wallet's volume accumulator and fee PDAs)
    // would be thrown out roughly once a minute and re-derived at ~300 us
    // each. A Map preserves insertion order, so delete-then-set is the move.
    pdaCache.delete(k);
    pdaCache.set(k, hit);
    return hit;
  }

  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concatBytes([...seeds, new Uint8Array([bump]), programId, PDA_MARKER]));
    if (!isOnCurve(hash)) {
      const out = base58Encode(hash);
      if (pdaCache.size >= PDA_CACHE_MAX) {
        const oldest = pdaCache.keys().next().value;
        if (oldest !== undefined) pdaCache.delete(oldest);
      }
      pdaCache.set(k, out);
      return out;
    }
  }
  throw new Error('unable to find a program-derived address (exhausted bumps)');
}

/** Test seam: the memo is an optimisation and must never change an answer. */
export function _clearPdaCache(): void {
  pdaCache.clear();
}

const key = (b58: string): Uint8Array => base58Decode(b58);

export interface PrewarmedAddresses {
  bondingCurve: string;
  creatorVault: string;
  sharingConfig: string;
  /** ATA that would hold the bought tokens for a given owner. */
  associatedTokenAccount: (owner: string) => string;
  /** Volume accumulator PDA for a given user. */
  userVolumeAccumulator: (user: string) => string;
  derivedAt: number;
}

/** Associated token account address for (owner, mint). `tokenProgram`
 *  defaults to the classic SPL Token program; pass TOKEN_2022_PROGRAM for
 *  Token-2022 mints (which new Pump create_v2 coins use). */
export function ataFor(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return findProgramAddress([key(owner), key(tokenProgram), key(mint)], key(ATA_PROGRAM));
}

// Individual PDA helpers — used by prewarm and by the local tx builder's
// template classifier (which matches observed accounts against these).
/**
 * The v2 bonding-curve PDA — `["bonding-curve-v2", mint]`.
 *
 * Pump added this as a required account and it broke every builder that did
 * not know about it, ours included: the account is not derivable by any of
 * the older rules, so the template classifier fell through to "rotating fee
 * account" and copied ANOTHER MINT's value, producing
 * `InvalidBondingCurveV2 (6074): bonding_curve_v2 remaining account is
 * missing or invalid`.
 *
 * Verified 2026-08-24 against live trades: present at slot 16 of the
 * 18-account buy in 13 of 17 sampled buys (the rest are pre-v2 mints), and
 * absent from the legacy 27-account layout entirely. The account is often
 * UNINITIALISED on chain (owner missing, 0 bytes) — the program creates it,
 * so do not gate on its existence.
 */
export function bondingCurveV2For(mint: string): string {
  return findProgramAddress([enc.encode('bonding-curve-v2'), key(mint)], key(PUMP_PROGRAM));
}

/** Raydium LaunchLab pool — `["pool", baseMint, quoteMint]`. Verified against
 *  a live pool 2026-08-24, so opening a LaunchLab token needs no lookup. */
export function launchLabPoolFor(mint: string, quoteMint: string, programId: string): string {
  return findProgramAddress([enc.encode('pool'), key(mint), key(quoteMint)], key(programId));
}

/** Boop curve account — `["bonding_curve", mint]`. Verified against live
 *  pools 2026-08-24, so a Boop mint never needs a pool lookup. */
export function boopPoolFor(mint: string, programId: string): string {
  return findProgramAddress([enc.encode('bonding_curve'), key(mint)], key(programId));
}

export function bondingCurveFor(mint: string): string {
  return findProgramAddress([enc.encode('bonding-curve'), key(mint)], key(PUMP_PROGRAM));
}
/** Metaplex Token Metadata program — the `Metadata` account every pump coin
 *  created through the classic SPL token program carries. */
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** The mint's Metaplex metadata PDA — `["metadata", program, mint]` under the
 *  metadata program. Derived, never looked up: with it, a coin's name and
 *  symbol are one account in the same batch as its curve (data/pumpChain.ts).
 *  A Token-2022 mint may have none — its metadata lives in the mint itself. */
export function metadataFor(mint: string): string {
  return findProgramAddress([enc.encode('metadata'), key(METADATA_PROGRAM), key(mint)], key(METADATA_PROGRAM));
}
export function creatorVaultFor(creator: string): string {
  return findProgramAddress([enc.encode('creator-vault'), key(creator)], key(PUMP_PROGRAM));
}
export function sharingConfigFor(mint: string): string {
  return findProgramAddress([enc.encode('sharing-config'), key(mint)], key(PUMP_FEES_PROGRAM));
}
export function userVolumeAccumulatorFor(user: string): string {
  return findProgramAddress([enc.encode('user_volume_accumulator'), key(user)], key(PUMP_PROGRAM));
}

// ── Singleton PDAs of the current (2026-08-29) buy/sell layout ────────
//
// Every one of these was verified against an inner pump `Buy` decoded from a
// PumpPortal-built transaction that simulated clean, and against the same
// addresses in successful on-chain trades. They have no per-trade seed, so
// they are memoised: derive once, reuse forever.
const memo = new Map<string, string>();
function once(name: string, derive: () => string): string {
  let v = memo.get(name);
  if (!v) {
    v = derive();
    memo.set(name, v);
  }
  return v;
}

/** `["global"]` — 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf. */
export function globalFor(): string {
  return once('global', () => findProgramAddress([enc.encode('global')], key(PUMP_PROGRAM)));
}
/** `["__event_authority"]` — Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1. */
export function eventAuthorityFor(): string {
  return once('eventAuthority', () => findProgramAddress([enc.encode('__event_authority')], key(PUMP_PROGRAM)));
}
/** `["global_volume_accumulator"]` — Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y. */
export function globalVolumeAccumulatorFor(): string {
  return once('gva', () => findProgramAddress([enc.encode('global_volume_accumulator')], key(PUMP_PROGRAM)));
}
/** Fee program's `["fee_config", PUMP_PROGRAM]` — 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt. */
export function feeConfigFor(): string {
  return once('feeConfig', () => findProgramAddress([enc.encode('fee_config'), key(PUMP_PROGRAM)], key(PUMP_FEES_PROGRAM)));
}

/**
 * Fallbacks for the two accounts the layout takes from the Global account's
 * DATA rather than from a seed (see txBuilder.parseGlobal). Used only when
 * the Global account cannot be read; both were the live values on 2026-08-29.
 *
 *  - fee recipient: `Global.fee_recipient` (the program also accepts any of
 *    `Global.fee_recipients`).
 *  - fee vault: a fee-program-owned account referenced from Global's tail,
 *    passed as the last account of both buy and sell. It is neither a user
 *    nor a mint PDA — the template learner saw it vary across samples and
 *    mis-filed it as a "rotating fee recipient", which is what a build then
 *    copied from someone else's trade.
 */
export const PUMP_FEE_RECIPIENT_FALLBACK = '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV';
export const PUMP_FEE_VAULT_FALLBACK = 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW';
/** Global.reserved_fee_recipient (offset 483) — the fee recipient a MAYHEM-mode
 *  coin demands; a normal recipient reverts `NotAuthorized (6000)` on both buy
 *  and sell (measured 2026-09-07). #0 of pump's published reserved list. */
export const PUMP_RESERVED_FEE_RECIPIENT_FALLBACK = 'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS';

// ── PumpSwap (pump-amm) ───────────────────────────────────────────────
//
// Where a pump coin trades once its curve is complete. Every address below
// was verified against direct top-level pump-amm trades and three recent
// migrations on 2026-09-19 (docs/pumpswap-builder-2026-09-19.md).

export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** The pump-fees program's `BuybackVault`, passed (with its WSOL ATA) by
 *  every pump-amm buy and sell. Read from GlobalConfig @835 at build time;
 *  this is the live value, used only when the config cannot be read. */
export const PUMP_SWAP_BUYBACK_VAULT_FALLBACK = '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD';

/** `["global_config"]` — ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw. */
export function pumpSwapGlobalConfigFor(): string {
  return once('pswap:global', () => findProgramAddress([enc.encode('global_config')], key(PUMP_AMM_PROGRAM)));
}
/** `["__event_authority"]` — GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR. */
export function pumpSwapEventAuthorityFor(): string {
  return once('pswap:eventAuthority', () => findProgramAddress([enc.encode('__event_authority')], key(PUMP_AMM_PROGRAM)));
}
/** `["global_volume_accumulator"]` — C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw. */
export function pumpSwapGlobalVolumeAccumulatorFor(): string {
  return once('pswap:gva', () => findProgramAddress([enc.encode('global_volume_accumulator')], key(PUMP_AMM_PROGRAM)));
}
/** `["user_volume_accumulator", user]` — writable on every buy. */
export function pumpSwapUserVolumeAccumulatorFor(user: string): string {
  return findProgramAddress([enc.encode('user_volume_accumulator'), key(user)], key(PUMP_AMM_PROGRAM));
}
/** `["creator_vault", coin_creator]` — the authority whose WSOL ATA takes
 *  the creator fee. `coin_creator` is the pool's own field, the system
 *  program when the coin has none. */
export function pumpSwapCreatorVaultAuthorityFor(coinCreator: string): string {
  return findProgramAddress([enc.encode('creator_vault'), key(coinCreator)], key(PUMP_AMM_PROGRAM));
}
/** Fee program's `["fee_config", PUMP_AMM_PROGRAM]` — 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx. */
export function pumpSwapFeeConfigFor(): string {
  return once('pswap:feeConfig', () => findProgramAddress([enc.encode('fee_config'), key(PUMP_AMM_PROGRAM)], key(PUMP_FEES_PROGRAM)));
}
/** Pump's `["pool-authority", mint]` — the creator of the pool pump's
 *  migration makes for a graduated coin. Verified on 3/3 recent migrations. */
export function pumpPoolAuthorityFor(mint: string): string {
  return findProgramAddress([enc.encode('pool-authority'), key(mint)], key(PUMP_PROGRAM));
}
/** pump-amm `["pool", index u16 LE, creator, base_mint, quote_mint]`. */
export function pumpSwapPoolFor(index: number, creator: string, baseMint: string, quoteMint: string): string {
  return findProgramAddress([enc.encode('pool'), new Uint8Array([index & 0xff, (index >> 8) & 0xff]), key(creator), key(baseMint), key(quoteMint)], key(PUMP_AMM_PROGRAM));
}
/** The pool a graduated pump coin trades in: index 0, created by pump's
 *  pool authority for the mint, quoted in WSOL. Derived, never fetched. */
export function pumpSwapCanonicalPoolFor(mint: string): string {
  return pumpSwapPoolFor(0, pumpPoolAuthorityFor(mint), mint, WSOL_MINT);
}
/** pump-amm `["pool-v2", base_mint]` — the account every buy and sell must
 *  pass just before the buyback vault, whether or not it exists yet (the
 *  program validates the ADDRESS: without it, `InvalidPoolV2 (6062) pool_v2
 *  remaining account is missing or invalid`). Not one sampled coin had it
 *  initialised. Found by seed search against three pools' trades. */
export function pumpSwapPoolV2For(mint: string): string {
  return findProgramAddress([enc.encode('pool-v2'), key(mint)], key(PUMP_AMM_PROGRAM));
}

/** Derive and cache the buy-path PDAs for a freshly detected launch. */
export function prewarm(mint: string, creator: string): PrewarmedAddresses {
  return {
    bondingCurve: bondingCurveFor(mint),
    creatorVault: creatorVaultFor(creator),
    sharingConfig: sharingConfigFor(mint),
    associatedTokenAccount: (owner: string) => ataFor(owner, mint),
    userVolumeAccumulator: userVolumeAccumulatorFor,
    derivedAt: Date.now(),
  };
}
