// A pump.fun coin, read from the chain instead of asked of pump.fun.
//
// WHY (2026-09-20). pump.fun's `/coins/{mint}` was the app's chronic rate
// limiter: a token page rebuilt its summary every five seconds and the
// summary bought that record every time; the orders poll did the same for
// every armed mint every twelve seconds; the portfolio for every holding.
// The host allows ~60 a minute for everything and answered most of those
// with 429, so the provider sat parked for minutes at a time — and while
// parked, a fresh curve coin had NO price at all, because nothing else
// indexes a coin that is forty seconds old.
//
// Everything that record was bought FOR is on chain, in accounts whose
// addresses are derived from the mint with no lookup:
//
//   bonding-curve PDA   → virtual reserves (the price), real SOL (the exit
//                         liquidity), complete, creator, mayhem/cashback
//   the mint            → token program, decimals, supply
//   Metaplex metadata   → name, symbol, uri (Token-2022 coins carry these
//                         in the mint itself; mintExtensions.ts reads them)
//   canonical PumpSwap  → for a graduated coin: the pool's quote vault plus
//   pool + its vaults     its VIRTUAL quote reserve over its base vault is
//                         the price every swap actually fills at
//                         (pumpSwapBuilder.ts, verified to the lamport)
//
// One `getMultipleAccounts` — three accounts per mint, thirty-three mints
// per call — answers for the whole batch, on an RPC budget the app is
// nowhere near, and a second call of the same shape prices the graduated
// ones. What is NOT here, and stays with the provider on a ten-minute
// identity memo: the creation time and pump's own flags (banned, nsfw, king
// of the hill, ATH). Those do not change by the second, so they are asked
// for once, and never on a batch path. The image and the socials are in the
// metadata JSON the `uri` above points at (engine/metadata.ts fetches it;
// the summary merges it last) — pump.fun's record only copies that file.
//
// Honest-null rule throughout: a curve that does not exist is "not a pump
// coin", cached as such briefly; an RPC that did not answer is UNKNOWN and
// is asked again next time.

import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  ataFor,
  bondingCurveFor,
  metadataFor,
} from '../chain/addresses';
import { getMultipleAccountInfo, type AccountInfo } from '../chain/rpcClient';
import { curveProgressTokenPct } from '../engine/curve';
import { parseMintExtensions } from '../engine/mintExtensions';
import { canonicalPoolFor, parsePool } from '../engine/pumpSwapBuilder';
import { parseCurve, type CurveState } from '../engine/txBuilder';
import { cached, putCache } from './http';
import { seedMintFacts } from './onchain';
import * as quoteRates from './quoteRates';
import { emptySummary, type TokenSummary } from '@shared/market';

/** Fresh enough for a header that re-reads every five seconds, and short
 *  enough that a stop-loss never evaluates a price from the previous poll. */
export const CHAIN_TTL_MS = 4_000;
/** "This mint has no bonding curve" is a fact about the mint, but a curve
 *  can appear seconds after a mint does, so it is not remembered for long. */
const NOT_PUMP_TTL_MS = 60_000;
/** Accounts per `getMultipleAccounts` is capped at 100 by the RPC; three per
 *  mint makes thirty-three the widest honest batch. */
export const MINTS_PER_CALL = 33;
/** SPL token account: mint 32 · owner 32 · amount u64 @64. */
const TOKEN_AMOUNT_OFFSET = 64;
/** Bonding curve: disc 8 · vTok @8 · vSol @16 · realTok @24 · realSol @32. */
const CURVE_REAL_SOL_OFFSET = 32;

const key = (mint: string): string => `pumpchain:${mint}`;
const noKey = (mint: string): string => `pumpchain:no:${mint}`;

