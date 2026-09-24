// PumpSwap (pump-amm) local builder — golden pins against a real buy and a
// real sell captured from mainnet on 2026-09-20 (test/fixtures/pumpswap-layout.json,
// refreshed by `npm run fixture:pumpswap-layout`).
//
// Every address the builder derives is checked against the slot a real trade
// put it in, and every amount the quote math produces is checked against the
// amount the program's own event reported for that trade — never against a
// number typed into this file. The layout facts and how they were found are
// in docs/pumpswap-builder-2026-09-19.md; the live check that the layout is
// still the one the program expects TODAY is test/pumpswap.live.mjs.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  PUMP_SWAP_BUY_DISC,
  PUMP_SWAP_SELL_DISC,
  PUMP_SWAP_FEE_CEILING_BPS,
  PUMP_SWAP_MIN_COMPUTE_UNITS,
  parsePool,
  parseGlobalConfig,
  quoteNeededForBase,
  quoteOutForBase,
  baseOutForBudget,
  netQuoteForSell,
  pumpSwapAccounts,
  encodePumpSwapData,
  pickRotating,
  canonicalPoolFor,
} from './.pumpswapbuilder.mjs';
import {
  ataFor,
  pumpSwapGlobalConfigFor,
  pumpSwapEventAuthorityFor,
  pumpSwapGlobalVolumeAccumulatorFor,
  pumpSwapUserVolumeAccumulatorFor,
  pumpSwapCreatorVaultAuthorityFor,
  pumpSwapFeeConfigFor,
  pumpPoolAuthorityFor,
  pumpSwapCanonicalPoolFor,
  pumpSwapPoolV2For,
  PUMP_AMM_PROGRAM,
  PUMP_FEES_PROGRAM,
  WSOL_MINT,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
} from './.addr2.mjs';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/pumpswap-layout.json', import.meta.url), 'utf8'));
let passed = 0;
const ok = (name, fn) => {
  fn();
  passed++;
  console.log(`ok   ${name}`);
};
const hex = (b) => Buffer.from(b).toString('hex');

// ── Discriminators and singleton PDAs ─────────────────────────────────

ok('buy and sell discriminators are the ones the real trades carried', () => {
  assert.strictEqual(hex(PUMP_SWAP_BUY_DISC), fx.buy.data.slice(0, 16));
  assert.strictEqual(hex(PUMP_SWAP_SELL_DISC), fx.sell.data.slice(0, 16));
});

ok('global_config, event_authority, global volume accumulator and fee_config derive to the fixture slots', () => {
  assert.strictEqual(pumpSwapGlobalConfigFor(), fx.buy.accounts[2].key);
  assert.strictEqual(pumpSwapEventAuthorityFor(), fx.buy.accounts[15].key);
  assert.strictEqual(pumpSwapGlobalVolumeAccumulatorFor(), fx.buy.accounts[19].key);
  assert.strictEqual(pumpSwapFeeConfigFor(), fx.buy.accounts[21].key);
  assert.strictEqual(fx.buy.accounts[22].key, PUMP_FEES_PROGRAM);
  assert.strictEqual(fx.buy.accounts[16].key, PUMP_AMM_PROGRAM);
});

ok('the user volume accumulator and the creator vault authority derive from the signer and the coin creator', () => {
  assert.strictEqual(pumpSwapUserVolumeAccumulatorFor(fx.buy.signer), fx.buy.accounts[20].key);
  assert.strictEqual(pumpSwapCreatorVaultAuthorityFor(fx.buy.coinCreator), fx.buy.accounts[18].key);
  assert.strictEqual(ataFor(fx.buy.accounts[18].key, WSOL_MINT, TOKEN_PROGRAM), fx.buy.accounts[17].key);
});

ok('pool_v2 is PDA(["pool-v2", base_mint]) — the account the real trades passed as their optional slot', () => {
  // It exists on no coin sampled, and the program still validates the
  // address: leaving it out was InvalidPoolV2 (6062) in simulation.
  assert.strictEqual(pumpSwapPoolV2For(fx.buy.baseMint), fx.buy.optionalAccount);
  assert.strictEqual(pumpSwapPoolV2For(fx.sell.baseMint), fx.sell.optionalAccount);
});

// ── Pool ──────────────────────────────────────────────────────────────

const poolBytes = Buffer.from(fx.buy.poolAccount, 'base64');
const pool = parsePool(fx.buy.pool, poolBytes);

