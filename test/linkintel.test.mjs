// Telegram previews and domain records (shared/linkIntel.ts): the parsers
// that read Telegram's public page and a registry's RDAP answer, driven
// against fixtures captured live on 2026-09-20, plus the link normaliser,
// IANA's bootstrap, the shared-platform rule and the strip text.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  describeDomain,
  describeTelegram,
  domainAgeDays,
  fmtAge,
  fmtRegistered,
  parseRdapDomain,
  parseTelegramPreview,
  rdapBaseFor,
  rdapHosts,
  telegramPreviewUrl,
  websiteHostOf,
} from './.linkintel.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// The relevant part of https://t.me/kryptback as served on 2026-09-20.
const CHANNEL = `<!DOCTYPE html><html><head><title>Telegram: Contact @kryptback</title>
<meta property="og:title" content="Krypt.cc"></head><body><div class="tgme_page_wrap"><div class="tgme_page">
<div class="tgme_page_photo"><a href="tg://resolve?domain=kryptback"><img class="tgme_page_photo_image" src="x"></a></div>
<div class="tgme_page_title" dir="auto">
  <span dir="auto">Krypt.cc</span>
</div>
<div class="tgme_page_extra">149 subscribers</div>
<div class="tgme_page_description" dir="auto">Krypt.cc Tele<br/>gram &amp; more</div>
<div class="tgme_page_action"><a class="tgme_action_button_new shine" href="tg://resolve?domain=kryptback">View in Telegram</a></div>
</div></div></body></html>`;

// A public group (https://t.me/BotTalk, same day): members and online, spaces in the numbers.
const GROUP = `<div class="tgme_page_title" dir="auto">
  <span dir="auto">Bot Talk</span>
</div>
<div class="tgme_page_extra">26 481 members, 1 564 online</div>`;

// A private invite (t.me/+…): Telegram's generic page, no count anywhere.
const INVITE = `<head><meta property="og:title" content="Join group chat on Telegram"><meta property="og:description" content=""></head>
<body><div class="tgme_page_wrap"><div class="tgme_page"><div class="tgme_page_icon"></div>
<div class="tgme_page_description">You are invited to a group chat on Telegram. Click to join:</div>
<div class="tgme_page_action"><a class="tgme_action_button_new" href="tg://join?invite=abc">Join Group</a></div></div></div></body>`;

// A bot or user: the extra line is the handle.
const ACCOUNT = `<div class="tgme_page_title" dir="auto"><span dir="auto">Some Bot</span></div>
<div class="tgme_page_extra">@somebot</div>
<div class="tgme_page_description" dir="auto">I do things</div>`;

{
  const p = parseTelegramPreview(CHANNEL, 'https://t.me/kryptback');
  assert.equal(p.kind, 'channel');
  assert.equal(p.title, 'Krypt.cc');
  assert.equal(p.members, 149);
  assert.equal(p.countWord, 'subscribers');
  assert.equal(p.online, null, 'a channel shows no online count');
  assert.equal(p.description, 'Krypt.cc Tele gram & more', 'tags stripped, entities decoded');
  assert.equal(p.privateInvite, false);
  assert.equal(describeTelegram(p), 'channel · 149 subscribers');
  ok('a channel: title, subscribers, description off the live markup');
}

{
  const p = parseTelegramPreview(GROUP, 'https://t.me/BotTalk');
  assert.equal(p.kind, 'group');
  assert.equal(p.members, 26481, 'spaces inside the number');
  assert.equal(p.countWord, 'members');
  assert.equal(p.online, 1564);
  assert.equal(describeTelegram(p), 'group · 26.5K members · 1.6K online');
  ok('a group: members and online');
}

{
  const p = parseTelegramPreview(INVITE, 'https://t.me/+krFbfKJDp6cxNjhh');
  assert.equal(p.kind, 'invite');
  assert.equal(p.members, null, 'no count is null, not 0');
  assert.equal(p.privateInvite, true);
  assert.match(describeTelegram(p), /private invite/);
  // An invite whose page DOES show members (a group Telegram previews) is a group.
  const open = parseTelegramPreview(GROUP, 'https://t.me/+abc');
  assert.equal(open.kind, 'group');
  assert.equal(open.members, 26481);
  assert.equal(open.privateInvite, false);
  ok('a private invite is named as such, with no invented number');
}

{
  const p = parseTelegramPreview(ACCOUNT, 'https://t.me/somebot');
  assert.equal(p.kind, 'account');
  assert.equal(p.members, null);
  assert.equal(p.title, 'Some Bot');
  assert.match(describeTelegram(p), /an account, not a room/);
  const empty = parseTelegramPreview('<html><body>nothing</body></html>', 'https://t.me/x');
  assert.equal(empty.kind, 'unknown');
  assert.equal(empty.title, null);
  assert.equal(describeTelegram(empty), 'no public count on this page');
  ok('an account is not a room; an unrecognised page reads as unknown');
}

