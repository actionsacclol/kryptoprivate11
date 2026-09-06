import { useEffect, useState } from 'react';
import { Bot, Loader2, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { scoreTone, type AiAnalysis } from '@shared/ai';
import { Card, PrimaryButton } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useAppState } from '../../state/AppStateProvider';
import { cls, fmtAge } from '../../utils/format';

// AI second opinion, on demand.
//
// It is off unless the user configured a key, and it never runs automatically —
// each analysis spends their API credits. The result is framed as exactly what
// it is: one model's read of the same facts the app already shows, NOT advice.

const toneClass: Record<ReturnType<typeof scoreTone>, string> = {
  unknown: 'text-krypt-muted',
  bad: 'text-rose-300',
  mid: 'text-arc-gold',
  good: 'text-emerald-300',
};

export function AiPanel({ mint, symbol }: { mint: string; symbol: string }) {
  const toast = useToast();
  const { settings } = useAppState();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiAnalysis | null>(null);

  const configured = settings.ai.provider !== 'off' &&
    ((settings.ai.provider === 'openai' && settings.ai.openaiKey.trim()) ||
      (settings.ai.provider === 'anthropic' && settings.ai.anthropicKey.trim()));

  // A previous analysis of this mint is cached in the main process for the
  // session, so switching tabs or leaving and coming back restores it for free
  // rather than re-spending API credits. Re-analyze (force) is the only path
  // that pays again.
  useEffect(() => {
    let live = true;
    setResult(null);
    void window.krypt.ai.cached(mint).then((r) => {
      if (live && r.ok && r.data) setResult(r.data);
    });
    return () => {
      live = false;
    };
  }, [mint]);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.ai.analyze(mint, force);
    setBusy(false);
    if (r.ok && r.data) setResult(r.data);
    else toast.error(r.message);
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-krypt-purple" />
        <span className="text-sm font-semibold text-white">AI analysis</span>
        {result && (
          <span className="text-[10px] text-krypt-muted/70">
            {result.provider} · {result.model} · {fmtAge(result.at)}
          </span>
        )}
        <div className="flex-1" />
        <PrimaryButton onClick={() => void run(!!result)} disabled={busy || !configured} className="!py-1.5 !px-3 text-xs">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {result ? 'Re-analyze' : `Analyze ${symbol || ''}`.trim()}
        </PrimaryButton>
      </div>

      {!configured && (
        <p className="text-[11px] text-krypt-muted leading-relaxed">
          Add an OpenAI or Anthropic API key in <span className="text-white">Settings → AI</span> to get a model&apos;s
          read on a token. Off by default; each analysis uses your own API credits.
        </p>
      )}

      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className={cls('font-mono text-2xl font-bold leading-none', toneClass[scoreTone(result.score)])}>
                {result.score === null ? '—' : result.score}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-krypt-muted/60 mt-1">AI score</div>
            </div>
            <div className="min-w-0 flex-1">
              <div className={cls('text-sm font-semibold', toneClass[scoreTone(result.score)])}>{result.verdict}</div>
              <p className="text-[11px] text-krypt-muted leading-relaxed mt-0.5">{result.summary}</p>
            </div>
          </div>

          {(result.bullish.length > 0 || result.bearish.length > 0) && (
            <div className="grid sm:grid-cols-2 gap-3">
              {result.bullish.length > 0 && (
                <div className="rounded-md border border-emerald-400/20 bg-emerald-500/[0.05] px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 mb-1">
                    <ThumbsUp className="h-3 w-3" /> For
                  </div>
                  <ul className="space-y-1">
                    {result.bullish.map((b, i) => (
                      <li key={i} className="text-[11px] text-krypt-muted leading-snug">• {b}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.bearish.length > 0 && (
                <div className="rounded-md border border-rose-400/20 bg-rose-500/[0.05] px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300 mb-1">
                    <ThumbsDown className="h-3 w-3" /> Against
                  </div>
                  <ul className="space-y-1">
                    {result.bearish.map((b, i) => (
                      <li key={i} className="text-[11px] text-krypt-muted leading-snug">• {b}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] text-krypt-muted/50 leading-relaxed">
            An AI&apos;s opinion on the same on-chain facts shown here — automated, often wrong, and NOT financial
            advice. Your token data was sent to {result.provider} to produce it.
          </p>
        </div>
      )}
    </Card>
  );
}
