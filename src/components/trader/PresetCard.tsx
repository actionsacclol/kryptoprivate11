// Krypto Trader — one preset card (design §3).
//
// Each card says the rule in words, the honest result from the tests with its
// n, and — under Adjust — the parameters. A card the fit check greyed out
// cannot be picked, and says why. There is no market-cap or volume preset:
// "Hold with a stop" fills that slot on purpose (D1/D2).

import { useState, type ReactNode } from 'react';
import { Minus, Plus, SlidersHorizontal } from 'lucide-react';
import {
  TRADER_PARAM_BOUNDS,
  TRADER_PRESET_TEXT,
  traderMoney,
  traderNativeText,
  traderParamsOf,
  type TraderOptions,
  type DipsParams,
  type HoldParams,
  type StepsParams,
  type TraderParamsByPreset,
  type TraderPreset,
  type TrimParams,
} from '@shared/kryptoTrader';
import { cls } from '../../utils/format';

export function PresetCard<P extends TraderPreset>({
  preset,
  selected,
  greyed,
  params,
  onSelect,
  onParams,
  chain = 'solana',
}: {
  preset: P;
  /** The session chain: the rule's money reads in its coin. The tested
   *  results stay as measured (Solana pump.fun coins, in SOL) and say so. */
  chain?: TraderOptions['chain'];
  selected: boolean;
  /** The fit check's reason this preset does not fit, or null. */
  greyed: string | null;
  params: TraderParamsByPreset[P];
  onSelect: () => void;
  onParams: (next: TraderParamsByPreset[P]) => void;
}) {
  const [adjust, setAdjust] = useState(false);
  const t = TRADER_PRESET_TEXT[preset];
  // Every edit goes back through the same parser main uses, so the form can
  // never hold a value main would clamp differently.
  const set = (patch: Partial<TraderParamsByPreset[P]>) => onParams(traderParamsOf(preset, { ...params, ...patch }));
  return (
    <div
      data-preset={preset}
      className={cls(
        'rounded-lg border p-3 transition',
        greyed ? 'border-white/5 bg-black/20 opacity-60' : selected ? 'border-krypt-purple/60 bg-krypt-purple/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/5',
      )}
    >
      <button type="button" disabled={!!greyed} onClick={onSelect} className="block w-full text-left disabled:cursor-not-allowed">
        <div className="flex items-center gap-2">
          <span className={cls('h-3 w-3 flex-shrink-0 rounded-full border', selected && !greyed ? 'border-krypt-purple bg-krypt-purple' : 'border-white/30')} />
          <span className="text-note font-semibold text-white">{t.label}</span>
        </div>
        <p className="mt-1 text-body leading-relaxed text-white/80">{traderNativeText(t.rule, chain)}</p>
        {t.card && <p className="mt-1 text-label leading-relaxed text-krypt-muted">{t.card}</p>}
        <p className="mt-1 text-label leading-relaxed text-krypt-muted/80">
          {t.result}
          {chain !== 'solana' && ' Measured on Solana pump.fun coins; nothing was tested on this chain.'}
        </p>
      </button>
      {greyed && <p className="mt-1.5 text-label leading-relaxed text-amber-200/90">Does not fit this coin: {greyed}</p>}
      {!greyed && (
        <button
          type="button"
          onClick={() => setAdjust((a) => !a)}
          className="mt-2 inline-flex items-center gap-1 text-label text-krypt-muted hover:text-white"
        >
          <SlidersHorizontal className="h-3 w-3" />
          {adjust ? 'Hide settings' : 'Adjust'}
        </button>
      )}
      {adjust && !greyed && (
        <div className="mt-2 rounded-md border border-white/10 bg-black/20 p-2.5">
          {preset === 'trim' && <TrimEditor p={params as TrimParams} set={set as (x: Partial<TrimParams>) => void} />}
          {preset === 'steps' && <StepsEditor p={params as StepsParams} set={set as (x: Partial<StepsParams>) => void} unit={traderMoney(chain).symbol} />}
          {preset === 'dips' && <DipsEditor p={params as DipsParams} set={set as (x: Partial<DipsParams>) => void} />}
          {preset === 'hold' && <HoldEditor p={params as HoldParams} set={set as (x: Partial<HoldParams>) => void} />}
        </div>
      )}
    </div>
  );
}

// ─── editors ───────────────────────────────────────────────────────────────

