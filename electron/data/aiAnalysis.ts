// AI analysis — the HTTP side. Main-process only.
//
// The key never leaves this process. The renderer asks for an analysis by mint;
// the engine assembles the PUBLIC on-chain facts and this module sends them to
// the chosen provider with the user's own key. What crosses the wire to OpenAI
// or Anthropic is exactly the facts block (disclosed in the privacy policy) —
// never the wallet, never any key but the one for that provider.

import {
  AI_SYSTEM_PROMPT,
  aiCostUsd,
  aiProviderOf,
  buildFacts,
  parseAnalysis,
  traderAskTokens,
  type AiAnalysis,
  type AiProvider,
  type AiSettings,
} from '@shared/ai';
import type { TokenDetail, TokenSummary } from '@shared/market';
import { kryptoAiPrompt, type KryptoGoal } from '@shared/kryptoMode';
import { TRADER_AI_PROMPT, TRADER_AI_REPLY_SCHEMA, traderAiModelFor } from '@shared/kryptoTrader';

export interface AiResult {
  ok: boolean;
  message: string;
  analysis?: AiAnalysis;
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 30_000;

/** Which provider a request will use, given the settings. Null = not usable. */
export function activeProvider(ai: AiSettings): AiProvider | null {
  if (ai.provider === 'openai' && ai.openaiKey.trim()) return 'openai';
  if (ai.provider === 'anthropic' && ai.anthropicKey.trim()) return 'anthropic';
  return null;
}

export async function analyze(
  ai: AiSettings,
  summary: TokenSummary,
  detail: TokenDetail | null,
  now: number,
): Promise<AiResult> {
  const provider = activeProvider(ai);
  if (!provider) {
    return { ok: false, message: 'AI analysis is off, or the key for the selected provider is missing (Settings → AI).' };
  }
  const facts = buildFacts(summary, detail, now);
  const userPrompt = `Analyse this token and reply with ONLY the JSON object described.\n\n${facts}`;

  try {
    const raw =
      provider === 'openai'
        ? await callOpenAI(ai.openaiKey.trim(), ai.openaiModel.trim() || 'gpt-4o-mini', userPrompt)
        : await callAnthropic(ai.anthropicKey.trim(), ai.anthropicModel.trim() || 'claude-sonnet-5', userPrompt);
    if (!raw.ok) return { ok: false, message: raw.message };

    const model = provider === 'openai' ? ai.openaiModel : ai.anthropicModel;
    const analysis = parseAnalysis(raw.text, provider, model, now);
    if (!analysis) return { ok: false, message: 'The model did not return a usable analysis. Try again or a different model.' };
    return { ok: true, message: 'ok', analysis };
  } catch (err) {
    return { ok: false, message: `AI request failed: ${(err as Error).message}` };
  }
}

/**
 * $Krypto Mode's AI driver: the facts block (public market facts + the bot's
 * own book, built by kryptoFacts — no key, no address) → the model's raw
 * reply. Parsing and every limit are the caller's (shared/kryptoMode.ts).
 */
export async function askKrypto(ai: AiSettings, facts: string, goal: KryptoGoal = 'position'): Promise<{ ok: boolean; message: string; text?: string }> {
  const provider = activeProvider(ai);
  if (!provider) return { ok: false, message: 'No AI key is set (Settings → AI).' };
  const prompt = `Decide the bot's next move and reply with ONLY the JSON object described.

${facts}`;
  try {
    const r =
      provider === 'openai'
        ? await callOpenAI(ai.openaiKey.trim(), ai.openaiModel.trim() || 'gpt-4o-mini', prompt, kryptoAiPrompt(goal))
        : await callAnthropic(ai.anthropicKey.trim(), ai.anthropicModel.trim() || 'claude-sonnet-5', prompt, kryptoAiPrompt(goal));
    return r.ok ? { ok: true, message: 'ok', text: r.text } : { ok: false, message: r.message };
  } catch (err) {
    return { ok: false, message: `AI request failed: ${(err as Error).message}` };
  }
}

/**
 * Krypto Trader's AI driver (stage 3): the facts (shared/kryptoTrader.ts
 * traderFacts — numbers and app-defined values only, the coin is "the coin")
 * → the model's raw reply, with what the call cost. There is NO goal
 * parameter and one prompt, TRADER_AI_PROMPT: Krypto Mode's prompts for a
 * declared bot on the user's own coin never reach a trader session (T20).
 * Parsing (parseTraderAiReply, strict) and every limit are the caller's.
 *
 * The reply is asked for as structured JSON output where the provider takes
 * a schema (Anthropic output_config.format, OpenAI json_schema). A refusal or
 * a reply cut off at max_tokens is not ok — the caller holds — but its tokens
 * were billed, so its cost is still returned and counted.
 */
export async function askTrader(
  ai: AiSettings,
  facts: string,
  opts: { model?: string | null; style?: string | null } = {},
): Promise<{ ok: boolean; message: string; text?: string; model: string | null; provider: AiProvider | null; usd: number | null; usdEstimated: boolean; refusal: boolean; cutOff: boolean }> {
  const pick = traderAiModelFor(opts.model ?? null, { anthropic: !!ai.anthropicKey.trim(), openai: !!ai.openaiKey.trim() });
  if (!pick) {
    return {
      ok: false,
      message: opts.model ? `No ${aiProviderOf(opts.model) === 'anthropic' ? 'Anthropic' : 'OpenAI'} key is set for ${opts.model} (Settings → AI).` : 'No AI key is set (Settings → AI).',
      model: opts.model ?? null,
      provider: null,
      usd: null,
      usdEstimated: false,
      refusal: false,
      cutOff: false,
    };
  }
  const system = opts.style ? `${TRADER_AI_PROMPT}\n\nStyle for this session: ${opts.style}` : TRADER_AI_PROMPT;
  const call = { maxTokens: 400, schema: TRADER_AI_REPLY_SCHEMA as unknown as Record<string, unknown> };
  try {
    const r =
      pick.provider === 'openai'
        ? await callOpenAI(ai.openaiKey.trim(), pick.model, facts, system, call)
        : await callAnthropic(ai.anthropicKey.trim(), pick.model, facts, system, call);
    let usd: number | null = null;
    let usdEstimated = false;
    if (r.usage) usd = aiCostUsd(pick.model, r.usage.input, r.usage.output);
    else if (r.reached) {
      // The provider answered but said nothing about usage: count the
      // expected size, never zero, so the day's cap cannot be passed silently.
      const t = traderAskTokens(pick.model);
      usd = aiCostUsd(pick.model, t.input, t.output);
      usdEstimated = true;
    }
    const base = { model: pick.model, provider: pick.provider, usd, usdEstimated, refusal: r.stop === 'refusal', cutOff: r.stop === 'max_tokens' };
    return r.ok ? { ...base, ok: true, message: 'ok', text: r.text } : { ...base, ok: false, message: r.message };
  } catch (err) {
    return { ok: false, message: `AI request failed: ${(err as Error).message}`, model: pick.model, provider: pick.provider, usd: null, usdEstimated: false, refusal: false, cutOff: false };
  }
}

/** Cheap sanity check that a key works, for the settings panel. */
export async function verifyKey(provider: AiProvider, key: string, model: string): Promise<AiResult> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, message: 'No key' };
  const probe = 'Reply with ONLY {"score": 50, "verdict": "test", "summary": "ok", "bullish": [], "bearish": []}';
  try {
    const r =
      provider === 'openai'
        ? await callOpenAI(trimmed, model.trim() || 'gpt-4o-mini', probe)
        : await callAnthropic(trimmed, model.trim() || 'claude-sonnet-5', probe);
    return r.ok ? { ok: true, message: 'Key works' } : { ok: false, message: r.message };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

interface CallResult {
  ok: boolean;
  text: string;
  message: string;
  /** Tokens the provider billed, when it said. */
  usage: { input: number; output: number } | null;
  /** 'refusal' | 'max_tokens' | the provider's own stop reason, or null. */
  stop: string | null;
  /** The provider answered (so the call was billed), whatever it said. */
  reached: boolean;
}

interface CallOpts {
  /** The reply budget for a model that does not think. Thinking models get more (below). */
  maxTokens?: number;
  /** A JSON schema for structured output. Without one: JSON mode (OpenAI) / plain text (Anthropic). */
  schema?: Record<string, unknown>;
}

/**
 * The Anthropic request body for this model — the per-model fixes (design
 * §7, checked against the claude-api reference 2026-09-25):
 *   • Opus 5.5 cannot turn thinking off (a `thinking: disabled` is a 400):
 *     it runs at `output_config.effort: "low"` with ~4000 max_tokens so the
 *     thinking does not eat the reply;
 *   • Opus 5 thinks by default: effort "low", ~4000 max_tokens;
 *   • Sonnet 5 accepts `thinking: {type: "disabled"}` — a 700-token JSON
 *     reply with adaptive thinking on could be cut off mid-object;
 *   • Haiku 4.5 takes neither (effort errors there; no thinking by default);
 *   • structured output is `output_config.format` ({type: "json_schema"}),
 *     not the deprecated `output_format`.
 */
export function anthropicBody(model: string, system: string, userPrompt: string, o: CallOpts = {}): Record<string, unknown> {
  const base = o.maxTokens ?? 700;
  const body: Record<string, unknown> = { model, max_tokens: base, system, messages: [{ role: 'user', content: userPrompt }] };
  const output: Record<string, unknown> = {};
  if (/^claude-opus-5-5/.test(model)) {
    body.max_tokens = Math.max(4000, base);
    output.effort = 'low';
  } else if (/^claude-opus-5(?![-.]?\d)/.test(model)) {
    body.max_tokens = Math.max(4000, base);
    output.effort = 'low';
  } else if (/^claude-sonnet-5(?![-.]?\d)/.test(model)) {
    body.thinking = { type: 'disabled' };
  }
  if (o.schema) output.format = { type: 'json_schema', schema: o.schema };
  if (Object.keys(output).length) body.output_config = output;
  return body;
}

/**
 * The OpenAI request body. The GPT-5 family (and the o-series) reason: they
 * take `max_completion_tokens` (room for the reasoning too) and no
 * `temperature` — UNVERIFIED against a real key (design §7 notes the GPT-5
 * 400 this avoids); one call settles it. Older chat models keep the shape
 * that worked. A schema asks for strict json_schema output.
 */
export function openaiBody(model: string, system: string, userPrompt: string, o: CallOpts = {}): Record<string, unknown> {
  const base = o.maxTokens ?? 700;
  const reasoning = /^(gpt-5|o\d)/i.test(model);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    response_format: o.schema ? { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: o.schema } } : { type: 'json_object' },
  };
  if (reasoning) {
    body.max_completion_tokens = Math.max(4000, base);
    body.reasoning_effort = 'low';
  } else {
    body.temperature = 0.4;
    body.max_tokens = base;
  }
  return body;
}

