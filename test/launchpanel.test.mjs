// Launch panel render tests.
//
// The cohort maths is pinned in launchintel.test.mjs; this pins the half that
// unit tests normally miss and screenshots lie about. Two failure modes, both
// seen before in this codebase:
//
//   • a null percentage rendering as "0.0%" instead of an em dash, which
//     turns "we could not price these wallets" into "they sold everything";
//   • a panel that throws on a report with nulls in it, which in the app
//     looks like an empty tab rather than an error.
//
// Rendered server-side, so it runs offline in `npm test`.

import assert from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { LaunchPanel } from './.launchpanel.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const cohort = (over = {}) => ({
  wallets: 0,
  bought: 0,
  boughtPct: null,
  sol: 0,
  heldPct: null,
  retainedPct: null,
  stillHolding: null,
  ...over,
});

const report = (over = {}) => ({
  mint: 'MintAAA',
  creator: 'DEVwa11et',
  supply: 1_000_000_000,
  sniperWindowSlots: 20,
  source: 'pumpswap',
  note: null,
  balancesNote: null,
  generatedAt: Date.now(),
  analysis: {
    launchSlot: 441_502_089,
    launchTs: Date.now() - 3_600_000,
    complete: true,
    tradesScanned: 42,
    slotsSpanned: 18,
    priced: true,
    dev: cohort({ wallets: 1, bought: 30_000_000, boughtPct: 3, sol: 4.2, heldPct: 0, retainedPct: 0, stillHolding: 0 }),
    bundle: cohort({
      wallets: 12,
      bought: 140_000_000,
      boughtPct: 14,
      sol: 21.5,
      heldPct: 9.5,
      retainedPct: 68,
      stillHolding: 7,
    }),
    snipers: cohort({ wallets: 5, bought: 50_000_000, boughtPct: 5, sol: 8, heldPct: 1.25, retainedPct: 25, stillHolding: 2 }),
    wallets: [
      {
        address: 'BundlerOne',
        cohort: 'bundle',
        firstSlot: 441_502_089,
        slotOffset: 0,
        bought: 80_000_000,
        boughtPct: 8,
        sol: 12,
        soldInWindow: false,
        heldNow: 60_000_000,
        heldPct: 6,
      },
      {
        address: 'SniperOne',
        cohort: 'sniper',
        firstSlot: 441_502_092,
        slotOffset: 3,
        bought: 20_000_000,
        boughtPct: 2,
        sol: 3,
        soldInWindow: true,
        heldNow: null,
        heldPct: null,
      },
    ],
  },
  ...over,
});

const render = (props) => renderToStaticMarkup(createElement(LaunchPanel, { history: null, loading: false, ...props }));

test('a measured report shows both what was bought and what is still held', () => {
  const html = render({ report: report() });
  assert.match(html, /14\.00%/, 'the bundle share bought');
  assert.match(html, /9\.50%/, 'the bundle share still held');
  assert.match(html, /68% kept/);
  assert.match(html, /7\/12/, 'wallets still in');
});

test('an unpriced cohort renders em dashes, never zeros', () => {
  // Every cohort unpriced — a genuine 0% (a cohort that really did sell out)
  // must still be free to render as 0%, so the fixture must not mix the two.
  const r = report();
  r.analysis.dev = cohort({ wallets: 1, bought: 30_000_000, boughtPct: 3, sol: 4.2 });
  r.analysis.bundle = cohort({ wallets: 12, bought: 140_000_000, boughtPct: 14, sol: 21.5 });
  r.analysis.snipers = cohort({ wallets: 5, bought: 50_000_000, boughtPct: 5, sol: 8 });
  r.analysis.wallets = r.analysis.wallets.map((w) => ({ ...w, heldNow: null, heldPct: null }));
  r.analysis.priced = false;
  const html = render({ report: r });
  assert.match(html, /14\.00%/, 'what they bought is still known');
  // The three unpriced fields must all be dashes.
  const dashes = (html.match(/—/g) ?? []).length;
  assert.ok(dashes >= 3, `expected at least 3 em dashes for unknowns, found ${dashes}`);
  assert.doesNotMatch(html, /0% kept/, 'unknown retention must not read as a total dump');
});

test('an unmeasured launch shows the reason and NO cohort numbers', () => {
  const html = render({
    report: report({
      note: "pump.fun's trade history does not reach this token's launch (2024-02-18).",
      analysis: {
        ...report().analysis,
        complete: false,
        tradesScanned: 0,
        launchSlot: null,
        dev: cohort(),
        bundle: cohort(),
        snipers: cohort(),
        wallets: [],
      },
    }),
  });
  assert.match(html, /Launch cohorts not measured/);
  assert.match(html, /does not reach this token/);
  assert.doesNotMatch(html, /of supply bought/, 'no cohort cards when nothing was measured');
});

test('the sniper window definition is shown, not just applied', () => {
  const html = render({ report: report() });
  assert.match(html, /within 20 slots/, 'the window must be stated in the UI');
});

test('a creator track record renders its verdict and scope caveat', () => {
  const history = {
    address: 'DEVwa11et',
    launches: 40,
    graduated: 0,
    graduationRate: 0,
    firstLaunchAt: Date.now() - 3 * 86_400_000,
    lastLaunchAt: Date.now(),
    medianAthUsd: 4000,
    bestAthUsd: 9000,
    recent: [
      { mint: 'm1', symbol: 'AAA', name: 'A', createdAt: Date.now(), graduated: false, athUsd: 4000, marketCapUsd: null },
      { mint: 'm2', symbol: 'BBB', name: 'B', createdAt: Date.now() - 1000, graduated: true, athUsd: 9000, marketCapUsd: null },
    ],
    truncated: false,
    launchesInBusiestDay: 22,
  };
  const html = render({ report: report(), history });
  assert.match(html, /Launch factory/i);
  assert.match(html, /pump\.fun launches only/, 'the scope caveat must always ship with the number');
});

test('the panel renders while loading and with no report at all', () => {
  assert.ok(render({ report: null, loading: true }).length > 0);
  assert.ok(render({ report: null, loading: false }).length > 0);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`launchpanel: ${passed}/${cases.length} tests passed`);
}

await run();
