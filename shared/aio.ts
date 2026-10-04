// The All-in-One wallet — one recovery phrase, one identity on every chain.
//
// It is not a new kind of signer. Its phrase derives one Solana key and one
// EVM key (seedPhrase.ts, Phantom's and MetaMask's paths), and those keys
// live in the SAME stores every other wallet lives in: wallets.json signs
// Solana, evm-wallets.json signs BNB and Robinhood (one address on both, no
// home chain). So every signer rule, policy, fee and PnL path applies to it
// unchanged. What this module adds is the link — which two stored wallets
// belong together — and the phrase that can rebuild both.
//
// Pure: no electron, no file access. electron/system/aioWallet.ts does IO.

export type AioChain = 'solana' | 'bnb' | 'robinhood';
export const AIO_CHAINS: AioChain[] = ['solana', 'bnb', 'robinhood'];

/** What aio-wallet.json holds. The phrase only ever as ciphertext. */
export interface AioRecord {
  version: 1;
  label: string;
  solanaAddress: string;
  evmAddress: string;
  /** The ids in the two wallet stores. Null until the key was added — the
   *  record is written FIRST, so a crash between can never lose the phrase. */
  solanaWalletId: string | null;
  evmWalletId: string | null;
  /** OS-keystore ciphertext of the phrase (base64). Opaque here. */
  phraseEnc: string;
  createdAt: number;
  /** When the user confirmed the phrase is written down. Null = not yet,
   *  and the page keeps asking: a wallet with no backup is one disk away
   *  from gone. */
  backedUpAt: number | null;
  /** Keys that were ALREADY in their list when the phrase was set up (the
   *  user had imported that key before). Removing the All-in-One wallet
   *  leaves those where they were. Absent on records from before 2026-10-02
   *  — read as not adopted. */
  adopted?: { solana: boolean; evm: boolean };
  /**
   * Which derivation path each key was made from (AIO_SOLANA_PATHS /
   * AIO_EVM_PATHS ids). Absent = 'sol-0' / 'evm-0' — every record made
   * before 2026-10-03, and every new wallet. Set when an import found the
   * user's money on another path (Trust Wallet, a second MetaMask account…).
   */
  paths?: { solana: string; evm: string };
}

/** A derivation path the import scan tries, and what it is known as. */
export interface AioPath {
  id: string;
  label: string;
  /** Solana: SLIP-10 hardened indexes. EVM: a BIP-32 path string. */
  path: number[] | string;
}

export const AIO_SOLANA_PATHS: AioPath[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({ id: `sol-${i}`, label: `Account ${i + 1} — Phantom, Solflare, Backpack`, path: [44, 501, i, 0] })),
  { id: 'sol-trust', label: 'Trust Wallet / Solana CLI', path: [44, 501, 0] },
  { id: 'sol-ledger-1', label: 'Ledger account 2', path: [44, 501, 1] },
  { id: 'sol-ledger-2', label: 'Ledger account 3', path: [44, 501, 2] },
  { id: 'sol-root', label: 'Older wallets (Sollet)', path: [44, 501] },
];

export const AIO_EVM_PATHS: AioPath[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({ id: `evm-${i}`, label: `Account ${i + 1} — MetaMask, Rabby, Trust`, path: `m/44'/60'/0'/0/${i}` })),
  { id: 'evm-ledger-1', label: 'Ledger Live account 2', path: "m/44'/60'/1'/0/0" },
  { id: 'evm-ledger-2', label: 'Ledger Live account 3', path: "m/44'/60'/2'/0/0" },
];

export const DEFAULT_AIO_PATHS = { solana: 'sol-0', evm: 'evm-0' } as const;

export function aioSolanaPath(id: string | undefined): number[] {
  const p = AIO_SOLANA_PATHS.find((x) => x.id === (id ?? DEFAULT_AIO_PATHS.solana));
  return (p ?? AIO_SOLANA_PATHS[0]!).path as number[];
}
export function aioEvmPath(id: string | undefined): string {
  const p = AIO_EVM_PATHS.find((x) => x.id === (id ?? DEFAULT_AIO_PATHS.evm));
  return (p ?? AIO_EVM_PATHS[0]!).path as string;
}
export function isAioPathChoice(v: unknown): v is { solana: string; evm: string } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return AIO_SOLANA_PATHS.some((p) => p.id === o.solana) && AIO_EVM_PATHS.some((p) => p.id === o.evm);
}

