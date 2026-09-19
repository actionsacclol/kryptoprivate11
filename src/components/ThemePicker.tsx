// The accent picker.
//
// Each swatch is painted from the theme's OWN variables rather than from the
// active ones, so the row shows you the colour you are about to get instead
// of five copies of the colour you already have. That is why the styles are
// inline: Tailwind classes resolve against `:root`, and these five need to
// resolve against themselves.
//
// `Row` is at module scope. A component declared inside another component
// gets a new type on every render, React remounts it, and clicks that start
// on the old element never land — which is exactly the bug the language
// picker shipped with (2026-09-18).

import { Check } from 'lucide-react';
import { THEMES, THEME_META, type ThemeId } from '@shared/theme';
import { useAppState } from '../state/AppStateProvider';
import { cls } from '../utils/format';

/** The accent each theme paints with, mirroring src/index.css. Duplicated on
 *  purpose and pinned by a test: the swatch has to be a literal colour, not a
 *  variable that would resolve to whatever is currently active. */
const SWATCH: Record<ThemeId, { accent: string; soft: string }> = {
  purple: { accent: 'rgb(139 124 232)', soft: 'rgb(183 166 255)' },
  blue: { accent: 'rgb(56 148 235)', soft: 'rgb(137 195 255)' },
  red: { accent: 'rgb(232 106 76)', soft: 'rgb(255 160 134)' },
  green: { accent: 'rgb(45 178 160)', soft: 'rgb(120 226 210)' },
  grey: { accent: 'rgb(150 156 174)', soft: 'rgb(196 201 214)' },
};

function Row({
  id,
  chosen,
  onPick,
}: {
  id: ThemeId;
  chosen: boolean;
  onPick: (id: ThemeId) => void;
}) {
  const meta = THEME_META[id];
  const sw = SWATCH[id];
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className={cls(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition',
        chosen ? 'bg-white/[0.06]' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]',
      )}
      style={chosen ? { borderColor: sw.accent } : undefined}
    >
      <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
        <span className="h-5 w-5 rounded-full" style={{ background: sw.accent }} />
        <span className="h-3 w-3 rounded-full" style={{ background: sw.soft }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-white/90">{meta.label}</span>
        <span className="block truncate text-nano text-krypt-muted">{meta.note}</span>
      </span>
      {chosen && <Check className="h-4 w-4 shrink-0" style={{ color: sw.accent }} />}
    </button>
  );
}

export function ThemePicker() {
  const { settings, updateSettings } = useAppState();
  const current: ThemeId = settings.theme ?? 'purple';
  return (
    <div className="space-y-2">
      <p className="text-body leading-relaxed text-krypt-muted">
        Changes the accent only. Green for up, red for down and gold for anything about your
        money stay exactly where they are — on a trading screen those are data, not decoration.
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {THEMES.map((id) => (
          <Row key={id} id={id} chosen={current === id} onPick={(next) => void updateSettings({ theme: next })} />
        ))}
      </div>
    </div>
  );
}
