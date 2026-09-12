// RugCheck (api.rugcheck.xyz) — keyless, verified live 2026-08-30.
//
// Two routes only, both a few KB:
//   /v1/tokens/{mint}/report/summary    ~160 ms — risks[], score, holders
//   /v1/tokens/{mint}/insiders/networks ~175 ms — transfer clusters
// The full `/report` runs to 2 MB and is never requested; http.ts caps this
// provider at 256 KB so a stray call to it fails instead of being parsed.
//
// What it earns its place for (docs/insight-swarm-2026-08-30.md finding 5):
// it covers one-minute-old curves, it names "Creator history of rugged
// tokens" — a fact this install cannot compute — and its top holders are
// the keyless fallback for installs without a Helius key.
//
// Every function here returns null on a non-200. A silent RugCheck is not a
// clean RugCheck; the orchestrator renders that as an unknown.

import { getJson, memo } from '../http';
import type { HolderReport, HolderRow } from '@shared/market';

export interface RugRisk {
  name: string;
  level: string;
  description?: string;
}

export interface RugTopHolder {
  address: string;
  owner?: string;
  pct: number;
  insider?: boolean;
  uiAmount: number | null;
}

export interface RugSummary {
  risks: RugRisk[];
  score: number | null;
  totalHolders: number | null;
  topHolders: RugTopHolder[] | null;
  rugged: boolean | null;
  lpLockedPct: number | null;
}

export interface InsiderNetwork {
  size: number;
  /** Of supply, 0..100. Null when the route lists the cluster without a share. */
  sharePct: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// Only the fields consumed; RugCheck's summary carries far more.
interface WireSummary {
  risks?: Array<{ name?: string; level?: string; description?: string }>;
  score?: number;
  score_normalised?: number;
  totalHolders?: number;
  topHolders?: Array<{ address?: string; owner?: string; pct?: number; insider?: boolean; uiAmount?: number }>;
  rugged?: boolean;
  lpLockedPct?: number;
  markets?: Array<{ lp?: { lpLockedPct?: number } }>;
}

const TTL_SUMMARY = 60_000;
const TTL_NETWORKS = 300_000;

export async function summary(mint: string): Promise<RugSummary | null> {
  return memo<RugSummary>(`rc:summary:${mint}`, TTL_SUMMARY, async () => {
    const r = await getJson<WireSummary>('rugcheck', `/v1/tokens/${encodeURIComponent(mint)}/report/summary`);
    if (!r.ok || !r.data || typeof r.data !== 'object') return null;
    const d = r.data;
    const risks: RugRisk[] = (Array.isArray(d.risks) ? d.risks : [])
      .filter((x) => x && typeof x.name === 'string')
      .map((x) => ({
        name: x.name as string,
        level: typeof x.level === 'string' ? x.level : 'unknown',
        ...(typeof x.description === 'string' ? { description: x.description } : {}),
      }));
    const top: RugTopHolder[] | null = Array.isArray(d.topHolders)
      ? d.topHolders
          .filter((h) => h && typeof h.address === 'string' && num(h.pct) !== null)
          .map((h) => ({
            address: h.address as string,
            ...(typeof h.owner === 'string' ? { owner: h.owner } : {}),
            pct: h.pct as number,
            ...(typeof h.insider === 'boolean' ? { insider: h.insider } : {}),
            uiAmount: num(h.uiAmount),
          }))
      : null;
    return {
      risks,
      score: num(d.score_normalised) ?? num(d.score),
      totalHolders: num(d.totalHolders),
      topHolders: top,
      rugged: bool(d.rugged),
      lpLockedPct: num(d.lpLockedPct) ?? num(d.markets?.[0]?.lp?.lpLockedPct),
    };
  });
}

/** True when RugCheck names a creator history of rugged tokens. */
export function creatorRugsFlag(s: RugSummary): boolean {
  return s.risks.some((r) => /creator history of rugged/i.test(r.name));
}

interface WireNetwork {
  size?: number;
  activeAccounts?: number;
  accounts?: unknown[];
  members?: unknown[];
  sharePct?: number;
  share?: number;
  pct?: number;
  percent?: number;
  tokenAmountPct?: number;
}

/**
 * Transfer clusters among holders. An empty array on a 200 is a real
 * answer — "no clusters" — and is cached like any other.
 */
export async function insiderNetworks(mint: string): Promise<InsiderNetwork[] | null> {
  return memo<InsiderNetwork[]>(`rc:networks:${mint}`, TTL_NETWORKS, async () => {
    const r = await getJson<WireNetwork[] | { networks?: WireNetwork[] }>(
      'rugcheck',
      `/v1/tokens/${encodeURIComponent(mint)}/insiders/networks`,
    );
    if (!r.ok) return null;
    const body = r.data;
    // An empty ARRAY is a real answer — "no clusters". A body that is neither
    // an array nor `{networks: [...]}` is not an answer at all, and defaulting
    // it to `[]` scored a weight-10 PASS ("No transfer clusters detected among
    // holders", sourced rugcheck) out of a shape we did not recognise, then
    // cached it for five minutes. Unknown is an em dash, never a pass.
    const list: WireNetwork[] | null = Array.isArray(body) ? body : Array.isArray(body?.networks) ? body.networks : null;
    if (!list) return null;
    return list
      .filter((n) => n && typeof n === 'object')
      .map((n) => {
        const size =
          num(n.size) ??
          num(n.activeAccounts) ??
          (Array.isArray(n.accounts) ? n.accounts.length : Array.isArray(n.members) ? n.members.length : 0);
        const raw = num(n.sharePct) ?? num(n.tokenAmountPct) ?? num(n.percent) ?? num(n.pct) ?? num(n.share);
        // A share given as a 0..1 fraction is normalised to a percentage.
        const sharePct = raw === null ? null : raw > 0 && raw <= 1 ? raw * 100 : raw;
        return { size, sharePct };
      });
  });
}

/** Largest cluster's share of supply, or null when none carries one. */
export function largestNetworkSharePct(nets: InsiderNetwork[]): number | null {
  const shares = nets.map((n) => n.sharePct).filter((v): v is number => v !== null);
  return shares.length ? Math.max(...shares) : null;
}

/**
 * Holder list for installs without a Helius or Birdeye key — the public RPC
 * refuses getTokenLargestAccounts. Shaped like onchain.topHolders' report so
 * the panel needs no special case; `source: 'rugcheck'` says where it came
 * from. `totalSupply` lets amounts be reconstructed from shares; without it
 * a row whose amount RugCheck did not state is left out rather than zeroed.
 */
export async function holdersFallback(mint: string, totalSupply: number | null): Promise<HolderReport | null> {
  const s = await summary(mint);
  if (!s || !s.topHolders) return null;
  const rows: HolderRow[] = [];
  for (const h of s.topHolders) {
    const amount =
      h.uiAmount !== null ? h.uiAmount : totalSupply !== null && totalSupply > 0 ? (h.pct / 100) * totalSupply : null;
    if (amount === null) continue;
    rows.push({
      address: h.address,
      owner: h.owner ?? null,
      amount,
      pct: h.pct,
      tags: h.insider ? ['insider'] : [],
      label: null,
    });
  }
  if (!rows.length) return null;
  return {
    mint,
    totalSupply,
    holderCount: s.totalHolders,
    rows,
    source: 'rugcheck',
    note: `Top ${rows.length} holders from RugCheck — add a Helius key in Settings → Solana RPC for an on-chain read.`,
  };
}
