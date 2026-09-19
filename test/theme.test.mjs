// Accent themes — the three things about them that can silently rot.
//
// 1. A theme that ships without a CSS block puts an attribute on <html> that
//    matches nothing, so the app renders with no accent and looks broken with
//    nothing to explain it.
// 2. The picker's swatches are LITERAL colours, duplicated from index.css on
//    purpose: a swatch painted from the active variables would show five
//    copies of the colour you already have. Duplication is the right call and
//    this is the thing that keeps it honest.
// 3. A theme must never move a colour that carries meaning. Emerald is "the
//    fill landed", rose and crimson are "it did not", gold is "this is about
//    your money". On a trading screen those are data. If a theme could repaint
//    them, a green accent and a green profit badge become the same thing.

import assert from 'node:assert';
import fs from 'node:fs';
import { THEMES, THEME_META, DEFAULT_THEME, isThemeId } from './.theme.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL('../src/components/ThemePicker.tsx', import.meta.url), 'utf8');
const tw = fs.readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8');

/** `--krypt-accent: 139 124 232;` inside the block for one theme. */
function accentOf(theme) {
  const sel = theme === DEFAULT_THEME ? `html\\[data-theme='${theme}'\\]` : `html\\[data-theme='${theme}'\\]`;
  const re = new RegExp(`${sel}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  assert.ok(m, `index.css has a block for the ${theme} theme`);
  const vars = {};
  for (const line of m[1].split('\n')) {
    const v = /--(krypt-[\w-]+):\s*([^;]+);/.exec(line);
    if (v) vars[v[1]] = v[2].trim();
  }
  return vars;
}

{
  for (const id of THEMES) {
    const vars = accentOf(id);
    for (const need of ['krypt-accent', 'krypt-accent-soft', 'krypt-indigo', 'krypt-grad-from', 'krypt-grad-to']) {
      assert.ok(vars[need], `${id} defines --${need}`);
      assert.match(vars[need], /^\d{1,3} \d{1,3} \d{1,3}$/, `${id} --${need} is space-separated channels, so <alpha-value> works`);
    }
    assert.ok(THEME_META[id], `${id} has a label and a note for the picker`);
  }
  ok(`all ${THEMES.length} themes define every variable, as RGB channels`);
}

{
  // The duplication check. A swatch that drifts from the CSS shows the user a
  // colour the app will not actually apply.
  for (const id of THEMES) {
    const vars = accentOf(id);
    for (const [cssVar, key] of [['krypt-accent', 'accent'], ['krypt-accent-soft', 'soft']]) {
      const want = `rgb(${vars[cssVar]})`;
      const re = new RegExp(`${id}:\\s*\\{[^}]*${key}:\\s*'([^']+)'`);
      const m = re.exec(picker);
      assert.ok(m, `ThemePicker has a ${key} swatch for ${id}`);
      assert.equal(m[1], want, `${id} ${key} swatch matches index.css`);
    }
  }
  ok('every picker swatch is the colour index.css will actually apply');
}

{
  // The accent is a variable in Tailwind, which is what makes 376 existing
  // `krypt-purple` usages themeable without touching one of them.
  assert.match(tw, /'krypt-purple':\s*'rgb\(var\(--krypt-accent\) \/ <alpha-value>\)'/, 'krypt-purple reads the variable');
  assert.match(tw, /'krypt-pink':\s*'rgb\(var\(--krypt-accent-soft\) \/ <alpha-value>\)'/, 'krypt-pink reads the variable');
  assert.ok(tw.includes('<alpha-value>'), 'opacity modifiers still resolve');
  ok('Tailwind resolves the accent through the variable, alpha intact');
}

{
  // The colours that mean something are literals, and stay literals.
  const SEMANTIC = [
    ["'arc-gold'", '#D9B45B'],
    ["'arc-crimson'", '#E5484D'],
  ];
  for (const [name, hex] of SEMANTIC) {
    const re = new RegExp(`${name}:\\s*'([^']+)'`);
    const m = re.exec(tw);
    assert.ok(m, `${name} is defined`);
    assert.equal(m[1], hex, `${name} is a fixed colour, not a themeable variable`);
  }
  // And no theme block may try to redefine one.
  for (const id of THEMES) {
    const vars = accentOf(id);
    for (const k of Object.keys(vars)) {
      assert.ok(
        !/gold|crimson|emerald|rose/i.test(k),
        `${id} must not repaint a colour that carries meaning (${k})`,
      );
    }
  }
  ok('gold, crimson and the up/down colours are fixed — a theme cannot repaint them');
}

{
  assert.ok(isThemeId('purple') && isThemeId('grey'));
  assert.ok(!isThemeId('chartreuse'));
  assert.ok(!isThemeId(''));
  assert.ok(!isThemeId(null));
  assert.ok(!isThemeId(42));
  assert.ok(THEMES.includes(DEFAULT_THEME), 'the default is one of the themes that ship');
  ok('only a theme that ships can be stored');
}

{
  // The first cut of themes looked like it worked and did almost nothing: the
  // Tailwind classes followed the variable, but the accents that carry the
  // LOOK — the wordmark gradient, the glows, the chart strokes, the sparklines
  // — were hardcoded #8B7CE8 in CSS and in JS. Switching theme changed the
  // backdrop and left everything else purple (user report, 2026-09-18).
  //
  // So: no accent literal may come back anywhere, except where it is
  // deliberate and listed here with the reason.
  const ALLOWED = new Map([
    // A share-image palette with its own named themes ('Void'), not app
    // chrome. An exported PNG should not change because the app did.
    ['src/components/terminal/PnlCard.tsx', 1],

    // The comment that explains all of this, plus the fallback default in
    // accentSoftHex for when the variable cannot be read.
    ['src/state/theme.ts', 2],
    // The :root block names the original hex so the default stays traceable.
    ['src/index.css', 2],
  ]);

  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) out.push(...walk(rel));
      else if (/\.(tsx?|css)$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const LITERAL = /#8B7CE8|#B7A6FF|rgba?\(\s*139,\s*124,\s*232|rgba?\(\s*183,\s*166,\s*255/gi;
  const offenders = [];
  for (const rel of walk('../src')) {
    const body = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const hits = (body.match(LITERAL) || []).length;
    if (!hits) continue;
    const key = rel.replace('../', '');
    const allowed = ALLOWED.get(key) ?? 0;
    if (hits > allowed) offenders.push(`${key}: ${hits} literal(s), ${allowed} allowed`);
  }
  assert.deepEqual(offenders, [], 'accent literals must read the theme variable:\n  ' + offenders.join('\n  '));
  ok('no hardcoded accent outside the places that are meant to have one');
}

console.log(`\ntheme: ${passed}/${passed} passed`);