export interface PumpChainCoin {
  mint: string;
  /** When the accounts were read, ms. */
  readAt: number;
  /** The program that owns the mint. */
  tokenProgram: string;
  isToken2022: boolean;
  decimals: number;
  supplyRaw: bigint;
  /** From Metaplex metadata or the Token-2022 metadata extension. Null when
   *  neither exists — a coin can be created with no metadata at all. */
  name: string | null;
  symbol: string | null;
  uri: string | null;
  curve: CurveState & {
    /** `real_sol_reserves` — SOL a seller can actually take out. */
    realSol: bigint;
  };
  /** The canonical PumpSwap pool of a graduated coin, with the reserves its
   *  swaps price on. Null on the curve, and null when the coin is complete
   *  but the pool could not be read (then `priceSol` is null too). */
  pool: {
    address: string;
    quoteLamports: bigint;
    virtualQuote: bigint;
    baseRaw: bigint;
  } | null;
  /** SOL per whole token. Null only when a graduated coin's pool was not
   *  readable — never a stale or guessed figure. */
  priceSol: number | null;
  /** Real SOL on the coin's side of the market: the curve's real reserve, or
   *  the pool's quote vault (its virtual reserve is not money). */
  liquiditySol: number | null;
  /**
   * The curve's quote token when it is NOT SOL (pump launches coins against
   * tokenized stocks since 2026-10). The account's reserve slots then hold
   * the quote token, so `priceSol` / `liquiditySol` above are computed
   * through `solPerUnit` (data/quoteRates.ts) and are null until Jupiter
   * has priced the quote token. Null = an ordinary SOL curve.
   */
  quote: { mint: string; symbol: string | null; solPerUnit: number | null } | null;
}

/** A mint the reader should try: pump's vanity suffix, the same gate the
 *  provider path always used. A pump coin without it falls to the providers
 *  exactly as before. */
