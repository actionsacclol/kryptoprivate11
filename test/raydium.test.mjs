// Raydium AMM v4 + CPMM rail tests — decoder, pool accounts, Discover rows,
// and the wiring.
//
// The fixtures in test/fixtures/raydium.json are REAL transactions and
// accounts captured from mainnet on 2026-09-19, each with the vault balance
// changes the chain reported alongside. Every amount a decoder produces is
// checked against those deltas rather than against numbers typed into this
// file: a decoder that reads the right bytes from the wrong offsets produces
// confident figures that are silently wrong, and the only witness that
// cannot be fooled is the vault that moved.
//
// What was verified before any of this was written (docs/raydium-rail-2026-09-19.md):
//   • AMM v4 `ray_log` direction: 2 = coin in, 1 = pc in — seven swaps across
//     a pool with SOL as coin and one with SOL as pc, matched to vault deltas;
//   • CPMM SwapEvent: the input vault gained `inputAmount` and the output
//     vault lost `outputAmount` exactly, four of four;
//   • AmmInfo / PoolState offsets: found by searching the accounts for the
//     mints and vaults their own creation instruction named.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  attributeLogs,
  decodeRayLog,
  rayLogsOf,
  ammV4CreationInLogs,
  cpmmEventsOf,
  decodeCpmmEventEx,
  cpmmCreationInLogs,
  sideAmmV4Swap,
  sideCpmmSwap,
  executedPriceSol,
  RAYDIUM_AMM_V4_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT,
  RAYDIUM_CPMM_CREATE_FEE_ACCOUNT,
  WSOL_MINT,
} from './.raydium.mjs';
import { parseAmmV4Pool, parseCpmmPool, parsePool, parseReserves, priceSolFromReserves, solInPool, isRaydiumPoolProgram } from './.raydiumaccounts.mjs';
import { summaryFromPool, mergeLivePools } from './.raydiumrows.mjs';
import { reservesAfter, near, baseSide } from './.raydiumwatcher.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const fx = JSON.parse(fs.readFileSync('test/fixtures/raydium.json', 'utf8'));
const b64 = (s) => Buffer.from(s, 'base64');
const abs = (n) => (n < 0n ? -n : n);
/** The WSOL vault's delta and the token vault's delta out of a fixture's list. */
const solAndToken = (deltas) => {
  const sol = deltas.find((d) => d.mint === WSOL_MINT);
  const tok = deltas.find((d) => d.mint !== WSOL_MINT);
  assert.ok(sol && tok, 'the fixture names both vaults');
  return { sol: BigInt(sol.delta), tok: BigInt(tok.delta) };
};

// ── Constants ─────────────────────────────────────────────────────────

