// Scripts — the user's own automation: rules built without code, or a
// JavaScript script, each under its own budget, paper first.
//
// The page is a list on the left and one script's editor on the right.
// Nothing here executes anything: every save goes through validation in
// main, every action a script takes is checked there against its budget,
// and arming a script is a separate click from saving it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clipboard, Code2, ListChecks, Play, Plus, Power, Trash2 } from 'lucide-react';
import {
  ALERT_KINDS,
  DEFAULT_BUDGET,
  OPS_FOR_KIND,
  OP_LABELS,
  RULE_ACTIONS,
  RULE_FIELDS,
  RULE_TRIGGERS,
  SCOPES_FOR_TRIGGER,
  SCRIPT_API_DOC,
  SCRIPT_EXAMPLES,
  aiPromptPack,
  defaultScript,
  describeRules,
  fieldGuideText,
  validateScript,
  type RuleAction,
  type RuleActionType,
  type RuleCondition,
  type RuleField,
  type RuleOp,
  type ScriptLogLine,
  type ScriptSnapshot,
  type ScriptStats,
  type UserScript,
} from '@shared/automation';
import { Badge, Card, GhostButton, Page, PrimaryButton, Section, Switch } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { useAppState } from '../state/AppStateProvider';
import { cls } from '../utils/format';

type Draft = Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const inputCls = 'w-full rounded-md bg-black/40 border border-white/15 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60';
const selectCls = 'rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted mb-1">
        {label}
        {hint && <span className="normal-case tracking-normal text-krypt-muted/60"> · {hint}</span>}
      </div>
      {children}
    </label>
  );
}