export function looksLikePumpMint(mint: string): boolean {
  return typeof mint === 'string' && mint.endsWith('pump') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

/**
 * Metaplex `Metadata`: key u8 @0 · update_authority 32 @1 · mint 32 @33 ·
 * then three Borsh strings (u32 length + bytes): name, symbol, uri. The
 * strings are written at fixed widths (32/10/200) and padded with NULs,
 * which is why they are trimmed. Anything past the uri is not read.
 */
export function parseMetaplex(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  const d = Buffer.from(data);
  let p = 65;
  const str = (): string | null => {
    if (p + 4 > d.length) return null;
    const n = d.readUInt32LE(p);
    if (n > 4_096 || p + 4 + n > d.length) return null;
    const s = d.subarray(p + 4, p + 4 + n).toString('utf8');
    p += 4 + n;
    return s.replace(/\0+$/g, '').trim();
  };
  const name = str();
  const symbol = str();
  const uri = str();
  if (name === null || symbol === null || uri === null) return null;
  return { name, symbol, uri };
}

/** Price of a curve coin from its virtual reserves, SOL per whole token.
 *  `solPerUnit` is what one raw unit of the reserve is worth in SOL: a
 *  lamport (1e-9) on a SOL curve, the quote token's rate on a quote-paired
 *  one (data/quoteRates.ts). */
export function curvePriceSol(vSol: bigint, vTok: bigint, decimals: number, solPerUnit = 1e-9): number | null {
  if (vTok <= 0n || !(solPerUnit > 0)) return null;
  const p = (Number(vSol) * solPerUnit) / (Number(vTok) / 10 ** decimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Price on a pump-migrated PumpSwap pool: the quote vault PLUS the pool's
 * virtual quote reserve, over the base vault — the constant-product figure
 * twelve consecutive real swaps reproduced to the lamport (pumpSwapBuilder).
 */
export function poolPriceSol(quoteLamports: bigint, virtualQuote: bigint, baseRaw: bigint, decimals: number, solPerUnit = 1e-9): number | null {
  if (baseRaw <= 0n || !(solPerUnit > 0)) return null;
  const p = (Number(quoteLamports + virtualQuote) * solPerUnit) / (Number(baseRaw) / 10 ** decimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

function tokenAmount(acc: AccountInfo | null): bigint | null {
  if (!acc || acc.data.length < TOKEN_AMOUNT_OFFSET + 8) return null;
  return acc.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

/** What the reader already knows, no request. */
export function readIfCached(mint: string): PumpChainCoin | null {
  return cached<PumpChainCoin>(key(mint));
}

/** One mint. Prefer `readMany` wherever there is more than one. */
export async function read(httpUrl: string, mint: string): Promise<PumpChainCoin | null> {
  const hit = readIfCached(mint);
  if (hit) return hit;
  const m = await readMany(httpUrl, [mint]);
  return m.get(mint) ?? null;
}

/**
 * Read many coins in as few requests as the RPC allows. A mint in the result
 * maps to its coin, or to null when it is not a pump coin OR the read
 * failed — callers that need the difference ask `readIfCached` afterwards,
 * but for a summary both mean "nothing from the chain this time", and only
 * the former is remembered.
 */
export async function readMany(httpUrl: string, mints: string[]): Promise<Map<string, PumpChainCoin | null>> {
  const out = new Map<string, PumpChainCoin | null>();
  const todo: string[] = [];
  for (const mint of new Set(mints)) {
    if (!looksLikePumpMint(mint)) {
      out.set(mint, null);
      continue;
    }
    const hit = readIfCached(mint);
    if (hit) {
      out.set(mint, hit);
      continue;
    }
    if (cached<boolean>(noKey(mint))) {
      out.set(mint, null);
      continue;
    }
    todo.push(mint);
  }
  if (!todo.length) return out;

  // Pass one: curve, mint, metadata — three derived accounts per mint.
  const graduated: Array<{ mint: string; coin: PumpChainCoin }> = [];
  // Curves quoted in something other than SOL: priced after the loop, once
  // the quote token's rate is in hand (one memoised Jupiter read each).
  const quoted: Array<{ mint: string; coin: PumpChainCoin }> = [];
  for (let i = 0; i < todo.length; i += MINTS_PER_CALL) {
    const chunk = todo.slice(i, i + MINTS_PER_CALL);
    const addrs = chunk.flatMap((m) => [bondingCurveFor(m), m, metadataFor(m)]);
    const r = await getMultipleAccountInfo(httpUrl, addrs, 'processed');
    if (!r.ok || !r.data) {
      // Unknown, not "not a pump coin": nothing is remembered, and the next
      // caller asks again.
      for (const m of chunk) out.set(m, null);
      continue;
    }
    const readAt = Date.now();
    chunk.forEach((mint, k) => {
      const curveAcc = r.data![k * 3];
      const mintAcc = r.data![k * 3 + 1];
      const metaAcc = r.data![k * 3 + 2];
      const st = curveAcc ? parseCurve(curveAcc.data) : null;
      if (!st || !mintAcc || mintAcc.data.length < 82) {
        putCache(noKey(mint), true, NOT_PUMP_TTL_MS);
        out.set(mint, null);
        return;
      }
      // The mint's bytes are in hand: seed the facts `summary()` reads next,
      // so its own `getAccountInfo` for the same account never fires.
      const facts = seedMintFacts(mint, mintAcc.owner, mintAcc.data);
      const decimals = facts.decimals ?? 6;
      const supplyRaw = facts.supplyRaw !== null ? BigInt(facts.supplyRaw) : 0n;
      const meta = metaAcc ? parseMetaplex(metaAcc.data) : null;
      const ext = !meta && mintAcc.owner === TOKEN_2022_PROGRAM ? parseMintExtensions(mintAcc.data) : null;
      const realSol = curveAcc!.data.length >= CURVE_REAL_SOL_OFFSET + 8 ? curveAcc!.data.readBigUInt64LE(CURVE_REAL_SOL_OFFSET) : 0n;
      const coin: PumpChainCoin = {
        mint,
        readAt,
        tokenProgram: mintAcc.owner,
        isToken2022: mintAcc.owner === TOKEN_2022_PROGRAM,
        decimals,
        supplyRaw,
        name: meta?.name ?? ext?.name ?? null,
        symbol: meta?.symbol ?? ext?.symbol ?? null,
        // The URI reaches the metadata JSON — the file the socials are in.
        // Every create_v2 coin is Token-2022 with no Metaplex account, so
        // the extension is where it usually is (2026-09-20, user report:
        // a runner's X and website on pump.fun, neither in the app).
        uri: meta?.uri ?? ext?.uri ?? null,
        curve: { ...st, realSol },
        pool: null,
        priceSol: null,
        liquiditySol: null,
        quote: st.quoteMint !== null ? { mint: st.quoteMint, symbol: quoteRates.symbolOf(st.quoteMint), solPerUnit: null } : null,
      };
      if (st.complete) {
        graduated.push({ mint, coin });
        return;
      }
      if (coin.quote) {
        // The reserve slot holds the quote token, not lamports: dividing it
        // by 1e9 read a $15k coin as a $2 one (2026-10-26). Priced below.
        quoted.push({ mint, coin });
        return;
      }
      coin.priceSol = curvePriceSol(st.vSol, st.vTok, decimals);
      coin.liquiditySol = Number(realSol) / 1e9;
      putCache(key(mint), coin, CHAIN_TTL_MS);
      out.set(mint, coin);
    });
  }

  // Quote-paired curves: the quote reserve × SOL-per-raw-unit is a SOL
  // reserve the ordinary price rule accepts. No rate (Jupiter parked, or a
  // quote token it does not list) → the price stays null and the summary's
  // providers fill the USD figure; never a figure in the wrong unit.
  if (quoted.length) {
    await Promise.all(
      quoted.map(async ({ mint, coin }) => {
        const q = coin.quote!;
        const rate = await quoteRates.ensure(q.mint).catch(() => null);
        if (rate) {
          q.symbol = rate.symbol;
          q.solPerUnit = rate.solPerUnit;
          coin.priceSol = curvePriceSol(coin.curve.vSol, coin.curve.vTok, coin.decimals, rate.solPerUnit);
          coin.liquiditySol = Number(coin.curve.realSol) * rate.solPerUnit;
        }
        putCache(key(mint), coin, CHAIN_TTL_MS);
        out.set(mint, coin);
      }),
    );
  }

  // Pass two, graduated coins only: the canonical pool and its two vaults.
  // The vault addresses are the pool's associated token accounts, derived
  // here and confirmed against the pool's own record below.
  for (let i = 0; i < graduated.length; i += MINTS_PER_CALL) {
    const chunk = graduated.slice(i, i + MINTS_PER_CALL);
    const addrs = chunk.flatMap(({ mint, coin }) => {
      // The pool PDA includes the quote mint: a coin launched against a
      // tokenized stock graduates into a pool quoted in it (2026-10-26:
      // derived with WSOL, LUMINA's pool read as "none"). The quote vault
      // is guessed as a classic ATA; a Token-2022 quote mismatches and the
      // pool's own vault record is followed below.
      const quoteMint = coin.curve.quoteMint ?? WSOL_MINT;
      const pool = canonicalPoolFor(mint, quoteMint);
      return [pool, ataFor(pool, quoteMint, TOKEN_PROGRAM), ataFor(pool, mint, coin.tokenProgram)];
    });
    const r = await getMultipleAccountInfo(httpUrl, addrs, 'processed');
    for (let k = 0; k < chunk.length; k++) {
      const { mint, coin } = chunk[k];
      const poolAddr = addrs[k * 3];
      const poolAcc = r.ok && r.data ? r.data[k * 3] : null;
      const pool = poolAcc ? parsePool(poolAddr, poolAcc.data) : null;
      let quote = r.ok && r.data ? tokenAmount(r.data[k * 3 + 1]) : null;
      let base = r.ok && r.data ? tokenAmount(r.data[k * 3 + 2]) : null;
      // A pool whose vaults are not its ATAs (none seen, but the record
      // names them, so it is checked): read the ones it names.
      if (pool && (pool.poolQuoteAta !== addrs[k * 3 + 1] || pool.poolBaseAta !== addrs[k * 3 + 2])) {
        const v = await getMultipleAccountInfo(httpUrl, [pool.poolQuoteAta, pool.poolBaseAta], 'processed');
        quote = v.ok && v.data ? tokenAmount(v.data[0]) : null;
        base = v.ok && v.data ? tokenAmount(v.data[1]) : null;
      }
      if (pool && quote !== null && base !== null) {
        coin.pool = { address: poolAddr, quoteLamports: quote, virtualQuote: pool.virtualQuote, baseRaw: base };
        if (pool.quoteMint !== WSOL_MINT) {
          // The pool keeps the curve's pair: a coin launched against a
          // tokenized stock graduates into a pool quoted in it, and the
          // vault holds that token's raw units, not lamports. Converted at
          // the quote rate or left null — never divided by 1e9.
          const rate = await quoteRates.ensure(pool.quoteMint).catch(() => null);
          coin.quote = { mint: pool.quoteMint, symbol: rate?.symbol ?? quoteRates.symbolOf(pool.quoteMint), solPerUnit: rate?.solPerUnit ?? null };
          if (rate) {
            coin.priceSol = poolPriceSol(quote, pool.virtualQuote, base, coin.decimals, rate.solPerUnit);
            coin.liquiditySol = Number(quote) * rate.solPerUnit;
          }
        } else {
          coin.priceSol = poolPriceSol(quote, pool.virtualQuote, base, coin.decimals);
          coin.liquiditySol = Number(quote) / 1e9;
        }
      }
      // Cached even without a price: the identity half (name, symbol,
      // creator, complete) is still true, and a null price renders as an
      // em dash while the providers fill it — never as a stale curve price.
      putCache(key(mint), coin, CHAIN_TTL_MS);
      out.set(mint, coin);
    }
  }
  return out;
}

/**
 * The summary the chain can state on its own. Merged FIRST in
 * `market.buildSummary`, so these fields win over every provider's copy of
 * them; what the chain cannot know (image, socials, creation time, pump's
 * flags) stays null here and the providers fill it.
 */
export function toSummary(coin: PumpChainCoin, solUsd: number | null): TokenSummary {
  const s = emptySummary(coin.mint);
  s.name = coin.name ?? '';
  s.symbol = coin.symbol ?? '';
  s.decimals = coin.decimals;
  s.launchpad = 'pumpfun';
  s.creator = coin.curve.creator;
  const supply = coin.supplyRaw > 0n ? Number(coin.supplyRaw) / 10 ** coin.decimals : null;
  s.totalSupply = supply;
  s.circSupply = supply;
  s.priceSol = coin.priceSol;
  s.priceUsd = coin.priceSol !== null && solUsd !== null && solUsd > 0 ? coin.priceSol * solUsd : null;
  if (s.priceUsd !== null && supply !== null) {
    s.marketCapUsd = s.priceUsd * supply;
    s.fdvUsd = s.marketCapUsd;
  }
  // Token-side progress: the share of the sellable supply already sold,
  // valid on classic and mayhem curves alike (curve.ts explains why the
  // SOL-side figure reads 0 % on most mayhem coins). 100 once complete, as
  // pump's own record reported it.
  s.bondingCurvePct = coin.curve.complete ? 100 : curveProgressTokenPct(coin.curve.vTok);
  if (coin.curve.complete) {
    s.poolAddress = coin.pool?.address ?? canonicalPoolFor(coin.mint, coin.curve.quoteMint ?? WSOL_MINT);
    s.poolQuoteMint = WSOL_MINT;
    s.dexId = 'pumpswap';
  } else {
    s.poolAddress = bondingCurveFor(coin.mint);
    s.dexId = 'pumpfun-curve';
  }
  if (coin.quote) {
    // Said on the summary so the page can show it and nothing downstream
    // assumes SOL: the local builder refuses such a curve, pool watchers
    // check `poolQuoteMint`, and the header names the quote token.
    s.poolQuoteMint = coin.quote.mint;
    s.curveQuote = { mint: coin.quote.mint, symbol: coin.quote.symbol };
  }
  s.liquidityUsd = coin.liquiditySol !== null && solUsd !== null && solUsd > 0 ? coin.liquiditySol * solUsd : null;
  s.sources = {};
  if (s.priceSol !== null) s.sources.price = 'onchain';
  if (s.marketCapUsd !== null) s.sources.marketCap = 'derived';
  if (s.liquidityUsd !== null) s.sources.liquidity = 'onchain';
  s.fetchedAt = coin.readAt;
  return s;
}
