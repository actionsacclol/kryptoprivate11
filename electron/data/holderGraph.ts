// Holder relationship graph (term.txt §7).
//
// A bubble chart of who holds what is decoration. What makes it worth the
// screen space is the EDGES: which holders were funded by the same wallet,
// which are one hop from the creator, which arrived together. That is what
// turns "twelve wallets hold 40%" into "twelve wallets hold 40% and eleven
// of them were funded by the same address an hour before launch".
//
// ─── Cost, and why this is on-demand ──────────────────────────────────
//
// Funding relationships are not in any free index. They come from reading
// each holder's earliest transactions and finding who sent them their first
// SOL — one `getSignaturesForAddress` plus a couple of `getTransaction`
// calls PER HOLDER. For 20 holders that is ~60 RPC calls.
//
// That is far too expensive to run on every token page load, so it never
// runs automatically: the holders panel shows the graph without edges, and
// the user presses "Analyse funding" when they want it. Bounded, explicit,
// and the cost is visible in the button rather than hidden in a poll.
//
// ─── Honesty ──────────────────────────────────────────────────────────
//
// An edge means "we observed A send SOL to B before B bought". It does NOT
// mean they are the same person, and the UI says so. A shared funder is
// frequently just a CEX hot wallet, which is why known exchange addresses
// are excluded from being funders at all — without that filter every token
// looks like one giant coordinated cluster.

import { getSignaturesForAddress, getTransaction, resolveAccountKeys } from '../engine/rpcClient';
import type { HolderRow } from '@shared/market';

/**
 * Addresses that fund thousands of unrelated wallets. An edge through one of
 * these carries no information — it says "both users withdrew from Binance".
 * Treating them as funders would make every token appear bundled.
 */
const KNOWN_HOT_WALLETS = new Set<string>([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Binance
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', // Binance 2
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Coinbase
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', // Coinbase 2
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', // Bybit
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Kraken
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', // OKX
  'A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR', // Bitget
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', // Kucoin
  '11111111111111111111111111111111',              // system program
]);

export interface GraphNode {
  /** Owner wallet (or token account when the owner is unknown). */
  id: string;
  label: string | null;
  /** Share of supply, 0..100; null when supply is unknown (honest-null). */
  pct: number | null;
  amount: number;
  tags: string[];
  /** Wallet age in ms at the time of analysis, or null if not analysed. */
  ageMs: number | null;
  /** Address that appears to have funded this wallet, or null. */
  fundedBy: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** 'funded' = `from` sent SOL to `to`. 'sibling' = shared funder. */
  kind: 'funded' | 'sibling';
}

export interface HolderGraph {
  mint: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Wallets grouped by shared funder, largest cluster first. */
  clusters: Array<{ funder: string; members: string[]; totalPct: number }>;
  /** True once funding analysis has run. */
  analysed: boolean;
  /** Holders we could not analyse, and why. */
  note: string | null;
  /** RPC calls the analysis actually spent, so the cost is never hidden. */
  rpcCalls: number;
}

/** Graph with nodes only — free, built from data the holders panel already has. */
export function fromHolders(mint: string, rows: HolderRow[]): HolderGraph {
  return {
    mint,
    nodes: rows.map((r) => ({
      id: r.owner ?? r.address,
      label: r.label,
      pct: r.pct,
      amount: r.amount,
      tags: r.tags,
      ageMs: null,
      fundedBy: null,
    })),
    edges: [],
    clusters: [],
    analysed: false,
    note: 'Funding links not analysed yet.',
    rpcCalls: 0,
  };
}

const LAMPORTS = 1_000_000_000;
/** Ignore dust: a rent-exempt sweep is not "funding". */
const MIN_FUNDING_LAMPORTS = 0.005 * LAMPORTS;
/** Hard ceiling so one click can never turn into hundreds of calls. */
const MAX_HOLDERS_ANALYSED = 25;

/**
 * Find who funded a wallet: walk its OLDEST transactions and take the first
 * meaningful SOL transfer in.
 *
 * `getSignaturesForAddress` returns newest-first with no ascending option, so
 * reaching the oldest means paging to the end. That is unaffordable for an
 * old wallet, and pointless — the wallets that matter here are fresh ones
 * created shortly before the launch. So the walk is capped, and a wallet with
 * more history than the cap is reported as `null` (unknown) rather than
 * guessed at from a recent transfer, which would be a different fact
 * entirely.
 */
