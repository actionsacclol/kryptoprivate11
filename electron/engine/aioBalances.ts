// The All-in-One wallet's balance: everything its two addresses hold, on
// every chain, in dollars.
//
// Each chain is read on its own deadline and its own failure: a chain that
// does not answer is reported as unread (the total says it is partial),
// never as empty. Prices follow the honest-null rule — an asset with no
// price is listed and counted as "unpriced", never as $0 (shared/aio.ts).
//
// Reads, never writes. Nothing here signs or moves anything.

import type { Address } from 'viem';
import { getBalance, getTokenAccountsByOwner } from '../chain/rpcClient';
import * as jup from '../data/providers/jupiter';
import { client as evmClient } from '../evm/client';
import { holdingsOf } from '../evm/erc20';
import * as tokenDiscovery from '../evm/tokenDiscovery';
import { nativeUsd } from '../evm/prices';
import * as evmRail from '../evm/rail';
import * as evmLedger from '../evm/ledger';
import { OTHER_CHAINS, readOtherChain } from '../evm/otherChains';
import { KNOWN_MINTS, WSOL_MINT } from '@shared/swap';
import { EVM_CHAIN_META, NATIVE_ADDRESS, type EvmChainKind } from '@shared/evm';
import {
  AIO_BALANCE_CHAINS,
  summariseAioBalances,
  type AioAsset,
  type AioBalanceChain,
  type AioBalances,
  type AioOtherChain,
} from '@shared/aio';

/** Per chain. A public endpoint that has not answered in this long is not
 *  going to, and the page should not wait on the slowest chain. */
const CHAIN_DEADLINE_MS = 9_000;
/** A page polling every few seconds re-reads at most this often. */
const FRESH_MS = 20_000;
/** Jupiter's price route takes 50 ids; one is SOL. */
const MAX_PRICED_MINTS = 49;

type Read = { chain: AioBalanceChain; ok: boolean; partial?: boolean; message?: string | null; assets: AioAsset[] };

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

const stableOf = (chain: keyof typeof KNOWN_MINTS, token: string) =>
  KNOWN_MINTS[chain].find((k) => k.mint.toLowerCase() === token.toLowerCase() && /^USD/.test(k.symbol)) ?? null;

async function readSolana(httpUrl: string, owner: string): Promise<Read> {
  const [bal, accounts, solUsd] = await Promise.all([getBalance(httpUrl, owner), getTokenAccountsByOwner(httpUrl, owner), jup.solUsd()]);
  if (!bal.ok) return { chain: 'solana', ok: false, message: bal.message, assets: [] };
  const sol = (bal.data ?? 0) / 1e9;
  const assets: AioAsset[] = [
    { chain: 'solana', symbol: 'SOL', name: 'Solana', token: null, amount: sol, usd: solUsd !== null ? sol * solUsd : null, priceSource: solUsd !== null ? 'native' : null, kind: 'native' },
  ];
  // Token accounts are a separate read; a failure there leaves the SOL line
  // standing and says the tokens are missing.
  if (!accounts.ok) return { chain: 'solana', ok: true, partial: true, message: `tokens not read — ${accounts.message}`, assets };
  const held = (accounts.data ?? []).filter((a) => a.uiAmount > 0 && a.mint !== WSOL_MINT);
  const stableMints = held.filter((a) => stableOf('solana', a.mint));
  const others = held.filter((a) => !stableOf('solana', a.mint));
  const [prices, meta] = await Promise.all([
    jup.prices(others.slice(0, MAX_PRICED_MINTS).map((a) => a.mint)).catch(() => new Map<string, number>()),
    jup.byMints(others.slice(0, MAX_PRICED_MINTS).map((a) => a.mint)).catch(() => new Map()),
  ]);
  for (const a of stableMints) {
    const k = stableOf('solana', a.mint)!;
    assets.push({ chain: 'solana', symbol: k.symbol, name: k.name, token: a.mint, amount: a.uiAmount, usd: a.uiAmount, priceSource: 'stable', kind: 'stable' });
  }
  for (const a of others) {
    const px = prices.get(a.mint);
    const m = meta.get(a.mint) as { symbol?: string; name?: string } | undefined;
    assets.push({
      chain: 'solana',
      symbol: m?.symbol ?? `${a.mint.slice(0, 4)}…`,
      name: m?.name ?? null,
      token: a.mint,
      amount: a.uiAmount,
      usd: typeof px === 'number' && px > 0 ? a.uiAmount * px : null,
      priceSource: typeof px === 'number' && px > 0 ? 'market' : null,
      kind: 'token',
    });
  }
  return { chain: 'solana', ok: true, assets };
}

