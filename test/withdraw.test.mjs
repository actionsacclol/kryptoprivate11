// Withdraw SOL — the user-facing cash-out path built on the sweep signer.
// Pins: the max-withdrawable arithmetic (rent-exempt minimum + fee headroom
// stay behind, floored at 0, unknown stays null), and that the sweep policy
// the withdraw rides on still refuses a non-home destination, a second
// destination smuggled into the same tx, and anything over the cap.

import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { checkOutflowForTest as check } from './.signpolicy.mjs';
import { maxWithdrawableLamports, RENT_EXEMPT_MIN_LAMPORTS, WITHDRAW_FEE_HEADROOM_LAMPORTS } from './.sweep.mjs';

// ── maxWithdrawableLamports ──────────────────────────────────────────────

assert.equal(RENT_EXEMPT_MIN_LAMPORTS, 890_880);
assert.equal(WITHDRAW_FEE_HEADROOM_LAMPORTS, 10_000);
const RESERVE = RENT_EXEMPT_MIN_LAMPORTS + WITHDRAW_FEE_HEADROOM_LAMPORTS;

assert.equal(maxWithdrawableLamports(1_000_000_000), 1_000_000_000 - RESERVE);
console.log('ok  max = balance − rent-exempt minimum − fee headroom');

assert.equal(maxWithdrawableLamports(RESERVE), 0, 'exactly the reserve → nothing withdrawable');
assert.equal(maxWithdrawableLamports(RESERVE - 1), 0, 'below the reserve floors at 0, never negative');
assert.equal(maxWithdrawableLamports(0), 0);
assert.equal(maxWithdrawableLamports(RESERVE + 1), 1);
console.log('ok  floor at 0 below the reserve');

assert.equal(maxWithdrawableLamports(1_500_000_000.9), 1_500_000_000 - RESERVE, 'fractional lamports are floored');
console.log('ok  fractional balances floor to whole lamports');

// Honest-null: an unknown balance is null, never 0.
assert.equal(maxWithdrawableLamports(null), null);
assert.equal(maxWithdrawableLamports(undefined), null);
assert.equal(maxWithdrawableLamports(NaN), null);
assert.equal(maxWithdrawableLamports(Infinity), null);
console.log('ok  unknown balance → null (not 0)');

// ── The sweep policy a withdraw is signed under ──────────────────────────

const BLOCKHASH = '11111111111111111111111111111111';
const me = Keypair.generate();
const MY_PUB = me.publicKey.toBase58();
const HOME = Keypair.generate().publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();
const SWEEP = (max) => ({ intent: 'sweep', maxTransferLamports: max });

function tx(instructions) {
  const msg = new TransactionMessage({ payerKey: me.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}
const transfer = (to, lamports) => SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: new PublicKey(to), lamports });

{
  const r = check(tx([transfer(HOME, 500_000)]), MY_PUB, HOME, SWEEP(500_000));
  assert.equal(r.ok, true, r.message);
  console.log('ok  withdraw to the stored withdrawal address is allowed');
}

{
  const r = check(tx([transfer(ATTACKER, 500_000)]), MY_PUB, HOME, SWEEP(500_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /withdrawal address|refusing/i);
  console.log('ok  withdraw to a non-home destination is REFUSED');
}

{
  // Home gets its lamports, but a second transfer to a stranger rides along.
  const r = check(tx([transfer(HOME, 500_000), transfer(ATTACKER, 1)]), MY_PUB, HOME, SWEEP(500_001));
  assert.equal(r.ok, false);
  assert.match(r.message, /single instruction|refusing/i);
  console.log('ok  a second destination in the same tx is REFUSED');
}

{
  // Two transfers both to home still exceed "exactly one instruction".
  const r = check(tx([transfer(HOME, 1), transfer(HOME, 1)]), MY_PUB, HOME, SWEEP(2));
  assert.equal(r.ok, false);
  console.log('ok  two transfers to home in one tx are REFUSED (single-instruction rule)');
}

{
  const r = check(tx([transfer(HOME, 500_001)]), MY_PUB, HOME, SWEEP(500_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /cap/i);
  console.log('ok  one lamport over the cap is REFUSED');
}

{
  const r = check(tx([transfer(HOME, 500_000)]), MY_PUB, null, SWEEP(500_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /no withdrawal address/i);
  console.log('ok  withdraw with no withdrawal address set is REFUSED');
}

{
  // A different wallet's home address is not THIS wallet's home address.
  const OTHER_HOME = Keypair.generate().publicKey.toBase58();
  const r = check(tx([transfer(OTHER_HOME, 500_000)]), MY_PUB, HOME, SWEEP(500_000));
  assert.equal(r.ok, false);
  console.log("ok  another wallet's home address is REFUSED for this wallet");
}

console.log('withdraw: all passed');
