// Send — pay any address (2026-10-03).
//
// Pins: the Solana signer signs a send ONLY against an approval (address,
// mint, program, ceiling) and refuses every way the bytes could differ from
// it; the EVM signer refuses an ERC-20 transfer unless recipient, token and
// amount are pinned; amounts parse exactly; and the IPC handler asks the
// native dialog BEFORE it files an approval.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { checkOutflowForTest as check } from './.signpolicy.mjs';
import { checkEvmTx, ERC20_TRANSFER_SELECTOR } from './.evmpolicy.mjs';
import { parseUnits, formatUnits, sendRequestOf } from './.send.mjs';

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok  ${m}`);
};

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const me = Keypair.generate().publicKey;
const them = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const BH = '11111111111111111111111111111111';
const ata = (owner, m, program) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(program).toBuffer(), m.toBuffer()], new PublicKey(ATA))[0];
const tx = (ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: BH, instructions: ixs }).compileToV0Message()).serialize();
const solPolicy = (lamports) => ({ intent: 'send', maxTransferLamports: lamports, sendApprovalId: 'x' });
const tokPolicy = { intent: 'send-token', maxTransferLamports: 0, sendApprovalId: 'x' };
const approvedSol = (lamports, to = them) => ({ to: to.toBase58(), mint: null, tokenProgram: null, maxAmount: BigInt(lamports) });
const approvedTok = (amount, program = TOKEN, to = them) => ({ to: to.toBase58(), mint: mint.toBase58(), tokenProgram: program, maxAmount: BigInt(amount) });

// ── SOL ────────────────────────────────────────────────────────────────
{
  const send = tx([SystemProgram.transfer({ fromPubkey: me, toPubkey: them, lamports: 50_000_000 })]);
  assert.equal(check(send, me.toBase58(), null, solPolicy(50_000_000), approvedSol(50_000_000)).ok, true);
  ok('a SOL send to the approved address, for the approved amount, signs');

  const r = check(send, me.toBase58(), null, solPolicy(50_000_000), null);
  assert.equal(r.ok, false);
  assert.match(r.message, /not confirmed/);
  ok('no approval → refused, whatever the policy says');

  assert.equal(check(send, me.toBase58(), null, solPolicy(50_000_000), approvedSol(50_000_000, stranger)).ok, false);
  ok('a transfer to any address but the approved one → refused');

  assert.equal(check(send, me.toBase58(), null, solPolicy(50_000_000), approvedSol(49_999_999)).ok, false);
  ok('one lamport over the approved amount → refused');

  const two = tx([
    SystemProgram.transfer({ fromPubkey: me, toPubkey: them, lamports: 1_000 }),
    SystemProgram.transfer({ fromPubkey: me, toPubkey: stranger, lamports: 1_000 }),
  ]);
  assert.equal(check(two, me.toBase58(), null, solPolicy(50_000_000), approvedSol(50_000_000)).ok, false);
  ok('a second instruction smuggled in → refused');

  // The stored withdrawal address is not a back door into a send.
  assert.equal(check(send, me.toBase58(), them.toBase58(), solPolicy(50_000_000), approvedSol(50_000_000, stranger)).ok, false);
  ok('the saved withdrawal address does not stand in for the approval');

  assert.equal(check(send, me.toBase58(), null, solPolicy(50_000_000), approvedTok(50_000_000)).ok, false);
  ok('a token approval does not sign a SOL send');
}

// ── Tokens ─────────────────────────────────────────────────────────────
const createIx = (program, to = them) =>
  new TransactionInstruction({
    programId: new PublicKey(ATA),
    keys: [
      { pubkey: me, isSigner: true, isWritable: true },
      { pubkey: ata(to, mint, program), isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(program), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
const transferIx = (amount, program, to = them) => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = 6;
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: ata(me, mint, program), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(to, mint, program), isSigner: false, isWritable: true },
      { pubkey: me, isSigner: true, isWritable: false },
    ],
    data,
  });
};
{
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
  for (const program of [TOKEN, TOKEN22]) {
    const t = tx([price, createIx(program), transferIx(1_000_000, program)]);
    assert.equal(check(t, me.toBase58(), null, tokPolicy, approvedTok(1_000_000, program)).ok, true, program);
  }
  ok('a token send (create their account + checked transfer) signs — classic SPL and Token-2022');

  const t = tx([price, createIx(TOKEN), transferIx(1_000_000, TOKEN)]);
  assert.equal(check(t, me.toBase58(), null, tokPolicy, approvedTok(1_000_000, TOKEN22)).ok, false);
  ok('the approval names the token program — a different program → refused');

  assert.equal(check(t, me.toBase58(), null, tokPolicy, approvedTok(999_999)).ok, false);
  ok('one base unit over the approved amount → refused');

  const elsewhere = tx([price, transferIx(1_000_000, TOKEN, stranger)]);
  assert.equal(check(elsewhere, me.toBase58(), null, tokPolicy, approvedTok(1_000_000)).ok, false);
  ok("a transfer into someone else's token account → refused");

  const sneaky = tx([price, transferIx(1_000_000, TOKEN), SystemProgram.transfer({ fromPubkey: me, toPubkey: stranger, lamports: 1 })]);
  assert.equal(check(sneaky, me.toBase58(), null, tokPolicy, approvedTok(1_000_000)).ok, false);
  ok('a SOL transfer riding along with a token send → refused');

  const twice = tx([price, transferIx(500_000, TOKEN), transferIx(500_000, TOKEN)]);
  assert.equal(check(twice, me.toBase58(), null, tokPolicy, approvedTok(1_000_000)).ok, false);
  ok('two transfers → refused');

  assert.equal(check(t, me.toBase58(), null, tokPolicy, null).ok, false);
  ok('no approval → a token send is refused too');
}

// ── EVM ────────────────────────────────────────────────────────────────
{
  const token = '0x55d398326f99059ff775485246999027b3197955';
  const to = '0x1111111111111111111111111111111111111111';
  const other = '0x2222222222222222222222222222222222222222';
  const data = (recipient, amount) => `${ERC20_TRANSFER_SELECTOR}${recipient.slice(2).padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
  const base = { chainId: 56, to: token, value: 0n, gas: 60_000n, maxFeePerGas: 1_000_000_000n };
  const policy = (extra = {}) => ({
    chainId: 56,
    intent: 'send',
    allow: [{ to: token, selectors: [ERC20_TRANSFER_SELECTOR], maxValueWei: 0n }],
    maxGas: 1_500_000n,
    maxFeePerGasWei: 50_000_000_000n,
    approveSpenders: [],
    permit2Spenders: [],
    tokenTransfer: { token, to, maxAmount: 1000n },
    ...extra,
  });
  assert.equal(checkEvmTx({ ...base, data: data(to, 1000n) }, policy()).ok, true);
  ok('an ERC-20 send to the pinned recipient, within the pinned amount, signs');
  assert.equal(checkEvmTx({ ...base, data: data(other, 1000n) }, policy()).ok, false);
  ok('calldata naming another recipient → refused');
  assert.equal(checkEvmTx({ ...base, data: data(to, 1001n) }, policy()).ok, false);
  ok('calldata over the pinned amount → refused');
  assert.equal(checkEvmTx({ ...base, data: data(to, 1000n) }, policy({ tokenTransfer: undefined })).ok, false);
  ok('a transfer selector with nothing pinned → refused, whatever the allowlist says');
  assert.equal(checkEvmTx({ ...base, data: `${data(to, 1000n)}00` }, policy()).ok, false);
  ok('trailing calldata → refused');
  const native = {
    chainId: 56,
    intent: 'send',
    allow: [{ to, selectors: 'transfer', maxValueWei: 5n }],
    maxGas: 1_500_000n,
    maxFeePerGasWei: 50_000_000_000n,
    approveSpenders: [],
    permit2Spenders: [],
  };
  assert.equal(checkEvmTx({ ...base, to, value: 5n, data: '0x' }, native).ok, true);
  assert.equal(checkEvmTx({ ...base, to, value: 6n, data: '0x' }, native).ok, false);
  assert.equal(checkEvmTx({ ...base, to: other, value: 5n, data: '0x' }, native).ok, false);
  ok('a coin send: exactly the recipient, at most the amount, no calldata');
}

