// Portfolio + ledger tests.
//
// The property under test throughout: a figure that depends on cost basis is
// NULL when the basis is unknown, and never 0. A PnL of "0" on a position we
// have no purchase record for reads as break-even, which is a specific,
// confident lie. These cases pin that in every direction.

import assert from 'node:assert';
// Both come from ONE bundle — see test/portfolioentry.ts for why.
import { ledger, portfolio } from './.portfolioentry.mjs';
import { toCsv } from './.portfolioshared.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const LAM = 1_000_000_000;
const MINT = 'PortMint111111111111111111111111111111111';
const OTHER = 'OtherMint11111111111111111111111111111111';

/** Build a reconciled fill. solDelta is signed as the chain reports it. */
const fill = (over = {}) => ({
  id: over.id ?? `f${Math.random().toString(36).slice(2)}`,
  mint: over.mint ?? MINT,
  symbol: over.symbol ?? 'PORT',
  side: over.side ?? 'buy',
  at: over.at ?? 1_700_000_000_000,
  signature: over.signature ?? 'sig',
  requested: over.requested ?? 1,
  solDeltaLamports: over.solDeltaLamports ?? null,
  tokenDeltaRaw: over.tokenDeltaRaw ?? null,
  decimals: over.decimals ?? 6,
  feeLamports: over.feeLamports ?? null,
  state: over.state ?? 'reconciled',
  note: over.note ?? null,
  wallet: over.wallet === undefined ? null : over.wallet,
  attempts: over.attempts,
});

const holding = (mint, uiAmount) => ({
  mint, tokenAccount: `ta_${mint}`, amountRaw: String(Math.round(uiAmount * 1e6)),
  uiAmount, decimals: 6, symbol: null,
});

const priceMap = (mint, priceSol, priceUsd) =>
  new Map([[mint, {
    priceSol, priceUsd, marketCapUsd: priceUsd === null ? null : priceUsd * 1_000_000,
    name: 'Port Token', symbol: 'PORT', imageUrl: null, circSupply: 1_000_000,
  }]]);

// ── Ledger basis ──────────────────────────────────────────────────────

test('basis uses the CHAIN delta, not the requested amount', () => {
  ledger._reset();
  // Asked for 1 SOL; the chain says 1.05 left the wallet (fees, tip, rent).
  ledger._load([
    fill({ side: 'buy', requested: 1, solDeltaLamports: -1.05 * LAM, tokenDeltaRaw: '1000000000', decimals: 6 }),
  ]);
  const b = ledger.basisByMint().get(MINT);
  assert.equal(b.spentSol, 1.05, 'cost must be what actually left the wallet');
  assert.equal(b.tokensBought, 1000);
});

test('unreconciled fills are counted but excluded from the money', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ side: 'buy', state: 'unreconciled', solDeltaLamports: null }),
    fill({ side: 'buy', state: 'pending', solDeltaLamports: null }),
  ]);
  const b = ledger.basisByMint().get(MINT);
  assert.equal(b.spentSol, 1, 'the unreadable fills must not be guessed at');
  assert.equal(b.unreconciled, 2);
});

test('sells accumulate proceeds and tokens sold', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', solDeltaLamports: -2 * LAM, tokenDeltaRaw: '2000000000' }),
    fill({ side: 'sell', solDeltaLamports: 3 * LAM, tokenDeltaRaw: '-1000000000' }),
  ]);
  const b = ledger.basisByMint().get(MINT);
  assert.equal(b.spentSol, 2);
  assert.equal(b.receivedSol, 3);
  assert.equal(b.tokensBought, 2000);
  assert.equal(b.tokensSold, 1000);
});

// ── Position PnL ──────────────────────────────────────────────────────

