// Auto-callout — post a pump.fun callout on the coins you buy.
//
// A callout is a public statement under your name that other people trade
// against, and pump pays callers out of the volume a call brings in. So this
// page is deliberately explicit about what goes out and when: the text is
// yours, written in full, and nothing is posted until it is switched on.
//
// What pump allows is not ours to decide and is not guessed at here. Its own
// eligibility check runs before every post: you must hold the coin, there are
// three attempts per coin, and there is a cooldown. A refusal is reported in
// the Console rather than retried.

import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import {
  CALLOUT_VARS,
  MAX_THESES,
  MIN_CALLOUT_POSITION_USD,
  THESIS_BUDGET,
  REPLY_BUDGET,
  CALLOUT_WATERMARK,
  autoCalloutProblem,
  thesesOf,
  withCalloutWatermark,
  type AutoCalloutSettings,
  type CalloutOutcome,
} from '@shared/calloutAuto';
import { Card, NumberInput, Page, PrimaryButton, Section, Switch, TextInput } from '../components/common';
import { RunnerWebhook } from '../components/terminal/RunnerWebhook';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { cls } from '../utils/format';
import type { PumpAuthStatus } from '@shared/pumpAuth';

export function AutoCalloutPage() {
  const { settings, updateSettings, refreshSettings } = useAppState();
  const toast = useToast();
  const [draft, setDraft] = useState<AutoCalloutSettings>(settings.autoCallout);
  const [pump, setPump] = useState<PumpAuthStatus | null>(null);
  // The test post. Its own fields, deliberately separate from the settings
  // above: this posts one real callout now, and it must not be possible to do
  // it by accident while editing the list.
  const [testWallet, setTestWallet] = useState('');
  const [testMint, setTestMint] = useState('');
  const [testText, setTestText] = useState('');
  const [posting, setPosting] = useState(false);
  const [outcome, setOutcome] = useState<CalloutOutcome | null>(null);
  // Call or reply. A callout is ONE per coin per account and there is no edit,
  // so once one exists the only thing left to send is a reply — and which of
  // the two this is has to be obvious BEFORE the button is pressed, not
  // discovered from a refusal afterwards.
  const [mode, setMode] = useState<'call' | 'reply'>('call');

  useEffect(() => setDraft(settings.autoCallout), [settings.autoCallout]);
  useEffect(() => {
    void window.krypt.pump.status().then((r) => {
      if (r.ok && r.data) setPump(r.data);
    });
  }, []);

  const lines = thesesOf(draft.text);
  const problem = autoCalloutProblem(draft);
  const accounts = pump?.sessions.length ?? 0;

  const postTest = async (): Promise<void> => {
    setPosting(true);
    setOutcome(null);
    try {
      const r =
        mode === 'reply'
          ? await window.krypt.pump.calloutReply(testWallet, testMint.trim(), testText.trim())
          : await window.krypt.pump.callout(testWallet, testMint.trim(), testText.trim());
      // Shown in full either way. A refusal from pump is the useful half of a
      // test — it proves the preflight is being asked and obeyed — so it is
      // reported here rather than swallowed into a red toast.
      setOutcome(r.data ?? { ok: r.ok, message: r.message });
      if (r.ok) toast.success(r.message);
    } finally {
      setPosting(false);
    }
  };

  // The webhook saves on its own (Save / Change / remove on the card), and
  // through the DRAFT: every other save on this page sends the whole draft,
  // so a webhook saved around it would be put back to its old value by the
  // next Save — the rebuild-drops-fields trap in another shape.
  const saveWebhook = async (discordWebhookUrl: string): Promise<boolean> => {
    const next = { ...draft, discordWebhookUrl };
    const why = autoCalloutProblem(next);
    if (why) {
      toast.error(why);
      return false;
    }
    // Straight to the IPC rather than updateSettings, which toasts a refusal
    // but does not report it — the card needs to know, or it says "saved"
    // over a URL main refused.
    const r = await window.krypt.settings.update({ autoCallout: next });
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    setDraft(next);
    await refreshSettings();
    return true;
  };

  const save = async (next: AutoCalloutSettings): Promise<void> => {
    const why = autoCalloutProblem(next);
    if (why) {
      toast.error(why);
      return;
    }
    setDraft(next);
    await updateSettings({ autoCallout: next });
  };

  return (
    <Page
      title="Auto-callout"
      subtitle="Post a pump.fun callout on the coins you buy, from the account belonging to the wallet that bought."
    >
      {accounts === 0 && (
        <Section title="No pump.fun account">
          <Card>
            <p className="text-body leading-relaxed text-krypt-muted">
              A callout is posted by the wallet that bought, so that wallet needs a pump.fun account. Make one on the
              Wallet page under <span className="text-white">pump.fun accounts</span>.
            </p>
          </Card>
        </Section>
      )}

      <Section
        title="When to call"
        description={`Every buy from a wallet that has a pump.fun account. pump decides whether each one is allowed — the position must be worth at least $${MIN_CALLOUT_POSITION_USD}, there are three attempts per coin, and there is a cooldown between posts.`}
      >
        <Card className="space-y-3">
          <Switch
            checked={draft.enabled}
            onChange={(v) => void save({ ...draft, enabled: v })}
            label="Call out what I buy"
            description={
              lines.length === 0
                ? 'Write at least one line below first — a callout with nothing on it is not worth making.'
                : `${lines.length} line${lines.length === 1 ? '' : 's'} to choose from, one picked at random per coin.`
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-krypt-muted">Skip buys under</span>
            <NumberInput value={draft.minBuySol} onChange={(v) => setDraft({ ...draft, minBuySol: v })} step={0.01} min={0} max={100} />
            <span className="text-body text-krypt-muted">SOL</span>
            <span className="text-label text-krypt-muted/70">
              {draft.minBuySol > 0 ? 'Smaller buys are not called.' : 'Every buy is called.'}
            </span>
          </div>
          <p className="text-label leading-relaxed text-krypt-muted/70">
            Not a pump limit — it is here because the payout tracks the volume your calls bring in, and calling every
            scratch trade spends the standing that earns it.
          </p>
          <Switch
            checked={draft.likeOwn}
            onChange={(v) => void save({ ...draft, likeOwn: v })}
            label="Like your own callouts"
            description="The account that posted a callout likes it straight after. Applies to every callout the app posts: on a buy, from a script, or the test below."
          />
          <div className="border-t border-white/8 pt-3">
            <Switch
              checked={draft.onLaunch}
              onChange={(v) => void save({ ...draft, onLaunch: v })}
              label="Call out coins I launch"
              description="After you launch a coin, post a callout from the launch wallet — a short delay later, so the coin has a moment and pump keeps the call. Uses the lines below."
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-body text-krypt-muted">Only if the dev buy is worth over</span>
              <NumberInput value={draft.launchMinUsd} onChange={(v) => setDraft({ ...draft, launchMinUsd: v })} step={1} min={0} max={100000} />
              <span className="text-body text-krypt-muted">USD</span>
              <span className="text-label text-krypt-muted/70">
                {draft.launchMinUsd > 0 ? `Smaller launches are not called.` : 'Every launch is called (pump still needs the coin worth $1).'}
              </span>
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="What to say"
        description="One line per variant. A random one is used for each coin, so your calls do not all read identically — the same sentence every time is a signature, and a caller people mute earns nothing."
      >
        <Card className="space-y-2">
          <textarea
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            rows={8}
            placeholder={'Runner\nEarly on this one\nLike the chart here\nDev looks real'}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
          />
          {/* The fill-in variables, so people know they can use them. Same
              set as the Scripts page's callout lines (CALLOUT_VARS). Click one
              to drop it at the end of the box. */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
            <p className="mb-1.5 text-label text-krypt-muted/80">
              Put any of these in a line and the coin’s real numbers fill in. A value the app doesn’t know shows as “—”, never a fake 0.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {CALLOUT_VARS.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={v.means}
                  onClick={() => setDraft({ ...draft, text: `${draft.text}${draft.text && !draft.text.endsWith('\n') && !draft.text.endsWith(' ') ? ' ' : ''}{${v.name}}` })}
                  className="rounded-md border border-white/10 bg-black/30 px-2 py-0.5 font-mono text-label text-krypt-purple transition hover:border-krypt-purple/50 hover:text-white"
                >
                  {`{${v.name}}`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cls('text-label', lines.length > MAX_THESES ? 'text-arc-gold' : 'text-krypt-muted')}>
              {lines.length} of {MAX_THESES} lines · {THESIS_BUDGET} characters each
            </span>
            <div className="flex-1" />
            <PrimaryButton onClick={() => void save(draft)} disabled={!!problem}>
              <Megaphone className="h-4 w-4" /> Save
            </PrimaryButton>
          </div>
          {problem && <p className="text-body text-rose-300">{problem}</p>}
          {/* Shown, not hidden. A callout posted the instant a buy confirms is
              not the same thing as one someone sat down and wrote, and a reader
              deciding whether to trade on it deserves to know which it is. */}
          <p className="text-label leading-relaxed text-krypt-muted/70">
            Every one ends with a short Krypto Bot credit line — <span className="text-krypt-muted">“{CALLOUT_WATERMARK}”</span> and
            a few variations, rotated so your posts aren't identical — so anyone reading it knows it was posted
            automatically rather than written in the moment.
          </p>
          {lines.length > 0 && (
            <p className="text-label leading-relaxed text-krypt-muted/70">
              These are public, under your wallet's name, and pump shows your position in the coin beside each one.
              Write them as you would write them yourself.
            </p>
          )}
        </Card>
      </Section>

      <RunnerWebhook
        chain="solana"
        chainLabel="Solana"
        webhookUrl={draft.discordWebhookUrl}
        onSave={saveWebhook}
        title="Post your callouts to Discord"
        description="Every callout this page posts — on a buy, or with the button below — also goes to this Discord channel as an embed: the coin, your words, a link to the callout, market cap, holders, buyers and curve. Outbound only; no wallet or position data is sent."
        savedMessage="Your callouts will be posted to Discord."
        clearedMessage="Stopped posting callouts to Discord."
        onTest={async () => {
          const r = await window.krypt.pump.testCalloutWebhook(testMint.trim() || undefined);
          return { ok: r.ok, message: r.message };
        }}
      />

      {accounts > 0 && (
        <Section
          title="Post one now"
          description="A real, public callout on a coin that wallet already holds — the way to see the whole thing work end to end before switching anything on. Nothing here is scheduled and nothing is retried."
        >
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(['call', 'reply'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setOutcome(null);
                  }}
                  className={cls(
                    'rounded-md border px-2.5 py-1 text-label font-semibold transition',
                    mode === m ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                  )}
                >
                  {m === 'call' ? 'New callout' : 'Reply to my callout'}
                </button>
              ))}
              <span className="text-label text-krypt-muted/70">
                {mode === 'call'
                  ? 'One per coin, per account.'
                  : 'Updates the call that account already made — it appends rather than rewriting, and re-bumps the callout.'}
              </span>
            </div>
            <div className="space-y-1">
              <span className="text-label text-krypt-muted">Post as</span>
              <select
                value={testWallet}
                onChange={(e) => setTestWallet(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
              >
                <option value="">Pick an account…</option>
                {(pump?.sessions ?? []).map((sess) => (
                  <option key={sess.walletId} value={sess.walletId}>
                    {sess.username ?? `${sess.address.slice(0, 8)}…`}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <span className="text-label text-krypt-muted">Token</span>
              <TextInput value={testMint} onChange={setTestMint} placeholder="Mint address of a coin that wallet holds" />
            </div>
            <div className="space-y-1">
              <span className="text-label text-krypt-muted">What it will say</span>
              <TextInput value={testText} onChange={setTestText} placeholder="Runner" mono={false} />
              {testText.trim() && (
                <p className="text-label leading-relaxed text-krypt-muted/70">
                  Goes out as{' '}
                  <span className="text-white">
                    “{withCalloutWatermark(testText.trim().slice(0, mode === 'reply' ? REPLY_BUDGET : THESIS_BUDGET))}”
                  </span>
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton
                onClick={() => void postTest()}
                disabled={posting || !testWallet || !testMint.trim() || !testText.trim()}
              >
                <Megaphone className="h-4 w-4" />{' '}
                {posting ? 'Posting…' : mode === 'reply' ? 'Post this reply' : 'Post this callout'}
              </PrimaryButton>
              <span className="text-label text-krypt-muted/70">
                Public, under that wallet's name.{' '}
                {mode === 'call'
                  ? `pump needs the position to be worth at least $${MIN_CALLOUT_POSITION_USD}.`
                  : 'That account must already have called this coin, and pump’s reply cooldown applies.'}
              </span>
            </div>
            {outcome && (
              <div className="space-y-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                <p className={cls('text-body', outcome.ok ? 'text-emerald-300' : 'text-rose-300')}>{outcome.message}</p>
                {outcome.thesis && (
                  <p className="text-label text-krypt-muted">
                    {outcome.ok ? 'Posted' : 'Would have posted'}: “{outcome.thesis}”
                  </p>
                )}
                {/* pump's own verdict, in pump's words. A refusal here is
                    ordinary — three attempts per coin, a cooldown, a position
                    under a dollar — and is worth reading rather than retrying. */}
                {outcome.verdict && <p className="text-label text-krypt-muted/70">pump says: {outcome.verdict}</p>}
              </div>
            )}
          </Card>
        </Section>
      )}
    </Page>
  );
}