ok('parsePool reads the mints, the vaults and the coin creator the trade named', () => {
  assert.ok(pool, 'parsed');
  assert.strictEqual(pool.baseMint, fx.buy.baseMint);
  assert.strictEqual(pool.quoteMint, WSOL_MINT);
  assert.strictEqual(pool.poolBaseAta, fx.buy.accounts[7].key);
  assert.strictEqual(pool.poolQuoteAta, fx.buy.accounts[8].key);
  assert.strictEqual(pool.coinCreator, fx.buy.coinCreator);
  assert.strictEqual(pool.index, 0);
  assert.ok(pool.lpSupply > 0n);
});

ok('the canonical pool is PDA(["pool", 0, pool-authority(mint), mint, WSOL]) and its creator is that authority', () => {
  assert.strictEqual(pool.creator, pumpPoolAuthorityFor(fx.buy.baseMint));
  assert.strictEqual(pumpSwapCanonicalPoolFor(fx.buy.baseMint), fx.buy.pool);
  assert.strictEqual(canonicalPoolFor(fx.buy.baseMint), fx.buy.pool);
});

ok('a pump-migrated pool carries a virtual quote reserve of about 17.58 SOL at byte 245', () => {
  assert.strictEqual(pool.virtualQuote, poolBytes.readBigUInt64LE(245));
  assert.ok(pool.virtualQuote > 17_000_000_000n && pool.virtualQuote < 18_000_000_000n, `${pool.virtualQuote}`);
});

ok('parsePool refuses a truncated or foreign account', () => {
  assert.strictEqual(parsePool(fx.buy.pool, poolBytes.subarray(0, 200)), null);
  const wrong = Buffer.from(poolBytes);
  wrong[0] ^= 0xff;
  assert.strictEqual(parsePool(fx.buy.pool, wrong), null);
});

// ── GlobalConfig ──────────────────────────────────────────────────────

const global = parseGlobalConfig(Buffer.from(fx.globalConfig, 'base64'));

ok('parseGlobalConfig reads the eight fee recipients, and the two real trades named two different ones', () => {
  assert.ok(global.fromChain, 'from chain');
  assert.strictEqual(global.protocolFeeRecipients.length, 8);
  assert.ok(global.protocolFeeRecipients.includes(fx.buy.protocolFeeRecipient), 'buy recipient listed');
  assert.ok(global.protocolFeeRecipients.includes(fx.sell.protocolFeeRecipient), 'sell recipient listed');
  assert.notStrictEqual(fx.buy.protocolFeeRecipient, fx.sell.protocolFeeRecipient);
  // The recipient's WSOL account is the slot after it.
  assert.strictEqual(ataFor(fx.buy.protocolFeeRecipient, WSOL_MINT, TOKEN_PROGRAM), fx.buy.accounts[10].key);
});

ok('the reserved (mayhem) recipients are a separate list of eight, disjoint from the normal ones', () => {
  assert.strictEqual(global.reservedFeeRecipients.length, 8);
  for (const r of global.reservedFeeRecipients) assert.ok(!global.protocolFeeRecipients.includes(r), `${r} is in both lists`);
});

ok('the buyback vaults are read from the config, and the two trades named two of them', () => {
  assert.ok(global.buybackVaults.length >= 2, `${global.buybackVaults.length}`);
  assert.ok(global.buybackVaults.includes(fx.buy.buybackVault), 'the trades’ vault is listed');
  assert.ok(global.buybackVaults.includes(fx.buybackVault), 'the sampled vault is listed');
  assert.strictEqual(ataFor(fx.buy.buybackVault, WSOL_MINT, TOKEN_PROGRAM), fx.buy.accounts[25].key);
});

ok('a config that is not a GlobalConfig falls back to constants and says so', () => {
  const fb = parseGlobalConfig(Buffer.alloc(100));
  assert.strictEqual(fb.fromChain, false);
  assert.strictEqual(fb.protocolFeeRecipients.length, 1);
  assert.strictEqual(fb.reservedFeeRecipients.length, 1);
  assert.strictEqual(fb.buybackVaults.length, 1);
});

ok('pickRotating is fixed per pool and always names a listed account', () => {
  const a = pickRotating(global.protocolFeeRecipients, fx.buy.pool);
  assert.strictEqual(pickRotating(global.protocolFeeRecipients, fx.buy.pool), a);
  assert.ok(global.protocolFeeRecipients.includes(a));
  assert.strictEqual(pickRotating([], fx.buy.pool), null);
});

// ── Account lists ─────────────────────────────────────────────────────