async function callOpenAI(key: string, model: string, userPrompt: string, system = AI_SYSTEM_PROMPT, o: CallOpts = {}): Promise<CallResult> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(openaiBody(model, system, userPrompt, o)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await safeErr(res);
    return { ok: false, text: '', message: `OpenAI ${res.status}: ${detail}`, usage: null, stop: null, reached: false };
  }
  const body = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const u = body.usage;
  const usage = u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' ? { input: u.prompt_tokens, output: u.completion_tokens } : null;
  const c = body.choices?.[0];
  if (c?.message?.refusal) return { ok: false, text: '', message: 'The model declined to answer (refusal).', usage, stop: 'refusal', reached: true };
  if (c?.finish_reason === 'length') return { ok: false, text: '', message: 'The reply was cut off at the token limit.', usage, stop: 'max_tokens', reached: true };
  const text = c?.message?.content ?? '';
  return { ok: !!text, text, message: text ? 'ok' : 'empty response', usage, stop: c?.finish_reason ?? null, reached: true };
}

async function callAnthropic(key: string, model: string, userPrompt: string, system = AI_SYSTEM_PROMPT, o: CallOpts = {}): Promise<CallResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody(model, system, userPrompt, o)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await safeErr(res);
    return { ok: false, text: '', message: `Anthropic ${res.status}: ${detail}`, usage: null, stop: null, reached: false };
  }
  const body = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  const u = body.usage;
  const usage =
    u && typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number'
      ? { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens }
      : null;
  // Check the stop reason BEFORE reading the content (claude-api reference):
  // a refusal can carry partial text, and a reply cut at max_tokens is a
  // half JSON object — neither is an answer.
  if (body.stop_reason === 'refusal') return { ok: false, text: '', message: 'The model declined to answer (refusal).', usage, stop: 'refusal', reached: true };
  if (body.stop_reason === 'max_tokens') return { ok: false, text: '', message: 'The reply was cut off at the token limit.', usage, stop: 'max_tokens', reached: true };
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return { ok: !!text, text, message: text ? 'ok' : 'empty response', usage, stop: body.stop_reason ?? null, reached: true };
}

async function safeErr(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } };
      return (j.error?.message ?? t).slice(0, 200);
    } catch {
      return t.slice(0, 200);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}
