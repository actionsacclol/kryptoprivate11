// A token's own links (shared/tokenLinks.ts): what they are, what may be
// embedded, and the wiring that keeps an embedded page harmless.
//
// The Links panel (2026-09-20) is the one place the app puts a page it did
// not write INSIDE itself. These pin the two halves of why that is safe: the
// renderer only ever asks for https pages a token's creator published, and
// main strips every capability from the view when it attaches, whatever the
// renderer asked for.

import assert from 'node:assert';
import fs from 'node:fs';
import { LAUNCHPAD_SITES, isEmbeddableUrl, launchpadSite, tokenLinks } from './.tokenlinks.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const MINT = '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump';
const ADDR = '0xc3A0B2A457DAEc0490e35d48f635f972649308B3';

{
  assert.equal(launchpadSite('solana', 'pumpfun', MINT)?.url, `https://pump.fun/coin/${MINT}`);
  assert.equal(launchpadSite('solana', 'pumpfun', MINT)?.label, 'pump.fun');
  // The same URL the $KRYPTO card uses — one pattern, not two.
  assert.ok(src('../shared/canary.ts').includes('https://pump.fun/coin/'), 'canary links pump.fun the same way');
  assert.equal(launchpadSite('bnb', 'fourmeme', ADDR)?.url, LAUNCHPAD_SITES.fourmeme(ADDR));
  assert.ok(LAUNCHPAD_SITES.fourmeme(ADDR).startsWith('https://four.meme/'));
  assert.equal(launchpadSite('robinhood', 'pons', ADDR)?.label, 'Pons');
  assert.ok(LAUNCHPAD_SITES.pons(ADDR).startsWith('https://www.ponslaunchpad.com/'));
  // A launchpad the app has no page for is no link, not a guessed one.
  assert.equal(launchpadSite('solana', 'bonk', MINT), null);
  assert.equal(launchpadSite('solana', 'unknown', MINT), null);
  assert.equal(launchpadSite('bnb', 'bnb', ADDR), null);
  assert.equal(launchpadSite('robinhood', 'robinhood', ADDR), null);
  // The wrong chain for a launchpad is no link either.
  assert.equal(launchpadSite('bnb', 'pumpfun', MINT), null);
  assert.equal(launchpadSite('solana', '', ''), null);
  ok('launchpad pages: pump.fun is certain, four.meme and Pons are constants, everything else is null');
}

{
  assert.equal(isEmbeddableUrl('https://x.com/someone/status/1'), true);
  assert.equal(isEmbeddableUrl('https://pump.fun/coin/' + MINT), true);
  assert.equal(isEmbeddableUrl('http://example.com'), false, 'http is not a page the app will show');
  assert.equal(isEmbeddableUrl('javascript:alert(1)'), false);
  assert.equal(isEmbeddableUrl('data:text/html,hi'), false);
  assert.equal(isEmbeddableUrl('file:///C:/Users/x/wallet.json'), false);
  assert.equal(isEmbeddableUrl('https://user:pw@example.com/'), false, 'credentials in a URL');
  assert.equal(isEmbeddableUrl('https://localhost:5273/'), false);
  assert.equal(isEmbeddableUrl('https://127.0.0.1/'), false);
  assert.equal(isEmbeddableUrl('https://10.0.0.5/'), false);
  assert.equal(isEmbeddableUrl('https://router.local/'), false);
  assert.equal(isEmbeddableUrl('https://a.com/' + 'x'.repeat(2_100)), false, 'over 2 kB');
  assert.equal(isEmbeddableUrl(''), false);
  assert.equal(isEmbeddableUrl(null), false);
  assert.equal(isEmbeddableUrl(42), false);
  assert.equal(isEmbeddableUrl('not a url'), false);
  ok('embeddable = https, a real public host, no credentials, nothing local');
}

{
  const socials = { twitter: 'https://x.com/krypt/status/123', website: 'https://krypt.cc', telegram: 'https://t.me/kryptcc' };
  const links = tokenLinks('solana', MINT, 'pumpfun', socials);
  assert.deepEqual(links.map((l) => l.kind), ['x', 'website', 'telegram', 'launchpad'], 'order: X, website, Telegram, launchpad');
  assert.deepEqual(links.map((l) => l.label), ['X', 'Website', 'Telegram', 'pump.fun']);
  assert.equal(links[0].host, 'x.com');
  assert.equal(links[1].host, 'krypt.cc');
  assert.equal(links[3].url, `https://pump.fun/coin/${MINT}`);
  ok('a fully linked pump coin lists all four, in display order, with hosts');
}

{
  // twitter.com and mobile hosts are X; a "twitter" field that points
  // somewhere else is shown as a website labelled by its host, so the
  // button says where the click goes.
  assert.equal(tokenLinks('solana', MINT, null, { twitter: 'https://twitter.com/abc', website: null, telegram: null })[0].kind, 'x');
  assert.equal(tokenLinks('solana', MINT, null, { twitter: 'https://mobile.twitter.com/abc', website: null, telegram: null })[0].kind, 'x');
  const odd = tokenLinks('solana', MINT, null, { twitter: 'https://www.tiktok.com/@abc', website: null, telegram: null });
  assert.equal(odd[0].kind, 'website');
  assert.equal(odd[0].label, 'tiktok.com');
  // A website field that is really an X or Telegram link is labelled as such.
  assert.equal(tokenLinks('solana', MINT, null, { twitter: null, website: 'https://x.com/abc', telegram: null })[0].kind, 'x');
  assert.equal(tokenLinks('solana', MINT, null, { twitter: null, website: 'https://t.me/abc', telegram: null })[0].kind, 'telegram');
  ok('the label says where a click goes, whichever field the provider put it in');
}