test('a position with a known basis reports real PnL', () => {
  ledger._reset();
  ledger._load([fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' })]);
  const p = portfolio.build({
    holdings: [holding(MINT, 1000)],
    solBalance: 5,
    solUsd: 100,
    prices: priceMap(MINT, 0.002, 0.2),
  }).positions[0];

  assert.equal(p.basisKnown, true);
  assert.equal(p.costSol, 1);
  assert.equal(p.avgEntryPriceSol, 0.001);
  assert.equal(p.valueSol, 2);
  assert.equal(p.unrealizedPnlSol, 1);
  assert.equal(p.unrealizedPnlPct, 100);
});

test('a position with NO basis reports null PnL, not zero', () => {
  ledger._reset();
  ledger._load([]); // tokens arrived from somewhere we never saw
  const p = portfolio.build({
    holdings: [holding(MINT, 1000)],
    solBalance: 5,
    solUsd: 100,
    prices: priceMap(MINT, 0.002, 0.2),
  }).positions[0];

  assert.equal(p.basisKnown, false);
  assert.equal(p.costSol, null);
  assert.equal(p.unrealizedPnlSol, null, 'must be null — 0 would read as break-even');
  assert.equal(p.unrealizedPnlPct, null);
  assert.equal(p.valueUsd, 200, 'value is still known: it needs no basis');
});

test('holding MORE than the ledger recorded invalidates the basis', () => {
  ledger._reset();
  // Bought 1000 through Krypt, but the wallet holds 5000 — the rest came
  // from elsewhere, so an average cost over 1000 would be wrong.
  ledger._load([fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' })]);
  const p = portfolio.build({
    holdings: [holding(MINT, 5000)],
    solBalance: 0,
    solUsd: 100,
    prices: priceMap(MINT, 0.002, 0.2),
  }).positions[0];
  assert.equal(p.basisKnown, false);
  assert.equal(p.unrealizedPnlSol, null);
});

test('an unpriced position has null value and is excluded from the total', () => {
  ledger._reset();
  ledger._load([fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' })]);
  const out = portfolio.build({
    holdings: [holding(MINT, 1000)],
    solBalance: 2,
    solUsd: 100,
    prices: new Map(),
  });
  assert.equal(out.positions[0].valueUsd, null);
  assert.equal(out.positions[0].unrealizedPnlSol, null, 'no price means no unrealized PnL');
  assert.ok(out.warnings.some((w) => /could not be priced/.test(w)));
});

// ── Closed round trips ────────────────────────────────────────────────

test('a mint still held is NOT counted as closed', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ side: 'sell', solDeltaLamports: 0.5 * LAM, tokenDeltaRaw: '-500000000' }),
  ]);
  const out = portfolio.build({
    holdings: [holding(MINT, 500)], // half still held
    solBalance: 0, solUsd: 100, prices: priceMap(MINT, 0.001, 0.1),
  });
  assert.equal(out.closed.length, 0, 'the chain says it is still open, so it is open');
});

test('a fully exited mint becomes a closed round trip with real PnL', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', at: 1000, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ side: 'sell', at: 5000, solDeltaLamports: 2.5 * LAM, tokenDeltaRaw: '-1000000000' }),
  ]);
  const out = portfolio.build({ holdings: [], solBalance: 0, solUsd: 100, prices: new Map() });
  assert.equal(out.closed.length, 1);
  const c = out.closed[0];
  assert.equal(c.costSol, 1);
  assert.equal(c.proceedsSol, 2.5);
  assert.equal(c.pnlSol, 1.5);
  assert.equal(c.pnlPct, 150);
  assert.equal(c.holdMs, 4000);
  assert.equal(out.realizedPnlSol, 1.5);
});

