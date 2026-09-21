// What a token's website says about itself (shared/siteRead.ts): the reader
// that runs inside the Links panel's browser view, driven here against a
// fake page — a real coin site, a template that names nothing, a drainer's
// words — plus the validator over a guest's untrusted reply and the strip text.

import assert from 'node:assert';
import fs from 'node:fs';
import { describeSiteRead, readSitePage, siteLinksX, siteReaderScript, validateSiteRead } from './.siteread.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const MINT = '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump';

const fakeDom = ({ url, title = '', meta = {}, hrefs = [], body = '' }) => ({
  title: () => title,
  url: () => url,
  meta: (n) => (n in meta ? meta[n] : null),
  hrefs: () => hrefs,
  bodyText: () => body,
});

{
  const dom = fakeDom({
    url: 'https://www.krypt.cc/',
    title: 'Krypt — the terminal',
    meta: { description: 'Free, open, honest.', generator: 'Framer 2026' },
    hrefs: ['/download', 'https://x.com/YuhgoSlavia', 'https://twitter.com/YuhgoSlavia/status/1', 'https://t.me/kryptback', 'https://t.me/kryptback/', 'https://pump.fun/coin/' + MINT, 'https://discord.gg/krypt', 'mailto:support@krypt.cc', 'https://docs.krypt.cc/start', 'javascript:void(0)'],
    body: `Krypt. Contract: ${MINT}. Buy on pump.fun. Join us on X and Telegram.`,
  });
  const s = readSitePage(dom, MINT);
  assert.equal(s.host, 'krypt.cc');
  assert.equal(s.title, 'Krypt — the terminal');
  assert.equal(s.description, 'Free, open, honest.');
  assert.equal(s.generator, 'Framer 2026');
  assert.equal(s.namesContract, true);
  assert.deepEqual(s.xHandles, ['yuhgoslavia'], 'one handle, lower-case, from both x.com and twitter.com');
  assert.deepEqual(s.telegramLinks, ['https://t.me/kryptback'], 'deduplicated, trailing slash dropped');
  assert.equal(s.outboundHosts, 2, 'pump.fun and discord.gg; own subdomain, mailto and javascript are not outbound hosts');
  assert.equal(s.wordCount, 12);
  assert.equal(s.mentionsConnectWallet, false);
  assert.equal(siteLinksX(s, 'YuhgoSlavia'), true, 'case-insensitive');
  assert.equal(siteLinksX(s, 'someoneelse'), false);
  assert.equal(siteLinksX(s, null), null, 'no X on the token = nothing to compare');
  assert.equal(describeSiteRead(s, 'YuhgoSlavia'), 'names the contract · links the token’s X (@YuhgoSlavia) · 1 Telegram link · 12 words · 2 outbound hosts · built with Framer 2026');
  ok('a real coin site: names the contract, links the token’s X and Telegram, built with what');
}

{
  // The contract only in a link (a "Buy" button), not in the text, still counts.
  const inLink = readSitePage(fakeDom({ url: 'https://coin.example', hrefs: [`https://dexscreener.com/solana/${MINT}`], body: 'To the moon' }), MINT);
  assert.equal(inLink.namesContract, true);
  // A template that names nothing and links a different X.
  const tmpl = readSitePage(fakeDom({ url: 'https://coin-site.vercel.app/', hrefs: ['https://x.com/someoneelse', 'https://x.com/intent/tweet?text=hi', 'https://x.com/i/communities/1'], body: 'Buy now. Tokenomics. Roadmap.' }), MINT);
  assert.equal(tmpl.namesContract, false);
  assert.deepEqual(tmpl.xHandles, ['someoneelse'], 'intent and i/ paths are not accounts');
  assert.equal(siteLinksX(tmpl, 'yuhgoslavia'), false);
  assert.equal(describeSiteRead(tmpl, 'yuhgoslavia'), 'does not name the contract · links a different X (@someoneelse) · 4 words · 0 outbound hosts');
  assert.equal(describeSiteRead(readSitePage(fakeDom({ url: 'https://a.b', body: '' }), MINT), 'x'), 'does not name the contract · links no X · 0 words · 0 outbound hosts');
  ok('a template names nothing and links someone else; a contract in a link still counts');
}

{
  const drainer = readSitePage(fakeDom({ url: 'https://claim-coin.example', body: 'Connect your wallet to claim your airdrop now!' }), MINT);
  assert.equal(drainer.mentionsConnectWallet, true);
  assert.match(describeSiteRead(drainer, null), /asks to connect a wallet or claim/);
  const walletConnect = readSitePage(fakeDom({ url: 'https://a.b', body: 'Powered by WalletConnect' }), MINT);
  assert.equal(walletConnect.mentionsConnectWallet, true);
  const plain = readSitePage(fakeDom({ url: 'https://a.b', body: 'Our wallet is community-owned and we claim nothing.' }), MINT);
  assert.equal(plain.mentionsConnectWallet, false, 'the words apart are not the phrase');
  ok('the drainer phrases are recognised as words on the page, not a verdict');
}

