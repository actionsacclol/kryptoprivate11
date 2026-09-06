// AI token analysis — bring-your-own-key second opinion on a token.
//
// ─── What this is, and is not ─────────────────────────────────────────
//
// A user can plug in an OpenAI or Anthropic key and get an LLM's read on a
// token: a score and a short, structured take. It is a SECOND OPINION on the
// same on-chain facts the app already shows — never a data source, never a
// recommendation. The Software Terms already disclaim scores and signals as
// automated, frequently wrong, and not financial advice; this is exactly that,
// and the UI labels it so.
//
// This module is pure: it builds the prompt from a token's facts and validates
// the model's JSON reply. The HTTP calls and key handling live in
// electron/data/aiAnalysis.ts, main-process only — a key never crosses to the
// renderer, and the model only ever receives PUBLIC on-chain facts (disclosed
// in the privacy policy), never the user's wallet or keys.

import type { TokenDetail, TokenSummary } from './market';

export type AiProvider = 'openai' | 'anthropic';

export interface AiSettings {
  /** 'off' disables the feature; otherwise which provider runs an analysis. */
  provider: 'off' | AiProvider;
  openaiKey: string;
  anthropicKey: string;
  /** Editable because model IDs churn; sensible defaults, user overrides. */
  openaiModel: string;
  anthropicModel: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'off',
  openaiKey: '',
  anthropicKey: '',
  openaiModel: 'gpt-4o-mini',
  anthropicModel: 'claude-sonnet-5',
};

export interface AiAnalysis {
  /** 0..100 overall rating, or null if the model declined to score. */
  score: number | null;
  /** Short label, e.g. "Avoid", "High risk", "Speculative". */
  verdict: string;
  /** One or two plain sentences. */
  summary: string;
  /** Reasons for, reasons against. */
  bullish: string[];
  bearish: string[];
  provider: AiProvider;
  model: string;
  /** Epoch ms, stamped by the caller (not the model). */
  at: number;
}

// ─── Prompt ───────────────────────────────────────────────────────────

export const AI_SYSTEM_PROMPT = [
  'You are a skeptical on-chain analyst for Solana memecoins. You are given the',
  'facts an app already gathered about ONE token. Give a concise, honest second',
  'opinion for a trader who will make their own decision.',
  '',
  'Rules:',
  '- Most new memecoins go to zero or are outright scams. Default to caution.',
  '- Judge ONLY from the facts given. If a fact is "unknown", treat it as unknown',
  '  — never assume it is fine and never invent numbers.',
  '- Weigh the real risk signals: high dev/insider/bundled/sniper concentration,',
  '  thin liquidity, few holders, no socials, a bad creator track record.',
  '- This is NOT financial advice and you are NOT a financial adviser. Do not tell',
  '  the user to buy or sell. Describe the risk/opportunity; the decision is theirs.',
  '- Respond with ONLY a JSON object, no prose, no markdown fences, matching:',
  '  {"score": <0-100 integer or null>, "verdict": "<=4 words",',
  '   "summary": "1-2 sentences", "bullish": ["..."], "bearish": ["..."]}',
  '  score = your overall rating (higher = stronger/safer-looking, still risky).',
].join('\n');

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? 'unknown' : `${v.toFixed(1)}%`);
const usd = (v: number | null | undefined): string =>
  v === null || v === undefined ? 'unknown' : `$${Math.round(v).toLocaleString('en-US')}`;
const num = (v: number | null | undefined): string => (v === null || v === undefined ? 'unknown' : String(v));
const ageStr = (createdAt: number | null | undefined, now: number): string => {
  if (!createdAt) return 'unknown';
  const mins = Math.max(0, Math.round((now - createdAt) / 60000));
  if (mins < 60) return `${mins}m old`;
  if (mins < 1440) return `${Math.round(mins / 60)}h old`;
  return `${Math.round(mins / 1440)}d old`;
};

/**
 * Assemble the facts block. Kept as compact labelled lines rather than raw JSON
 * so the model reads it the way a person would, and so "unknown" is explicit
 * (the honest-null rule carried all the way to the prompt).
 */
export function buildFacts(summary: TokenSummary, detail: TokenDetail | null, now: number): string {
  const s = summary;
  const win = s.stats['5m'] ?? s.stats['1h'] ?? s.stats['24h'];
  const lines = [
    `Token: ${s.symbol || '?'} (${s.name || 'unnamed'}) on ${s.launchpad}`,
    `Age: ${ageStr(s.createdAt, now)}`,
    `Market cap: ${usd(s.marketCapUsd)} | Liquidity: ${usd(s.liquidityUsd)}`,
    `Holders: ${num(s.holders)} | Krypt score: ${s.kryptScore === null ? 'unknown' : `${s.kryptScore}/100`}`,
    `Bonding curve progress: ${s.bondingCurvePct === null ? 'unknown' : s.bondingCurvePct >= 100 ? 'graduated to a DEX' : pct(s.bondingCurvePct)}`,
    `Concentration — dev: ${pct(s.devHoldingPct)}, top holders/insiders: ${pct(s.insiderPct)}, bundled: ${pct(s.bundledPct)}, snipers: ${pct(s.sniperPct)}`,
    `Smart-money holders: ${num(s.smartHolders)}`,
    `Recent window (${win ? '' : 'unknown'}): volume ${usd(win?.volumeUsd)}, buys ${num(win?.buys)}, sells ${num(win?.sells)}, price change ${win?.priceChangePct === null || win?.priceChangePct === undefined ? 'unknown' : `${win.priceChangePct.toFixed(1)}%`}`,
    `Socials: ${[s.socials.twitter && 'twitter', s.socials.telegram && 'telegram', s.socials.website && 'website'].filter(Boolean).join(', ') || 'none'}${s.socials.dexPaid ? ' (paid DexScreener enhancement)' : ''}`,
  ];
  const risky = (detail?.security?.checks ?? []).filter((c) => c.verdict === 'fail' || c.verdict === 'warn');
  if (risky.length) {
    lines.push(`Security concerns: ${risky.map((c) => `${c.label} (${c.verdict})`).join('; ')}`);
  }
  if (detail?.warnings?.length) lines.push(`Warnings: ${detail.warnings.join('; ')}`);
  return lines.join('\n');
}

// ─── Response parsing ─────────────────────────────────────────────────

/** Pull a JSON object out of a model reply that may be fenced or chatty. */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Prefer a fenced block, else the first {...} span.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8) : [];

/**
 * Validate and coerce a model reply into an AiAnalysis. Returns null when the
 * reply is unusable — a bad response must surface as an honest error, never as
 * a fabricated score.
 */
export function parseAnalysis(
  raw: string,
  provider: AiProvider,
  model: string,
  at: number,
): AiAnalysis | null {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  let score: number | null = null;
  if (typeof o.score === 'number' && Number.isFinite(o.score)) {
    score = Math.max(0, Math.min(100, Math.round(o.score)));
  }
  const verdict = typeof o.verdict === 'string' && o.verdict.trim() ? o.verdict.trim().slice(0, 40) : 'No verdict';
  const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, 600) : '';
  if (!summary) return null; // a take with no summary is not a take

  return {
    score,
    verdict,
    summary,
    bullish: asStringArray(o.bullish),
    bearish: asStringArray(o.bearish),
    provider,
    model,
    at,
  };
}

/** 0..100 → a tone hint the UI can color by, without hardcoding thresholds twice. */
export function scoreTone(score: number | null): 'unknown' | 'bad' | 'mid' | 'good' {
  if (score === null) return 'unknown';
  if (score < 35) return 'bad';
  if (score < 65) return 'mid';
  return 'good';
}
