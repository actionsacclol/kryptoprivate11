// Compress (2026-10-03): the plan a user confirms is the plan that runs.
import assert from 'node:assert/strict';
import { COMPRESS_KEEP, COMPRESS_MIN_MOVE_USD, describeCompress, excludeKey, planCompress, safeSymbol } from './.aiocompress.mjs';

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const native = (chain, symbol, amount, usd) => ({ chain, symbol, name: symbol, token: null, amount, usd, priceSource: 'native', kind: 'native' });
const token = (chain, symbol, amount, usd, kind = 'token') => ({ chain, symbol, name: symbol, token: `${chain}-${symbol}`, amount, usd, priceSource: usd === null ? null : 'market', kind });
const bal = (assets) => ({
  totalUsd: assets.reduce((a, x) => a + (x.usd ?? 0), 0),
  unpriced: 0,
  partial: false,
  chains: ['solana', 'bnb', 'robinhood', 'ethereum', 'base', 'arbitrum'].map((c) => ({ chain: c, ok: true, message: null, usd: 0 })),
  assets,
  at: Date.now(),
});
const ALL = { solana: true, bnb: true, robinhood: true };

test('into SOL: tokens sold on every chain, the other chains moved in, dust under the floor stays', () => {
  const p = planCompress({
    bal: bal([
      native('solana', 'SOL', 0.05, 6),
      token('solana', 'MEME', 1000, 4),
      native('bnb', 'BNB', 0.008, 6.4),
      token('bnb', 'CAKE', 2, 5, 'token'),
      native('robinhood', 'ETH', 0.0005, 1.3),
    ]),
    target: 'solana',
    signingOn: ALL,
    live: ALL,
    enabled: ALL,
  });
  assert.deepEqual(p.sells.map((s) => [s.chain, s.symbol, s.blocked]), [['solana', 'MEME', null], ['bnb', 'CAKE', null]]);
  const bnbMove = p.moves.find((m) => m.from === 'bnb');
  assert.equal(bnbMove.blocked, null, 'BNB (~$11 after the CAKE sale) moves');
  assert.ok(bnbMove.estUsd > 10 && bnbMove.estUsd < 11.5, `estimate ${bnbMove.estUsd}`);
  // What stays behind on BNB is COMPRESS_KEEP, in BNB.
  assert.ok(Math.abs(bnbMove.estAmount - (bnbMove.estUsd / (6.4 / 0.008))) < 1e-12);
  const ethMove = p.moves.find((m) => m.from === 'robinhood');
  assert.match(ethMove.blocked, /under Relay's \$5 minimum/);
  assert.ok(p.stays.some((s) => s.chain === 'robinhood' && /minimum/.test(s.why)), 'the small ETH is listed as staying');
  assert.equal(p.coin, 'SOL');
  assert.equal(p.nothingToDo, false);
  assert.ok(p.estFinalUsd > 20 && p.estFinalUsd < 22, `final ${p.estFinalUsd}`);
  assert.ok(p.estCostUsd > 0 && p.estCostUsd < 1, `cost ${p.estCostUsd}`);
  const words = describeCompress(p);
  assert.match(words, /Sell 1,000 MEME on Solana/);
  assert.match(words, /Move about .* BNB from BNB Chain to Solana/);
  assert.doesNotMatch(words, /Robinhood/, 'nothing that will not happen is described as happening');
});

test('a chain in Paper never sells on paper: blocked, flagged for Live, and its token stays', () => {
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), native('bnb', 'BNB', 0.001, 0.8), token('bnb', 'CAKE', 4, 10)]),
    target: 'solana',
    signingOn: ALL,
    live: { solana: true, bnb: false, robinhood: true },
    enabled: ALL,
  });
  assert.match(p.sells[0].blocked, /BNB Chain is in Paper/);
  assert.deepEqual(p.needsLive, ['bnb']);
  assert.ok(p.stays.some((s) => s.symbol === 'CAKE'));
  // Without the CAKE sale BNB holds ~$0.80: under the floor, so nothing runs.
  assert.equal(p.nothingToDo, true);
});

test('not the signer: nothing sold or moved there, and the reason says so', () => {
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), native('bnb', 'BNB', 0.02, 16), token('bnb', 'CAKE', 4, 10)]),
    target: 'solana',
    signingOn: { solana: true, bnb: false, robinhood: true },
    live: ALL,
    enabled: ALL,
  });
  assert.match(p.sells[0].blocked, /not the signer on BNB Chain/);
  assert.match(p.moves.find((m) => m.from === 'bnb').blocked, /not the signer/);
});

