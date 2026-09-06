// Paper-position tests.
//
// The properties under test: a paper fill uses the SIMULATION's numbers, a
// paper sell never fills at a made-up price, the 1% exit model is applied
// exactly once, and a paper position renders as a `Position` flagged paper
// with an honest null wherever it cannot be priced.

import assert from 'node:assert';
import {
  emptyPaperBook,
  openPaper,
  sellPaper,
  paperRealizedSol,
  paperToPosition,
  parsePaperBook,
  PAPER_ROUND_TRIP_COST_PCT,
  MAX_OPEN_PAPER_POSITIONS,
  PAPER_FILL_MODEL,
} from './.paper.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const MINT = 'PaperMint11111111111111111111111111111111';
const T0 = 1_700_000_000_000;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('open books the simulated tokens and cost verbatim', () => {
  const r = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1_000_000, costSol: 0.10234, decimalsKnown: true }, T0);
  assert.equal(r.ok, true);
  assert.equal(r.book.open.length, 1);
  const p = r.book.open[0];
  assert.equal(p.tokens, 1_000_000);
  assert.equal(p.costSol, 0.10234, 'cost is the simulated lamport delta, not the requested amount');
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].side, 'buy');
  assert.equal(p.openedAt, T0);
});

test('open refuses zero tokens or zero cost', () => {
  assert.equal(openPaper(emptyPaperBook(), { mint: MINT, symbol: '', tokens: 0, costSol: 0.1, decimalsKnown: true }).ok, false);
  assert.equal(openPaper(emptyPaperBook(), { mint: MINT, symbol: '', tokens: 10, costSol: 0, decimalsKnown: true }).ok, false);
});

test('a second buy averages into the same position', () => {
  let b = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 100, costSol: 1, decimalsKnown: true }, T0).book;
  b = openPaper(b, { mint: MINT, symbol: 'PPR', tokens: 100, costSol: 3, decimalsKnown: true }, T0 + 1).book;
  assert.equal(b.open.length, 1);
  assert.equal(b.open[0].tokens, 200);
  assert.equal(b.open[0].costSol, 4);
  assert.equal(b.open[0].fills.length, 2);
});

test('book is bounded at MAX_OPEN_PAPER_POSITIONS', () => {
  let b = emptyPaperBook();
  for (let i = 0; i < MAX_OPEN_PAPER_POSITIONS; i++) {
    b = openPaper(b, { mint: `M${i}`, symbol: '', tokens: 1, costSol: 0.01, decimalsKnown: true }).book;
  }
  const r = openPaper(b, { mint: 'Overflow', symbol: '', tokens: 1, costSol: 0.01, decimalsKnown: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /full/);
  // Adding to an EXISTING position is still allowed at the cap.
  assert.equal(openPaper(b, { mint: 'M0', symbol: '', tokens: 1, costSol: 0.01, decimalsKnown: true }).ok, true);
});

test('full sell applies the 1% model once and realizes proceeds − cost', () => {
  const b = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1000, costSol: 1, decimalsKnown: true }, T0).book;
  const r = sellPaper(b, MINT, 100, 0.002, T0 + 60_000); // gross 2 SOL
  assert.equal(r.ok, true);
  const expected = 2 * (1 - PAPER_ROUND_TRIP_COST_PCT / 100);
  assert.ok(near(r.proceedsSol, expected), `proceeds ${r.proceedsSol} != ${expected}`);
  assert.ok(near(r.realizedSol, expected - 1));
  assert.equal(r.closed, true);
  assert.equal(r.book.open.length, 0);
  assert.equal(r.book.closed.length, 1);
  assert.ok(near(r.book.closed[0].pnlSol, expected - 1));
  assert.equal(r.book.closed[0].holdMs, 60_000);
  assert.ok(r.message.includes(PAPER_FILL_MODEL), 'toast states the model');
  assert.ok(near(paperRealizedSol(r.book), expected - 1));
});

test('partial sell keeps the remainder at average cost', () => {
  const b = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1000, costSol: 1, decimalsKnown: true }, T0).book;
  const r = sellPaper(b, MINT, 25, 0.001, T0 + 1); // gross 0.25 SOL
  assert.equal(r.ok, true);
  assert.equal(r.closed, false);
  assert.equal(r.tokensSold, 250);
  const p = r.book.open[0];
  assert.equal(p.tokens, 750);
  assert.ok(near(p.costSol, 0.75));
  assert.ok(near(r.realizedSol, 0.25 * 0.99 - 0.25));
  assert.ok(near(p.realizedSol, r.realizedSol));
  assert.ok(near(paperRealizedSol(r.book), r.realizedSol), 'partials count in the realized total');
  // Then close the rest: the closed trade's cost is the FULL original cost.
  const r2 = sellPaper(r.book, MINT, 100, 0.001, T0 + 2);
  assert.equal(r2.closed, true);
  assert.ok(near(r2.book.closed[0].costSol, 1));
  assert.ok(near(r2.book.closed[0].proceedsSol, 0.99));
  assert.ok(near(paperRealizedSol(r2.book), -0.01));
});

