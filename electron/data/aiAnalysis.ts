// AI analysis — the HTTP side. Main-process only.
//
// The key never leaves this process. The renderer asks for an analysis by mint;
// the engine assembles the PUBLIC on-chain facts and this module sends them to
// the chosen provider with the user's own key. What crosses the wire to OpenAI
// or Anthropic is exactly the facts block (disclosed in the privacy policy) —
// never the wallet, never any key but the one for that provider.

import {
  AI_SYSTEM_PROMPT,
  buildFacts,
  parseAnalysis,
  type AiAnalysis,
  type AiProvider,
  type AiSettings,
} from '@shared/ai';
import type { TokenDetail, TokenSummary } from '@shared/market';
import { KRYPTO_AI_SYSTEM_PROMPT } from '@shared/kryptoMode';

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
export async function askKrypto(ai: AiSettings, facts: string): Promise<{ ok: boolean; message: string; text?: string }> {
  const provider = activeProvider(ai);
  if (!provider) return { ok: false, message: 'No AI key is set (Settings → AI).' };
  const prompt = `Decide the bot's next move and reply with ONLY the JSON object described.

${facts}`;
  try {
    const r =
      provider === 'openai'
        ? await callOpenAI(ai.openaiKey.trim(), ai.openaiModel.trim() || 'gpt-4o-mini', prompt, KRYPTO_AI_SYSTEM_PROMPT)
        : await callAnthropic(ai.anthropicKey.trim(), ai.anthropicModel.trim() || 'claude-sonnet-5', prompt, KRYPTO_AI_SYSTEM_PROMPT);
    return r.ok ? { ok: true, message: 'ok', text: r.text } : { ok: false, message: r.message };
  } catch (err) {
    return { ok: false, message: `AI request failed: ${(err as Error).message}` };
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
}

async function callOpenAI(key: string, model: string, userPrompt: string, system = AI_SYSTEM_PROMPT): Promise<CallResult> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await safeErr(res);
    return { ok: false, text: '', message: `OpenAI ${res.status}: ${detail}` };
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? '';
  return { ok: !!text, text, message: text ? 'ok' : 'empty response' };
}

async function callAnthropic(key: string, model: string, userPrompt: string, system = AI_SYSTEM_PROMPT): Promise<CallResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await safeErr(res);
    return { ok: false, text: '', message: `Anthropic ${res.status}: ${detail}` };
  }
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return { ok: !!text, text, message: text ? 'ok' : 'empty response' };
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
