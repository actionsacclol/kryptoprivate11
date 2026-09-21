// The authoritative half of the terminal's data.
//
// Everything in `providers/` is somebody else's opinion. This file is the
// chain. When the two disagree — and they do, constantly, on freshly created
// mints — the on-chain answer wins and the provider's answer is dropped.
//
// The security panel specifically REFUSES to call mint/freeze authority
// "pass" on a provider's audit flag. Jupiter's `audit.freezeAuthorityDisabled`
// is a cached index entry; a freeze authority added in the last block is the
// exact case that matters, and it is the case a cache gets wrong. So the
// authority verdicts here are the ones the score uses, and the provider flag
// is only ever a fallback marked `unknown` in the UI.

import {
  getAccountInfo,
  getTokenAccountOwners,
  getTokenLargestAccounts,
  getTokenSupply,
  type LargestAccount,
} from '../chain/rpcClient';
// The same two ids also sit in engine/pumpDecoder as TOKEN_PROGRAM_ID and
// TOKEN_2022_PROGRAM_ID - byte-identical, two names. These are the canonical
// copies: chain constants belong with the chain primitives, and the data
// layer has no business reaching into a decoder for them.
import { TOKEN_2022_PROGRAM as TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM as TOKEN_PROGRAM_ID } from '../chain/addresses';
import { memo, putCache } from './http';
import { holderPct, type HolderReport, type HolderRow } from '@shared/market';

export interface MintFacts {
  /** False when the RPC could not be read — NOT the same as "all clear". */
  checked: boolean;
  exists: boolean;
  isToken2022: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number | null;
  /** Raw supply in base units. */
  supplyRaw: string | null;
  uiSupply: number | null;
  message: string;
}

const UNCHECKED = (message: string): MintFacts => ({
  checked: false,
  exists: false,
  isToken2022: false,
  mintAuthority: null,
  freezeAuthority: null,
  decimals: null,
  supplyRaw: null,
  uiSupply: null,
  message,
});

/**
 * Read the mint account directly.
 *
 * SPL mint layout (identical for the base fields under Token-2022):
 *   0  u32  mintAuthorityOption
 *   4  [32] mintAuthority
 *   36 u64  supply
 *   44 u8   decimals
 *   45 u8   isInitialized
 *   46 u32  freezeAuthorityOption
 *   50 [32] freezeAuthority
 */
/**
 * Cached briefly. `summary()` reads the mint, and so does `securityReport()`,
 * and so does `holders()` — opening one token page fired the same
 * `getAccountInfo` three or four times, each up to the RPC's 8s timeout. On a
 * rate-limited public endpoint that alone took a token page from ~5s to 18s.
 *
 * The TTL is deliberately short. Mint and freeze authority are exactly the
 * facts where a change in the last block is the one that matters, so this
 * trades a few seconds of staleness for not hammering the endpoint — it must
 * never grow into a long-lived cache.
 */
export const MINT_FACTS_TTL_MS = 15_000;
const mintKey = (mint: string): string => `onchain:mint:${mint}`;

export async function mintFacts(httpUrl: string, mint: string): Promise<MintFacts> {
  const hit = await memo<MintFacts>(mintKey(mint), MINT_FACTS_TTL_MS, () => mintFactsUncached(httpUrl, mint));
  return hit ?? UNCHECKED('mint read failed');
}

/**
 * A reader that already holds the mint account's bytes hands them over, so
 * `mintFacts()` is a cache hit instead of a second request for the same
 * account. The pump reader (pumpChain.ts) fetches the mint in the batch with
 * the curve; before this, `summary()` re-read it alone a moment later.
 */
export function seedMintFacts(mint: string, owner: string, data: Buffer): MintFacts {
  const facts = mintFactsFromAccount(owner, data);
  putCache(mintKey(mint), facts, MINT_FACTS_TTL_MS);
  return facts;
}

async function mintFactsUncached(httpUrl: string, mint: string): Promise<MintFacts | null> {
  const res = await getAccountInfo(httpUrl, mint);
  if (!res.ok) return UNCHECKED(`mint not read (${res.message})`);
  // NOT `checked: true`. "The RPC returned no account" is the definition of
  // unknown, not a reading. UNCHECKED carries mintAuthority/freezeAuthority as
  // null, and downstream a null authority on a CHECKED mint is read as
  // "positively observed absent" — which in SPL is the SAFE state. So this one
  // word turned "we could not find this mint" into "Mint authority: Disabled.
  // No new supply can be minted." on the two heaviest security gates, sourced
  // `onchain`. Reachable from a lagging node on a seconds-old mint, which is
  // exactly when this app is used. Every consumer already renders null
  // correctly (`shared/market.ts` gates on `!m.checked`).
  if (!res.data) return UNCHECKED('mint account not found');
  return mintFactsFromAccount(res.data.owner, res.data.data);
}

/** The facts in a mint account's bytes. `checked: true` throughout: the
 *  account was READ, whatever it turned out to contain. */
