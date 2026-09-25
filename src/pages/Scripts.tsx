// Scripts — the user's own automation: rules built without code, or a
// JavaScript script, each under its own budget, paper first.
//
// Three views under one top bar (2026-09-20, user: "the turn-on-live button
// is at the bottom of a script, scripts and new scripts live in the same
// area, it's cluttered"):
//   • My scripts — the list on the left, one script's editor on the right,
//     with the arm switch, Save and Delete in a header card ABOVE the
//     editor, where the eye lands first;
//   • New — pick a chain, then a rule (no code) or a script (JavaScript);
//   • Reference — the AI prompt, the bot API, every variable, the examples.
// Nothing here executes anything: every save goes through validation in
// main, every action a script takes is checked there against its budget,
// and arming a script is a separate click from saving it.

import { ScriptInputsDialog, useScriptInputs } from '../components/terminal/ScriptInputsDialog';
import { inputsProblem } from '@shared/scriptInputs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Clipboard, Code2, Eraser, FolderOpen, ListChecks, Play, Plus, Power, RotateCcw, Settings2, Trash2 } from 'lucide-react';
import { nativeSymbolOf, type ChainKind } from '@shared/evm';
import {
  ALERT_KINDS,
  DEFAULT_BUDGET,
  OPS_FOR_KIND,
  OP_LABELS,
  RULE_ACTIONS,
  RULE_FIELDS,
  actionAvailableOn,
  chainLabel,
  fieldAvailableOn,
  nativeFieldLabel,
  nativeText,
  scriptChain,
  triggerAvailableOn,
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
import { Badge, Card, Field, GhostButton, Page, PrimaryButton, Section, Switch } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { useAppState } from '../state/AppStateProvider';
import { cls } from '../utils/format';
import { MultiWalletConsent } from '../components/MultiWalletConsent';

type Draft = Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const inputCls = 'w-full rounded-md bg-black/40 border border-white/15 px-2 py-1.5 text-note text-white outline-none focus:border-krypt-purple/60';
const selectCls = 'rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-note text-white';

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

type View = 'scripts' | 'new' | 'reference';
type RefTab = 'prompt' | 'api' | 'vars' | 'examples';

const VIEWS: Array<[View, string, typeof ListChecks]> = [
  ['scripts', 'My scripts', ListChecks],
  ['new', 'New', Plus],
  ['reference', 'Reference', BookOpen],
];

const CHAINS = ['solana', 'robinhood', 'bnb'] as const;
const chainName = (ch: ChainKind): string => (ch === 'solana' ? 'Solana' : ch === 'bnb' ? 'BNB' : 'Robinhood');

/** The chain tabs, shared by the list, the New view and the variable guide. */
function ChainTabs({ value, onChange, counts }: { value: ChainKind; onChange: (ch: ChainKind) => void; counts?: Record<ChainKind, number> }) {
  return (
    <div className="flex rounded-lg border border-white/10 overflow-hidden">
      {CHAINS.map((ch) => (
        <button
          key={ch}
          onClick={() => onChange(ch)}
          title={chainLabel(ch)}
          className={cls(
            'flex-1 px-2 py-2 text-body font-semibold transition flex items-center justify-center gap-1.5',
            value === ch ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
          )}
        >
          {chainName(ch)}
          {counts && counts[ch] > 0 && <span className="text-label text-krypt-muted/70">{counts[ch]}</span>}
        </button>
      ))}
    </div>
  );
}

export function ScriptsPage() {
  const toast = useToast();
  const modal = useModal();
  const { settings } = useAppState();
  const [snap, setSnap] = useState<ScriptSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('scripts');
  const [refTab, setRefTab] = useState<RefTab>('prompt');

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

  // The arm switch acts on the SAVED script, while every control below it
  /** The settings this script's own code asks for, and whether they are given. */
  const inputs = useScriptInputs(draft?.kind === 'code' ? draft.code : '', draft?.inputs);
  const [askingInputs, setAskingInputs] = useState(false);
  /** Set when the dialog was opened BY pressing On: answer, and it arms. */
  const [armAfterInputs, setArmAfterInputs] = useState(false);

  // edits the draft. Arming while they disagree is how a script gets armed at
  // a size the screen is not showing — or worse, flipped to live in the editor
  // and armed with no live confirmation, because the saved copy still says
  // paper. Refuse it here rather than let a paper script spend.
  const dirty = useMemo(() => {
    if (!current || !draft) return false;
    return JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...current, updatedAt: 0 });
  }, [current, draft]);

  /**
   * Which chain's scripts the list is showing.
   *
   * A script runs on ONE chain and can only ever see and spend that chain's
   * money, so a single mixed list was the wrong shape: a user picked New
   * script, got the Solana default, and had no reason to think the chain was
   * a thing they had to choose (report, 2026-09-15). The tab is the choice,
   * made before there is a script to make it on.
   */
  const [tab, setTab] = useState<ChainKind>('solana');
  const chainCounts = useMemo(() => {
    const out: Record<ChainKind, number> = { solana: 0, robinhood: 0, bnb: 0 };
    for (const s of snap?.scripts ?? []) out[scriptChain(s)] += 1;
    return out;
  }, [snap]);
  const shown = useMemo(() => (snap?.scripts ?? []).filter((s) => scriptChain(s) === tab), [snap, tab]);

  // Opening a script from anywhere else moves the tab to its chain, so the
  // list never shows one chain while the editor holds another.
  useEffect(() => {
    if (current) setTab(scriptChain(current));
  }, [current]);

  const startNew = (kind: 'rules' | 'code', chain: ChainKind = tab): void => {
    setSelected(null);
    setTab(chain);
    setDraft({ ...defaultScript(kind, chain) });
    setView('scripts');
  };

  /** An example from Reference becomes a new code draft on the current chain. */
  const useExample = (ex: { name: string; code: string }): void => {
    setSelected(null);
    setDraft({ ...defaultScript('code', tab), name: ex.name, code: ex.code });
    setView('scripts');
  };

  /** A .js file off disk becomes a new code draft, exactly like an example. */
  const openFile = async (): Promise<void> => {
    const r = await window.krypt.automation.openFile();
    if (!r.ok) toast.error(r.message);
    else if (r.data) useExample(r.data);
  };

  const openReference = (t: RefTab): void => {
    setRefTab(t);
    setView('reference');
  };

  /** `override` is for a draft that was just built and not yet in state —
   *  React has not re-rendered, so reading `draft` here would save the old one. */
  const save = async (override?: Draft): Promise<boolean> => {
    const d = override ?? draft;
    if (!d) return false;
    const v = validateScript(d);
    if (!v.ok) {
      toast.error(v.message);
      return false;
    }
    setBusy(true);
    const r = await window.krypt.automation.save(d);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    toast.success(r.message);
    if (r.data) {
      setSnap(r.data);
      if (!d.id) {
        const newest = r.data.scripts.find((x) => x.name === d.name);
        if (newest) setSelected(newest.id);
      }
    }
    return true;
  };

  const toggle = async (s: UserScript, on: boolean): Promise<void> => {
    if (on && s.mode === 'live') {
      const okGo = await modal.confirm({
        title: 'Arm a LIVE script',
        // The money this names is the CHAIN's money: telling someone their
        // Robinhood script will spend SOL is telling them something false
        // about their own funds, right at the moment they arm it.
        message: nativeText(
          `"${s.name}" will spend real SOL on its own, up to ${s.budget.maxSolPerTrade} SOL a trade, ${s.budget.maxBuysPerDay} buys a day, and stop itself after ${s.budget.maxLossSolPerDay} SOL of realised loss in a day. You can turn it off any time; the kill switch stops every script at once.`,
          scriptChain(s),
        ),
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

  // Reset one script, or (no script) every script plus paper trades. A
  // script's totals are usually its OWN saved state (bot.setState), so this
  // clears that, not just the widget. Live scripts keep their open positions
  // and today's budget — see automation.resetScript.
  const resetScripts = async (s: UserScript | null): Promise<void> => {
    const kept = 'Live scripts keep the positions they still hold (so they can still sell them) and today’s buys and loss, which their daily limits count.';
    const okGo = await modal.confirm({
      title: s ? `Reset "${s.name}"` : 'Reset everything',
      message: s
        ? `Clear "${s.name}"’s stats, saved state (everything it stored with bot.setState), log and once-per-token memory?${s.mode === 'paper' ? ' Its paper positions and today’s paper numbers are cleared too.' : `

${kept}`}${s.enabled && s.kind === 'code' ? ' It is running, so it restarts fresh.' : ''}`
        : `Reset every script (paper and live) — stats, saved state, logs, memory — and clear every paper trade on every chain?

${kept} Live trades and copy trading are not touched. A copy of the old paper record is saved as paper-positions.backup.json.`,
      confirmLabel: s ? 'Reset script' : 'Reset everything',
      destructive: true,
    });
    if (!okGo) return;
    const r = await window.krypt.automation.reset(s?.id);
    if (!r.ok) toast.error(r.message);
    else {
      toast.success(r.message);
      if (r.data) setSnap(r.data);
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
  const currentStats: ScriptStats | undefined = current && snap ? snap.stats[current.id] : undefined;

  return (
    <Page
      title="Scripts"
      subtitle="Your own rules and code, each under a budget. Paper first; live is a separate, confirmed switch."
      actions={
        <div className="flex items-center gap-2">
        <GhostButton onClick={() => void resetScripts(null)} className="!py-2 !px-3 text-xs">
          <Eraser className="h-3.5 w-3.5" /> Reset everything
        </GhostButton>
        <div className="flex rounded-lg border border-white/10 overflow-hidden" role="tablist" aria-label="Scripts views">
          {VIEWS.map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cls(
                'px-3 py-1.5 text-body font-semibold transition flex items-center gap-1.5',
                view === id ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        </div>
      }
    >
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

      {view === 'new' && (
        <div className="max-w-3xl space-y-4">
          <Card className="space-y-3">
            <div className="text-label uppercase tracking-label text-krypt-muted">Which chain</div>
            <ChainTabs value={tab} onChange={setTab} counts={chainCounts} />
            <p className="text-body text-krypt-muted">A script watches and trades on one chain, in that chain’s own coin ({nativeSymbolOf(tab)}). Both kinds start in paper mode, off.</p>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="space-y-3 border-krypt-purple/25">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <ListChecks className="h-4 w-4 text-krypt-purple" /> A rule — no code
              </div>
              <p className="text-body text-krypt-muted">When this happens, if these hold, do that. Three dropdowns; every fact a rule can see is under Reference → Variables.</p>
              <PrimaryButton onClick={() => startNew('rules')} className="!py-2 text-xs">
                <Plus className="h-3.5 w-3.5" /> Start a rule on {chainName(tab)}
              </PrimaryButton>
            </Card>
            <Card className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Code2 className="h-4 w-4 text-krypt-purple" /> A script — JavaScript
              </div>
              <p className="text-body text-krypt-muted">A few lines in a sandbox with no network, no files and no keys. Copy the AI prompt under Reference, paste it into any assistant, describe what you want, paste the result back.</p>
              <div className="flex flex-wrap items-center gap-2">
                <PrimaryButton onClick={() => startNew('code')} className="!py-2 text-xs">
                  <Plus className="h-3.5 w-3.5" /> Start a script on {chainName(tab)}
                </PrimaryButton>
                <GhostButton onClick={() => openReference('examples')} className="!py-2 text-xs">
                  <BookOpen className="h-3.5 w-3.5" /> Start from an example
                </GhostButton>
                <GhostButton onClick={() => void openFile()} className="!py-2 text-xs">
                  <FolderOpen className="h-3.5 w-3.5" /> Open a .js file
                </GhostButton>
              </div>
            </Card>
          </div>
        </div>
      )}

      {view === 'reference' && (
        <ReferenceView
          tab={refTab}
          setTab={setRefTab}
          chain={draft ? scriptChain(draft) : tab}
          onUseExample={useExample}
        />
      )}

      {view === 'scripts' && (
        <div className="grid lg:grid-cols-[300px_1fr] gap-4 items-start">
          {/* The list: one tab per chain. A script can only see and spend the
              money of the chain it is on, so the chain is picked BEFORE the
              script exists rather than found later inside its editor. */}
          <div className="space-y-3">
            <ChainTabs value={tab} onChange={setTab} counts={chainCounts} />
            {/* A live script on this chain that the chain cannot execute. The
                page used to show only Solana's reason, so an unarmed EVM rail
                looked like a page with nothing wrong on it. */}
            {(() => {
              const why = snap?.blockedByChain?.[tab] ?? null;
              if (!why || !shown.some((s) => s.mode === 'live' && s.enabled)) return null;
              return (
                <div className="rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2 flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-arc-gold flex-shrink-0 mt-0.5" />
                  <p className="text-label text-arc-gold/90">
                    A live script here is armed but {chainLabel(tab)} cannot execute — {why}.
                  </p>
                </div>
              );
            })()}
            <Card padded={false} className="divide-y divide-white/5">
              {!snap ? (
                <div className="p-4 text-xs text-krypt-muted">Loading…</div>
              ) : shown.length === 0 ? (
                <div className="p-4 text-xs text-krypt-muted space-y-2">
                  <p>
                    {snap.scripts.length === 0
                      ? 'No scripts yet. A rule is three dropdowns; a script is a few lines of JavaScript. Both start in paper mode.'
                      : `No scripts on ${chainLabel(tab)} yet — the ones you have are on another tab. A new one here trades ${nativeSymbolOf(tab)}.`}
                  </p>
                  <button onClick={() => setView('new')} className="underline text-krypt-muted hover:text-white">
                    Make one
                  </button>
                </div>
              ) : (
                shown.map((s) => {
                  const st: ScriptStats | undefined = snap.stats[s.id];
                  const coin = nativeSymbolOf(scriptChain(s));
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
                      <div className="mt-1 text-body text-krypt-muted truncate">{s.kind === 'rules' ? describeRules(s.rules, scriptChain(s)) : `script · ${s.code.split('\n').length} lines`}</div>
                      {st && (
                        <div className="mt-1 text-label font-mono text-krypt-muted/70">
                          today {st.buysToday}b/{st.sellsToday}s · {st.realizedSolToday >= 0 ? '+' : ''}
                          {st.realizedSolToday.toFixed(3)} {coin} · open {st.openCount}
                          {st.errorsInARow > 0 && <span className="text-rose-300"> · {st.errorsInARow} errors</span>}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </Card>
            <GhostButton onClick={() => setView('new')} className="w-full !py-2 text-xs">
              <Plus className="h-3.5 w-3.5" /> New rule or script
            </GhostButton>
            {snap && snap.scripts.length > 0 && !snap.killSwitch && (
              <GhostButton destructive onClick={() => void killSwitch(true)} className="w-full !py-2 text-xs">
                <Power className="h-3.5 w-3.5" /> Kill switch — stop every script
              </GhostButton>
            )}
          </div>

          {/* Editor */}
          <div className="space-y-4">
            {!draft ? (
              <Card className="text-xs text-krypt-muted">
                Pick a script on the left, or{' '}
                <button onClick={() => setView('new')} className="underline hover:text-white">
                  make a new one
                </button>
                .
              </Card>
            ) : (
              <>
                {/* The controls first: name, what it is, and the arm switch,
                    Save and Delete — at the TOP, where they used to sit under
                    the whole editor. */}
                <Card className="space-y-2 border-krypt-purple/25">
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      className={cls(inputCls, 'max-w-xs !text-sm font-semibold')}
                      placeholder="Name this script"
                      aria-label="Script name"
                    />
                    <Badge tone={draft.kind === 'code' ? 'gradient' : 'neutral'}>{draft.kind === 'rules' ? 'rule' : 'script'}</Badge>
                    <Badge>{chainName(scriptChain(draft))}</Badge>
                    <Badge tone={draft.mode === 'live' ? 'danger' : 'neutral'}>{draft.mode}</Badge>
                    <span className="flex-1" />
                    {inputs.count > 0 && (
                      <GhostButton onClick={() => setAskingInputs(true)} className="!py-2 text-xs">
                        <Settings2 className="h-3.5 w-3.5" />
                        Settings
                        {inputs.problem && <span className="ml-1 text-arc-gold">·{' '}needed</span>}
                      </GhostButton>
                    )}
                    {current && (
                      <Switch
                        checked={current.enabled}
                        disabled={dirty}
                        /* A script cannot run with its own settings
                           unanswered — it would work against blanks and fail
                           in a way that reads as the script being broken. So
                           pressing On ASKS rather than refusing: the form
                           opens, and answering it arms the script. */
                        onChange={(v) => {
                          if (v && inputs.problem) {
                            setArmAfterInputs(true);
                            setAskingInputs(true);
                            return;
                          }
                          void toggle(current, v);
                        }}
                        label={current.enabled ? 'On' : 'Off'}
                        description={
                          dirty
                            ? 'Unsaved — save before arming'
                            : inputs.problem
                              ? 'Asks for its settings first'
                              : current.enabled
                                ? `Running in ${current.mode} mode`
                                : 'Enable to start'
                        }
                      />
                    )}
                    <PrimaryButton onClick={() => void save()} disabled={busy} className="!py-2 text-xs">
                      {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save (paper, off)'}
                    </PrimaryButton>
                    {current && (
                      <GhostButton onClick={() => void resetScripts(current)} className="!py-2 text-xs">
                        <RotateCcw className="h-3.5 w-3.5" /> Reset stats
                      </GhostButton>
                    )}
                    {current && (
                      <GhostButton destructive onClick={() => void removeScript(current)} className="!py-2 text-xs">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </GhostButton>
                    )}
                  </div>
                  {currentStats && (
                    <div className="text-label font-mono text-krypt-muted/70">
                      last run {fmtAgo(currentStats.lastRunAt)} · today {currentStats.buysToday} buys, {currentStats.sellsToday} sells,{' '}
                      {currentStats.realizedSolToday >= 0 ? '+' : ''}
                      {currentStats.realizedSolToday.toFixed(4)} {nativeSymbolOf(scriptChain(draft))} realised · {currentStats.openCount} open
                      {currentStats.lastError ? (
                        // WHEN, not just what. This field is sticky — it stays
                        // until the next error replaces it — so without a time
                        // an error from six hours ago reads as one happening
                        // now. A user reported exactly that (2026-09-21).
                        <span className="text-rose-300">
                          {' '}· last error{currentStats.lastErrorAt ? ` ${fmtAgo(currentStats.lastErrorAt)} ago` : ''}: {currentStats.lastError}
                        </span>
                      ) : null}
                    </div>
                  )}
                  {dirty && <p className="text-label text-amber-200/90">Unsaved changes. Arming waits for a save; saving a live script restarts it with the new settings.</p>}
                </Card>

                <Card className="space-y-3">
                  <div className="grid grid-cols-[auto_auto_auto] gap-3 items-end">
                    <Field label="Kind">
                      <div className="flex rounded-md border border-white/10 overflow-hidden">
                        {(['rules', 'code'] as const).map((k) => (
                          <button
                            key={k}
                            onClick={() => setDraft({ ...draft, kind: k, code: k === 'code' && !draft.code ? SCRIPT_EXAMPLES[0].code : draft.code })}
                            className={cls('px-3 py-1.5 text-body font-semibold transition', draft.kind === k ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
                          >
                            {k === 'rules' ? 'Rules' : 'Code'}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Chain" hint="A script watches and trades on one chain">
                      <div className="flex rounded-md border border-white/10 overflow-hidden">
                        {CHAINS.map((ch) => (
                          <button
                            key={ch}
                            onClick={() => {
                              if (scriptChain(draft) === ch) return;
                              // Conditions and actions the new chain cannot supply are
                              // DROPPED rather than carried over dead: an unknown fact
                              // never satisfies a rule, so keeping them would leave a
                              // rule that looks armed and can never fire.
                              const rules = {
                                ...draft.rules,
                                // A trigger the new chain never fires would leave the rule
                                // armed and silent, so it falls back to one that does.
                                trigger: triggerAvailableOn(draft.rules.trigger, ch) ? draft.rules.trigger : 'launch_update',
                                conditions: draft.rules.conditions.filter((c) => fieldAvailableOn(c.field, ch)),
                                actions: draft.rules.actions.filter((a) => actionAvailableOn(a.type, ch)),
                              };
                              setDraft({ ...draft, chain: ch, rules });
                            }}
                            className={cls(
                              'px-2.5 py-1.5 text-body font-semibold transition',
                              scriptChain(draft) === ch ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                            )}
                          >
                            {chainName(ch)}
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
                            className={cls('px-3 py-1.5 text-body font-semibold transition', draft.mode === m ? (m === 'live' ? 'bg-rose-500/30 text-white' : 'bg-krypt-purple/25 text-white') : 'text-krypt-muted hover:text-white')}
                          >
                            {m === 'paper' ? 'Paper' : 'Live'}
                          </button>
                        ))}
                      </div>
                    </Field>
                  </div>
                  {scriptChain(draft) !== 'solana' && (
                    <div className="text-body text-krypt-muted flex items-start gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-krypt-warn" />
                      <span>
                        On {chainLabel(scriptChain(draft))} a script sees only what that chain&rsquo;s scanner measures — buyers, buys,
                        sells, curve progress, whether the creator sold, and money only when the curve is quoted in the chain&rsquo;s own
                        coin. There is no Krypt score, no risk flags and no holder or creator history, so those conditions are not
                        offered, and advanced orders and alerts are Solana-only. Paper works: the fill is modelled from the chain&rsquo;s
                        quoted price with the same fees a real buy pays, and refuses rather than inventing one when no price is known.
                      </span>
                    </div>
                  )}
                  {draft.mode === 'live' && (
                    <div className="text-body text-rose-200/90 flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                      {/* Saving disarms only on the paper → live TRANSITION. A script
                          already saved as live keeps its arming and restarts with the
                          new code the moment you save, which is the opposite of what
                          the old sentence promised. */}
                      {current?.mode === 'live'
                        ? current.enabled
                          ? 'This script is armed and live. Saving restarts it immediately with the new code — it stays armed.'
                          : nativeText('Live spends real SOL on its own. This script is already saved as live; arming is a separate confirmed switch.', scriptChain(draft))
                        : nativeText('Live spends real SOL on its own. Saving as live disarms the script; arming is a separate confirmed switch.', scriptChain(draft))}
                      {!liveEnabled && ' Live execution is off in Settings, so a live script would refuse every trade until it is on.'}
                    </div>
                  )}
                  {draft.mode === 'paper' && draft.kind === 'rules' && draft.rules.actions.some((a) => ['stop_loss', 'take_profit', 'trailing_stop', 'limit_buy', 'limit_sell', 'apply_template'].includes(a.type)) && (
                    <div className="text-body text-amber-200/90">Advanced orders execute for real, so a paper script records them on its log without placing them. Switch the script to live to place them.</div>
                  )}

                  {/* Budget */}
                  <div className="grid grid-cols-5 gap-3">
                    <Field label="Max per trade" hint={nativeSymbolOf(scriptChain(draft))}>
                      <input type="number" step="0.01" value={draft.budget.maxSolPerTrade} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxSolPerTrade: Number(e.target.value) } })} className={inputCls} />
                    </Field>
                    <Field label="Buys per day">
                      <input type="number" value={draft.budget.maxBuysPerDay} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxBuysPerDay: Number(e.target.value) } })} className={inputCls} />
                    </Field>
                    <Field label="Daily loss stop" hint={nativeSymbolOf(scriptChain(draft))}>
                      <input type="number" step="0.01" value={draft.budget.maxLossSolPerDay} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxLossSolPerDay: Number(e.target.value) } })} className={inputCls} />
                    </Field>
                    <Field label="Open positions">
                      <input type="number" value={draft.budget.maxOpenPositions} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxOpenPositions: Number(e.target.value) } })} className={inputCls} />
                    </Field>
                    <Field label="Actions / min">
                      <input type="number" value={draft.budget.maxActionsPerMinute} onChange={(e) => setDraft({ ...draft, budget: { ...draft.budget, maxActionsPerMinute: Number(e.target.value) } })} className={inputCls} />
                    </Field>
                  </div>
                  <div className="text-body text-krypt-muted">
                    Every action a script takes is checked against this budget in the app, not in the script. A buy over the cap is refused, not shrunk. Past the daily loss stop the script turns itself off.
                    {' '}
                    <button className="underline text-krypt-muted hover:text-white" onClick={() => setDraft({ ...draft, budget: { ...DEFAULT_BUDGET } })}>
                      Reset to defaults
                    </button>
                  </div>
                </Card>

                {draft.kind === 'rules' ? (
                  <RulesEditor draft={draft} setDraft={setDraft} templates={snap?.templates ?? []} />
                ) : (
                  <CodeEditor draft={draft} setDraft={setDraft} onReference={openReference} />
                )}

                {current && snap && <ScriptLog lines={snap.logs[current.id] ?? []} stats={snap.stats[current.id]} coin={nativeSymbolOf(scriptChain(current))} />}
              </>
            )}
          </div>
        </div>
      )}
      {/* The settings this script asks for. An overlay because it is a step in
          RUNNING the script rather than part of writing it: be asked, answer,
          go. Nothing is saved until Done. */}
      {/* Trading from your OTHER wallets by address — the only multi-wallet
          path since the Copier was removed (2026-09-22), so its acknowledgement
          lives here. */}
      {view === 'scripts' && <MultiWalletConsent />}

      {askingInputs && draft && (
        <ScriptInputsDialog
          specs={inputs.specs}
          values={draft.inputs}
          onClose={() => {
            setAskingInputs(false);
            setArmAfterInputs(false);
          }}
          onDone={(next) => {
            const answered = { ...draft, inputs: next };
            setDraft(answered);
            setAskingInputs(false);
            if (!armAfterInputs) return;
            setArmAfterInputs(false);
            // Opened by pressing On, so finish the job: the answers have to be
            // SAVED before arming (the engine starts the stored script, not
            // the draft on screen), and a form left incomplete arms nothing.
            void (async () => {
              if (inputsProblem(inputs.specs, next)) {
                toast.info('Fill in the rest and press On again.');
                return;
              }
              if (!(await save(answered))) return;
              const saved = current ?? null;
              if (saved) await toggle({ ...saved, ...answered } as UserScript, true);
            })();
          }}
        />
      )}
    </Page>
  );
}

// ── Reference ─────────────────────────────────────────────────────────
//
// Everything a person reads rather than edits: the AI prompt, the bot API,
// the variable guide and the examples. It used to hang off the code editor
// as side panels; a script is written once and read up on often, so it has
// its own view.

const REF_TABS: Array<[RefTab, string]> = [
  ['prompt', 'AI prompt'],
  ['api', 'Bot API'],
  ['vars', 'Variables'],
  ['examples', 'Examples'],
];

function ReferenceView({ tab, setTab, chain, onUseExample }: { tab: RefTab; setTab: (t: RefTab) => void; chain: ChainKind; onUseExample: (ex: { name: string; code: string }) => void }) {
  const toast = useToast();
  const [guideChain, setGuideChain] = useState<ChainKind>(chain);
  const copyPrompt = async (): Promise<void> => {
    const ok = await copyText(aiPromptPack());
    if (ok) toast.success('AI prompt copied — paste it into any assistant, then describe what you want the script to do.');
    else toast.error('Could not reach the clipboard');
  };
  const copyGuide = async (): Promise<void> => {
    const ok = await copyText(fieldGuideText());
    toast[ok ? 'success' : 'error'](ok ? 'Variable guide copied' : 'Could not reach the clipboard');
  };
  const copyApi = async (): Promise<void> => {
    const ok = await copyText(SCRIPT_API_DOC);
    toast[ok ? 'success' : 'error'](ok ? 'Bot API copied' : 'Could not reach the clipboard');
  };
  return (
    <div className="space-y-4">
      <div className="flex rounded-lg border border-white/10 overflow-hidden w-fit" role="tablist" aria-label="Reference sections">
        {REF_TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cls('px-3 py-1.5 text-body font-semibold transition', tab === id ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'prompt' && (
        <Card className="space-y-3 max-w-3xl">
          <div className="text-sm font-semibold text-white">Let an assistant write the script</div>
          <p className="text-body text-krypt-muted">
            The prompt carries the whole bot API, every variable with when it is null, the events, the budget rules and the sandbox’s limits — everything an assistant needs to write a script that runs here first time. Copy it, paste it into any assistant, describe what you want in plain words, then paste the script it gives you into a new script’s editor and save.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={() => void copyPrompt()} className="!py-2 text-xs">
              <Clipboard className="h-3.5 w-3.5" /> Copy AI prompt
            </PrimaryButton>
            <GhostButton onClick={() => void copyGuide()} className="!py-2 text-xs">
              Copy variable guide only
            </GhostButton>
            <GhostButton onClick={() => void copyApi()} className="!py-2 text-xs">
              Copy bot API only
            </GhostButton>
          </div>
          <p className="text-label text-krypt-muted/70">Unknown facts are null, never zero — a script that treats null as 0 buys on nothing. The prompt says so; a good assistant will guard for it.</p>
        </Card>
      )}

      {tab === 'api' && (
        <Card className="overflow-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-label uppercase tracking-label text-krypt-muted">The bot API — what a script can ask the app to do, and what it gets back</div>
            <GhostButton onClick={() => void copyApi()} className="!py-0.5 !px-2 text-body">
              Copy
            </GhostButton>
          </div>
          <pre className="font-mono text-body leading-5 text-krypt-muted whitespace-pre-wrap">{SCRIPT_API_DOC}</pre>
        </Card>
      )}

      {tab === 'vars' && (
        <Card className="overflow-auto space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-label uppercase tracking-label text-krypt-muted">Variable guide — every field a script or rule can see, and when it is null</div>
            <div className="flex items-center gap-2">
              <div className="w-64">
                <ChainTabs value={guideChain} onChange={setGuideChain} />
              </div>
              <GhostButton onClick={() => void copyGuide()} className="!py-0.5 !px-2 text-body">
                Copy
              </GhostButton>
            </div>
          </div>
          <VariableGuide guideChain={guideChain} />
        </Card>
      )}

      {tab === 'examples' && (
        <Card padded={false} className="divide-y divide-white/5 max-w-3xl">
          {SCRIPT_EXAMPLES.map((ex) => (
            <div key={ex.name} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white">{ex.name}</div>
                <div className="text-body text-krypt-muted">{ex.description}</div>
                <div className="mt-1 text-label font-mono text-krypt-muted/60">{ex.code.split('\n').length} lines</div>
              </div>
              <GhostButton onClick={() => onUseExample(ex)} className="!py-1 !px-3 text-xs flex-shrink-0">
                <Code2 className="h-3.5 w-3.5" /> Use it
              </GhostButton>
            </div>
          ))}
        </Card>
      )}
    </div>
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
  // A chain that cannot measure a fact must not offer a condition on it: an
  // unknown never satisfies a rule, so such a rule would look armed and never
  // once fire. Same for actions with no implementation on the rail.
  const chain = scriptChain(draft);
  // Every label, hint and unit in the model is written in SOL because the
  // field IDS are a stored rule's schema. What the user reads follows the
  // chain they are actually on.
  const coinText = (text: string): string => nativeFieldLabel(text, chain, nativeSymbolOf(chain));
  const fieldsFor = RULE_FIELDS.filter((f) => scopes.includes(f.scope) && fieldAvailableOn(f.id, chain));
  const actionsFor = RULE_ACTIONS.filter(
    (a) =>
      actionAvailableOn(a.id, chain) &&
      (r.trigger === 'schedule' ? !a.needsMint : !(r.trigger === 'position' && (a.id === 'buy' || a.id === 'limit_buy'))),
  );

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
              {RULE_TRIGGERS.filter((t) => triggerAvailableOn(t.id, chain)).map((t) => (
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
          <div className="text-label uppercase tracking-label text-krypt-muted mb-2">And all of these hold (an unknown value never does)</div>
          <div className="space-y-2">
            {r.conditions.map((c, i) => {
              const f = RULE_FIELDS.find((x) => x.id === c.field);
              const kind = f?.kind ?? 'number';
              return (
                <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                  <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value as RuleField })} className={selectCls} title={f ? `${coinText(f.hint || f.label)} · ${coinText(f.unit)} · null when ${f.nullWhen}` : ''}>
                    {fieldsFor.map((x) => (
                      <option key={x.id} value={x.id}>
                        {coinText(x.label)}
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
                    <span className="text-body text-krypt-muted">{coinText(f?.hint || f?.unit || '')}</span>
                  ) : (
                    <input
                      type={kind === 'number' ? 'number' : 'text'}
                      step="any"
                      value={c.value}
                      onChange={(e) => setCond(i, { value: kind === 'number' ? Number(e.target.value) : e.target.value })}
                      placeholder={coinText(f?.unit ?? '')}
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
          <div className="text-label uppercase tracking-label text-krypt-muted mb-2">Then</div>
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
                <ActionParams a={a} set={(next) => setAction(i, next)} templates={templates} chain={chain} />
                <GhostButton onClick={() => setRules({ actions: r.actions.filter((_, j) => j !== i) })} className="!py-1 !px-2 text-xs">
                  ✕
                </GhostButton>
              </div>
            ))}
            <GhostButton onClick={() => setRules({ actions: [...r.actions, defaultActionFor('log')] })} className="!py-1 !px-2 text-xs">
              <Plus className="h-3 w-3" /> Action
            </GhostButton>
          </div>
          <div className="mt-2 text-body text-krypt-muted">Messages may use {'{symbol}'}, {'{mint}'}, {'{score}'}, {'{pnlPct}'} and any other field name. Hover a field for its unit and when it is unknown.</div>
        </div>
      </Card>
    </Section>
  );
}

function ActionParams({ a, set, templates, chain }: { a: RuleAction; set: (a: RuleAction) => void; templates: Array<{ id: string; name: string }>; chain: ChainKind }) {
  const coin = nativeSymbolOf(chain);
  const hint = nativeText(RULE_ACTIONS.find((x) => x.id === a.type)?.hint ?? '', chain);
  switch (a.type) {
    case 'buy':
      return <input type="number" step="0.01" value={a.sol} onChange={(e) => set({ type: 'buy', sol: Number(e.target.value) })} className={inputCls} placeholder={coin} />;
    case 'sell':
      return <input type="number" value={a.pct} onChange={(e) => set({ type: 'sell', pct: Number(e.target.value) })} className={inputCls} placeholder="% of what is held" />;
    case 'stop_loss':
    case 'trailing_stop':
      return (
        <div className="flex items-center gap-2">
          <input type="number" value={a.pct} onChange={(e) => set({ type: a.type, pct: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
          <span className="text-body text-krypt-muted">% {a.type === 'stop_loss' ? 'below the price now' : 'below the peak'} — sells all</span>
        </div>
      );
    case 'take_profit':
      return (
        <div className="flex items-center gap-2">
          <span className="text-body text-krypt-muted">up</span>
          <input type="number" value={a.gainPct} onChange={(e) => set({ ...a, gainPct: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
          <span className="text-body text-krypt-muted">% → sell</span>
          <input type="number" value={a.sellPct} onChange={(e) => set({ ...a, sellPct: Number(e.target.value) })} className={cls(inputCls, 'w-20')} />
          <span className="text-body text-krypt-muted">%</span>
        </div>
      );
    case 'limit_buy':
    case 'limit_sell':
      return (
        <div className="flex items-center gap-2">
          <select value={a.basis} onChange={(e) => set({ ...a, basis: e.target.value as 'mcap_usd' | 'price_sol' })} className={selectCls}>
            <option value="mcap_usd">market cap USD</option>
            <option value="price_sol">price {coin}</option>
          </select>
          <input type="number" step="any" value={a.value} onChange={(e) => set({ ...a, value: Number(e.target.value) })} className={cls(inputCls, 'w-32')} placeholder="level" />
          {a.type === 'limit_buy' ? (
            <>
              <span className="text-body text-krypt-muted">→ buy</span>
              <input type="number" step="0.01" value={a.sol} onChange={(e) => set({ ...a, sol: Number(e.target.value) })} className={cls(inputCls, 'w-24')} />
              <span className="text-body text-krypt-muted">{coin}</span>
            </>
          ) : (
            <>
              <span className="text-body text-krypt-muted">→ sell</span>
              <input type="number" value={a.pct} onChange={(e) => set({ ...a, pct: Number(e.target.value) })} className={cls(inputCls, 'w-20')} />
              <span className="text-body text-krypt-muted">%</span>
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
      return <span className="text-body text-krypt-muted">{hint}</span>;
  }
}

// ── Code editor ───────────────────────────────────────────────────────

function CodeEditor({ draft, setDraft, onReference }: { draft: Draft; setDraft: (d: Draft) => void; onReference: (t: RefTab) => void }) {
  const toast = useToast();
  const copyPrompt = async (): Promise<void> => {
    const ok = await copyText(aiPromptPack());
    if (ok) toast.success('AI prompt copied — paste it into any assistant, then describe what you want the script to do.');
    else toast.error('Could not reach the clipboard');
  };
  return (
    <Section
      title="Script"
      description="JavaScript, run in a sandbox with no network, no files and no keys. It can only ask the app to act, and the app checks every ask against the budget above."
    >
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
            <GhostButton onClick={() => onReference('api')} className="!py-1 !px-2 text-xs">
              <BookOpen className="h-3.5 w-3.5" /> API
            </GhostButton>
            <GhostButton onClick={() => onReference('vars')} className="!py-1 !px-2 text-xs">
              Variables
            </GhostButton>
          </div>
        </div>
        <textarea
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          spellCheck={false}
          className={cls(inputCls, 'font-mono text-note leading-5 min-h-[380px] resize-y')}
        />
        <div className="text-body text-krypt-muted flex items-center gap-2">
          <Play className="h-3 w-3" /> Save, then switch it on at the top. A stuck handler is killed (one still awaiting the app gets up to 30 s); five errors in a row turn the script off. Unknown facts are null, never zero.
        </div>
      </Card>
    </Section>
  );
}

function VariableGuide({ guideChain = 'solana' as ChainKind }: { guideChain?: ChainKind }) {
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
    <div className="space-y-3 text-body">
      <div className="text-krypt-muted">
        Always present: <code className="text-white/80">mint</code>, <code className="text-white/80">symbol</code>, <code className="text-white/80">name</code>, <code className="text-white/80">priceHistory</code> ({nativeSymbolOf(guideChain)}, oldest first).
      </div>
      {groups
        .filter(([scope]) => RULE_FIELDS.some((f) => f.scope === scope && fieldAvailableOn(f.id, guideChain)))
        .map(([scope, title]) => (
        <div key={scope}>
          <div className="text-label uppercase tracking-label text-krypt-muted/80 mb-1">{title}</div>
          <table className="w-full">
            <tbody>
              {RULE_FIELDS.filter((f) => f.scope === scope && fieldAvailableOn(f.id, guideChain)).map((f) => (
                <tr key={f.id} className="border-t border-white/5 align-top">
                  <td className="py-1 pr-2 font-mono text-white/85 whitespace-nowrap">{f.id}</td>
                  <td className="py-1 pr-2 text-krypt-muted/80 whitespace-nowrap">{f.kind}</td>
                  <td className="py-1 text-krypt-muted">
                    {nativeFieldLabel(f.hint || f.label, guideChain, nativeSymbolOf(guideChain))}
                    {f.unit ? ` · ${nativeFieldLabel(f.unit, guideChain, nativeSymbolOf(guideChain))}` : ''}
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

function ScriptLog({ lines, stats, coin }: { lines: ScriptLogLine[]; stats?: ScriptStats; coin: string }) {
  return (
    <Section
      title="Log"
      description={stats ? `Last run ${fmtAgo(stats.lastRunAt)} · today ${stats.buysToday} buys, ${stats.sellsToday} sells, ${stats.realizedSolToday >= 0 ? '+' : ''}${stats.realizedSolToday.toFixed(4)} ${coin} realised · ${stats.openCount} open · fired on ${stats.firedMints} tokens${stats.lastError ? ` · last error${stats.lastErrorAt ? ` ${fmtAgo(stats.lastErrorAt)} ago` : ''}: ${stats.lastError}` : ''}` : ''}
    >
      <Card padded={false} className="max-h-[320px] overflow-auto">
        {lines.length === 0 ? (
          <div className="p-4 text-xs text-krypt-muted">Nothing yet.</div>
        ) : (
          <div className="font-mono text-body">
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
