// Paper-position tests.
//
// The properties under test: a paper fill uses the SIMULATION's numbers, a
// paper sell never fills at a made-up price, the 1% exit model is applied
// exactly once, and a paper position renders as a `Position` flagged paper
// with an honest null wherever it cannot be priced.

import assert from 'node:assert';
import {
  paperHistoryRows,
  emptyPaperBook,
  openPaper,
  sellPaper,
  paperRealizedSol,
  paperToPosition,
  parsePaperBook,
  PAPER_ROUND_TRIP_COST_PCT,
  MAX_OPEN_PAPER_POSITIONS,
  PAPER_FILL_MODEL,
  samePaperKey,
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

// ── paper fills appear in the trade history, labelled ────────────────
{
  let book = emptyPaperBook();
  book = openPaper(book, { mint: 'M1', symbol: 'ONE', tokens: 1000, costSol: 0.1, decimalsKnown: true }, 1_000).book;
  book = sellPaper(book, 'M1', 50, 0.0002, 2_000).book; // partial: 500 tokens, stays open
  book = openPaper(book, { mint: 'M2', symbol: 'TWO', tokens: 10, costSol: 0.05, decimalsKnown: true }, 3_000).book;
  book = sellPaper(book, 'M2', 100, 0.004, 4_000).book; // closed round trip
  const rows = paperHistoryRows(book);
  assert.equal(rows.length, 4, 'two fills on the open position, two rows for the closed round trip');
  assert.ok(rows.every((r) => r.paper === true && r.signature === null && r.feeSol === null), 'every row is labelled paper, unsigned, unfeed');
  assert.deepEqual(rows.map((r) => r.at), [4_000, 3_000, 2_000, 1_000], 'newest first, like the ledger');
  const [closeSell, closeBuy, partial, firstBuy] = rows;
  assert.equal(firstBuy.side, 'buy');
  assert.equal(firstBuy.requested, 0.1, 'a buy asks in SOL');
  assert.equal(firstBuy.solDelta, -0.1, 'signed like the ledger: a buy is money out');
  assert.equal(firstBuy.tokenDelta, 1000);
  assert.equal(partial.side, 'sell');
  assert.equal(partial.requested, 50, 'a sell asks in percent, rebuilt from the tokens held before it');
  assert.ok(partial.solDelta > 0 && partial.tokenDelta === -500);
  assert.equal(closeBuy.mint, 'M2');
  assert.equal(closeBuy.requested, 0.05);
  assert.equal(closeSell.requested, 100);
  assert.ok(closeSell.solDelta > 0);
  assert.equal(closeSell.tokenDelta, -10);
  assert.match(closeSell.note, /^Paper — /);
  assert.ok(!/folded/.test(closeSell.note), 'one buy, one sell: nothing was folded');
  // A position whose decimals are unknown shows no token count — raw units are not a number to print.
  let raw = emptyPaperBook();
  raw = openPaper(raw, { mint: 'M3', symbol: 'RAW', tokens: 123456, costSol: 0.02, decimalsKnown: false }, 5_000).book;
  assert.equal(paperHistoryRows(raw)[0].tokenDelta, null);
  console.log('ok  paper fills become labelled trade-history rows');
}

// ── Chains (2026-09-14) ───────────────────────────────────────────────
//
// The book was keyed on the address alone. The SAME 0x address can be a
// different token on Robinhood Chain and on BNB, so that key merged two
// positions into one and would have sold the wrong token's bag.
{
  let b = emptyPaperBook();
  b = openPaper(b, { mint: '0xabc', chain: 'robinhood', symbol: 'RH', tokens: 100, costSol: 1, decimalsKnown: true }, 1_000).book;
  b = openPaper(b, { mint: '0xabc', chain: 'bnb', symbol: 'BNB', tokens: 200, costSol: 2, decimalsKnown: true }, 2_000).book;
  assert.equal(b.open.length, 2, 'the same address on two chains is two positions');
  assert.equal(b.open.find((p) => p.chain === 'robinhood').tokens, 100);
  assert.equal(b.open.find((p) => p.chain === 'bnb').tokens, 200);

  // Selling one leaves the other untouched.
  const sold = sellPaper(b, '0xabc', 100, 0.02, 3_000, 'robinhood');
  assert.equal(sold.ok, true, sold.message);
  assert.equal(sold.book.open.length, 1);
  assert.equal(sold.book.open[0].chain, 'bnb', 'the BNB bag is still there');
  console.log('ok  the same address on two chains is two paper positions');
}
{
  // A position written before chains existed is Solana, and a Solana buy still
  // adds to it rather than opening a second one beside it.
  const legacy = { version: 1, open: [{ mint: 'M1', symbol: 'OLD', tokens: 10, costSol: 1, decimalsKnown: true, openedAt: 1, lastFillAt: 1, realizedSol: 0, fills: [] }], closed: [] };
  const after = openPaper(legacy, { mint: 'M1', symbol: 'OLD', tokens: 10, costSol: 1, decimalsKnown: true }, 2_000).book;
  assert.equal(after.open.length, 1, 'a chainless position is Solana, not a separate token');
  assert.equal(after.open[0].tokens, 20);
  assert.equal(samePaperKey({ mint: 'M1' }, { mint: 'M1', chain: 'solana' }), true);
  assert.equal(samePaperKey({ mint: 'M1' }, { mint: 'M1', chain: 'bnb' }), false);
  console.log('ok  a position saved before chains existed still reads as Solana');
}

