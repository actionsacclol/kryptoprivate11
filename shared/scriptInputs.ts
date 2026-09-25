// Settings a script asks for before it runs.
//
// A code script declares what it needs at the top of its own source, and the
// app renders a form for it. The script then reads the answers from
// `bot.input`, so the same script can be run against a different coin, a
// different wallet or different ranges without anyone editing code — which is
// what a script with five numbers hardcoded into it always ends up needing.
//
//   /* @inputs
//   {
//     "mint":   { "type": "mint",  "label": "Coin" },
//     "buy":    { "type": "range", "label": "Buy each wallet", "default": [0.006, 0.012], "step": 0.001 },
//     "lines":  { "type": "lines", "label": "What to say" }
//   }
//   */
//
// ─── Why a comment, parsed as JSON ───────────────────────────────────────
//
// The declaration has to be readable BEFORE the script runs — the form is
// what makes it runnable — so it cannot be a function the script calls. A
// JSON block in a comment is static, parsed with `JSON.parse` rather than
// evaluated, and survives the code being edited around it.
//
// Nothing here trusts the block: a malformed one is reported and the script
// simply has no inputs, rather than failing to load.

import { MAX_WEBHOOK_CHARS, redactWebhook, webhookUrlProblem } from './webhook';

/** What a field looks like in the form, and what it yields. */
export type ScriptInputType =
  /** One line of text → string. */
  | 'text'
  /** Several lines, one per entry → string[]. */
  | 'lines'
  /** A single number → number. */
  | 'number'
  /** Two numbers, low and high → [number, number]. */
  | 'range'
  /** A token address → string. */
  | 'mint'
  /** One of this chain's wallets, by address → string. */
  | 'wallet'
  /** Every signed-in pump.fun account, by address → string[]. */
  | 'pumpAccounts'
  /** One of `options` → string. */
  | 'select'
  /** On or off → boolean. */
  | 'toggle'
  /**
   * A Discord webhook URL → string. Discord's hosts only (shared/webhook.ts);
   * anything else is refused on save and coerced to blank. The script never
   * sees the URL — `bot.input` carries a redacted form, and `bot.discord`
   * names the FIELD, so a post can only go where the user pasted.
   */
  | 'webhook';

export interface ScriptInputSpec {
  type: ScriptInputType;
  /** Shown beside the field. Falls back to the key. */
  label: string;
  /** A sentence under it, when the label is not enough. */
  help?: string;
  /** Pre-filled. A range's default is a two-number array. */
  default?: unknown;
  /** number / range only. */
  min?: number;
  max?: number;
  step?: number;
  /** select only. */
  options?: string[];
  /** Blank is allowed. Everything else must be answered before Run. */
  optional?: boolean;
}

export type ScriptInputSpecs = Record<string, ScriptInputSpec>;
export type ScriptInputValues = Record<string, unknown>;

/** More fields than this is a form nobody fills in. Was 16 until 09-22: a
 *  real script (scorenow) reached 18, and the fields past the cap were
 *  silently cut, so bot.input.likeChance read undefined and no like ever
 *  fired. Over the cap is now REPORTED, never trimmed. Was 24 until 09-24:
 *  scorenow reached 27, the whole block was refused, and the Settings button
 *  vanished with the error shown nowhere (the editor now shows it). */
export const MAX_INPUTS = 32;
/** Longest a text answer may be. */
export const MAX_TEXT = 500;
/** Most entries a `lines` answer may carry. */
export const MAX_LINES = 50;

const TYPES: ScriptInputType[] = ['text', 'lines', 'number', 'range', 'mint', 'wallet', 'pumpAccounts', 'select', 'toggle', 'webhook'];
/** The same list, for the docs and the AI pack — one source, so they cannot drift. */
export const SCRIPT_INPUT_TYPES: readonly ScriptInputType[] = TYPES;

/** The declaration block, or null when the script has none. */
export function inputsBlock(code: string): string | null {
  const m = /\/\*\s*@inputs\b([\s\S]*?)\*\//.exec(code ?? '');
  return m ? m[1] : null;
}

/**
 * The fields a script asks for.
 *
 * `error` is set when a block is present but unreadable — which is worth
 * saying out loud, because the alternative is a script that silently ignores
 * the settings its author wrote.
 */
