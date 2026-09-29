// Liquid glass (2026-09-28) — the pure half, pinned.
//
// 1. The optics table covers every look, and exactly the two hard looks
//    (Hacker, Retro) have no lens. A look added later must decide.
// 2. Every lens is a SURFACE, not a loupe: frost on, a small displacement,
//    no brightness veil (a veil over a price is a lie about its colour),
//    a map no larger than 256 (the Hub mounts a dozen at once).
// 3. Every tint is translucent and reads the look's panel colour, so a light
//    look gets light glass without a second table.
// 4. The stylesheet carries the flat fallback, the Lite guard and the
//    per-look switches the component relies on.
// 5. The callers obey the two rules that make backdrop-filter work at all:
//    no scrim under a lens blurs, and an overlay that wraps a lens slides
//    without fading (a fading parent is a backdrop root — the lens would
//    see nothing until the fade ended).
//
//   esbuild src/state/glass.ts --bundle --format=esm --platform=node --alias:@shared=./shared --outfile=test/.glass.mjs
//   node test/glass.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GLASS_LOOKS, GLASS_MODE, GLASS_SURFACES, GLASS_TINT, SKINS, glassModeFor, glassOpticsFor } from './.glass.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ok = (m) => console.log('ok  ', m);

// ── 1. Coverage ────────────────────────────────────────────────────────
{
  assert.deepEqual([...GLASS_SURFACES], ['sheet', 'tile']);
  assert.deepEqual([...SKINS], ['classic', 'futuristic', 'minimal', 'hacker', 'retro', 'xp'], 'the looks this table was written against');
  for (const skin of SKINS) {
    const o = glassOpticsFor(skin);
    if (skin === 'hacker' || skin === 'retro') assert.equal(o, null, `${skin} has no lens`);
    else assert.ok(o && typeof o === 'object', `${skin} has a lens`);
    for (const surface of GLASS_SURFACES) {
      assert.equal(glassModeFor(surface, skin, true), 'flat', `${skin}/${surface} is flat in Lite`);
      const want = skin === 'hacker' || skin === 'retro' ? 'flat' : GLASS_MODE[surface];
      assert.equal(glassModeFor(surface, skin, false), want, `${skin}/${surface} is ${want}`);
    }
  }
  assert.deepEqual([...GLASS_LOOKS], ['classic', 'futuristic', 'minimal', 'xp']);
  ok('every look decides, only Hacker and Retro have no glass, and Lite is always flat');
}

// ── 2. The lens is reserved for overlays; what stays on screen is frost ─
{
  // MEASURED 2026-09-28: the displacement pass costs ~5 ms per surface per
  // frame over the animating backdrop; blur + saturate costs nothing. A
  // surface that stays on screen must never be a lens.
  assert.equal(GLASS_MODE.sheet, 'lens', 'overlays get the lens');
  assert.equal(GLASS_MODE.tile, 'frost', 'tiles over the backdrop get frost');
  for (const skin of GLASS_LOOKS) {
    const o = glassOpticsFor(skin);
    assert.ok(o.frost >= 4, `${skin} frosts (${o.frost})`);
    assert.ok(o.strength > 0 && o.strength <= 0.1, `${skin} bends gently (${o.strength})`);
    assert.equal(o.brightness, 0, `${skin} has no veil`);
    assert.ok(o.mapSize <= 256, `${skin} map is small (${o.mapSize})`);
    assert.ok(o.saturate >= 1, `${skin} never desaturates the data behind it`);
    assert.ok(o.dispersion >= 0 && o.dispersion <= 0.6, `${skin} dispersion in range (${o.dispersion})`);
  }
  // Looks move the base rather than replacing it: a shift keeps every field.
  const base = Object.keys(glassOpticsFor('classic')).sort();
  for (const skin of GLASS_LOOKS) assert.deepEqual(Object.keys(glassOpticsFor(skin)).sort(), base, `${skin} keeps every field`);
  ok('the lens is a surface, not a loupe, and only overlays carry it');
}

// ── 3. Tints ───────────────────────────────────────────────────────────
{
  for (const surface of GLASS_SURFACES) {
    assert.match(GLASS_TINT[surface], /^bg-krypt-panel\/\d{2}$/, `${surface} tint reads the look's panel colour with an alpha`);
    assert.ok(Number(GLASS_TINT[surface].split('/')[1]) < 95, `${surface} tint is translucent`);
  }
  ok('every tint is a translucent wash of the look\'s panel colour');
}

