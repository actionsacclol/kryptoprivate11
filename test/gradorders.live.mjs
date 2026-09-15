// Live check: does an armed order on a GRADUATED token still get evaluated?
//
// NOT part of `npm test` (needs network). This is the end-to-end version of
// the unit case in feedhealth.test.mjs, against the real engine, the real
// orders poller and the real market layer.
//
// The bug it reproduces (user report, 2026-09-13): a trailing stop froze its
// peak the moment its token graduated and never fired. The orders poller
// skipped the mint because it was still in the launch tracker; the curve
// feed had stopped carrying it because it had migrated to pump-amm. Nothing
// ticked the order at all.
//
// So the harness stages EXACTLY that state — a real, live, graduated
// pumpswap token, planted in the launch tracker with `curveComplete: true`
// and a fresh curve tick — and then asks one question: does the trailing
// stop's peak move? Nothing is signed and no wallet is needed: peak tracking
// happens in `onTick` before any execution gate.
//
// Build first:
//   npx esbuild electron/engine/engine.ts --bundle --format=esm \
//     --platform=node --alias:electron=./test/electronstub.engine.mjs \
//     --alias:@shared=./shared --external:ws --external:undici \
//     --banner:js="import{createRequire}from 'module';const require=createRequire(import.meta.url);" \
//     --outfile=test/.engine.mjs
// Then: node test/gradorders.live.mjs [mint]

import { SniperEngine } from './.engine.mjs';
import { DEFAULT_SETTINGS } from './.sharedtypes.mjs';

const WATCH_MS = 75_000;

// The app's own defaults, so this exercises the provider stack a user
// actually runs on — not a hand-rolled subset that quietly disables half of
// it. Only the parts that would write to disk or spend money are overridden.
const settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  recorderEnabled: false,
  autoStartEngine: false,
  execution: { ...DEFAULT_SETTINGS.execution, liveEnabled: false },
};

/** A graduated pump token that is trading right now. */
async function pickGraduated() {
  const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=pump%20solana');
  const j = await r.json();
  const rows = (j.pairs ?? []).filter(
    (p) =>
      p.chainId === 'solana' &&
      p.dexId === 'pumpswap' &&
      p.baseToken?.address?.endsWith('pump') &&
      Number(p.liquidity?.usd ?? 0) > 20_000,
  );
  rows.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  if (!rows.length) throw new Error('no graduated pump token with liquidity found right now');
  return { mint: rows[0].baseToken.address, symbol: rows[0].baseToken.symbol };
}

const mintArg = process.argv[2];
const picked = mintArg ? { mint: mintArg, symbol: '?' } : await pickGraduated();
console.log(`token under test: ${picked.symbol} ${picked.mint} (graduated, trading on pumpswap)`);

const engine = new SniperEngine(
  () => settings,
  (ev) => {
    if (ev.kind === 'log' && /order|poll|price gap/i.test(ev.line)) console.log(`  [engine] ${ev.line}`);
  },
);

// ── Stage the state that used to cause the skip ───────────────────────
//
// In the field this is a token the engine watched launch and then watched
// graduate: still inside LAUNCH_LIST_CAP, curve complete, last curve tick
// only seconds old. Every input except `curveComplete` says "the feed has
// this one".
engine.tokens.set(picked.mint, {
  row: { mint: picked.mint, symbol: picked.symbol, name: picked.symbol, priceSol: null, flow: {}, detectedAt: Date.now() },
  createEvent: { creator: '11111111111111111111111111111111', mint: picked.mint },
  trades: [], buyersBySol: new Map(), tokensByUser: new Map(), firstBuyAtByUser: new Map(),
  smartBuyers: new Set(), virtualSolReserves: 0n, virtualTokenReserves: 0n,
  mintChecked: true, evalDeadline: 0, decided: true,
  curveComplete: true,          // ← graduated
  dumpRecorded: false, addr: null, oddsTrades: [], oddsTapeTruncated: false,
  oddsJudged: 0, flagged: false, socials: null,
});
engine.lastCurveTickAt.set(picked.mint, Date.now()); // ← ticked a moment ago

console.log(
  `staged: tracked=${engine.tokens.has(picked.mint)} curveComplete=true lastCurveTick=now ` +
    `→ curveFeedIsTicking=${engine.curveFeedIsTicking(picked.mint)} (must be false, or the poller skips it)`,
);

const created = await engine.createOrder({
  mint: picked.mint,
  symbol: picked.symbol,
  kind: 'trailing_stop',
  triggerValue: 25,
  triggerBasis: 'pct',
  amount: 100,
  expiresAt: null,
});
console.log(`arm trailing stop: ${created.ok ? 'OK' : 'FAILED'} — ${created.message}`);
if (!created.ok) process.exit(1);

// ── The experiment ────────────────────────────────────────────────────
//
// "Did the poller reach it?" cannot be answered by looking at the price
// cache alone: `createOrder` writes that itself when it anchors the order.
// So count the writes that happen AFTER arming — only the poll can make
// those — and run the same token twice: once with the fix, once with the
// old `this.tokens.has(mint)` rule restored. The difference between the two
// columns IS the bug.

const peakOf = () => {
  const snap = engine.ordersSnapshot();
  const list = Array.isArray(snap) ? snap : (snap.orders ?? snap.active ?? []);
  return list.find((x) => x.mint === picked.mint && x.kind === 'trailing_stop') ?? null;
};

/** Count price writes for our mint from here on. Only the orders poll can
 *  produce one once the order is armed and the curve feed is not carrying
 *  this token (it graduated). */
let priceWrites = 0;
const realRemember = engine.rememberPrice.bind(engine);
engine.rememberPrice = (mint, price) => {
  if (mint === picked.mint) priceWrites += 1;
  return realRemember(mint, price);
};

const WINDOW_MS = 40_000; // the poll runs every 12 s — room for three

async function observe(label) {
  priceWrites = 0;
  const before = peakOf();
  console.log(`\n── ${label} ──`);
  console.log(`   skip decision: curveFeedIsTicking=${engine.curveFeedIsTicking(picked.mint)}` +
              `  (true = poller skips this mint)`);
  console.log(`   watching ${WINDOW_MS / 1000}s…`);
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  const after = peakOf();
  console.log(`   price updates from the poll: ${priceWrites}`);
  console.log(`   peak: ${before?.peakPriceSol} → ${after?.peakPriceSol}   state: ${after?.state}`);
  return priceWrites;
}

// A: the fix as shipped.
const withFix = await observe('WITH THE FIX (curveFeedIsTicking: graduated ⇒ poll it)');

// B: the rule this replaced — launch-list membership standing in for feed
// liveness. Same engine, same order, same token, one line different.
engine.curveFeedIsTicking = (mint) => engine.tokens.has(mint);
const oldRule = await observe('WITH THE OLD RULE (this.tokens.has(mint))');

console.log('\n─── result ───');
console.log(`price updates in ${WINDOW_MS / 1000}s, with the fix:      ${withFix}`);
console.log(`price updates in ${WINDOW_MS / 1000}s, with the old rule: ${oldRule}`);

const ok = withFix > 0 && oldRule === 0;
if (ok) {
  console.log('\nPASS — the fix polls a graduated, still-tracked mint; the old rule never did.');
  console.log('That gap is exactly the frozen trailing stop the user reported.');
} else if (withFix > 0 && oldRule > 0) {
  console.log('\nINCONCLUSIVE — the old rule also polled. This token is probably not in the');
  console.log('state the bug needs (check the staged tracker entry).');
} else {
  console.log('\nFAIL — the fix did not get this mint polled. The blind spot is back.');
}
process.exit(ok ? 0 : 1);
