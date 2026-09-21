// X page stats (shared/xStats.ts): the reader that runs inside the Links
// panel's browser view, driven here against fake pages — a profile, a post,
// the sign-in wall — plus the number parser, the validator that turns a
// guest's untrusted reply into a typed record, and the strip text.

import assert from 'node:assert';
import fs from 'node:fs';
import { describeXStats, fmtCount, parseCount, readXPage, validateXStats, xPageKindOf, xStatsReaderScript } from './.xstats.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

/** A fake document: selector → text, selector+attr → value. */
const fakeDom = ({ url, title = 'X', text = {}, attrs = {}, body = '' }) => ({
  text: (s) => (s in text ? text[s] : null),
  attr: (s, n) => (attrs[`${s}|${n}`] ?? null),
  texts: (s) => (s in text ? [text[s]] : []),
  title: () => title,
  url: () => url,
  bodyText: () => body,
});

{
  assert.equal(parseCount('12.3K Followers'), 12300);
  assert.equal(parseCount('1,234 Following'), 1234);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('5B'), 5000000000);
  assert.equal(parseCount('123 Likes. Like'), 123);
  assert.equal(parseCount('Followers'), null, 'no number is null, not 0');
  assert.equal(parseCount(null), null);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('45 Replies'), 45, 'non-breaking space');
  // X renders the number and its word with no space between them. A real
  // account's 533 read as 53 before the suffix check was scoped to the suffix.
  assert.equal(parseCount('533Followers'), 533);
  assert.equal(parseCount('1,234Following'), 1234);
  assert.equal(parseCount('12.3KFollowers'), 12300);
  assert.equal(parseCount('12 Bookmarks. Bookmark'), 12, 'B of Bookmarks is not billions');
  assert.equal(parseCount('2Bookmarks'), 2);
  ok('counts parse with K/M/B and thousands separators; no number is null');
}

{
  assert.equal(xPageKindOf('https://x.com/krypt'), 'profile');
  assert.equal(xPageKindOf('https://twitter.com/krypt/'), 'profile');
  assert.equal(xPageKindOf('https://x.com/krypt/status/1234567890'), 'post');
  assert.equal(xPageKindOf('https://x.com/i/communities/123'), 'other');
  assert.equal(xPageKindOf('https://x.com/search?q=abc'), 'other');
  assert.equal(xPageKindOf('https://x.com/home'), 'other');
  assert.equal(xPageKindOf('https://example.com/krypt'), 'other');
  assert.equal(xPageKindOf('not a url'), 'other');
  ok('a profile, a post, and everything else, from the URL');
}

{
  const dom = fakeDom({
    url: 'https://x.com/yuhgoslavia',
    title: 'Yuhgo (@YuhgoSlavia) / X',
    text: {
      'a[href$="/verified_followers"]': '12.3K Followers',
      'a[href$="/following"]': '340 Following',
      '[data-testid="UserJoinDate"]': 'Joined March 2021',
      '[data-testid="UserName"]': 'Yuhgo @YuhgoSlavia',
    },
    attrs: { '[data-testid="UserName"] svg[data-testid="icon-verified"]|aria-label': 'Verified account' },
    body: 'Yuhgo @YuhgoSlavia 12.3K Followers 340 Following',
  });
  const s = readXPage(dom, parseCount);
  assert.equal(s.page, 'profile');
  assert.equal(s.handle, 'YuhgoSlavia', 'the handle from the name block beats the URL casing');
  assert.equal(s.followers, 12300);
  assert.equal(s.following, 340);
  assert.equal(s.joined, 'March 2021');
  assert.equal(s.verified, true);
  assert.equal(s.loginWall, false);
  assert.equal(s.likes, null, 'a profile has no likes');
  assert.equal(describeXStats(s), '@YuhgoSlavia · 12.3K followers · 340 following · joined March 2021 · verified');
  ok('a profile page: followers, following, joined, verified, handle');
}

{
  // The plain /followers link when the verified one is absent; no badge → not verified.
  const dom = fakeDom({
    url: 'https://x.com/someone',
    text: { 'a[href$="/followers"]': '87 Followers', '[data-testid="UserName"]': 'Some One @someone' },
    body: 'x',
  });
  const s = readXPage(dom, parseCount);
  assert.equal(s.followers, 87);
  assert.equal(s.following, null, 'not on the page is unknown');
  assert.equal(s.verified, false, 'a name block with no badge is not verified');
  assert.equal(s.joined, null);
  assert.equal(describeXStats(s), '@someone · 87 followers');
  ok('a profile read by its second route, with unknowns left null');
}

