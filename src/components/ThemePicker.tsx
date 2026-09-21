// The look and accent pickers.
//
// Two axes (2026-09-20). A LOOK moves the fonts, the surfaces, the corner
// radius and the effects — Classic's engraved plates and serif headings,
// Futuristic's sharp grid, Minimal's flat quiet, Hacker's black screen and
// scanlines. An ACCENT moves one colour. They combine freely, and neither
// touches the colours that carry meaning.
//
// Each swatch and each preview is painted from the theme's OWN values rather
// than from the active ones, so the row shows you what you are about to get
// instead of five copies of what you already have. That is why the styles
// are inline: Tailwind classes resolve against `:root`, and these need to
// resolve against themselves. The literals are duplicated from index.css on
// purpose and pinned by test/theme.test.mjs.
//
// `Row` and `LookRow` are at module scope. A component declared inside
// another component gets a new type on every render, React remounts it, and
// clicks that start on the old element never land — which is exactly the bug
// the language picker shipped with (2026-09-18).

import { Check } from 'lucide-react';
import { SKINS, SKIN_META, THEMES, THEME_META, type SkinId, type ThemeId } from '@shared/theme';
import { useAppState } from '../state/AppStateProvider';
import { cls } from '../utils/format';

/** The accent each theme paints with, mirroring src/index.css. */
const SWATCH: Record<ThemeId, { accent: string; soft: string }> = {
  purple: { accent: 'rgb(139 124 232)', soft: 'rgb(183 166 255)' },
  blue: { accent: 'rgb(56 148 235)', soft: 'rgb(137 195 255)' },
  red: { accent: 'rgb(232 106 76)', soft: 'rgb(255 160 134)' },
  green: { accent: 'rgb(45 178 160)', soft: 'rgb(120 226 210)' },
  grey: { accent: 'rgb(150 156 174)', soft: 'rgb(196 201 214)' },
};

/** What each look paints its surfaces with, mirroring the `html[data-skin]`
 *  blocks in src/index.css. The preview is a real little panel in the look's
 *  own fonts, so a person sees the character, not a colour dot. */
const LOOK: Record<SkinId, { bg: string; panel: string; text: string; radius: string; display: string; sans: string }> = {
  classic: { bg: 'rgb(6 7 15)', panel: 'rgb(10 13 26)', text: 'rgb(240 237 226)', radius: '8px', display: 'Cinzel, Georgia, serif', sans: "'Spline Sans', system-ui, sans-serif" },
  futuristic: { bg: 'rgb(4 8 14)', panel: 'rgb(7 13 22)', text: 'rgb(226 238 247)', radius: '3px', display: 'Orbitron, sans-serif', sans: 'Rajdhani, sans-serif' },
  minimal: { bg: 'rgb(10 10 12)', panel: 'rgb(16 16 19)', text: 'rgb(236 236 236)', radius: '10px', display: 'Inter, system-ui, sans-serif', sans: 'Inter, system-ui, sans-serif' },
  hacker: { bg: 'rgb(0 0 0)', panel: 'rgb(3 6 3)', text: 'rgb(214 236 214)', radius: '0px', display: 'VT323, monospace', sans: "'Share Tech Mono', monospace" },
  retro: { bg: 'rgb(12 8 28)', panel: 'rgb(20 14 44)', text: 'rgb(240 236 255)', radius: '0px', display: "'Press Start 2P', monospace", sans: "'Share Tech Mono', monospace" },
  xp: { bg: 'rgb(232 238 248)', panel: 'rgb(255 255 255)', text: 'rgb(20 28 46)', radius: '6px', display: "'Trebuchet MS', Tahoma, sans-serif", sans: 'Tahoma, Verdana, sans-serif' },
};

/** A look that reads best with a particular accent brings it along — but
 *  only while the accent is still the default, so a colour someone chose on
 *  purpose is never overwritten by picking a look. */
const PAIRS: Partial<Record<SkinId, ThemeId>> = { hacker: 'green', futuristic: 'blue', xp: 'blue' };

function LookRow({ id, chosen, accent, onPick }: { id: SkinId; chosen: boolean; accent: string; onPick: (id: SkinId) => void }) {
  const meta = SKIN_META[id];
  const look = LOOK[id];
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className={cls(
        'flex w-full items-stretch gap-3 rounded-lg border p-2 text-left transition',
        chosen ? 'bg-white/[0.06]' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]',
      )}
      style={chosen ? { borderColor: accent } : undefined}
    >
      {/* The preview: the look's own background, a panel in its own surface
          colour and corner radius, a heading in its display font and a line
          in its body font, with the CURRENT accent as the one coloured thing. */}
      <span aria-hidden="true" className="flex w-24 shrink-0 items-center justify-center overflow-hidden rounded" style={{ background: look.bg, borderRadius: look.radius }}>
        <span className="flex w-20 flex-col gap-1 px-2 py-1.5" style={{ background: look.panel, border: `1px solid ${look.text.replace(')', ' / 0.16)')}`, borderRadius: look.radius, color: look.text }}>
          <span style={{ fontFamily: look.display, fontSize: id === 'hacker' ? 15 : id === 'retro' ? 9 : 12, lineHeight: 1.1 }}>{id === 'futuristic' || id === 'retro' ? 'AA' : 'Aa'}</span>
          <span style={{ fontFamily: look.sans, fontSize: 9, opacity: 0.85 }}>0.5% · 12.3K</span>
          <span className="block h-1 w-8 rounded-full" style={{ background: accent, borderRadius: look.radius }} />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-semibold text-white/90">{meta.label}</span>
          {chosen && <Check className="h-4 w-4 shrink-0" style={{ color: accent }} />}
        </span>
        <span className="block text-nano leading-snug text-krypt-muted">{meta.note}</span>
        <span className="block truncate text-nano text-krypt-muted/70">{meta.fonts}</span>
      </span>
    </button>
  );
}

function Row({ id, chosen, onPick }: { id: ThemeId; chosen: boolean; onPick: (id: ThemeId) => void }) {
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
  const skin: SkinId = settings.skin ?? 'classic';
  const accent = SWATCH[current].accent;
  const pickSkin = (next: SkinId): void => {
    const paired = current === 'purple' ? PAIRS[next] : undefined;
    void updateSettings(paired ? { skin: next, theme: paired } : { skin: next });
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-label uppercase tracking-label text-krypt-muted">Look</div>
        <p className="text-body leading-relaxed text-krypt-muted">
          Fonts, surfaces, corners and effects. Whatever the look, green for up, red for down and gold for anything about your money stay exactly where they are — on a trading screen those are data, not decoration.
        </p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {SKINS.map((id) => (
            <LookRow key={id} id={id} chosen={skin === id} accent={accent} onPick={pickSkin} />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-label uppercase tracking-label text-krypt-muted">Accent</div>
        <p className="text-body leading-relaxed text-krypt-muted">One colour, on any look. Hacker, Futuristic and XP bring a matching accent along the first time you pick them; change it here after.</p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {THEMES.map((id) => (
            <Row key={id} id={id} chosen={current === id} onPick={(next) => void updateSettings({ theme: next })} />
          ))}
        </div>
      </div>
    </div>
  );
}
