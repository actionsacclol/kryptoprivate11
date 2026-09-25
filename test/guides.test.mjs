// Guides page: every card has an advanced twin, the switch never breaks the
// page, and the pump.fun quickstart video is where people look for it
// (2026-09-24).

import assert from 'node:assert';
import fs from 'node:fs';
import { ADVANCED_GUIDES } from './.guidesadv.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const page = read('../src/pages/Guides.tsx');
const sectionIds = [...page.matchAll(/^  ([a-z]+): \{$/gm)].map((m) => m[1]).filter((id) => id !== 'guides');
const extraIds = [...page.matchAll(/^  \{ id: '([^']+)', title: /gm)].map((m) => m[1]);
const cards = ['start', ...sectionIds, ...extraIds];

{
  assert.ok(sectionIds.length >= 8 && extraIds.length >= 8, `the page's cards are findable (${cards.length})`);
  for (const id of cards) {
    const g = ADVANCED_GUIDES[id];
    assert.ok(g, `card "${id}" has an advanced guide`);
    assert.ok(typeof g.what === 'string' && g.what.length > 40, `${id}: says what it is`);
    assert.ok(g.steps.length >= 3, `${id}: has a workflow`);
    assert.ok(g.details.length >= 2 && g.details.every((d) => d.heading && d.lines.length > 0), `${id}: has detail sections`);
    assert.ok(g.careful.length >= 1, `${id}: names its sharp edges`);
  }
  for (const id of Object.keys(ADVANCED_GUIDES)) assert.ok(cards.includes(id), `advanced guide "${id}" belongs to a card on the page`);
  ok('every card on the page has an advanced version, and none is orphaned');
}

{
  const all = JSON.stringify(ADVANCED_GUIDES);
  assert.ok(!/costs you nothing extra/.test(all + page), 'the referral is never described as free — pump takes Krypt’s share from the account’s callout rewards');
  ok('the referral is described as it is');
}

{
  assert.ok(/function readAdvanced\(\): boolean \{\s*try \{/.test(page) && /function writeAdvanced\(on: boolean\): void \{\s*try \{/.test(page), 'storage reads and writes are guarded');
  assert.ok(/role="switch"[\s\S]{0,80}aria-checked=\{advanced\}/.test(page), 'the switch says its state');
  ok('the Advanced switch is remembered, and a refused storage cannot break the page');
}

{
  const videos = read('../src/guideVideos.ts');
  assert.ok(/PUMP_QUICKSTART_URL = 'https:\/\/www\.youtube\.com\/watch\?v=ylEtm666evc'/.test(videos), 'the quickstart link is https');
  const accounts = read('../src/pages/PumpAccounts.tsx');
  assert.ok(/openExternal\(PUMP_QUICKSTART_URL\)/.test(accounts), 'the pump.fun accounts page opens it');
  assert.ok(/video: \{ url: PUMP_QUICKSTART_URL/.test(page) && /openExternal\(guide\.video!\.url\)/.test(page), 'and so does the pump.fun guide card');
  assert.ok(!/href=\{?["']https:\/\/www\.youtube/.test(accounts + page), 'always through main, never a bare href');
  ok('the pump.fun quickstart video is on the accounts page and the guide');
}

console.log(`\nguides: ${passed}/${passed} passed`);