test('the program ids and fee accounts are the pinned mainnet addresses', () => {
  // A typo here would subscribe to nothing and decode nothing, silently.
  assert.equal(RAYDIUM_AMM_V4_PROGRAM, '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
  assert.equal(RAYDIUM_CPMM_PROGRAM, 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
  assert.equal(RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT, '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5');
  assert.equal(RAYDIUM_CPMM_CREATE_FEE_ACCOUNT, 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8');
  assert.equal(isRaydiumPoolProgram(RAYDIUM_AMM_V4_PROGRAM), true);
  assert.equal(isRaydiumPoolProgram(RAYDIUM_CPMM_PROGRAM), true);
  assert.equal(isRaydiumPoolProgram('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'), false, 'CLMM is not this rail');
});

// ── Attribution ───────────────────────────────────────────────────────

test('log lines are attributed to the program executing them, by the invoke stack', () => {
  const logs = [
    'Program A invoke [1]',
    'Program log: Instruction: Route',
    'Program B invoke [2]',
    'Program data: AAAA',
    'Program B success',
    'Program data: BBBB',
    'Program A success',
    'Program data: CCCC',
  ];
  const tagged = attributeLogs(logs);
  assert.deepEqual(
    tagged.map((t) => [t.program, t.line]),
    [
      ['A', 'Program log: Instruction: Route'],
      ['B', 'Program data: AAAA'],
      ['A', 'Program data: BBBB'],
      ['', 'Program data: CCCC'],
    ],
  );
  // A truncated log can pop more than it pushed; that is not a crash.
  assert.doesNotThrow(() => attributeLogs(['Program A success', 'Program data: x']));
});

test("a SwapEvent emitted by ANOTHER program is not decoded as CPMM's", () => {
  // Same discriminator (Anchor hashes the event NAME), same length, wrong
  // program: the invoke stack is what keeps this out.
  const real = fx.cpmm.swaps[0].logs.find((l) => l.startsWith('Program data: ') && b64(l.slice(14)).length === 170);
  assert.ok(real, 'the fixture has a 170-byte SwapEvent line');
  const foreign = ['Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]', real, 'Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success'];
  const r = cpmmEventsOf(foreign);
  assert.equal(r.events.length, 0);
  assert.equal(r.layoutErrors, 0, 'and it is not drift either — it was never ours');
  const ours = [`Program ${RAYDIUM_CPMM_PROGRAM} invoke [1]`, real, `Program ${RAYDIUM_CPMM_PROGRAM} success`];
  assert.equal(cpmmEventsOf(ours).events.length, 1);
});

// ── AMM v4: creation ──────────────────────────────────────────────────

test('an AMM v4 creation is recognised by its InitLog, and names the market', () => {
  const c = fx.ammV4Creation;
  const init = ammV4CreationInLogs(c.logs);
  assert.ok(init, 'InitLog decodes from the creation logs');
  assert.equal(init.market, c.expect.market, 'the market in the log is the one the instruction named');
  assert.ok(init.time > 0n);
  assert.ok(init.pcAmount > 0n && init.coinAmount > 0n, 'initial deposits are positive');
  // Swap logs are not creations, and creation logs carry no swap.
  assert.equal(ammV4CreationInLogs(fx.ammV4Pool.swaps[0].logs), null);
  assert.equal(rayLogsOf(c.logs).filter((e) => e.kind === 'ray_swap').length, 0);
});

test('an AmmInfo account parses to the mints, vaults and market its creation named', () => {
  const c = fx.ammV4Creation;
  const state = parseAmmV4Pool(c.pool, b64(c.poolAccount.data));
  assert.ok(state, 'the account parses');
  assert.equal(c.poolAccount.owner, RAYDIUM_AMM_V4_PROGRAM);
  assert.equal(state.kind, 'amm-v4');
  assert.equal(state.mintA, c.expect.coinMint, 'coin mint at 400');
  assert.equal(state.mintB, c.expect.pcMint, 'pc mint at 432');
  assert.equal(state.vaultA, c.expect.coinVault, 'coin vault at 336');
  assert.equal(state.vaultB, c.expect.pcVault, 'pc vault at 368');
  assert.equal(state.market, c.expect.market, 'market at 528');
  assert.equal(state.lpMint, c.expect.lpMint, 'lp mint at 464');
  const init = ammV4CreationInLogs(c.logs);
  assert.equal(state.decimalsA, init.coinDecimals, 'coin decimals at 32 agree with the InitLog');
  assert.equal(state.decimalsB, init.pcDecimals, 'pc decimals at 40 agree with the InitLog');
  // Sided: SOL is one of the two, and the base is the other.
  assert.ok(state.solSide === 'A' || state.solSide === 'B');
  assert.equal(state.baseMint, state.solSide === 'A' ? state.mintB : state.mintA);
  // parsePool routes by owner and refuses a stranger.
  assert.ok(parsePool(c.pool, RAYDIUM_AMM_V4_PROGRAM, b64(c.poolAccount.data)));
  assert.equal(parsePool(c.pool, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', b64(c.poolAccount.data)), null);
  // Reserves from the vaults price the pool.
  const reserves = parseReserves(b64(c.vaults[0].data), b64(c.vaults[1].data));
  assert.ok(reserves && reserves.reserveA > 0n && reserves.reserveB > 0n);
  const price = priceSolFromReserves(state, reserves);
  assert.ok(price !== null && price > 0, `priced from reserves (${price})`);
  assert.ok(solInPool(state, reserves) > 0);
});

// ── AMM v4: swaps ─────────────────────────────────────────────────────

test('AMM v4 swaps decode to the amounts the vaults moved, sided by which side is SOL', () => {
  const p = fx.ammV4Pool;
  const state = parseAmmV4Pool(p.pool, b64(p.poolAccount.data));
  assert.ok(state && state.solSide !== null, 'the fixture pool has a SOL side');
  let buys = 0;
  let sells = 0;
  for (const s of p.swaps) {
    const swaps = rayLogsOf(s.logs).filter((e) => e.kind === 'ray_swap');
    assert.equal(swaps.length, 1, `${s.signature.slice(0, 8)}: one swap log`);
    const ev = swaps[0];
    assert.ok(ev.direction === 1 || ev.direction === 2);
    assert.ok(ev.poolCoin > 0n && ev.poolPc > 0n, 'reserves before the swap are positive');
    const sided = sideAmmV4Swap(ev, state.solSide);
    assert.ok(sided, 'sided');
    const { sol, tok } = solAndToken(s.vaultDeltas);
    assert.equal(sided.lamports, abs(sol), `${s.signature.slice(0, 8)}: lamports equal the SOL vault's change`);
    assert.equal(sided.baseUnits, abs(tok), `${s.signature.slice(0, 8)}: base units equal the token vault's change`);
    assert.equal(sided.isBuy, sol > 0n, `${s.signature.slice(0, 8)}: a buy is SOL going INTO the pool`);
    const price = executedPriceSol(sided, state.baseDecimals);
    assert.ok(price !== null && price > 0);
    if (sided.isBuy) buys++;
    else sells++;
  }
  assert.ok(buys + sells === p.swaps.length && p.swaps.length >= 3, `${buys} buys, ${sells} sells`);
});

test('direction is read from the log, so the two sidings disagree on the same swap', () => {
  const s = fx.ammV4Pool.swaps[0];
  const ev = rayLogsOf(s.logs).find((e) => e.kind === 'ray_swap');
  const asCoin = sideAmmV4Swap(ev, 'A');
  const asPc = sideAmmV4Swap(ev, 'B');
  assert.notEqual(asCoin.isBuy, asPc.isBuy, 'SOL as coin and SOL as pc side the same swap opposite ways');
  assert.equal(sideAmmV4Swap(ev, null), null, 'no SOL side, no siding');
  assert.equal(sideAmmV4Swap({ ...ev, direction: 7 }, 'A'), null, 'an unknown direction is refused, not guessed');
});

test('the v4 reserve tracker follows a swap and tolerates only a small gap', () => {
  const ev = { kind: 'ray_swap', logType: 3, direction: 2, amountIn: 100n, amountOut: 50n, poolCoin: 10_000n, poolPc: 5_000n };
  assert.deepEqual(reservesAfter(ev), { reserveA: 10_100n, reserveB: 4_950n }, 'coin in, pc out');
  assert.deepEqual(reservesAfter({ ...ev, direction: 1 }), { reserveA: 9_950n, reserveB: 5_100n }, 'pc in, coin out');
  assert.equal(near(10_000n, 10_500n), true, '5% apart is the same pool');
  assert.equal(near(10_000n, 20_000n), false, 'double is another pool');
  assert.equal(near(0n, 0n), true);
  assert.equal(near(0n, 1n), false, 'zero matches only zero');
});

test('decodeRayLog refuses the wrong size or type', () => {
  const ok = fx.ammV4Pool.swaps[0].logs.find((l) => l.includes('ray_log: ')).split('ray_log: ')[1];
  assert.ok(decodeRayLog(ok));
  assert.equal(decodeRayLog(Buffer.concat([b64(ok), Buffer.from([0])]).toString('base64')), null, 'one byte too long');
  const wrongType = b64(ok);
  wrongType[0] = 9;
  assert.equal(decodeRayLog(wrongType.toString('base64')), null);
  assert.equal(decodeRayLog(''), null);
  assert.equal(decodeRayLog('not base64!!'), null);
});

// ── CPMM: swaps ───────────────────────────────────────────────────────

test('CPMM swaps decode to the amounts the vaults moved, sided by their own mints', () => {
  let buys = 0;
  let sells = 0;
  for (const s of fx.cpmm.swaps) {
    const { events, layoutErrors } = cpmmEventsOf(s.logs);
    assert.equal(layoutErrors, 0);
    assert.equal(events.length, 1, `${s.signature.slice(0, 8)}: one CPMM swap`);
    const ev = events[0];
    assert.equal(ev.pool, s.pool, 'the pool comes from the event body');
    const sided = sideCpmmSwap(ev);
    assert.ok(sided, 'a SOL side was found');
    const { sol, tok } = solAndToken(s.vaultDeltas);
    assert.equal(sided.lamports, abs(sol), `${s.signature.slice(0, 8)}: lamports equal the SOL vault's change`);
    assert.equal(sided.baseUnits, abs(tok), `${s.signature.slice(0, 8)}: base units equal the token vault's change`);
    assert.equal(sided.isBuy, sol > 0n, `${s.signature.slice(0, 8)}: a buy is SOL going INTO the pool`);
    if (sided.isBuy) buys++;
    else sells++;
  }
  assert.ok(fx.cpmm.swaps.length >= 3, `${buys} buys, ${sells} sells`);
});

test('a CPMM PoolState parses to the pool the swaps named, with decimals that price it', () => {
  const c = fx.cpmm;
  const state = parseCpmmPool(c.pool, b64(c.poolAccount.data));
  assert.ok(state, 'the account parses');
  assert.equal(c.poolAccount.owner, RAYDIUM_CPMM_PROGRAM);
  assert.equal(state.kind, 'cpmm');
  assert.ok(state.solSide !== null, 'the fixture pool has a SOL side');
  const swapOnPool = c.swaps.find((s) => s.pool === c.pool);
  const ev = cpmmEventsOf(swapOnPool.logs).events[0];
  const tokenMint = ev.inputMint === WSOL_MINT ? ev.outputMint : ev.inputMint;
  assert.equal(state.baseMint, tokenMint, 'the non-SOL mint is the one the swap traded');
  assert.deepEqual([state.mintA, state.mintB].sort(), [WSOL_MINT, tokenMint].sort(), 'mints at 168 and 200');
  const { sol, tok } = solAndToken(swapOnPool.vaultDeltas);
  const solVault = swapOnPool.vaultDeltas.find((d) => d.mint === WSOL_MINT).account;
  const tokVault = swapOnPool.vaultDeltas.find((d) => d.mint !== WSOL_MINT).account;
  assert.deepEqual([state.vaultA, state.vaultB].sort(), [solVault, tokVault].sort(), 'vaults at 72 and 104 are the accounts that moved');
  void sol;
  void tok;
  const reserves = parseReserves(b64(c.vaults[0].data), b64(c.vaults[1].data));
  assert.ok(reserves);
  const price = priceSolFromReserves(state, reserves);
  assert.ok(price !== null && price > 0, `priced from reserves (${price})`);
});

test('decodeCpmmEventEx: a known event of the wrong size is drift, a stranger is nothing', () => {
  const line = fx.cpmm.swaps[0].logs.find((l) => l.startsWith('Program data: ') && b64(l.slice(14)).length === 170);
  const buf = b64(line.slice(14));
  assert.ok(decodeCpmmEventEx(buf.toString('base64')).event);
  const short = decodeCpmmEventEx(buf.subarray(0, 89).toString('base64'));
  assert.equal(short.event, null);
  assert.equal(short.layoutError, true, 'the 81-byte legacy body is refused as drift, never parsed');
  const foreign = Buffer.concat([Buffer.alloc(8, 7), buf.subarray(8)]);
  const f = decodeCpmmEventEx(foreign.toString('base64'));
  assert.equal(f.event, null);
  assert.equal(f.layoutError, false);
});

// ── CPMM: creation ────────────────────────────────────────────────────

test('a CPMM creation is recognised from the Initialize instruction log, whichever variant', () => {
  const c = fx.cpmmCreation;
  assert.equal(cpmmCreationInLogs(c.logs), true, 'a LaunchLab migration creates through initialize_with_permission');
  assert.equal(cpmmCreationInLogs(fx.cpmm.swaps[0].logs), false, 'a swap is not a creation');
  assert.equal(cpmmCreationInLogs(fx.ammV4Creation.logs), false, "a v4 creation is not CPMM's");
  // CPMM emits nothing on creation — the instruction name is all there is.
  const own = attributeLogs(c.logs).filter((t) => t.program === RAYDIUM_CPMM_PROGRAM && t.line.startsWith('Program data: '));
  assert.equal(own.length, 0);
});

test('the new pool is found by OWNER among the accounts the instruction touched, with its vaults', () => {
  const c = fx.cpmmCreation;
  const byAddr = new Map(c.touched.map((a) => [a.address, a]));
  let state = null;
  for (const a of c.touched) {
    if (a.owner !== RAYDIUM_CPMM_PROGRAM || !a.data) continue;
    state = parsePool(a.address, a.owner, b64(a.data));
    if (state) break;
  }
  assert.ok(state, 'exactly the pool parses');
  assert.equal(state.pool, c.pool);
  const va = byAddr.get(state.vaultA);
  const vb = byAddr.get(state.vaultB);
  assert.ok(va?.data && vb?.data, 'both vaults were in the same account batch');
  const reserves = parseReserves(b64(va.data), b64(vb.data));
  assert.ok(reserves && reserves.reserveA > 0n && reserves.reserveB > 0n, 'the migration seeded both sides');
  // This graduation was quoted in something other than SOL — a LaunchLab
  // curve trades in whatever it was launched with and graduates in it. The
  // honest reading is no SOL side, no SOL price, and (with no dollar coin
  // either) no row: naming either mint as "the token" would be a guess.
  assert.equal(state.solSide, null, 'not SOL-quoted, and the parser says so');
  assert.equal(priceSolFromReserves(state, reserves), null);
  assert.equal(solInPool(state, reserves), null);
  assert.equal(baseSide(state), null, 'and neither side is a known quote, so it is not listed');
});

test('the token side of a pool is opposite SOL, else opposite a dollar coin, else unknown', () => {
  const mk = (mintA, mintB) => ({ kind: 'cpmm', pool: 'p', mintA, mintB, decimalsA: 6, decimalsB: 9, vaultA: 'a', vaultB: 'b', solSide: mintA === WSOL_MINT ? 'A' : mintB === WSOL_MINT ? 'B' : null, baseMint: null, baseDecimals: null, status: 0, creator: null, lpMint: 'l', market: null });
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(baseSide(mk('TOKEN', WSOL_MINT)), 'A');
  assert.equal(baseSide(mk(WSOL_MINT, 'TOKEN')), 'B');
  assert.equal(baseSide(mk('TOKEN', USDC)), 'A', 'a USDC pool has a token side, just no SOL price');
  assert.equal(baseSide(mk(USDC, 'TOKEN')), 'B');
  assert.equal(baseSide(mk('TOKEN', 'OTHER')), null, 'two unknowns: no guess');
  assert.equal(baseSide(mk(USDC, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')), null, 'two quotes: no token');
});

// ── Discover rows ─────────────────────────────────────────────────────

test('a live pool becomes an honest Discover row', () => {
  const pool = { kind: 'cpmm', pool: 'P', mint: 'M', decimals: 6, quoteMint: WSOL_MINT, solQuoted: true, priceSol: 0.000002, solInPool: 85, detectedAt: 1_000, signature: 'S' };
  const row = summaryFromPool(pool, 200);
  assert.equal(row.launchpad, 'raydium');
  assert.equal(row.dexId, 'raydium');
  assert.equal(row.poolAddress, 'P');
  assert.equal(row.poolQuoteMint, WSOL_MINT);
  assert.equal(row.createdAt, 1_000);
  assert.equal(row.priceSol, 0.000002);
  assert.ok(Math.abs(row.priceUsd - 0.0004) < 1e-12);
  assert.equal(row.liquidityUsd, 85 * 2 * 200, 'both sides of the pool are worth the SOL side');
  assert.equal(row.bondingCurvePct, 100);
  assert.equal(row.sources.price, 'engine');
  // What the chain did not say stays unsaid.
  assert.equal(row.name, '');
  assert.equal(row.holders, null);
  assert.equal(row.marketCapUsd, null);
  const unpriced = summaryFromPool({ ...pool, solQuoted: false, priceSol: null, solInPool: null, quoteMint: 'USDC' }, 200);
  assert.equal(unpriced.priceUsd, null);
  assert.equal(unpriced.liquidityUsd, null);
  const noSol = summaryFromPool(pool, null);
  assert.equal(noSol.priceUsd, null, 'no SOL price, no USD');
  assert.equal(noSol.priceSol, 0.000002, 'but the SOL price stands');
});

test('live pools merge under provider rows and respect the age window', () => {
  const now = Date.now();
  const mk = (mint, ago) => ({ kind: 'amm-v4', pool: `pool-${mint}`, mint, decimals: 6, quoteMint: WSOL_MINT, solQuoted: true, priceSol: 1e-6, solInPool: 10, detectedAt: now - ago, signature: 's' });
  const provider = summaryFromPool(mk('A', 0), 100);
  provider.poolAddress = null;
  provider.createdAt = null;
  provider.name = 'Provider knows the name';
  const byMint = new Map([['A', provider]]);
  const added = mergeLivePools(byMint, [mk('A', 5_000), mk('B', 5_000), mk('C', 2 * 86_400_000)], 100, 86_400_000);
  assert.equal(added, 1, 'B is new; A was known; C is too old');
  assert.equal(byMint.get('A').name, 'Provider knows the name', 'the provider row is kept');
  assert.equal(byMint.get('A').poolAddress, 'pool-A', 'and takes the pool it lacked');
  assert.equal(byMint.get('A').createdAt, now - 5_000);
  assert.ok(byMint.has('B'));
  assert.ok(!byMint.has('C'));
});

// ── Wiring ────────────────────────────────────────────────────────────

test('the rail is wired: engine start/stop/suspend/resume, the token page, and the Migrated column', () => {
  const engine = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8');
  assert.ok(engine.includes('raydiumWatcher.attach('), 'attached');
  assert.ok(engine.includes('raydiumWatcher.startCreations()'), 'creations start with the scanner');
  assert.equal((engine.match(/raydiumWatcher\.stopAll\(\)/g) ?? []).length, 2, 'stopped on stop() and on suspend');
  assert.ok(engine.includes('livePools: (limit) => raydiumWatcher.recentPools(limit)'));
  const market = fs.readFileSync(new URL('../electron/data/market.ts', import.meta.url), 'utf8');
  assert.ok(market.includes('c.watchRaydiumPool(mint, s.poolAddress)'), 'the token page tries the Raydium tape');
  assert.ok(market.includes('c.unwatchRaydiumPool(mint)'), 'and releases it');
  assert.ok(market.includes('mergeLivePools(byMint, c.livePools('), 'the Migrated column takes the live pools');
  const filter = fs.readFileSync(new URL('../src/components/terminal/FilterBar.tsx', import.meta.url), 'utf8');
  assert.match(filter, /id: 'raydium'[^\n]*live/, 'the Raydium chip says what it now gets');
});

for (const c of cases) {
  try {
    c.fn();
    passed += 1;
    console.log(`  ok   ${c.name}`);
  } catch (e) {
    console.log(`  FAIL ${c.name}\n${e.stack}`);
    process.exit(1);
  }
}
console.log(`\nraydium: ${passed}/${cases.length} passed`);
