// The Wallet Utilities swapper — the rules the card and the main process
// both apply, and the unit conversions that decide how much leaves.
//
// `swapProblems` runs on BOTH sides of the IPC boundary, so "the button was
// enabled" can never mean something different from "main will accept it".

import assert from 'node:assert';
import {
  DEFAULT_SLIPPAGE_PCT,
  KNOWN_MINTS,
  MAX_SLIPPAGE_PCT,
  MIN_SLIPPAGE_PCT,
  SPEED_URGENCY,
  SWAP_ABILITY,
  SWAP_CHAINS,
  SWAP_CU_BUDGET,
  SWAP_SPEEDS,
  WSOL_MINT,
  nativeOf,
  nativeSymbol,
  priorityCapLamports,
  emptyDraft,
  fromRaw,
  isKnownMint,
  looksLikeMint,
  swapProblems,
  toRaw,
} from './.swap.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const good = (over = {}) => ({ ...emptyDraft(), amount: 1, ...over });

{
  const d = emptyDraft();
  assert.equal(d.inputMint, WSOL_MINT, 'SOL is the side people start from');
  assert.equal(d.amount, 0, 'and no amount is pre-filled — nothing is ever primed to send');
  assert.equal(d.slippagePct, DEFAULT_SLIPPAGE_PCT);
  assert.equal(d.speed, 'normal', 'the middle preset is the default — never the expensive one');
  assert.deepEqual(swapProblems(d, 10), ['Enter an amount.'], 'so the only complaint is the amount');
  ok('a fresh draft is SOL to USDC with nothing primed to send');
}

{
  assert.deepEqual(swapProblems(good(), 10), [], 'a complete draft passes');
  assert.deepEqual(swapProblems(good({ amount: 10 }), 10), [], 'and spending exactly what you hold is allowed');
  ok('a complete draft has nothing wrong with it');
}

{
  // The rule that stops a swap becoming a no-op that still pays a fee.
  const same = swapProblems(good({ outputMint: WSOL_MINT }), 10);
  assert.equal(same.length, 1);
  assert.match(same[0], /two different tokens/i);
  ok('swapping a token for itself is refused');
}

{
  assert.match(swapProblems(good({ amount: 0 }), 10)[0], /enter an amount/i);
  assert.match(swapProblems(good({ amount: -1 }), 10)[0], /enter an amount/i);
  assert.match(swapProblems(good({ amount: Number.NaN }), 10)[0], /enter an amount/i);
  assert.match(swapProblems(good({ amount: 11 }), 10)[0], /more than you hold/i);
  ok('the amount must be a real positive number, and no more than you hold');
}

{
  // Unknown is not zero. An unreadable balance must never be reported as
  // "you do not hold that" — the chain refuses what it cannot cover anyway.
  assert.deepEqual(swapProblems(good({ amount: 1_000_000 }), null), [], 'a null balance never blocks');
  ok('an unreadable balance does not block a swap, and is not treated as zero');
}

{
  assert.deepEqual(swapProblems(good({ slippagePct: MIN_SLIPPAGE_PCT }), 10), []);
  assert.deepEqual(swapProblems(good({ slippagePct: MAX_SLIPPAGE_PCT }), 10), []);
  // Zero slippage is a swap that never lands; 100 % is a swap that can take
  // everything. Both are refused rather than clamped.
  assert.equal(swapProblems(good({ slippagePct: 0 }), 10).length, 1);
  assert.equal(swapProblems(good({ slippagePct: 100 }), 10).length, 1);
  assert.equal(swapProblems(good({ slippagePct: Number.NaN }), 10).length, 1);
  ok('slippage is bounded at both ends, and refused rather than clamped');
}

{
  assert.match(swapProblems(good({ inputMint: 'not-a-mint' }), 10)[0], /swap from/i);
  assert.match(swapProblems(good({ outputMint: '' }), 10)[0], /swap to/i);
  // The shape check is per chain, and the two shapes do not overlap: an EVM
  // address pasted into the Solana swapper is not a mint, and a base58 mint
  // pasted into the BNB one is not a token.
  assert.equal(looksLikeMint('solana', WSOL_MINT), true);
  assert.equal(looksLikeMint('solana', '0x55d398326f99059fF775485246999027B3197955'), false);
  assert.equal(looksLikeMint('solana', 'IlO0'), false, 'base58 has no I, l, O or 0');
  assert.equal(looksLikeMint('bnb', '0x55d398326f99059fF775485246999027B3197955'), true);
  assert.equal(looksLikeMint('bnb', WSOL_MINT), false);
  assert.equal(looksLikeMint('bnb', '0x1234'), false, 'an EVM address is 40 hex digits');
  ok('each chain checks the address shape that chain actually uses');
}

