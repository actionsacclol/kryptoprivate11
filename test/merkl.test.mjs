// The Merkl provider — the rules that ARE the feature.
//
// docs/airdrop-research-2026-09-09.md killed airdrop farming and kept one
// thing: published, funded, address-queryable reward rates. Two rules make
// that safe to ship, and both fail silently if they regress, so both are
// pinned here against the real bundled module with a stubbed fetch.
//
//   1. NO THIRD-PARTY URL ESCAPES. Merkl puts `depositUrl` and
//      `explorerAddress` on every opportunity. Fake claim domains for our own
//      rail already exist, and checking the domain is not a defence —
//      BadgerDAO lost $120.3M to an approval injected into the CORRECT site.
//      Tests 5 and 6 assert it at both ends: nothing in any returned object,
//      and the shipped bundle does not so much as contain the field names.
//
//   2. "NONE" AND "WE COULD NOT ASK" ARE DIFFERENT FACTS. `[]` on a 200 is a
//      real zero; a failure, a park or a body this build cannot read is
//      `rows: null` and renders as an em dash. Jupiter's claim worker answers
//      "not eligible" with HTTP 200 and Content-Length 0 — that exact trap,
//      applied to whether someone has money waiting. Tests 1-4 and 7-11.
//
// No network: fetch is stubbed. Tests run in order and share the module's
// cache, so each chain id is used once.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { opportunities, walletRewards, fromBaseUnits, isAddress } from './.merkl.mjs';

const ADDR = '0x0000000000000000000000000000000000000001';

let hits = [];
function stubFetch(handler) {
  hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push(String(url));
    return handler(String(url), init, hits.length);
  };
}
const res = (status, body = '[]', headers = { 'content-type': 'application/json' }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  body: null,
  text: async () => body,
});

/** One real opportunity row, captured from api.merkl.xyz on 2026-09-09 —
 *  including the two fields that must never come out the other side. */
