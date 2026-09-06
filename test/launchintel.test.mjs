// Launch-intel cohort tests.
//
// These numbers are an accusation. "38% of supply was bundled and they still
// hold it" is the difference between a user buying and not buying, so every
// definition in `shared/launchintel.ts` is pinned here — including the ones
// that look obvious, because the failure mode is a plausible wrong number
// rather than a crash.
//
// The three that would be silent in production:
//   • a missing balance read as zero → "they dumped everything" from an RPC
//     hiccup, which is the honest-null rule stated in money terms;
//   • the creator counted inside the bundle → every dev buy inflates it;
//   • trades arriving newest-first (which is how the provider serves them)
//     making the LAST trade look like the launch slot.

import assert from 'node:assert';
import {
  analyseLaunch,
  applyBalances,
  creatorVerdict,
  summariseCreator,
  SNIPER_WINDOW_SLOTS,
} from './.launchintel.mjs';
import { normaliseTrade, parseSlot } from './.pumpswap.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const SUPPLY = 1_000_000_000; // 1B, the pump.fun standard
const DEV = 'DEVwa11et';

/** A trade, terse. slot offsets are relative to the launch slot. */
const t = (slotOffset, user, base, isBuy = true, ts = 0) => ({
  slot: 1000 + slotOffset,
  ts: 1_700_000_000_000 + ts,
  user,
  isBuy,
  base,
  sol: base / 1_000_000,
  program: 'pump',
  tx: `tx${user}${slotOffset}`,
});

const base = { creator: DEV, supply: SUPPLY, complete: true };

// ── Cohort assignment ─────────────────────────────────────────────────

test('same-slot buyers are the bundle; the creator is never one of them', () => {
  const a = analyseLaunch(
    [t(0, DEV, 30_000_000), t(0, 'b1', 20_000_000), t(0, 'b2', 10_000_000), t(5, 's1', 40_000_000)],
    base,
  );
  assert.equal(a.bundle.wallets, 2, 'the two non-creator launch-block buyers');
  assert.equal(a.dev.wallets, 1);
  assert.equal(a.snipers.wallets, 1);
  assert.ok(Math.abs(a.bundle.boughtPct - 3) < 1e-9, `bundle 3% of supply, got ${a.bundle.boughtPct}`);
  assert.ok(Math.abs(a.dev.boughtPct - 3) < 1e-9);
});

test('trades in provider order (newest first) give the same answer', () => {
  const trades = [t(0, DEV, 30_000_000), t(0, 'b1', 20_000_000), t(9, 's1', 40_000_000)];
  const forward = analyseLaunch(trades, base);
  const reversed = analyseLaunch([...trades].reverse(), base);
  assert.equal(reversed.launchSlot, forward.launchSlot);
  assert.equal(reversed.bundle.wallets, forward.bundle.wallets);
  assert.equal(reversed.snipers.wallets, forward.snipers.wallets);
});

test('the sniper window is exactly SNIPER_WINDOW_SLOTS wide, inclusive', () => {
  const a = analyseLaunch(
    [t(0, 'b1', 1_000_000), t(SNIPER_WINDOW_SLOTS, 'edge', 1_000_000), t(SNIPER_WINDOW_SLOTS + 1, 'late', 1_000_000)],
    base,
  );
  assert.equal(a.snipers.wallets, 1, 'the boundary slot counts as a snipe');
  const late = a.wallets.find((w) => w.address === 'late');
  assert.equal(late.cohort, 'early', 'one slot past the window is no longer a snipe');
});

test('a wallet keeps the cohort of its FIRST buy when it buys again later', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(4, 'b1', 30_000_000)], base);
  assert.equal(a.bundle.wallets, 1);
  assert.equal(a.snipers.wallets, 0, 'the follow-up buy must not create a second identity');
  assert.ok(Math.abs(a.bundle.boughtPct - 4) < 1e-9, 'both buys belong to the bundle');
});

test('a wallet that only sells is not credited with a purchase', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(1, 'ghost', 5_000_000, false)], base);
  assert.equal(a.wallets.length, 1);
  assert.equal(a.wallets[0].address, 'b1');
});

