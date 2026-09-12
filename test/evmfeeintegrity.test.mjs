// shared/evmFeeIntegrity.ts — the tamper-resistant EVM treasury.
//
// Same properties as test/feeintegrity.test.mjs, for Robinhood Chain: the
// blob decodes to the pinned treasury, editing the readable constant changes a
// decoy (the canonical still wins), case does not count as tampering, and the
// resolver never throws.

import assert from 'node:assert';
import { resolveEvmTreasury, canonicalEvmTreasury } from './.evmfeeintegrity.mjs';
import { EVM_TREASURY_ADDRESS, activeEvmTreasury, evmTreasuryIntegrity, evmFeesEnabled, splitEvmFee, WEI } from './.evmshared.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const TREASURY = '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a';

ok('the blob decodes to the pinned treasury and its checksum agrees', () => {
  assert.equal(canonicalEvmTreasury(), TREASURY);
});

ok('a genuine build resolves clean', () => {
  const r = resolveEvmTreasury(EVM_TREASURY_ADDRESS);
  assert.equal(r.state, 'ok');
  assert.equal(r.intact, true);
  assert.equal(r.treasury, TREASURY);
});

ok('editing the readable constant changes a decoy — the canonical still wins', () => {
  const r = resolveEvmTreasury('0x1111111111111111111111111111111111111111');
  assert.equal(r.state, 'address-tampered');
  assert.equal(r.intact, false);
  assert.equal(r.treasury, TREASURY, 'the fee still goes where the blob says');
});

ok('blanking the readable constant does not turn fees off either', () => {
  const r = resolveEvmTreasury('');
  assert.equal(r.state, 'address-tampered');
  assert.equal(r.treasury, TREASURY);
});

ok('a lowercased copy of the same address is the same destination, not a tamper', () => {
  const r = resolveEvmTreasury(TREASURY.toLowerCase());
  assert.equal(r.state, 'ok');
  assert.equal(r.treasury, TREASURY);
});

ok('the resolver never throws on garbage input', () => {
  for (const bad of [undefined, null, 42, {}, '0x', 'not an address']) {
    const r = resolveEvmTreasury(bad);
    assert.equal(r.treasury, TREASURY);
    assert.equal(r.state, 'address-tampered');
  }
});

ok('shared/evm.ts routes billing through the layer', () => {
  assert.equal(activeEvmTreasury(), TREASURY);
  assert.equal(evmTreasuryIntegrity().state, 'ok');
  assert.equal(evmFeesEnabled(), true);
  const s = splitEvmFee(WEI, false);
  assert.equal(s.treasuryWei, 5_000_000_000_000_000n);
});

console.log(`\n${passed} evm fee integrity cases passed`);
