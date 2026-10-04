// Relay, called directly (shared/relay.ts) — against REAL quotes captured on
// 2026-10-01 (test/fixtures/relay-quotes.json), and against the same quotes
// tampered with, one field at a time. A check that passes the real thing and
// refuses every tampered copy is a check; one that only passes the real thing
// proves nothing.
import assert from 'node:assert';
import fs from 'node:fs';
import {
  parseRelayQuote,
  solanaDepositProblem,
  evmDepositProblem,
  bridgeStatusOfRelay,
  destinationProblem,
  RELAY_SOLANA_DEPOSITORY,
} from './.relay.mjs';

// ── Relay's free text is cleaned before it is shown (swarm 2026-10-03) ──
{
  const { cleanRelayReason } = await import('./.relay.mjs');
  assert.equal(cleanRelayReason('  N/A  '), 'N/A');
  assert.equal(cleanRelayReason('Refund: see https://evil.example/claim now'), 'Refund: see [link removed] now');
  assert.equal(cleanRelayReason('a\u202Ebc\nd'), 'a bc d', 'no bidi override, one line');
  assert.equal(cleanRelayReason('x'.repeat(400)).length, 158, 'capped');
  assert.equal(cleanRelayReason('\u0000\u0007'), null);
  console.log('ok  Relay\'s free-text reason is cleaned: no links, no bidi, one short line');
}

