import { useState } from 'react';
import { ChevronDown, EyeOff, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { HIDE_TRADEOFF } from '@shared/rugrules';
import {
  emptyFilters,
  STATS_WINDOWS,
  type DiscoverFilters,
  type FilterPreset,
  type Launchpad,
  type Range,
  type StatsWindow,
} from '@shared/market';
import type { OddsBucket } from '@shared/odds';
import { cls } from '../../utils/format';
import { ODDS_BUCKET_LABEL, ODDS_BUCKET_ORDER } from '../../utils/odds';
import type { DiscoverSort } from '../../state/TerminalProvider';

// The filter surface from term.txt section 4. Every field is a min/max pair
// and every one is optional — an empty box means "don't filter on this",
// which is why these are text inputs parsed to number|null rather than
// NumberInput (which cannot represent "unset").

function RangeInput({
  label,
  value,
  onChange,
  suffix,
  step,
}: {
  label: string;
  value: Range;
  onChange: (next: Range) => void;
  suffix?: string;
  step?: string;
}) {
  const parse = (raw: string): number | null => {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const box =
    'w-full bg-black/40 border border-white/10 rounded px-1.5 py-1 text-body font-mono text-white outline-none focus:border-krypt-purple/50 placeholder:text-krypt-muted/40';

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-micro uppercase tracking-label text-krypt-muted">{label}</span>
        {suffix && <span className="text-micro text-krypt-muted/50">{suffix}</span>}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          placeholder="min"
          value={value.min ?? ''}
          onChange={(e) => onChange({ ...value, min: parse(e.target.value) })}
          className={box}
        />
        <span className="text-krypt-muted/40 text-label">–</span>
        <input
          type="number"
          step={step}
          placeholder="max"
          value={value.max ?? ''}
          onChange={(e) => onChange({ ...value, max: parse(e.target.value) })}
          className={box}
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cls(
        'rounded border px-2 py-1 text-label font-semibold transition',
        checked
          ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white'
          : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white hover:border-white/20',
      )}
    >
      {label}
    </button>
  );
}

/**
 * The launch rails, ordered by how well this app covers them.
 *
 * `hint` is shown on hover and says what you actually get, because coverage
 * genuinely differs per rail — LaunchLab trades arrive without a trader, and
 * Boop is barely active. A selector that implied they were equivalent would
 * be the dishonest kind of tidy.
 */
const LAUNCHPADS: Array<{ id: Launchpad; label: string; hint: string }> = [
  { id: 'pumpfun', label: 'Pump.fun', hint: 'Full coverage: live tape, launch intel, execution' },
  { id: 'bonk', label: 'LetsBonk', hint: 'Raydium LaunchLab — live tape and exact curve progress (trades arrive without a trader)' },
  { id: 'meteora', label: 'Meteora DBC', hint: 'Believe and others — exact curve progress, per-token live tape' },
  { id: 'boop', label: 'Boop', hint: 'Own curve program, fully decoded — but the rail is nearly dormant' },
  { id: 'moonshot', label: 'Moonshot', hint: 'Listed by providers; no dedicated decoder' },
  { id: 'believe', label: 'Believe', hint: 'Runs on Meteora DBC' },
  { id: 'raydium', label: 'Raydium', hint: 'Post-migration AMM pools' },
  { id: 'pons', label: 'Pons', hint: 'Robinhood Chain — bonding curve, graduates to Uniswap v4 at 4.2 ETH; on-chain progress and execution' },
  { id: 'fourmeme', label: 'four.meme', hint: 'BNB Smart Chain — bonding curve, graduates to PancakeSwap v2 at 18 BNB; on-chain progress and execution' },
  // Every EVM row that did NOT come from a launchpad decoder is tagged with
  // its chain, so without these chips ticking a launchpad silently empties
  // the Trending column with no way to bring those rows back.
  { id: 'robinhood', label: 'Robinhood pools', hint: 'Robinhood Chain — Uniswap pools with no launchpad decoder' },
  { id: 'bnb', label: 'BNB pools', hint: 'BNB Smart Chain — PancakeSwap and other pools with no launchpad decoder' },
];