// ── Amounts ────────────────────────────────────────────────────────────
{
  assert.equal(parseUnits('1.5', 6), 1_500_000n);
  assert.equal(parseUnits('0.000000001', 9), 1n);
  // A comma is refused, never stripped: "0,05" was sent as 5 (swarm 2026-10-03).
  assert.equal(parseUnits('1,000', 2), null);
  assert.equal(parseUnits('0,05', 18), null);
  assert.equal(parseUnits('1,5', 9), null);
  assert.equal(parseUnits('.5', 1), 5n);
  assert.equal(parseUnits('0.0000000001', 9), null, 'more decimals than the coin has → refused, never rounded');
  for (const bad of ['', '.', '0', '-1', '1e3', 'abc', '1.2.3']) assert.equal(parseUnits(bad, 9), null, bad);
  assert.equal(parseUnits('123456789.123456789123456789', 18), 123456789123456789123456789n);
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits(1n, 9), '0.000000001');
  assert.equal(formatUnits(1234567_000000n, 6), '1,234,567');
  ok('amounts parse exactly — no float, no rounding, too many decimals refused');

  assert.equal(sendRequestOf({ chain: 'solana', to: ' abc ', token: null, amount: 'max' })?.to, 'abc');
  assert.equal(sendRequestOf({ chain: 'eth', to: 'a', token: null, amount: '1' }), null);
  assert.equal(sendRequestOf({ chain: 'bnb', to: 'a', token: 5, amount: '1' }), null);
  ok('the IPC payload is validated');
}