test('selling inside the window is recorded on the wallet', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(3, 'b1', 4_000_000, false)], base);
  assert.equal(a.wallets[0].soldInWindow, true);
});

test('unknown supply yields null percentages, never zero', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], { ...base, supply: null });
  assert.equal(a.bundle.boughtPct, null);
  assert.equal(a.wallets[0].boughtPct, null);
  assert.ok(a.bundle.bought > 0, 'the raw token amount is still known');
});

test('no trades produces an empty analysis rather than a throw', () => {
  const a = analyseLaunch([], base);
  assert.equal(a.launchSlot, null);
  assert.equal(a.bundle.boughtPct, null);
  assert.equal(a.wallets.length, 0);
});

// ── Top-3 buyers (volatility input) ───────────────────────────────────

test('top3BuyersPct sums the three largest NON-creator buys', () => {
  const a = analyseLaunch(
    [
      t(0, DEV, 500_000_000), // the creator is excluded however large
      t(0, 'b1', 100_000_000), // 10%
      t(1, 'b2', 50_000_000), // 5%
      t(2, 'b3', 30_000_000), // 3%
      t(3, 'b4', 20_000_000), // 2% — fourth, not counted
    ],
    base,
  );
  assert.ok(Math.abs(a.top3BuyersPct - 18) < 1e-9, `got ${a.top3BuyersPct}`);
});

test('top3BuyersPct works with fewer than three buyers and is null with none but the creator', () => {
  const two = analyseLaunch([t(0, 'b1', 100_000_000), t(1, 'b2', 50_000_000)], base);
  assert.ok(Math.abs(two.top3BuyersPct - 15) < 1e-9);
  const devOnly = analyseLaunch([t(0, DEV, 100_000_000)], base);
  assert.equal(devOnly.top3BuyersPct, null);
});

test('top3BuyersPct is null without supply, never zero', () => {
  const a = analyseLaunch([t(0, 'b1', 100_000_000), t(1, 'b2', 50_000_000)], { ...base, supply: null });
  assert.equal(a.top3BuyersPct, null);
  assert.equal(analyseLaunch([], base).top3BuyersPct, null);
});

test('top3BuyersPct survives applyBalances unchanged', () => {
  const a = analyseLaunch([t(0, 'b1', 100_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 0]]), SUPPLY);
  assert.equal(priced.top3BuyersPct, a.top3BuyersPct, 'it is a BOUGHT share, not a held one');
});

// ── Balances ──────────────────────────────────────────────────────────

test('an unpriced cohort reports null held, NOT zero', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(0, 'b2', 10_000_000)], base);
  assert.equal(a.bundle.heldPct, null, 'before pricing');
  const priced = applyBalances(a, new Map(), SUPPLY);
  assert.equal(priced.bundle.heldPct, null, 'an empty balance map is an unknown, not a dump');
  assert.equal(priced.bundle.stillHolding, null);
});

test('a partially priced cohort measures retention only over what it knows', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(0, 'b2', 30_000_000)], base);
  // Only b1 came back: it kept half of its 10M. b2 is unknown and must not be
  // read as a dump, so retention is 50% of b1's buy — not 5% of both.
  const priced = applyBalances(a, new Map([['b1', 5_000_000]]), SUPPLY);
  assert.ok(Math.abs(priced.bundle.retainedPct - 50) < 1e-9, `got ${priced.bundle.retainedPct}`);
  assert.equal(priced.bundle.stillHolding, 1);
  assert.ok(Math.abs(priced.bundle.heldPct - 0.5) < 1e-9);
  assert.equal(priced.wallets.find((w) => w.address === 'b2').heldNow, null);
});

test('an explicit zero balance IS a dump', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 0]]), SUPPLY);
  assert.equal(priced.bundle.retainedPct, 0);
  assert.equal(priced.bundle.stillHolding, 0);
  assert.equal(priced.bundle.heldPct, 0);
});

test('retention cannot exceed 100% when a wallet bought more after the window', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 90_000_000]]), SUPPLY);
  assert.equal(priced.bundle.retainedPct, 100);
  assert.ok(priced.bundle.heldPct > 8, 'the held share is still reported in full');
});