test('Ethereum, Base and Arbitrum stay — read for the total only', () => {
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), native('base', 'ETH', 0.01, 26)]),
    target: 'bnb',
    signingOn: ALL,
    live: ALL,
    enabled: ALL,
  });
  assert.ok(p.stays.some((s) => s.chain === 'base' && /read for the total only/.test(s.why)));
  assert.equal(p.moves.find((m) => m.from === 'solana').blocked, null, 'Solana → BNB still moves');
  assert.equal(p.moves.some((m) => m.from === 'base'), false, 'never a move from Base');
});

test('an unpriced token is still sold (a route may exist) but leaves the cost unknown', () => {
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), token('solana', 'MYSTERY', 5, null)]),
    target: 'solana',
    signingOn: ALL,
    live: ALL,
    enabled: ALL,
  });
  assert.equal(p.sells[0].blocked, null);
  assert.equal(p.estCostUsd, null, 'unknown, never a number');
  assert.match(describeCompress(p), /MYSTERY on Solana \(no price\)/);
});

test('dust is never sold: it costs more than it returns, and it does not ask for Live', () => {
  const d = { ...token('bnb', 'TAIGAN', 15618, 0.004), dust: true };
  const p = planCompress({ bal: bal([native('solana', 'SOL', 0.1, 12), d]), target: 'solana', signingOn: ALL, live: { solana: true, bnb: false, robinhood: true }, enabled: ALL });
  assert.match(p.sells[0].blocked, /under a cent/);
  assert.deepEqual(p.needsLive, [], 'no Go Live prompt for dust');
  assert.equal(p.nothingToDo, true);
});

test('v6 audit: an unread chain is named, never treated as empty', () => {
  const b = bal([native('solana', 'SOL', 0.1, 12)]);
  b.chains = b.chains.map((c) => (c.chain === 'bnb' ? { ...c, ok: false, message: 'no answer in 9s', usd: null } : c));
  const p = planCompress({ bal: b, target: 'solana', signingOn: ALL, live: ALL, enabled: ALL });
  assert.deepEqual(p.unread, ['bnb']);
  assert.ok(p.stays.some((s) => s.chain === 'bnb' && /could not be read/.test(s.why)));
});

test('v6 audit: $KRYPTO and a running bot’s coin stay, with the reason', () => {
  const k = { ...token('solana', 'KRYPTO', 1000000, 40), token: 'KMINT' };
  const bot = token('bnb', 'BAG', 10, 20);
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), k, native('bnb', 'BNB', 0.001, 0.8), bot]),
    target: 'solana', signingOn: ALL, live: ALL, enabled: ALL,
    exclude: { [excludeKey('solana', 'KMINT')]: 'your $KRYPTO', [excludeKey('bnb', bot.token.toUpperCase())]: 'a running script holds it' },
  });
  assert.equal(p.sells.find((s) => s.symbol === 'KRYPTO').blocked, 'your $KRYPTO');
  assert.equal(p.sells.find((s) => s.symbol === 'BAG').blocked, 'a running script holds it', 'EVM keys compare lower-case');
  assert.equal(p.needsLive.length, 0);
  assert.doesNotMatch(describeCompress(p), /KRYPTO|BAG/);
});

test('v6 audit: untrusted symbols are cleaned before a native dialog', () => {
  assert.equal(safeSymbol('US‮DT'), 'USDT');
  assert.equal(safeSymbol('A\nB'), 'AB');
  assert.equal(safeSymbol('x'.repeat(40)).length, 25);
  assert.equal(safeSymbol(''), '?');
});

test('already all in the target coin: nothing to do', () => {
  const p = planCompress({
    bal: bal([native('solana', 'SOL', 0.1, 12), native('bnb', 'BNB', 0, 0)]),
    target: 'solana',
    signingOn: ALL,
    live: ALL,
    enabled: ALL,
  });
  assert.equal(p.nothingToDo, true);
  assert.equal(p.moves.length, 0, 'an empty chain is not even a line');
  assert.ok(COMPRESS_MIN_MOVE_USD > 5, 'the floor carries a margin over Relay’s $5');
  assert.ok(COMPRESS_KEEP.solana > 0.00089, 'Solana keeps more than its rent-exempt minimum');
});

let passed = 0;
for (const c of cases) {
  try {
    c.fn();
    passed++;
    console.log(`ok   ${c.name}`);
  } catch (err) {
    console.error(`FAIL ${c.name}\n  ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}
console.log(`aiocompress: ${passed}/${cases.length} passed`);
