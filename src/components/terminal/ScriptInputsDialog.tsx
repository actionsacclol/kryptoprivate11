// The settings a script asks for, as a form.
//
// A code script declares what it needs in an `@inputs` block at the top of its
// own source (see shared/scriptInputs.ts) and reads the answers from
// `bot.input`. This is where they are answered — so one script can be pointed
// at a different coin, a different wallet or different ranges without anyone
// editing code, which is what a script with five numbers hardcoded into it
// always ends up needing.
//
// An overlay rather than another panel in the editor, because it is a step in
// running the script rather than part of writing it: the point is to be asked,
// answer, and go. Escape and the backdrop both close it; nothing is saved
// until Done, so a half-filled form that gets dismissed changes nothing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import {
  coerceInputs,
  defaultsFor,
  inputsProblem,
  parseInputs,
  type ScriptInputSpec,
  type ScriptInputSpecs,
  type ScriptInputValues,
} from '@shared/scriptInputs';
import { webhookUrlProblem } from '@shared/webhook';
import { GhostButton, NumberInput, PrimaryButton, Switch, TextInput } from '../common';
import { cls, shortAddr } from '../../utils/format';
import type { WalletSummary } from '@shared/types';

/** The fields a script's code asks for, and whether they are answered. */
export function useScriptInputs(code: string, values: ScriptInputValues | undefined) {
  return useMemo(() => {
    const { specs, error } = parseInputs(code);
    const count = Object.keys(specs).length;
    return {
      specs,
      error,
      count,
      problem: count > 0 ? inputsProblem(specs, values ?? {}) : null,
    };
  }, [code, values]);
}

export function ScriptInputsDialog({
  specs,
  values,
  onDone,
  onClose,
}: {
  specs: ScriptInputSpecs;
  values: ScriptInputValues | undefined;
  onDone: (next: ScriptInputValues) => void;
  onClose: () => void;
}) {
  // Start from the answers already given, with the script's own defaults
  // filling anything it has never been asked.
  const [draft, setDraft] = useState<ScriptInputValues>(() => ({ ...defaultsFor(specs), ...(values ?? {}) }));
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [accounts, setAccounts] = useState<Array<{ address: string; username: string | null }>>([]);
  const panel = useRef<HTMLDivElement>(null);

  const needsWallets = Object.values(specs).some((s) => s.type === 'wallet');
  const needsAccounts = Object.values(specs).some((s) => s.type === 'pumpAccounts');

  useEffect(() => {
    if (needsWallets) void window.krypt.wallet.list().then((r) => r.ok && r.data && setWallets(r.data));
    if (needsAccounts) {
      void window.krypt.pump.status().then((r) => {
        if (r.ok && r.data) setAccounts(r.data.sessions.map((s) => ({ address: s.address, username: s.username })));
      });
    }
  }, [needsWallets, needsAccounts]);

  // Escape closes, and focus starts inside — a dialog that traps neither is
  // one the keyboard cannot leave.
  //
  // Focus is taken ONCE, on open. It used to sit in an effect keyed on
  // `onClose`, which the Scripts page passes inline — a new function on every
  // render, and that page re-renders about once a second while scripts run
  // (their log and stats). So the effect re-ran and pulled focus back to the
  // panel, out of whatever box was being typed in: the fields could not be
  // edited at all (2026-09-23). The Escape handler reads the latest onClose
  // through a ref instead of re-subscribing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }));
  const problem = inputsProblem(specs, draft);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Script settings"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-white/10 bg-krypt-panel p-4 shadow-2xl outline-none"
      >
        <div className="mb-3 flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-krypt-purple" />
          <span className="text-value font-semibold text-white">This script needs a few things</span>
          <div className="flex-1" />
          <GhostButton onClick={onClose} className="!py-1">
            <X className="h-4 w-4" />
          </GhostButton>
        </div>

        <div className="space-y-3">
          {Object.entries(specs).map(([key, spec]) => (
            <Field
              key={key}
              spec={spec}
              value={draft[key]}
              wallets={wallets}
              accounts={accounts}
              onChange={(v) => set(key, v)}
            />
          ))}
        </div>

        {problem && <p className="mt-3 text-body text-arc-gold/90">{problem}</p>}

        <div className="mt-4 flex items-center gap-2">
          {/* Saved even when incomplete: a half-answered form is worth keeping,
              and arming is what the missing answer actually blocks. */}
          <PrimaryButton onClick={() => onDone(coerceInputs(specs, draft))}>Done</PrimaryButton>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
        </div>
      </div>
    </div>
  );
}

