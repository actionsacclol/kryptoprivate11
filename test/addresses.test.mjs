// PDA / ATA / base58 regression tests. These golden vectors were verified
// byte-for-byte against @solana/web3.js's PublicKey.findProgramAddressSync
// before web3.js was dropped in favor of pure @noble primitives. If a noble
// upgrade changes the ed25519 off-curve check, THIS goes red.

import assert from 'node:assert/strict';
import { base58Decode, base58Encode } from './.b58.mjs';
import { ataFor, bondingCurveFor, bondingCurveV2For, creatorVaultFor, userVolumeAccumulatorFor, globalFor, eventAuthorityFor, globalVolumeAccumulatorFor, feeConfigFor, prewarm, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './.addr2.mjs';

// ── base58 leading-zero correctness (the bug that crashed PDA derivation) ──
{
  const sys = base58Decode('11111111111111111111111111111111');
  assert.equal(sys.length, 32, 'system program decodes to exactly 32 bytes');
  assert.ok(sys.every((b) => b === 0), 'all zero');
  for (const a of [
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    'So11111111111111111111111111111111111111112',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  ]) {
    const d = base58Decode(a);
    assert.equal(d.length, 32, `${a} is 32 bytes`);
    assert.equal(base58Encode(d), a, `${a} round-trips`);
  }
  console.log('ok  base58 leading-zero + round-trip');
}

// ── PDA / ATA golden vectors (== web3.js) ──
{
  const a = prewarm('4vErdRYjZ1o9K7Z5p6D8vN2q3xW1mYbTgHc5uJf9RpXk', '5rc9GLWST1Uy2u4VpChy8kvRcVFqL3sVnB2mDwXe7jQp');
  assert.equal(a.bondingCurve, '2C2B1jcbDZ8k9bPvLNEmtor29CEHDiVXc3WzGhkaTc72');
  assert.equal(a.creatorVault, 'H4pLmv1psp5a1Nc39AL3QMr1Vmorcr4hewB57w3z4H8q');
  assert.equal(a.sharingConfig, 'GEPbjDCxdbPoYQsZtqnoPbprgwg4LfTHDtPThzQkUGhp');
  assert.equal(a.associatedTokenAccount('11111111111111111111111111111111'), 'HKVS69ZrKBsGQyTuMKq44oLx3o5iViyXhJtiToJBMpVM');
  // derived addresses are valid 32-byte pubkeys
  assert.equal(base58Decode(a.bondingCurve).length, 32);
  console.log('ok  PDA/ATA golden vectors match web3.js');
}

// ── The v2 bonding curve + quote-side accounts (2026-08 pump change) ──
//
// `["bonding-curve-v2", mint]` became a REQUIRED account, and the newer
// layouts are quote-mint aware — they carry the curve's WSOL account. Both
// were previously unmodelled, so the template classifier copied another
// mint's values, which the program rejected (InvalidBondingCurveV2 and
// ConstraintSeeds on associated_quote_bonding_curve). These pin the
// derivations that fixed it.
{
  const MINT = '6tMM6beJxNdoHTWvsWQfaocXpJm9gDyw9AJKB8KPpump';
  const WSOL = 'So11111111111111111111111111111111111111112';

  // GOLDEN VECTOR: captured 2026-08-24 from slot 16 of a real successful
  // 18-account buy (disc 66063d1201daebea) on this mint.
  assert.equal(bondingCurveV2For(MINT), '5S4diBPpRfPj4hU7RCKpRpoEPNQeoWdraTRW2g5v5xr1');
  console.log('ok  v2 bonding curve matches an address observed on chain');

  assert.notEqual(bondingCurveV2For(MINT), bondingCurveFor(MINT), 'v1 and v2 curves are different accounts');
  const other = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  assert.notEqual(bondingCurveV2For(MINT), bondingCurveV2For(other), 'v2 curve is per-mint');
  assert.equal(base58Decode(bondingCurveV2For(MINT)).length, 32);
  console.log('ok  v2 bonding curve is per-mint and well-formed');

  // The quote-side account is the curve's WSOL ATA — NOT its token ATA. Using
  // the token mint here is exactly the ConstraintSeeds failure.
  const curve = bondingCurveFor(MINT);
  const quoteAta = ataFor(curve, WSOL, TOKEN_PROGRAM);
  const tokenAta = ataFor(curve, MINT, TOKEN_PROGRAM);
  assert.notEqual(quoteAta, tokenAta, 'quote and base curve ATAs must never collide');
  assert.equal(base58Decode(quoteAta).length, 32);
  assert.equal(ataFor(curve, WSOL, TOKEN_PROGRAM), quoteAta, 'deterministic');
  console.log('ok  curve quote ATA is derived from WSOL, not the token mint');
}

// ── The current buy layout's PDAs (2026-08-29) ──
//
// GOLDEN VECTORS from the inner pump `Buy` of a PumpPortal-built transaction
// that simulated clean (mint HoZRwYVHbehn9F6dujm61qTkaY8j6evnKUowwjx5pump,
// buyer 2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce). The local builder
// now derives the layout from these seeds instead of learning it, so each
// one is pinned to the address the program actually accepted.
{
  const MINT = 'HoZRwYVHbehn9F6dujm61qTkaY8j6evnKUowwjx5pump';
  const USER = '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce';
  const CREATOR = '5TzdhmUZEaqDzpu7CH7d13MPbVjfbT1XroREe8gHjajC';
  assert.equal(globalFor(), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(eventAuthorityFor(), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(globalVolumeAccumulatorFor(), 'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
  assert.equal(feeConfigFor(), '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', 'fee program PDA ["fee_config", PUMP]');
  const curve = bondingCurveFor(MINT);
  assert.equal(curve, 'BdU5z8KvnuEiK4x2VzJpc3S4Ma87kYJcr7oD68mxUMap');
  assert.equal(bondingCurveV2For(MINT), 'CA2oEWbxJQEtPfXRicn9JG9RRdNohE5geAAxBcmb2mpx');
  assert.equal(creatorVaultFor(CREATOR), '2gHwpoGVmVceRrQ6qVAa71kwmTGHbMvrYDGJRZLWGj7P');
  assert.equal(userVolumeAccumulatorFor(USER), '9jvXGXWp5PvpjDVrWxWZDQr9kP3L8S1EGQFjLcKMk4q7');
  // Fresh pump launches are Token-2022 mints: both ATAs derive for that program.
  assert.equal(ataFor(curve, MINT, TOKEN_2022_PROGRAM), 'CMMJJtyLbK1BzBk9yWR1qjPL17hEJa7A1H5jkP6K3MjV');
  assert.equal(ataFor(USER, MINT, TOKEN_2022_PROGRAM), '4SPo6YkB93ydJxgs4JYJ3gZ9jNpBZLHS83Sz4zM1ZD6N');
  assert.notEqual(ataFor(USER, MINT, TOKEN_PROGRAM), ataFor(USER, MINT, TOKEN_2022_PROGRAM), 'a classic-program ATA is a different account');
  console.log('ok  current buy-layout PDAs match the addresses the program accepted');
}

console.log('addresses tests passed');