{
  // The picker is a convenience, never a restriction: anything else is
  // reachable by pasting, and nothing here is a recommendation.
  assert.equal(KNOWN_MINTS.solana.length, 3);
  assert.equal(isKnownMint('solana', WSOL_MINT).symbol, 'SOL');
  assert.equal(isKnownMint('solana', USDC).decimals, 6);
  assert.equal(isKnownMint('solana', 'SomethingElse111111111111111111111111111111'), null);
  ok('the Solana list names SOL and the two stables, and nothing else');
}

// -- the other two chains ------------------------------------------------

{
  assert.deepEqual(SWAP_CHAINS, ['solana', 'robinhood', 'bnb']);
  assert.equal(nativeSymbol('solana'), 'SOL');
  assert.equal(nativeSymbol('robinhood'), 'ETH');
  assert.equal(nativeSymbol('bnb'), 'BNB');
  // Each chain's native is the address its own rail uses for "the coin".
  assert.equal(nativeOf('solana'), WSOL_MINT, 'Solana wraps, so its native side is WSOL');
  assert.equal(nativeOf('bnb'), '0x0000000000000000000000000000000000000000');
  ok('every chain names its own coin, and Solana names the wrapped one');
}

{
  // Read off each chain on 2026-09-11 — symbol and decimals from the
  // contract, not from memory. The check earned its keep immediately: BSC's
  // stables are EIGHTEEN decimals, not the six they are nearly everywhere
  // else, and assuming six would have sized every swap a trillion-fold wrong.
  const usdt = isKnownMint('bnb', '0x55d398326f99059fF775485246999027B3197955');
  assert.equal(usdt.symbol, 'USDT');
  assert.equal(usdt.decimals, 18, 'BSC USDT is 18 decimals, not 6');
  assert.equal(isKnownMint('bnb', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d').decimals, 18);
  assert.equal(isKnownMint('robinhood', '0x5fc5360d0400a0fd4f2af552add042d716f1d168').symbol, 'USDG');
  assert.equal(isKnownMint('robinhood', '0x5fc5360d0400a0fd4f2af552add042d716f1d168').decimals, 6);
  // Case must not decide whether a token is known: addresses get pasted in
  // whatever case the explorer showed them.
  assert.ok(isKnownMint('bnb', '0x55d398326f99059ff775485246999027b3197955'), 'lookup is case-insensitive');
  ok('the EVM token lists carry the decimals their contracts actually report');
}

{
  // What each chain can route, and the refusal that follows from it.
  assert.equal(SWAP_ABILITY.solana, 'any');
  assert.equal(SWAP_ABILITY.robinhood, 'native-pair');
  assert.equal(SWAP_ABILITY.bnb, 'native-pair');

  const USDT_BNB = '0x55d398326f99059fF775485246999027B3197955';
  const USDC_BNB = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
  const native = nativeOf('bnb');

  // Native on either side is fine, both directions.
  assert.deepEqual(swapProblems({ ...emptyDraft('bnb'), inputMint: native, outputMint: USDT_BNB, amount: 1 }, 10), []);
  assert.deepEqual(swapProblems({ ...emptyDraft('bnb'), inputMint: USDT_BNB, outputMint: native, amount: 1 }, 10), []);

  // Token to token is refused HERE rather than at the router, because the
  // rail has no builder for it and a control that fails is worse than one
  // that says why.
  const both = swapProblems({ ...emptyDraft('bnb'), inputMint: USDT_BNB, outputMint: USDC_BNB, amount: 1 }, 10);
  assert.equal(both.length, 1);
  assert.match(both[0], /one side has to be BNB/i);
  assert.match(both[0], /not routed on this chain yet/i);

  // And the same pair on Solana is perfectly fine — the limit is the chain's,
  // not the feature's.
  assert.deepEqual(
    swapProblems({ ...emptyDraft('solana'), inputMint: USDC, outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', amount: 1 }, 10),
    [],
  );
  ok('an EVM swap must have its native coin on one side; Solana has no such limit');
}

{
  // A fresh draft per chain starts on that chain's coin, never on a leftover
  // address from the chain before it.
  for (const c of SWAP_CHAINS) {
    const d = emptyDraft(c);
    assert.equal(d.chain, c);
    assert.equal(d.inputMint, nativeOf(c), `${c} starts from its own coin`);
    assert.equal(d.amount, 0);
    assert.ok(looksLikeMint(c, d.outputMint), `${c} starts with a valid counterpart`);
  }
  assert.deepEqual(swapProblems({ ...emptyDraft('bnb'), chain: 'ethereum', amount: 1 }, 10), ['Pick a chain.']);
  ok('each chain opens on its own coin, and an unknown chain is refused outright');
}

// -- unit conversion: how much actually leaves ---------------------------

{
  assert.equal(toRaw(1, 9), 1_000_000_000n, 'one SOL');
  assert.equal(toRaw(1, 6), 1_000_000n, 'one USDC');
  assert.equal(toRaw(0.000001, 6), 1n, 'one base unit');
  assert.equal(toRaw(0, 9), 0n);
  assert.equal(toRaw(-5, 9), 0n, 'a negative amount converts to nothing, never a huge u64');
  assert.equal(toRaw(Number.NaN, 9), 0n);
  ok('human units convert to base units at both common precisions');
}

{
  // The float trap this exists to avoid: 0.1 * 1e9 is 100000000.00000001 in
  // IEEE754, and a swap that asks for one lamport MORE than the user typed
  // fails at the worst possible moment — on a max-balance swap.
  assert.equal(toRaw(0.1, 9), 100_000_000n);
  assert.equal(toRaw(0.3, 9), 300_000_000n);
  assert.equal(toRaw(8.7, 9), 8_700_000_000n);
  assert.equal(toRaw(1.005, 6), 1_005_000n);
  ok('conversion goes through fixed point, so 0.1 SOL is exactly 100000000');
}

{
  // Rounds DOWN: never spend more than was typed.
  assert.equal(toRaw(1.9999999999, 6), 1_999_999n);
  assert.equal(toRaw(0.0000009, 6), 0n, 'below one base unit is nothing, not one');
  ok('conversion rounds down — a swap never spends more than was typed');
}

{
  assert.equal(fromRaw('1000000000', 9), 1);
  assert.equal(fromRaw('1', 6), 0.000001);
  assert.equal(fromRaw('not a number', 6), 0);
  ok('base units convert back for display, and garbage reads as zero');
}

// -- speed presets ------------------------------------------------------
//
// They buy BLOCK POSITION and nothing else. The numbers behind them are
// measured percentiles of what the network is actually paying, so the only
// thing pinned here is that the mapping is ordered, bounded and honest about
// which way it points.

{
  assert.deepEqual(SWAP_SPEEDS, ['cheap', 'normal', 'fast'], 'cheapest first, so the list reads as a price ladder');
  assert.equal(SPEED_URGENCY.cheap, 'normal', 'cheapest pays the median');
  assert.equal(SPEED_URGENCY.normal, 'competitive');
  assert.equal(SPEED_URGENCY.fast, 'high');
  // p95 is reserved for getting OUT of a position under pressure. A swap
  // from a wallet page is not that, and offering it here would price an
  // emergency into an errand.
  assert.ok(!Object.values(SPEED_URGENCY).includes('emergency'), 'no preset reaches the emergency percentile');
  ok('the three presets map to three measured percentiles, cheapest first');
}

{
  assert.equal(swapProblems(good({ speed: 'cheap' }), 10).length, 0);
  assert.equal(swapProblems(good({ speed: 'fast' }), 10).length, 0);
  assert.match(swapProblems(good({ speed: 'ludicrous' }), 10)[0], /pick a speed/i);
  ok('an unknown speed is refused rather than silently priced');
}

{
  // micro-lamports per CU to a lamport ceiling. Getting this wrong by 1e6 is
  // the difference between a tenth of a cent and half a SOL.
  assert.equal(priorityCapLamports(1e6), SWAP_CU_BUDGET, 'one lamport per CU is exactly the CU budget');
  assert.equal(priorityCapLamports(100_000), SWAP_CU_BUDGET / 10);
  assert.equal(priorityCapLamports(0), 0);
  assert.equal(priorityCapLamports(-5), 0, 'a negative estimate buys nothing, never a refund');
  assert.equal(priorityCapLamports(Number.NaN), 0);
  // Sanity on the order of magnitude: the estimator's own fallback p50 is
  // 50k micro-lamports/CU, which must come out as a fraction of a cent.
  assert.ok(priorityCapLamports(50_000) < 20_000_000, 'a median-priced swap is well under 0.02 SOL');
  ok('the priority ceiling converts micro-lamports per CU without an exponent slip');
}

console.log(`\nswap: ${passed}/${passed} passed`);