{
  const dom = fakeDom({
    url: 'https://x.com/someone/status/1234567890',
    title: 'Some One on X: "gm"',
    attrs: {
      'article [data-testid="like"]|aria-label': '1,203 Likes. Like',
      'article [data-testid="retweet"]|aria-label': '210 reposts. Repost',
      'article [data-testid="reply"]|aria-label': '88 Replies. Reply',
      'article [data-testid="bookmark"]|aria-label': '12 Bookmarks. Bookmark',
      'article a[href$="/analytics"]|aria-label': '45.2K views. View post analytics',
    },
    body: 'gm',
  });
  const s = readXPage(dom, parseCount);
  assert.equal(s.page, 'post');
  assert.equal(s.handle, 'someone');
  assert.equal(s.likes, 1203);
  assert.equal(s.reposts, 210);
  assert.equal(s.replies, 88);
  assert.equal(s.bookmarks, 12);
  assert.equal(s.views, 45200);
  assert.equal(s.followers, null, 'a post has no followers');
  assert.equal(describeXStats(s), 'post by @someone · 1.2K likes · 210 reposts · 88 replies · 45.2K views');
  ok('a post page: likes, reposts, replies, bookmarks, views');
}

{
  // The SIGNED-OUT profile shell (what a fresh panel gets, read 2026-09-20):
  // no data-testid at all — the join date is the /about link, the badge an
  // aria-label by the name, the handle's casing only in the title.
  const dom = fakeDom({
    url: 'https://x.com/yuhgoslavia',
    title: 'Yuhgo (@YuhgoSlavia) / X',
    text: { 'a[href$="/verified_followers"]': '533Followers', 'a[href$="/following"]': '10Following', 'a[href$="/about"]': 'Joined May 2025', 'main h1': 'Yuhgo' },
    attrs: { 'main [aria-label="Verified account"]|aria-label': 'Verified account' },
    body: 'Log in Sign up Yuhgo @YuhgoSlavia Joined May 2025 10 Following 533 Followers',
  });
  const s = readXPage(dom, parseCount);
  assert.equal(s.followers, 533);
  assert.equal(s.following, 10);
  assert.equal(s.joined, 'May 2025');
  assert.equal(s.handle, 'YuhgoSlavia', 'casing from the title');
  assert.equal(s.verified, true);
  assert.equal(s.loginWall, false, 'Log in buttons on a page that was read are not the wall');
  // Same shell, no badge: not verified — known, not unknown.
  const plain = fakeDom({ url: 'https://x.com/someone', title: 'Some (@someone) / X', text: { 'a[href$="/followers"]': '5Followers', 'main h1': 'Some' }, body: 'x' });
  assert.equal(readXPage(plain, parseCount).verified, false);
  // Neither shell recognisable: unknown, and the join date is not invented.
  const bare = fakeDom({ url: 'https://x.com/someone', text: { 'a[href$="/followers"]': '5Followers' }, body: 'x' });
  assert.equal(readXPage(bare, parseCount).verified, null);
  assert.equal(readXPage(bare, parseCount).joined, null);
  // The join date can also be read off the page text when no link carries it.
  const bodyOnly = fakeDom({ url: 'https://x.com/someone', text: { 'a[href$="/followers"]': '5Followers' }, body: 'Some @someone Joined March 2021 5 Followers' });
  assert.equal(readXPage(bodyOnly, parseCount).joined, 'March 2021');
  ok('the signed-out profile shell, which has no test ids, reads by its links, title and badge label');
}

{
  // The SIGNED-OUT post shell: the counts are the TEXT of controls whose
  // aria-labels are the bare words; no views are shown at all.
  const dom = fakeDom({
    url: 'https://x.com/jack/status/20',
    title: 'jack on X: "just setting up my twttr" / X',
    text: { 'article [aria-label="Reply"]': '18K', 'article [aria-label="Repost"]': '124K', 'article [aria-label="Like"]': '310K', 'article [aria-label="Bookmark"]': '21K' },
    body: 'jack @jack just setting up my twttr 18K 124K 310K 21K',
  });
  const s = readXPage(dom, parseCount);
  assert.equal(s.page, 'post');
  assert.equal(s.handle, 'jack');
  assert.equal(s.replies, 18000);
  assert.equal(s.reposts, 124000);
  assert.equal(s.likes, 310000);
  assert.equal(s.bookmarks, 21000);
  assert.equal(s.views, null, 'not shown to a signed-out reader: unknown, never 0');
  assert.equal(s.loginWall, false);
  ok('the signed-out post shell reads its counts off the controls');
}

{
  // X's sign-in wall: nothing readable and the wall's words on the page.
  const dom = fakeDom({ url: 'https://x.com/someone/status/1', body: 'Don’t miss what’s happening. People on X are the first to know. Sign in to X' });
  const s = readXPage(dom, parseCount);
  assert.equal(s.loginWall, true);
  assert.equal(s.likes, null);
  assert.match(describeXStats(s), /sign-in wall/);
  // A page with numbers and those words somewhere is NOT a wall.
  const fine = fakeDom({ url: 'https://x.com/someone', text: { 'a[href$="/followers"]': '5 Followers' }, body: 'Sign in to X ... 5 Followers' });
  assert.equal(readXPage(fine, parseCount).loginWall, false);
  ok('the sign-in wall is recognised, and never mistaken for a read page');
}

