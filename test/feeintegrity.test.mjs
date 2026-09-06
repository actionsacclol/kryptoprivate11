// Fee integrity — does the anti-tamper layer defeat the attack it exists for?
//
// The threat model is narrow and concrete: someone opens the packaged app,
// finds the treasury address, and edits it to their own wallet — or sets the
// fee to zero. These tests assert that the CASUAL version of that attack fails,
// and, just as important, that a legit untampered build is unaffected and that
// the layer never blocks a trade.

import assert from 'node:assert/strict';
import { resolveTreasury, canonicalTreasury } from './.feeintegrity.mjs';

const REAL = 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n';
const ATTACKER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

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

// ─── The untampered build ─────────────────────────────────────────────

ok('an untampered build resolves to the real treasury and reports intact', () => {
  const r = resolveTreasury(REAL);
  assert.equal(r.treasury, REAL);
  assert.equal(r.state, 'ok');
  assert.equal(r.intact, true);
});

ok('the canonical address is recovered from the blob alone', () => {
  // Proves the address survives independently of the readable constant — the
  // blob is a real second copy, not a checksum of the first.
  assert.equal(canonicalTreasury(), REAL);
});

// ─── The attack this layer exists to stop ─────────────────────────────

ok('editing the readable address to the attacker DOES NOT redirect the fee', () => {
  const r = resolveTreasury(ATTACKER);
  assert.equal(r.treasury, REAL, "the fee must still go to the real treasury");
  assert.notEqual(r.treasury, ATTACKER, 'the attacker address must never be returned');
});

ok('the redirect attempt is flagged as tampering, not silently accepted', () => {
  const r = resolveTreasury(ATTACKER);
  assert.equal(r.state, 'address-tampered');
  assert.equal(r.intact, false);
});

ok('blanking the readable address does not disable the fee', () => {
  // Setting TREASURY_ADDRESS = '' would, without this layer, turn fees off.
  const r = resolveTreasury('');
  assert.equal(r.treasury, REAL, 'the canonical copy keeps fees on');
  assert.equal(r.state, 'address-tampered');
});

ok('whitespace and near-misses are treated as tampering, not a match', () => {
  assert.equal(resolveTreasury(REAL.slice(0, -1) + 'X').state, 'address-tampered');
  assert.equal(resolveTreasury(REAL.toLowerCase()).state, 'address-tampered');
});

// ─── Safety: the layer never sends money to the wrong place ───────────

ok('the layer only ever returns the real address or nothing — never a guess', () => {
  for (const input of [REAL, ATTACKER, '', '   ', 'garbage', REAL + REAL]) {
    const t = resolveTreasury(input).treasury;
    assert.ok(t === REAL || t === '', `returned an unexpected address for ${JSON.stringify(input)}: ${t}`);
  }
});

console.log(`feeintegrity: ${passed}/${passed} tests passed`);