{
  assert.equal(telegramPreviewUrl('https://t.me/kryptback'), 'https://t.me/kryptback');
  assert.equal(telegramPreviewUrl('https://t.me/s/kryptback'), 'https://t.me/kryptback', 'the channel view is the same room');
  assert.equal(telegramPreviewUrl('https://telegram.me/kryptback/'), 'https://t.me/kryptback');
  assert.equal(telegramPreviewUrl('https://t.me/kryptback/123'), 'https://t.me/kryptback', 'a message link points at the room');
  assert.equal(telegramPreviewUrl('https://t.me/+krFbfKJDp6cxNjhh'), 'https://t.me/+krFbfKJDp6cxNjhh');
  assert.equal(telegramPreviewUrl('https://t.me/joinchat/AbCdEf'), 'https://t.me/joinchat/AbCdEf');
  assert.equal(telegramPreviewUrl('https://x.com/kryptback'), null);
  assert.equal(telegramPreviewUrl('https://t.me/'), null);
  assert.equal(telegramPreviewUrl('not a url'), null);
  assert.equal(telegramPreviewUrl(null), null);
  ok('every Telegram link shape normalises to one preview page; nothing else does');
}

// The registry's RDAP answer for krypt.cc (tld-rdap.verisign.com, 2026-09-20), trimmed.
const RDAP = {
  objectClassName: 'domain',
  handle: '123',
  ldhName: 'KRYPT.CC',
  status: ['client transfer prohibited'],
  events: [
    { eventAction: 'registration', eventDate: '2010-02-16T02:27:50Z' },
    { eventAction: 'expiration', eventDate: '2027-02-16T02:27:50Z' },
    { eventAction: 'last changed', eventDate: '2025-08-08T12:50:32Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-09-20T10:49:05Z' },
  ],
  entities: [
    {
      objectClassName: 'entity',
      handle: '1068',
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'NameCheap, Inc.']]],
    },
  ],
};

{
  const r = parseRdapDomain(RDAP, 'krypt.cc');
  assert.equal(r.domain, 'krypt.cc');
  assert.equal(r.registeredAt, '2010-02-16T02:27:50.000Z');
  assert.equal(r.expiresAt, '2027-02-16T02:27:50.000Z');
  assert.equal(r.changedAt, '2025-08-08T12:50:32.000Z');
  assert.equal(r.registrar, 'NameCheap, Inc.');
  assert.deepEqual(r.statuses, ['client transfer prohibited']);
  const NOW = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(domainAgeDays(r.registeredAt, NOW), 6060);
  assert.equal(fmtRegistered(r.registeredAt), 'Feb 2010');
  assert.equal(fmtAge(domainAgeDays(r.registeredAt, NOW)), '16 years');
  // Sparse answers: no events, no registrar — unknown, not invented.
  const thin = parseRdapDomain({ ldhName: 'x.fun', events: [] }, 'x.fun');
  assert.equal(thin.registeredAt, null);
  assert.equal(thin.registrar, null);
  assert.equal(parseRdapDomain({ errorCode: 404, title: 'Not Found' }, 'x.fun'), null, 'an error object is not a record');
  assert.equal(parseRdapDomain('nope', 'x.fun'), null);
  assert.equal(domainAgeDays(null), null);
  ok('an RDAP domain object gives its dates and registrar; sparse or wrong answers stay unknown');
}