// ── Where the approval comes from ──────────────────────────────────────
{
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const wallet = src('../electron/system/wallet.ts');
  const take = wallet.slice(wallet.indexOf('function takeSendApproval('), wallet.indexOf('export function signVersionedTransaction('));
  assert.ok(take.indexOf('sendApprovals.delete(id)') < take.indexOf('expiresAt <= Date.now()'), 'spent before it is judged: one use, even a failed one');
  assert.ok(take.includes('a.wallet !== walletPublicKey'), 'an approval signs for the wallet it was filed for only');
  assert.ok(wallet.includes("policy.intent === 'send' || policy.intent === 'send-token' ? takeSendApproval(policy.sendApprovalId, w.publicKey) : null"));
  ok('the signer resolves the approval itself — single use, per wallet, short-lived');

  const ipc = src('../electron/ipc.ts');
  const exec = ipc.slice(ipc.indexOf("ipcMain.handle('send:execute'"), ipc.indexOf("ipcMain.handle('wallet:setMaxBalance'"));
  const dialogAt = exec.indexOf('confirmNative(e.sender,');
  const approveAt = exec.indexOf('wallet.approveSend(');
  const evmAt = exec.indexOf('evmSend.execute(');
  assert.ok(dialogAt > 0 && approveAt > dialogAt && evmAt > dialogAt, 'the native dialog comes first');
  assert.ok(exec.indexOf('if (response !== 1)') < approveAt, 'and a Cancel returns before any approval exists');
  assert.ok(exec.indexOf('planned = await planSend(req)') < dialogAt, 'the dialog shows numbers main read itself, not the page');
  assert.equal((ipc.match(/wallet\.approveSend\(/g) ?? []).length, 1, 'send:execute is the only place an approval is filed');
  ok('approvals are filed only by send:execute, only after the native confirmation');
}

// ── A key enters only through a native dialog (swarm 2026-10-03) ──────────
{
  // "Your own address" (bridge:send, lab:collect) is only safe if every key
  // held was made here or confirmed by the user. A compromised renderer could
  // import an attacker's key, select it, and bridge funds to it.
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const ch of ['wallet:import', 'evm:wallet:import', 'aio:import', 'pump:importAccount']) {
    const at = ipc.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(at > 0, ch);
    const body = ipc.slice(at, at + 900);
    const gate = body.indexOf('confirmImport(e.sender,');
    const store = body.search(/importSecret\(|importPhrase\(/);
    assert.ok(gate > 0 && gate < store, `${ch}: the native confirmation comes before the key is stored`);
  }
  ok('every key import (Solana, EVM, All-in-One, pump account) is natively confirmed first');
}

// ── Back-to-back EVM sends never share a nonce (live test 2026-10-03) ─────
{
  // A Robinhood deposit and its fee leg went out a moment apart; the RPC's
  // pending nonce had not caught up, the fee reused nonce 0, the node said
  // "nonce too low", and the sender called that landed — a fee logged as
  // paid that never existed.
  const trade = fs.readFileSync(new URL('../electron/evm/trade.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const send = trade.slice(trade.indexOf('async function sendCall('), trade.indexOf('function tokenDeltaFromReceipt('));
  assert.ok(send.includes('const nonce = Math.max(pendingNonce, nonceFloor(chain, owner));') && send.includes("c.getTransactionCount({ address: owner, blockTag: 'pending' })"), 'the nonce is never below the last one this app sent');
  assert.ok(send.indexOf('noteNonce(chain, owner, nonce)') > send.indexOf('sendRawTransaction('), 'and is noted once the node took the transaction');
  assert.ok(!/const landed = \/already known\|nonce too low/.test(send), '"nonce too low" alone is not "landed"');
  assert.ok(send.includes('c.getTransaction({ hash })'), 'it is landed only when the node knows OUR hash');
  ok('back-to-back EVM sends get consecutive nonces; "nonce too low" is checked against our own hash');
  // A broadcast that timed out was mined anyway and Send said "failed" (2026-10-03).
  const amb = send.indexOf('timed? ?out|fetch failed');
  assert.ok(amb > 0 && amb < send.indexOf('if (!landed) return { ok: false, message: `Send failed: ${msg}`'), 'a timeout is followed by hash, never reported as nothing sent');
  ok('an ambiguous broadcast error (timeout, dropped socket) is followed by hash, not called a failure');
}

// ── the address book (2026-10-03) ─────────────────────────────────────────
{
  const { checkRecipient, recipientWarnings, cleanLabel, parseSendBook } = await import('./.sendbook.mjs');
  const mine = '0x011F1bbac10Dcf1eFCe795C9e92391C40cbbDd0a';
  const poison = '0x011F' + 'f'.repeat(32) + 'Dd0a'; // same first and last four, different middle
  const book = {
    contacts: [{ id: 'c1', label: 'my Ledger', family: 'evm', address: mine, addedAt: 1 }],
    history: [{ at: 1, chain: 'bnb', to: mine, token: null, amountText: '0.1 BNB', txid: '0x1', ok: true }],
  };
  const known = checkRecipient(book, 'evm', mine.toLowerCase());
  assert.equal(known.contact.label, 'my Ledger', 'EVM matches case-blind');
  assert.equal(recipientWarnings(known).length, 0, 'a saved, used address: nothing to warn about');
  const p1 = checkRecipient(book, 'evm', poison);
  assert.ok(p1.lookalike && p1.lookalike.address === mine, 'the poisoning lookalike is caught');
  const w = recipientWarnings(p1);
  assert.ok(w[0].startsWith('CAREFUL') && w[0].includes('my Ledger'), 'and named, first');
  assert.ok(w.some((x) => /not sent to this address before/.test(x)), 'and it is a first-time recipient');
  const fresh = checkRecipient(book, 'solana', '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce');
  assert.equal(fresh.lookalike, null, 'another family is never compared');
  assert.equal(cleanLabel('  a\u202Eb\n c  '), 'a b c', 'no bidi, one line');
  assert.equal(cleanLabel('x'.repeat(99)).length, 40);
  assert.equal(cleanLabel('   '), null);
  assert.equal(parseSendBook({ contacts: 'x', history: [] }), null, 'not a book: refused, never read as empty');
  assert.deepEqual(parseSendBook({ contacts: [], history: [] }), { contacts: [], history: [] });
  // v6 audit: the app's OWN addresses are known, and imitations of them caught.
  const home = 'AHVyVc3Uxw8ecbKRgGenkiJrRSVmt4CAg9GMAtGs1TW6';
  const own = [{ address: home, label: 'withdrawal address (wallet “Main”)' }];
  const empty = { contacts: [], history: [] };
  const toHome = checkRecipient(empty, 'solana', home, own);
  assert.equal(toHome.own.address, home);
  assert.ok(recipientWarnings(toHome).some((x) => /your own withdrawal address/.test(x)), 'named as your own');
  assert.ok(!recipientWarnings(toHome).some((x) => /not sent to this address before/.test(x)), 'your own address is not a stranger');
  const fakeHome = 'AHVy' + 'z'.repeat(36) + '1TW6';
  assert.ok(recipientWarnings(checkRecipient(empty, 'solana', fakeHome, own))[0].startsWith('CAREFUL'), 'a lookalike of the withdrawal address is caught');
  // A contact the page saved, never sent to: still a first-time recipient.
  const saved = { contacts: [{ id: 'c2', label: 'friend', family: 'evm', address: poison, addedAt: 2 }], history: [] };
  assert.ok(recipientWarnings(checkRecipient(saved, 'evm', poison)).some((x) => /not sent to this address before/.test(x)), 'a saved name alone does not make an address trusted');
  ok('the address book: lookalikes (address poisoning) and first-time recipients are warned about');
}

console.log(`\nsend: ${passed}/${passed} passed`);