function TrimEditor({ p, set }: { p: TrimParams; set: (x: Partial<TrimParams>) => void }) {
  const b = TRADER_PARAM_BOUNDS.trim;
  return (
    <Grid>
      <Num label="Entry (% of budget)" v={p.entryPct} bounds={b.entryPct} on={(v) => set({ entryPct: v })} />
      <Num label="Core never trimmed (% of bag)" v={p.corePct} bounds={b.corePct} on={(v) => set({ corePct: v })} />
      <Num label="Trim step (+% above anchor)" v={p.stepPct} bounds={b.stepPct} on={(v) => set({ stepPct: v })} help="Below this coin's cost floor the fit check greys the preset." />
      <Num label="Trim size (% of tradable bag)" v={p.trimPct} bounds={b.trimPct} on={(v) => set({ trimPct: v })} />
      <Num label="Rebuy dip (−% from last trim)" v={p.rebuyDipPct} bounds={b.rebuyDipPct} on={(v) => set({ rebuyDipPct: v })} />
      <Num label="Max rounds per day" v={p.maxRoundsPerDay} bounds={b.maxRoundsPerDay} on={(v) => set({ maxRoundsPerDay: v })} />
      <Check
        label="Pause near graduation (curve ≥ 95%)"
        checked={p.pauseNearGrad}
        on={(v) => set({ pauseNearGrad: v })}
        help="Locked on while the coin is on its curve; turning it off only matters after graduation."
      />
    </Grid>
  );
}

function StepsEditor({ p, set, unit }: { p: StepsParams; set: (x: Partial<StepsParams>) => void; unit: string }) {
  const b = TRADER_PARAM_BOUNDS.steps;
  const [refused, setRefused] = useState(false);
  const sum = p.rungs.reduce((a, r) => a + r.sellPct, 0);
  // The parser falls back to the DEFAULT steps when the sizes sum past 100 %,
  // so an edit that would do that is refused here instead of silently
  // replacing everything the user set.
  const setRungs = (rungs: StepsParams['rungs']) => {
    if (rungs.reduce((a, r) => a + r.sellPct, 0) > 100) {
      setRefused(true);
      return;
    }
    setRefused(false);
    set({ rungs });
  };
  const setRung = (i: number, patch: Partial<{ upPct: number; sellPct: number }>) => setRungs(p.rungs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <Grid>
        <Num label="Entry (% of budget)" v={p.entryPct} bounds={b.entryPct} on={(v) => set({ entryPct: v })} />
        <Check label={`First step returns the ${unit} put in`} checked={p.recoverCostFirst} on={(v) => set({ recoverCostFirst: v })} />
      </Grid>
      <div className="space-y-1.5">
        <div className="text-label uppercase tracking-label text-krypt-muted/70">Steps (+% over average cost · % of bag sold)</div>
        {p.rungs.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <RawNum v={r.upPct} bounds={b.upPct} on={(v) => setRung(i, { upPct: v })} suffix="% up" />
            <RawNum v={r.sellPct} bounds={b.sellPct} on={(v) => setRung(i, { sellPct: v })} suffix="% sold" />
            <button
              type="button"
              disabled={p.rungs.length <= b.rungs[0]}
              onClick={() => setRungs(p.rungs.filter((_, j) => j !== i))}
              className="rounded-md border border-white/10 p-1 text-krypt-muted hover:text-white disabled:opacity-30"
              title="Remove this step"
            >
              <Minus className="h-3 w-3" />
            </button>
          </div>
        ))}
        {p.rungs.length < b.rungs[1] && sum < 100 && (
          <button
            type="button"
            onClick={() => {
              const last = p.rungs[p.rungs.length - 1];
              const up = Math.min(b.upPct[1], (last?.upPct ?? 50) * 2);
              const sell = Math.max(1, Math.min(25, 100 - sum));
              setRungs([...p.rungs, { upPct: up, sellPct: sell }]);
            }}
            className="inline-flex items-center gap-1 text-label text-krypt-muted hover:text-white"
          >
            <Plus className="h-3 w-3" /> Add a step
          </button>
        )}
        <p className="text-label text-krypt-muted/70">
          Steps sell {sum}% of the bag in total{sum < 100 ? `; the other ${100 - sum}% is held until the stop or the time limit` : ''}.
        </p>
        {refused && <p className="text-label text-rose-300">That would sell more than 100% of the bag — the steps were kept as they were.</p>}
      </div>
    </div>
  );
}

