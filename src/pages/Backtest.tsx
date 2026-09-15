import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Star, Trash2 } from 'lucide-react';
import { Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useAppState } from '../state/AppStateProvider';
import type { BacktestTrade, WatchedWallet } from '@shared/types';
import { cls, shortAddr } from '../utils/format';

interface Gates {
  maxSells: number;
  maxSellVol: number;
  minBuyers: number;
  maxBuyers: number;
  minInflow: number;
  maxInflow: number;
  curveMin: number;
  curveMax: number;
  minScore: number;
  requireSmart: boolean;
}

function evaluate(rows: BacktestTrade[], g: Gates) {
  const kept = rows.filter(
    (r) =>
      r.sells <= g.maxSells &&
      r.sellVolSol <= g.maxSellVol &&
      r.uniqueBuyers >= g.minBuyers &&
      r.uniqueBuyers <= g.maxBuyers &&
      r.netInflowSol >= g.minInflow &&
      r.netInflowSol <= g.maxInflow &&
      r.curvePct >= g.curveMin &&
      r.curvePct <= g.curveMax &&
      r.score >= g.minScore &&
      (!g.requireSmart || r.smartBuyerCount > 0),
  );
  const wins = kept.filter((r) => r.win).length;
  const pnl = kept.reduce((a, r) => a + r.pnlSol, 0);
  const creatorSells = kept.filter((r) => r.exit === 'creator_sell').length;
  return { n: kept.length, wins, pnl, creatorSells, winPct: kept.length ? (wins / kept.length) * 100 : 0, avg: kept.length ? pnl / kept.length : 0 };
}