test('win rate, profit factor and extremes come from closed trips only', () => {
  ledger._reset();
  ledger._load([
    // winner: +1
    fill({ mint: MINT, side: 'buy', at: 1, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000' }),
    fill({ mint: MINT, side: 'sell', at: 2, solDeltaLamports: 2 * LAM, tokenDeltaRaw: '-1000000' }),
    // loser: -0.5
    fill({ mint: OTHER, symbol: 'OTHR', side: 'buy', at: 3, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000' }),
    fill({ mint: OTHER, symbol: 'OTHR', side: 'sell', at: 4, solDeltaLamports: 0.5 * LAM, tokenDeltaRaw: '-1000000' }),
  ]);
  const out = portfolio.build({ holdings: [], solBalance: 0, solUsd: 100, prices: new Map() });
  assert.equal(out.wins, 1);
  assert.equal(out.losses, 1);
  assert.equal(out.winRatePct, 50);
  assert.equal(out.avgWinnerSol, 1);
  assert.equal(out.avgLoserSol, -0.5);
  assert.equal(out.profitFactor, 2);
  assert.equal(out.bestTradeSol, 1);
  assert.equal(out.worstTradeSol, -0.5);
  assert.equal(out.realizedPnlSol, 0.5);
});

test('no closed trips means null stats, not zeroes', () => {
  ledger._reset();
  ledger._load([]);
  const out = portfolio.build({ holdings: [], solBalance: 1, solUsd: 100, prices: new Map() });
  assert.equal(out.winRatePct, null);
  assert.equal(out.profitFactor, null);
  assert.equal(out.avgWinnerSol, null);
  assert.equal(out.realizedPnlSol, null);
  assert.equal(out.bestTradeSol, null);
});

test('the equity curve is cumulative and time-ordered', () => {
  ledger._reset();
  ledger._load([
    fill({ mint: MINT, side: 'buy', at: 10, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000' }),
    fill({ mint: MINT, side: 'sell', at: 20, solDeltaLamports: 2 * LAM, tokenDeltaRaw: '-1000000' }),
    fill({ mint: OTHER, side: 'buy', at: 30, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000' }),
    fill({ mint: OTHER, side: 'sell', at: 40, solDeltaLamports: 0.5 * LAM, tokenDeltaRaw: '-1000000' }),
  ]);
  const out = portfolio.build({ holdings: [], solBalance: 0, solUsd: 100, prices: new Map() });
  assert.deepEqual(out.equity.map((p) => p.v), [1, 0.5]);
  assert.ok(out.equity[0].t < out.equity[1].t);
});

// ── Warnings ──────────────────────────────────────────────────────────

test('warnings name every gap in the numbers', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', state: 'unreconciled' }),
    fill({ side: 'buy', state: 'pending' }),
  ]);
  const out = portfolio.build({
    holdings: [holding(MINT, 100)],
    solBalance: 1, solUsd: 100, prices: priceMap(MINT, 0.001, 0.1),
  });
  assert.ok(out.warnings.some((w) => /could not be read/.test(w)), 'unreconciled');
  assert.ok(out.warnings.some((w) => /still reconciling/.test(w)), 'pending');
  assert.ok(out.warnings.some((w) => /no cost basis/.test(w)), 'basis');
});

// ── Totals ────────────────────────────────────────────────────────────

test('total value adds the SOL balance to priced positions', () => {
  ledger._reset();
  ledger._load([fill({ side: 'buy', solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' })]);
  const out = portfolio.build({
    holdings: [holding(MINT, 1000)],
    solBalance: 3, solUsd: 100, prices: priceMap(MINT, 0.002, 0.2),
  });
  assert.equal(out.positionsValueUsd, 200);
  assert.equal(out.totalValueUsd, 500); // 200 + 3 SOL at $100
});

test('fees paid sum only where the chain reported one', () => {
  ledger._reset();
  ledger._load([
    fill({ side: 'buy', solDeltaLamports: -1 * LAM, feeLamports: 5000 }),
    fill({ side: 'sell', solDeltaLamports: 1 * LAM, feeLamports: 5000 }),
  ]);
  const out = portfolio.build({ holdings: [], solBalance: 0, solUsd: 100, prices: new Map() });
  assert.equal(out.feesPaidSol, 0.00001);
});

// ── Export ────────────────────────────────────────────────────────────

test('CSV escapes commas and quotes rather than corrupting a row', () => {
  const csv = toCsv([
    {
      at: 1_700_000_000_000, mint: MINT, symbol: 'A,B', side: 'buy', requested: 1,
      solDelta: -1.05, tokenDelta: 1000, feeSol: 0.000005, signature: 'sig',
      state: 'reconciled', note: 'said "hello", then left',
    },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"A,B"'), 'a comma in a field must be quoted');
  assert.ok(lines[1].includes('""hello""'), 'a quote must be doubled');
});

test('CSV renders nulls as empty, never as the string "null"', () => {
  const csv = toCsv([
    {
      at: 1_700_000_000_000, mint: MINT, symbol: 'X', side: 'sell', requested: 50,
      solDelta: null, tokenDelta: null, feeSol: null, signature: null,
      state: 'unreconciled', note: null,
    },
  ]);
  assert.ok(!csv.includes('null'), 'an unreadable value must be blank, not the word null');
});

// ── Multi-wallet: basis and reconciliation are PER WALLET ─────────────

const W1 = 'Wallet1111111111111111111111111111111111111';
const W2 = 'Wallet2222222222222222222222222222222222222';

test('basisByMint(wallet) ignores another wallet\'s fills', () => {
  ledger._load([
    fill({ wallet: W1, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ wallet: W2, solDeltaLamports: -5 * LAM, tokenDeltaRaw: '9000000000' }),
  ]);
  const b1 = ledger.basisByMint(W1).get(MINT);
  const b2 = ledger.basisByMint(W2).get(MINT);
  assert.equal(b1.spentSol, 1);
  assert.equal(b1.tokensBought, 1000);
  assert.equal(b2.spentSol, 5);
  assert.equal(ledger.basisByMint().get(MINT).spentSol, 6, 'no wallet = single-wallet = everything');
});

test('legacy fills with no wallet belong to the active wallet (backward compat)', () => {
  ledger._load([
    fill({ wallet: null, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ wallet: W2, solDeltaLamports: -5 * LAM, tokenDeltaRaw: '9000000000' }),
  ]);
  assert.equal(ledger.basisByMint(W1).get(MINT).spentSol, 1);
  assert.equal(ledger.basisByMint(W2).get(MINT).spentSol, 6);
});

test('the portfolio prices the ACTIVE wallet\'s holdings with ITS basis only', () => {
  ledger._load([
    fill({ wallet: W1, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ wallet: W2, solDeltaLamports: -9 * LAM, tokenDeltaRaw: '1000000000' }),
  ]);
  const out = portfolio.build({ holdings: [holding(MINT, 1000)], solBalance: 1, solUsd: null, prices: priceMap(MINT, 0.002, null), wallet: W1 });
  const pos = out.positions.find((p) => p.mint === MINT);
  assert.equal(pos.costSol, 1, 'W2 spent 9 SOL on the same mint; W1 holds a 1 SOL bag');
});

test('realizedPnlForSell: proceeds vs the SAME wallet\'s average cost; null without a basis', () => {
  const sell = fill({ wallet: W1, side: 'sell', solDeltaLamports: 2 * LAM, tokenDeltaRaw: '-500000000' });
  ledger._load([
    fill({ wallet: W1, solDeltaLamports: -1 * LAM, tokenDeltaRaw: '1000000000' }),
    fill({ wallet: W2, solDeltaLamports: -100 * LAM, tokenDeltaRaw: '1000000000' }),
    sell,
  ]);
  // W1 avg cost 0.001 SOL/token; sold 500 for 2 SOL → +1.5 SOL. W2's 100 SOL must not leak in.
  assert.ok(Math.abs(ledger.realizedPnlForSell(sell) - 1.5) < 1e-9);
  const orphan = fill({ wallet: W2, mint: OTHER, side: 'sell', solDeltaLamports: 2 * LAM, tokenDeltaRaw: '-500000000' });
  ledger._load([orphan]);
  assert.equal(ledger.realizedPnlForSell(orphan), null, 'no buys recorded → unknown, never 0');
});

// ── Re-entry: a new position, priced at the NEW entry ─────────────────
//
// The bug these pin (user report, 2026-09-13): cost basis was the average of
// every buy the install had ever seen of a mint. A trader who bought at a
// 29k market cap, sold the lot, and bought back at 93k was shown the 29k
// entry — and, worse, every percentage order (`positionEntryPriceSol`)
// anchored its take-profit and stop there, so a Runner ladder armed on the
// re-entry put its targets below the price it was armed at.

/** buy 1000 tokens for `sol`; then, optionally, sell them all for `out`. */
const buyAt = (sol, tokens, at) =>
  fill({ wallet: W1, side: 'buy', at, solDeltaLamports: -sol * LAM, tokenDeltaRaw: String(tokens * 1e6) });
const sellAt = (sol, tokens, at) =>
  fill({ wallet: W1, side: 'sell', at, solDeltaLamports: sol * LAM, tokenDeltaRaw: String(-tokens * 1e6) });

test('a re-entry is priced at the re-entry, not blended with the round before it', () => {
  ledger._load([
    buyAt(1, 1000, 1_000),   // entry 0.001 SOL/token
    sellAt(3, 1000, 2_000),  // out, flat
    buyAt(4, 1000, 3_000),   // re-entry at 0.004 SOL/token
  ]);
  const b = ledger.basisByMint(W1).get(MINT);
  assert.equal(b.spentSol, 4, 'only the open position');
  assert.equal(b.tokensBought, 1000);
  assert.equal(b.receivedSol, 0, 'the old round trip is not this position’s realised');
  assert.equal(b.buys, 1);
  assert.equal(b.roundTrips, 1);
  assert.equal(b.firstAt, 3_000, 'this position opened at the re-entry');
  assert.equal(b.spentSol / b.tokensBought, 0.004, 'the anchor every % order is built on');
});

test('lifetime still carries every round trip, for the closed history', () => {
  ledger._load([buyAt(1, 1000, 1_000), sellAt(3, 1000, 2_000), buyAt(4, 1000, 3_000)]);
  const b = ledger.basisByMint(W1).get(MINT);
  assert.equal(b.lifetimeSpentSol, 5);
  assert.equal(b.lifetimeReceivedSol, 3);
  assert.equal(b.lifetimeBuys, 2);
  assert.equal(b.lifetimeSells, 1);
  assert.equal(b.firstEverAt, 1_000, 'the first time we ever touched the mint');
});

test('a PARTIAL sell does not start a new position', () => {
  ledger._load([buyAt(1, 1000, 1_000), sellAt(1, 400, 2_000), buyAt(4, 1000, 3_000)]);
  const b = ledger.basisByMint(W1).get(MINT);
  assert.equal(b.roundTrips, 0, 'the wallet never went flat');
  assert.equal(b.spentSol, 5, 'both buys are in the same position');
  assert.equal(b.receivedSol, 1);
});

test('dust left behind still closes the position', () => {
  // Sold all but 0.1% of the bag — a rounding remainder, not a holding.
  ledger._load([buyAt(1, 1000, 1_000), sellAt(3, 999, 2_000), buyAt(4, 1000, 3_000)]);
  const b = ledger.basisByMint(W1).get(MINT);
  assert.equal(b.roundTrips, 1);
  assert.equal(b.spentSol, 4, 'the re-entry alone');
});

test('the closed round trip covers BOTH rounds once the mint is gone', () => {
  ledger._load([
    buyAt(1, 1000, 1_000), sellAt(3, 1000, 2_000),
    buyAt(4, 1000, 3_000), sellAt(6, 1000, 4_000),
  ]);
  const out = portfolio.build({ holdings: [], solBalance: 0, solUsd: null, prices: new Map(), wallet: W1 });
  assert.equal(out.closed.length, 1);
  const c = out.closed[0];
  assert.equal(c.costSol, 5, 'both entries');
  assert.equal(c.proceedsSol, 9, 'both exits');
  assert.equal(c.pnlSol, 4);
  assert.equal(c.buys, 2);
  assert.equal(c.sells, 2);
  assert.equal(c.openedAt, 1_000, 'the first time the mint was ever bought');
});

test('the open position after a re-entry reports the re-entry cost and ONLY its own realised', () => {
  ledger._load([
    buyAt(1, 1000, 1_000), sellAt(3, 1000, 2_000),   // +2 SOL, closed
    buyAt(4, 1000, 3_000), sellAt(1, 250, 4_000),    // still holding 750
  ]);
  const out = portfolio.build({
    holdings: [holding(MINT, 750)], solBalance: 0, solUsd: 100,
    prices: priceMap(MINT, 0.005, 0.5), wallet: W1,
  });
  const pos = out.positions.find((p) => p.mint === MINT);
  assert.equal(pos.avgEntryPriceSol, 0.004, 'the re-entry price, not 0.0025');
  assert.equal(pos.costSol, 3, '750 tokens at the re-entry price');
  // Realised on THIS position: 1 SOL out for 250 tokens that cost 0.004 each.
  assert.ok(Math.abs(pos.realizedPnlSol - 0) < 1e-9, 'sold 250 at cost → flat, not +2 from the round before');
});

test('realizedPnlForSell prices the sell that emptied the bag', () => {
  // The sell closes the position, so the basis AFTER the walk is empty —
  // it has to be read as it stood just before the fill, or the most
  // important sell of all reports "unknown".
  const out = sellAt(3, 1000, 2_000);
  ledger._load([buyAt(1, 1000, 1_000), out]);
  assert.ok(Math.abs(ledger.realizedPnlForSell(out) - 2) < 1e-9);
});

// ── Reconciliation is bounded and never overlaps ──────────────────────

/** Fake RPC: getTransaction returns null (not on chain yet) and counts calls. */
function fakeChain() {
  const calls = { getTransaction: 0 };
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (method in calls) calls[method] += 1;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) };
  };
  return calls;
}
const realFetch = globalThis.fetch;
ledger._setReconcileDelayMs(1);

test('reconcilePending retries ONLY pending fills — terminal ones are never re-read', async () => {
  const calls = fakeChain();
  ledger._load([
    fill({ state: 'unreconciled', note: 'Transaction failed on chain', wallet: W1 }),
    fill({ state: 'unreconciled', note: 'Wallet not found in the transaction', wallet: W1 }),
    fill({ state: 'reconciled', solDeltaLamports: -1, wallet: W1 }),
    fill({ state: 'pending', wallet: W1, attempts: 0 }),
  ]);
  await ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(calls.getTransaction, 4, 'one round (4 reads) for the single pending fill');
});

test('a pending fill stays pending across rounds, then becomes terminal', async () => {
  fakeChain();
  const f = fill({ state: 'pending', wallet: W1, attempts: 0 });
  ledger._load([f]);
  await ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(f.state, 'pending', 'not on chain YET — a late-landing tx must keep being watched');
  assert.equal(f.attempts, 1);
  for (let i = 0; i < 10; i++) await ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(f.state, 'unreconciled', 'gave up after the bounded number of rounds');
  assert.match(f.note, /did not land/);
  const calls = fakeChain();
  await ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(calls.getTransaction, 0, 'terminal → never polled again');
});

// ── A sale settles exactly once ───────────────────────────────────────
//
// `recordFill` starts a reconcile round itself, and `reconcilePending`
// sweeps anything still `pending` — which that first round's fill is for the
// seconds it spends sleeping and fetching. Both used to reach `settled()`,
// so every listener ran twice for one sale: the realised PnL was logged
// twice, and the losing-streak counter advanced twice. A user saw −0.0073
// SOL counted twice and the app disarm on `loss_limit` (2026-09-13).

test('one fill notifies onSettled exactly once, however many reconcile paths race it', async () => {
  fakeChain();
  const seen = [];
  const off = ledger.onSettled((f) => seen.push(f.id));
  const f = fill({ state: 'pending', wallet: W1, attempts: 0, side: 'sell' });
  ledger._load([f]);
  // Two sweeps back to back is the shape of the race: the second arrives
  // while the first is still working on the same fill.
  await Promise.all([
    ledger.reconcilePending('http://fake.invalid', W1),
    ledger.reconcilePending('http://fake.invalid', W1),
  ]);
  for (let i = 0; i < 12; i++) await ledger.reconcilePending('http://fake.invalid', W1);
  off();
  assert.equal(f.state, 'unreconciled', 'it reached a terminal state');
  assert.equal(seen.filter((id) => id === f.id).length, 1, 'and announced it once');
});

test('at most ONE reconcile pass runs at a time', async () => {
  const calls = fakeChain();
  ledger._load([fill({ state: 'pending', wallet: W1, attempts: 0 })]);
  const a = ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(ledger.reconcileBusy(), true);
  const b = await ledger.reconcilePending('http://fake.invalid', W1);
  assert.equal(b, 0, 'the overlapping pass returns immediately');
  await a;
  assert.equal(calls.getTransaction, 4, 'one pass worth of reads, not two');
  assert.equal(ledger.reconcileBusy(), false);
});

test('each fill reconciles against the wallet that MADE it, not the active one', async () => {
  const owners = [];
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (method !== 'getTransaction') return { ok: true, json: async () => ({ result: null }) };
    // A tx whose only balance-bearing account is W2.
    return { ok: true, json: async () => ({ result: {
      transaction: { message: { accountKeys: [W2] } },
      meta: { err: null, fee: 5000, preBalances: [10 * LAM], postBalances: [9 * LAM], preTokenBalances: [], postTokenBalances: [] },
    } }) };
  };
  const f = fill({ state: 'pending', wallet: W2, attempts: 0 });
  ledger._load([f]);
  await ledger.reconcilePending('http://fake.invalid', W1); // W1 is ACTIVE
  assert.equal(f.state, 'reconciled', 'reconciled against W2 (its own wallet), so the wallet IS found');
  assert.equal(f.solDeltaLamports, -1 * LAM);
  void owners;
});

globalThis.fetch = realFetch;

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
  console.log(`portfolio: ${passed}/${cases.length} tests passed`);
}

await run();
