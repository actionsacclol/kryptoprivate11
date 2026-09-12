// Signer outflow policy — the gate that decides whether our SOL is allowed to
// move. Before 2026-08-16 the signer checked only fee payer + signature count,
// so anything that could hand it a transaction could empty the wallet.
//
// These build real VersionedTransactions and assert the policy accepts exactly
// the legitimate shapes and refuses everything else. A regression here is a
// drained wallet, not a failed test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import {
  checkOutflowForTest as check,
  KNOWN_TRADE_PROGRAMS,
  unknownTopLevelPrograms,
} from './.signpolicy.mjs';
import { VersionedTransaction as VT } from '@solana/web3.js';

/** The gate, over serialized bytes — what the callers actually hold. */
const unknownPrograms = (bytes) => unknownTopLevelPrograms(VT.deserialize(bytes), KNOWN_TRADE_PROGRAMS);

const BLOCKHASH = '11111111111111111111111111111111';
const me = Keypair.generate();
const MY_PUB = me.publicKey.toBase58();
const HOME = Keypair.generate().publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();
// A real Jito tip account from tipAccounts.ts.
const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const SWEEP = (max) => ({ intent: 'sweep', maxTransferLamports: max });
const TRADE = (max) => ({ intent: 'trade', maxTransferLamports: max });

function tx(instructions, payer = me.publicKey) {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

const transfer = (to, lamports) =>
  SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: new PublicKey(to), lamports });

// ── Sweeps ───────────────────────────────────────────────────────────────

{
  const r = check(tx([transfer(HOME, 1_000_000)]), MY_PUB, HOME, SWEEP(1_000_000));
  assert.equal(r.ok, true, r.message);
  console.log('ok  sweep to the stored withdrawal address is allowed');
}

// THE DRAIN. A caller asks to sweep, but the destination is not the stored
// home address. The old signer signed this without looking.
{
  const r = check(tx([transfer(ATTACKER, 1_000_000)]), MY_PUB, HOME, SWEEP(1_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /withdrawal address|refusing/i);
  console.log('ok  sweep to an address that is not homeAddress is REFUSED');
}

{
  const r = check(tx([transfer(HOME, 5_000_000)]), MY_PUB, HOME, SWEEP(1_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /cap/i);
  console.log('ok  sweep over the lamport cap is REFUSED');
}

// A "sweep" that smuggles a second transfer alongside the legitimate one.
{
  const r = check(
    tx([transfer(HOME, 1_000), transfer(ATTACKER, 900_000_000)]),
    MY_PUB, HOME, SWEEP(1_000_000_000),
  );
  assert.equal(r.ok, false);
  console.log('ok  multi-instruction "sweep" is REFUSED');
}

{
  const r = check(tx([transfer(HOME, 1_000)]), MY_PUB, null, SWEEP(1_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /withdrawal address/i);
  console.log('ok  sweep with no withdrawal address set is REFUSED');
}

// ── Trades ───────────────────────────────────────────────────────────────

// The normal shape: compute budget + a program instruction + a tip.
{
  const r = check(
    tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [], data: Buffer.from([1, 2, 3]) }),
      transfer(JITO_TIP, 100_000),
    ]),
    MY_PUB, HOME, TRADE(10_000_000),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  trade with a tip to a known tip account is allowed');
}

// The trade-path drain: a relayer-built tx that pays an attacker.
{
  const r = check(
    tx([
      new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [], data: Buffer.from([1]) }),
      transfer(ATTACKER, 50_000),
    ]),
    MY_PUB, HOME, TRADE(10_000_000),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /tip account|refusing/i);
  console.log('ok  trade transferring to an unknown address is REFUSED');
}

{
  const r = check(tx([transfer(JITO_TIP, 50_000_000)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /cap/i);
  console.log('ok  oversized tip is REFUSED (a tip cannot drain the wallet)');
}

// A trade with no bare transfers at all — SOL moves via CPI inside the program.
{
  const r = check(
    tx([new TransactionInstruction({ programId: PUMP_PROGRAM, keys: [], data: Buffer.from([9]) })]),
    MY_PUB, HOME, TRADE(0),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  trade with no top-level transfer passes a zero cap');
}

// ── Lamport-moving SystemProgram instructions we do not parse ─────────────

// Built raw, with the new account NOT marked as a signer — a hostile builder
// would do exactly this to keep numRequiredSignatures at 1 and slip past the
// cheap checks. The instruction must be refused on its own merits.
function rawSystemIx(discriminant, extraBytes, dest) {
  const data = Buffer.alloc(4 + extraBytes);
  data.writeUInt32LE(discriminant, 0);
  return new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: me.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(dest), isSigner: false, isWritable: true },
    ],
    data,
  });
}

