// Signer outflow policy — the gate that decides whether our SOL is allowed to
// move. Before 2026-08-16 the signer checked only fee payer + signature count,
// so anything that could hand it a transaction could empty the wallet.
//
// These build real VersionedTransactions and assert the policy accepts exactly
// the legitimate shapes and refuses everything else. A regression here is a
// drained wallet, not a failed test.

import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { checkOutflowForTest as check } from './.signpolicy.mjs';

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
  // A sell that pushes the traded mint into the pool at top level is expected.
  const r = check(tx([tokTransfer(MY_ATA, POOL_ATA, 1000), tokTransferChecked(MY_ATA, MINT, POOL_ATA)]), MY_PUB, HOME, SELL());
  assert.equal(r.ok, true, r.message);
  console.log('ok  a SELL transferring the traded mint out is allowed');
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
