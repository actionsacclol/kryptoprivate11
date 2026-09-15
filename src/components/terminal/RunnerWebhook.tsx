// "Post runner flags to Discord" — one card, used by every chain's Runners
// tab (Solana's page and EvmRunnersSection both render it).
//
// It lives on the Runners tab rather than buried in Settings because that is
// where someone decides they want these pushed somewhere, and because the URL
// is PER CHAIN: Solana flags and BNB flags usually belong in different
// channels, and a single global field would quietly merge them.
//
// The URL is a credential — its path segment is the webhook token — so it is
// never rendered back in full once saved. The field shows a redacted form and
// a Change button, the same way a saved API key behaves.

import { useEffect, useState } from 'react';
import { Check, Send, Trash2 } from 'lucide-react';
import { Card, GhostButton, Section, TextInput } from '../common';
import { useToast } from '../../state/ToastProvider';
import type { ChainKind } from '@shared/evm';
// The SAME rule the IPC boundary enforces — imported, not re-implemented, so
// the message a user sees while typing cannot drift from the one that
// actually decides whether the save is accepted.
import { redactWebhook, webhookUrlProblem } from '@shared/webhook';


export function RunnerWebhook({
  chain,
  chainLabel,
  webhookUrl,
  onSave,
}: {
  chain: ChainKind;
  chainLabel: string;
  /** What is stored right now. Empty = off. */
  webhookUrl: string;
  /** Persist it. Rejects with a message the caller has already toasted. */
  onSave: (url: string) => Promise<boolean>;
}) {
  const toast = useToast();
  const saved = (webhookUrl ?? '').trim();
  const [editing, setEditing] = useState(saved === '');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);

  // A chain switch is a different webhook: never leave one chain's draft in
  // the box while the card is labelled with another's.
  useEffect(() => {
    setDraft('');
    setEditing((webhookUrl ?? '').trim() === '');
  }, [chain, webhookUrl]);

  const problem = webhookUrlProblem(draft);

  const save = async (): Promise<void> => {
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy('save');
    try {
      if (await onSave(draft.trim())) {
        setDraft('');
        setEditing(false);
        toast.success(`${chainLabel} runner flags will be posted to Discord.`);
      }
    } finally {
      setBusy(null);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy('clear');
    try {
      if (await onSave('')) {
        setDraft('');
        setEditing(true);
        toast.success(`Stopped posting ${chainLabel} flags to Discord.`);
      }
    } finally {
      setBusy(null);
    }
  };

  // A webhook nobody has tested is a webhook nobody knows is working — and
  // the failure mode is silence, which is indistinguishable from "no flags
  // yet". One click proves the round trip.
  const test = async (): Promise<void> => {
    setBusy('test');
    try {
      const r = await window.krypt.runners.testWebhook(chain);
      r.ok ? toast.success(r.message) : toast.error(r.message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Post flags to Discord"
      description={`Every ${chainLabel} flag that raises a desktop notification is also posted to this webhook, with a link to the token. Outbound only — nothing reads your server, and no wallet or position data is ever sent. The per-hour limit above applies to both.`}
    >
      <Card className="space-y-3">
        {!editing && saved ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-body text-emerald-300">
              <Check className="h-3 w-3" />
              Posting to {redactWebhook(saved)}
            </span>
            <span className="flex-1" />
            <GhostButton onClick={() => void test()} disabled={busy !== null} className="!py-1.5 !px-2.5 text-body">
              <Send className="h-3 w-3" />
              {busy === 'test' ? 'Sending…' : 'Send test'}
            </GhostButton>
            <GhostButton onClick={() => setEditing(true)} disabled={busy !== null} className="!py-1.5 !px-2.5 text-body">
              Change
            </GhostButton>
            <button
              onClick={() => void clear()}
              disabled={busy !== null}
              title="Stop posting flags to Discord"
              className="text-krypt-muted/60 transition hover:text-rose-300 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <TextInput
              value={draft}
              onChange={setDraft}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <div className="flex flex-wrap items-center gap-2">
              <GhostButton onClick={() => void save()} disabled={busy !== null || draft.trim() === ''} className="!py-1.5 !px-2.5 text-body">
                {busy === 'save' ? 'Saving…' : 'Save webhook'}
              </GhostButton>
              {saved && (
                <GhostButton
                  onClick={() => {
                    setDraft('');
                    setEditing(false);
                  }}
                  disabled={busy !== null}
                  className="!py-1.5 !px-2.5 text-body"
                >
                  Cancel
                </GhostButton>
              )}
              <span className="flex-1" />
              <span className="text-label text-krypt-muted/70">
                Discord → your channel → Edit Channel → Integrations → Webhooks → Copy URL
              </span>
            </div>
            {problem && <p className="text-body text-rose-300/90">{problem.charAt(0).toUpperCase() + problem.slice(1)}.</p>}
          </>
        )}
      </Card>
    </Section>
  );
}
