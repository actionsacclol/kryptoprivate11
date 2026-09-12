// Collecting creator fees — the accounts, and the rule that guards them.
//
// Everything here came out of pump's own on-chain Anchor IDL on 2026-09-11,
// not out of memory: the discriminator, the five accounts, their order, and
// the fact that `creator` is NOT a required signer. That last one is why a
// claim is an ordinary one-signature transaction and never touches the launch
// intent — and why the signer's rule below is about who gets PAID rather than
// who signs, because pump lets anybody crank a collection.

import assert from 'node:assert';
import { PublicKey } from '@solana/web3.js';
import {
  COLLECT_CREATOR_FEE_DISCRIMINATOR,
  COLLECT_CREATOR_FEE_V2_DISCRIMINATOR,
  collectAccounts,
  collectInstruction,
  creatorVaultOf,
} from './.pumpfees.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATOR = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');

{
  assert.equal(COLLECT_CREATOR_FEE_DISCRIMINATOR.toString('hex'), '1416567bc61cdb84', 'sha256("global:collect_creator_fee")[0..8]');
  assert.equal(COLLECT_CREATOR_FEE_V2_DISCRIMINATOR.toString('hex'), 'cf118af204221338');
  ok('the discriminators are the ones pump publishes in its IDL');
}

{
  // The vault is seeded by the CREATOR, with no mint anywhere in it. That is
  // the whole reason one claim collects every coin a wallet ever launched,
  // and why this module needs no token list.
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), CREATOR.toBuffer()],
    new PublicKey(PUMP),
  );
  assert.equal(creatorVaultOf(CREATOR).toBase58(), expected.toBase58());

  const other = new PublicKey('So11111111111111111111111111111111111111112');
  assert.notEqual(creatorVaultOf(other).toBase58(), creatorVaultOf(CREATOR).toBase58(), 'a different creator is a different vault');
  ok('the vault is per creator, not per token — one claim covers every coin');
}

{
  const keys = collectAccounts(CREATOR);
  assert.equal(keys.length, 5, 'collect_creator_fee takes five accounts');
  // Anchor matches by POSITION, so the order is the assertion.
  assert.equal(keys[0].pubkey.toBase58(), CREATOR.toBase58(), '0 creator');
  assert.equal(keys[1].pubkey.toBase58(), creatorVaultOf(CREATOR).toBase58(), '1 creator_vault');
  assert.equal(keys[2].pubkey.toBase58(), '11111111111111111111111111111111', '2 system_program');
  assert.equal(keys[4].pubkey.toBase58(), PUMP, '4 program');
  ok('all five accounts derive in the order the IDL gives them');
}

{
  // `creator` is writable and NOT a signer — pump lets anyone crank a
  // collection, and the lamports go to the creator regardless. If this ever
  // flips, the transaction shape changes and this test is where it surfaces.
  const keys = collectAccounts(CREATOR);
  assert.equal(keys.filter((k) => k.isSigner).length, 0, 'the instruction itself requires no signer');
  assert.equal(keys[0].isWritable, true, 'but the creator is paid, so it is writable');
  assert.equal(keys[1].isWritable, true, 'and the vault is debited');
  ok('no account signs, which is why a claim stays a one-signature transaction');
}

{
  // No arguments at all: the data IS the discriminator, eight bytes, nothing
  // more. An amount appearing here would mean pump changed the instruction.
  const ix = collectInstruction(CREATOR);
  assert.equal(ix.programId.toBase58(), PUMP);
  assert.equal(ix.data.length, 8, 'collect_creator_fee takes no arguments');
  assert.equal(ix.data.toString('hex'), '1416567bc61cdb84');
  ok('the instruction is a bare discriminator — pump takes no arguments here');
}

console.log(`\npumpfees: ${passed}/${passed} passed`);