{
  // createAccount: lamports + space + owner. Drains via rent to a new account.
  const r = check(tx([rawSystemIx(0, 8 + 8 + 32, ATTACKER)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /moves lamports/i);
  console.log('ok  SystemProgram.createAccount (drains via rent) is REFUSED');
}

{
  // transferWithSeed — moves lamports by a path this rule does not parse.
  const r = check(tx([rawSystemIx(11, 8 + 8 + 32, ATTACKER)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /moves lamports/i);
  console.log('ok  SystemProgram.transferWithSeed is REFUSED');
}

{
  // allocate (8) — moves nothing, but our builders never emit it: fail closed.
  const r = check(tx([rawSystemIx(8, 8, ATTACKER)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /Unexpected SystemProgram/i);
  console.log('ok  unexpected SystemProgram instruction fails closed');
}

{
  // A transfer whose data is truncated must not be parsed optimistically.
  const short = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: me.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(JITO_TIP), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([2, 0, 0, 0, 1, 2]), // Transfer, but only 2 of 8 lamport bytes
  });
  const r = check(tx([short]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /Malformed/i);
  console.log('ok  truncated transfer data is REFUSED');
}

// ── Fee payer ────────────────────────────────────────────────────────────

{
  const other = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: other.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: new PublicKey(HOME), lamports: 1 })],
  }).compileToV0Message();
  const r = check(new VersionedTransaction(msg).serialize(), MY_PUB, HOME, SWEEP(1_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /fee payer/i);
  console.log('ok  transaction we do not pay for is REFUSED');
}

// ── Platform fee allowance ───────────────────────────────────────────────
//
// The fee widens this policy, so it gets the same hostile treatment as
// everything else: each recipient is named, each has its own ceiling, and the
// tip cap must not move a lamport because of it.

const TREASURY = Keypair.generate().publicKey.toBase58();
const REFERRER = Keypair.generate().publicKey.toBase58();
const FEE = (max, allowance) => ({ intent: 'trade', maxTransferLamports: max, feeAllowance: allowance });

{
  const r = check(
    tx([transfer(TREASURY, 2_400_000), transfer(REFERRER, 600_000)]),
    MY_PUB, HOME,
    FEE(0, [{ address: TREASURY, maxLamports: 2_400_000 }, { address: REFERRER, maxLamports: 600_000 }]),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  fee + referral transfers within their ceilings are allowed');
}

{
  const r = check(
    tx([transfer(TREASURY, 2_400_001)]),
    MY_PUB, HOME,
    FEE(0, [{ address: TREASURY, maxLamports: 2_400_000 }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /over the|refusing/i);
  console.log('ok  a fee transfer ONE lamport over its ceiling is REFUSED');
}

// The obvious way to game a per-address ceiling.
{
  const r = check(
    tx([transfer(TREASURY, 2_000_000), transfer(TREASURY, 2_000_000)]),
    MY_PUB, HOME,
    FEE(0, [{ address: TREASURY, maxLamports: 2_400_000 }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /over the/i);
  console.log('ok  two transfers to the SAME fee address are summed, not judged separately');
}

// The reason feeAllowance is separate from maxTransferLamports.
{
  const r = check(
    tx([transfer(TREASURY, 2_400_000), transfer(JITO_TIP, 500_000)]),
    MY_PUB, HOME,
    FEE(100_000, [{ address: TREASURY, maxLamports: 2_400_000 }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /cap/i);
  console.log('ok  a fee allowance does NOT raise the tip cap');
}

{
  const r = check(
    tx([transfer(ATTACKER, 1_000)]),
    MY_PUB, HOME,
    FEE(0, [{ address: TREASURY, maxLamports: 2_400_000 }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /neither your withdrawal address nor a known tip account/i);
  console.log('ok  an address NOT in the allowance is still REFUSED');
}

// A build with no treasury configured must not become permissive.
{
  const r = check(tx([transfer(TREASURY, 1_000)]), MY_PUB, HOME, TRADE(1_000_000));
  assert.equal(r.ok, false);
  console.log('ok  with no allowance present, a fee transfer is REFUSED like any stranger');
}

// A sweep is not a trade; the fee rule must not leak into it.
{
  const r = check(
    tx([transfer(TREASURY, 1_000)]),
    MY_PUB, HOME,
    { intent: 'sweep', maxTransferLamports: 1_000_000, feeAllowance: [{ address: TREASURY, maxLamports: 1_000_000 }] },
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /withdrawal address|refusing/i);
  console.log('ok  feeAllowance is ignored for a sweep');
}

// ── Anti-tamper: required fee (buys only) ─────────────────────────────
//
// The interlock: a cracked build that strips the fee cannot open a position,
// but a legit user is never blocked from closing one. Buys carry
// requireFeeTransfer; sells must not.

const FEEREQ = (allowance, req) => ({ intent: 'trade', maxTransferLamports: 0, feeAllowance: allowance, requireFeeTransfer: req });

{
  // A billable BUY that includes the required fee: allowed.
  const r = check(
    tx([transfer(TREASURY, 4_000_000)]),
    MY_PUB, HOME,
    FEEREQ([{ address: TREASURY, maxLamports: 4_000_000 }], { address: TREASURY, minLamports: 4_000_000 }),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a buy WITH the required fee is allowed');
}

{
  // The attack: a build that stripped the fee. The buy has NO SOL transfer at
  // all — just a compute-budget instruction and (in reality) the trade ix.
  const noFee = tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })]);
  const r = check(
    noFee,
    MY_PUB, HOME,
    FEEREQ([{ address: TREASURY, maxLamports: 4_000_000 }], { address: TREASURY, minLamports: 4_000_000 }),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /modified|missing/i);
  console.log('ok  a buy with the fee STRIPPED is REFUSED (the interlock)');
}

{
  // A shaved fee — present but below the required floor — is also refused.
  const r = check(
    tx([transfer(TREASURY, 1_000)]),
    MY_PUB, HOME,
    FEEREQ([{ address: TREASURY, maxLamports: 4_000_000 }], { address: TREASURY, minLamports: 4_000_000 }),
  );
  assert.equal(r.ok, false);
  console.log('ok  a buy with a SHAVED fee (below the floor) is REFUSED');
}

{
  // The safety property: a SELL never carries requireFeeTransfer, so a sell
  // with no fee is fine — a user can always exit.
  const r = check(
    tx([transfer(JITO_TIP, 1)]),
    MY_PUB, HOME,
    { intent: 'trade', maxTransferLamports: 10_000_000 },
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a SELL with no fee is allowed — exits are never blocked');
}

// ── SPL Token instructions (2026-08-28 audit, HIGH) ─────────────────────
//
// The old rule inspected SystemProgram only. A compromised relayer could
// append a Token `Approve` (delegating our ATA), a `Transfer` of another
// token we hold, `SetAuthority`, or `CloseAccount` to a stranger, and every
// gate passed. Every one of those is pinned here, built from raw bytes the
// way a hostile builder would emit them.

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const MINT = Keypair.generate().publicKey; // the token being traded
const OTHER_MINT = Keypair.generate().publicKey; // something else we hold
const POOL = Keypair.generate().publicKey;
const ATTACKER_PK = new PublicKey(ATTACKER);

const ata = (owner, mint, prog = TOKEN) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA_PROG)[0];
const MY_ATA = ata(me.publicKey, MINT);
const MY_ATA_2022 = ata(me.publicKey, MINT, TOKEN_2022);
const MY_OTHER_ATA = ata(me.publicKey, OTHER_MINT);
const MY_WSOL_ATA = ata(me.publicKey, WSOL);
const POOL_ATA = ata(POOL, MINT);

const BUY = (extra = {}) => ({ intent: 'trade', maxTransferLamports: 10_000_000, trade: { side: 'buy', mint: MINT.toBase58() }, ...extra });
const SELL = (extra = {}) => ({ intent: 'trade', maxTransferLamports: 10_000_000, trade: { side: 'sell', mint: MINT.toBase58() }, ...extra });

const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const tokIx = (keys, data, programId = TOKEN) => new TransactionInstruction({ programId, keys, data: Buffer.from(data) });

// Raw SPL Token instruction builders (discriminator byte + payload).
const approve = (account, delegate, amount = 1n << 63n, prog = TOKEN) =>
  tokIx([w(account), ro(delegate), ro(me.publicKey, true)], Buffer.concat([Buffer.from([4]), u64(amount)]), prog);
const approveChecked = (account, mint, delegate) =>
  tokIx([w(account), ro(mint), ro(delegate), ro(me.publicKey, true)], Buffer.concat([Buffer.from([13]), u64(1), Buffer.from([6])]));
const revoke = (account) => tokIx([w(account), ro(me.publicKey, true)], [5]);
const setAuthority = (account, newAuth) =>
  tokIx([w(account), ro(me.publicKey, true)], Buffer.concat([Buffer.from([6, 2, 1]), newAuth.toBuffer()]));
const burn = (account, mint, amount = 1) =>
  tokIx([w(account), w(mint), ro(me.publicKey, true)], Buffer.concat([Buffer.from([8]), u64(amount)]));
const burnChecked = (account, mint) =>
  tokIx([w(account), w(mint), ro(me.publicKey, true)], Buffer.concat([Buffer.from([15]), u64(1), Buffer.from([6])]));
const closeAccount = (account, dest, prog = TOKEN) => tokIx([w(account), w(dest), ro(me.publicKey, true)], [9], prog);
const tokTransfer = (source, dest, amount = 1, prog = TOKEN) =>
  tokIx([w(source), w(dest), ro(me.publicKey, true)], Buffer.concat([Buffer.from([3]), u64(amount)]), prog);
const tokTransferChecked = (source, mint, dest) =>
  tokIx([w(source), ro(mint), w(dest), ro(me.publicKey, true)], Buffer.concat([Buffer.from([12]), u64(1), Buffer.from([6])]));
const syncNative = (account) => tokIx([w(account)], [17]);
const withdrawExcess = (account) => tokIx([w(account), w(ATTACKER_PK), ro(me.publicKey, true)], [38], TOKEN_2022);
const createAtaIdempotent = (ataAddr, owner, mint) =>
  new TransactionInstruction({
    programId: ATA_PROG,
    keys: [w(me.publicKey, true), w(ataAddr), ro(owner), ro(mint), ro(SystemProgram.programId), ro(TOKEN)],
    data: Buffer.from([1]),
  });
const pumpIx = (keys = []) => new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data: Buffer.from([0x66, 0x06, 0x3d, 0x12]) });

// ── Positive: the real shapes still pass ──
{
  // Pump buy: compute budget, create ATA, pump buy, fee, tip.
  const r = check(
    tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAtaIdempotent(MY_ATA, me.publicKey, MINT),
      pumpIx([w(MY_ATA), w(me.publicKey, true), ro(MINT)]),
      transfer(TREASURY, 50_000),
      transfer(JITO_TIP, 100_000),
    ]),
    MY_PUB, HOME, BUY({ feeAllowance: [{ address: TREASURY, maxLamports: 50_000 }] }),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a normal pump BUY (ATA create + pump ix + fee + tip) still passes');
}

{
  // Pump sell: pump sell ix, close the emptied ATA back to ourselves, tip.
  const r = check(
    tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      pumpIx([w(MY_ATA), w(me.publicKey, true), ro(MINT)]),
      closeAccount(MY_ATA, me.publicKey),
      transfer(JITO_TIP, 100_000),
    ]),
    MY_PUB, HOME, SELL(),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a normal pump SELL (pump ix + ATA close to self + tip) still passes');
}

{
  // Pump-amm swap: WSOL wrap (create + SOL transfer to own WSOL ATA +
  // syncNative), swap, unwrap by closing WSOL ATA to self, tip.
  const swap = new TransactionInstruction({
    programId: PUMP_AMM,
    keys: [w(me.publicKey, true), w(MY_ATA), w(MY_WSOL_ATA), w(POOL)],
    data: Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]),
  });
  const r = check(
    tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAtaIdempotent(MY_WSOL_ATA, me.publicKey, WSOL),
      SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: MY_WSOL_ATA, lamports: 500_000_000 }),
      syncNative(MY_WSOL_ATA),
      createAtaIdempotent(MY_ATA, me.publicKey, MINT),
      swap,
      closeAccount(MY_WSOL_ATA, me.publicKey),
      transfer(JITO_TIP, 100_000),
    ]),
    MY_PUB, HOME, BUY(),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a pump-amm swap (WSOL wrap 0.5 SOL / unwrap / close to self) still passes');
}

