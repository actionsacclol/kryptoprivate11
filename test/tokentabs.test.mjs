// Open token tabs — several charts at once, clicked between.
//
// The rules worth pinning are the ones a hand notices when they are wrong:
// re-opening a coin must not add a second tab for it, the cap must never
// evict the tab you are looking at, and closing the one you are on must
// land somewhere sensible rather than on nothing.

import assert from 'node:assert';
import { MAX_TOKEN_TABS, chainForMint, closeTab, neighbourOf, openTab, tabKey, tabLabel } from './.tokentabs.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// A separator, or Mint1 + ones and Mint11 + ones slice to the same string.
const M = (n) => `Mint${n}_${'x'.repeat(40)}`.slice(0, 43);

{
  let tabs = [];
  tabs = openTab(tabs, M(1), 'solana', 'ONE');
  tabs = openTab(tabs, M(2), 'solana', 'TWO');
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map(tabLabel), ['ONE', 'TWO']);

  // Re-opening is a SELECT. Otherwise the bar fills with copies of the coin
  // you keep checking — the one you least want duplicated.
  tabs = openTab(tabs, M(1), 'solana');
  assert.equal(tabs.length, 2, 'no second tab for a token already open');
  assert.equal(tabs[0].symbol, 'ONE', 'and it keeps the name it had');
  ok('opening a token twice selects it rather than duplicating it');
}

{
  // The same address on another chain is another token (copy trading has the
  // same rule), so it gets its own tab.
  let tabs = openTab([], '0xabc', 'robinhood');
  tabs = openTab(tabs, '0xabc', 'bnb');
  assert.equal(tabs.length, 2);
  assert.equal(tabKey(tabs[0]), 'robinhood:0xabc');
  assert.equal(tabKey(tabs[1]), 'bnb:0xabc');
  ok('one address on two chains is two tabs');
}

{
  // The cap evicts the least recently ACTIVE, and never the one just opened.
  let tabs = [];
  for (let i = 0; i < MAX_TOKEN_TABS; i += 1) tabs = openTab(tabs, M(i), 'solana', `S${i}`);
  assert.equal(tabs.length, MAX_TOKEN_TABS);
  // Touch the oldest so it is no longer the coldest.
  tabs = openTab(tabs, M(0), 'solana');
  const fresh = M(99);
  tabs = openTab(tabs, fresh, 'solana', 'NEW');
  assert.equal(tabs.length, MAX_TOKEN_TABS, 'the cap holds');
  assert.ok(tabs.some((t) => t.mint === fresh), 'the tab just opened is never the one evicted');
  assert.ok(tabs.some((t) => t.mint === M(0)), 'nor is the one just used');
  assert.ok(!tabs.some((t) => t.mint === M(1)), 'the coldest went');
  ok('the cap drops the least recently used, never the live one');
}

{
  // Closing hands over to the RIGHT, falling back to the left — what a
  // browser does, and what the hand expects.
  const tabs = [M(1), M(2), M(3)].map((mint) => ({ mint, chain: 'solana', at: 1 }));
  assert.equal(neighbourOf(tabs, tabKey(tabs[0])).mint, M(2));
  assert.equal(neighbourOf(tabs, tabKey(tabs[2])).mint, M(2), 'the last one falls back left');
  assert.equal(neighbourOf([tabs[0]], tabKey(tabs[0])), null, 'closing the only tab leaves nothing');
  assert.equal(neighbourOf(tabs, 'solana:nope'), null, 'a tab that is not there has no neighbour');
  assert.equal(closeTab(tabs, tabKey(tabs[1])).length, 2);
  ok('closing hands over to the right, then the left, then nothing');
}

{
  // A tab with no symbol reads as an ADDRESS, never as a guess.
  assert.equal(tabLabel({ mint: M(7), chain: 'solana', at: 1 }), `${M(7).slice(0, 4)}…${M(7).slice(-3)}`);
  assert.equal(tabLabel({ mint: M(7), chain: 'solana', symbol: 'SEVEN', at: 1 }), 'SEVEN');
  assert.equal(tabLabel({ mint: 'SHORT', chain: 'solana', at: 1 }), 'SHORT');
  ok('an unresolved tab shows its address rather than inventing a name');
}

{
  // The same rule `openToken` uses: a bare 0x is Robinhood's, the first EVM
  // chain the app had.
  assert.equal(chainForMint('0x1234567890abcdef1234567890abcdef12345678'), 'robinhood');
  assert.equal(chainForMint(M(1)), 'solana');
  assert.equal(chainForMint('0x1234567890abcdef1234567890abcdef12345678', 'bnb'), 'bnb', 'a caller that knows says so');
  ok('a bare address lands on the chain openToken would have picked');
}

console.log(`\ntokentabs: ${passed}/6 passed`);
