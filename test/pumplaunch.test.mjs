// pump.fun `create_v2` — pinned against a launch that really happened.
//
// The Launch page said Solana was "not ready" because two of create_v2's
// sixteen accounts were unidentified. They came out of pump's own on-chain
// Anchor IDL, and this is the check that they are right: derive every account
// and re-encode every argument for a real launch, then require both to match
// what the creator actually submitted.
//
// Two things here were NOT guessable, and are the reason this file exists
// rather than a confident account list written from memory:
//
//   · six of the sixteen accounts belong to pump's MAYHEM program, including
//     `mayhem_token_vault`, which is the ATA of `sol_vault` — a PDA of a
//     different program entirely;
//   · `OptionBool` is a struct with one bool, not an Anchor Option, and the
//     real instruction carries eight further bytes the IDL does not describe.
//
// Either mistake makes a transaction that fails, or lands and does something
// other than what was asked.

import assert from 'node:assert';
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { createV2Accounts, createV2Data, CREATE_V2_DISCRIMINATOR, bondingCurveOf, mayhemStateOf, solVault } from './.pumplaunch.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

/**
 * Captured from chain by a script that refused to write unless our builder
 * already reproduced it — so these are the bytes Solana accepted, not a
 * transcription of them.
 */
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-create.json', import.meta.url), 'utf8'));
const MINT = new PublicKey(FIX.mint);
const CREATOR = new PublicKey(FIX.creator);

{
  const ours = createV2Accounts(MINT, CREATOR).map((a) => a.pubkey.toBase58());
  assert.equal(ours.length, 16, 'create_v2 takes sixteen accounts');
  assert.deepEqual(ours, FIX.accounts, 'every account, in order, matches the real launch');
  ok('all sixteen accounts derive to exactly what the real launch used');
}

{
  // Anchor matches accounts by POSITION. A list that is right but reordered is
  // a different instruction, so the order is asserted above and the two
  // signers are asserted here.
  const metas = createV2Accounts(MINT, CREATOR);
  assert.equal(metas[0].isSigner, true, 'the new mint signs for itself');
  assert.equal(metas[0].pubkey.toBase58(), FIX.mint);
  assert.equal(metas[5].isSigner, true, 'and so does the creator');
  assert.equal(metas[5].pubkey.toBase58(), FIX.creator);
  assert.equal(metas.filter((m) => m.isSigner).length, 2, 'exactly two signers — the launch rule depends on it');
  ok('the mint and the creator sign, and nothing else does');
}

{
  const args = { ...FIX.args, creator: new PublicKey(FIX.args.creator) };
  const data = createV2Data(args);
  assert.equal(data.toString('hex'), FIX.data, 'instruction data matches byte for byte');
  assert.equal(data.subarray(0, 8).toString('hex'), CREATE_V2_DISCRIMINATOR.toString('hex'));
  ok('the argument encoding reproduces the real instruction data exactly');
}

{
  // The 09-10 "undocumented tail" is creator_fee_bps (IDL, read 09-25): an
  // OptionU64, sent as 0 on every observed launch.
  const data = createV2Data({ ...FIX.args, creator: new PublicKey(FIX.args.creator) });
  assert.deepEqual([...data.subarray(-8)], [0, 0, 0, 0, 0, 0, 0, 0], 'creator_fee_bps is sent as 0, as every observed launch sends');
  ok('creator_fee_bps (the old "undocumented" eight bytes) is sent as zero, as observed');
}

{
  // HOLDER REWARDS (2026-09-12): the current 11-byte form, reproduced byte for
  // byte from a real successful launch that turned holder rewards on.
  const HR = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-create-holder.json', import.meta.url), 'utf8'));
  const args = { ...HR.args, creator: new PublicKey(HR.args.creator) };
  const data = createV2Data(args);
  assert.equal(data.toString('hex'), HR.data, 'a holder-rewards create matches the real one byte for byte');
  assert.equal(data[data.length - 1], 1, 'is_holder_reward is the last byte, and it is 1');
  assert.equal(createV2Data({ ...args, holderReward: false })[data.length - 1], 0, 'off is an explicit 0 in the current form');
  assert.equal(createV2Data({ ...args, holderReward: null }).length, data.length - 1, 'null keeps the older form without the byte');
  assert.equal(HR.accounts.length, 16, 'same sixteen accounts');
  assert.equal(HR.accounts[11], solVault().toBase58(), 'same mayhem sol_vault in slot 11');
  ok('holder rewards: the current create form reproduces a real launch exactly');
}

{
  // The two accounts that were unidentified until the IDL named them.
  const vault = solVault();
  assert.equal(FIX.accounts[11], vault.toBase58(), 'slot 11 is the mayhem sol_vault');
  assert.equal(FIX.accounts[12], mayhemStateOf(MINT).toBase58(), 'slot 12 is this mint’s mayhem_state');
  assert.equal(FIX.accounts[2], bondingCurveOf(MINT).toBase58(), 'slot 2 is the bonding curve');
  ok('the mayhem accounts that blocked this for a day derive correctly');
}

{
  // Changing an argument must change the bytes — otherwise the test above
  // could pass against a builder that ignores its inputs.
  const base = { ...FIX.args, creator: new PublicKey(FIX.args.creator) };
  assert.notEqual(createV2Data({ ...base, name: 'Something Else' }).toString('hex'), FIX.data);
  assert.notEqual(createV2Data({ ...base, mayhem: !base.mayhem }).toString('hex'), FIX.data);
  ok('the encoder actually reads its arguments');
}

console.log(`\npumplaunch: ${passed}/${passed} passed`);
