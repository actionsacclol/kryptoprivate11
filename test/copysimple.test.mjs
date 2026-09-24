// Copy Simple (2026-09-20): the three-question follow beside Copy Trading.
// Read from source: it must be reachable (all four route touches), it must
// save through the same handler as the full page, and it must never create
// a live config.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

{
  const sidebar = read('../src/components/Sidebar.tsx');
  assert.ok(/\|\s*'copysimple'/.test(sidebar), 'RouteId lists it');
  assert.ok(/\{ id: 'copysimple', label: 'Copy Simple'/.test(sidebar), 'the sidebar row exists, plainly named');
  assert.ok(sidebar.indexOf("id: 'copysimple'") < sidebar.indexOf("id: 'wallets', label: 'Copy Trading'"), 'listed before Copy Trading');
  const loaders = read('../src/routeLoaders.ts');
  assert.ok(/copysimple: \(\) => import\('\.\/pages\/CopySimple'\)/.test(loaders), 'the loader exists');
  const app = read('../src/App.tsx');
  assert.ok(/route === 'copysimple' && <CopySimplePage onOpenAdvanced=\{\(\) => navigate\('wallets'\)\} onOpenScout=\{\(\) => navigate\('scout'\)\} \/>/.test(app), 'rendered with its two ways out');
  const ws = read('../src/workspaces.ts');
  // FIRST in Automation, not the whole list: routes get added to that
  // workspace over time (auto-callout, 2026-09-22) and pinning the exact
  // array makes this fail for a reason it does not care about.
  const automation = /routes: \[('copysimple'[^\]]*)\]/.exec(ws);
  assert.ok(automation, 'the Automation route list is findable');
  assert.ok(automation[1].startsWith("'copysimple'"), 'Automation lists it first');
  assert.ok(automation[1].includes("'wallets'"), 'with Copy Trading beside it');
  ok('all four route touches are in place and Copy Simple is the Automation landing page');
}

{
  const page = read('../src/pages/CopySimple.tsx');
  assert.ok(/window\.krypt\.copy\.save\(cfg as Partial<CopyConfig>\)/.test(page), 'saves through the same copy:save as the full page');
  assert.ok(/simpleConfig\(addr, label, chain, size\)/.test(page), 'the config is the shared derivation, not page-local numbers');
  assert.ok(!/mode: 'live'/.test(page), 'nothing on the page constructs a live config');
  assert.ok(/enabled: mode === 'live' \? false : c\.enabled/.test(page), 'switching a card to live disarms it first, as on the full page');
  assert.ok(/Arm LIVE copy trading/.test(page) && /Six months of research/.test(page), 'arming runs the same confirmation');
  assert.ok(/Follow on paper/.test(page), 'the one button is paper');
  const guides = read('../src/pages/Guides.tsx');
  assert.ok(/Copy Simple: paste/.test(guides), 'the guide mentions it');
  ok('the page is a view over the shared config: paper first, same save, same arm confirmation');
}

console.log(`\ncopysimple: ${passed}/${passed} passed`);