/** One candidate the scan found, with what it holds (null = unread). */
export interface AioScanRow {
  id: string;
  label: string;
  address: string;
  /** Native balances, in each chain's coin. */
  balances: Partial<Record<'solana' | 'bnb' | 'robinhood', number | null>>;
}

export interface AioWalletInfo {
  exists: boolean;
  label: string | null;
  solanaAddress: string | null;
  /** The same address receives on BNB, Robinhood and every other EVM chain. */
  evmAddress: string | null;
  solanaWalletId: string | null;
  evmWalletId: string | null;
  /** Which chains sign with it right now. */
  signingOn: Record<AioChain, boolean>;
  activeEverywhere: boolean;
  backedUp: boolean;
  createdAt: number | null;
  /** A key that is no longer in its store (removed there by hand). The
   *  phrase can put it back — `repair`. */
  missing: Array<'solana' | 'evm'>;
  /** Why the record cannot be read or written, or null. */
  failure: string | null;
}

export const AIO_DEFAULT_LABEL = 'All-in-One';
const MAX_LABEL = 32;

export function cleanAioLabel(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) : '';
  return s || AIO_DEFAULT_LABEL;
}

const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The record, or null for "no All-in-One wallet", or 'invalid' for a file
 * that exists but is not one we understand — which the caller must treat as
 * unreadable, never as absent: it holds the only copy of the phrase.
 */
export function parseAioFile(raw: unknown): AioRecord | null | 'invalid' {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return 'invalid';
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return 'invalid';
  if (o.wallet === null) return null;
  const w = o.wallet as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') return 'invalid';
  if (typeof w.solanaAddress !== 'string' || !SOLANA_ADDR.test(w.solanaAddress)) return 'invalid';
  if (typeof w.evmAddress !== 'string' || !EVM_ADDR.test(w.evmAddress)) return 'invalid';
  if (typeof w.phraseEnc !== 'string' || !w.phraseEnc) return 'invalid';
  return {
    version: 1,
    label: cleanAioLabel(w.label),
    solanaAddress: w.solanaAddress,
    evmAddress: w.evmAddress,
    solanaWalletId: idOrNull(w.solanaWalletId),
    evmWalletId: idOrNull(w.evmWalletId),
    phraseEnc: w.phraseEnc,
    createdAt: typeof w.createdAt === 'number' ? w.createdAt : 0,
    backedUpAt: typeof w.backedUpAt === 'number' ? w.backedUpAt : null,
    ...(isAioPathChoice(w.paths) ? { paths: { solana: (w.paths as { solana: string }).solana, evm: (w.paths as { evm: string }).evm } } : {}),
    ...(w.adopted && typeof w.adopted === 'object'
      ? { adopted: { solana: (w.adopted as Record<string, unknown>).solana === true, evm: (w.adopted as Record<string, unknown>).evm === true } }
      : {}),
  };
}

/** The file body for a record (or for none). */
export function aioFileBody(rec: AioRecord | null): { version: 1; wallet: AioRecord | null } {
  return { version: 1, wallet: rec };
}

export function emptyAioInfo(failure: string | null = null): AioWalletInfo {
  return {
    exists: false,
    label: null,
    solanaAddress: null,
    evmAddress: null,
    solanaWalletId: null,
    evmWalletId: null,
    signingOn: { solana: false, bnb: false, robinhood: false },
    activeEverywhere: false,
    backedUp: false,
    createdAt: null,
    missing: [],
    failure,
  };
}

/**
 * The info a page shows, from the record plus what the stores say right
 * now: which wallet signs on each chain, and which of the two keys are still
 * held. `held*` are the stores' current lists (addresses), `active*` their
 * current signers (ids).
 */
export function aioInfoOf(
  rec: AioRecord,
  now: {
    solanaIds: string[];
    evmIds: string[];
    activeSolanaId: string | null;
    activeEvmIds: { bnb: string | null; robinhood: string | null };
  },
): AioWalletInfo {
  const solHeld = rec.solanaWalletId !== null && now.solanaIds.includes(rec.solanaWalletId);
  const evmHeld = rec.evmWalletId !== null && now.evmIds.includes(rec.evmWalletId);
  const signingOn: Record<AioChain, boolean> = {
    solana: solHeld && now.activeSolanaId === rec.solanaWalletId,
    bnb: evmHeld && now.activeEvmIds.bnb === rec.evmWalletId,
    robinhood: evmHeld && now.activeEvmIds.robinhood === rec.evmWalletId,
  };
  const missing: Array<'solana' | 'evm'> = [];
  if (!solHeld) missing.push('solana');
  if (!evmHeld) missing.push('evm');
  return {
    exists: true,
    label: rec.label,
    solanaAddress: rec.solanaAddress,
    evmAddress: rec.evmAddress,
    solanaWalletId: solHeld ? rec.solanaWalletId : null,
    evmWalletId: evmHeld ? rec.evmWalletId : null,
    signingOn,
    activeEverywhere: AIO_CHAINS.every((c) => signingOn[c]),
    backedUp: rec.backedUpAt !== null,
    createdAt: rec.createdAt,
    missing,
    failure: null,
  };
}