function DipsEditor({ p, set }: { p: DipsParams; set: (x: Partial<DipsParams>) => void }) {
  const b = TRADER_PARAM_BOUNDS.dips;
  return (
    <Grid>
      <Num label="Lots" v={p.lots} bounds={b.lots} on={(v) => set({ lots: v })} />
      <Num label="Step below average cost (%)" v={p.stepPct} bounds={b.stepPct} on={(v) => set({ stepPct: v })} />
      <Num label="Size multiplier per lot" v={p.sizeMult} bounds={b.sizeMult} on={(v) => set({ sizeMult: v })} help="1.0 to 1.5 — never a 2× Martingale." />
      <NullableNum label="Take all profit at (+% vs average)" v={p.takeProfitPct} bounds={b.takeProfitPct} on={(v) => set({ takeProfitPct: v })} />
      <Num label="No buy this far under the session high (%)" v={p.maxBelowHighPct} bounds={b.maxBelowHighPct} on={(v) => set({ maxBelowHighPct: v })} />
    </Grid>
  );
}

function HoldEditor({ p, set }: { p: HoldParams; set: (x: Partial<HoldParams>) => void }) {
  const b = TRADER_PARAM_BOUNDS.hold;
  return (
    <Grid>
      <Num label="Entry (% of budget)" v={p.entryPct} bounds={b.entryPct} on={(v) => set({ entryPct: v })} />
      <NullableNum label="Sell all at (+%)" v={p.takeProfitPct} bounds={b.takeProfitPct} on={(v) => set({ takeProfitPct: v })} />
    </Grid>
  );
}

// ─── small inputs ──────────────────────────────────────────────────────────

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>;
}

const inputCls = 'w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50';

/** A number with a local text buffer, committed on blur/Enter; the parser
 *  clamps it to the range shown under it. */
function useBuffer(v: number | null, commit: (raw: string) => void) {
  const [text, setText] = useState<string | null>(null);
  return {
    value: text ?? (v === null ? '' : String(v)),
    onFocus: () => setText(v === null ? '' : String(v)),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
    onBlur: () => {
      if (text !== null) commit(text.trim());
      setText(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    },
  };
}

function Num({ label, v, bounds, on, help }: { label: string; v: number; bounds: readonly [number, number]; on: (v: number) => void; help?: string }) {
  const buf = useBuffer(v, (raw) => {
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) on(n);
  });
  return (
    <label className="block">
      <span className="block text-label text-krypt-muted">{label}</span>
      <input type="text" inputMode="decimal" {...buf} className={cls('mt-0.5', inputCls)} />
      <span className="block text-micro text-krypt-muted/60">
        {bounds[0]}–{bounds[1]}
        {help ? ` · ${help}` : ''}
      </span>
    </label>
  );
}

/** Empty = off. */
function NullableNum({ label, v, bounds, on }: { label: string; v: number | null; bounds: readonly [number, number]; on: (v: number | null) => void }) {
  const buf = useBuffer(v, (raw) => {
    if (raw === '') return on(null);
    const n = Number(raw);
    if (Number.isFinite(n)) on(n);
  });
  return (
    <label className="block">
      <span className="block text-label text-krypt-muted">{label}</span>
      <input type="text" inputMode="decimal" placeholder="off" {...buf} className={cls('mt-0.5', inputCls)} />
      <span className="block text-micro text-krypt-muted/60">
        Empty = off · {bounds[0]}–{bounds[1]}
      </span>
    </label>
  );
}

function RawNum({ v, bounds, on, suffix }: { v: number; bounds: readonly [number, number]; on: (v: number) => void; suffix: string }) {
  const buf = useBuffer(v, (raw) => {
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) on(Math.min(bounds[1], Math.max(bounds[0], n)));
  });
  return (
    <div className="flex min-w-0 flex-1 items-center rounded-md border border-white/10 bg-black/30">
      <input type="text" inputMode="decimal" {...buf} className="w-full min-w-0 bg-transparent px-2 py-1 font-mono text-body text-white/90 outline-none" />
      <span className="flex-shrink-0 pr-2 text-micro text-krypt-muted">{suffix}</span>
    </div>
  );
}

function Check({ label, checked, on, help }: { label: string; checked: boolean; on: (v: boolean) => void; help?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 pt-1">
      <input type="checkbox" checked={checked} onChange={(e) => on(e.target.checked)} className="mt-0.5 accent-[rgb(var(--krypt-accent))]" />
      <span>
        <span className="block text-label text-white/85">{label}</span>
        {help && <span className="block text-micro text-krypt-muted/60">{help}</span>}
      </span>
    </label>
  );
}