/** How many filter fields are actually doing something. */
export function activeFilterCount(f: DiscoverFilters): number {
  let n = 0;
  for (const [key, v] of Object.entries(f)) {
    if (key === 'window' || key === 'search') continue;
    if (v && typeof v === 'object' && 'min' in v) {
      const r = v as Range;
      if (r.min !== null || r.max !== null) n++;
    } else if (Array.isArray(v)) {
      if (v.length) n++;
    } else if (v === true) {
      n++;
    }
  }
  return n;
}

export function FilterBar({
  filters,
  onChange,
  presets,
  activePresetId,
  onApplyPreset,
  counts,
  hideFlagged,
  onHideFlagged,
  hiddenFlagged,
  sortBy,
  onSortBy,
  minOddsBucket,
  onMinOddsBucket,
  hiddenByOdds,
}: {
  filters: DiscoverFilters;
  onChange: (next: DiscoverFilters) => void;
  presets: FilterPreset[];
  activePresetId: string | null;
  onApplyPreset: (id: string | null) => void;
  /** How many rows in the loaded columns carry each launchpad. Lets a chip
   *  say what it would actually show — an empty one is usually a coverage
   *  fact, not a mistake by the user. */
  counts?: Partial<Record<Launchpad, number>>;
  /** The measured rug-rule hide (R1–R4). Lives outside `DiscoverFilters`
   *  because it is not a user threshold — it is the shipped default. */
  hideFlagged: boolean;
  onHideFlagged: (on: boolean) => void;
  /** Rows the hide removed, across all columns. */
  hiddenFlagged: number;
  /** Column order — provider's own ranking, or graduation-odds bucket. */
  sortBy: DiscoverSort;
  onSortBy: (s: DiscoverSort) => void;
  /** "Odds bucket ≥ …" threshold; null = off. Not-judged rows cannot pass. */
  minOddsBucket: OddsBucket | null;
  onMinOddsBucket: (b: OddsBucket | null) => void;
  /** Rows the odds threshold removed, across all columns. */
  hiddenByOdds: number;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof DiscoverFilters>(key: K, value: DiscoverFilters[K]): void =>
    onChange({ ...filters, [key]: value });
  const active = activeFilterCount(filters);

  return (
    <div className="plate rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <button
          onClick={() => setOpen((o) => !o)}
          className={cls(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-body font-semibold transition',
            active > 0
              ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white'
              : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {active > 0 && (
            <span className="rounded-full bg-krypt-purple/40 px-1.5 text-micro font-bold text-white">{active}</span>
          )}
          <ChevronDown className={cls('h-3 w-3 transition', open && 'rotate-180')} />
        </button>

        <div className="h-5 w-px bg-white/10" />

        {/* Stats window — decides which set of numbers every volume/txn
            filter and every card metric refers to. */}
        <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
          {STATS_WINDOWS.map((w: StatsWindow) => (
            <button
              key={w}
              onClick={() => set('window', w)}
              className={cls(
                'px-2 py-1 text-label font-mono font-semibold transition',
                filters.window === w ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
              )}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-white/10" />

        {/* Launchpad selector, out in the open.
            It used to live inside the collapsed panel, which meant the one
            filter people reach for most was three clicks away. ALL is the
            absence of a filter, not a value — an empty list matches
            everything, including tokens whose launchpad we could not
            identify. */}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={() => set('launchpads', [])}
            title="Every launchpad, including tokens we could not identify"
            className={cls(
              'rounded-md px-2 py-1 text-label font-semibold uppercase tracking-wider transition border',
              filters.launchpads.length === 0
                ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            All
          </button>
          {LAUNCHPADS.map((lp) => {
            const on = filters.launchpads.includes(lp.id);
            return (
              <button
                key={lp.id}
                title={lp.hint}
                onClick={() =>
                  set('launchpads', on ? filters.launchpads.filter((x) => x !== lp.id) : [...filters.launchpads, lp.id])
                }
                className={cls(
                  'rounded-md px-2 py-1 text-label font-semibold transition border',
                  on
                    ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white'
                    : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white hover:border-white/25',
                )}
              >
                {lp.label}
                {counts?.[lp.id] !== undefined && (
                  <span className={cls('ml-1 font-mono', on ? 'text-white/70' : 'text-krypt-muted/60')}>
                    {counts[lp.id]}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="h-5 w-px bg-white/10" />

        <div className="flex items-center gap-1 flex-wrap">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => onApplyPreset(activePresetId === p.id ? null : p.id)}
              className={cls(
                'rounded-md border px-2 py-1 text-label font-semibold transition',
                activePresetId === p.id
                  ? 'border-arc-gold/50 bg-arc-gold/15 text-arc-gold'
                  : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white hover:border-white/20',
              )}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-white/10" />

        {/* The measured hide. Absence of a flag is NOT safety — the residual
            is still ~77 % bad — which is why that sentence lives here on the
            toggle and never on a card. */}
        <button
          onClick={() => onHideFlagged(!hideFlagged)}
          title={HIDE_TRADEOFF.text}
          className={cls(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-label font-semibold transition',
            hideFlagged
              ? 'border-rose-400/40 bg-rose-500/10 text-rose-200'
              : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white hover:border-white/20',
          )}
        >
          <EyeOff className="h-3 w-3" />
          Hide flagged launches
          {hideFlagged && (
            <span className="font-mono text-rose-200/70">{hiddenFlagged} hidden</span>
          )}
        </button>

        <div className="h-5 w-px bg-white/10" />

        {/* Graduation odds — a sort and a threshold on the measured bucket.
            Neither is a user number: the buckets are the shipped model's,
            and the threshold drops not-judged rows because an unknown
            cannot clear a bar. */}
        <div className="flex items-center gap-1">
          <label className="text-micro uppercase tracking-label text-krypt-muted/60">Sort</label>
          <select
            value={sortBy}
            onChange={(e) => onSortBy(e.target.value as DiscoverSort)}
            title="Provider order keeps each column as its source ranked it. Graduation odds orders by measured bucket, best first, not-judged rows last."
            className="bg-black/40 border border-white/10 rounded-md px-1.5 py-1 text-label text-white outline-none focus:border-krypt-purple/50"
          >
            <option value="provider">Provider order</option>
            <option value="odds">Graduation odds</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <label className="text-micro uppercase tracking-label text-krypt-muted/60">Odds ≥</label>
          <select
            value={minOddsBucket ?? ''}
            onChange={(e) => onMinOddsBucket(e.target.value === '' ? null : (e.target.value as OddsBucket))}
            title="Keep only launches judged in this bucket or better. Launches not judged yet (under 60 s, graduated, or first trades unread) are dropped while this is on."
            className={cls(
              'bg-black/40 border rounded-md px-1.5 py-1 text-label outline-none focus:border-krypt-purple/50',
              minOddsBucket === null ? 'border-white/10 text-krypt-muted' : 'border-arc-gold/40 text-arc-gold',
            )}
          >
            <option value="">Any</option>
            {ODDS_BUCKET_ORDER.map((b) => (
              <option key={b} value={b}>
                {ODDS_BUCKET_LABEL[b]}
              </option>
            ))}
          </select>
          {minOddsBucket !== null && (
            <span className="font-mono text-label text-arc-gold/70">{hiddenByOdds} hidden</span>
          )}
        </div>

        <div className="flex-1" />

        <div className="relative">
          <input
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Filter by name, symbol or mint…"
            className="w-56 bg-black/40 border border-white/10 rounded-md pl-2.5 pr-7 py-1.5 text-body text-white outline-none focus:border-krypt-purple/50 placeholder:text-krypt-muted/50"
          />
          {filters.search && (
            <button
              onClick={() => set('search', '')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-krypt-muted hover:text-white"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {active > 0 && (
          <button
            onClick={() => onApplyPreset(null)}
            title="Clear all filters"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-label text-krypt-muted hover:text-white"
          >
            <RotateCcw className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-white/10 px-3 py-3 space-y-3 animate-ink">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <RangeInput label="Age" suffix="sec" value={filters.ageSec} onChange={(v) => set('ageSec', v)} />
            <RangeInput label="Market cap" suffix="$" value={filters.marketCapUsd} onChange={(v) => set('marketCapUsd', v)} />
            <RangeInput label="Liquidity" suffix="$" value={filters.liquidityUsd} onChange={(v) => set('liquidityUsd', v)} />
            <RangeInput label={`Volume ${filters.window}`} suffix="$" value={filters.volumeUsd} onChange={(v) => set('volumeUsd', v)} />
            <RangeInput label="Transactions" value={filters.txns} onChange={(v) => set('txns', v)} />
            <RangeInput label="Buys" value={filters.buys} onChange={(v) => set('buys', v)} />
            <RangeInput label="Sells" value={filters.sells} onChange={(v) => set('sells', v)} />
            <RangeInput label="Buy/sell ratio" step="0.1" value={filters.buySellRatio} onChange={(v) => set('buySellRatio', v)} />
            <RangeInput label="Holders" value={filters.holders} onChange={(v) => set('holders', v)} />
            <RangeInput label="Holder growth" suffix="%" value={filters.holderGrowthPct} onChange={(v) => set('holderGrowthPct', v)} />
            <RangeInput label="Top 10" suffix="%" value={filters.top10Pct} onChange={(v) => set('top10Pct', v)} />
            <RangeInput label="Dev holding" suffix="%" value={filters.devHoldingPct} onChange={(v) => set('devHoldingPct', v)} />
            <RangeInput label="Insider" suffix="%" value={filters.insiderPct} onChange={(v) => set('insiderPct', v)} />
            <RangeInput label="Sniper" suffix="%" value={filters.sniperPct} onChange={(v) => set('sniperPct', v)} />
            <RangeInput label="Bundled" suffix="%" value={filters.bundledPct} onChange={(v) => set('bundledPct', v)} />
            <RangeInput label="Smart holders" value={filters.smartHolders} onChange={(v) => set('smartHolders', v)} />
            <RangeInput label="Bonding curve" suffix="%" value={filters.bondingCurvePct} onChange={(v) => set('bondingCurvePct', v)} />
            <RangeInput label="Krypt score" value={filters.kryptScore} onChange={(v) => set('kryptScore', v)} />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {/* Launchpad toggles moved to the always-visible row above. */}
            <div
              className="flex items-center gap-1.5"
              title="Socials and DEX-paid have no measured edge: socials show no effect on dying (84 % vs 85 %) and hide half of graduations if used as a filter. Kept as descriptive filters only."
            >
              <span className="text-micro uppercase tracking-label text-krypt-muted mr-1">Descriptive — requires</span>
              <Toggle label="X" checked={filters.requireTwitter} onChange={(v) => set('requireTwitter', v)} />
              <Toggle label="Telegram" checked={filters.requireTelegram} onChange={(v) => set('requireTelegram', v)} />
              <Toggle label="Website" checked={filters.requireWebsite} onChange={(v) => set('requireWebsite', v)} />
              <Toggle label="DEX paid" checked={filters.requireDexPaid} onChange={(v) => set('requireDexPaid', v)} />
            </div>
            <div className="flex items-center gap-1.5">
              <Toggle
                label="Hide bad creators"
                checked={filters.hideBlacklistedCreators}
                onChange={(v) => set('hideBlacklistedCreators', v)}
              />
            </div>

            <div className="flex-1" />
            <button
              onClick={() => onChange({ ...emptyFilters(), window: filters.window, search: filters.search })}
              className="text-label text-krypt-muted hover:text-white underline underline-offset-2"
            >
              Reset all ranges
            </button>
          </div>

          <div className="space-y-1 pt-1 border-t border-white/5">
            <p className="text-label text-krypt-muted/60 leading-relaxed">
              A range filter is skipped for any token where that metric is unknown, rather than hiding the token.
            </p>
            <p className="text-label text-krypt-muted/60 leading-relaxed">
              <span className="text-krypt-muted">Hide flagged launches:</span> {HIDE_TRADEOFF.text} Launches whose
              first trades have not been read yet are never hidden — unknown is not flagged.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