test('sell never fills at a null or zero price', () => {
  const b = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1000, costSol: 1, decimalsKnown: true }).book;
  for (const px of [null, 0, -1, NaN]) {
    const r = sellPaper(b, MINT, 100, px);
    assert.equal(r.ok, false, `price ${px} must refuse`);
    assert.match(r.message, /no price to fill a paper sell/);
    assert.equal(r.book.open.length, 1, 'position untouched');
  }
});

test('sell of an unknown mint refuses', () => {
  assert.equal(sellPaper(emptyPaperBook(), MINT, 100, 1).ok, false);
});

test('unknown-decimals position closes as a full loss, never valued at a guess', () => {
  const b = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'RAW', tokens: 5_000_000_000, costSol: 0.5, decimalsKnown: false }).book;
  const r = sellPaper(b, MINT, 100, 0.001);
  assert.equal(r.ok, true);
  assert.equal(r.proceedsSol, 0);
  assert.ok(near(r.realizedSol, -0.5));
  assert.match(r.message, /units unknown/);
});

test('paperToPosition: priced → paper flag, basisKnown, honest PnL', () => {
  const p = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1000, costSol: 1, decimalsKnown: true }, T0).book.open[0];
  const pos = paperToPosition(
    p,
    { priceSol: 0.0015, priceUsd: 0.3, marketCapUsd: 300_000, name: 'Paper', symbol: 'PPR', imageUrl: null, circSupply: 1_000_000, decimals: 6 },
    200,
  );
  assert.equal(pos.paper, true);
  assert.equal(pos.basisKnown, true);
  assert.equal(pos.costSol, 1);
  assert.ok(near(pos.valueSol, 1.5));
  assert.ok(near(pos.unrealizedPnlSol, 0.5));
  assert.ok(near(pos.unrealizedPnlPct, 50));
  assert.ok(near(pos.avgEntryPriceSol, 0.001));
  assert.ok(near(pos.entryMcapUsd, 0.001 * 200 * 1_000_000));
  assert.equal(pos.realizedPnlSol, 0);
  assert.equal(pos.firstBuyAt, T0);
});

test('paperToPosition: no price → value and PnL are null, not 0', () => {
  const p = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'PPR', tokens: 1000, costSol: 1, decimalsKnown: true }).book.open[0];
  const pos = paperToPosition(p, undefined, null);
  assert.equal(pos.paper, true);
  assert.equal(pos.costSol, 1, 'cost is always known for paper');
  assert.equal(pos.valueSol, null);
  assert.equal(pos.unrealizedPnlSol, null);
  assert.equal(pos.unrealizedPnlPct, null);
  assert.equal(pos.entryMcapUsd, null);
});

test('paperToPosition: unknown decimals → unpriceable even with a price', () => {
  const p = openPaper(emptyPaperBook(), { mint: MINT, symbol: 'RAW', tokens: 5e9, costSol: 1, decimalsKnown: false }).book.open[0];
  const pos = paperToPosition(p, { priceSol: 0.001, priceUsd: null, marketCapUsd: null, name: '', symbol: '', imageUrl: null, circSupply: null, decimals: 6 }, 200);
  assert.equal(pos.valueSol, null);
  assert.equal(pos.unrealizedPnlSol, null);
  assert.equal(pos.avgEntryPriceSol, null);
});

test('parsePaperBook survives garbage and drops empty positions', () => {
  assert.deepEqual(parsePaperBook(null).open, []);
  assert.deepEqual(parsePaperBook('nope').open, []);
  const b = parsePaperBook({ open: [{ mint: MINT, tokens: 0, costSol: 1 }, { mint: 'ok', tokens: 5, costSol: 1 }], closed: [{ mint: 'x', pnlSol: 'bad' }] });
  assert.equal(b.open.length, 1);
  assert.equal(b.open[0].mint, 'ok');
  assert.equal(b.open[0].decimalsKnown, true, 'legacy rows without the flag are UI units');
  assert.equal(b.closed.length, 0);
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
  console.log(`paper: ${passed}/${cases.length} tests passed`);
}

await run();

// ── A paper buy that cannot reach the chain ──────────────────────────
// Paper mode exists to be used with no money. Requiring an on-chain
// simulation meant it failed for exactly those people; the modelled fill is
// the fallback, and it must not flatter the trade.
{
  const { modelledPaperFill, PAPER_SIDE_COST } = await import('./.paper.mjs');
  const fill = modelledPaperFill(1, 0.001);
  assert.ok(fill, 'a price and a size are enough');
  assert.equal(fill.costSol, 1, 'the cost is what left the wallet');
  assert.ok(fill.tokens < 1000, 'fees come off the top, so it buys less than the raw division');
  assert.ok(Math.abs(fill.tokens - (1 * (1 - PAPER_SIDE_COST)) / 0.001) < 1e-9, 'and exactly the fees a real buy pays');

  // Nothing unknowable is invented.
  assert.equal(modelledPaperFill(1, 0), null, 'no price, no fill');
  assert.equal(modelledPaperFill(1, -0.5), null);
  assert.equal(modelledPaperFill(0, 0.001), null, 'no size, no fill');
  assert.equal(modelledPaperFill(-1, 0.001), null);
  assert.equal(modelledPaperFill(NaN, 0.001), null);
  assert.equal(modelledPaperFill(1, NaN), null);
  console.log('ok  a modelled paper fill charges real fees, or refuses');
}
