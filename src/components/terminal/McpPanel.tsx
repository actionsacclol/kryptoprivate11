// The AI connection (MCP) panel. Moved out of Settings on 2026-09-23 into
// its own page under Automation, because nobody found it in Settings: an AI
// driving the app is a way of acting without clicking, which is what the
// Automation workspace is for. See docs/mcp-connection-2026-09-21.md.

import { useCallback, useEffect, useState } from 'react';
import { Card, Switch } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { cls } from '../../utils/format';
import { MCP_ACCESS_LEVELS, MCP_ACCESS_TEXT, type McpAccess } from '@shared/mcp';

/**
 * The AI connection.
 *
 * Ordered the way the decision is made: switch it on, choose how far it
 * reaches, copy the line that connects a client, then the limits — which only
 * matter once someone has chosen live. The access buttons are four, not a
 * toggle, because the difference between "it can look" and "it can spend your
 * money" should not be one click apart with the same shape.
 */
export function McpPanel() {
  const toast = useToast();
  const modal = useModal();
  const [panel, setPanel] = useState<{
    settings: { enabled: boolean; access: McpAccess; port: number; token: string; budget: { maxBuySol: number; hourlyCapSol: number; maxTradesPerMinute: number } };
    server: { running: boolean; port: number | null; sessions: number; lastClient: string | null; calls: number; refusals: number; message: string };
    command: string;
    json: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const read = useCallback(async () => {
    const r = await window.krypt.mcp.status();
    if (r.ok && r.data) setPanel(r.data);
  }, []);
  useEffect(() => {
    void read();
    // While it is listening the counters move as an agent works.
    const id = setInterval(() => void read(), 5_000);
    return () => clearInterval(id);
  }, [read]);

  const apply = async (fn: () => Promise<{ ok: boolean; message: string; data?: unknown }>): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      await read();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not reach the clipboard');
    }
  };

  /**
   * Going live is the one step that spends money, so it is confirmed in the
   * same words the rest of the app uses for arming something — and every
   * other level is applied without a dialog, because nothing else can cost
   * anything.
   */
  const setAccess = async (level: McpAccess): Promise<void> => {
    if (level === 'live') {
      const yes = await modal.confirm({
        title: 'Let an AI spend real funds?',
        message:
          'An AI assistant connected to this app will be able to buy and sell with your live wallet, on its own, within the limits below. It cannot withdraw, cannot change any setting and cannot sign anything itself — but it can trade, and a trade is real money. Nothing has measured an AI trading this app profitably.',
        confirmLabel: 'Allow live trading',
      });
      if (!yes) return;
    }
    await apply(() => window.krypt.mcp.setAccess(level));
  };

  if (!panel) return <Card className="text-note text-krypt-muted">Reading the connection…</Card>;
  const s = panel.settings;
  const live = s.access === 'live';

  return (
    <Card className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-note font-semibold text-white">{s.enabled ? (panel.server.running ? 'Listening' : 'On, but not listening') : 'Off'}</div>
          <p className="mt-0.5 text-label leading-relaxed text-krypt-muted">
            {s.enabled
              ? panel.server.running
                ? `On 127.0.0.1:${panel.server.port} — this machine only. ${panel.server.lastClient ? `Last client: ${panel.server.lastClient}. ` : ''}${panel.server.calls} call${panel.server.calls === 1 ? '' : 's'}${panel.server.refusals ? `, ${panel.server.refusals} refused` : ''}.`
                : panel.server.message || 'The port could not be opened.'
              : 'No port is open and no client can connect.'}
          </p>
        </div>
        <Switch checked={s.enabled} onChange={(v) => void apply(() => window.krypt.mcp.setEnabled(v))} disabled={busy} label="" />
      </div>

      {s.enabled && (
        <>
          <div>
            <div className="mb-1.5 text-micro uppercase tracking-label text-krypt-muted/60">How far it reaches</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MCP_ACCESS_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => void setAccess(level)}
                  disabled={busy}
                  title={MCP_ACCESS_TEXT[level].why}
                  className={cls(
                    'rounded-lg border px-3 py-2.5 text-note font-semibold transition disabled:opacity-50',
                    s.access === level
                      ? level === 'live'
                        ? 'border-rose-400/60 bg-rose-400/15 text-rose-100'
                        : 'border-krypt-purple/60 bg-krypt-purple/15 text-white'
                      : 'border-white/10 bg-krypt-panel text-krypt-muted hover:border-white/20 hover:text-white',
                  )}
                >
                  {MCP_ACCESS_TEXT[level].label}
                </button>
              ))}
            </div>
            <p className={cls('mt-1.5 text-label leading-relaxed', live ? 'text-rose-200' : 'text-krypt-muted')}>{MCP_ACCESS_TEXT[s.access].why}</p>
          </div>

          <div>
            <div className="mb-1.5 text-micro uppercase tracking-label text-krypt-muted/60">Connect a client</div>
            <p className="mb-2 text-label leading-relaxed text-krypt-muted">
              Paste this into a terminal to connect Claude Code. The token is a password for your wallet’s app — treat it like one, and never paste it into a
              chat or a screenshot.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void copy(panel.command, 'Command')}
                className="rounded-lg border border-krypt-purple/50 bg-krypt-purple/15 px-4 py-2.5 text-note font-semibold text-white transition hover:bg-krypt-purple/25"
              >
                Copy the connect command
              </button>
              <button
                onClick={() => void copy(panel.json, 'Config')}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-note font-medium text-white transition hover:bg-white/10"
              >
                Copy it as JSON
              </button>
              <button
                onClick={() => setShowToken((v) => !v)}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-note font-medium text-krypt-muted transition hover:text-white"
              >
                {showToken ? 'Hide the token' : 'Show the token'}
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    const yes = await modal.confirm({
                      title: 'Generate a new token?',
                      message: 'Every AI client connected with the old token stops working until you give it the new command.',
                      confirmLabel: 'Generate',
                    });
                    if (yes) await apply(() => window.krypt.mcp.newToken());
                  })()
                }
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-note font-medium text-krypt-muted transition hover:border-rose-400/40 hover:text-rose-200"
              >
                New token
              </button>
            </div>
            {showToken && <p className="mt-2 break-all rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-label text-white/80">{s.token}</p>}
          </div>

          {/* The limits only bind live spending, and the panel says so rather
              than leaving a paper user to wonder why nothing is capped. */}
          <div>
            <div className="mb-1.5 text-micro uppercase tracking-label text-krypt-muted/60">Limits {live ? '' : '· they bind once you allow live trading'}</div>
            <div className="grid grid-cols-3 gap-3">
              <McpNumber label="Max per buy" hint="SOL" value={s.budget.maxBuySol} onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, maxBuySol: v }))} />
              <McpNumber label="Max in an hour" hint="SOL" value={s.budget.hourlyCapSol} onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, hourlyCapSol: v }))} />
              <McpNumber
                label="Trades a minute"
                hint="1–60"
                value={s.budget.maxTradesPerMinute}
                onSave={(v) => void apply(() => window.krypt.mcp.setBudget({ ...s.budget, maxTradesPerMinute: Math.round(v) }))}
              />
            </div>
            <p className="mt-1.5 text-label leading-relaxed text-krypt-muted">
              Selling is never capped by value — the worst an unwanted sell can do is put your own funds back in your own wallet, and being able to get out is
              the point of letting an assistant trade at all.
            </p>
          </div>

          <p className="text-label leading-relaxed text-krypt-muted">
            What it can never do, whatever you allow: withdraw or transfer anything, change a setting, see or export your key, bridge, launch a token, or hand
            the app a transaction to sign. It asks; the app decides and builds.
          </p>
        </>
      )}
    </Card>
  );
}

/** A number that is only saved when it is committed — typing 0.0 into a live
 *  spending cap should not save `0` on the way to `0.05`. */
function McpNumber({ label, hint, value, onSave }: { label: string; hint: string; value: number; onSave: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <label className="block">
      <span className="mb-1 block text-label text-krypt-muted">
        {label} <span className="text-krypt-muted/60">{hint}</span>
      </span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-note text-white outline-none focus:border-krypt-purple/50"
      />
    </label>
  );
}
