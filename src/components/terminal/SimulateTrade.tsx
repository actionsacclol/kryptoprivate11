// A made-up trade, for looking at the replay and the card without waiting
// for a real round trip whose candles still exist (2026-09-03).
//
// Providers keep very little history for a dead memecoin — most real trades
// come back with one candle, which makes the animation impossible to judge.
// Type a ticker, a size, a result and a hold, and this draws the trade that
// would have produced it.
//
// What it makes is a picture of numbers the user typed. It touches no wallet,
// is never written to the trade history, and lives only as long as the panel
// showing it — the mint it carries is a placeholder, not an address.

import { useMemo, useState } from 'react';
import { Clapperboard, Image as ImageIcon, Wand2, X } from 'lucide-react';
import type { Candle } from '@shared/market';
import type { ClosedTrade } from '@shared/portfolio';
import { DEFAULT_SIM, simulateTrade, type SimShape } from '@shared/simTrade';
import { NumberInput } from '../common';
import { cls } from '../../utils/format';

const SHAPES: Array<{ id: SimShape; label: string }> = [
  { id: 'dip-then-run', label: 'Dip, then run' },
  { id: 'spike-then-fade', label: 'Spike, then fade' },
  { id: 'steady', label: 'Steady' },
  { id: 'chop', label: 'Chop' },
];

const HOLD_PRESETS: Array<{ label: string; ms: number }> = [
  { label: '30s', ms: 30_000 },
  { label: '2m', ms: 120_000 },
  { label: '10m', ms: 600_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
];

const inputCls =
  'rounded-md border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60';

export function SimulateTrade({
  onClose,
  onReplay,
  onCard,
}: {
  onClose: () => void;
  onReplay: (trade: ClosedTrade, candles: Candle[]) => void;
  onCard: (trade: ClosedTrade) => void;
}) {
  const [symbol, setSymbol] = useState('DEMO');
  const [costSol, setCostSol] = useState(0.5);
  const [pnlPct, setPnlPct] = useState(180);
  const [holdMs, setHoldMs] = useState(600_000);
  const [volatility, setVolatility] = useState(45);
  const [shape, setShape] = useState<SimShape>('dip-then-run');
  const [seed, setSeed] = useState(7);

  // Rebuilt on every change so the numbers under the buttons are the numbers
  // the replay will show.
  const result = useMemo(
    () =>
      simulateTrade({
        ...DEFAULT_SIM,
        symbol: symbol.trim() || 'DEMO',
        costSol: Math.max(0.001, costSol),
        pnlPct,
        holdMs,
        volatility: Math.max(0, Math.min(1, volatility / 100)),
        shape,
        seed,
        // Placed in the recent past so the replay reads as "just now".
        closedAt: Date.now() - 60_000,
      }),
    [symbol, costSol, pnlPct, holdMs, volatility, shape, seed],
  );
  const { trade, candles } = result;
  const up = trade.pnlSol >= 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="plate w-full max-w-lg animate-pop-in rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-display text-[11px] font-semibold uppercase tracking-[0.28em] text-krypt-muted">
            Simulate a trade
          </h3>
          <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
          <button onClick={onClose} className="text-krypt-muted transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 rounded-md border border-krypt-pink/30 bg-krypt-pink/10 px-3 py-2 text-[11px] leading-relaxed text-krypt-pink/90">
          A made-up trade for checking how the replay and the card look. Nothing here touches your wallet, and it is
          never recorded against your trade history.
        </p>

        <div className="grid gap-2.5">
          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Ticker</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              maxLength={12}
              spellCheck={false}
              className={cls(inputCls, 'w-36 font-mono uppercase')}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Size in</label>
            <NumberInput value={costSol} min={0.001} max={1000} onChange={setCostSol} suffix="SOL" className="w-32" />
          </div>

          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Result</label>
            <NumberInput value={pnlPct} min={-99} max={100000} onChange={setPnlPct} suffix="%" className="w-32" />
            <span className={cls('font-mono text-[12px]', up ? 'text-emerald-300' : 'text-rose-300')}>
              {up ? '+' : ''}
              {trade.pnlSol.toFixed(3)} SOL out {trade.proceedsSol.toFixed(3)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Held</label>
            <div className="flex overflow-hidden rounded-md border border-white/10">
              {HOLD_PRESETS.map((h) => (
                <button
                  key={h.label}
                  onClick={() => setHoldMs(h.ms)}
                  className={cls(
                    'px-2.5 py-1 text-[10px] font-semibold transition',
                    holdMs === h.ms ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                  )}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Shape</label>
            <select value={shape} onChange={(e) => setShape(e.target.value as SimShape)} className={cls(inputCls, 'w-44')}>
              {SHAPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-28 text-[11px] text-krypt-muted">Violence</label>
            <input
              type="range"
              min={0}
              max={100}
              value={volatility}
              onChange={(e) => setVolatility(Number(e.target.value))}
              className="w-44 accent-krypt-purple"
            />
            <span className="font-mono text-[11px] text-krypt-muted">{volatility}</span>
            <button
              onClick={() => setSeed((s) => s + 1)}
              title="Same numbers, a different path"
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10px] font-semibold text-krypt-muted transition hover:text-white"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Reshuffle
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/8 pt-3">
          <button
            onClick={() => onReplay(trade, candles)}
            className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
          >
            <Clapperboard className="h-4 w-4" />
            Replay it
          </button>
          <button
            onClick={() => onCard(trade)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            <ImageIcon className="h-4 w-4" />
            Make the card
          </button>
          <span className="font-mono text-[11px] text-krypt-muted">{candles.length} candles</span>
        </div>
      </div>
    </div>
  );
}