// ── 4. The stylesheet ──────────────────────────────────────────────────
{
  const css = read('src/index.css');
  assert.match(css, /\.glass-lens \{/, 'the lens surface has a rule');
  assert.match(css, /\.glass-frost \{\n    backdrop-filter: blur\(\d+px\) saturate\([\d.]+\);/, 'frost is blur + saturate');
  assert.doesNotMatch(css.match(/\.glass-frost \{([^}]*)\}/)[1], /url\(/, 'frost never carries the displacement pass');
  assert.doesNotMatch(css.match(/\.glass-chrome \{([^}]*)\}/)[1], /backdrop-filter/, 'the frame carries no filter at all');
  assert.match(css, /\.glass \{[^}]*background-color: rgb\(var\(--krypt-panel\) \/ 0\.9\d\)/, 'the flat fallback is a near-opaque panel');
  assert.match(css, /\.glass-btn::before \{/, 'buttons have a sheen');
  assert.match(css, /html\.lite \[class\*='backdrop-blur'\],\nhtml\.lite \[data-liquid-glass\],\nhtml\.lite \.glass-frost \{\n  backdrop-filter: none !important;/, 'Lite strips the filter from any lens or frost that exists');
  assert.match(css, /html\.lite \.glass-lens,\nhtml\.lite \.glass-frost \{\n  background-color: rgb\(var\(--krypt-panel\) \/ 0\.9\d\) !important;/, 'Lite gives a stripped lens or frost the flat fill');
  for (const hard of ['hacker', 'retro']) {
    assert.match(css, new RegExp(`html\\[data-skin='${hard}'\\] \\.glass-btn::before \\{ display: none; \\}`), `${hard} has no button sheen`);
    assert.match(css, new RegExp(`html\\[data-skin='${hard}'\\] \\.glass \\{ background-image: none; \\}`), `${hard} has no wash`);
  }
  // The lens carries no border of its own, so a bar can keep a bottom edge only.
  const lensRule = css.match(/\.glass-lens \{([^}]*)\}/)[1];
  assert.doesNotMatch(lensRule, /border:/, 'the lens rule sets no border');
  ok('the stylesheet carries the fallback, the Lite guard and the look switches');
}

// ── 5. The callers ─────────────────────────────────────────────────────
{
  // The frame: a class, not a component, and no filter.
  for (const f of ['src/components/TopBar.tsx', 'src/components/Sidebar.tsx']) {
    const src = read(f);
    assert.match(src, /className="glass-chrome /, `${f} is chrome`);
    assert.doesNotMatch(src, /<LiquidGlass\b|backdrop-blur/, `${f} carries no filter`);
  }
  const surfaces = [
    'src/components/CalloutsRail.tsx',
    'src/components/TokenDrawer.tsx',
    'src/components/WalletDrawer.tsx',
    'src/components/terminal/TokenSearch.tsx',
    'src/components/terminal/ProfilesPanel.tsx',
    'src/components/Onboarding.tsx',
    'src/state/ModalProvider.tsx',
    'src/state/ToastProvider.tsx',
    'src/pages/Hub.tsx',
    'src/components/KryptoCard.tsx',
    'src/components/PanelGrid.tsx',
    'src/pages/Workspace.tsx',
    'src/components/terminal/PnlCard.tsx',
    'src/components/terminal/SimulateTrade.tsx',
    'src/components/terminal/TradeReplay.tsx',
    'src/components/terminal/GifPicker.tsx',
    'src/components/terminal/ScriptInputsDialog.tsx',
  ];
  for (const f of surfaces) {
    const src = read(f);
    assert.match(src, /<LiquidGlass\b/, `${f} renders a glass surface`);
    // A scrim under a lens must not blur: it would become the backdrop root
    // and the lens would frost the scrim instead of the page.
    for (const m of src.matchAll(/className="([^"]*fixed inset-0[^"]*)"/g)) {
      assert.doesNotMatch(m[1], /backdrop-blur/, `${f}: a scrim under a lens does not blur (${m[1]})`);
    }
  }
  // Surfaces that stay on screen for a session never carry the lens: a lens
  // that never closes re-runs its displacement pass on every backdrop frame
  // (the callouts rail: +3 % GPU, 240 -> 222 fps, measured 2026-09-29).
  assert.match(read('src/components/CalloutsRail.tsx'), /<LiquidGlass surface="tile"/, 'the callouts rail is frost');
  assert.match(read('src/components/PanelGrid.tsx'), /<LiquidGlass surface="tile"/, 'Widgets panels are frost');
  // Quiet pages hold a STILL backdrop: every filtered surface re-filters each
  // time the pixels behind it change (18 frosted panels: 3.9 % GPU moving,
  // 0.1 % still).
  const metal = read('src/components/viz/LiquidMetal.tsx');
  assert.match(metal, /still = next < 1;/, 'a quiet page stops the backdrop loop');
  assert.ok(metal.includes('if (!running) drawOnce();'), 'a still field repaints after a resize or an accent change');
  // An overlay that wraps a lens slides; it does not fade.
  for (const f of ['src/components/TokenDrawer.tsx', 'src/components/WalletDrawer.tsx', 'src/components/CalloutsRail.tsx']) {
    const src = read(f);
    // The props only — a comment explaining the rule is allowed to say 'opacity'.
    const aside = src
      .slice(src.indexOf('<motion.aside'), src.indexOf('>', src.indexOf('<motion.aside')))
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    assert.doesNotMatch(aside, /opacity/, `${f}: the aside that wraps the glass animates transform only`);
  }
  // The component itself: Lite and a lens-less look fall back to the flat div.
  const comp = read('src/components/LiquidGlass.tsx');
  assert.match(comp, /const mode = glassModeFor\(surface, skin, lite\);/, 'the table decides the material');
  assert.match(comp, /className=\{cls\('glass', className\)\}/, 'the fallback is the flat .glass surface');
  assert.match(comp, /className=\{cls\('glass-frost', tint \?\? GLASS_TINT\[surface\], className\)\}/, 'frost is a plain div with the tint');
  assert.match(comp, /<Glass optics=\{optics \?\? undefined\} className=\{cls\('glass-lens'/, 'the lens is the library');
  ok('every surface is glass, no scrim under a lens blurs, overlays slide rather than fade');
}

console.log('glass: all checks passed');