{
  const s = validateXStats({ page: 'profile', handle: 'ab_c', followers: 12300.4, following: -1, joined: 'March 2021', verified: true, likes: 'x', views: 1e13, loginWall: 'yes', title: 't'.repeat(500) });
  assert.equal(s.handle, 'ab_c');
  assert.equal(s.followers, 12300, 'rounded');
  assert.equal(s.following, null, 'negative is unknown');
  assert.equal(s.likes, null, 'text is unknown');
  assert.equal(s.views, null, 'absurd is unknown');
  assert.equal(s.loginWall, false, 'only a real true');
  assert.equal(s.title.length, 120, 'bounded');
  assert.equal(validateXStats({ page: 'profile', handle: '<script>' }).handle, null, 'a handle is letters, digits, underscore');
  assert.equal(validateXStats({ page: 'nope' }), null);
  assert.equal(validateXStats(null), null);
  assert.equal(validateXStats('str'), null);
  ok('a guest reply becomes a bounded typed record, or null');
}

{
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(999), '999');
  assert.equal(fmtCount(12300), '12.3K');
  assert.equal(fmtCount(45200), '45.2K');
  assert.equal(fmtCount(123456), '123K');
  assert.equal(fmtCount(1000), '1K', 'no trailing .0');
  assert.equal(fmtCount(1200000), '1.2M');
  assert.equal(fmtCount(null), '—');
  ok('counts format the way X shows them');
}

{
  // The injected script is plain JS, self-contained, and carries the same
  // reader the tests just drove.
  const src = xStatsReaderScript();
  assert.ok(src.startsWith('(() => {'), 'an expression');
  assert.ok(!/\bimport\b|\brequire\(/.test(src), 'no imports');
  assert.ok(/document\.querySelector/.test(src) && /location\.href/.test(src), 'reads the real document');
  assert.ok(/verified_followers/.test(src) && /["']like["']/.test(src) && /UserJoinDate/.test(src), 'carries the selectors');
  // It runs: give it a document and it returns the record.
  const doc = {
    title: 'Some One (@someone) / X',
    body: { innerText: 'x' },
    querySelector: (s) => (s === 'a[href$="/followers"]' ? { textContent: '42 Followers', getAttribute: () => null } : s === '[data-testid="UserName"]' ? { textContent: 'Some One @someone', getAttribute: () => null } : null),
    querySelectorAll: () => [],
  };
  const fn = new Function('document', 'location', `return ${src};`);
  const r = fn(doc, { href: 'https://x.com/someone' });
  assert.equal(r.page, 'profile');
  assert.equal(r.followers, 42);
  assert.equal(r.handle, 'someone');
  ok('the injected script is self-contained and returns the record when run on a document');
}

{
  // Wiring: the panel reads x.com pages only, validates in main, and never
  // loads a page on its own.
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const reg = src('../src/panels/registry.tsx');
  assert.ok(/xPageKindOf\(/.test(reg) && /executeJavaScript\(xStatsReaderScript\(\)/.test(reg), 'the panel runs the reader in the view');
  assert.ok(/window\.krypt\.links\.setXStats\(/.test(reg), 'and hands the record to main for scripts');
  assert.ok(reg.indexOf('<webview') < reg.indexOf('read {ago(xs.readAt)} ago'), 'the numbers sit at the bottom of the widget, under the view');
  const token = src('../src/pages/Token.tsx');
  assert.ok(/\['links', 'Links'\]/.test(token) && /<LinksPanel /.test(token), 'the token page has a Links tab under the chart');
  const panel = src('../src/components/terminal/LinksPanel.tsx');
  assert.ok(panel.indexOf('The X page, as read in the Links panel') < panel.indexOf('Links the creator published'), 'in the tab the numbers sit above the links');
  assert.ok(!/shown\.kind !== 'x' \? \(/.test(reg), 'the widget bar shows the X numbers whichever page is open');
  const auto = src('../shared/automation.ts');
  for (const id of ['xFollowers', 'xFollowing', 'xVerified', 'xLikes', 'xReposts', 'xReplies', 'xViews', 'xStatsAgeSec']) assert.ok(auto.includes(`id: '${id}'`), `${id} is a script variable`);
  const ipc = src('../electron/ipc.ts');
  assert.ok(/ipcMain\.handle\('links:xstats:set'/.test(ipc) && /validateXStats\(/.test(ipc), 'main validates before keeping');
  ok('wired: read in the view, validated in main, never crawled');
}

console.log(`\nxstats: ${passed}/${passed} passed`);
