import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import type { AiProvider } from '@shared/ai';
import { redactToken } from '@shared/bots';
import { Card, GhostButton, PrimaryButton } from '../common';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';

// AI settings — provider choice and the two keys.
//
// The key follows the same rule as the bot token and the Helius key: stored
// locally, shown only redacted once set, and stripped from any recording. Off
// is the default; nothing is sent anywhere until the user analyses a token.

const PROVIDERS: Array<{ id: 'off' | AiProvider; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
];

function KeyRow({
  provider,
  label,
  keyValue,
  model,
  defaultModel,
  onSaveKey,
  onRemoveKey,
  onModel,
}: {
  provider: AiProvider;
  label: string;
  keyValue: string;
  model: string;
  defaultModel: string;
  onSaveKey: (k: string) => void;
  onRemoveKey: () => void;
  onModel: (m: string) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const verify = async (): Promise<void> => {
    setBusy(true);
    const r = await window.krypt.ai.verify(provider, keyValue, model || defaultModel);
    setBusy(false);
    if (r.ok) toast.success(`${label} key works`);
    else toast.error(r.message);
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-note font-semibold text-white">{label}</span>
        {keyValue && (
          <span className="font-mono text-label text-krypt-muted" title="Your key is never shown in full">
            {redactToken(keyValue)}
          </span>
        )}
      </div>

      {keyValue ? (
        <div className="flex items-center gap-2">
          <GhostButton onClick={() => void verify()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Test key
          </GhostButton>
          <GhostButton onClick={onRemoveKey} destructive>
            <XCircle className="h-3.5 w-3.5" /> Remove key
          </GhostButton>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`${label} API key`}
            spellCheck={false}
            type="password"
            className="flex-1 rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-body text-white outline-none focus:border-krypt-purple/60"
          />
          <PrimaryButton
            onClick={() => {
              const k = draft.trim();
              if (!k) return;
              onSaveKey(k);
              setDraft('');
            }}
            disabled={!draft.trim()}
          >
            Save
          </PrimaryButton>
        </div>
      )}

      <label className="block text-label uppercase tracking-wider text-krypt-muted/60">Model</label>
      <input
        value={model}
        onChange={(e) => onModel(e.target.value)}
        placeholder={defaultModel}
        spellCheck={false}
        className="w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-body text-white outline-none focus:border-krypt-purple/60"
      />
    </div>
  );
}

export function AiSettingsPanel({
  settings,
  onSettings,
}: {
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const ai = settings.ai;
  const patch = (p: Partial<AppSettings['ai']>): void => onSettings({ ai: { ...ai, ...p } });

  return (
    <Card className="space-y-3">
      <p className="text-body leading-relaxed text-krypt-muted">
        Plug in your own OpenAI or Anthropic key and get a model&apos;s read on a token from the token page&apos;s
        <span className="text-white"> AI</span> tab — a score and a short take. It is a second opinion on the same
        on-chain facts the app already shows, <span className="text-white">not financial advice</span>. Off by default;
        each analysis uses your own API credits, and only public token facts are sent to the provider you choose.
      </p>

      <div className="flex items-center gap-1">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => patch({ provider: p.id })}
            className={cls(
              'rounded-md px-3 py-1.5 text-body font-semibold transition',
              ai.provider === p.id ? 'bg-white/8 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {ai.provider !== 'off' && (
        <div className="grid sm:grid-cols-2 gap-3">
          <KeyRow
            provider="openai"
            label="OpenAI"
            keyValue={ai.openaiKey}
            model={ai.openaiModel}
            defaultModel="gpt-4o-mini"
            onSaveKey={(k) => patch({ openaiKey: k })}
            onRemoveKey={() => patch({ openaiKey: '' })}
            onModel={(m) => patch({ openaiModel: m })}
          />
          <KeyRow
            provider="anthropic"
            label="Anthropic"
            keyValue={ai.anthropicKey}
            model={ai.anthropicModel}
            defaultModel="claude-sonnet-5"
            onSaveKey={(k) => patch({ anthropicKey: k })}
            onRemoveKey={() => patch({ anthropicKey: '' })}
            onModel={(m) => patch({ anthropicModel: m })}
          />
        </div>
      )}
    </Card>
  );
}
