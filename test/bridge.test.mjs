// Bridging between chains — the rules both sides of the IPC boundary apply,
// and the reading of a status that has five ways of meaning "not yet".
//
// Everything pinned here traces to docs/bridge-research-2026-09-11.md. The
// numbers are measured; where a figure could not be measured it is absent
// rather than guessed, and this file does not invent one either.

import assert from 'node:assert';
import {
  BRIDGE_CHAINS,
  HARD_FLOOR_USD,
  LIFI_CHAIN_ID,
  SOFT_MIN_USD,
  STATUS_LABEL,
  allRoutes,
  assuranceOf,
  bridgeProblems,
  chainLabel,
  costPct,
  emptyDraft,
  isInFlight,
  nativeSymbolOf,
  readStatus,
  routeId,
  sizeRefusal,
  sizeWarning,
} from './.bridge.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const ALL = new Set(allRoutes().map((r) => routeId(r.from, r.to)));
const draft = (over = {}) => ({ ...emptyDraft(), amount: 1, ...over });

{
  assert.deepEqual(BRIDGE_CHAINS, ['solana', 'robinhood', 'bnb']);
  assert.equal(allRoutes().length, 6, 'three chains, six directed pairs — all to all');
  // Every pair, both ways, and never a chain to itself.
  for (const { from, to } of allRoutes()) assert.notEqual(from, to);
  ok('all three chains, all six directions');
}

{
  // LI.FI's own ids. Solana's is not a chain id in any EVM sense, and getting
  // it wrong routes somebody's money to another chain entirely.
  assert.equal(LIFI_CHAIN_ID.solana, 1151111081099710);
  assert.equal(LIFI_CHAIN_ID.robinhood, 4663);
  assert.equal(LIFI_CHAIN_ID.bnb, 56);
  assert.equal(chainLabel('robinhood'), 'Robinhood Chain');
  assert.equal(nativeSymbolOf('bnb'), 'BNB');
  assert.equal(nativeSymbolOf('solana'), 'SOL');
  ok('each chain carries its real LI.FI id and its own coin');
}

// -- what can actually be checked ---------------------------------------

{
  // The finding that shaped the whole feature. On an EVM source the recipient,
  // the destination chain and the minimum output are all in the calldata at
  // fixed offsets. On Solana NONE of them are in the transaction at all — the
  // destination rides on an opaque id that changes between identical quotes.
  assert.equal(assuranceOf('bnb'), 'verified');
  assert.equal(assuranceOf('robinhood'), 'verified');
  assert.equal(assuranceOf('solana'), 'trusted');
  ok('an EVM source is verifiable and a Solana source is not — stated, not hidden');
}

// -- the draft ----------------------------------------------------------

{
  assert.deepEqual(bridgeProblems(draft(), 10, ALL), []);
  assert.match(bridgeProblems(draft({ to: 'solana' }), 10, ALL)[0], /two different chains/i);
  assert.match(bridgeProblems(draft({ amount: 0 }), 10, ALL)[0], /enter an amount/i);
  assert.match(bridgeProblems(draft({ amount: 11 }), 10, ALL)[0], /more than you hold/i);
  assert.match(bridgeProblems(draft({ amount: Number.NaN }), 10, ALL)[0], /enter an amount/i);
  ok('a complete draft passes, and the obvious mistakes are named');
}

{
  // Unknown is not zero — an unreadable balance must never read as "you have
  // nothing", and the chain refuses what it cannot cover anyway.
  assert.deepEqual(bridgeProblems(draft({ amount: 1_000_000 }), null, ALL), []);
  ok('an unreadable balance does not block a bridge');
}

{
  // A route whose programs this build has not measured refuses BY NAME, rather
  // than failing at the signer with something unreadable. The launcher's
  // BUILDER_VERIFIED pattern, for the same reason.
  const only = new Set(['solana->robinhood']);
  assert.deepEqual(bridgeProblems(draft({ from: 'solana', to: 'robinhood' }), 10, only), []);
  const no = bridgeProblems(draft({ from: 'solana', to: 'bnb' }), 10, only);
  assert.equal(no.length, 1);
  assert.match(no[0], /not enabled in this build yet/i);
  assert.match(no[0], /Solana/);
  assert.match(no[0], /BNB/);
  ok('an unmeasured route refuses by name, naming both chains');
}

// -- size: one warning, one refusal -------------------------------------

const quote = (over = {}) => ({
  from: 'solana',
  to: 'bnb',
  fromAmountRaw: '1000000000',
  toAmountRaw: '1',
  toAmountMinRaw: '1',
  toDecimals: 18,
  fromUsd: 100,
  toUsd: 99,
  tool: 'mayan',
  durationSec: 3,
  assurance: 'trusted',
  feeUsd: 1,
  ...over,
});