export function parseInputs(code: string): { specs: ScriptInputSpecs; error: string | null } {
  const block = inputsBlock(code);
  if (block === null) return { specs: {}, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (e) {
    return { specs: {}, error: `The @inputs block is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { specs: {}, error: 'The @inputs block must be a JSON object of field name → settings.' };
  }
  const count = Object.keys(raw as Record<string, unknown>).length;
  if (count > MAX_INPUTS) {
    return { specs: {}, error: `The @inputs block declares ${count} fields; a form holds at most ${MAX_INPUTS}.` };
  }
  const specs: ScriptInputSpecs = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return { specs: {}, error: `"${key}" is not a usable name — a field is read as bot.input.${key}, so it has to be a plain identifier.` };
    }
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    const type = String(o.type ?? '') as ScriptInputType;
    if (!TYPES.includes(type)) {
      return { specs: {}, error: `"${key}" has an unknown type ${JSON.stringify(o.type)}. One of: ${TYPES.join(', ')}.` };
    }
    if (type === 'select' && (!Array.isArray(o.options) || o.options.length === 0)) {
      return { specs: {}, error: `"${key}" is a select and needs a non-empty "options" list.` };
    }
    specs[key] = {
      type,
      label: typeof o.label === 'string' && o.label ? o.label.slice(0, 80) : key,
      ...(typeof o.help === 'string' ? { help: o.help.slice(0, 200) } : {}),
      ...(o.default !== undefined ? { default: o.default } : {}),
      ...(typeof o.min === 'number' ? { min: o.min } : {}),
      ...(typeof o.max === 'number' ? { max: o.max } : {}),
      ...(typeof o.step === 'number' ? { step: o.step } : {}),
      ...(Array.isArray(o.options) ? { options: o.options.map((x) => String(x).slice(0, 80)).slice(0, 40) } : {}),
      ...(o.optional === true ? { optional: true as const } : {}),
    };
  }
  return { specs, error: null };
}

/** An empty answer for one field — what the form starts from. */
export function defaultFor(spec: ScriptInputSpec): unknown {
  if (spec.default !== undefined) return spec.default;
  switch (spec.type) {
    case 'number':
      return spec.min ?? 0;
    case 'range':
      return [spec.min ?? 0, spec.max ?? spec.min ?? 0];
    case 'lines':
    case 'pumpAccounts':
      return [];
    case 'select':
      return spec.options?.[0] ?? '';
    case 'toggle':
      return false;
    default:
      return '';
  }
}

export function defaultsFor(specs: ScriptInputSpecs): ScriptInputValues {
  const out: ScriptInputValues = {};
  for (const [k, spec] of Object.entries(specs)) out[k] = defaultFor(spec);
  return out;
}

const clamp = (n: number, spec: ScriptInputSpec): number => {
  let v = Number.isFinite(n) ? n : (spec.min ?? 0);
  if (typeof spec.min === 'number') v = Math.max(spec.min, v);
  if (typeof spec.max === 'number') v = Math.min(spec.max, v);
  return v;
};

/**
 * The answers as the script will actually see them.
 *
 * Every value is forced into its declared shape here, in one place, so a
 * script reading `bot.input.gap[0]` gets a number whatever the form or a
 * hand-edited settings file contained. A range comes back low-to-high; a
 * script should not have to sort its own inputs.
 */
export function coerceInputs(specs: ScriptInputSpecs, values: ScriptInputValues): ScriptInputValues {
  const out: ScriptInputValues = {};
  for (const [k, spec] of Object.entries(specs)) {
    // A field the saved answers have never held takes the script's own
    // default. Without this, a field added to a script that was already
    // answered read as its MINIMUM until the form was reopened — a new
    // "stop loss %" silently 0 (no stop), a new "skip above curve %" 1
    // (skip everything) (2026-09-23).
    const v = values && Object.prototype.hasOwnProperty.call(values, k) ? values[k] : spec.default;
    switch (spec.type) {
      case 'number':
        out[k] = clamp(Number(v), spec);
        break;
      case 'range': {
        const a = Array.isArray(v) ? v : [];
        const lo = clamp(Number(a[0]), spec);
        const hi = clamp(Number(a[1]), spec);
        out[k] = [Math.min(lo, hi), Math.max(lo, hi)];
        break;
      }
      case 'lines':
      case 'pumpAccounts': {
        const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
        out[k] = list
          .map((x) => String(x).trim().slice(0, MAX_TEXT))
          .filter((x) => x.length > 0)
          .slice(0, MAX_LINES);
        break;
      }
      case 'select':
        out[k] = spec.options?.includes(String(v)) ? String(v) : (spec.options?.[0] ?? '');
        break;
      case 'toggle':
        out[k] = v === true;
        break;
      case 'webhook': {
        // A URL that is not a Discord webhook is dropped, never kept: this is
        // the value main POSTs to. inputsProblem reports it before it gets here.
        const url = String(v ?? '').trim().slice(0, MAX_WEBHOOK_CHARS);
        out[k] = url && !webhookUrlProblem(url) ? url : '';
        break;
      }
      default:
        out[k] = String(v ?? '').trim().slice(0, MAX_TEXT);
    }
  }
  return out;
}

/**
 * Why this script cannot run yet, or null.
 *
 * Only about fields being ANSWERED. Whether a mint exists or a wallet is
 * funded is not a form's business — that is the script's to find out, and
 * pump's or the chain's to refuse.
 */
export function inputsProblem(specs: ScriptInputSpecs, values: ScriptInputValues): string | null {
  // A pasted webhook that is not one is said out loud, before coercion
  // blanks it and the form reads as merely unanswered.
  for (const [k, spec] of Object.entries(specs)) {
    if (spec.type !== 'webhook') continue;
    const bad = webhookUrlProblem(String(values?.[k] ?? ''));
    if (bad) return `${spec.label}: ${bad}`;
  }
  const v = coerceInputs(specs, values);
  for (const [k, spec] of Object.entries(specs)) {
    if (spec.optional) continue;
    const val = v[k];
    // `false` is an answer. A toggle left off would otherwise read as blank
    // and block a script forever on a setting the user deliberately declined.
    if (spec.type === 'toggle') continue;
    const empty =
      val === '' ||
      val === undefined ||
      val === null ||
      (Array.isArray(val) && spec.type !== 'range' && val.length === 0);
    if (empty) return `${spec.label} needs an answer before this script can run.`;
  }
  return null;
}

/** Whether a script asks for anything at all. */
export function hasInputs(specs: ScriptInputSpecs): boolean {
  return Object.keys(specs).length > 0;
}

/**
 * The answers as the SANDBOX sees them: the same as `coerceInputs`, except a
 * webhook is its redacted form ('' when unset). The URL is a credential and a
 * script has no use for it — `bot.discord` names the field and main looks
 * the URL up — so it never crosses into the sandbox at all.
 */
export function inputsForScript(specs: ScriptInputSpecs, values: ScriptInputValues): ScriptInputValues {
  const out = coerceInputs(specs, values);
  for (const [k, spec] of Object.entries(specs)) {
    if (spec.type === 'webhook') out[k] = out[k] ? redactWebhook(String(out[k])) : '';
  }
  return out;
}
