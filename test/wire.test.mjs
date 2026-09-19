// The information hub — the rules that keep it honest.
//
// test/fixtures/dexscreener-boosts.json is a REAL /token-boosts/latest/v1
// payload captured 2026-09-19, trimmed to four live rows plus two the parser
// must reject: an ethereum row (a chain this app does not trade) and a row
// with no token address.
//
// What is pinned here is not "does it parse". It is the three things that
// would quietly turn this panel into the thing it was built to replace:
// showing a coin the user cannot trade, ranking by anything other than what
// was spent, and following a link the app did not verify is https.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  engineRail,
  providerRails,
  worstState,
  parseBoosts,
  parseProfiles,
  hubChainLabel,
  HUB_CHAINS,
} from './.wire.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const boostsRaw = JSON.parse(fs.readFileSync('test/fixtures/dexscreener-boosts.json', 'utf8'));

{
  const rows = parseBoosts(boostsRaw, [...HUB_CHAINS]);
  assert.equal(rows.length, 4, 'four tradeable rows survive; ethereum and the malformed row do not');
  assert.ok(!rows.some((r) => r.chainId === 'ethereum'), 'a chain this app cannot trade is never shown');
  assert.ok(rows.every((r) => r.tokenAddress), 'every row has an address to open');
  // Biggest spend first is the whole point of the panel.
  for (let i = 0; i < rows.length - 1; i++) {
    assert.ok((rows[i].totalAmount ?? 0) >= (rows[i + 1].totalAmount ?? 0), 'sorted by what was actually spent');
  }
  ok(`a real boosts payload parses to ${rows.length} rows, biggest spend first`);
}

{
  // Links are attacker-controlled text on someone else's coin. Anything the
  // app would put behind a click has to be https and nothing else.
  const rows = parseBoosts(
    [
      {
        chainId: 'solana',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        links: [
          { type: 'twitter', url: 'https://x.com/ok' },
          { type: 'evil', url: 'javascript:alert(1)' },
          { type: 'evil2', url: 'http://plain.example' },
          { type: 'evil3', url: 'file:///etc/passwd' },
          { url: 42 },
          'not-an-object',
        ],
      },
    ],
    [...HUB_CHAINS],
  );
  assert.equal(rows[0].links.length, 1, 'only the https link survives');
  assert.equal(rows[0].links[0].url, 'https://x.com/ok');
  ok('a link the app would open is https or it is dropped');
}

{
  assert.deepEqual(parseBoosts(null, [...HUB_CHAINS]), []);
  assert.deepEqual(parseBoosts({ rows: [] }, [...HUB_CHAINS]), [], 'an envelope is not an array');
  assert.deepEqual(parseBoosts([null, 3, 'x'], [...HUB_CHAINS]), []);
  assert.deepEqual(parseProfiles(null, [...HUB_CHAINS]), []);
  ok('a payload that changed shape is an empty panel, never a throw');
}

{
  const p = parseProfiles(
    [
      { chainId: 'solana', tokenAddress: 'A'.repeat(43), cto: true },
      { chainId: 'solana', tokenAddress: 'B'.repeat(43) },
    ],
    [...HUB_CHAINS],
  );
  assert.equal(p.length, 2);
  assert.equal(p[0].cto, true, 'a community takeover is flagged when the source says so');
  assert.equal(p[1].cto, false, 'and is NOT claimed when the field is absent');
  ok('community takeover is reported, never inferred');
}

{
  assert.equal(hubChainLabel('solana'), 'SOL');
  assert.equal(hubChainLabel('bsc'), 'BNB', "DexScreener's bsc is this app's BNB");
  ok('chain labels match what the rest of the app calls them');
}

// ── Rails ────────────────────────────────────────────────────────────

const STATUS = { running: true, feed: 'live', slot: 448091615, eventsPerSec: 12.5, decodeLatencyMs: 19 };

{
  assert.equal(engineRail(null, null, null).state, 'unknown', 'never read is unknown, not ok');
  assert.equal(engineRail({ ...STATUS, running: false }, null, 1).state, 'down');
  assert.equal(engineRail(STATUS, 'Feed data is stale', 1).state, 'degraded');
  // The engine's own sentence is passed through, not re-worded: two
  // descriptions of one state is how they come to disagree.
  assert.equal(engineRail(STATUS, 'Feed data is stale', 1).detail, 'Feed data is stale');
  assert.equal(engineRail(STATUS, null, 1).state, 'ok');
  assert.match(engineRail(STATUS, null, 1).detail, /448,091,615/, 'the slot is readable, not raw');
  ok('the scanner rail reports stopped, paused and live as three different things');
}

{
  const base = { id: 'jupiter', label: 'Jupiter', host: 'lite-api.jup.ag', keyless: true, provides: 'prices', errors: 0, lastError: null, lastCallAt: 1, latencyMs: 40, queued: 0 };
  const rows = providerRails(
    [
      { ...base, id: 'a', label: 'Quota', enabled: true, usable: true, calls: 5, cooldownMs: 6_000, cooldownIsQuota: true },
      { ...base, id: 'b', label: 'Fine', enabled: true, usable: true, calls: 9, cooldownMs: 0 },
      { ...base, id: 'c', label: 'NoKey', enabled: true, usable: false, calls: 0, cooldownMs: 0 },
      { ...base, id: 'd', label: 'Off', enabled: false, usable: true, calls: 0, cooldownMs: 0 },
      { ...base, id: 'e', label: 'Untouched', enabled: true, usable: true, calls: 0, cooldownMs: 0 },
    ],
    1,
  );
  assert.ok(!rows.some((r) => r.label === 'Off'), 'a provider the user switched off is not a fault');
  assert.equal(rows[0].label, 'NoKey', 'worst first — someone opens this because something is wrong');
  assert.equal(rows[0].state, 'down');
  const quota = rows.find((r) => r.label === 'Quota');
  // The distinction that matters: waiting fixes a throttle, not an allowance.
  assert.match(quota.detail, /Waiting will not clear this/, 'a spent allowance says so');
  assert.equal(rows.find((r) => r.label === 'Untouched').state, 'unknown', 'never called is unknown, not ok');
  assert.equal(rows.find((r) => r.label === 'Fine').state, 'ok');
  ok('provider rails separate off, unread, throttled, spent and broken');
}

{
  assert.equal(worstState([{ state: 'ok' }, { state: 'degraded' }, { state: 'ok' }]), 'degraded');
  assert.equal(worstState([{ state: 'degraded' }, { state: 'down' }]), 'down');
  assert.equal(worstState([{ state: 'ok' }]), 'ok');
  assert.equal(worstState([]), 'ok', 'nothing to report is not a fault');
  ok('the headline takes the worst row, so one broken rail is never averaged away');
}

console.log(`\nwire: ${passed}/${passed} passed`);