const REAL_OPPORTUNITY = {
  chainId: 4663,
  type: 'MORPHOCOLLATERAL',
  identifier: '0xc845dA65a020DDca5f132EFA8Fea79676D8EDFDE',
  name: 'Deposit USDe as collateral on USDe/USDG 91.5%',
  description: 'Earn rewards by supplying USDe as a collateral on Morpho on Robinhood Chain',
  howToSteps: ['Go to Morpho and deposit USDe as collateral.'],
  status: 'LIVE',
  action: 'LEND',
  tvl: 319043091.9647625,
  apr: 4.749999999999999,
  dailyRewards: 41519.30648856498,
  latestCampaignEnd: '1789052400',
  id: '6518393048281704051',
  depositUrl: 'https://app.morpho.org/robinhood-chain/market/0xc845da65/usde-usdg#market',
  explorerAddress: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
  tokens: [{ symbol: 'USDe', decimals: 18, address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', icon: 'https://example.invalid/x.png' }],
  chain: { id: 4663, name: 'Robinhood Chain' },
  protocol: { id: 'morpho', name: 'Morpho', url: 'https://morpho.org/', icon: 'https://example.invalid/m.svg' },
};

/** A rewards document, shaped exactly as the live API answered. */
const REAL_REWARDS = [
  {
    chain: { id: 4663, name: 'Robinhood Chain' },
    rewards: [
      {
        root: '0x6a7ca85c620683dc5b2cb6f7b92c56cedd468d501ef5306b7e66c838ed9676be',
        distributionChainId: 4663,
        recipient: ADDR,
        amount: '9076071563221601707',
        claimed: '76071563221601707',
        pending: '0',
        proofs: ['0x2a876a2b', '0x090eced6'],
        token: { chainId: 4663, address: '0xD223bbdd0421E394C0df9dFfe568f1dADfFd6f85', decimals: 18, symbol: 'Gravity Points' },
      },
    ],
  },
];

// ── 1. `[]` on a 200 is a real answer meaning NONE ───────────────────────
{
  stubFetch(() => res(200, '[]'));
  const a = await opportunities(4663);
  assert.ok(Array.isArray(a.rows), 'an empty list is rows: [], not null');
  assert.equal(a.rows.length, 0);
  assert.equal(a.message, 'ok');
  assert.ok(typeof a.at === 'number', 'a real answer is stamped with when it was read');

  const w = await walletRewards(4663, ADDR);
  assert.deepEqual(w.rows, [], 'the zero-address case Merkl really serves: [] means nothing accrued');
  console.log('ok  [] reads as "none", on both routes');
}

// ── 2. a failed request is UNKNOWN, and is never zero ────────────────────
{
  stubFetch(() => res(500, 'upstream exploded'));
  const a = await opportunities(10);
  assert.equal(a.rows, null, 'a 500 must be null — an em dash, never an empty list');
  assert.notDeepEqual(a.rows, [], 'the failure must not be indistinguishable from "no campaigns"');
  assert.match(a.message, /500/);
  assert.equal(a.at, null, 'nothing was read, so there is no read time');

  const w = await walletRewards(10, ADDR);
  assert.equal(w.rows, null, 'a failed rewards lookup never says "no rewards"');
  console.log('ok  a failed request is UNKNOWN, not zero');
}

// ── 3. the "refusal as success" trap: HTTP 200 with an empty body ────────
//
// Jupiter's claim-proof worker answers "not eligible" with HTTP 200, a JSON
// content-type and Content-Length 0. Here that must not become "no rewards".
{
  stubFetch(() => res(200, ''));
  const a = await opportunities(14);
  assert.equal(a.rows, null, 'HTTP 200 with an empty body is unknown, not "no campaigns"');
  const w = await walletRewards(14, ADDR);
  assert.equal(w.rows, null, 'HTTP 200 with an empty body is unknown, not "no rewards"');
  console.log('ok  an empty 200 body is UNKNOWN (the Jupiter trap)');
}

// ── 4. a malformed body does not throw, and does not read as zero ────────
{
  const bodies = [
    ['an object where an array belongs', '{"error":"nope"}'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['truncated JSON', '[{"id":"1",'],
    ['rows of the wrong shape', '[1,2,3]'],
    ['rows missing every field we read', '[{"foo":"bar"},{"baz":1}]'],
  ];
  let chainId = 20;
  for (const [label, body] of bodies) {
    stubFetch(() => res(200, body));
    let a;
    await assert.doesNotReject(async () => {
      a = await opportunities(chainId);
    }, `${label} must not throw`);
    assert.equal(a.rows, null, `${label} → unknown, not an empty list`);

    stubFetch(() => res(200, body));
    let w;
    await assert.doesNotReject(async () => {
      w = await walletRewards(chainId, ADDR);
    }, `${label} must not throw on the rewards route`);
    assert.equal(w.rows, null, `${label} → unknown on the rewards route too`);
    chainId += 1;
  }
  console.log(`ok  ${bodies.length} malformed bodies: none threw, none read as zero`);
}

// ── 5. NO code path emits depositUrl, explorerAddress, or any URL ────────
{
  stubFetch(() => res(200, JSON.stringify([REAL_OPPORTUNITY, REAL_OPPORTUNITY])));
  // A fresh chain id each time: the module caches a successful read for five
  // minutes, and test 1 already put an empty list under 4663.
  const a = await opportunities(30);
  assert.equal(a.rows.length, 2, 'the real row maps');
  assert.equal(a.rows[0].protocol, 'Morpho');
  assert.equal(a.rows[0].name, REAL_OPPORTUNITY.name, 'the pool name survives, as text');
  assert.equal(a.rows[0].dailyRewardsUsd, REAL_OPPORTUNITY.dailyRewards);

  const dumped = JSON.stringify(a);
  assert.ok(!dumped.includes(REAL_OPPORTUNITY.depositUrl), 'depositUrl must not appear in the answer');
  assert.ok(!dumped.includes(REAL_OPPORTUNITY.explorerAddress), 'explorerAddress must not appear in the answer');
  assert.ok(!/https?:\/\//i.test(dumped), `no URL of any kind may reach the renderer — got: ${dumped.slice(0, 200)}`);
  assert.ok(!/depositUrl|explorerAddress|proofs|icon/i.test(dumped), 'and the field names never appear either');
  for (const row of a.rows) {
    assert.ok(!('depositUrl' in row), 'the mapped row has no depositUrl property at all');
    assert.ok(!('explorerAddress' in row), 'the mapped row has no explorerAddress property at all');
  }
  console.log('ok  no URL, no depositUrl, no explorerAddress reaches the renderer');
}

// ── 6. …and the shipped bundle cannot even name them ─────────────────────
//
// Test 5 proves it for the fixture. This proves there is no OTHER branch —
// a debug path, a second mapper, a "just for the tooltip" field — that could
// read those keys, because the compiled module never mentions them.
{
  const bundle = readFileSync(new URL('./.merkl.mjs', import.meta.url), 'utf8');
  assert.ok(!bundle.includes('depositUrl'), 'the built provider never reads depositUrl');
  assert.ok(!bundle.includes('explorerAddress'), 'the built provider never reads explorerAddress');
  assert.ok(!bundle.includes('howToSteps'), 'nor the instructions that carry protocol links');
  assert.ok(!bundle.includes('proofs'), 'nor the merkle proofs a claim UI would need');
  // The only URL text in the whole bundle is http.ts's fixed-origin template,
  // `https://${host}`, whose host can only come from its hardcoded HOSTS
  // table. There is no concrete destination compiled in anywhere — so there
  // is nothing for a row of Merkl data to point at.
  const urls = [...new Set(bundle.match(/https?:\/\/[^\s'"`]*/g) ?? [])];
  assert.deepEqual(urls, ['https://${host}'], `only the fixed-origin template may appear; found ${JSON.stringify(urls)}`);
  assert.ok(bundle.includes('api.merkl.xyz'), 'the host is the hardcoded one from http.ts');
  console.log('ok  the built bundle contains no URL literal and cannot name the link fields');
}

// ── 7. rewards: amounts are exact, and an unreadable one is null ─────────
{
  stubFetch(() => res(200, JSON.stringify(REAL_REWARDS)));
  const w = await walletRewards(31, ADDR);
  assert.equal(w.rows.length, 1);
  const r = w.rows[0];
  assert.equal(r.tokenSymbol, 'Gravity Points');
  assert.ok(Math.abs(r.earned - 9.076071563221602) < 1e-9, `earned: ${r.earned}`);
  assert.ok(Math.abs(r.unclaimed - 9) < 1e-9, `unclaimed = earned - claimed: ${r.unclaimed}`);
  assert.equal(r.pending, 0, 'a wire "0" IS zero — the provider said so');
  assert.ok(!JSON.stringify(w).includes('0x6a7ca85c'), 'the merkle root does not travel');
  assert.ok(!JSON.stringify(w).includes('0x2a876a2b'), 'nor do the proofs');

  // An amount this build cannot read is unknown — never 0, and it poisons the
  // subtraction rather than overstating what can be collected.
  stubFetch(() =>
    res(200, JSON.stringify([{ chain: { id: 56 }, rewards: [{ ...REAL_REWARDS[0].rewards[0], claimed: 'not-a-number' }] }])),
  );
  const bad = await walletRewards(56, ADDR);
  assert.equal(bad.rows.length, 1);
  assert.equal(bad.rows[0].claimed, null, 'an unreadable amount is null, not 0');
  assert.equal(bad.rows[0].unclaimed, null, 'and the difference is unknown, not "all of it"');
  console.log('ok  amounts are exact; an unreadable amount is null, never 0');
}

// ── 8. a recognised chain group with no rewards IS zero ──────────────────
//
// The distinction test 4 relies on cuts both ways: a document this build
// understands, saying nothing accrued, must not be downgraded to unknown.
{
  stubFetch(() => res(200, JSON.stringify([{ chain: { id: 56 }, rewards: [] }])));
  const w = await walletRewards(57, ADDR);
  assert.deepEqual(w.rows, [], 'an understood, empty document is a real "nothing accrued"');
  console.log('ok  an understood empty document still reads as "none"');
}

// ── 9. no address, no request ───────────────────────────────────────────
{
  stubFetch(() => res(200, '[]'));
  const bad = await walletRewards(4663, 'notanaddress');
  assert.equal(bad.rows, null, 'a bad address is refused as unknown');
  assert.equal(hits.length, 0, 'and nothing was sent to Merkl');
  assert.equal(isAddress(ADDR), true);
  assert.equal(isAddress('0x123'), false);
  assert.equal(isAddress(null), false);
  console.log('ok  a malformed address is refused before anything is sent');
}

// ── 10. base-unit conversion is BigInt-exact ─────────────────────────────
{
  assert.equal(fromBaseUnits('1000000000000000000', 18), 1);
  assert.equal(fromBaseUnits('0', 18), 0);
  assert.equal(fromBaseUnits('1', 0), 1);
  // Past 2^53: a float parse would silently rewrite the last digits of
  // somebody's balance.
  assert.ok(Math.abs(fromBaseUnits('123456789012345678901234', 18) - 123456.78901234568) < 1e-6);
  for (const bad of ['', 'abc', '1.5', '-1', null, undefined, 12, {}]) {
    assert.equal(fromBaseUnits(bad, 18), null, `unreadable amount ${JSON.stringify(bad)} → null`);
  }
  for (const bad of [null, 'x', -1, 1.5, 99]) {
    assert.equal(fromBaseUnits('1000', bad), null, `unreadable decimals ${JSON.stringify(bad)} → null`);
  }
  console.log('ok  base-unit conversion is exact, and refuses what it cannot read');
}

// ── 11. a PARKED provider is UNKNOWN too ─────────────────────────────────
//
// The 429 parks `merkl` inside http.ts; the call behind it fails fast at the
// front of the queue without a request. That fail-fast must arrive as null.
//
// LAST on purpose. The park is module state on a 20 s clock and http.ts
// exposes no reset, so every check after this one would fail fast without a
// request and pass for the wrong reason. It did, while this block sat third:
// tests 3-5 were all being answered by a leftover park rather than by the
// bodies they stub.
{
  stubFetch(() => res(429));
  const first = await opportunities(11);
  assert.equal(first.rows, null);
  assert.match(first.message, /rate limited/i);

  const parked = await opportunities(12);
  assert.equal(parked.rows, null, 'a parked provider is unknown, not empty');
  assert.match(parked.message, /rate limited, retrying in \d+s/);
  assert.equal(hits.length, 1, 'the second call never left the machine — and still did not report zero');

  const w = await walletRewards(13, ADDR);
  assert.equal(w.rows, null, 'the park reaches the rewards route as unknown as well');
  console.log('ok  a parked provider reads as UNKNOWN, never as zero');
}

console.log('');
console.log('merkl: all checks passed');
