import { useCallback, useEffect, useState } from 'react';
import { Check, Link2, Loader2, Send, ShieldAlert, Unlink } from 'lucide-react';
import { looksLikeToken, redactToken, type BotKind } from '@shared/bots';
import type { AppSettings } from '@shared/types';
import { Card, GhostButton, NumberInput, PrimaryButton, Switch } from '../common';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';

// Telegram / Discord bots.
//
// The pairing flow is the point of this panel. You bring your own bot, so the
// app cannot know who you are on that platform — it shows a code, you send it
// from the account you want served, and the bot records THAT sender as its
// only owner. Nobody else is answered afterwards, and never with an error
// message, because a refusal still tells a stranger the bot is real.
//
// The bots are READ-ONLY. That is stated here rather than left implied: this
// app can move money, and a chat command that could trade would sit outside
// the arming model entirely.

interface BotStatusRow {
  kind: BotKind;
  enabled: boolean;
  running: boolean;
  paired: boolean;
  tokenPresent: boolean;
  pairingActive: boolean;
  lastError: string | null;
}

const SETUP: Record<BotKind, { title: string; steps: string[] }> = {
  telegram: {
    title: 'Telegram',
    steps: [
      'Message @BotFather and send /newbot',
      'Copy the token it gives you and paste it below',
      'Open a chat with your new bot and press Start',
    ],
  },
  discord: {
    title: 'Discord',
    steps: [
      'Discord Developer Portal → New Application → Bot → Reset Token',
      'On the same Bot page, switch ON the MESSAGE CONTENT intent',
      'Paste the token below, then DM the bot',
    ],
  },
};

