// History reader — aggregates the JSONL recordings on disk into a summary.
// The recorder is the durable source of truth, so history survives restarts
// and the in-memory launch/position caps. Files can be tens of MB (mostly
// trade events), so we stream line-by-line and only keep aggregates + a
// capped tail of closes.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { BacktestTrade, HistoryClose, HistorySummary } from '@shared/types';

const RECENT_CLOSES_CAP = 500;
const EQUITY_POINTS = 240;

function hourLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
}

export async function summarize(recordingsDir: string): Promise<HistorySummary> {
  const empty: HistorySummary = {
    files: 0, firstAt: null, lastAt: null, launches: 0, trades: 0, entered: 0, closed: 0,
    decisions: {}, exitReasons: {}, realizedPnlSol: 0, wins: 0, losses: 0, best: 0, worst: 0,
    equity: [], hourly: [], recentCloses: [],
  };
  let files: string[] = [];
  try {
    files = fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return empty;
  }
  if (files.length === 0) return empty;

  const s: HistorySummary = { ...empty, files: files.length, decisions: {}, exitReasons: {}, hourly: [], recentCloses: [] };
  const closes: HistoryClose[] = [];
  const launchesByHour = new Map<number, number>();
  const entriesByHour = new Map<number, number>();
  const HOUR = 3_600_000;

  for (const file of files) {
    const stream = fs.createReadStream(path.join(recordingsDir, file), { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let r: { t?: string; at?: number; action?: string; reason?: string; pnlSol?: number; pnlPct?: number; mint?: string };
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const at = r.at ?? 0;
      if (at) {
        s.firstAt = s.firstAt === null ? at : Math.min(s.firstAt, at);
        s.lastAt = s.lastAt === null ? at : Math.max(s.lastAt, at);
      }
      switch (r.t) {
        case 'create': {
          s.launches++;
          const b = Math.floor(at / HOUR);
          launchesByHour.set(b, (launchesByHour.get(b) ?? 0) + 1);
          break;
        }
        case 'trade':
          s.trades++;
          break;
        case 'decision':
          s.decisions[r.action ?? '?'] = (s.decisions[r.action ?? '?'] ?? 0) + 1;
          if (r.action === 'enter') {
            s.entered++;
            const b = Math.floor(at / HOUR);
            entriesByHour.set(b, (entriesByHour.get(b) ?? 0) + 1);
          }
          break;
        case 'position_close': {
          s.closed++;
          const reason = r.reason ?? '?';
          s.exitReasons[reason] = (s.exitReasons[reason] ?? 0) + 1;
          const pnl = r.pnlSol ?? 0;
          closes.push({ at, mint: r.mint ?? '', reason, pnlSol: pnl, pnlPct: r.pnlPct ?? 0 });
          break;
        }
      }
    }
  }

  // Realized PnL + cumulative equity (chronological, excluding orphaned voids).
  closes.sort((a, b) => a.at - b.at);
  const real = closes.filter((c) => c.reason !== 'orphaned');
  let cum = 0;
  const fullEquity: Array<{ t: number; v: number }> = [];
  for (const c of real) {
    cum += c.pnlSol;
    fullEquity.push({ t: c.at, v: Math.round(cum * 1e6) / 1e6 });
    if (c.pnlSol > 0) s.wins++;
    else s.losses++;
    if (c.pnlSol > s.best) s.best = c.pnlSol;
    if (c.pnlSol < s.worst) s.worst = c.pnlSol;
  }
  s.realizedPnlSol = Math.round(cum * 1e6) / 1e6;

  // Downsample equity to a fixed point count.
  if (fullEquity.length <= EQUITY_POINTS) {
    s.equity = fullEquity;
  } else {
    const step = fullEquity.length / EQUITY_POINTS;
    for (let i = 0; i < EQUITY_POINTS; i++) s.equity.push(fullEquity[Math.floor(i * step)]);
    s.equity.push(fullEquity[fullEquity.length - 1]);
  }

  // Hourly buckets across the covered span.
  if (s.firstAt !== null && s.lastAt !== null) {
    const start = Math.floor(s.firstAt / HOUR);
    const end = Math.floor(s.lastAt / HOUR);
    for (let b = start; b <= end; b++) {
      s.hourly.push({ label: hourLabel(b * HOUR), launches: launchesByHour.get(b) ?? 0, entries: entriesByHour.get(b) ?? 0 });
    }
  }

  s.recentCloses = closes.slice(-RECENT_CLOSES_CAP).reverse();
  return s;
}

/**
 * Build the backtest dataset: every closed round-trip with the flow features
 * observed at the entry decision joined to its realized outcome. This is what
 * the in-app backtester filters against, so gate changes can be evaluated on
 * real recorded trades before shipping them.
 */
export async function backtestDataset(recordingsDir: string): Promise<BacktestTrade[]> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  // First pass: enter decisions (features) + closes (outcomes), keyed by mint.
  const enters = new Map<string, { flow: Record<string, number>; score: number; smartBuyers: number }>();
  const closesByMint = new Map<string, { pnlSol: number; reason: string }>();
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(recordingsDir, file), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let r: {
        t?: string; action?: string; mint?: string; score?: number; smartBuyers?: number;
        flow?: Record<string, number>; pnlSol?: number; reason?: string;
      };
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.t === 'decision' && r.action === 'enter' && r.mint && r.flow) {
        enters.set(r.mint, { flow: r.flow, score: r.score ?? 0, smartBuyers: r.smartBuyers ?? 0 });
      } else if (r.t === 'position_close' && r.mint) {
        closesByMint.set(r.mint, { pnlSol: r.pnlSol ?? 0, reason: r.reason ?? '?' });
      }
    }
  }
  const out: BacktestTrade[] = [];
  for (const [mint, e] of enters) {
    const cl = closesByMint.get(mint);
    if (!cl || cl.reason === 'orphaned') continue;
    const f = e.flow;
    out.push({
      score: e.score,
      uniqueBuyers: f.uniqueBuyers ?? 0,
      netInflowSol: f.netInflowSol ?? 0,
      sells: f.sells ?? 0,
      sellVolSol: f.sellVolumeSol ?? 0,
      curvePct: f.curveProgressPct ?? 0,
      topHolderShare: f.topHolderTokenShare ?? 0,
      earlyBuyerShare: f.earlyBuyerShare ?? 0,
      smartBuyerCount: e.smartBuyers,
      pnlSol: cl.pnlSol,
      exit: cl.reason,
      win: cl.pnlSol > 0,
    });
  }
  return out;
}