// ── every quote is bound to an order we checked (2026-10-03) ──────────────
{
  const src = fs.readFileSync(new URL('../electron/engine/relay.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const q = src.slice(src.indexOf('export async function quote('), src.indexOf('export interface RelayStatusRead'));
  assert.ok(q.includes('includeProtocolData: true'), 'the order behind each quote is asked for');
  assert.ok(q.includes('relayBindingProblem(r.data,'), 'and checked, on the raw answer, before any quote is used');
  // A cross-chain order may refund on the FAR side, to the recipient: leaving
  // it out refused every Solana<->EVM move (caught live, 2026-10-03).
  assert.ok(q.includes('refundRecipients: [req.user, req.refundTo, req.recipient]'), 'refunds may go to any of our own three addresses');
  console.log('ok  every Relay quote is bound to an order paying us, refunds included');
}

const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/relay-quotes.json', import.meta.url), 'utf8'));
const SOLU = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const clone = (o) => JSON.parse(JSON.stringify(o));
const parse = (body) => {
  const r = parseRelayQuote(body);
  assert.ok(r.ok, r.why);
  return r.quote;
};

// ── every measured route parses, and its deposit checks out ────────────
{
  for (const [name, amount] of [['solana->bnb', '100000000'], ['solana->robinhood', '100000000']]) {
    const q = parse(FX[name]);
    assert.ok(q.solana && !q.evm, `${name} is a Solana deposit`);
    assert.equal(solanaDepositProblem(q, SOLU, amount), null, `${name}: the real deposit passes`);
    assert.match(q.requestId, /^0x[0-9a-f]{64}$/);
  }
  for (const [name, amount, chainId] of [['bnb->solana', '30000000000000000', 56], ['bnb->robinhood', '30000000000000000', 56], ['robinhood->solana', '5000000000000000', 4663], ['robinhood->bnb', '5000000000000000', 4663]]) {
    const q = parse(FX[name]);
    assert.ok(q.evm && !q.solana, `${name} is an EVM deposit`);
    assert.equal(evmDepositProblem(q, EVM, amount, chainId), null, `${name}: the real deposit passes`);
  }
  // EXACT_OUTPUT: the deposit amount is what Relay says goes IN.
  const exact = parse(FX['solana->bnb EXACT_OUTPUT 0.02']);
  assert.equal(exact.amountOutRaw, '20000000000000000', 'exactly 0.02 BNB out');
  assert.equal(solanaDepositProblem(exact, SOLU, exact.amountInRaw), null, 'and the deposit equals the quoted input');
  // App fees are visible in the quote and come out of the output.
  const withFee = parse(FX['bnb->solana appFees']);
  const without = parse(FX['bnb->solana']);
  assert.ok(withFee.appFeeUsd > 0, 'the app fee is priced');
  assert.ok(BigInt(withFee.amountOutRaw) < BigInt(without.amountOutRaw), 'and it comes out of what arrives');
  assert.equal(evmDepositProblem(withFee, EVM, '30000000000000000', 56), null, 'the deposit itself is unchanged');
  console.log('ok  every measured route parses and its real deposit passes');
}

// ── Solana: every tampered field is refused ─────────────────────────────
{
  const base = FX['solana->bnb'];
  const ixOf = (b) => b.steps[0].items[0].data.instructions[0];
  const cases = [
    ['a different program', (b) => { ixOf(b).programId = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'; }, /not Relay's depository/],
    ['a second signer', (b) => { ixOf(b).keys[2].isSigner = true; }, /account 3/],
    ['the vault swapped', (b) => { ixOf(b).keys[3].pubkey = SOLU; }, /account 4/],
    ['someone else signing', (b) => { ixOf(b).keys[1].pubkey = 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n'; }, /account 2/],
    ['a bigger amount', (b) => { const d = ixOf(b).data; ixOf(b).data = d.slice(0, 16) + '00e40b5402000000' + d.slice(32); }, /not the 100000000 asked for/],
    ['a different instruction', (b) => { ixOf(b).data = 'ffffffffffffffff' + ixOf(b).data.slice(16); }, /not DepositNative/],
    ['a second instruction', (b) => { b.steps[0].items[0].data.instructions.push(clone(ixOf(b))); }, /2 instructions/],
    ['an unmeasured lookup table', (b) => { b.steps[0].items[0].data.addressLookupTableAddresses = ['11111111111111111111111111111112']; }, /lookup table/],
  ];
  for (const [what, mutate, why] of cases) {
    const b = clone(base);
    mutate(b);
    const q = parse(b);
    assert.match(solanaDepositProblem(q, SOLU, '100000000') ?? 'PASSED', why, `refused: ${what}`);
  }
  assert.match(solanaDepositProblem(parse(base), SOLU, '99999999'), /not the 99999999/, 'the amount must be EXACTLY what was asked');
  assert.match(solanaDepositProblem(parse(base), 'J7YraeWCWGJXYTsTGta1zSX7PS5BV2i4H4ogkR6ZZ13n', '100000000'), /account 2/, "another wallet's deposit is not ours to sign");
  console.log('ok  Solana: program, accounts, roles, amount and table are all pinned');
}

// ── EVM: every tampered field is refused ───────────────────────────────
{
  const base = FX['bnb->solana'];
  const dataOf = (b) => b.steps[0].items[0].data;
  const cases = [
    ['another contract', (b) => { dataOf(b).to = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'; }, /not Relay's depository/],
    ['another selector', (b) => { dataOf(b).data = '0xa9059cbb' + dataOf(b).data.slice(10); }, /not depositNative/],
    ['another depositor', (b) => { dataOf(b).data = dataOf(b).data.slice(0, 34) + 'dcbad4133961664d3f7e05f2d310a56dc3ea483a' + dataOf(b).data.slice(74); }, /depositor is 0xdcbad/],
    ['more value', (b) => { dataOf(b).value = '30000000000000001'; }, /not the 30000000000000000/],
    ['another chain', (b) => { dataOf(b).chainId = 4663; }, /chain 4663, not 56/],
    ['extra calldata', (b) => { dataOf(b).data += '00'.repeat(32); }, /not the measured/],
  ];
  for (const [what, mutate, why] of cases) {
    const b = clone(base);
    mutate(b);
    const q = parse(b);
    assert.match(evmDepositProblem(q, EVM, '30000000000000000', 56) ?? 'PASSED', why, `refused: ${what}`);
  }
  console.log('ok  EVM: contract, selector, depositor, value and chain are all pinned');
}

// ── shapes that are not the measured one are not parsed at all ──────────
{
  const two = clone(FX['bnb->solana']);
  two.steps.push(clone(two.steps[0]));
  assert.equal(parseRelayQuote(two).ok, false, 'two steps (an approval first, say) is a route nobody measured');
  const sig = clone(FX['bnb->solana']);
  sig.steps[0].kind = 'signature';
  assert.equal(parseRelayQuote(sig).ok, false);
  assert.equal(parseRelayQuote({ message: 'Insufficient liquidity' }).ok, false);
  assert.equal(parseRelayQuote(null).ok, false);
  console.log('ok  anything but one deposit transaction is refused before it is read');
}

// ── status ─────────────────────────────────────────────────────────────
{
  assert.equal(bridgeStatusOfRelay('success'), 'done');
  assert.equal(bridgeStatusOfRelay('refund'), 'refunded');
  assert.equal(bridgeStatusOfRelay('failure'), 'failed');
  for (const s of ['waiting', 'pending', 'delayed']) assert.equal(bridgeStatusOfRelay(s), 'pending');
  assert.equal(bridgeStatusOfRelay('unknown'), 'unknown');
  assert.equal(bridgeStatusOfRelay(undefined), 'unknown');
  console.log('ok  Relay status maps onto the Bridge states');
}

// ── the quote must describe what was asked: our address, that chain, its coin ──
{
  const toBnb = parse(FX['solana->bnb']);
  assert.equal(destinationProblem(toBnb, 'bnb', EVM), null, 'the real quote names our EVM address on BNB, in BNB');
  assert.equal(destinationProblem(toBnb, 'bnb', EVM.toLowerCase()), null, 'EVM addresses compare case-blind');
  assert.match(destinationProblem(toBnb, 'bnb', '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a'), /not your address/);
  assert.match(destinationProblem(toBnb, 'robinhood', EVM), /chain 56, not robinhood/);
  const toSol = parse(FX['bnb->solana']);
  assert.equal(destinationProblem(toSol, 'solana', SOLU), null);
  assert.match(destinationProblem(toSol, 'solana', SOLU.toLowerCase()), /not your address/, 'a Solana address is case-sensitive');
  const stable = clone(FX['solana->bnb']);
  stable.details.currencyOut.currency.address = '0x55d398326f99059fF775485246999027B3197955';
  assert.match(destinationProblem(parse(stable), 'bnb', EVM), /not bnb's native coin/, 'a stablecoin delivered instead of BNB is refused');
  const nobody = clone(FX['solana->bnb']);
  delete nobody.details.recipient;
  assert.match(destinationProblem(parse(nobody), 'bnb', EVM), /nobody it names/);
  console.log('ok  a quote that delivers anywhere but our own address, chain and coin is refused');
}

assert.equal(RELAY_SOLANA_DEPOSITORY, '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2');
console.log('\nrelay: every deposit pinned to what was measured');
