// Telegram preview + domain record, live (2026-09-20): the two lookups
// electron/data/linkIntel.ts makes, against the real t.me and the real
// registry, for the $KRYPTO coin's own links — t.me/kryptback and krypt.cc.
// The one thing the unit tests cannot see: what the sources serve today.
// Read-only; two requests to t.me and IANA, one to Verisign's .cc RDAP.
//
//   npm run test:linkintel

import assert from 'node:assert';
import { lookupDomain, lookupTelegram, _reset } from './.linkintel.main.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

_reset();
const t0 = Date.now();
const tg = await lookupTelegram('https://t.me/kryptback');
check('t.me answered for the $KRYPTO channel', !!tg && !!tg.value, tg?.reason ?? (tg ? 'ok' : 'not a Telegram link?'));
if (tg?.value) {
  const p = tg.value;
  check('it is a channel with a subscriber count', p.kind === 'channel' && p.countWord === 'subscribers', `${p.kind} · ${p.members} ${p.countWord}`);
  check('the count is a plausible number', typeof p.members === 'number' && p.members > 0 && p.members < 10_000_000, String(p.members));
  check('the title was read', typeof p.title === 'string' && p.title.length > 0, p.title ?? 'none');
  check('a channel shows no online count (unknown, not 0)', p.online === null, String(p.online));
}
const again = await lookupTelegram('https://t.me/s/kryptback');
check('the channel view is the same cached room', again === tg, again && tg ? 'same entry' : 'different');

const dom = await lookupDomain('krypt.cc');
check('the registry answered for krypt.cc', !!dom && !!dom.value, dom?.reason ?? (dom ? 'ok' : 'no entry'));
if (dom?.value) {
  const r = dom.value;
  check('registered in February 2010', r.registeredAt?.startsWith('2010-02-16') === true, r.registeredAt ?? 'none');
  check('the registrar is named', typeof r.registrar === 'string' && /namecheap/i.test(r.registrar), r.registrar ?? 'none');
  check('an expiry is stated', typeof r.expiresAt === 'string', r.expiresAt ?? 'none');
}
const cached = await lookupDomain('KRYPT.CC');
check('a second ask is the cache', cached === dom, cached && dom ? 'same entry' : 'different');

// An ending IANA lists no RDAP server for is honestly unknown, not an error.
const io = await lookupDomain('example.io');
check('a .io domain is unknown with the reason stated', !!io && io.value === null && /publishes no RDAP/.test(io.reason ?? ''), io?.reason ?? 'none');

// A domain that does not exist at the registry.
const nope = await lookupDomain('this-domain-does-not-exist-krypt-test-2026.cc');
check('an unregistered .cc name is unknown with the reason stated', !!nope && nope.value === null && /no record/.test(nope.reason ?? ''), nope?.reason ?? 'none');

console.log(`\n${Date.now() - t0} ms for the lot`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall link-intel live checks passed');
assert.equal(failures, 0);
