// The bridge orchestrator — which routes it will touch, and the checks it
// applies to a transaction somebody else built.
//
// The two rails are verified differently and that asymmetry is the feature's
// defining fact, so it is pinned here rather than left to a comment.

import assert from 'node:assert';
import { ENABLED_ROUTES, NON_EVM_RECEIVER, chainRefusal, containsAddress, decodeBridgeData, lifiFeeCeilingLamports, recipientProblem, relayDepositProblem } from './.bridgeengine.mjs';
import { VersionedTransaction } from '@solana/web3.js';
import fs from 'node:fs';
import { allRoutes, routeId } from './.bridge.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

{
  // A route is enabled only once the thing it targets has been MEASURED — the
  // launcher's BUILDER_VERIFIED pattern. Mayan's Solana programs have not been
  // decoded, so solana->bnb is deliberately absent and must stay absent until
  // they are.
  assert.ok(!ENABLED_ROUTES.has('solana->bnb'), 'an unmeasured route is not enabled');
  assert.ok(ENABLED_ROUTES.has('solana->robinhood'), 'the measured Solana route is');
  for (const r of allRoutes()) {
    const id = routeId(r.from, r.to);
    if (r.from !== 'solana') assert.ok(ENABLED_ROUTES.has(id), `${id} has a pinned contract, so it is enabled`);
  }
  ok('every EVM-source route is enabled; the unmeasured Solana one is not');
}

{
  // Five of six today. The sixth is a measurement away, not a redesign.
  assert.equal(ENABLED_ROUTES.size, 5);
  ok('five of the six directions are live, and the sixth is one quote away');
}

// -- what can be proved about a transaction we did not build ---------------

const ME = '0x011F1bbac10Dcf1eFCe795C9e92391C40cbbDd0a';
const STRANGER = '0xdEAD00000000000000000000000000000000bEEf';

{
  // The recipient check is a byte search, not a fixed word offset: the offset
  // depends on which bridge LI.FI picked, and this has to be true or false
  // for the transaction in hand.
  const calldata = '0x1794958f' + '0'.repeat(24) + ME.slice(2).toLowerCase() + 'deadbeef'.repeat(8);
  assert.equal(containsAddress(calldata, ME), true, 'our address is found wherever it sits');
  assert.equal(containsAddress(calldata, STRANGER), false, 'a stranger is not');
  ok('the recipient is found in the calldata regardless of where it sits');
}

{
  // Case must never decide this: addresses arrive checksummed, lowercase and
  // uppercase depending on who wrote them.
  const lower = '0x' + 'ab'.repeat(20);
  const calldata = '0xdeadbeef' + 'AB'.repeat(20);
  assert.equal(containsAddress(calldata, lower), true);
  assert.equal(containsAddress(calldata.toLowerCase(), lower.toUpperCase()), true);
  ok('the recipient check is case-insensitive, both ways');
}

{
  // A Solana transaction carries no EVM recipient at all — measured, and the
  // reason the Solana leg is "trusted" rather than "verified". A search that
  // accidentally matched something would be worse than no search.
  assert.equal(containsAddress('0x' + '00'.repeat(200), ME), false);
  assert.equal(containsAddress('', ME), false);
  // And a malformed address never accidentally "matches" everything.
  assert.equal(containsAddress('0xdeadbeef', '0x123'), false, 'a short address matches nothing');
  assert.equal(containsAddress('0xdeadbeef', ''), false, 'an empty address matches nothing');
  ok('an absent or malformed recipient never reads as found');
}

{
  // A Solana recipient is a 32-byte pubkey, not 20 hex bytes. The first
  // version handled only the EVM shape, so every ->solana bridge would have
  // failed this check and — once the send path started refusing on it — been
  // refused. Found by audit 2026-09-11.
  const SOL = '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce';
  // Its 32 bytes, as the calldata would carry them.
  const { PublicKey } = await import('@solana/web3.js');
  const hex = new PublicKey(SOL).toBuffer().toString('hex');
  assert.equal(hex.length, 64);
  assert.equal(containsAddress('0xdeadbeef' + hex + 'cafe', SOL), true, 'a Solana pubkey is found by its 32 bytes');
  assert.equal(containsAddress('0xdeadbeef' + '00'.repeat(40), SOL), false);
  assert.equal(containsAddress('0xdeadbeef', 'not-base58-at-all!'), false, 'garbage is never found');
  ok('a Solana recipient is searched for as its 32-byte pubkey');
}

// -- the recipient is DECODED from BridgeData, on two real quotes ---------

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/lifi-bnb-quotes.json', import.meta.url), 'utf8'));
const OURS = FIX.bnb_to_robinhood.toAddress;

{
  const s = decodeBridgeData(FIX.bnb_to_solana.data);
  assert.ok(s, 'the Mayan call decodes');
  assert.equal(s.receiver, NON_EVM_RECEIVER, 'a Solana destination carries the non-EVM sentinel as receiver');
  assert.equal(s.destinationChainId, 1151111081099710n, "and LI.FI's Solana chain id");
  const r = decodeBridgeData(FIX.bnb_to_robinhood.data);
  assert.ok(r, 'the Relay call decodes');
  assert.equal(r.receiver, OURS.toLowerCase(), 'an EVM destination carries our address as receiver');
  assert.equal(r.destinationChainId, 4663n);
  ok('BridgeData.receiver and destinationChainId decode from both real BNB quotes');
}

