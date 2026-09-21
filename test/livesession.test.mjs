// The live session's ledger (shared/liveSession.ts).
//
// The Observatory showed −0.068 SOL beside "0 buys, 0 sells, realized
// +0.000, win rate —" after a day of manual trading, because the counters
// counted the scanner's own trades, which no longer exist. These pin the
// replacement: the portfolio's fills, trips and positions, windowed to the
// session.

import assert from 'node:assert';
import fs from 'node:fs';
import { liveSessionLedger } from './.livesession.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const T0 = 1_700_000_000_000;
const fill = (at, side, state = 'reconciled', wallet = 'W') => ({ at, side, state, wallet });
const trip = (closedAt, pnlSol) => ({ mint: 'm', symbol: 's', openedAt: closedAt - 60_000, closedAt, costSol: 1, proceedsSol: 1 + pnlSol, pnlSol, pnlPct: pnlSol * 100, holdMs: 60_000, tokensBought: 1, tokensSold: 1, entryPriceSol: 1, exitPriceSol: 1, buys: 1, sells: 1, tripIndex: 1, tripsOnMint: 1 });
const pos = (firstBuyAt, unrealizedPnlSol) => ({ mint: 'p', symbol: 'p', name: '', imageUrl: null, amount: 1, decimals: 6, priceUsd: null, priceSol: null, valueUsd: null, valueSol: null, marketCapUsd: null, basisKnown: true, costSol: 1, avgEntryPriceSol: 1, entryMcapUsd: null, unrealizedPnlSol, unrealizedPnlPct: null, realizedPnlSol: null, firstBuyAt, lastFillAt: firstBuyAt, unreconciledFills: 0 });
const summary = (closed, positions) => ({ closed, positions, generatedAt: T0 + 999, warnings: [] });

{
  // Fills are counted from the moment the session began, whatever state
  // they are in — a buy still reconciling is still a buy the user made.
  const fills = [fill(T0 - 1, 'buy'), fill(T0, 'buy'), fill(T0 + 10, 'sell', 'pending'), fill(T0 + 20, 'buy', 'unreconciled'), fill(T0 + 30, 'sell')];
  const ls = liveSessionLedger(T0, fills, null, 'W');
  assert.equal(ls.buys, 2, 'the buy before the session is not counted');
  assert.equal(ls.sells, 2);
  assert.equal(ls.pending, 1);
  assert.equal(ls.unreconciled, 1);
  assert.equal(ls.portfolioAt, null, 'no portfolio yet');
  assert.equal(ls.realizedSol, null, 'no trips is not a profit of zero');
  assert.equal(ls.unrealizedSol, null);
  assert.equal(ls.winRatePct, null);
  assert.equal(ls.maxDrawdownSol, null);
  ok('fills since the session are counted by side and state; nothing else is invented');
}

{
  // Another wallet's fills are not this session's; a fill with no wallet
  // (pre multi-wallet) is the active wallet's.
  const fills = [fill(T0, 'buy', 'reconciled', 'OTHER'), fill(T0 + 1, 'buy', 'reconciled', null), fill(T0 + 2, 'sell', 'reconciled', 'W')];
  const ls = liveSessionLedger(T0, fills, null, 'W');
  assert.equal(ls.buys, 1);
  assert.equal(ls.sells, 1);
  ok('only the active wallet is counted');
}

{
  // Trips closed since the session began: realized, wins, losses, win rate,
  // and the drawdown of the cumulative curve in closing order.
  const closed = [trip(T0 + 300, -0.2), trip(T0 + 100, 0.5), trip(T0 - 5, 9), trip(T0 + 200, -0.4), trip(T0 + 400, 0.1)];
  const ls = liveSessionLedger(T0, [], summary(closed, []), 'W');
  assert.equal(ls.portfolioAt, T0 + 999);
  assert.ok(Math.abs(ls.realizedSol - 0.0) < 1e-9, `0.5 − 0.4 − 0.2 + 0.1 = 0 (got ${ls.realizedSol})`);
  assert.equal(ls.wins, 2);
  assert.equal(ls.losses, 2);
  assert.equal(ls.winRatePct, 50);
  // Curve in closing order: +0.5, +0.1, −0.1, 0.0 → peak 0.5, trough −0.1.
  assert.ok(Math.abs(ls.maxDrawdownSol - 0.6) < 1e-9, `drawdown 0.6 (got ${ls.maxDrawdownSol})`);
  ok('closed trips since the session make realized, win rate and drawdown; the 9 SOL trip from before it does not');
}