export function mintFactsFromAccount(owner: string, data: Buffer): MintFacts {
  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID;
  if (!isToken2022 && owner !== TOKEN_PROGRAM_ID) {
    return { ...UNCHECKED(`unknown token program ${owner.slice(0, 8)}`), checked: true, exists: true };
  }
  if (data.length < 82) {
    return { ...UNCHECKED('malformed mint layout'), checked: true, exists: true, isToken2022 };
  }

  const mintAuthOpt = data.readUInt32LE(0);
  const freezeAuthOpt = data.readUInt32LE(46);
  const decimals = data.readUInt8(44);
  const supply = data.readBigUInt64LE(36);

  // Encoding the 32-byte authority pubkeys back to base58 needs the encoder;
  // the terminal only ever asks "is there one", so the presence flag is
  // enough and we avoid pulling base58 into this path.
  return {
    checked: true,
    exists: true,
    isToken2022,
    mintAuthority: mintAuthOpt === 0 ? null : 'present',
    freezeAuthority: freezeAuthOpt === 0 ? null : 'present',
    decimals,
    supplyRaw: supply.toString(),
    uiSupply: Number(supply) / 10 ** decimals,
    message: 'ok',
  };
}

/** Known program-owned / burn destinations that are not real holders. */
const NON_HOLDERS = new Set<string>([
  '11111111111111111111111111111111', // system program
  '1nc1nerator11111111111111111111111111111111', // pump's burn address
]);

/**
 * Top holders straight from the chain.
 *
 * `getTokenLargestAccounts` caps at 20 accounts — that is an RPC limit, not
 * a choice, and it is stated on the report so the UI can say "top 20 of N"
 * rather than implying a complete list. It IS enough for the top-10
 * concentration number, which is the figure that actually gates a trade.
 */
export async function topHolders(
  httpUrl: string,
  mint: string,
  opts: { resolveOwners?: boolean; excludeAccounts?: Set<string> } = {},
): Promise<HolderReport> {
  const empty: HolderReport = {
    mint,
    totalSupply: null,
    holderCount: null,
    rows: [],
    source: 'onchain',
    note: null,
  };

  const [supplyRes, largestRes] = await Promise.all([
    getTokenSupply(httpUrl, mint),
    getTokenLargestAccounts(httpUrl, mint),
  ]);

  if (!largestRes.ok || !largestRes.data?.length) {
    // The free public RPC does not rate-limit getTokenLargestAccounts, it
    // CLOSES it: measured 2026-09-09, the endpoint answers the very first
    // call with `x-ratelimit-method-limit: 0` and `retry-after: 10`. So this
    // is not an unlucky burst, it is the guaranteed outcome on a default
    // install. Say what to do about it rather than showing an empty panel
    // that looks like the token has no holders. (rpcClient now refuses this
    // method locally without spending a request, and parks host#method rather
    // than the whole host, so the refusal no longer blinds every other read.)
    const rateLimited = /429|too many/i.test(largestRes.message);
    return {
      ...empty,
      source: 'none',
      note: !largestRes.ok
        ? rateLimited
          ? 'The public Solana RPC rate-limits holder lookups. Add a free Helius key in Settings → Solana RPC, or a Birdeye key in Settings → Market data, to read holders.'
          : `Could not read holders: ${largestRes.message}`
        : 'This mint has no token accounts holding a balance.',
    };
  }

  const totalSupply = supplyRes.ok && supplyRes.data ? supplyRes.data.uiAmount : null;
  const accounts: LargestAccount[] = largestRes.data.filter(
    (a) => a.uiAmount > 0 && !opts.excludeAccounts?.has(a.address),
  );

  let owners = new Map<string, string>();
  if (opts.resolveOwners !== false && accounts.length) {
    const r = await getTokenAccountOwners(
      httpUrl,
      accounts.map((a) => a.address),
    );
    if (r.ok && r.data) owners = r.data;
  }

  const rows: HolderRow[] = accounts
    .map((a) => {
      const owner = owners.get(a.address) ?? null;
      return {
        address: a.address,
        owner,
        amount: a.uiAmount,
        // Honest null: without a supply there is no share, and 0 would read
        // as "holds nothing".
        pct: holderPct(a.uiAmount, totalSupply),
        tags: [],
        label: null,
      } satisfies HolderRow;
    })
    .filter((r) => !r.owner || !NON_HOLDERS.has(r.owner));

  return {
    mint,
    totalSupply,
    holderCount: null, // an RPC cannot count holders; an indexer must
    rows,
    source: 'onchain',
    note: `Top ${rows.length} accounts (getTokenLargestAccounts caps at 20)`,
  };
}

/** Sum of the top N rows, as a percentage of supply. Null when unknowable. */
export function concentration(rows: HolderRow[], n: number): number | null {
  const known = rows.filter((r): r is HolderRow & { pct: number } => r.pct !== null && Number.isFinite(r.pct));
  if (!known.length) return null;
  const sorted = [...known].sort((a, b) => b.pct - a.pct).slice(0, n);
  const total = sorted.reduce((acc, r) => acc + r.pct, 0);
  return Number.isFinite(total) && total > 0 ? Math.min(100, total) : null;
}