{
  assert.equal(recipientProblem('solana', FIX.bnb_to_solana.data, FIX.bnb_to_solana.toAddress), null, 'the real Solana quote passes');
  assert.equal(recipientProblem('robinhood', FIX.bnb_to_robinhood.data, OURS), null, 'the real Robinhood quote passes');
  // Wrong destination for the calldata in hand.
  assert.match(recipientProblem('bnb', FIX.bnb_to_robinhood.data, OURS), /addressed to chain 4663/);
  assert.match(recipientProblem('robinhood', FIX.bnb_to_solana.data, OURS), /addressed to chain 1151111081099710/);
  assert.match(recipientProblem('solana', FIX.bnb_to_solana.data, '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce'.replace('2NWQ', '3NWQ')), /does not carry your Solana address/);
  assert.match(recipientProblem('robinhood', FIX.bnb_to_robinhood.data, null), /no wallet/);
  ok('a quote for the wrong chain, or without our address, is refused with the reason');
}

{
  // The attack the byte search could not see: a Relay call names the SENDER
  // as depositorAddress too, so our address is present even when the
  // receiver is a stranger. Swap the receiver word and the search still
  // passes; the decode does not.
  const d = FIX.bnb_to_robinhood.data;
  const body = d.slice(10);
  const base = Number(BigInt('0x' + body.slice(0, 64)) / 32n);
  const at = (base + 5) * 64;
  const stranger = '000000000000000000000000' + 'deadbeef'.repeat(5);
  const tampered = d.slice(0, 10) + body.slice(0, at) + stranger + body.slice(at + 64); // selector kept
  assert.equal(containsAddress(tampered, OURS), true, 'the byte search is fooled by the depositor field');
  assert.match(recipientProblem('robinhood', tampered, OURS), /receiver is 0xdeadbeef/);
  ok('a receiver swapped for a stranger is caught even though our address is still in the calldata');
}

{
  assert.equal(decodeBridgeData('0x'), null);
  assert.equal(decodeBridgeData('0xdeadbeef' + 'ff'.repeat(32)), null, 'a garbage offset is not a struct');
  assert.equal(decodeBridgeData('0xdeadbeef' + '0'.repeat(62) + '20'), null, 'an offset past the end is not a struct');
  assert.match(recipientProblem('robinhood', '0xdeadbeef', OURS), /not a LI.FI bridge call/);
  ok('calldata that is not a LI.FI bridge call is refused, never passed');
}

// -- the Solana deposit carries the money field, and it is READ -----------

{
  const REAL = fs.readFileSync(new URL('./fixtures/lifi-sol-rh-relay.base64.txt', import.meta.url), 'utf8').trim();
  const tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(REAL, 'base64')));
  assert.equal(relayDepositProblem(tx, 'relaydepository', '20000000'), null, '19,950,000 deposited + 50,000 fee = the 0.02 SOL quoted');
  assert.match(relayDepositProblem(tx, 'relaydepository', '20000001'), /moves 20000000 lamports, not the 20000001 quoted/);
  assert.match(relayDepositProblem(tx, 'mayan', '20000000'), /unmeasured bridge/);
  ok('the Relay deposit amount plus the fee transfer must equal the quoted amount exactly');
}

{
  // LI.FI's fee is 0.25 % of the amount (measured at 0.02 and 0.5 SOL). The
  // ceiling is twice that, never a flat number: a flat 0.0005 SOL refused a
  // 0.5 SOL transfer live on 2026-09-11.
  assert.equal(lifiFeeCeilingLamports('20000000'), 150_000, '0.02 SOL: the floor (measured fee 50,000)');
  assert.equal(lifiFeeCeilingLamports('100000000'), 500_000, '0.1 SOL: 0.5 % (measured 250,000)');
  assert.equal(lifiFeeCeilingLamports('500000000'), 2_500_000, '0.5 SOL: 0.5 % (measured 1,250,000)');
  assert.ok(lifiFeeCeilingLamports('500000000') > 1_250_000, 'the measured 0.5 SOL fee is under the ceiling');
  ok('the LI.FI fee ceiling scales with the amount');
}

{
  // The chain's refusal in words. A System-program failure inside Relay's
  // deposit shows up as a bare {"Custom":1}; the runtime's own log line says
  // what it was. Seen live 2026-09-11 (0.5 SOL typed against 0.137 held).
  const logs = [
    'Program 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2 invoke [1]',
    'Program log: Instruction: DepositNative',
    'Program 11111111111111111111111111111111 invoke [2]',
    'Transfer: insufficient lamports 136845273, need 498750000',
    'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
  ];
  const why = chainRefusal({ InstructionError: [4, { Custom: 1 }] }, logs);
  assert.match(why, /holds 0\.136845 SOL and this transfer needs 0\.498750 — more than you hold/);
  assert.match(chainRefusal({ InstructionError: [0, { Custom: 6001 }] }, ['Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.']), /SlippageExceeded \(6001\)/);
  assert.equal(chainRefusal({ InstructionError: [1, 'X'] }, []), '{"InstructionError":[1,"X"]}', 'with no log to read, the raw error');
  ok('a refusal from the chain is said in words when the logs carry them');
}

console.log(`\nbridgeengine: ${passed}/${passed} passed`);