{
  const v = validateSiteRead({ url: 'https://a.b/', host: 'a.b', title: 't'.repeat(500), description: 5, namesContract: 'yes', xHandles: ['Good_1', 'bad handle', '<script>', 'fine'], telegramLinks: ['https://t.me/ok', 'https://evil.example/x', 'https://t.me/+inv'], outboundHosts: -3, wordCount: 12.7, generator: '', mentionsConnectWallet: true });
  assert.equal(v.title.length, 200, 'bounded');
  assert.equal(v.description, null, 'a number is not a description');
  assert.equal(v.namesContract, false, 'only a real true');
  assert.deepEqual(v.xHandles, ['fine'], 'handles must be lower-case letters, digits, underscore — the reader emits them so');
  assert.deepEqual(v.telegramLinks, ['https://t.me/ok', 'https://t.me/+inv'], 'only t.me links');
  assert.equal(v.outboundHosts, 0, 'a negative count is 0, never negative');
  assert.equal(v.wordCount, 13, 'rounded');
  assert.equal(v.generator, null);
  assert.equal(v.mentionsConnectWallet, true);
  assert.equal(validateSiteRead({ url: 'ftp://a.b' }), null, 'not a web page');
  assert.equal(validateSiteRead({}), null);
  assert.equal(validateSiteRead(null), null);
  assert.equal(validateSiteRead('x'), null);
  ok('a guest reply becomes a bounded typed record, or null');
}

{
  const src = siteReaderScript(MINT);
  assert.ok(src.startsWith('(() => {'), 'an expression');
  assert.ok(!/\bimport\b|\brequire\(/.test(src), 'no imports');
  assert.ok(src.includes(JSON.stringify(MINT)), 'the mint is inlined');
  assert.throws(() => siteReaderScript('0xdeadbeef'), /not a mint/, 'an EVM address never reaches the guest');
  assert.throws(() => siteReaderScript('"; alert(1); "'), /not a mint/);
  // It runs: give it a document and it returns the record.
  const doc = {
    title: 'Coin',
    body: { innerText: `Contract ${MINT} — connect your wallet` },
    querySelector: (s) => (s.includes('generator') ? { getAttribute: () => 'Wix.com Website Builder' } : null),
    querySelectorAll: () => [{ getAttribute: () => 'https://x.com/coin' }, { getAttribute: () => 'https://t.me/coin' }],
  };
  const fn = new Function('document', 'location', `return ${src};`);
  const r = fn(doc, { href: 'https://coin.example/' });
  assert.equal(r.namesContract, true);
  assert.deepEqual(r.xHandles, ['coin']);
  assert.deepEqual(r.telegramLinks, ['https://t.me/coin']);
  assert.equal(r.generator, 'Wix.com Website Builder');
  assert.equal(r.mentionsConnectWallet, true);
  ok('the injected script is self-contained, refuses a non-mint, and returns the record when run on a document');
}

{
  // Wiring: read in the view only for the token's own site, validated in main, never fetched.
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const reg = src('../src/panels/registry.tsx');
  assert.ok(/executeJavaScript\(siteReaderScript\(mint\)\)/.test(reg), 'the panel runs the reader in the view');
  assert.ok(/window\.krypt\.links\.setSiteRead\(/.test(reg), 'and hands the record to main for scripts');
  assert.ok(/isTokenSitePage\(url\)/.test(reg), 'only on the token’s own site — not X, Telegram or a launchpad');
  const ipc = src('../electron/ipc.ts');
  assert.ok(/ipcMain\.handle\('links:site:set'/.test(ipc) && /validateSiteRead\(/.test(ipc), 'main validates before keeping');
  const panel = src('../src/components/terminal/LinksPanel.tsx');
  assert.ok(/Names the contract/.test(panel) && /Visitor numbers are not shown/.test(panel), 'the tab shows the read and says what is not shown');
  const auto = src('../shared/automation.ts');
  for (const id of ['siteNamesContract', 'siteLinksX', 'siteOutboundHosts', 'siteMentionsConnectWallet', 'tgMembers', 'tgOnline', 'tgKind', 'domainAgeDays', 'domainHostedOn']) assert.ok(auto.includes(`id: '${id}'`), `${id} is a script variable`);
  ok('wired: read in the view, validated in main, exposed to scripts');
}

console.log(`\nsiteread: ${passed}/${passed} passed`);
