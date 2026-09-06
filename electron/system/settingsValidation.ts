// Main-side validation for `settings:update`.
//
// WHY (2026-08-16 product swarm §8): the handler accepted an arbitrary
// `Partial<AppSettings>` from the renderer and passed it straight into the
// store. `Partial<AppSettings>` is a COMPILE-TIME claim — at runtime the
// renderer can send anything, and a compromised renderer (or an XSS in any
// content the UI renders) could rewrite execution limits, then flip
// autoCashout, and drain through the sweep path. The signer now refuses
// unknown destinations (signPolicy.ts), but defence in depth means the store
// should not accept junk in the first place.
//
// The rule set is derived from DEFAULT_SETTINGS so it cannot drift as fields
// are added: unknown keys are dropped, type mismatches are rejected, and the
// money-critical numbers are bounded explicitly below.

import { BLOCK_FEED_WSS_URLS, DEFAULT_SETTINGS, type AppSettings } from '@shared/types';

export interface Validated {
  ok: boolean;
  message: string;
  patch?: Partial<AppSettings>;
  /** Paths the patch carried that the store is not allowed to take from it.
   *  They are removed, not treated as an error — see OWNED_ELSEWHERE. */
  stripped?: string[];
}

/**
 * Fields the renderer may SEND but never SET through a settings patch.
 *
 * `execution.liveEnabled` is the trading mode. It is owned by live:setLive,
 * which arms or disarms the engine in the same step; a raw patch would let
 * the persisted bit and the engine disagree — exactly the lie the Paper/Live
 * switch exists to prevent.
 *
 * Until 2026-09-06 sending it REJECTED the whole patch, which turned out to
 * break every panel that edits a sibling field: they all send
 * `{ execution: { ...settings.execution, field: value } }`, and that spread
 * carries the current liveEnabled along with it. The result was that MEV
 * mode, Jito, Helius Sender, local build, max live SOL, slippage, auto
 * cash-out and auto-sell-on-exit could not be saved at all — a user reported
 * "Rejected settings update — execution.liveEnabled: use the Paper/Live
 * switch" while sitting in Live the whole time, having tried to change
 * something else entirely.
 *
 * Dropping the field instead keeps the guarantee that mattered (the bit can
 * never reach the store from a patch) without holding the rest of the patch
 * hostage to it.
 */
const OWNED_ELSEWHERE = new Set(['execution.liveEnabled']);

/** Inclusive bounds for numbers where a bad value costs real SOL. */
const BOUNDS: Record<string, { min: number; max: number; int?: boolean }> = {
  'execution.maxLiveSol': { min: 0.000001, max: 25 },
  'execution.liveSlippagePct': { min: 0, max: 50 },
  'execution.maxLiveSessionLossSol': { min: 0, max: 100 },
  'execution.maxLiveConsecutiveLosses': { min: 1, max: 50, int: true },
  'execution.cashoutThresholdSol': { min: 0.000001, max: 100 },
  'execution.computeUnitLimit': { min: 10_000, max: 1_400_000, int: true },
  'strategy.maxSessionLossSol': { min: 0, max: 1000 },
  'strategy.maxConsecutiveLosses': { min: 1, max: 100, int: true },
  'strategy.runnerAlerts.maxPerHour': { min: 1, max: 120, int: true },
  // Terminal data settings. A refresh interval of 0 would hammer four
  // third-party APIs in a tight loop and get the user rate-limited into a
  // broken-looking app, so the floor is enforced here rather than in the UI.
  'data.discoverRefreshSec': { min: 2, max: 300, int: true },
  'data.discoverLimit': { min: 5, max: 80, int: true },
  'alerts.repeatCooldownSec': { min: 5, max: 3600, int: true },
};

/** Fields that may only take one of a fixed set of values. */
const ENUMS: Record<string, readonly unknown[]> = {
  'execution.feeUrgency': ['normal', 'competitive', 'high', 'emergency'],
  'execution.mevMode': ['off', 'fast', 'private'],
  'execution.jitoTipPercentile': [50, 75, 95],
  'strategy.runnerAlerts.minBucket': ['top1', 'top1_5', 'top5_10'],
  // The block-feed host is a pick from a hardcoded list, never free text:
  // no IPC channel accepts a URL (terminal-data-providers rule), and a
  // blockSubscribe socket pulls whole blocks from whatever it is pointed at.
  'rpc.blockWssUrl': BLOCK_FEED_WSS_URLS,
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Hotkeys fire real trades, so a binding that reaches the store must be
 *  fully shaped and bounded — never a partially-typed object from the
 *  renderer. Anything malformed rejects the whole patch. */
function validateBindings(raw: unknown): { ok: boolean; message: string; value?: unknown } {
  if (!Array.isArray(raw)) return { ok: false, message: 'hotkeys.bindings: expected an array' };
  if (raw.length > 40) return { ok: false, message: 'hotkeys.bindings: too many bindings' };
  const out: unknown[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return { ok: false, message: 'hotkeys.bindings: entry is not an object' };
    const { id, combo, action, enabled } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 64) return { ok: false, message: 'hotkeys.bindings: bad id' };
    if (typeof combo !== 'string' || combo.length > 40) return { ok: false, message: 'hotkeys.bindings: bad combo' };
    if (typeof enabled !== 'boolean') return { ok: false, message: 'hotkeys.bindings: bad enabled flag' };
    if (!isPlainObject(action)) return { ok: false, message: 'hotkeys.bindings: bad action' };
    const kind = (action as Record<string, unknown>).kind;
    if (kind === 'buy') {
      const sol = Number((action as Record<string, unknown>).sol);
      if (!Number.isFinite(sol) || sol <= 0 || sol > 25) {
        return { ok: false, message: 'hotkeys.bindings: buy amount must be between 0 and 25 SOL' };
      }
      out.push({ id, combo, enabled, action: { kind: 'buy', sol } });
    } else if (kind === 'sell') {
      const percent = Number((action as Record<string, unknown>).percent);
      if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        return { ok: false, message: 'hotkeys.bindings: sell percent must be a whole number 1-100' };
      }
      out.push({ id, combo, enabled, action: { kind: 'sell', percent } });
    } else if (kind === 'emergency_sell') {
      out.push({ id, combo, enabled, action: { kind: 'emergency_sell' } });
    } else {
      return { ok: false, message: 'hotkeys.bindings: unknown action kind' };
    }
  }
  return { ok: true, message: 'ok', value: out };
}