async function readEvm(chain: EvmChainKind, owner: Address): Promise<Read> {
  const sym = EVM_CHAIN_META[chain].nativeSymbol;
  // Stablecoins by name, every token the app has traded on this chain, and
  // every token the chain says was SENT to this wallet plus the majors
  // (tokenDiscovery, 2026-10-03 — a transfer in used to be invisible here).
  tokenDiscovery.kick(chain, owner);
  const stables = KNOWN_MINTS[chain].filter((k) => k.mint !== NATIVE_ADDRESS).map((k) => k.mint as Address);
  // This ADDRESS's tokens (not the active signer's whole history), capped
  // as the wallet pages cap them (v6 audit 2026-10-03).
  const traded = [...new Set(evmLedger.knownTokens(chain, owner).slice(-60).map((t) => t.toLowerCase()))] as Address[];
  const tokens = [...new Set([...stables.map((s) => s.toLowerCase()), ...traded, ...tokenDiscovery.candidates(chain, owner)])] as Address[];
  const [wei, held, px] = await Promise.all([evmClient(chain).getBalance({ address: owner }), holdingsOf(chain, owner, tokens), nativeUsd(chain)]);
  const native = Number(wei) / 1e18;
  const assets: AioAsset[] = [
    { chain, symbol: sym, name: EVM_CHAIN_META[chain].name, token: null, amount: native, usd: px !== null ? native * px : null, priceSource: px !== null ? 'native' : null, kind: 'native' },
  ];
  // Priced: at most 30 a read; the rest are listed unpriced, never as $0.
  const nonStable = [...held.keys()].filter((t) => !stableOf(chain, t)).slice(0, 30);
  const summaries = nonStable.length ? await evmRail.summaries(chain, nonStable).catch(() => ({} as Record<string, { priceUsd?: number | null; symbol?: string; name?: string }>)) : {};
  for (const [token, h] of held) {
    const amount = Number(h.raw) / 10 ** h.decimals;
    const k = stableOf(chain, token);
    if (k) {
      assets.push({ chain, symbol: k.symbol, name: k.name, token, amount, usd: amount, priceSource: 'stable', kind: 'stable' });
      continue;
    }
    const s = (summaries as Record<string, { priceUsd?: number | null }>)[token] ?? (summaries as Record<string, { priceUsd?: number | null }>)[token.toLowerCase()];
    const p = typeof s?.priceUsd === 'number' && s.priceUsd > 0 ? s.priceUsd : null;
    assets.push({ chain, symbol: h.symbol || `${token.slice(0, 6)}…`, name: h.name || null, token, amount, usd: p !== null ? amount * p : null, priceSource: p !== null ? 'market' : null, kind: 'token' });
  }
  return { chain, ok: true, assets };
}

async function readOther(chain: AioOtherChain, owner: Address): Promise<Read> {
  const cfg = OTHER_CHAINS[chain];
  // ETH everywhere here; Robinhood's gas coin is ETH too, so its price is
  // the ETH price.
  const [r, ethUsd] = await Promise.all([readOtherChain(chain, owner), nativeUsd('robinhood')]);
  const native = Number(r.native) / 1e18;
  const assets: AioAsset[] = [
    { chain, symbol: cfg.nativeSymbol, name: cfg.name, token: null, amount: native, usd: ethUsd !== null ? native * ethUsd : null, priceSource: ethUsd !== null ? 'native' : null, kind: 'native' },
  ];
  for (const s of cfg.stables) {
    const raw = r.stables.get(s.address.toLowerCase());
    if (raw === undefined || raw <= 0n) continue;
    const amount = Number(raw) / 10 ** s.decimals;
    assets.push({ chain, symbol: s.symbol, name: null, token: s.address, amount, usd: amount, priceSource: 'stable', kind: 'stable' });
  }
  return { chain, ok: true, assets };
}

let last: { key: string; at: number; value: AioBalances } | null = null;
let inflight: { key: string; p: Promise<AioBalances> } | null = null;

/**
 * Everything both addresses hold. `force` skips the 20 s reuse (the page's
 * Refresh button); concurrent callers share one read either way.
 */
export async function aioBalances(
  opts: { httpUrl: string; solanaAddress: string | null; evmAddress: string | null; force?: boolean },
): Promise<AioBalances> {
  const key = `${opts.solanaAddress ?? '-'}|${opts.evmAddress ?? '-'}`;
  if (!opts.force && last && last.key === key && Date.now() - last.at < FRESH_MS) return last.value;
  if (inflight && inflight.key === key) return inflight.p;
  const p = (async () => {
    const evm = opts.evmAddress as Address | null;
    const job = (chain: AioBalanceChain): Promise<Read> => {
      let run: Promise<Read>;
      if (chain === 'solana') {
        if (!opts.solanaAddress) return Promise.resolve({ chain, ok: false, message: 'no Solana key', assets: [] });
        run = readSolana(opts.httpUrl, opts.solanaAddress);
      } else if (!evm) {
        return Promise.resolve({ chain, ok: false, message: 'no EVM key', assets: [] });
      } else if (chain === 'bnb' || chain === 'robinhood') {
        if (!evmRail.enabled(chain)) return Promise.resolve({ chain, ok: false, message: `${EVM_CHAIN_META[chain].shortName} is switched off in Settings`, assets: [] });
        run = readEvm(chain, evm);
      } else {
        run = readOther(chain, evm);
      }
      return within(run, CHAIN_DEADLINE_MS).catch((err: unknown) => ({ chain, ok: false, message: (err as Error)?.message ?? 'read failed', assets: [] }));
    };
    const reads = await Promise.all(AIO_BALANCE_CHAINS.map(job));
    const value = summariseAioBalances(reads, Date.now());
    last = { key, at: value.at, value };
    return value;
  })().finally(() => {
    inflight = null;
  });
  inflight = { key, p };
  return p;
}