function Field({
  spec,
  value,
  wallets,
  accounts,
  onChange,
}: {
  spec: ScriptInputSpec;
  value: unknown;
  wallets: WalletSummary[];
  accounts: Array<{ address: string; username: string | null }>;
  onChange: (v: unknown) => void;
}) {
  const range = Array.isArray(value) ? value : [];
  const selected = Array.isArray(value) ? value.map(String) : [];

  return (
    <div className="space-y-1">
      <span className="text-label text-krypt-muted">
        {spec.label}
        {spec.optional && <span className="text-krypt-muted/60"> · optional</span>}
      </span>

      {(spec.type === 'text' || spec.type === 'mint') && (
        <TextInput
          value={String(value ?? '')}
          onChange={onChange}
          mono={spec.type === 'mint'}
          placeholder={spec.type === 'mint' ? 'Token address' : ''}
        />
      )}

      {spec.type === 'webhook' && (
        <div className="space-y-1">
          {/* A password field: the last path segment is the webhook's
              credential, and this dialog gets screenshotted. */}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
          />
          {webhookUrlProblem(String(value ?? '')) && (
            <p className="text-label text-rose-300">{webhookUrlProblem(String(value ?? ''))}</p>
          )}
        </div>
      )}

      {spec.type === 'number' && (
        <NumberInput
          value={Number(value ?? 0)}
          onChange={onChange}
          step={spec.step ?? 1}
          min={spec.min ?? 0}
          max={spec.max ?? Number.MAX_SAFE_INTEGER}
        />
      )}

      {spec.type === 'range' && (
        <div className="flex flex-wrap items-center gap-2">
          <NumberInput
            value={Number(range[0] ?? 0)}
            onChange={(v) => onChange([v, Number(range[1] ?? 0)])}
            step={spec.step ?? 1}
            min={spec.min ?? 0}
            max={spec.max ?? Number.MAX_SAFE_INTEGER}
          />
          <span className="text-body text-krypt-muted">to</span>
          <NumberInput
            value={Number(range[1] ?? 0)}
            onChange={(v) => onChange([Number(range[0] ?? 0), v])}
            step={spec.step ?? 1}
            min={spec.min ?? 0}
            max={spec.max ?? Number.MAX_SAFE_INTEGER}
          />
        </div>
      )}

      {spec.type === 'lines' && (
        <textarea
          value={(Array.isArray(value) ? value : []).join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          rows={4}
          placeholder="One per line"
          className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
        />
      )}

      {spec.type === 'toggle' && (
        <Switch checked={value === true} onChange={(v) => onChange(v)} label={value === true ? 'On' : 'Off'} />
      )}

      {spec.type === 'select' && (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
        >
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}

      {spec.type === 'wallet' && (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
        >
          <option value="">Pick a wallet…</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.publicKey}>
              {w.label || 'Wallet'} · {shortAddr(w.publicKey)}
            </option>
          ))}
        </select>
      )}

      {spec.type === 'pumpAccounts' && (
        <div className="space-y-1 rounded-lg border border-white/10 bg-black/30 p-2">
          {accounts.length === 0 ? (
            <p className="text-label text-krypt-muted">
              No pump.fun accounts are signed in — Wallet page → pump.fun accounts.
            </p>
          ) : (
            accounts.map((a) => {
              const on = selected.includes(a.address);
              return (
                <button
                  key={a.address}
                  onClick={() => onChange(on ? selected.filter((x) => x !== a.address) : [...selected, a.address])}
                  className={cls(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-body transition',
                    on ? 'bg-krypt-purple/20 text-white' : 'text-krypt-muted hover:text-white',
                  )}
                >
                  <span className={cls('h-3 w-3 rounded-sm border', on ? 'border-krypt-purple bg-krypt-purple' : 'border-white/25')} />
                  <span className="truncate">{a.username || shortAddr(a.address)}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {spec.help && <p className="text-label leading-relaxed text-krypt-muted/70">{spec.help}</p>}
    </div>
  );
}