function checkLeaf(path: string, value: unknown, def: unknown): string | null {
  // typeof [] and typeof {} are both 'object', so an array default would
  // accept an object (or null) and persist a value that throws on the next
  // engine start. Arrays are checked as arrays: length capped, every element
  // matching the default's element type.
  if (Array.isArray(def)) {
    if (!Array.isArray(value)) return `${path}: expected a list`;
    if (value.length > 32) return `${path}: at most 32 entries`;
    const elemType = def.length ? typeof def[0] : 'string';
    for (const [i, v] of value.entries()) {
      if (typeof v !== elemType) return `${path}[${i}]: expected ${elemType}`;
      if (elemType === 'string' && (v as string).length > 2_000) return `${path}[${i}]: string too long`;
    }
    return null;
  }
  if (Array.isArray(value)) return `${path}: expected ${typeof def}, got a list`;
  if (typeof value !== typeof def) {
    return `${path}: expected ${typeof def}, got ${typeof value}`;
  }
  // typeof null is 'object', so a null would otherwise pass wherever the
  // default is an object and be spread into the stored settings.
  if (def !== null && value === null) return `${path}: expected ${typeof def}, got null`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path}: not a finite number`;
    const b = BOUNDS[path];
    if (b) {
      if (b.int && !Number.isInteger(value)) return `${path}: must be a whole number`;
      if (value < b.min || value > b.max) return `${path}: must be between ${b.min} and ${b.max}`;
    }
  }
  if (typeof value === 'string' && value.length > 2_000) {
    return `${path}: string too long`;
  }
  const e = ENUMS[path];
  if (e && !e.includes(value)) {
    return `${path}: must be one of ${e.join(', ')}`;
  }
  return null;
}

/**
 * Drop unknown keys and reject malformed or out-of-range values. Returns the
 * cleaned patch, or ok:false with the first problem found.
 */
export function validateSettingsPatch(raw: unknown): Validated {
  if (!isPlainObject(raw)) return { ok: false, message: 'Settings patch must be an object' };

  const out: Record<string, unknown> = {};
  const stripped: string[] = [];
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in defaults)) continue; // unknown top-level key — silently dropped
    // settingsRevision is owned by the migration, never by the renderer.
    if (key === 'settingsRevision') continue;
    const def = defaults[key];

    if (isPlainObject(def)) {
      if (!isPlainObject(value)) return { ok: false, message: `${key}: expected an object` };
      const nested: Record<string, unknown> = {};
      for (const [k2, v2] of Object.entries(value)) {
        if (!(k2 in def)) continue; // unknown nested key — dropped
        // Carried along by a spread, not something a patch may set.
        if (OWNED_ELSEWHERE.has(`${key}.${k2}`)) {
          stripped.push(`${key}.${k2}`);
          continue;
        }
        const defLeaf = (def as Record<string, unknown>)[k2];
        // One field is two levels deep: `data.providers` is a map of
        // provider id -> boolean. checkLeaf would wave any object through
        // (typeof 'object' === typeof 'object'), so it gets an explicit
        // pass: known ids only, booleans only.
        // Hotkey bindings are an array of objects — neither the object nor
        // the scalar path fits, and they decide what a keypress SPENDS, so
        // they get their own explicit shape check.
        if (key === 'hotkeys' && k2 === 'bindings') {
          const cleaned = validateBindings(v2);
          if (!cleaned.ok) return { ok: false, message: `Rejected settings update — ${cleaned.message}` };
          nested[k2] = cleaned.value;
          continue;
        }
        if (isPlainObject(defLeaf)) {
          if (!isPlainObject(v2)) return { ok: false, message: `${key}.${k2}: expected an object` };
          const inner: Record<string, unknown> = {};
          for (const [k3, v3] of Object.entries(v2)) {
            if (!(k3 in defLeaf)) continue;
            if (typeof v3 !== typeof (defLeaf as Record<string, unknown>)[k3]) {
              return { ok: false, message: `Rejected settings update — ${key}.${k2}.${k3}: wrong type` };
            }
            inner[k3] = v3;
          }
          nested[k2] = inner;
          continue;
        }
        const err = checkLeaf(`${key}.${k2}`, v2, defLeaf);
        if (err) return { ok: false, message: `Rejected settings update — ${err}` };
        nested[k2] = v2;
      }
      out[key] = nested;
    } else {
      const err = checkLeaf(key, value, def);
      if (err) return { ok: false, message: `Rejected settings update — ${err}` };
      out[key] = value;
    }
  }

  return { ok: true, message: 'ok', patch: out as Partial<AppSettings>, stripped };
}
