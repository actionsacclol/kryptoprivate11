// Auto-sell templates — the exit you decide once, armed on every buy.
//
// The orders this places are ordinary advanced orders: they show up on the
// same page, they can be cancelled, and the engine treats them exactly as it
// treats one you typed. That is the whole design. A template is not an
// automation that trades for you; it is the paperwork you would otherwise do
// by hand after every fill, which is why people skip it and then hold a bag
// with no stop.
//
// The card says what will be armed before you arm it, in the same words the
// Orders list will use afterwards.

import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  MAX_TAKE_PROFITS,
  describeTemplate,
  emptyTemplate,
  validateTemplate,
  type OrderTemplate,
} from '@shared/orderTemplates';
import { Card, GhostButton, NumberInput, PrimaryButton, Section, Switch } from '../common';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

const inputCls =
  'rounded-md border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60';

function Editor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: OrderTemplate;
  setDraft: (t: OrderTemplate) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const v = validateTemplate(draft);
  const patch = (p: Partial<OrderTemplate>): void => setDraft({ ...draft, ...p });

  return (
    <div className="rounded-lg border border-krypt-purple/40 bg-black/30 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          maxLength={40}
          placeholder="Template name"
          className={cls(inputCls, 'w-48')}
        />
        <div className="flex-1" />
        <PrimaryButton onClick={onSave} disabled={!v.ok} className="!py-1">
          <Check className="h-3.5 w-3.5" /> Save
        </PrimaryButton>
        <GhostButton onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </GhostButton>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-[11px] text-krypt-muted">
          <input
            type="checkbox"
            className="accent-krypt-purple"
            checked={draft.stopLossPct !== null}
            onChange={(e) => patch({ stopLossPct: e.target.checked ? 30 : null })}
          />
          Stop loss
          {draft.stopLossPct !== null && (
            <NumberInput value={draft.stopLossPct} min={1} max={99} onChange={(n) => patch({ stopLossPct: n })} suffix="%" className="w-24" />
          )}
        </label>
        <label className="flex items-center gap-2 text-[11px] text-krypt-muted">
          <input
            type="checkbox"
            className="accent-krypt-purple"
            checked={draft.trailingPct !== null}
            onChange={(e) => patch({ trailingPct: e.target.checked ? 30 : null })}
          />
          Trailing stop
          {draft.trailingPct !== null && (
            <NumberInput value={draft.trailingPct} min={1} max={99} onChange={(n) => patch({ trailingPct: n })} suffix="%" className="w-24" />
          )}
        </label>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] text-krypt-muted">Take profits</span>
          <span className="text-[10px] text-krypt-muted/60">each sells a share of what is left at that point</span>
          <div className="flex-1" />
          {draft.takeProfits.length < MAX_TAKE_PROFITS && (
            <GhostButton
              onClick={() => {
                const last = draft.takeProfits[draft.takeProfits.length - 1];
                patch({ takeProfits: [...draft.takeProfits, { gainPct: last ? last.gainPct * 2 : 100, sellPct: 50 }] });
              }}
              className="!py-0.5"
            >
              <Plus className="h-3 w-3" /> Add
            </GhostButton>
          )}
        </div>
        <div className="space-y-1.5">
          {draft.takeProfits.map((tp, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 text-[11px] text-krypt-muted/60">{i + 1}</span>
              <span className="text-[11px] text-krypt-muted">at</span>
              <NumberInput
                value={tp.gainPct}
                min={1}
                max={100000}
                onChange={(n) => patch({ takeProfits: draft.takeProfits.map((x, j) => (j === i ? { ...x, gainPct: n } : x)) })}
                suffix="%"
                className="w-28"
              />
              <span className="text-[11px] text-krypt-muted">sell</span>
              <NumberInput
                value={tp.sellPct}
                min={1}
                max={100}
                onChange={(n) => patch({ takeProfits: draft.takeProfits.map((x, j) => (j === i ? { ...x, sellPct: n } : x)) })}
                suffix="%"
                className="w-24"
              />
              <GhostButton onClick={() => patch({ takeProfits: draft.takeProfits.filter((_, j) => j !== i) })} destructive className="!py-0.5">
                <Trash2 className="h-3 w-3" />
              </GhostButton>
            </div>
          ))}
          {!draft.takeProfits.length && <div className="text-[11px] text-krypt-muted/50">No take profits — the stop is the only exit.</div>}
        </div>
      </div>

      <Switch
        checked={draft.sellOnDevSell}
        onChange={(b) => patch({ sellOnDevSell: b })}
        label="Exit if the creator sells"
        description="The one launch signal with a measured edge in our own data"
      />

      {!v.ok && <div className="text-[11px] text-rose-300">{v.message}</div>}
    </div>
  );
}