const fillFor = (side) => ({
  pool,
  owner: fx[side].signer,
  baseTokenProgram: fx[side].baseTokenProgram,
  protocolFeeRecipient: fx[side].protocolFeeRecipient,
  buybackVault: fx[side].buybackVault,
});
// A real trade's flags are what ITS client sent, and a client may mark more
// accounts writable than the program needs — the sell fixture's bot marked
// the vault authority, fee_config and even the fee PROGRAM writable. So:
// keys and signers exact; the builder never marks writable a slot the real
// trade had read-only; and where the real trade over-marked, the live
// simulation (test/pumpswap.live.mjs) is the witness that read-only passes.
const sameList = (built, real, overMarked = []) => {
  assert.strictEqual(built.length, real.length, `${built.length} accounts, the trade had ${real.length}`);
  for (let i = 0; i < real.length; i++) {
    assert.strictEqual(built[i].pubkey, real[i].key, `slot ${i}`);
    assert.strictEqual(built[i].isSigner, real[i].signer, `slot ${i} signer`);
    if (built[i].isWritable !== real[i].writable) {
      assert.ok(!built[i].isWritable, `slot ${i}: built writable, the trade had it read-only`);
      assert.ok(overMarked.includes(i), `slot ${i}: the trade marked it writable, the builder does not`);
    }
  }
};

ok('a buy reproduces all 26 accounts of the real buy, flags included', () => {
  sameList(pumpSwapAccounts('buy', fillFor('buy')), fx.buy.accounts);
});

ok('a sell reproduces all 24 accounts of the real sell; that client over-marked three read-only slots', () => {
  sameList(pumpSwapAccounts('sell', fillFor('sell')), fx.sell.accounts, [18, 19, 20]);
});

ok('the base mint is Token-2022 on a fresh pump coin and the quote side stays classic Token', () => {
  assert.strictEqual(fx.buy.baseTokenProgram, TOKEN_2022_PROGRAM);
  const list = pumpSwapAccounts('buy', fillFor('buy'));
  assert.strictEqual(list[11].pubkey, TOKEN_2022_PROGRAM);
  assert.strictEqual(list[12].pubkey, TOKEN_PROGRAM);
  assert.strictEqual(list[13].pubkey, SYSTEM_PROGRAM);
  assert.strictEqual(list[14].pubkey, ATA_PROGRAM);
  assert.strictEqual(list[5].pubkey, ataFor(fx.buy.signer, fx.buy.baseMint, TOKEN_2022_PROGRAM));
  assert.strictEqual(list[6].pubkey, ataFor(fx.buy.signer, WSOL_MINT, TOKEN_PROGRAM));
});

// ── Instruction data ──────────────────────────────────────────────────

ok('encodePumpSwapData reproduces the real buy’s 24 leading bytes and the real sell’s data', () => {
  const buy = encodePumpSwapData('buy', BigInt(fx.buy.args.base), BigInt(fx.buy.args.quote));
  assert.strictEqual(buy.length, 24);
  assert.strictEqual(hex(buy), fx.buy.data.slice(0, 48));
  const sell = encodePumpSwapData('sell', BigInt(fx.sell.args.base), BigInt(fx.sell.args.quote));
  assert.strictEqual(hex(sell), fx.sell.data.slice(0, 48));
});

// ── Quote math ────────────────────────────────────────────────────────
// The program's event reports the quote VAULT as its reserve; the price it
// charged is constant product on that vault plus the pool's virtual quote
// reserve — exact on both fixtures, off by 43 % and 76 % without it.

const B = (side) => BigInt(fx[side].event.poolBaseReserves);
const Q = (side) => BigInt(fx[side].event.poolQuoteReserves) + pool.virtualQuote;

ok('quoteNeededForBase reproduces the real buy’s quote to the lamport, only with the virtual reserve', () => {
  const base = BigInt(fx.buy.event.baseAmount);
  assert.strictEqual(quoteNeededForBase(base, B('buy'), Q('buy')), BigInt(fx.buy.event.quoteAmount));
  assert.notStrictEqual(quoteNeededForBase(base, B('buy'), BigInt(fx.buy.event.poolQuoteReserves)), BigInt(fx.buy.event.quoteAmount));
});

ok('quoteOutForBase reproduces the real sell’s quote to the lamport, only with the virtual reserve', () => {
  const base = BigInt(fx.sell.event.baseAmount);
  assert.strictEqual(quoteOutForBase(base, B('sell'), Q('sell')), BigInt(fx.sell.event.quoteAmount));
  assert.notStrictEqual(quoteOutForBase(base, B('sell'), BigInt(fx.sell.event.poolQuoteReserves)), BigInt(fx.sell.event.quoteAmount));
});