test('pricing one cohort leaves the others untouched', () => {
  const a = analyseLaunch([t(0, 'b1', 10_000_000), t(2, 's1', 10_000_000)], base);
  const priced = applyBalances(a, new Map([['b1', 10_000_000]]), SUPPLY);
  assert.ok(priced.bundle.heldPct !== null);
  assert.equal(priced.snipers.heldPct, null);
});

// ── Provider normalisation ────────────────────────────────────────────

test('the slot is the first 12 digits of slotIndexId', () => {
  // Verified against getSlot on a live trade, 2026-08-24: delta 0.
  assert.equal(parseSlot('0004415020890001520000'), 441502089);
  assert.equal(parseSlot('short'), null);
  assert.equal(parseSlot(undefined), null);
});

test('a malformed trade is dropped, not coerced', () => {
  assert.equal(normaliseTrade({ slotIndexId: '0004415020890001520000', type: 'buy' }), null, 'no timestamp');
  assert.equal(
    normaliseTrade({ slotIndexId: 'x', timestamp: '2026-08-24T23:21:45.000Z', type: 'buy', userAddress: 'u', baseAmount: '1' }),
    null,
    'no slot',
  );
  assert.equal(
    normaliseTrade({
      slotIndexId: '0004415020890001520000',
      timestamp: '2026-08-24T23:21:45.000Z',
      type: 'transfer',
      userAddress: 'u',
      baseAmount: '1',
    }),
    null,
    'not a swap',
  );
});

test('a well-formed trade normalises with the fields the analysis needs', () => {
  const n = normaliseTrade({
    slotIndexId: '0004415020890001520000',
    tx: 'sig',
    timestamp: '2026-08-24T23:21:45.000Z',
    userAddress: 'wallet',
    type: 'sell',
    program: 'pump_amm',
    amountSol: '-0.068',
    baseAmount: '320649.50408',
  });
  assert.equal(n.slot, 441502089);
  assert.equal(n.isBuy, false);
  assert.equal(n.user, 'wallet');
  assert.ok(Math.abs(n.base - 320649.50408) < 1e-6);
  assert.equal(n.sol, 0.068, 'SOL is a magnitude — the direction is in isBuy');
  assert.equal(n.ts, Date.parse('2026-08-24T23:21:45.000Z'));
});

// ── Creator track record ──────────────────────────────────────────────

const launch = (daysAgo, graduated = false, athUsd = null) => ({
  mint: `m${daysAgo}${graduated}${athUsd}`,
  symbol: 'X',
  name: 'X',
  createdAt: 1_700_000_000_000 - daysAgo * 86_400_000,
  graduated,
  athUsd,
  marketCapUsd: null,
});

test('the busiest-day count finds a launch factory', () => {
  const h = summariseCreator('c', [launch(0), launch(0.1), launch(0.2), launch(0.3), launch(30)], false);
  assert.equal(h.launches, 5);
  assert.equal(h.launchesInBusiestDay, 4, 'the four clustered launches, not the old one');
});

test('graduation rate and median ATH come from the launches that report one', () => {
  const h = summariseCreator('c', [launch(1, true, 100), launch(2, false, 50), launch(3, false, null)], false);
  assert.equal(h.graduated, 1);
  assert.ok(Math.abs(h.graduationRate - 33.333) < 0.01);
  assert.equal(h.medianAthUsd, 100, 'nulls are excluded rather than counted as zero');
  assert.equal(h.bestAthUsd, 100);
});

test('a single launch is a first-timer, not a suspect', () => {
  const v = creatorVerdict(summariseCreator('c', [launch(0)], false));
  assert.equal(v.verdict, 'pass');
});

test('a launch factory fails regardless of graduations', () => {
  const many = Array.from({ length: 12 }, (_, i) => launch(i * 0.05, i < 2));
  const v = creatorVerdict(summariseCreator('c', many, false));
  assert.equal(v.verdict, 'fail');
  assert.match(v.detail, /factory/i);
});

test('a spread-out history with graduations passes', () => {
  const h = summariseCreator('c', [launch(1, true), launch(40, true), launch(80, false)], false);
  const v = creatorVerdict(h);
  assert.equal(v.verdict, 'pass');
  assert.equal(h.launchesInBusiestDay, 1);
});

