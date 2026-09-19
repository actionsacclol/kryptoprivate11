import { useMemo, useState } from 'react';
import { accent } from '../../state/theme';
import { Loader2, Network, TriangleAlert } from 'lucide-react';
import type { HolderGraph, GraphNode } from '@shared/market';
import { MAP_H, MAP_W, packCircles, type PlacedCircle } from './holderLayout';
import { cls, fmtPctOrDash, shortAddr } from '../../utils/format';

type Placed = PlacedCircle<GraphNode>;

// Holder bubble map (term.txt §7).
//
// Drawn as plain SVG with a deterministic layout — no force simulation and
// no charting library. That is a deliberate choice: a physics sim jitters on
// every re-render, never settles the same way twice, and makes it impossible
// to say "the big red bubble on the left" to someone else looking at the
// same token. Circle packing is stable, so the picture is the same every
// time you open it.
//
// Bubble AREA is proportional to holding percentage, not radius — a radius
// mapping makes a 4% holder look four times a 1% holder rather than twice.

const TAG_COLOR: Record<string, { fill: string; stroke: string; label: string }> = {
  dev: { fill: 'rgba(229,72,77,0.30)', stroke: '#E5484D', label: 'Creator' },
  bundle: { fill: 'rgba(217,70,239,0.28)', stroke: '#d946ef', label: 'Shared funder' },
  sniper: { fill: 'rgba(245,158,11,0.28)', stroke: '#f59e0b', label: 'Sniper' },
  insider: { fill: 'rgba(249,115,22,0.28)', stroke: '#f97316', label: 'Insider' },
  smart: { fill: 'rgba(52,211,153,0.28)', stroke: '#34d399', label: 'Smart money' },
  fresh: { fill: 'rgba(56,189,248,0.26)', stroke: '#38bdf8', label: 'Fresh wallet' },
  // Smart/fresh/lp are category colours and stay put; whale is the accent.
  whale: { fill: accent(0.3), stroke: accent(), label: 'Whale' },
  lp: { fill: 'rgba(240,237,226,0.10)', stroke: 'rgba(240,237,226,0.35)', label: 'Liquidity pool' },
};

/** Most-significant tag wins the colour. Order matters: a dev wallet that is
 *  also a whale should read as the creator, not as a whale. */
const TAG_PRIORITY = ['dev', 'bundle', 'insider', 'sniper', 'smart', 'fresh', 'whale', 'lp'];

function colorFor(tags: string[]): { fill: string; stroke: string; label: string } {
  for (const t of TAG_PRIORITY) {
    if (tags.includes(t)) return TAG_COLOR[t];
  }
  return { fill: 'rgba(240,237,226,0.08)', stroke: 'rgba(240,237,226,0.28)', label: 'Holder' };
}