ok('the fee ceiling plus 3 lamports of rounding covers what the program actually charged on both trades', () => {
  // Each fee component is rounded up on its own: the real buy paid exactly
  // 125 bps and 3 lamports, which a flat 125 bps would have under-reserved.
  const buyFee = BigInt(fx.buy.event.userQuoteAmount) - BigInt(fx.buy.event.quoteAmount);
  const sellFee = BigInt(fx.sell.event.quoteAmount) - BigInt(fx.sell.event.userQuoteAmount);
  const ceiling = (quote) => (quote * PUMP_SWAP_FEE_CEILING_BPS) / 10_000n + 3n;
  assert.ok(buyFee <= ceiling(BigInt(fx.buy.event.quoteAmount)), `buy fee ${buyFee}`);
  assert.ok(buyFee > (BigInt(fx.buy.event.quoteAmount) * PUMP_SWAP_FEE_CEILING_BPS) / 10_000n, 'the flat ceiling alone was short');
  assert.ok(sellFee <= ceiling(BigInt(fx.sell.event.quoteAmount)), `sell fee ${sellFee}`);
  assert.ok(BigInt(fx.buy.event.lpFee) + BigInt(fx.buy.event.protocolFee) <= buyFee);
});

ok('baseOutForBudget never asks the pool for more than the real buyer got for the same spend', () => {
  const spend = BigInt(fx.buy.event.userQuoteAmount);
  const asked = baseOutForBudget(spend, B('buy'), Q('buy'), 0);
  const got = BigInt(fx.buy.event.baseAmount);
  assert.ok(asked <= got, `asked ${asked} > got ${got}`);
  assert.ok(asked * 1000n >= got * 999n, `asked ${asked} is under 99.9 % of ${got}`);
  // What it asks, plus the fee ceiling, fits the budget.
  const price = quoteNeededForBase(asked, B('buy'), Q('buy'));
  assert.ok(price + (price * PUMP_SWAP_FEE_CEILING_BPS) / 10_000n + 3n <= spend);
  // Slippage takes its margin off the tokens, the budget stays the limit.
  const withMargin = baseOutForBudget(spend, B('buy'), Q('buy'), 12);
  assert.ok(withMargin < asked && withMargin > (asked * 87n) / 100n);
  assert.strictEqual(baseOutForBudget(0n, B('buy'), Q('buy'), 0), 0n);
});

ok('netQuoteForSell is at most what the real seller received, and within 1 % of it', () => {
  const net = netQuoteForSell(BigInt(fx.sell.event.baseAmount), B('sell'), Q('sell'));
  const received = BigInt(fx.sell.event.userQuoteAmount);
  assert.ok(net <= received, `net ${net} > received ${received}`);
  assert.ok(net * 100n >= received * 99n, `net ${net} under 99 % of ${received}`);
});

ok('the compute floor is above what a wrapped buy and sell consumed in simulation', () => {
  // Measured 2026-09-19 (test/pumpswap.live.mjs): buys 99–123k, sells 82–99k.
  assert.ok(PUMP_SWAP_MIN_COMPUTE_UNITS >= 200_000);
});

// ── Wiring ────────────────────────────────────────────────────────────

ok('the live signer tries PumpSwap after the curve builder says graduated, before Jupiter and the relayer', () => {
  const src = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8');
  assert.ok(/\['local', 'pumpswap', 'jupiter', 'relayer'\]/.test(src), 'source order');
  assert.ok(/source === 'pumpswap'[\s\S]{0,600}\/graduated\/\.test\(localFail\)/.test(src), 'gated on the curve builder’s graduated verdict');
  assert.ok(/buildPumpSwapTrade\(/.test(src), 'calls the builder');
  // A PumpSwap build that fails validation, simulation or the loss guard
  // falls through to Jupiter rather than aborting the order.
  assert.ok(/source === 'pumpswap' && \(res\.stage === 'validate' \|\| res\.stage === 'simulate' \|\| res\.stage === 'guard'\)/.test(src), 'pre-broadcast failure falls through');
});

ok('the builder wraps SOL through the wallet’s own WSOL account and closes it, which the sign policy allows under a trade', () => {
  const src = fs.readFileSync(new URL('../electron/engine/pumpSwapBuilder.ts', import.meta.url), 'utf8');
  assert.ok(/SyncNative/.test(src) && /CloseAccount/.test(src), 'wrap and close');
  assert.ok(/pumpSwapPoolV2For\(pool\.baseMint\)/.test(src), 'pool_v2 slot derived');
  assert.ok(/state\.virtualQuote/.test(src), 'virtual quote in the price');
  assert.ok(/reservedFeeRecipients/.test(src) && /mayhem/.test(src), 'mayhem coins name a reserved recipient');
});

console.log(`\n${passed} pumpswap checks passed`);