// ── Balances (one total, every chain) ──────────────────────────────────

/** EVM chains the app does not trade on but the wallet's address receives
 *  on — read so funds sent there by mistake are never invisible. */
export type AioOtherChain = 'ethereum' | 'base' | 'arbitrum';
export type AioBalanceChain = AioChain | AioOtherChain;
export const AIO_BALANCE_CHAINS: AioBalanceChain[] = ['solana', 'bnb', 'robinhood', 'ethereum', 'base', 'arbitrum'];

export const AIO_CHAIN_LABEL: Record<AioBalanceChain, string> = {
  solana: 'Solana',
  bnb: 'BNB Chain',
  robinhood: 'Robinhood',
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
};

export interface AioAsset {
  chain: AioBalanceChain;
  symbol: string;
  name: string | null;
  /** Mint / token contract; null for the chain's native coin. */
  token: string | null;
  amount: number;
  /** Null = no price for it (honest null: never counted as $0). */
  usd: number | null;
  /** 'stable' = a dollar stablecoin valued at $1. */
  priceSource: 'market' | 'native' | 'stable' | null;
  kind: 'native' | 'stable' | 'token';
  /** Worth under AIO_DUST_USD: listed (behind "tiny balances"), not counted. */
  dust?: boolean;
}

export interface AioChainRead {
  chain: AioBalanceChain;
  /** False = this chain could not be read; its assets are missing, not zero. */
  ok: boolean;
  /** Read, but not completely (e.g. the coin balance answered and the token
   *  list did not): what was read counts, and the total says it is a floor. */
  partial?: boolean;
  message: string | null;
  /** Priced value on this chain; null when nothing on it is priced or it
   *  was not read. */
  usd: number | null;
}

export interface AioBalances {
  /** Sum of every PRICED asset. A floor when `unpriced` > 0 or `partial`.
   *  Null when no chain answered at all — never a $0 nobody measured. */
  totalUsd: number | null;
  /** Assets held that have no price — shown, not counted. */
  unpriced: number;
  /** At least one chain could not be read: the total is missing its share. */
  partial: boolean;
  chains: AioChainRead[];
  /** Largest first; unpriced after priced. */
  assets: AioAsset[];
  at: number;
}

/** Below this an asset is dust and left off the list (a 1-lamport airdrop
 *  is not a holding). Native coins always show, even at zero. */
export const AIO_DUST_USD = 0.01;

/**
 * Fold per-chain reads into one honest total. Pure, so the arithmetic that
 * decides what a user is told they own is pinned by a test.
 */
export function summariseAioBalances(
  reads: Array<{ chain: AioBalanceChain; ok: boolean; partial?: boolean; message?: string | null; assets: AioAsset[] }>,
  at: number,
): AioBalances {
  const chains: AioChainRead[] = [];
  const assets: AioAsset[] = [];
  let total = 0;
  let unpriced = 0;
  for (const r of reads) {
    let chainUsd: number | null = null;
    if (r.ok) {
      for (const a of r.assets) {
        if (!(a.amount > 0) && a.kind !== 'native') continue;
        if (a.usd !== null && Number.isFinite(a.usd)) {
          // Dust stays OUT of the total but IN the list, flagged: a token
          // that silently vanished read as "the app lost my coin" (10-03).
          if (a.kind !== 'native' && a.usd < AIO_DUST_USD) {
            assets.push({ ...a, dust: true });
            continue;
          }
          chainUsd = (chainUsd ?? 0) + a.usd;
        } else if (a.amount > 0) {
          unpriced += 1;
        }
        assets.push(a);
      }
      if (chainUsd !== null) total += chainUsd;
    }
    chains.push({
      chain: r.chain,
      ok: r.ok,
      ...(r.ok && r.partial ? { partial: true } : {}),
      message: r.ok ? (r.partial ? r.message ?? 'partly read' : null) : r.message ?? 'not read',
      usd: r.ok ? chainUsd : null,
    });
  }
  assets.sort((a, b) => {
    if (a.usd === null && b.usd === null) return 0;
    if (a.usd === null) return 1;
    if (b.usd === null) return -1;
    return b.usd - a.usd;
  });
  return {
    totalUsd: chains.some((c) => c.ok) ? Math.round(total * 100) / 100 : null,
    unpriced,
    partial: chains.some((c) => !c.ok || c.partial === true),
    chains,
    assets,
    at,
  };
}