{
  // Open positions opened since the session; unrealized only from the priced ones.
  const positions = [pos(T0 - 1, 5), pos(T0 + 1, 0.25), pos(T0 + 2, null), pos(T0 + 3, -0.05)];
  const ls = liveSessionLedger(T0, [], summary([], positions), 'W');
  assert.equal(ls.open, 3, 'the bag from before the session is not this session\'s');
  assert.ok(Math.abs(ls.unrealizedSol - 0.2) < 1e-9, `0.25 − 0.05 (got ${ls.unrealizedSol})`);
  const unpriced = liveSessionLedger(T0, [], summary([], [pos(T0 + 1, null)]), 'W');
  assert.equal(unpriced.open, 1);
  assert.equal(unpriced.unrealizedSol, null, 'one open position nobody can price is unknown, not zero');
  ok('open positions since the session; unpriced ones stay unknown');
}

{
  // Realized of exactly zero across trips is a number, not "no trips".
  const ls = liveSessionLedger(T0, [], summary([trip(T0 + 1, 0.3), trip(T0 + 2, -0.3)], []), 'W');
  assert.equal(ls.realizedSol, 0);
  assert.equal(ls.wins, 1);
  assert.equal(ls.losses, 1);
  ok('a flat session reads +0.000 with its trips counted, not as no trips');
}

{
  // The engine wires it, and the panel reads it while live.
  const fs = await import('node:fs');
  const engine = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(engine.includes('liveSession:') && engine.includes('liveSessionLedger('), 'the status carries the session ledger');
  const dash = fs.readFileSync(new URL('../src/pages/Dashboard.tsx', import.meta.url), 'utf8');
  assert.ok(dash.includes('status.liveSession'), 'the Observatory ledger reads it');
  assert.ok(!/status\.liveBuys/.test(dash) && !/status\.liveSells/.test(dash), 'and no longer shows the scanner-only counters');
  ok('wired: engine status → Observatory ledger');
}

{
  // Every surface that shows the session reads the same ledger. The Wallet
  // panel used to read liveBuys / liveSells (the scanner's own trades, gone
  // since 2026-08-16) and the Session PnL panel was fed the PAPER realized
  // series while live: "0 / 0" and "0.0000" under real trades in profit
  // (user report 2026-09-20). And the kept wallet balance moves on the fill
  // itself, not only on the public-endpoint poll that fails silently.
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const registry = src('../src/panels/registry.tsx');
  assert.ok(/status\.liveSession/.test(registry), 'the Wallet panel reads the session ledger');
  assert.ok(!/status\.liveBuys|status\.liveSells/.test(registry), 'and not the retired counters');
  const provider = src('../src/state/AppStateProvider.tsx');
  assert.ok(/const live = ev\.status\.liveActive;[\s\S]{0,300}liveRealizedPnlSol/.test(provider), 'the equity series follows the wallet change while live');
  const engine = src('../electron/engine/engine.ts');
  assert.ok(/f\.solDeltaLamports === null\) return;[\s\S]{0,600}walletBalanceLamports \+ f\.solDeltaLamports[\s\S]{0,200}pushStatus\(\)/.test(engine), 'a reconciled fill moves the kept wallet balance and pushes status');
  assert.ok(/this\.lastPortfolio \|\| this\.manualLiveActive\(\)\) this\.schedulePortfolioRebuild/.test(engine), 'a live fill starts a portfolio build even before any page asked');
  ok('wired: Wallet panel, Session PnL panel and the balance follow real fills');
}

console.log(`\nlivesession: ${passed}/${passed} passed`);
