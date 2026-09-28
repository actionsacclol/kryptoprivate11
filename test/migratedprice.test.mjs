// The engine's cheap price of a MIGRATED coin (user report 2026-09-27).
//
// A launch row's price is the curve's spot and stops moving at graduation;
// the cheap read (a script's bot.price, paper marks, the fee estimate) used
// to prefer that row over everything else, so every migrated coin read as
// its graduation price for as long as the row lived. This drives the real
// engine, offline: a planted tracked token, its curve completing, and a
// newer print arriving the way an AMM swap or the orders poller delivers
// one (rememberPrice).
//
// Built by the suite: test/.engine.test.mjs (engine.ts with the createRequire
// banner, as the live tests build it) and test/.sharedtypes.mjs.

import assert from 'node:assert/strict';
import { SniperEngine } from './.engine.test.mjs';
import { DEFAULT_SETTINGS } from './.sharedtypes.mjs';

const settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  recorderEnabled: false,
  autoStartEngine: false,
  execution: { ...DEFAULT_SETTINGS.execution, liveEnabled: false },
};

const engine = new SniperEngine(() => settings, () => {});

const GRAD = 4.1088e-7; // the graduation price: 115 SOL over 279.9M tokens
const POOL = 3.9e-8; // the pool 20 s later: the coin down 90 %
const MINT = 'GradMint1111111111111111111111111111111pump';
const MINT2 = 'GradMint2222222222222222222222222222222pump';

function plant(mint, complete) {
  engine.tokens.set(mint, {
    row: { mint, symbol: 'T', name: 'T', priceSol: GRAD, priceHistory: [GRAD], flow: {}, detectedAt: Date.now(), phase: 'flagged' },
    createEvent: { creator: '11111111111111111111111111111111', mint },
    trades: [], buyersBySol: new Map(), tokensByUser: new Map(), firstBuyAtByUser: new Map(),
    smartBuyers: new Set(), virtualSolReserves: 0n, virtualTokenReserves: 0n,
    mintChecked: true, evalDeadline: 0, decided: true,
    curveComplete: complete,
    dumpRecorded: false, addr: null, oddsTrades: [], oddsTapeTruncated: false,
    oddsJudged: 0, flagged: true, socials: null,
  });
}

const timeout = setTimeout(() => {
  console.error('migratedprice: timed out');
  process.exit(1);
}, 20_000);

try {
  // On the curve the row is the live spot: a newer remembered print does not override it.
  plant(MINT, false);
  engine.rememberPrice(MINT, POOL);
  assert.equal(await engine.botPrice(MINT), GRAD);
  console.log('ok  on the curve bot.price is the row (the live spot)');

  // The curve completes: the newer print — the pool — is what bot.price says now.
  engine.tokens.get(MINT).curveComplete = true;
  assert.equal(await engine.botPrice(MINT), POOL);
  console.log('ok  once the curve is complete bot.price is the newest print, not the graduation price');

  // Completed with nothing newer known: the graduation price is the last resort, never null.
  plant(MINT2, true);
  assert.equal(await engine.botPrice(MINT2), GRAD);
  console.log('ok  completed with nothing newer, the graduation price stands');

  console.log('migratedprice: all passed');
  clearTimeout(timeout);
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
