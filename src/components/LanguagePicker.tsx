// The language picker — one component, used in Settings and in onboarding.
//
// Each row leads with the language's ENDONYM: nobody scanning for their own
// language looks for the word "Korean". The English name is the second line,
// for the person setting the app up for someone else.
//
// A language that is not fully translated says so, with the share that is
// done. Someone choosing a partial language should know that going in rather
// than finding out one English screen at a time — and it is the same rule the
// rest of this app follows about not implying more than it knows.

import { Check } from 'lucide-react';
import { LOCALES, coverage, type LocaleId } from '@shared/i18n';
import { useLocale } from '../state/useLocale';
import { cls } from '../utils/format';

/**
 * One language row.
 *
 * At MODULE scope, deliberately. It lived inside LanguagePicker and every
 * render created a new component type, so React unmounted and remounted all
 * nine buttons on each settings change - and a click whose mousedown landed
 * on the old element never completed on the new one. The picker took two or
 * three tries to register (user report, 2026-09-18). A component defined
 * inside another component is always this bug waiting to happen.
 */
function Row({
  id,
  endonym,
  english,
  chosen,
  inUse,
  done,
  onPick,
}: {
  id: LocaleId;
  endonym: string;
  english: string;
  chosen: boolean;
  inUse: boolean;
  done: number;
  onPick: (id: LocaleId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className={cls(
        'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition',
        chosen
          ? 'border-krypt-purple/60 bg-krypt-purple/15'
          : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-white/90">{endonym}</span>
        <span className="block truncate text-nano text-krypt-muted">
          {english}
          {inUse && ' · in use'}
          {/* Only ever shown when it is NOT 100%: a badge saying "complete"
              on every finished language is noise. */}
          {done < 1 && ` · ${Math.round(done * 100)}% translated`}
        </span>
      </span>
      {chosen && <Check className="h-4 w-4 shrink-0 text-krypt-purple" />}
    </button>
  );
}

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { setting, active, t, set } = useLocale();
  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-body leading-relaxed text-krypt-muted">{t('lang.hint')}</p>
      )}
      <div className={cls('grid gap-1.5', compact ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2')}>
        <Row
          id="system"
          endonym={t('lang.system')}
          english="Match my system"
          chosen={setting === 'system'}
          inUse={false}
          done={1}
          onPick={set}
        />
        {LOCALES.map((l) => (
          <Row
            key={l.id}
            id={l.id}
            endonym={l.endonym}
            english={l.english}
            chosen={setting === l.id}
            inUse={setting === 'system' && l.id === active}
            done={coverage(l.id)}
            onPick={set}
          />
        ))}
      </div>
    </div>
  );
}