// ── "ALL" views: every chain's positions and closed trades, in dollars ──

export interface AllChainPosition {
  chain: AioChain;
  token: string;
  symbol: string;
  name: string;
  amount: number;
  /** Null = no price (honest null), never $0. */
  valueUsd: number | null;
  /** Unrealised, at today's coin price. Null without a cost basis or a price. */
  pnlUsd: number | null;
  pnlPct: number | null;
  basisKnown: boolean;
}

export interface AllChainTrip {
  chain: AioChain;
  mint: string;
  symbol: string;
  closedAt: number;
  holdMs: number;
  /** In the chain's own coin — the ledger's truth. */
  pnlNative: number;
  nativeSymbol: string;
  /** The same PnL at TODAY's coin price — labelled as such where shown.
   *  Null when that price is unknown. */
  pnlUsdNow: number | null;
  pnlPct: number;
}

const usdOf = (native: number | null | undefined, px: number | null | undefined): number | null =>
  native === null || native === undefined || px === null || px === undefined || !Number.isFinite(native) || !Number.isFinite(px) ? null : native * px;

type SolPos = {
  mint: string; symbol: string; name: string; amount: number; valueUsd: number | null; valueSol: number | null;
  unrealizedPnlSol: number | null; unrealizedPnlPct: number | null; basisKnown: boolean; paper?: boolean;
};
type EvmPos = {
  token: string; symbol: string; name: string; amount: number; valueNative: number | null;
  unrealizedPnlNative: number | null; unrealizedPnlPct: number | null; basisKnown: boolean;
};

/** One list of what every chain's signing wallet holds, largest first.
 *  Paper positions are never in it — they are not money. */
export function mergeAllChainPositions(
  sol: { positions: SolPos[]; solUsd: number | null } | null,
  evm: Array<{ chain: 'bnb' | 'robinhood'; nativeUsd: number | null; positions: EvmPos[] }>,
): AllChainPosition[] {
  const out: AllChainPosition[] = [];
  for (const p of sol?.positions ?? []) {
    if (p.paper) continue;
    out.push({
      chain: 'solana',
      token: p.mint,
      symbol: p.symbol,
      name: p.name,
      amount: p.amount,
      valueUsd: p.valueUsd ?? usdOf(p.valueSol, sol?.solUsd),
      pnlUsd: usdOf(p.unrealizedPnlSol, sol?.solUsd),
      pnlPct: p.unrealizedPnlPct,
      basisKnown: p.basisKnown,
    });
  }
  for (const e of evm) {
    for (const p of e.positions) {
      out.push({
        chain: e.chain,
        token: p.token,
        symbol: p.symbol,
        name: p.name,
        amount: p.amount,
        valueUsd: usdOf(p.valueNative, e.nativeUsd),
        pnlUsd: usdOf(p.unrealizedPnlNative, e.nativeUsd),
        pnlPct: p.unrealizedPnlPct,
        basisKnown: p.basisKnown,
      });
    }
  }
  return out.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

type Trip = { mint: string; symbol: string; closedAt: number; holdMs: number; pnlSol: number; pnlPct: number };

/** Every chain's closed round trips, newest first. */
export function mergeAllChainTrips(
  chains: Array<{ chain: AioChain; nativeSymbol: string; nativeUsd: number | null; trips: Trip[] }>,
): AllChainTrip[] {
  const out: AllChainTrip[] = [];
  for (const c of chains) {
    for (const t of c.trips) {
      out.push({
        chain: c.chain,
        mint: t.mint,
        symbol: t.symbol,
        closedAt: t.closedAt,
        holdMs: t.holdMs,
        pnlNative: t.pnlSol,
        nativeSymbol: c.nativeSymbol,
        pnlUsdNow: usdOf(t.pnlSol, c.nativeUsd),
        pnlPct: t.pnlPct,
      });
    }
  }
  return out.sort((a, b) => b.closedAt - a.closedAt);
}