{
  // A Token-2022 mint: the same shapes under the other program.
  const r = check(
    tx([pumpIx([w(MY_ATA_2022)]), closeAccount(MY_ATA_2022, me.publicKey, TOKEN_2022), revoke(MY_ATA_2022)]),
    MY_PUB, HOME, SELL(),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  Token-2022 close-to-self and Revoke pass');
}

{
  // A sell that pushes the traded mint into the pool at top level is expected —
  // alongside the venue instruction that names the pool account, which is what
  // a real exit always carries.
  const r = check(
    tx([pumpIx([w(POOL_ATA)]), tokTransfer(MY_ATA, POOL_ATA, 1000), tokTransferChecked(MY_ATA, MINT, POOL_ATA)]),
    MY_PUB, HOME, SELL(),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a SELL transferring the traded mint into the venue is allowed');
}

{
  // WHERE the tokens go used to be decoded and never checked, so a sell could
  // hand the whole bag to any address at all. A destination no venue in the
  // transaction touches is not an exit.
  const r = check(tx([pumpIx([w(POOL_ATA)]), tokTransfer(MY_ATA, ata(ATTACKER_PK, MINT), 1000)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /no trade program in this transaction touches/);

  // And the venue instruction has to be a VENUE: the Token program is on
  // KNOWN_TRADE_PROGRAMS too, so a Transfer must not vouch for itself.
  const r2 = check(tx([tokTransfer(MY_ATA, ata(ATTACKER_PK, MINT), 1000)]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, false, 'a lone Transfer cannot be its own evidence of a swap');

  console.log('ok  a SELL cannot send the traded mint somewhere no venue touches');
}

{
  // MintTo and FreezeAccount were waved through as "needs an authority that
  // is not us" — but a top-level Token instruction's authority must SIGN, and
  // a second signer is already refused. So the only reachable version is the
  // one where WE are the authority: minting supply, or freezing our own bag
  // so it cannot be sold.
  const mintTo = tokIx([w(MINT), w(MY_ATA), ro(me.publicKey, true)], Buffer.concat([Buffer.from([7]), u64(1_000_000)]));
  const r = check(tx([pumpIx(), mintTo]), MY_PUB, HOME, BUY());
  assert.equal(r.ok, false);
  assert.match(r.message, /MintTo creates supply/);

  const freeze = tokIx([w(MY_ATA), ro(MINT), ro(me.publicKey, true)], [10]);
  const r2 = check(tx([pumpIx(), freeze]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, false);
  assert.match(r2.message, /unsellable/);

  // Thaw stays allowed: on a default-frozen mint whose freeze authority is
  // ours, thawing is what makes the sell possible.
  const thaw = tokIx([w(MY_ATA), ro(MINT), ro(me.publicKey, true)], [11]);
  assert.equal(check(tx([pumpIx(), thaw]), MY_PUB, HOME, SELL()).ok, true, 'a thaw must not block an exit');

  console.log('ok  MintTo and FreezeAccount are refused; ThawAccount still signs');
}

{
  // Raydium CLMM / Orca Whirlpool / Meteora DLMM are on the allowlist because
  // Jupiter routes THROUGH them. A top-level call is not a route — it is the
  // shape an LP deposit takes, and an allowlisted program is otherwise never
  // inspected. Measured 0 of 25 real routes at top level.
  const WHIRLPOOL = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  const direct = new TransactionInstruction({ programId: WHIRLPOOL, keys: [w(MY_ATA)], data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) });

  const buy = check(tx([direct]), MY_PUB, HOME, BUY());
  assert.equal(buy.ok, false, 'a buy calling a routing venue directly is refused');
  assert.match(buy.message, /only ever calls through a router/);

  // But never on a sell: the measurement says it will not happen, and a limit
  // never blocks an exit on a probability.
  const sell = check(tx([direct]), MY_PUB, HOME, SELL());
  assert.equal(sell.ok, true, 'a sell is never blocked by this rule');
  assert.match(sell.message, /WARNING/, 'it is reported instead');

  console.log('ok  routing venues cannot be called directly on a buy, and never block a sell');
}

// ── The launch exception ──
//
// A launchpad create is the one legitimate transaction that cannot satisfy
// "exactly one signer", because the new mint signs for itself. The exception
// is deliberately narrow, and the FIRST test here is the one that matters
// most: with the launcher off, nothing changes at all.

const MINT_KP = Keypair.generate();
const LAUNCH_MINT = MINT_KP.publicKey.toBase58();
const LAUNCH = (extra = {}) => ({ intent: 'launch', maxTransferLamports: 10_000_000, launchMint: LAUNCH_MINT, ...extra });

// Two signers: us (fee payer) and the new mint.
function launchTx(instructions, secondSigner = MINT_KP.publicKey) {
  const msg = new TransactionMessage({
    payerKey: me.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      // The create names the mint as a SIGNER — this is what makes the
      // transaction two-signer in the first place.
      new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [{ pubkey: secondSigner, isSigner: true, isWritable: true }, w(MY_ATA)],
        data: Buffer.from([0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4]),
      }),
      ...instructions,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

{
  // THE test. A user who never turns the launcher on cannot construct the
  // launch intent, so a create is refused exactly as it was before any of
  // this existed — on the signer count, by the original rule.
  const r = check(launchTx([]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /needs 2 signers/);
  console.log('ok  with the launcher OFF, a create is refused exactly as before');
}

{
  const r = check(launchTx([]), MY_PUB, HOME, LAUNCH());
  assert.equal(r.ok, true, r.message);
  console.log('ok  a launch naming its own mint as the second signer passes');
}

{
  // The whole point: the second signer must be OUR ephemeral mint, not merely
  // "some other key". A stranger co-signer is the attack this guards.
  const stranger = Keypair.generate().publicKey;
  const r = check(launchTx([], stranger), MY_PUB, HOME, LAUNCH());
  assert.equal(r.ok, false);
  assert.match(r.message, /not the mint this launch created/);
  console.log('ok  a second signer that is not the generated mint is refused');
}

{
  // A launch with no mint named is not a launch, whatever its intent says.
  const r = check(launchTx([]), MY_PUB, HOME, { intent: 'launch', maxTransferLamports: 10_000_000 });
  assert.equal(r.ok, false);
  assert.match(r.message, /must name the mint/);
  console.log('ok  the launch intent without a named mint is refused');
}

{
  // A launch may only call a launchpad. The trade allowlist does NOT apply —
  // that list waves programs through without inspection, and a two-signer
  // transaction must never inherit it.
  const jupiter = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const r = check(
    launchTx([new TransactionInstruction({ programId: jupiter, keys: [w(MY_ATA)], data: Buffer.from([1, 2, 3, 4]) })]),
    MY_PUB, HOME, LAUNCH(),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /may only call a launchpad/);
  console.log('ok  a launch cannot ride alongside a non-launchpad program');
}

// ── Rejections ──
{
  for (const side of [BUY, SELL]) {
    const r = check(tx([pumpIx(), approve(MY_ATA, ATTACKER_PK)]), MY_PUB, HOME, side());
    assert.equal(r.ok, false);
    assert.match(r.message, /Approve delegates/);
    assert.ok(r.message.includes(MY_ATA.toBase58().slice(0, 8)) && r.message.includes(ATTACKER.slice(0, 8)), r.message);
  }
  const r2 = check(tx([approve(MY_OTHER_ATA, ATTACKER_PK, 1n, TOKEN_2022)]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, false);
  const r3 = check(tx([approveChecked(MY_ATA, MINT, ATTACKER_PK)]), MY_PUB, HOME, SELL());
  assert.equal(r3.ok, false);
  assert.match(r3.message, /Approve delegates/);
  console.log('ok  Token Approve / ApproveChecked (delegating our ATA) is REFUSED on buy and sell, both programs');
}

{
  const r = check(tx([pumpIx(), setAuthority(MY_ATA, ATTACKER_PK)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /SetAuthority/);
  console.log('ok  Token SetAuthority is REFUSED');
}

{
  const r = check(tx([pumpIx(), closeAccount(MY_ATA, ATTACKER_PK)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /CloseAccount.*not to this wallet/);
  const r2 = check(tx([closeAccount(MY_WSOL_ATA, ATTACKER_PK)]), MY_PUB, HOME, BUY());
  assert.equal(r2.ok, false);
  console.log('ok  CloseAccount with a foreign destination is REFUSED (token ATA and WSOL ATA)');
}

{
  // A buy moves no token of ours out — not even the traded one.
  const r = check(tx([pumpIx(), tokTransfer(MY_OTHER_ATA, ata(ATTACKER_PK, OTHER_MINT))]), MY_PUB, HOME, BUY());
  assert.equal(r.ok, false);
  assert.match(r.message, /Transfer moves tokens out of your account/);
  const r2 = check(tx([tokTransfer(MY_ATA, POOL_ATA)]), MY_PUB, HOME, BUY());
  assert.equal(r2.ok, false);
  console.log('ok  Token Transfer out of our account on a BUY is REFUSED');
}

{
  // A sell may move the traded mint, but a transfer of ANOTHER token riding
  // along is a drain, not an exit.
  const r = check(tx([pumpIx(), tokTransfer(MY_OTHER_ATA, ata(ATTACKER_PK, OTHER_MINT), 1_000_000)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /other than the one being sold/);
  const r2 = check(tx([tokTransferChecked(MY_OTHER_ATA, OTHER_MINT, ata(ATTACKER_PK, OTHER_MINT))]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, false);
  // Even from the WSOL account.
  const r3 = check(tx([tokTransfer(MY_WSOL_ATA, ata(ATTACKER_PK, WSOL))]), MY_PUB, HOME, SELL());
  assert.equal(r3.ok, false);
  console.log('ok  Token Transfer / TransferChecked of a DIFFERENT held token on a SELL is REFUSED');
}

{
  // Spoofed authority slot (a non-signer named as authority): the source is
  // recognisably ours, so it is refused on the source alone. (An ATA of a
  // mint the policy cannot derive is not recognised this way — but that
  // instruction fails on chain, since the named authority never signs.)
  const spoofed = tokIx([w(MY_ATA), w(POOL_ATA), ro(ATTACKER_PK)], Buffer.concat([Buffer.from([3]), u64(1)]));
  const r = check(tx([spoofed]), MY_PUB, HOME, BUY());
  assert.equal(r.ok, false);
  assert.match(r.message, /Transfer moves tokens out of your account/);
  const spoofedWsol = tokIx([w(MY_WSOL_ATA), w(ata(ATTACKER_PK, WSOL)), ro(ATTACKER_PK)], Buffer.concat([Buffer.from([3]), u64(1)]));
  assert.equal(check(tx([spoofedWsol]), MY_PUB, HOME, SELL()).ok, false);
  console.log('ok  Transfer from our ATA with a spoofed authority slot is REFUSED');
}

{
  const r = check(tx([pumpIx(), burn(MY_OTHER_ATA, OTHER_MINT, 5)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /Burn destroys/);
  const r2 = check(tx([burnChecked(MY_OTHER_ATA, OTHER_MINT)]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, false);
  const r3 = check(tx([burn(MY_ATA, MINT)]), MY_PUB, HOME, BUY());
  assert.equal(r3.ok, false, 'a buy never burns');
  console.log('ok  Burn / BurnChecked of another mint (or anything on a buy) is REFUSED');
}

{
  const r = check(tx([withdrawExcess(MY_ATA_2022)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /WithdrawExcessLamports/);
  console.log('ok  Token-2022 WithdrawExcessLamports is REFUSED');
}

{
  // No trade context at all (legacy caller): the safe default is "no token
  // of ours moves", so a transfer out is refused even without a side.
  const r = check(tx([tokTransfer(MY_ATA, POOL_ATA)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  const r2 = check(tx([pumpIx(), closeAccount(MY_ATA, me.publicKey)]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r2.ok, true, r2.message);
  console.log('ok  without trade context, token transfers out are refused; close-to-self still fine');
}

{
  // An unknown program handed one of our token accounts writable — the
  // no-Token-instruction drain. Read-only is fine; our ATA writable is not.
  const STRANGER = Keypair.generate().publicKey;
  const evil = new TransactionInstruction({ programId: STRANGER, keys: [w(me.publicKey, true), w(MY_ATA)], data: Buffer.from([1]) });
  const r = check(tx([pumpIx(), evil]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown program .* writable/);
  const evilWsol = new TransactionInstruction({ programId: STRANGER, keys: [w(MY_WSOL_ATA)], data: Buffer.from([1]) });
  assert.equal(check(tx([evilWsol]), MY_PUB, HOME, BUY()).ok, false);
  const benign = new TransactionInstruction({ programId: STRANGER, keys: [ro(MY_ATA), w(POOL)], data: Buffer.from([1]) });
  const r2 = check(tx([pumpIx(), benign]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, true, r2.message);
  console.log('ok  an unknown program given our ATA writable is REFUSED (read-only passes at policy level)');
}

{
  // v0 message with a lookup table: a Token instruction whose destination is
  // hidden behind an ALT index cannot be judged, so it is refused.
  const { AddressLookupTableAccount } = await import('@solana/web3.js');
  const alt = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [ATTACKER_PK, POOL] },
  });
  const v0 = (instructions) =>
    new VersionedTransaction(
      new TransactionMessage({ payerKey: me.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message([alt]),
    ).serialize();
  const hidden = v0([pumpIx(), closeAccount(MY_ATA, ATTACKER_PK)]);
  const r = check(hidden, MY_PUB, HOME, SELL());
  assert.equal(r.ok, false);
  assert.match(r.message, /lookup table/);
  // The same table used only by the trade program itself is fine.
  const r2 = check(v0([pumpIx([w(POOL)]), closeAccount(MY_ATA, me.publicKey)]), MY_PUB, HOME, SELL());
  assert.equal(r2.ok, true, r2.message);
  console.log('ok  a Token instruction touching a lookup-table account is REFUSED; ALT use by the trade program is fine');
}

{
  // WSOL wrap is allowed ONLY to our own WSOL ATA; a stranger's is a plain drain.
  const r = check(
    tx([SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: ata(ATTACKER_PK, WSOL), lamports: 500_000_000 })]),
    MY_PUB, HOME, BUY(),
  );
  assert.equal(r.ok, false);
  console.log('ok  a SOL transfer to someone ELSE\'s WSOL ATA is still REFUSED');
}

console.log('walletpolicy: all tests passed');

// ── PumpPortal router + relayer fee wallet (2026-08-29) ──────────────────
// Every relayer-built pump trade is now ONE instruction of PumpPortal's
// router program that CPIs into pump; the AMM route pays the relayer's fee
// with a bare top-level transfer to a known wallet. Both refused a real user
// today. Trusted now, but bounded: the fee wallet may take only the cap.
const ROUTER = new PublicKey('FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe');
const RELAYER_FEE_WALLET = '7FeFBYbewCqXG7LP6gC8Fnqzk7hmQFMtntXVRqnXi4g6';
const routerIx = (keys) => new TransactionInstruction({ programId: ROUTER, keys, data: Buffer.from([0x00, 0x94, 0xd0, 0xda, 0x1f, 0x43, 0x5e, 0xb0]) });

{
  const r = check(
    tx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      createAtaIdempotent(MY_ATA_2022, me.publicKey, MINT),
      routerIx([ro(POOL), w(MY_ATA_2022), w(me.publicKey, true), ro(MINT), ro(PUMP_PROGRAM)]),
      transfer(TREASURY, 50_000),
    ]),
    MY_PUB, HOME, BUY({ feeAllowance: [{ address: TREASURY, maxLamports: 50_000 }] }),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a PumpPortal ROUTER buy (our Token-2022 ATA writable) passes');
}

{
  const r = check(
    tx([
      routerIx([ro(POOL), w(MY_ATA_2022), w(me.publicKey, true), ro(MINT), ro(PUMP_PROGRAM)]),
      closeAccount(MY_ATA_2022, me.publicKey, TOKEN_2022),
    ]),
    MY_PUB, HOME, SELL(),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a PumpPortal ROUTER sell (+ Token-2022 ATA close to self) passes');
}

{
  // AMM route: relayer fee as a bare transfer, within the cap.
  const r = check(
    tx([
      createAtaIdempotent(MY_WSOL_ATA, me.publicKey, WSOL),
      SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: MY_WSOL_ATA, lamports: 11_200_000 }),
      syncNative(MY_WSOL_ATA),
      transfer(RELAYER_FEE_WALLET, 50_000),
      closeAccount(MY_WSOL_ATA, me.publicKey),
    ]),
    MY_PUB, HOME, BUY({ relayerFeeMaxLamports: 650_000 }),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  the relayer fee wallet may receive its bounded cut on an AMM buy');
}

{
  const r = check(
    tx([transfer(RELAYER_FEE_WALLET, 5_000_000)]),
    MY_PUB, HOME, BUY({ relayerFeeMaxLamports: 650_000 }),
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /relayer fee wallet/);
  console.log('ok  the relayer fee wallet is refused above the per-trade cap');
}

{
  const r = check(tx([transfer(RELAYER_FEE_WALLET, 50_000)]), MY_PUB, HOME, BUY());
  assert.equal(r.ok, false, 'no cap set = no relayer fee allowed');
  console.log('ok  without a relayer cap the fee wallet is refused like any stranger');
}

{
  const r = check(tx([transfer(RELAYER_FEE_WALLET, 50_000)]), MY_PUB, HOME, SWEEP(1_000_000));
  assert.equal(r.ok, false, 'a sweep pays only the home address');
  console.log('ok  a sweep still refuses the relayer fee wallet');
}

// ── Token-2022 extensions: unknown means refused, not harmless ────────
{
  // Discriminator 26 is TransferFeeExtension, whose sub-instructions move
  // tokens. The old switch enumerated only the classic kinds and let every
  // other byte through as inert.
  const feeExt = tokIx([w(MY_ATA_2022), w(MY_ATA_2022), ro(me.publicKey, true)], [26, 1], TOKEN_2022);
  const r = check(tx([feeExt]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false, 'a Token-2022 extension instruction must not be waved through');
  assert.match(r.message, /unrecognised Token instruction 26/);
  console.log('ok  an unknown Token-2022 extension instruction is refused');
}
{
  const confidential = tokIx([w(MY_ATA_2022), ro(me.publicKey, true)], [27, 0], TOKEN_2022);
  const r = check(tx([confidential]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, false);
  assert.match(r.message, /unrecognised Token instruction 27/);
  console.log('ok  a confidential-transfer extension instruction is refused');
}
{
  // The kinds a real trade contains still pass: SyncNative and
  // InitializeAccount3 on our own accounts.
  const sync = tokIx([w(MY_WSOL_ATA)], [17]);
  const init3 = tokIx([w(MY_ATA), ro(MINT), ro(me.publicKey)], [18]);
  const r = check(tx([sync, init3]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(r.ok, true, r.message);
  console.log('ok  the token instructions a trade actually needs still sign');
}

// ── Claiming creator fees ────────────────────────────────────────────────
//
// `intent: 'collect-fees'` is deliberately TIGHTER than a trade, not looser.
// A trade may call any known trade program with any data; a claim may do
// exactly one thing, and the thing that matters is who gets paid — pump lets
// anybody crank a collection, so the account in slot 0 is the whole security
// property.

const COLLECT = { intent: 'collect-fees', maxTransferLamports: 0 };
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 });
const vaultFor = (creator) =>
  PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), new PublicKey(creator).toBuffer()], PUMP_PROGRAM)[0];
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM)[0];

/** A collect_creator_fee instruction paying `creator`. */
const collectIx = (creator, disc = '1416567bc61cdb84') =>
  new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: new PublicKey(creator), isSigner: false, isWritable: true },
      { pubkey: vaultFor(creator), isSigner: false, isWritable: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc, 'hex'),
  });

{
  const r = check(tx([CU, collectIx(MY_PUB)]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, true, r.message);
  console.log('ok  a claim that pays this wallet signs');
}

{
  // The one that matters. Anyone may crank a collection, so a claim built to
  // pay somebody else is the attack — and it is refused by the account in
  // slot 0, not by anything about signatures.
  const r = check(tx([CU, collectIx(ATTACKER)]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, false);
  assert.match(r.message, /pays .*not this wallet/i);
  console.log('ok  a claim that pays somebody else is refused');
}

{
  // A buy wearing a claim's name. `intent: 'collect-fees'` must not become a
  // way to reach the pump program with arbitrary data.
  const buyDisc = '66063d1201daebea';
  const r = check(tx([CU, collectIx(MY_PUB, buyDisc)]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, false);
  assert.match(r.message, /not a creator-fee collection/i);
  console.log('ok  another pump instruction under the claim intent is refused');
}

{
  // The quote-token variant is recognised, so adding it later is a builder
  // change rather than a policy change.
  const r = check(tx([CU, collectIx(MY_PUB, 'cf118af204221338')]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, true, r.message);
  console.log('ok  collect_creator_fee_v2 is recognised too');
}

{
  // Exactly one. Two collects in one transaction is not a shape this app
  // builds, so it is not one the signer accepts.
  const r = check(tx([CU, collectIx(MY_PUB), collectIx(MY_PUB)]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, false);
  assert.match(r.message, /exactly one pump instruction/i);
  console.log('ok  a claim is exactly one pump instruction, never two');
}

{
  // A transfer smuggled in beside the collect. The outflow ceiling is zero,
  // so it is refused twice over — but the program check fires first.
  const r = check(tx([CU, collectIx(MY_PUB), transfer(ATTACKER, 1)]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, false);
  console.log('ok  nothing may leave the wallet beside a claim');
}

{
  // And a foreign program alongside it.
  const foreign = new TransactionInstruction({
    programId: new PublicKey(ATTACKER),
    keys: [{ pubkey: me.publicKey, isSigner: false, isWritable: true }],
    data: Buffer.from([1]),
  });
  const r = check(tx([CU, collectIx(MY_PUB), foreign]), MY_PUB, HOME, COLLECT);
  assert.equal(r.ok, false);
  assert.match(r.message, /may only call pump/i);
  console.log('ok  a claim may call pump and infrastructure, nothing else');
}

// ── The Wallet Utilities swapper ─────────────────────────────────────────
//
// A token-for-token swap signs as `trade: { side: 'sell', mint: inputMint }`,
// and the whole claim behind that design is the block below: the existing
// rules already cover it EXACTLY, so nothing in this file had to be widened
// to ship the swapper. If that ever stops being true, these fail rather than
// a policy quietly growing a hole.

const SWAP_IN = (extra = {}) => ({ intent: 'trade', maxTransferLamports: 10_000_000, trade: { side: 'sell', mint: MINT.toBase58() }, ...extra });

{
  // The input leaves into an account the route itself names, and the output
  // simply arrives — receiving needs no permission, because nothing of ours
  // moves out to do it.
  const route = pumpIx([w(MY_ATA), w(POOL_ATA), w(MY_OTHER_ATA)]);
  const out = tokTransfer(MY_ATA, POOL_ATA);
  const r = check(tx([route, out]), MY_PUB, HOME, SWAP_IN());
  assert.equal(r.ok, true, r.message);
  console.log('ok  a token-for-token swap signs as a sell of the input mint');
}

{
  // The output token arriving in OUR account is not something the policy has
  // to permit — and must not accidentally refuse either.
  const route = pumpIx([w(MY_ATA), w(POOL_ATA), w(MY_OTHER_ATA)]);
  const mkAta = createAtaIdempotent(MY_OTHER_ATA, me.publicKey, OTHER_MINT);
  const r = check(tx([mkAta, route, tokTransfer(MY_ATA, POOL_ATA)]), MY_PUB, HOME, SWAP_IN());
  assert.equal(r.ok, true, r.message);
  console.log('ok  creating the output token account is part of a swap, not a drain');
}

{
  // The protection that matters, unchanged: a swap that ALSO moves a
  // different token of ours out is a drain riding on a swap.
  const route = pumpIx([w(MY_ATA), w(POOL_ATA), w(MY_OTHER_ATA)]);
  const r = check(tx([route, tokTransfer(MY_ATA, POOL_ATA), tokTransfer(MY_OTHER_ATA, POOL_ATA)]), MY_PUB, HOME, SWAP_IN());
  assert.equal(r.ok, false);
  assert.match(r.message, /token other than the one being sold/i);
  console.log('ok  a swap that also moves a second token of ours is still refused');
}

{
  // And the destination rule holds: the input may only go somewhere the
  // route touches, so a swap cannot become a transfer to a stranger.
  const strangerAta = ata(ATTACKER_PK, MINT);
  const route = pumpIx([w(MY_ATA), w(POOL_ATA)]);
  const r = check(tx([route, tokTransfer(MY_ATA, strangerAta)]), MY_PUB, HOME, SWAP_IN());
  assert.equal(r.ok, false);
  assert.match(r.message, /which no trade program in this transaction touches/i);
  console.log('ok  a swap cannot send the input anywhere the route does not touch');
}

{
  // An approval is never part of a swap, whatever the route wants.
  const r = check(tx([approve(MY_ATA, POOL)]), MY_PUB, HOME, SWAP_IN());
  assert.equal(r.ok, false);
  assert.match(r.message, /delegate/i);
  console.log('ok  a swap may not delegate the input token account');
}

// ── Bridging between chains ──────────────────────────────────────────────
//
// The intent that signs a transaction BUILT BY SOMEBODY ELSE. Every bound
// here came out of the 2026-09-11 swarm, which demolished the three bounds
// originally proposed — "exactly one signer" was already enforced, "the
// destination must match the quote" validates attacker bytes against attacker
// bytes from the same channel, and a loss bound is blind to destination.
//
// What survived: pin the programs as BUILD CONSTANTS, refuse lookup tables,
// and let the existing fee-allowance machinery bound the one transfer.

const RELAY_DEPOSITORY = new PublicKey('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2');
const LIFI_IX = new PublicKey('3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br');
const LIFI_FEE_COLLECTOR = Keypair.generate().publicKey.toBase58();

const BRIDGE = (extra = {}) => ({ intent: 'bridge', maxTransferLamports: 0, ...extra });
const bridgeIx = (program, accounts = 2) =>
  new TransactionInstruction({
    programId: program,
    keys: Array.from({ length: accounts }, (_, i) => (i === 0 ? w(me.publicKey, true) : w(Keypair.generate().publicKey))),
    data: Buffer.from([0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06]),
  });

{
  // A synthetic shape: compute budget, LI.FI's own instruction, the
  // integrator fee, and the depository call — no lookup table.
  const r = check(
    tx([CU, bridgeIx(LIFI_IX), transfer(LIFI_FEE_COLLECTOR, 125_000), bridgeIx(RELAY_DEPOSITORY, 5)]),
    MY_PUB,
    HOME,
    BRIDGE({ feeAllowance: [{ address: LIFI_FEE_COLLECTOR, maxLamports: 125_000 }] }),
  );
  assert.equal(r.ok, true, r.message);
  console.log('ok  a bridge shape without lookup tables signs');
}

{
  // THE real one: the 503-byte Relay transaction LI.FI returned on
  // 2026-09-11 for 0.02 SOL solana -> robinhood. It carries ONE lookup
  // table (config readonly at index 1, vault writable at index 2) and a
  // 50,000-lamport transfer to LI.FI's collector. Until that day the policy
  // refused any lookup table outright, and the fixture above — built without
  // one — kept the suite green on a shape the bridge never produces.
  const REAL = fs.readFileSync(new URL('./fixtures/lifi-sol-rh-relay.base64.txt', import.meta.url), 'utf8').trim();
  const bytes = new Uint8Array(Buffer.from(REAL, 'base64'));
  const PAYER = '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce';
  const TABLE = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP';
  const CONFIG = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc';
  const VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
  const COLLECTOR = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm';
  const resolved = [{ key: TABLE, addresses: [Keypair.generate().publicKey.toBase58(), CONFIG, VAULT] }];
  const fee = [{ address: COLLECTOR, maxLamports: 500_000 }];

  // Unresolved: refused, and the message says what is missing.
  let r = check(bytes, PAYER, HOME, BRIDGE({ feeAllowance: fee }));
  assert.equal(r.ok, false);
  assert.match(r.message, /lookup table this signer has not resolved/);

  // Resolved and pinned: signs.
  r = check(bytes, PAYER, HOME, BRIDGE({ feeAllowance: fee, resolvedTables: resolved, bridgeAccounts: [CONFIG, VAULT] }));
  assert.equal(r.ok, true, r.message);

  // Resolved, but the table hands the program an account this route was
  // never measured with (a swapped vault): refused, by name.
  const stranger = Keypair.generate().publicKey.toBase58();
  r = check(bytes, PAYER, HOME, BRIDGE({ feeAllowance: fee, resolvedTables: [{ key: TABLE, addresses: [resolved[0].addresses[0], CONFIG, stranger] }], bridgeAccounts: [CONFIG, VAULT] }));
  assert.equal(r.ok, false);
  assert.match(r.message, new RegExp(stranger.slice(0, 4)));

  // A table resolved under the wrong key: refused.
  r = check(bytes, PAYER, HOME, BRIDGE({ feeAllowance: fee, resolvedTables: [{ key: stranger, addresses: resolved[0].addresses }], bridgeAccounts: [CONFIG, VAULT] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /resolved as/);

  // Without the fee allowance the 50,000-lamport collector transfer is a
  // bare transfer to nowhere we know: refused.
  r = check(bytes, PAYER, HOME, BRIDGE({ resolvedTables: resolved, bridgeAccounts: [CONFIG, VAULT] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /neither your withdrawal address nor a known tip account/);

  // And a ceiling under the measured fee refuses too.
  r = check(bytes, PAYER, HOME, BRIDGE({ feeAllowance: [{ address: COLLECTOR, maxLamports: 49_999 }], resolvedTables: resolved, bridgeAccounts: [CONFIG, VAULT] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /over the/);
  console.log('ok  the real Relay transaction signs only with its table resolved to the pinned accounts and its fee allowed');
}

{
  // THE bound. A program the quote named but this build never measured is
  // attacker data, and it is refused by name.
  const stranger = new PublicKey(ATTACKER);
  const r = check(tx([CU, bridgeIx(stranger, 5)]), MY_PUB, HOME, BRIDGE());
  assert.equal(r.ok, false);
  assert.match(r.message, /only call a bridge this build has measured/i);
  console.log('ok  a bridge program this build never measured is refused');
}

{
  // Lookup tables. LI.FI's Solana routes use them, and relaxing the existing
  // ALT refusals to accommodate that would be the actual loss event — an
  // account we cannot name is one we cannot judge.
  // The lookup table has to actually be USED, or web3.js compiles it away and
  // the test proves nothing — the accounts in the instruction must be the ones
  // the table holds.
  const hidden = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const alt = { key: Keypair.generate().publicKey, state: { addresses: hidden } };
  const viaAlt = new TransactionInstruction({
    programId: LIFI_IX,
    keys: [w(me.publicKey, true), w(hidden[0]), ro(hidden[1])],
    data: Buffer.from([1]),
  });
  const msg = new TransactionMessage({
    payerKey: me.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [CU, viaAlt],
  }).compileToV0Message([alt]);
  assert.ok(msg.addressTableLookups.length > 0, 'the fixture must really use a lookup table');
  const r = check(new VersionedTransaction(msg).serialize(), MY_PUB, HOME, BRIDGE());
  assert.equal(r.ok, false);
  assert.match(r.message, /lookup table/i);
  console.log('ok  a bridge using address lookup tables is refused outright');
}

{
  // The fee is bounded by the EXISTING per-address summing allowance, so two
  // transfers to the same collector cannot each slip under one ceiling.
  const r = check(
    tx([CU, bridgeIx(RELAY_DEPOSITORY, 5), transfer(LIFI_FEE_COLLECTOR, 125_000), transfer(LIFI_FEE_COLLECTOR, 125_000)]),
    MY_PUB,
    HOME,
    BRIDGE({ feeAllowance: [{ address: LIFI_FEE_COLLECTOR, maxLamports: 125_000 }] }),
  );
  assert.equal(r.ok, false);
  console.log('ok  two transfers to the same fee collector cannot each slip under the ceiling');
}

{
  // Anything leaving to anywhere the policy did not name is refused, which is
  // the rule that already refuses today's bridge transaction.
  const r = check(
    tx([CU, bridgeIx(RELAY_DEPOSITORY, 5), transfer(ATTACKER, 1_000)]),
    MY_PUB,
    HOME,
    BRIDGE({ feeAllowance: [{ address: LIFI_FEE_COLLECTOR, maxLamports: 125_000 }] }),
  );
  assert.equal(r.ok, false);
  console.log('ok  a transfer smuggled in beside a bridge is refused');
}

{
  // A transaction that calls no bridge at all is not a bridge, whatever the
  // intent claims.
  const r = check(tx([CU, transfer(LIFI_FEE_COLLECTOR, 125_000)]), MY_PUB, HOME,
    BRIDGE({ feeAllowance: [{ address: LIFI_FEE_COLLECTOR, maxLamports: 125_000 }] }));
  assert.equal(r.ok, false);
  assert.match(r.message, /calls no bridge/i);
  console.log('ok  the bridge intent refuses a transaction with no bridge in it');
}

{
  // No trade context, so a token instruction that moves a holding hits the
  // ordinary refusal. A bridge of native SOL touches no token account, and a
  // transaction claiming otherwise is not one.
  const r = check(tx([CU, bridgeIx(RELAY_DEPOSITORY, 5), tokTransfer(MY_ATA, POOL_ATA)]), MY_PUB, HOME, BRIDGE());
  assert.equal(r.ok, false);
  assert.match(r.message, /moves no token out|token other than/i);
  console.log('ok  a bridge may not move a token holding');
}

{
  // The launcher's second-signature exception does not leak here: a bridge is
  // a one-signature transaction like everything else that is not a launch.
  const second = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: me.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      CU,
      new TransactionInstruction({
        programId: RELAY_DEPOSITORY,
        keys: [w(me.publicKey, true), w(second.publicKey, true)],
        data: Buffer.from([1]),
      }),
    ],
  }).compileToV0Message();
  const r = check(new VersionedTransaction(msg).serialize(), MY_PUB, HOME, BRIDGE());
  assert.equal(r.ok, false);
  assert.match(r.message, /needs 2 signers/i);
  console.log('ok  a bridge needing a second signature is refused, invariant intact');
}

// ── The program gate that was missing ────────────────────────────────────
//
// `checkOutflow` reads TOP-LEVEL instructions and guards our TOKEN accounts.
// It does NOT stop an unrecognised program that has been handed the wallet's
// own system account — writable, and a signer — from moving SOL by CPI,
// because a CPI is not a top-level instruction. Until 2026-09-11 the only
// defence lived in liveSigner's relayer path; swap.ts signed Jupiter's bytes
// without it. This is the shared gate, and these pin what it catches.

{
  // The exact shape the gate exists for: a stranger program holding our
  // wallet writable and signing. checkOutflow alone WAVES THIS THROUGH.
  const stranger = new PublicKey(ATTACKER);
  const drain = new TransactionInstruction({
    programId: stranger,
    keys: [w(me.publicKey, true), w(Keypair.generate().publicKey)],
    data: Buffer.from([1, 2, 3]),
  });
  const permissive = check(tx([CU, drain]), MY_PUB, HOME, TRADE(10_000_000));
  assert.equal(permissive.ok, true, 'checkOutflow alone does not catch a CPI drain — this is why the gate exists');

  const unknown = unknownPrograms(tx([CU, drain]));
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0], stranger.toBase58());
  console.log('ok  the gate catches the CPI shape that checkOutflow cannot see');
}

{
  // A real route's programs pass. Jupiter, a venue, and the infrastructure.
  const jup = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  const whirl = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  const ix = (prog) => new TransactionInstruction({ programId: prog, keys: [w(me.publicKey, true)], data: Buffer.from([0]) });
  assert.deepEqual(unknownPrograms(tx([CU, ix(jup), ix(whirl), syncNative(MY_WSOL_ATA)])), []);
  console.log('ok  a real Jupiter route passes the gate');
}

{
  // A program hidden in a lookup table reads as unknown, because an account
  // we cannot name is one we cannot judge.
  const hidden = [Keypair.generate().publicKey];
  const alt = { key: Keypair.generate().publicKey, state: { addresses: hidden } };
  const viaAlt = new TransactionInstruction({
    programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
    keys: [w(me.publicKey, true), w(hidden[0])],
    data: Buffer.from([0]),
  });
  const msg = new TransactionMessage({ payerKey: me.publicKey, recentBlockhash: BLOCKHASH, instructions: [CU, viaAlt] }).compileToV0Message([alt]);
  // The PROGRAM here is static, so this route is fine — the point is the
  // helper reports hidden PROGRAMS, not hidden accounts.
  assert.deepEqual(unknownPrograms(new VersionedTransaction(msg).serialize()), []);
  console.log('ok  a lookup table holding accounts is not itself an unknown program');
}

{
  // The real Mayan route, measured 2026-09-11: it carries THREE lookup tables
  // and a System transfer whose destination lives inside one of them. The
  // bridge intent refuses it, and that refusal is the feature working — the
  // alternative is signing a payment to an address we cannot read.
  const hidden = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const alt = { key: Keypair.generate().publicKey, state: { addresses: hidden } };
  const mayan = new PublicKey('D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa');
  const viaAlt = new TransactionInstruction({
    programId: mayan,
    keys: [w(me.publicKey, true), w(hidden[0]), ro(hidden[1])],
    data: Buffer.from([1]),
  });
  const msg = new TransactionMessage({
    payerKey: me.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [CU, viaAlt],
  }).compileToV0Message([alt]);
  assert.ok(msg.addressTableLookups.length > 0);
  const r = check(new VersionedTransaction(msg).serialize(), MY_PUB, HOME, BRIDGE());
  assert.equal(r.ok, false, 'the real SOL to BNB route shape is refused');
  assert.match(r.message, /lookup table/i);
  console.log('ok  the measured Mayan route is refused for hiding accounts in lookup tables');
}