function BotRow({
  kind,
  settings,
  status,
  onSettings,
  onRefresh,
}: {
  kind: BotKind;
  settings: AppSettings;
  status: BotStatusRow | undefined;
  onSettings: (patch: Partial<AppSettings>) => void;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const cfg = settings.bots[kind];
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const patchBot = (patch: Partial<typeof cfg>): void => {
    onSettings({ bots: { ...settings.bots, [kind]: { ...cfg, ...patch } } });
  };

  const saveToken = async (): Promise<void> => {
    const t = token.trim();
    if (!looksLikeToken(kind, t)) {
      toast.warn(`That does not look like a ${SETUP[kind].title} bot token.`);
      return;
    }
    setBusy(true);
    const r = await window.krypt.bots.verify(kind, t);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    patchBot({ token: t, enabled: true });
    setToken('');
    toast.success(r.message);
    setTimeout(onRefresh, 500);
  };

  const startPairing = async (): Promise<void> => {
    const r = await window.krypt.bots.pair(kind);
    if (r.ok && r.data) {
      setCode(r.data.code);
      onRefresh();
    } else toast.error(r.message);
  };

  const unpair = async (): Promise<void> => {
    const r = await window.krypt.bots.unpair(kind);
    setCode(null);
    if (r.ok) toast.success('Unpaired');
    onRefresh();
  };

  return (
    <Card>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-display text-note font-semibold uppercase tracking-label text-white">
          {SETUP[kind].title}
        </span>
        {status?.paired ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-emerald-300">
            <Check className="h-3 w-3" /> paired
          </span>
        ) : cfg.token ? (
          <span className="rounded-full border border-arc-gold/30 bg-arc-gold/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-arc-gold">
            not paired
          </span>
        ) : null}
        {status?.running && (
          <span className="rounded-full border border-krypt-purple/30 bg-krypt-purple/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-krypt-pink">
            connected
          </span>
        )}
        <div className="flex-1" />
        {cfg.token && (
          <span className="font-mono text-label text-krypt-muted" title="Your token is never shown in full">
            {redactToken(cfg.token)}
          </span>
        )}
      </div>

      {!cfg.token ? (
        <div className="mt-2 space-y-2">
          <ol className="list-decimal pl-4 text-body leading-relaxed text-krypt-muted space-y-0.5">
            {SETUP[kind].steps.map((st) => (
              <li key={st}>{st}</li>
            ))}
          </ol>
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Bot token"
              className="flex-1 rounded bg-black/40 border border-white/15 px-2 py-1 font-mono text-body text-white outline-none"
            />
            <PrimaryButton onClick={() => void saveToken()} disabled={busy || !token.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Verify & save'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {!status?.paired && (
            <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2">
              {code ? (
                <>
                  <p className="text-body text-krypt-muted">
                    Send this to your bot from the account that should control it:
                  </p>
                  <p className="mt-1 font-mono text-xl tracking-heading text-white">/pair {code}</p>
                  <p className="mt-1 text-label text-krypt-muted/60">
                    Valid for 10 minutes. Whoever sends it becomes the only account this bot answers.
                  </p>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <GhostButton onClick={() => void startPairing()}>
                    <Link2 className="h-3.5 w-3.5" /> Start pairing
                  </GhostButton>
                  <span className="text-label text-krypt-muted">Generates a code to send to your bot</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Switch
              checked={cfg.enabled}
              onChange={(v) => patchBot({ enabled: v })}
              label="Enabled"
              description="Connect and answer commands"
            />
            <Switch
              checked={cfg.pushAlerts}
              onChange={(v) => patchBot({ pushAlerts: v })}
              label="Push alerts"
              description="Send price alerts to the chat"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {status?.paired && (
              <>
                <GhostButton
                  onClick={async () => {
                    const r = await window.krypt.bots.test(kind);
                    if (r.ok) toast.success(r.message);
                    else toast.error(r.message);
                  }}
                >
                  <Send className="h-3.5 w-3.5" /> Send test
                </GhostButton>
                <GhostButton onClick={() => void unpair()} destructive>
                  <Unlink className="h-3.5 w-3.5" /> Unpair
                </GhostButton>
              </>
            )}
            <GhostButton onClick={() => patchBot({ token: '', enabled: false, ownerId: null })} destructive>
              Remove token
            </GhostButton>
          </div>

          {status?.lastError && <p className="text-body text-rose-300">{status.lastError}</p>}
        </div>
      )}
    </Card>
  );
}

/**
 * Trading from chat. Its own card, above the bots, because switching it on is
 * a security decision rather than a preference: it turns a chat account into
 * something that can spend from the wallet on this machine.
 */
function TradingCard({
  settings,
  onSettings,
}: {
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const tr = settings.bots.trading;
  const patch = (p: Partial<typeof tr>): void => onSettings({ bots: { ...settings.bots, trading: { ...tr, ...p } } });

  return (
    <Card className={cls('space-y-3', tr.enabled && 'border-arc-gold/40')}>
      <div className="flex items-start gap-3">
        <ShieldAlert className={cls('mt-0.5 h-4 w-4 flex-shrink-0', tr.enabled ? 'text-arc-gold' : 'text-krypt-muted')} />
        <div className="flex-1">
          <div className="text-value font-semibold text-white">Trade from your phone</div>
          <p className="mt-1 text-body leading-relaxed text-krypt-muted">
            Lets the paired chat place trades: <span className="font-mono text-white/80">/sell &lt;mint&gt; 50</span> or{' '}
            <span className="font-mono text-white/80">/buy &lt;mint&gt; 0.05</span>. Your key never leaves this machine —
            the chat asks, this app signs. Anyone who takes over that chat account can trade with it, which is why buys
            are separate, capped, and every trade needs a one-time code.
          </p>
        </div>
      </div>

      <Switch
        checked={tr.enabled}
        onChange={(v) => patch({ enabled: v, allowBuys: v ? tr.allowBuys : false })}
        label="Allow trading from chat"
        description={tr.enabled ? 'Selling is allowed. /lock turns this off from the phone.' : 'Off — the bots are read-only'}
      />

      {tr.enabled && (
        <div className="space-y-3 border-t border-white/8 pt-3">
          <Switch
            checked={tr.allowBuys}
            onChange={(v) => patch({ allowBuys: v })}
            label="Allow buying too"
            description="Selling only closes a position you already have. Buying can spend the wallet, so it is separate."
          />
          <Switch
            checked={tr.requireConfirm}
            onChange={(v) => patch({ requireConfirm: v })}
            label="Require a confirmation code"
            description="The bot quotes the trade and waits for /yes <code>. Leave this on unless you have a reason."
          />
          {tr.allowBuys && (
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-body text-krypt-muted">
                Max per buy
                <NumberInput value={tr.maxBuySol} min={0.001} max={100} onChange={(n) => patch({ maxBuySol: n })} suffix="SOL" className="w-28" />
              </label>
              <label className="flex items-center gap-2 text-body text-krypt-muted">
                Max per hour
                <NumberInput value={tr.hourlyCapSol} min={0.001} max={1000} onChange={(n) => patch({ hourlyCapSol: n })} suffix="SOL" className="w-28" />
              </label>
            </div>
          )}
          {!tr.requireConfirm && (
            <div className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-body text-rose-200">
              With confirmation off, a single message from that chat trades immediately. One compromised account is
              enough.
            </div>
          )}
          <p className="text-label leading-relaxed text-krypt-muted/60">
            Every chat trade is logged, shown on this desktop as it happens, and still passes the same arming, loss
            guard and per-trade cap as a click here. Selling is never rationed by these limits — being unable to exit is
            the worse failure.
          </p>
        </div>
      )}
    </Card>
  );
}

export function BotsPanel({
  settings,
  onSettings,
}: {
  settings: AppSettings;
  onSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [rows, setRows] = useState<BotStatusRow[]>([]);

  const refresh = useCallback(async () => {
    const r = await window.krypt.bots.status();
    if (r.ok && r.data) setRows(r.data as BotStatusRow[]);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="space-y-3">
      <p className={cls('text-body leading-relaxed text-krypt-muted')}>
        Bring your own bot. The app shows a pairing code, you send it from the account that should control the bot, and
        that account becomes the only one it answers — anyone else is ignored silently.{' '}
        <span className="text-white/80">
          A bot can never move SOL to another address, change your settings, or arm live execution.
        </span>
      </p>

      <TradingCard settings={settings} onSettings={onSettings} />
      <div className="grid lg:grid-cols-2 gap-3">
        {(['telegram', 'discord'] as BotKind[]).map((kind) => (
          <BotRow
            key={kind}
            kind={kind}
            settings={settings}
            status={rows.find((r) => r.kind === kind)}
            onSettings={onSettings}
            onRefresh={() => void refresh()}
          />
        ))}
      </div>
    </div>
  );
}