function Slider({ label, value, min, max, step = 1, onChange, suffix }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-krypt-muted">{label}</span>
        <span className="font-mono text-white">{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[#8B7CE8]" />
    </div>
  );
}

export function Backtest() {
  const toast = useToast();
  const { settings } = useAppState();
  const [rows, setRows] = useState<BacktestTrade[] | null>(null);
  const [loading, setLoading] = useState(false);
  const s = settings.strategy;
  const [g, setG] = useState<Gates>({
    maxSells: s.maxSellsInWindow, maxSellVol: s.maxSellVolumeSol, minBuyers: s.minUniqueBuyers, maxBuyers: s.maxUniqueBuyers,
    minInflow: s.minNetInflowSol, maxInflow: s.maxNetInflowSol, curveMin: s.entryCurveMinPct, curveMax: s.entryCurveMaxPct,
    minScore: s.minScore, requireSmart: false,
  });
  const set = (k: keyof Gates, v: number | boolean): void => setG((cur) => ({ ...cur, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    const r = await window.krypt.backtest.dataset();
    setLoading(false);
    if (r.ok && r.data) setRows(r.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const baseline = useMemo(() => (rows ? evaluate(rows, { maxSells: 99, maxSellVol: 999, minBuyers: 0, maxBuyers: 999, minInflow: -999, maxInflow: 999, curveMin: 0, curveMax: 100, minScore: 0, requireSmart: false }) : null), [rows]);
  const result = useMemo(() => (rows ? evaluate(rows, g) : null), [rows, g]);
  const smartCount = useMemo(() => (rows ? rows.filter((r) => r.smartBuyerCount > 0).length : 0), [rows]);

  return (
    <Page title="Backtest" subtitle="Tune the entry gates against every recorded trade. Find edge before shipping it live.">
      {!rows || rows.length === 0 ? (
        <Empty title={loading ? 'Building dataset…' : 'No closed trades recorded yet'} message="Run the engine (paper is fine) and let launches close. Then tune gates here against real outcomes." action={<GhostButton onClick={() => void load()}><RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> Reload</GhostButton>} />
      ) : (
        <>
          {/* Results */}
          <Section title={`Result over ${rows.length} recorded trades`} actions={<GhostButton onClick={() => void load()} className="!py-1.5 !px-3 text-xs"><RefreshCw className={cls('h-3.5 w-3.5', loading && 'animate-spin')} /> Reload</GhostButton>}>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {result && baseline && ([
                ['Trades kept', `${result.n}`, `of ${baseline.n}`],
                ['Win rate', `${result.winPct.toFixed(1)}%`, `base ${baseline.winPct.toFixed(0)}%`],
                ['Total PnL', `${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(3)}`, `base ${baseline.pnl >= 0 ? '+' : ''}${baseline.pnl.toFixed(2)}`],
                ['Avg / trade', `${result.avg >= 0 ? '+' : ''}${result.avg.toFixed(4)}`, `base ${baseline.avg.toFixed(4)}`],
                ['Creator dumps', `${result.creatorSells}`, `base ${baseline.creatorSells}`],
              ] as Array<[string, string, string]>).map(([label, val, sub], i) => {
                const better = i === 1 ? result.winPct >= baseline.winPct : i === 2 ? result.pnl >= baseline.pnl : i === 4 ? result.creatorSells <= baseline.creatorSells : true;
                return (
                  <Card key={label}>
                    <div className="text-label uppercase tracking-label text-krypt-muted">{label}</div>
                    <div className={cls('mt-1 text-xl font-bold font-mono', i >= 1 && i <= 2 ? (better ? 'text-emerald-300' : 'text-rose-300') : 'text-white')}>{val}</div>
                    <div className="text-label text-krypt-muted/60 mt-0.5">{sub}</div>
                  </Card>
                );
              })}
            </div>
          </Section>

          {/* Gates */}
          <Section title="Entry gates" description="Adjust and watch the result update live. Apply the winners in the Strategy tab.">
            <Card className="grid lg:grid-cols-2 gap-x-8 gap-y-4">
              <Slider label="Max sells in window" value={g.maxSells} min={0} max={10} onChange={(v) => set('maxSells', v)} />
              <Slider label="Max sell volume" value={g.maxSellVol} min={0} max={5} step={0.1} onChange={(v) => set('maxSellVol', v)} suffix=" SOL" />
              <Slider label="Min unique buyers" value={g.minBuyers} min={0} max={30} onChange={(v) => set('minBuyers', v)} />
              <Slider label="Max unique buyers" value={g.maxBuyers} min={1} max={50} onChange={(v) => set('maxBuyers', v)} />
              <Slider label="Min net inflow" value={g.minInflow} min={0} max={30} onChange={(v) => set('minInflow', v)} suffix=" SOL" />
              <Slider label="Max net inflow" value={g.maxInflow} min={2} max={60} onChange={(v) => set('maxInflow', v)} suffix=" SOL" />
              <Slider label="Curve entry min" value={g.curveMin} min={0} max={40} onChange={(v) => set('curveMin', v)} suffix="%" />
              <Slider label="Curve entry max" value={g.curveMax} min={5} max={90} onChange={(v) => set('curveMax', v)} suffix="%" />
              <Slider label="Min score" value={g.minScore} min={0} max={100} onChange={(v) => set('minScore', v)} />
              <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                <input type="checkbox" checked={g.requireSmart} onChange={(e) => set('requireSmart', e.target.checked)} className="accent-[#8B7CE8] h-4 w-4" />
                Require smart-wallet buyer <span className="text-xs text-krypt-muted">({smartCount} trades have one)</span>
              </label>
            </Card>
          </Section>

          <WatchlistManager />
        </>
      )}
    </Page>
  );

  function WatchlistManager() {
    const [list, setList] = useState<WatchedWallet[]>([]);
    const [addr, setAddr] = useState('');
    const [lbl, setLbl] = useState('');
    const refresh = useCallback(() => { void window.krypt.watchlist.get().then((r) => { if (r.ok && r.data) setList(r.data); }); }, []);
    useEffect(() => { refresh(); }, [refresh]);
    const add = async (): Promise<void> => {
      const r = await window.krypt.watchlist.add(addr.trim(), lbl.trim());
      if (r.ok && r.data) { setList(r.data); setAddr(''); setLbl(''); toast.success(r.message); } else toast.error(r.message);
    };
    const remove = async (a: string): Promise<void> => {
      const r = await window.krypt.watchlist.remove(a);
      if (r.ok && r.data) setList(r.data);
    };
    return (
      <Section title="Smart-wallet watchlist" description="When any of these wallets buys a launch, it's flagged and recorded — so we can correlate 'smart money present' against outcomes.">
        <Card className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Wallet address" spellCheck={false}
              className="flex-1 min-w-[240px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60" />
            <input value={lbl} onChange={(e) => setLbl(e.target.value)} placeholder="Label (optional)"
              className="w-40 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder-krypt-muted/40 outline-none focus:border-krypt-purple/60" />
            <PrimaryButton onClick={() => void add()} disabled={addr.trim().length < 32}>Watch</PrimaryButton>
          </div>
          {list.length === 0 ? (
            <div className="text-xs text-krypt-muted">No wallets watched.</div>
          ) : (
            <div className="divide-y divide-white/5">
              {list.map((w) => (
                <div key={w.address} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Star className="h-3.5 w-3.5 text-krypt-purple flex-shrink-0" />
                    <span className="text-sm text-white truncate">{w.label}</span>
                    <span className="text-xs font-mono text-krypt-muted">{shortAddr(w.address, 6)}</span>
                  </div>
                  <button onClick={() => void remove(w.address)} className="text-krypt-muted hover:text-rose-300 transition p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    );
  }
}