async function findFunder(
  httpUrl: string,
  wallet: string,
  budget: { calls: number },
): Promise<{ funder: string | null; firstSeenAt: number | null }> {
  const sigs = await getSignaturesForAddress(httpUrl, wallet, 100);
  budget.calls += 1;
  if (!sigs.ok || !sigs.data?.length) return { funder: null, firstSeenAt: null };

  // A wallet at the page cap has deeper history than we are willing to walk.
  if (sigs.data.length >= 100) return { funder: null, firstSeenAt: null };

  const oldest = sigs.data[sigs.data.length - 1];
  const firstSeenAt = oldest.blockTime ? oldest.blockTime * 1000 : null;

  // Check the two oldest transactions — the funding transfer is almost
  // always the very first, but an ATA creation sometimes precedes it.
  for (const s of sigs.data.slice(-2).reverse()) {
    const res = await getTransaction(httpUrl, s.signature);
    budget.calls += 1;
    if (!res.ok || !res.data || res.data.meta?.err) continue;

    const tx = res.data;
    const keys = resolveAccountKeys(tx);
    const pre = tx.meta?.preBalances ?? [];
    const post = tx.meta?.postBalances ?? [];
    const idx = keys.indexOf(wallet);
    if (idx < 0 || !pre.length) continue;

    // Did this wallet GAIN lamports here?
    const gained = (post[idx] ?? 0) - (pre[idx] ?? 0);
    if (gained < MIN_FUNDING_LAMPORTS) continue;

    // The funder is whoever lost the most in the same transaction.
    let best: { addr: string; lost: number } | null = null;
    for (let i = 0; i < keys.length; i++) {
      if (i === idx) continue;
      const lost = (pre[i] ?? 0) - (post[i] ?? 0);
      if (lost <= 0) continue;
      if (KNOWN_HOT_WALLETS.has(keys[i])) continue;
      if (!best || lost > best.lost) best = { addr: keys[i], lost };
    }
    if (best) return { funder: best.addr, firstSeenAt };
  }
  return { funder: null, firstSeenAt };
}

/**
 * Run funding analysis over the graph's nodes. Expensive and explicit —
 * see the header. Returns a new graph; the input is not mutated.
 */
export async function analyseFunding(
  httpUrl: string,
  graph: HolderGraph,
  opts: { creator?: string | null } = {},
): Promise<HolderGraph> {
  const targets = graph.nodes
    .filter((n) => !n.tags.includes('lp'))
    .slice(0, MAX_HOLDERS_ANALYSED);

  const budget = { calls: 0 };
  const now = Date.now();
  const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const t of targets) {
    try {
      const { funder, firstSeenAt } = await findFunder(httpUrl, t.id, budget);
      const node = byId.get(t.id);
      if (!node) continue;
      node.fundedBy = funder;
      node.ageMs = firstSeenAt === null ? null : now - firstSeenAt;
      // "Fresh" is a wallet younger than a day — the signature of one made
      // for this launch rather than one that happened to buy it.
      if (node.ageMs !== null && node.ageMs < 86_400_000 && !node.tags.includes('fresh')) {
        node.tags = [...node.tags, 'fresh'];
      }
    } catch {
      /* one unreadable wallet must not abandon the whole analysis */
    }
  }

  // Edges: funder → holder, but only when the funder is itself on screen or
  // is the creator. An edge to an address the user cannot see explains
  // nothing; the cluster list below carries those instead.
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    if (!n.fundedBy) continue;
    if (byId.has(n.fundedBy) || n.fundedBy === opts.creator) {
      edges.push({ from: n.fundedBy, to: n.id, kind: 'funded' });
    }
  }

  // Clusters: holders sharing a funder. This is the number that matters —
  // it is the honest version of "bundled %".
  const byFunder = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.fundedBy) continue;
    const list = byFunder.get(n.fundedBy) ?? [];
    list.push(n.id);
    byFunder.set(n.fundedBy, list);
  }
  const clusters = [...byFunder.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([funder, members]) => ({
      funder,
      members,
      totalPct: members.reduce((acc, id) => acc + (byId.get(id)?.pct ?? 0), 0),
    }))
    .sort((a, b) => b.totalPct - a.totalPct);

  // Mark clustered wallets so the map can colour them.
  for (const c of clusters) {
    for (const id of c.members) {
      const node = byId.get(id);
      if (node && !node.tags.includes('bundle')) node.tags = [...node.tags, 'bundle'];
    }
  }

  const unresolved = targets.filter((t) => byId.get(t.id)?.fundedBy == null).length;
  const skipped = graph.nodes.length - targets.length;

  return {
    ...graph,
    nodes,
    edges,
    clusters,
    analysed: true,
    rpcCalls: budget.calls,
    note:
      `Analysed ${targets.length} holder${targets.length === 1 ? '' : 's'} in ${budget.calls} RPC calls.` +
      (unresolved ? ` ${unresolved} had too much history to trace.` : '') +
      (skipped > 0 ? ` ${skipped} not analysed (cap ${MAX_HOLDERS_ANALYSED}).` : '') +
      ' A shared funder means SOL moved between wallets — not that one person controls them.',
  };
}