function fmtAgo(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ScriptsPage() {
  const toast = useToast();
  const modal = useModal();
  const { settings } = useAppState();
  const [snap, setSnap] = useState<ScriptSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await window.krypt.automation.list();
    if (r.ok && r.data) setSnap(r.data);
  }, []);

  useEffect(() => {
    void load();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'automation') setSnap(ev.snapshot);
    });
    return off;
  }, [load]);

  const current = useMemo(() => snap?.scripts.find((s) => s.id === selected) ?? null, [snap, selected]);

  // Editing follows the SELECTION, not every push. `current` is rebuilt by
  // `automation.all()` on every snapshot, and a snapshot lands on every script
  // log line — depending on the object identity meant a second, chattier
  // script silently wiped whatever you were half-way through typing.
  useEffect(() => {
    if (current) setDraft({ ...current, rules: { ...current.rules, conditions: [...current.rules.conditions], actions: [...current.rules.actions] }, budget: { ...current.budget } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.updatedAt]);

  // The arm switch acts on the SAVED script, while every control above it
  // edits the draft. Arming while they disagree is how a script gets armed at
  // a size the screen is not showing — or worse, flipped to live in the editor
  // and armed with no live confirmation, because the saved copy still says
  // paper. The Warmer page already refuses this; so do we.
  const dirty = useMemo(() => {
    if (!current || !draft) return false;
    return JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...current, updatedAt: 0 });
  }, [current, draft]);

  const startNew = (kind: 'rules' | 'code'): void => {
    setSelected(null);
    setDraft({ ...defaultScript(kind) });
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    const v = validateScript(draft);
    if (!v.ok) {
      toast.error(v.message);
      return;
    }
    setBusy(true);
    const r = await window.krypt.automation.save(draft);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(r.message);
    if (r.data) {
      setSnap(r.data);
      if (!draft.id) {
        const newest = r.data.scripts.find((s) => s.name === draft.name);
        if (newest) setSelected(newest.id);
      }
    }
  };

  const toggle = async (s: UserScript, on: boolean): Promise<void> => {
    if (on && s.mode === 'live') {
      const okGo = await modal.confirm({
        title: 'Arm a LIVE script',
        message: `"${s.name}" will spend real SOL on its own, up to ${s.budget.maxSolPerTrade} SOL a trade, ${s.budget.maxBuysPerDay} buys a day, and stop itself after ${s.budget.maxLossSolPerDay} SOL of realised loss in a day. You can turn it off any time; the kill switch stops every script at once.`,
        confirmLabel: 'Arm it',
        destructive: true,
      });
      if (!okGo) return;
    }
    const r = await window.krypt.automation.setEnabled(s.id, on);
    if (!r.ok) toast.error(r.message);
    else {
      toast[on ? 'warn' : 'success'](r.message);
      if (r.data) setSnap(r.data);
    }
  };

  const removeScript = async (s: UserScript): Promise<void> => {
    const okGo = await modal.confirm({ title: 'Delete script', message: `Delete "${s.name}"? Its log and once-per-token memory go with it.`, confirmLabel: 'Delete', destructive: true });
    if (!okGo) return;
    const r = await window.krypt.automation.remove(s.id);
    if (!r.ok) toast.error(r.message);
    else {
      toast.success(r.message);
      if (r.data) setSnap(r.data);
      if (selected === s.id) {
        setSelected(null);
        setDraft(null);
      }
    }
  };

  const killSwitch = async (on: boolean): Promise<void> => {
    if (on) {
      const okGo = await modal.confirm({ title: 'Kill switch', message: 'Turn every script off now? Nothing can be enabled again until the switch is lifted.', confirmLabel: 'Stop everything', destructive: true });
      if (!okGo) return;
    }
    const r = await window.krypt.automation.killSwitch(on);
    if (!r.ok) toast.error(r.message);
    else if (r.data) setSnap(r.data);
  };

  const liveEnabled = settings.execution.liveEnabled;

  return (
    <Page title="Scripts" subtitle="Your own rules and code, each under a budget. Paper first; live is a separate, confirmed switch.">
      {snap?.killSwitch && (
        <Card className="mb-4 border-rose-500/40 bg-rose-500/10 text-xs text-rose-200 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> The kill switch is on — every script is off and none can be enabled.
          </span>
          <GhostButton onClick={() => void killSwitch(false)} className="!py-1 !px-3 text-xs">
            Lift it
          </GhostButton>
        </Card>
      )}
      <div className="grid lg:grid-cols-[320px_1fr] gap-4 items-start">
        {/* List */}
        <div className="space-y-3">
          <div className="flex gap-2">
            <PrimaryButton onClick={() => startNew('rules')} className="flex-1 !py-2 text-xs">
              <ListChecks className="h-3.5 w-3.5" /> New rule
            </PrimaryButton>
            <GhostButton onClick={() => startNew('code')} className="flex-1 !py-2 text-xs">
              <Code2 className="h-3.5 w-3.5" /> New script
            </GhostButton>
          </div>
          <Card padded={false} className="divide-y divide-white/5">
            {!snap ? (
              <div className="p-4 text-xs text-krypt-muted">Loading…</div>
            ) : snap.scripts.length === 0 ? (
              <div className="p-4 text-xs text-krypt-muted">No scripts yet. A rule is three dropdowns; a script is a few lines of JavaScript. Both start in paper mode.</div>
            ) : (
              snap.scripts.map((s) => {
                const st: ScriptStats | undefined = snap.stats[s.id];
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    className={cls('w-full text-left px-4 py-3 hover:bg-white/[0.04] transition', selected === s.id && 'bg-krypt-purple/10')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-white truncate">{s.name}</span>
                      <span className="flex items-center gap-1.5 flex-shrink-0">
                        <Badge tone={s.mode === 'live' ? 'danger' : 'neutral'}>{s.mode}</Badge>
                        <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? (s.kind === 'code' && st && !st.running ? 'starting' : 'on') : 'off'}</Badge>
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-krypt-muted truncate">{s.kind === 'rules' ? describeRules(s.rules) : `script · ${s.code.split('\n').length} lines`}</div>
                    {st && (
                      <div className="mt-1 text-[10px] font-mono text-krypt-muted/70">
                        today {st.buysToday}b/{st.sellsToday}s · {st.realizedSolToday >= 0 ? '+' : ''}
                        {st.realizedSolToday.toFixed(3)} SOL · open {st.openCount}
                        {st.errorsInARow > 0 && <span className="text-rose-300"> · {st.errorsInARow} errors</span>}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </Card>
          {snap && snap.scripts.length > 0 && !snap.killSwitch && (
            <GhostButton destructive onClick={() => void killSwitch(true)} className="w-full !py-2 text-xs">
              <Power className="h-3.5 w-3.5" /> Kill switch — stop every script
            </GhostButton>
          )}
        </div>

        {/* Editor */}
        <div className="space-y-4">
          {!draft ? (
            <Card className="text-xs text-krypt-muted">Pick a script on the left, or make a new one.</Card>
          ) : (
            <>
              <Card className="space-y-3 border-krypt-purple/25">
                <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-end">
                  <Field label="Name">
                    <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="Buy strong launches" />
                  </Field>
                  <Field label="Kind">
                    <div className="flex rounded-md border border-white/10 overflow-hidden">
                      {(['rules', 'code'] as const).map((k) => (
                        <button
                          key={k}
                          onClick={() => setDraft({ ...draft, kind: k, code: k === 'code' && !draft.code ? SCRIPT_EXAMPLES[0].code : draft.code })}
                          className={cls('px-3 py-1.5 text-[11px] font-semibold transition', draft.kind === k ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
                        >
                          {k === 'rules' ? 'Rules' : 'Code'}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Mode">
                    <div className="flex rounded-md border border-white/10 overflow-hidden">
                      {(['paper', 'live'] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => setDraft({ ...draft, mode: m })}
                          className={cls('px-3 py-1.5 text-[11px] font-semibold transition', draft.mode === m ? (m === 'live' ? 'bg-rose-500/30 text-white' : 'bg-krypt-purple/25 text-white') : 'text-krypt-muted hover:text-white')}
                        >
                          {m === 'paper' ? 'Paper' : 'Live'}
                        </button>
                      ))}
                    </div>
                  </Field>
                </div>
                {draft.mode === 'live' && (
                  <div className="text-[11px] text-rose-200/90 flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    {/* Saving disarms only on the paper → live TRANSITION. A script
                        already saved as live keeps its arming and restarts with the
                        new code the moment you save, which is the opposite of what
                        the old sentence promised. */}
                    {current?.mode === 'live'
                      ? current.enabled
                        ? 'This script is armed and live. Saving restarts it immediately with the new code — it stays armed.'
                        : 'Live spends real SOL on its own. This script is already saved as live; arming is a separate confirmed switch.'
                      : 'Live spends real SOL on its own. Saving as live disarms the script; arming is a separate confirmed switch.'}
                    {!liveEnabled && ' Live execution is off in Settings, so a live script would refuse every trade until it is on.'}
                  </div>
                )}
                {draft.mode === 'paper' && draft.kind === 'rules' && draft.rules.actions.some((a) => ['stop_loss', 'take_profit', 'trailing_stop', 'limit_buy', 'limit_sell', 'apply_template'].includes(a.type)) && (
                  <div className="text-[11px] text-amber-200/90">Advanced orders execute for real, so a paper script records them on its log without placing them. Switch the script to live to place them.</div>
                )}

                {/* Budget */}
                <div className="grid grid-cols-5 gap-3">
                  <Field label="Max per trade" hint="SOL">
                    <input type="number" step="0.01" value={draft.budget.maxSolPerTrade} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxSolPerTrade: Number(e.target.value) } })} className={inputCls} />
                  </Field>
                  <Field label="Buys per day">
                    <input type="number" value={draft.budget.maxBuysPerDay} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxBuysPerDay: Number(e.target.value) } })} className={inputCls} />
                  </Field>
                  <Field label="Daily loss stop" hint="SOL">
                    <input type="number" step="0.01" value={draft.budget.maxLossSolPerDay} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxLossSolPerDay: Number(e.target.value) } })} className={inputCls} />
                  </Field>
                  <Field label="Open positions">
                    <input type="number" value={draft.budget.maxOpenPositions} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxOpenPositions: Number(e.target.value) } })} className={inputCls} />
                  </Field>
                  <Field label="Actions / min">
                    <input type="number" value={draft.budget.maxActionsPerMinute} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxActionsPerMinute: Number(e.target.value) } })} className={inputCls} />
                  </Field>
                </div>
                <div className="text-[11px] text-krypt-muted">
                  Every action a script takes is checked against this budget in the app, not in the script. A buy over the cap is refused, not shrunk. Past the daily loss stop the script turns itself off.
                  {' '}
                  <button className="underline text-krypt-muted hover:text-white" onClick={() => setDraft({ ...draft, budget: { ...DEFAULT_BUDGET } })}>
                    Reset to defaults
                  </button>
                </div>
              </Card>

              {draft.kind === 'rules' ? <RulesEditor draft={draft} setDraft={setDraft} templates={snap?.templates ?? []} /> : <CodeEditor draft={draft} setDraft={setDraft} />}

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <PrimaryButton onClick={() => void save()} disabled={busy} className="!py-2 text-xs">
                    {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save (paper, off)'}
                  </PrimaryButton>
                  {current && (
                    <Switch
                      checked={current.enabled}
                      disabled={dirty}
                      onChange={(v) => void toggle(current, v)}
                      label={current.enabled ? 'On' : 'Off'}
                      description={dirty ? 'Unsaved settings — save before arming' : current.enabled ? `Running in ${current.mode} mode` : 'Enable to start'}
                    />
                  )}
                </div>
                {current && (
                  <GhostButton destructive onClick={() => void removeScript(current)} className="!py-2 text-xs">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </GhostButton>
                )}
              </div>

              {current && snap && <ScriptLog lines={snap.logs[current.id] ?? []} stats={snap.stats[current.id]} />}
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

// ── Rules editor ──────────────────────────────────────────────────────

function defaultActionFor(type: RuleActionType): RuleAction {
  switch (type) {
    case 'buy':
      return { type: 'buy', sol: 0.02 };
    case 'sell':
      return { type: 'sell', pct: 100 };
    case 'sell_all':
      return { type: 'sell_all' };
    case 'stop_loss':
      return { type: 'stop_loss', pct: 30 };
    case 'take_profit':
      return { type: 'take_profit', gainPct: 100, sellPct: 50 };
    case 'trailing_stop':
      return { type: 'trailing_stop', pct: 25 };
    case 'limit_buy':
      return { type: 'limit_buy', basis: 'mcap_usd', value: 20_000, sol: 0.02 };
    case 'limit_sell':
      return { type: 'limit_sell', basis: 'mcap_usd', value: 100_000, pct: 50 };
    case 'cancel_orders':
      return { type: 'cancel_orders' };
    case 'apply_template':
      return { type: 'apply_template', templateId: '' };
    case 'alert':
      return { type: 'alert', kind: 'mcap_above', threshold: 100_000 };
    case 'watch':
      return { type: 'watch' };
    case 'unwatch':
      return { type: 'unwatch' };
    case 'notify':
      return { type: 'notify', message: '{symbol}: rule fired' };
    case 'log':
      return { type: 'log', message: '{symbol}: rule fired' };
    case 'disable_self':
      return { type: 'disable_self' };
  }
}

function RulesEditor({ draft, setDraft, templates }: { draft: Draft; setDraft: (d: Draft) => void; templates: Array<{ id: string; name: string }> }) {
  const r = draft.rules;
  const setRules = (patch: Partial<Draft['rules']>): void => setDraft({ ...draft, rules: { ...r, ...patch } });
  const scopes = SCOPES_FOR_TRIGGER[r.trigger];
  const fieldsFor = RULE_FIELDS.filter((f) => scopes.includes(f.scope));
  const actionsFor = RULE_ACTIONS.filter((a) => (r.trigger === 'schedule' ? !a.needsMint : !(r.trigger === 'position' && (a.id === 'buy' || a.id === 'limit_buy'))));

  const setCond = (i: number, patch: Partial<RuleCondition>): void => {
    const next = r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c));
    // A new field may not accept the old operator.
    const f = RULE_FIELDS.find((x) => x.id === next[i].field);
    if (f && !OPS_FOR_KIND[f.kind].includes(next[i].op)) next[i] = { ...next[i], op: OPS_FOR_KIND[f.kind][0], value: f.kind === 'number' ? 0 : '' };
    setRules({ conditions: next });
  };
  const setAction = (i: number, a: RuleAction): void => setRules({ actions: r.actions.map((x, j) => (j === i ? a : x)) });

  return (
    <Section title="Rule" description={describeRules(r)}>
      <Card className="space-y-4">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
          <Field label="When">
            <select
              value={r.trigger}
              onChange={(e) => {
                const trigger = e.target.value as Draft['rules']['trigger'];
                setRules({
                  trigger,
                  conditions: [],
                  actions: trigger === 'position' || trigger === 'tick' ? [{ type: 'sell', pct: 100 }] : trigger === 'schedule' ? [{ type: 'sell_all' }] : [{ type: 'buy', sol: 0.02 }],
                  atHHMM: trigger === 'schedule' ? (r.atHHMM ?? '23:55') : r.atHHMM,
                });
              }}
              className={cls(selectCls, 'w-full')}
            >
              {RULE_TRIGGERS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </Field>
          {r.trigger === 'schedule' && (
            <Field label="At" hint="HH:MM local">
              <input value={r.atHHMM ?? ''} onChange={(e) => setRules({ atHHMM: e.target.value })} placeholder="23:55" className={cls(inputCls, 'w-24')} />
            </Field>
          )}
          <Field label="Once per token">
            <Switch checked={r.oncePerMint} onChange={(v) => setRules({ oncePerMint: v })} label="" description="" />
          </Field>
          <Field label="Cooldown" hint="s">
            <input type="number" value={r.cooldownSec} onChange={(e) => setRules({ cooldownSec: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
          </Field>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted mb-2">And all of these hold (an unknown value never does)</div>
          <div className="space-y-2">
            {r.conditions.map((c, i) => {
              const f = RULE_FIELDS.find((x) => x.id === c.field);
              const kind = f?.kind ?? 'number';
              return (
                <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                  <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value as RuleField })} className={selectCls} title={f ? `${f.hint || f.label} · ${f.unit} · null when ${f.nullWhen}` : ''}>
                    {fieldsFor.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                  <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value as RuleOp })} className={selectCls}>
                    {OPS_FOR_KIND[kind].map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                  {kind === 'boolean' ? (
                    <span className="text-[11px] text-krypt-muted">{f?.hint || f?.unit}</span>
                  ) : (
                    <input
                      type={kind === 'number' ? 'number' : 'text'}
                      step="any"
                      value={c.value}
                      onChange={(e) => setCond(i, { value: kind === 'number' ? Number(e.target.value) : e.target.value })}
                      placeholder={f?.unit}
                      className={inputCls}
                    />
                  )}
                  <GhostButton onClick={() => setRules({ conditions: r.conditions.filter((_, j) => j !== i) })} className="!py-1 !px-2 text-xs">
                    ✕
                  </GhostButton>
                </div>
              );
            })}
            <GhostButton onClick={() => setRules({ conditions: [...r.conditions, { field: fieldsFor[0]?.id ?? 'score', op: OPS_FOR_KIND[fieldsFor[0]?.kind ?? 'number'][0], value: fieldsFor[0]?.kind === 'number' || !fieldsFor[0] ? 0 : '' }] })} className="!py-1 !px-2 text-xs">
              <Plus className="h-3 w-3" /> Condition
            </GhostButton>
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted mb-2">Then</div>
          <div className="space-y-2">
            {r.actions.map((a, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
                <select value={a.type} onChange={(e) => setAction(i, defaultActionFor(e.target.value as RuleActionType))} className={selectCls} title={RULE_ACTIONS.find((x) => x.id === a.type)?.hint}>
                  {actionsFor.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <ActionParams a={a} set={(next) => setAction(i, next)} templates={templates} />
                <GhostButton onClick={() => setRules({ actions: r.actions.filter((_, j) => j !== i) })} className="!py-1 !px-2 text-xs">
                  ✕
                </GhostButton>
              </div>
            ))}
            <GhostButton onClick={() => setRules({ actions: [...r.actions, defaultActionFor('log')] })} className="!py-1 !px-2 text-xs">
              <Plus className="h-3 w-3" /> Action
            </GhostButton>
          </div>
          <div className="mt-2 text-[11px] text-krypt-muted">Messages may use {'{symbol}'}, {'{mint}'}, {'{score}'}, {'{pnlPct}'} and any other field name. Hover a field for its unit and when it is unknown.</div>
        </div>
      </Card>
    </Section>
  );
}