{
  // Nothing usable → nothing. An http:// social, a bare handle and a
  // duplicate are dropped, never "fixed up".
  assert.deepEqual(tokenLinks('solana', MINT, 'unknown', null), []);
  assert.deepEqual(tokenLinks('solana', MINT, 'unknown', { twitter: null, website: null, telegram: null }), []);
  assert.deepEqual(tokenLinks('solana', MINT, 'unknown', { twitter: 'http://x.com/abc', website: '@handle', telegram: 'javascript:1' }), []);
  const dup = tokenLinks('solana', MINT, null, { twitter: 'https://x.com/abc', website: 'https://x.com/abc', telegram: null });
  assert.equal(dup.length, 1, 'the same URL twice is one link');
  ok('no link is invented, repaired or repeated');
}

{
  // Chain-aware: an EVM token gets its own launchpad and nothing of Solana's.
  const bnb = tokenLinks('bnb', ADDR, 'fourmeme', { twitter: null, website: 'https://example.org', telegram: null });
  assert.deepEqual(bnb.map((l) => l.kind), ['website', 'launchpad']);
  assert.equal(bnb[1].label, 'four.meme');
  const rh = tokenLinks('robinhood', ADDR, 'pons', null);
  assert.deepEqual(rh.map((l) => l.label), ['Pons']);
  ok('EVM tokens link their own launchpads');
}

{
  // Main hardens every embedded view regardless of what the renderer asked.
  const sec = src('../electron/system/webSecurity.ts');
  assert.ok(/will-attach-webview/.test(sec), 'attach hook');
  assert.ok(/delete \(webPreferences as \{ preload\?: string \}\)\.preload/.test(sec), 'no preload — no window.krypt in a guest');
  assert.ok(/webPreferences\.nodeIntegration = false/.test(sec) && /webPreferences\.contextIsolation = true/.test(sec) && /webPreferences\.sandbox = true/.test(sec), 'no node, isolated, sandboxed');
  assert.ok(/if \(!isEmbeddableUrl\(params\.src\)\)[\s\S]{0,200}event\.preventDefault\(\)/.test(sec), 'a non-https src is refused at attach');
  assert.ok(/getType\(\) !== 'webview'\) return;[\s\S]*setWindowOpenHandler[\s\S]*action: 'deny'/.test(sec), 'popups denied');
  assert.ok(/'will-navigate', onlyHttps/.test(sec) && /'will-redirect', onlyHttps/.test(sec), 'navigation stays https');
  assert.ok(/setPermissionRequestHandler\(\(_wc, _permission, callback\) => callback\(false\)\)/.test(sec), 'no permissions');
  assert.ok(/'will-download', \(e\) => e\.preventDefault\(\)/.test(sec), 'no downloads');
  const main = src('../electron/main.ts');
  assert.equal((main.match(/webviewTag: true/g) ?? []).length, 2, 'both windows can host a view');
  assert.ok(/^guardWebviews\(\);/m.test(main), 'the guard is registered once at startup');
  ok('wired: main strips every capability from an embedded view and refuses the rest');
}

{
  // The panel and the pages use the shared derivation, and the view is
  // partitioned away from the app's own cookies.
  const reg = src('../src/panels/registry.tsx');
  assert.ok(/id: 'links'/.test(reg), 'the panel exists');
  assert.ok(/<webview[\s\S]{0,400}partition="persist:links"/.test(reg), 'its own cookie jar');
  assert.ok(/tokenLinks\(token\.chain, token\.mint/.test(reg), 'the panel derives links the shared way');
  // The panel opens on the launchpad page; X and the website are the other buttons.
  assert.ok(/const panelOrder = \[\.\.\.list\.filter\(\(l\) => l\.kind === 'launchpad'\), \.\.\.list\.filter\(\(l\) => l\.kind !== 'launchpad'\)\];[\s\S]{0,120}setActive\(panelOrder\[0\]\?\.kind/.test(reg), 'the panel opens on the launchpad page');
  assert.ok(/never enter a key or seed phrase/.test(reg), 'the panel says the site is not ours');
  assert.ok(/tokenLinks\('solana', mint/.test(src('../src/pages/Token.tsx')), 'the Solana token page lists the links');
  assert.ok(/tokenLinks\(chain, address/.test(src('../src/pages/EvmToken.tsx')), 'the EVM token page lists the links');
  const legal = src('../shared/legal/documents.ts');
  assert.ok(/The Links panel on the Widgets page/.test(legal), 'the privacy policy says what the panel sends where');
  const entity = src('../shared/legal/entity.ts');
  assert.ok(/TERMS_VERSION = '2026-09-20\.2'/.test(entity), 'the policy change re-prompts');
  ok('wired: panel, both token pages and the privacy policy');
}

console.log(`\ntokenlinks: ${passed}/${passed} passed`);