test('an unknown creator is null, not a pass', () => {
  assert.equal(creatorVerdict(null).verdict, null);
});

// ── Odds context derivation (electron/data/launchIntel.ts) ────────────
//
// The pure helpers that turn a pump.fun coin record + a launch scan into the
// scoring context for shared/odds.ts. Bundled here so package.json needs no
// new entry; the electron module has no electron import. When shared/odds.ts
// has not landed yet, its import is stubbed — none of these helpers call it.

import { existsSync } from 'node:fs';
import { buildSync } from 'esbuild';
const oddsAlias = existsSync('shared/odds.ts') ? {} : { '@shared/odds': './test/.oddsstub.mjs' };
if (!existsSync('shared/odds.ts')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('test/.oddsstub.mjs', 'export const oddsFeaturesFromTrades = () => null; export const scoreOdds = () => null;');
}
buildSync({
  entryPoints: ['electron/data/launchIntel.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@shared': './shared', ...oddsAlias },
  outfile: 'test/.launchintelmain.mjs',
  logLevel: 'silent',
});
const { oddsCtxFromCoin, oddsWindowForAge, oddsCreateSlot, curveProgressFromCoin } = await import('./.launchintelmain.mjs');

test('odds ctx: supply is total_supply scaled by base_decimals, null when absent', () => {
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000, base_decimals: 6 }).supply, 1_000_000_000);
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000, base_decimals: 9 }).supply, 1_000_000);
  // No decimals field → pump's default of 6, same as the rug path.
  assert.equal(oddsCtxFromCoin({ total_supply: 1_000_000_000_000_000 }).supply, 1_000_000_000);
  assert.equal(oddsCtxFromCoin({}).supply, null);
  assert.equal(oddsCtxFromCoin({ total_supply: 0 }).supply, null);
});

test('odds ctx: hasTwitter is null when the field is missing, false when empty, true when set', () => {
  assert.equal(oddsCtxFromCoin({}).hasTwitter, null);
  assert.equal(oddsCtxFromCoin({ twitter: undefined }).hasTwitter, null);
  assert.equal(oddsCtxFromCoin({ twitter: '' }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: '   ' }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: null }).hasTwitter, false);
  assert.equal(oddsCtxFromCoin({ twitter: 'https://x.com/a' }).hasTwitter, true);
});

test('odds ctx: reserves stay RAW and curve progress matches the rug reader', () => {
  const coin = { virtual_sol_reserves: 30_000_000_000, virtual_token_reserves: 1_073_000_000_000_000, base_decimals: 6 };
  const c = oddsCtxFromCoin(coin);
  assert.equal(c.virtualSolReserves, 30_000_000_000);
  assert.equal(c.virtualTokenReserves, 1_073_000_000_000_000);
  assert.equal(c.curveProgress, curveProgressFromCoin(coin));
  assert.equal(c.curveProgress, 0);
  const u = oddsCtxFromCoin({});
  assert.equal(u.virtualSolReserves, null);
  assert.equal(u.virtualTokenReserves, null);
  assert.equal(u.curveProgress, null);
});

test('odds window: nothing under 60 s, 60 until 120, then 120', () => {
  assert.equal(oddsWindowForAge(0), null);
  assert.equal(oddsWindowForAge(59.9), null);
  assert.equal(oddsWindowForAge(60), 60);
  assert.equal(oddsWindowForAge(119), 60);
  assert.equal(oddsWindowForAge(120), 120);
  assert.equal(oddsWindowForAge(86_400), 120);
  assert.equal(oddsWindowForAge(NaN), null);
});

test('odds ctx: a graduated coin reads progress 1 (oddsFor itself refuses it)', () => {
  assert.equal(oddsCtxFromCoin({ complete: true }).curveProgress, 1);
});

test('odds create slot: earliest slot only when the scan reached the launch', () => {
  const trades = [t(5, 'a', 1), t(0, DEV, 1), t(2, 'b', 1)];
  assert.equal(oddsCreateSlot(trades, true), 1000);
  assert.equal(oddsCreateSlot(trades, false), null);
  assert.equal(oddsCreateSlot([], true), null);
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
  console.log(`launchintel: ${passed}/${cases.length} tests passed`);
}

await run();
