// Krypto Trader — the user's pacing limits (09-25: every limit is the user's,
// the same call as Krypto Mode's). Defaults are the design's values; 0 turns a
// limit off. When an ANTI-WASH limit is off the one amber line from
// TRADER_ANTIWASH_LINE shows — the same line a running session carries.

import { useState } from 'react';
import {
  DEFAULT_TRADER_LIMITS,
  TRADER_ANTIWASH_LINE,
  TRADER_LIMIT_BOUNDS,
  TRADER_LIMIT_TEXT,
  traderAntiWashOff,
  traderLimitsOf,
  type TraderDriver,
  type TraderLimits,
} from '@shared/kryptoTrader';
import { cls } from '../../utils/format';

/** The limits only the AI and MCP drivers are held to. */
const DRIVER_ONLY: (keyof TraderLimits)[] = ['maxLosingAdds', 'aiMaxBuyPctOfBudget'];
/** The AI key's own pacing (how often it is asked) — the AI driver only. */
const AI_ONLY: (keyof TraderLimits)[] = ['aiMinGapSec', 'aiMaxAsksPerHour'];

export function AntiWashLine() {
  return (
    <p data-antiwash className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] p-2 text-label leading-relaxed text-amber-100/85">
      {TRADER_ANTIWASH_LINE}
    </p>
  );
}

export function TraderLimitsFields({ limits, driver, onChange }: { limits: TraderLimits; driver: TraderDriver; onChange: (next: TraderLimits) => void }) {
  const keys = (Object.keys(TRADER_LIMIT_TEXT) as (keyof TraderLimits)[]).filter((k) => (driver !== 'strategy' || !DRIVER_ONLY.includes(k)) && (driver === 'ai' || !AI_ONLY.includes(k)));
  const isDefault = keys.every((k) => limits[k] === DEFAULT_TRADER_LIMITS[k]);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {keys.map((k) => (
          <LimitInput key={k} k={k} value={limits[k]} changed={limits[k] !== DEFAULT_TRADER_LIMITS[k]} onCommit={(v) => onChange(traderLimitsOf({ [k]: v }, limits))} />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-micro text-krypt-muted/60">0 = off. Changed values are marked.</span>
        {!isDefault && (
          <button type="button" onClick={() => onChange({ ...DEFAULT_TRADER_LIMITS })} className="text-label text-krypt-muted underline underline-offset-2 hover:text-white">
            Back to the defaults
          </button>
        )}
      </div>
      {traderAntiWashOff(limits).length > 0 && <AntiWashLine />}
    </div>
  );
}

function LimitInput({ k, value, changed, onCommit }: { k: keyof TraderLimits; value: number | null; changed: boolean; onCommit: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const nullable = k === 'oppositeMovePct';
  const shown = text ?? (value === null ? '' : String(value));
  const commit = () => {
    if (text === null) return;
    const raw = text.trim();
    setText(null);
    if (raw === '') {
      // Empty means "worked out per coin" for the move limit, and "off" for
      // the rest — never a silent revert to the default.
      onCommit(nullable ? null : 0);
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) onCommit(n);
  };
  const [lo, hi] = TRADER_LIMIT_BOUNDS[k];
  return (
    <label className="block" data-limit={k}>
      <span className="block text-label text-krypt-muted">
        {TRADER_LIMIT_TEXT[k].label}
        {changed && <span className="ml-1 text-arc-gold/90">·&nbsp;changed</span>}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={nullable ? 'per coin' : undefined}
        onFocus={() => setText(value === null ? '' : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className={cls(
          'mt-0.5 w-full rounded-md border bg-black/30 px-2 py-1 font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50',
          value === 0 ? 'border-amber-400/30' : 'border-white/10',
        )}
      />
      <span className="block text-micro leading-relaxed text-krypt-muted/60">
        {TRADER_LIMIT_TEXT[k].help} ({lo}–{hi})
      </span>
    </label>
  );
}