export function TemplatePanel() {
  const toast = useToast();
  const [templates, setTemplates] = useState<OrderTemplate[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<OrderTemplate | null>(null);

  const apply = (r: { ok: boolean; message: string; data?: { templates: OrderTemplate[]; activeId: string | null } }): void => {
    if (r.ok && r.data) {
      setTemplates(r.data.templates);
      setActiveId(r.data.activeId);
    } else if (!r.ok) toast.error(r.message);
  };

  useEffect(() => {
    void window.krypt.templates.list().then(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setActive = async (id: string | null): Promise<void> => {
    const r = await window.krypt.templates.setActive(id);
    apply(r);
    if (r.ok) toast.success(r.message);
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    const r = await window.krypt.templates.save(draft);
    apply(r);
    if (r.ok) {
      toast.success(r.message);
      setDraft(null);
    }
  };

  const active = templates.find((t) => t.id === activeId) ?? null;

  return (
    <Section
      title="Auto-sell"
      description="Arm the same exit on every buy you place by hand, instead of writing it out per token. These become ordinary orders in the list below — you can see them, change them and cancel them. Nothing here opens a position."
    >
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-krypt-muted">On every manual buy:</span>
          <select
            value={activeId ?? ''}
            onChange={(e) => void setActive(e.target.value || null)}
            className="rounded-md border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60"
          >
            <option value="">Arm nothing (off)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {active ? (
            <span className="font-mono text-[11px] text-arc-gold">{describeTemplate(active)}</span>
          ) : (
            <span className="text-[11px] text-krypt-muted/60">A buy arms nothing; write your own exits below.</span>
          )}
          <div className="flex-1" />
          {!draft && (
            <GhostButton onClick={() => setDraft(emptyTemplate(`t_${Date.now().toString(36)}`))}>
              <Plus className="h-3.5 w-3.5" /> New template
            </GhostButton>
          )}
        </div>

        {draft && <Editor draft={draft} setDraft={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} />}

        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {templates.map((t) => {
            const builtIn = t.id.startsWith('builtin-');
            return (
              <div
                key={t.id}
                className={cls(
                  'rounded-lg border px-3 py-2',
                  t.id === activeId ? 'border-krypt-purple/50 bg-krypt-purple/10' : 'border-white/10 bg-white/[0.02]',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-white">{t.name}</span>
                  {builtIn && <span className="text-[9px] uppercase tracking-wider text-krypt-muted/60">built in</span>}
                  <div className="flex-1" />
                  <GhostButton onClick={() => setDraft({ ...t })} className="!py-0.5">
                    <Pencil className="h-3 w-3" />
                  </GhostButton>
                  {!builtIn && (
                    <GhostButton
                      onClick={() => void window.krypt.templates.remove(t.id).then(apply)}
                      destructive
                      className="!py-0.5"
                    >
                      <Trash2 className="h-3 w-3" />
                    </GhostButton>
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-krypt-muted">{describeTemplate(t)}</div>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-krypt-muted/60">
          These orders execute later, without a click at that moment — that is what a stop is for. They are gated on the
          same switches as a manual trade, they survive a restart PAUSED (never silently re-armed), and buying the same
          token twice does not arm a second ladder.
        </p>
      </Card>
    </Section>
  );
}