{
  assert.equal(costPct(quote({ fromUsd: 100, toUsd: 99 })), 1);
  assert.equal(costPct(quote({ fromUsd: null })), null, 'unpriceable is null, never 0');
  assert.equal(costPct(quote({ fromUsd: 0, toUsd: 0 })), null, 'and a zero basis is not a 0% cost');
  ok('cost is a real ratio, and unknown where it cannot be computed');
}

{
  // Measured floors, per route. These WARN — it is the user's money and a
  // small transfer may be deliberate.
  assert.equal(SOFT_MIN_USD['solana->bnb'], 25);
  assert.equal(SOFT_MIN_USD['solana->robinhood'], 50);
  assert.equal(SOFT_MIN_USD['robinhood->bnb'], 100, 'the worst route measured gets the highest floor');
  assert.equal(sizeWarning(quote({ fromUsd: 100 })), null, 'a big enough transfer says nothing');
  const warn = sizeWarning(quote({ fromUsd: 10, toUsd: 9 }));
  assert.match(warn, /10\.0%/, 'and a small one states the real measured cost');
  assert.match(warn, /\$25/);
  ok('a transfer below its route floor warns with its real cost');
}

{
  // The one hard refusal, and the reason is not "expensive" — it is that a
  // failed transfer below this is never refunded at all, because the refund
  // would cost more gas than it is worth.
  assert.equal(HARD_FLOOR_USD, 5);
  assert.equal(sizeRefusal(quote({ fromUsd: 25 })), null);
  const no = sizeRefusal(quote({ fromUsd: 2 }));
  assert.match(no, /not refunded/i);
  assert.match(no, /\$5/);
  // Unpriceable never refuses on size: we do not know that it is small.
  assert.equal(sizeRefusal(quote({ fromUsd: null })), null);
  ok('under five dollars is refused because a failure there is never refunded');
}

// -- reading a status ---------------------------------------------------

{
  // DONE alone is NOT success. PARTIAL and REFUNDED are both terminal DONE
  // substatuses, and reading only the top level would report a refund as an
  // arrival and a different token as the one you asked for.
  assert.equal(readStatus('DONE', 'COMPLETED'), 'done');
  assert.equal(readStatus('DONE', 'PARTIAL'), 'partial');
  assert.equal(readStatus('DONE', 'REFUNDED'), 'refunded');
  assert.equal(readStatus('DONE', undefined), 'done');
  ok('a DONE that is really a refund or a different token is not reported as arrival');
}

{
  assert.equal(readStatus('PENDING', 'WAIT_DESTINATION_TRANSACTION'), 'pending');
  assert.equal(readStatus('FAILED', 'SLIPPAGE_EXCEEDED'), 'failed');
  // NOT_FOUND and INVALID are NOT failures. A hash the aggregator has not
  // indexed yet looks exactly like one it will never know about, and calling
  // that "failed" tells a user their money is gone while it is still moving.
  assert.equal(readStatus('NOT_FOUND', ''), 'unknown');
  assert.equal(readStatus('INVALID', ''), 'unknown');
  assert.equal(readStatus(undefined, undefined), 'unknown');
  assert.equal(readStatus(null, null), 'unknown');
  assert.equal(readStatus(42, {}), 'unknown', 'and a nonsense answer is unknown, not a guess');
  ok('an unrecognised or missing status is "unknown" — never failed, never pending');
}

{
  assert.equal(isInFlight('pending'), true);
  assert.equal(isInFlight('unknown'), true, 'not knowing means the money is still out there');
  assert.equal(isInFlight('done'), false);
  assert.equal(isInFlight('refunded'), false);
  assert.equal(isInFlight('partial'), false);
  assert.equal(isInFlight('failed'), false);
  ok('"could not check" counts as still in flight, because it is');
}

{
  // The words a user actually reads. "Could not check" must never be dressed
  // as a definite state, and PARTIAL must not read as plain success.
  assert.match(STATUS_LABEL.unknown, /could not check/i);
  assert.ok(!/fail/i.test(STATUS_LABEL.unknown), 'unknown never says failed');
  assert.ok(!/arrived$/i.test(STATUS_LABEL.partial), 'partial never reads as a clean arrival');
  assert.match(STATUS_LABEL.refunded, /refunded/i);
  for (const [k, v] of Object.entries(STATUS_LABEL)) assert.ok(v.length > 0, `${k} has words`);
  ok('every status has honest words, and none of them overstate');
}

console.log(`\nbridge: ${passed}/${passed} passed`);