function ActionParams({ a, set, templates }: { a: RuleAction; set: (a: RuleAction) => void; templates: Array<{ id: string; name: string }> }) {
  const hint = RULE_ACTIONS.find((x) => x.id === a.type)?.hint ?? '';
  switch (a.type) {
    case 'buy':
      return <input type="number" step="0.01" value={a.sol} onChange={(e) => set({ type: 'buy', sol: Number(e.target.value) })} className={inputCls} placeholder="SOL" />;
    case 'sell':
      return <input type="number" value={a.pct} onChange={(e) => set({ type: 'sell', pct: Number(e.target.value) })} className={inputCls} placeholder="% of what is held" />;
    case 'stop_loss':
    case 'trailing_stop':
      return (
        <div className="flex items-center gap-2">
          <input type="number" value={a.pct} onChange={(e) => set({ type: a.type, pct: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
          <span className="text-[11px] text-krypt-muted">% {a.type === 'stop_loss' ? 'below the price now' : 'below the peak'} — sells all</span>
        </div>
      );
    case 'take_profit':
      return (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-krypt-muted">up</span>
          <input type="number" value={a.gainPct} onChange={(e) => set({ ...a, gainPct: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
          <span className="text-[11px] text-krypt-muted">% → sell</span>
          <input type="number" value={a.sellPct} onChange={(e) => set({ ...a, sellPct: Number(e.target.value) })} className={cls(inputCls, 'w-20')} />
          <span className="text-[11px] text-krypt-muted">%</span>
        </div>
      );
    case 'limit_buy':
    case 'limit_sell':
      return (
        <div className="flex items-center gap-2">
          <select value={a.basis} onChange={(e) => set({ ...a, basis: e.target.value as 'mcap_usd' | 'price_sol' })} className={selectCls}>
            <option value="mcap_usd">market cap USD</option>
            <option value="price_sol">price SOL</option>
          </select>
          <input type="number" step="any" value={a.value} onChange={(e) => set({ ...a, value: Number(e.target.value) })} className={cls(inputCls, 'w-32')} placeholder="level" />
          {a.type === 'limit_buy' ? (
            <>
              <span className="text-[11px] text-krypt-muted">→ buy</span>
              <input type="number" step="0.01" value={a.sol} onChange={(e) => set({ ...a, sol: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
              <span className="text-[11px] text-krypt-muted">SOL</span>
            </>
          ) : (
            <>
              <span className="text-[11px] text-krypt-muted">→ sell</span>
              <input type="number" value={a.pct} onChange={(e) => set({ ...a, pct: Number(e.target.value) })} className={cls(inputCls, 'w-20')} />
              <span className="text-[11px] text-krypt-muted">%</span>
            </>
          )}
        </div>
      );
    case 'apply_template':
      return (
        <select value={a.templateId} onChange={(e) => set({ type: 'apply_template', templateId: e.target.value })} className={cls(selectCls, 'w-full')}>
          <option value="">Pick a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      );
    case 'alert':
      return (
        <div className="flex items-center gap-2">
          <select value={a.kind} onChange={(e) => set({ ...a, kind: e.target.value as typeof a.kind })} className={selectCls}>
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace('_', ' ')}
              </option>
            ))}
          </select>
          <input type="number" step="any" value={a.threshold} onChange={(e) => set({ ...a, threshold: Number(e.target.value) })} className={cls(inputCls, 'w-32')} placeholder="threshold" />
        </div>
      );
    case 'notify':
    case 'log':
      return <input value={a.message} onChange={(e) => set({ type: a.type, message: e.target.value })} className={inputCls} placeholder="{symbol} scored {score} — {mint}" />;
    default:
      return <span className="text-[11px] text-krypt-muted">{hint}</span>;
  }
}

// ── Code editor ───────────────────────────────────────────────────────

function CodeEditor({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const toast = useToast();
  const [panel, setPanel] = useState<'api' | 'vars' | 'off'>('api');
  const copyPrompt = async (): Promise<void> => {
    const ok = await copyText(aiPromptPack());
    if (ok) toast.success('AI prompt copied — paste it into any assistant, then describe what you want the script to do.');
    else toast.error('Could not reach the clipboard');
  };
  const copyGuide = async (): Promise<void> => {
    const ok = await copyText(fieldGuideText());
    toast[ok ? 'success' : 'error'](ok ? 'Variable guide copied' : 'Could not reach the clipboard');
  };
  return (
    <Section
      title="Script"
      description="JavaScript, run in a sandbox with no network, no files and no keys. It can only ask the app to act, and the app checks every ask against the budget above."
    >
      <div className={cls('grid gap-3', panel !== 'off' ? 'lg:grid-cols-[1fr_380px]' : '')}>
        <Card className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <select
              className={selectCls}
              value=""
              onChange={(e) => {
                const ex = SCRIPT_EXAMPLES.find((x) => x.name === e.target.value);
                if (ex) setDraft({ ...draft, code: ex.code, name: draft.name === 'New script' ? ex.name : draft.name });
              }}
            >
              <option value="">Insert an example…</option>
              {SCRIPT_EXAMPLES.map((ex) => (
                <option key={ex.name} value={ex.name}>
                  {ex.name} — {ex.description}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void copyPrompt()} className="!py-1 !px-3 text-xs">
                <Clipboard className="h-3.5 w-3.5" /> Copy AI prompt
              </PrimaryButton>
              <GhostButton onClick={() => setPanel(panel === 'api' ? 'off' : 'api')} className="!py-1 !px-2 text-xs">
                API
              </GhostButton>
              <GhostButton onClick={() => setPanel(panel === 'vars' ? 'off' : 'vars')} className="!py-1 !px-2 text-xs">
                Variables
              </GhostButton>
            </div>
          </div>
          <textarea
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            spellCheck={false}
            className={cls(inputCls, 'font-mono text-[12px] leading-5 min-h-[380px] resize-y')}
          />
          <div className="text-[11px] text-krypt-muted flex items-center gap-2">
            <Play className="h-3 w-3" /> Save, then switch it on. A handler that runs past 3 s is killed; five errors in a row turn the script off. Unknown facts are null, never zero.
          </div>
        </Card>
        {panel === 'api' && (
          <Card className="overflow-auto max-h-[560px]">
            <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted mb-2">The bot API</div>
            <pre className="font-mono text-[11px] leading-5 text-krypt-muted whitespace-pre-wrap">{SCRIPT_API_DOC}</pre>
          </Card>
        )}
        {panel === 'vars' && (
          <Card className="overflow-auto max-h-[560px]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted">Variable guide — every field a script or rule can see</div>
              <GhostButton onClick={() => void copyGuide()} className="!py-0.5 !px-2 text-[11px]">
                Copy
              </GhostButton>
            </div>
            <VariableGuide />
          </Card>
        )}
      </div>
    </Section>
  );
}

function VariableGuide() {
  const groups: Array<[string, string]> = [
    ['token', 'Launch feed'],
    ['market', 'Market providers (when cached)'],
    ['position', 'Position (when held)'],
    ['runner', 'Runner flag'],
    ['leader', 'Followed wallet'],
    ['order', 'Advanced order'],
    ['alert', 'Alert'],
    ['any', 'Always'],
  ];
  return (
    <div className="space-y-3 text-[11px]">
      <div className="text-krypt-muted">
        Always present: <code className="text-white/80">mint</code>, <code className="text-white/80">symbol</code>, <code className="text-white/80">name</code>, <code className="text-white/80">priceHistory</code> (SOL, oldest first).
      </div>
      {groups.map(([scope, title]) => (
        <div key={scope}>
          <div className="text-[10px] uppercase tracking-[0.18em] text-krypt-muted/80 mb-1">{title}</div>
          <table className="w-full">
            <tbody>
              {RULE_FIELDS.filter((f) => f.scope === scope).map((f) => (
                <tr key={f.id} className="border-t border-white/5 align-top">
                  <td className="py-1 pr-2 font-mono text-white/85 whitespace-nowrap">{f.id}</td>
                  <td className="py-1 pr-2 text-krypt-muted/80 whitespace-nowrap">{f.kind}</td>
                  <td className="py-1 text-krypt-muted">
                    {f.hint || f.label}
                    {f.unit ? ` · ${f.unit}` : ''}
                    <span className="text-krypt-muted/60"> · null when {f.nullWhen}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── Log ───────────────────────────────────────────────────────────────

function ScriptLog({ lines, stats }: { lines: ScriptLogLine[]; stats?: ScriptStats }) {
  return (
    <Section
      title="Log"
      description={stats ? `Last run ${fmtAgo(stats.lastRunAt)} · today ${stats.buysToday} buys, ${stats.sellsToday} sells, ${stats.realizedSolToday >= 0 ? '+' : ''}${stats.realizedSolToday.toFixed(4)} SOL realised · ${stats.openCount} open · fired on ${stats.firedMints} tokens${stats.lastError ? ` · last error: ${stats.lastError}` : ''}` : ''}
    >
      <Card padded={false} className="max-h-[320px] overflow-auto">
        {lines.length === 0 ? (
          <div className="p-4 text-xs text-krypt-muted">Nothing yet.</div>
        ) : (
          <div className="font-mono text-[11px]">
            {[...lines].reverse().map((l, i) => (
              <div key={i} className={cls('px-4 py-1 border-b border-white/5 flex gap-3', l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-300' : 'text-white/80')}>
                <span className="text-krypt-muted/60 flex-shrink-0">{new Date(l.at).toLocaleTimeString()}</span>
                <span className="whitespace-pre-wrap break-words">{l.line}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Section>
  );
}