{
  const boot = {
    version: '1.0',
    services: [
      [['cc'], ['https://tld-rdap.verisign.com/cc/v1/']],
      [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
      [['fun'], ['https://rdap.radix.host/rdap/']],
      [['old'], ['http://only-http.example/rdap/']],
      [['xyz'], ['https://rdap.centralnic.com/xyz']],
    ],
  };
  assert.equal(rdapBaseFor(boot, 'cc'), 'https://tld-rdap.verisign.com/cc/v1/');
  assert.equal(rdapBaseFor(boot, 'NET'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(rdapBaseFor(boot, 'xyz'), 'https://rdap.centralnic.com/xyz/', 'a trailing slash is added');
  assert.equal(rdapBaseFor(boot, 'old'), null, 'http-only is refused');
  assert.equal(rdapBaseFor(boot, 'io'), null, 'a TLD IANA lists no server for (io, me, co on 2026-09-20)');
  assert.equal(rdapBaseFor(null, 'cc'), null);
  assert.deepEqual([...rdapHosts(boot)].sort(), ['rdap.centralnic.com', 'rdap.radix.host', 'rdap.verisign.com', 'tld-rdap.verisign.com']);
  ok('IANA’s bootstrap names the registry server per ending; only those hosts may be asked');
}

{
  assert.deepEqual(websiteHostOf('https://www.krypt.cc/'), { host: 'www.krypt.cc', domain: 'krypt.cc', tld: 'cc', hostedOn: null });
  assert.deepEqual(websiteHostOf('https://deep.sub.krypt.cc/x'), { host: 'deep.sub.krypt.cc', domain: 'krypt.cc', tld: 'cc', hostedOn: null });
  assert.deepEqual(websiteHostOf('https://shop.example.co.uk/'), { host: 'shop.example.co.uk', domain: 'example.co.uk', tld: 'uk', hostedOn: null }, 'a two-label suffix keeps three labels');
  assert.equal(websiteHostOf('https://coin-site.vercel.app').hostedOn, 'Vercel');
  assert.equal(websiteHostOf('https://coin-site.vercel.app').domain, null, 'the platform’s domain age says nothing about the coin');
  assert.equal(websiteHostOf('https://someone.github.io/coin/').hostedOn, 'GitHub Pages');
  assert.equal(websiteHostOf('https://vercel.app').hostedOn, 'Vercel');
  assert.equal(websiteHostOf('http://1.2.3.4/'), null);
  assert.equal(websiteHostOf('https://localhost/'), null);
  assert.equal(websiteHostOf('ftp://x.com'), null);
  assert.equal(websiteHostOf('garbage'), null);
  ok('the registrable domain is found, and a shared platform is named instead of looked up');
}

{
  const NOW = Date.parse('2026-09-20T12:00:00Z');
  const w = websiteHostOf('https://krypt.cc');
  assert.equal(describeDomain(w, parseRdapDomain(RDAP, 'krypt.cc'), NOW), 'krypt.cc · registered Feb 2010 (16 years) · via NameCheap, Inc.');
  assert.equal(describeDomain(websiteHostOf('https://x.vercel.app'), null, NOW), 'hosted on Vercel — no domain of its own');
  assert.equal(describeDomain(w, null, NOW), 'krypt.cc: no registry record read');
  assert.equal(describeDomain(w, { domain: 'krypt.cc', registeredAt: null, expiresAt: null, changedAt: null, registrar: null, statuses: [] }, NOW), 'krypt.cc · registration date not published');
  assert.equal(describeDomain(null, null, NOW), 'no website');
  assert.equal(fmtAge(0), 'today');
  assert.equal(fmtAge(1), '1 day');
  assert.equal(fmtAge(45), '45 days');
  assert.equal(fmtAge(400), '13 months');
  assert.equal(fmtAge(null), '—');
  assert.equal(fmtRegistered(null), '—');
  ok('the strip says the age a person would say, and names what is unknown');
}

{
  // Wiring: main looks these up only for a token someone asked about, the
  // renderer never sends a URL, and the privacy policy names the hosts.
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const main = src('../electron/data/linkIntel.ts');
  assert.ok(/allowHosts: TG_HOSTS/.test(main) && /new Set\(\['t\.me'\]\)/.test(main), 'Telegram lookups reach t.me and nothing else');
  assert.ok(/allowHosts: boot\.hosts/.test(main), 'registry lookups reach the hosts IANA lists and nothing else');
  assert.ok(/redirect: 'manual'/.test(main) && /hops >= 2/.test(main), 'redirects are followed by hand, onto allowlisted hosts only, twice at most');
  assert.ok(/const PER_HOUR = 60/.test(main), 'each source has an hourly budget');
  assert.ok(!/socials\.website\b[^\n]*fetch/.test(main), 'the token’s own website is never fetched');
  const ipc = src('../electron/ipc.ts');
  assert.ok(/ipcMain\.handle\('links:intel:get'/.test(ipc) && /linkIntel\.intel\(mint/.test(ipc), 'the renderer asks by mint; main derives the links itself');
  const legal = src('../shared/legal/documents.ts');
  assert.ok(/t\.me/.test(legal) && /data\.iana\.org/.test(legal), 'the privacy policy names the hosts');
  const engine = src('../electron/engine/engine.ts');
  assert.ok(/linkIntel\.trigger\(mint\)/.test(engine), 'a script asking about a token starts its lookups');
  assert.ok(/linkIntel\.facts\(mint\)/.test(engine), 'and the cached answers ride into the facts');
  ok('wired: by mint, allowlisted hosts, budgeted, disclosed');
}

console.log(`\nlinkintel: ${passed}/${passed} passed`);