export function HolderMap({
  graph,
  onAnalyse,
  analysing,
  creator,
  emptyNote,
}: {
  graph: HolderGraph;
  onAnalyse: () => void;
  analysing: boolean;
  creator: string | null;
  /** Why there are no holders, when there are none. */
  emptyNote?: string | null;
}) {
  const [hover, setHover] = useState<Placed | null>(null);
  // Layout needs a number; an unknown share packs as a dust bubble and is
  // LABELLED as unknown (honest-null) rather than drawn as 0 %.
  const placed = useMemo(() => packCircles(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);

  const legend = useMemo(() => {
    const present = new Set<string>();
    for (const n of graph.nodes) {
      for (const t of TAG_PRIORITY) {
        if (n.tags.includes(t)) {
          present.add(t);
          break;
        }
      }
    }
    return TAG_PRIORITY.filter((t) => present.has(t));
  }, [graph.nodes]);

  const biggestCluster = graph.clusters[0] ?? null;

  // No holders means nothing to draw AND nothing to analyse. Rendering an
  // empty box with an "Analyse funding" button invites a click that reads
  // nothing and spins forever — and it hides the actual reason, which is
  // almost always that the free public RPC refuses holder lookups (429 from
  // api.mainnet-beta, 403 from publicnode, both checked 2026-08-24).
  if (graph.nodes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center">
        <p className="text-note text-krypt-muted leading-relaxed max-w-md mx-auto">
          {emptyNote ??
            'No holder data for this token. The free public Solana RPC refuses holder lookups — add a free Helius key in Settings → Solana RPC, or a Birdeye key in Settings → Market data.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-body text-krypt-muted">
          {graph.nodes.length} holder{graph.nodes.length === 1 ? '' : 's'}, bubble area = share of supply
        </span>
        <div className="flex-1" />
        {!graph.analysed && (
          <button
            onClick={onAnalyse}
            disabled={analysing}
            className={cls(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-label font-semibold transition',
              analysing
                ? 'border-white/10 bg-white/5 text-krypt-muted cursor-wait'
                : 'border-krypt-purple/45 bg-krypt-purple/15 text-white hover:bg-krypt-purple/25',
            )}
          >
            {analysing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Network className="h-3 w-3" />}
            {analysing ? 'Reading the chain…' : 'Analyse funding'}
          </button>
        )}
      </div>

      {!graph.analysed && (
        <p className="text-label text-krypt-muted/65 leading-relaxed">
          Funding links are not free — tracing them reads each holder&rsquo;s earliest transactions, a couple of RPC
          calls per wallet. It runs only when you ask, and the result reports exactly how many calls it spent.
        </p>
      )}

      <div className="relative rounded-lg border border-white/10 bg-black/30 overflow-hidden">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full" style={{ maxHeight: 440 }}>
          {/* Funding edges, drawn under the bubbles. */}
          {graph.edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={`${e.from}-${e.to}-${i}`}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="rgba(217,70,239,0.45)"
                strokeWidth={1.2}
                strokeDasharray="3 3"
              />
            );
          })}

          {placed.map((p) => {
            const c = colorFor(p.node.tags);
            const isHover = hover?.node.id === p.node.id;
            return (
              <g
                key={p.node.id}
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={p.x} cy={p.y} r={p.r}
                  fill={c.fill}
                  stroke={isHover ? '#F0EDE2' : c.stroke}
                  strokeWidth={isHover ? 2 : 1.2}
                />
                {p.r >= 20 && (
                  <text
                    x={p.x} y={p.y + 3}
                    textAnchor="middle"
                    fontSize={Math.min(13, p.r / 2.4)}
                    fill="rgba(240,237,226,0.9)"
                    fontFamily="'JetBrains Mono', monospace"
                  >
                    {p.node.pct === null ? '—' : p.node.pct >= 1 ? `${p.node.pct.toFixed(0)}%` : `${p.node.pct.toFixed(1)}%`}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {hover && (
          <div className="absolute left-2 bottom-2 rounded-md border border-white/15 bg-krypt-panel/95 px-3 py-2 backdrop-blur-sm pointer-events-none">
            <div className="flex items-center gap-2">
              <span className="font-mono text-body text-white">
                {hover.node.label ?? shortAddr(hover.node.id, 6)}
              </span>
              <span className="text-body font-mono text-krypt-purple">{fmtPctOrDash(hover.node.pct, 2)}</span>
              {hover.node.id === creator && (
                <span className="text-micro font-bold uppercase text-rose-300">creator</span>
              )}
            </div>
            <div className="text-label text-krypt-muted mt-0.5">
              {colorFor(hover.node.tags).label}
              {hover.node.ageMs !== null && (
                <> · wallet {hover.node.ageMs < 86_400_000
                  ? `${Math.round(hover.node.ageMs / 3_600_000)}h old`
                  : `${Math.round(hover.node.ageMs / 86_400_000)}d old`}</>
              )}
            </div>
            {hover.node.fundedBy && (
              <div className="text-label text-fuchsia-300/85 mt-0.5">
                funded by {shortAddr(hover.node.fundedBy, 5)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap">
        {legend.map((t) => (
          <div key={t} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full border"
              style={{ background: TAG_COLOR[t].fill, borderColor: TAG_COLOR[t].stroke }}
            />
            <span className="text-label text-krypt-muted">{TAG_COLOR[t].label}</span>
          </div>
        ))}
      </div>

      {/* Clusters — the honest version of "bundled %" */}
      {graph.analysed && (
        biggestCluster ? (
          <div className="rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-note font-semibold text-fuchsia-200">
              <TriangleAlert className="h-3.5 w-3.5" />
              {graph.clusters.length} funding cluster{graph.clusters.length === 1 ? '' : 's'} found
            </div>
            <div className="mt-1.5 space-y-1">
              {graph.clusters.slice(0, 4).map((c) => (
                <div key={c.funder} className="text-body text-fuchsia-100/85 font-mono">
                  {c.members.length} wallets · {c.totalPct.toFixed(2)}% of supply · funded by{' '}
                  {shortAddr(c.funder, 5)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-body text-emerald-300/85">
            No funding clusters found among the analysed holders.
          </p>
        )
      )}

      {graph.note && <p className="text-label text-krypt-muted/60 leading-relaxed">{graph.note}</p>}
    </div>
  );
}
