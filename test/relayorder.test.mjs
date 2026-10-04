// Relay's order binding (shared/relayOrder.ts) — against REAL quotes taken
// 2026-10-02 with includeProtocolData (test/fixtures/relay-orders.json: four
// routes, each from /quote/v2 and from /quote), and against the same quotes
// tampered with, one field at a time. Every tamper is tried three ways:
//   - the order is edited and nothing else (both layers must refuse);
//   - the order is edited AND the deposit re-committed to it — a consistent
//     lie, so only the field checks can catch it;
//   - the deposit commits to the edited order while the quote shows the
//     honest one — the field checks pass, so only the commitment can catch it.
import assert from 'node:assert';
import fs from 'node:fs';
import {
  relayOrderId,
  relayOrderProblem,
  relayDepositCommitment,
  relayCommitmentProblem,
  relayBindingProblem,
  relayProtocolChainOf,
  RELAY_ORDER_EIP712_TYPES,
} from './.relayorder.mjs';

const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/relay-orders.json', import.meta.url), 'utf8'));
const SOL = '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce';
const EVM = '0x011F1bbac10Dcf1eFCe795C9e92391C40cbbDd0a';
const SOL_NATIVE = '11111111111111111111111111111111';
const EVM_NATIVE = '0x0000000000000000000000000000000000000000';
const EVIL_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVIL_SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const USDT_BNB = '0x55d398326f99059fF775485246999027B3197955';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const clone = (o) => JSON.parse(JSON.stringify(o));

const ROUTES = {
  'solana->bnb EXACT_INPUT': { to: 56, recipient: EVM, currency: EVM_NATIVE, evilTo: EVIL_EVM, token: USDT_BNB, otherChain: 'robinhood' },
  'solana->bnb EXACT_OUTPUT': { to: 56, recipient: EVM, currency: EVM_NATIVE, evilTo: EVIL_EVM, token: USDT_BNB, otherChain: 'robinhood' },
  'bnb->robinhood': { to: 4663, recipient: EVM, currency: EVM_NATIVE, evilTo: EVIL_EVM, token: USDT_BNB, otherChain: 'bnb' },
  'robinhood->solana': { to: 792703809, recipient: SOL, currency: SOL_NATIVE, evilTo: EVIL_SOL, token: USDC_SOL, otherChain: 'bnb' },
};
const QUOTES = [];
for (const [route, want] of Object.entries(ROUTES)) {
  for (const ep of ['quote/v2', 'quote']) QUOTES.push({ name: `${route} (${ep})`, q: FX[route][ep], want });
}
const expectOf = (q, want, extra = {}) => ({
  recipient: want.recipient,
  destinationChainId: want.to,
  destinationCurrency: want.currency,
  minOutRaw: BigInt(q.details.currencyOut.minimumAmount),
  refundRecipients: [SOL, EVM],
  ...extra,
});

/** Rewrite the id the deposit commits to (Solana data bytes 16..48 / EVM last calldata word). */
function recommit(q, id) {
  const d = q.steps[0].items[0].data;
  if (d.instructions) d.instructions[0].data = d.instructions[0].data.slice(0, 32) + id.slice(2);
  else d.data = d.data.slice(0, 74) + id.slice(2);
  return q;
}
const payment = (q) => q.protocol.v2.orderData.output.payments[0];

// ── the shape copied from the settlement SDK ───────────────────────────
{
  assert.deepEqual(Object.keys(RELAY_ORDER_EIP712_TYPES), ['Order', 'Input', 'InputPayment', 'InputRefund', 'Output', 'OutputPayment', 'Fee']);
  assert.equal(relayProtocolChainOf(792703809), 'solana');
  assert.equal(relayProtocolChainOf(56), 'bnb', "the protocol's name, not /chains' 'bsc'");
  assert.equal(relayProtocolChainOf(4663), 'robinhood');
  assert.equal(relayProtocolChainOf(8453), null, 'a chain this app does not bridge');
  console.log('ok  the EIP-712 type list and the protocol chain names are the measured ones');
}

// ── every real quote: the recomputed id is Relay's, and the deposit's ──
{
  for (const { name, q, want } of QUOTES) {
    const claimed = q.protocol.v2.orderId.toLowerCase();
    assert.equal(relayOrderId(q.protocol.v2.orderData), claimed, `${name}: the recomputed id is Relay's orderId`);
    assert.equal(relayDepositCommitment(q), claimed, `${name}: the deposit commits to it`);
    assert.equal(relayOrderProblem(q, expectOf(q, want)), null, `${name}: the order delivers what was asked`);
    assert.equal(relayCommitmentProblem(q), null, `${name}: the deposit is bound to the order`);
    assert.equal(relayBindingProblem(q, expectOf(q, want)), null, `${name}: both`);
    // minOutRaw / refunds / clock are optional.
    assert.equal(relayBindingProblem(q, { recipient: want.recipient, destinationChainId: want.to, destinationCurrency: want.currency }), null);
  }
  // EVM addresses compare as bytes: case does not matter.
  const bnb = FX['solana->bnb EXACT_INPUT']['quote/v2'];
  assert.equal(relayOrderProblem(bnb, expectOf(bnb, { ...ROUTES['solana->bnb EXACT_INPUT'], recipient: EVM.toLowerCase() })), null);
  // EXACT_OUTPUT: the floor is the exact amount asked for.
  const exact = FX['solana->bnb EXACT_OUTPUT']['quote/v2'];
  assert.equal(payment(exact).minimumAmount, '10000000000000000');
  assert.equal(relayOrderProblem(exact, expectOf(exact, ROUTES['solana->bnb EXACT_OUTPUT'], { minOutRaw: 10000000000000000n })), null);
  console.log(`ok  ${QUOTES.length} real quotes (4 routes x /quote/v2 + /quote): recomputed id == orderId == deposit commitment`);
}

// ── the quote's own orderId field is never trusted ─────────────────────
{
  for (const { name, q, want } of QUOTES) {
    const t = clone(q);
    t.protocol.v2.orderId = `0x${'ab'.repeat(32)}`;
    assert.equal(relayBindingProblem(t, expectOf(t, want)), null, `${name}: the claimed id is not read`);
  }
  console.log('ok  the quote\'s orderId field is ignored; only the recomputed id counts');
}

// ── tampering, field by field, three ways ──────────────────────────────
{
  const TAMPERS = {
    recipient: (o, want) => { o.output.payments[0].recipient = want.evilTo; },
    'output chain': (o, want) => { o.output.chainId = want.otherChain; },
    currency: (o, want) => { o.output.payments[0].currency = want.token; },
    minimumAmount: (o) => { o.output.payments[0].minimumAmount = '1'; },
  };
  let n = 0;
  for (const { name, q, want } of QUOTES) {
    for (const [field, edit] of Object.entries(TAMPERS)) {
      const ex = expectOf(q, want);

      // 1. The order is edited, nothing else.
      const a = clone(q);
      edit(a.protocol.v2.orderData, want);
      assert.notEqual(relayOrderProblem(a, ex), null, `${name}: edited ${field} is refused by the field check`);
      assert.notEqual(relayCommitmentProblem(a), null, `${name}: edited ${field} no longer matches the deposit`);
      assert.notEqual(relayBindingProblem(a, ex), null);

      // 2. A consistent lie: the deposit really commits to the edited order.
      let editedId = null;
      try {
        editedId = relayOrderId(a.protocol.v2.orderData);
      } catch {
        // The edit made the order unencodable (a base58 recipient on an EVM
        // chain) — it can never pass, which (1) already showed.
      }
      if (editedId) {
        const b = recommit(clone(a), editedId);
        assert.equal(relayCommitmentProblem(b), null, `${name}: ${field} lie is internally consistent`);
        assert.notEqual(relayOrderProblem(b, ex), null, `${name}: so only the field check refuses a ${field} lie`);
        assert.notEqual(relayBindingProblem(b, ex), null);

        // 3. The quote shows the honest order; the deposit commits to the edited one.
        const c = recommit(clone(q), editedId);
        assert.equal(relayOrderProblem(c, ex), null, `${name}: the shown order looks right`);
        const why = relayCommitmentProblem(c);
        assert.match(why ?? '', /commits to order/, `${name}: a deposit committing to another ${field} is refused`);
        assert.notEqual(relayBindingProblem(c, ex), null);
        assert.equal(relayDepositCommitment(c), editedId);
      }
      n++;
    }
  }
  console.log(`ok  ${n} tampers (recipient, chain, currency, minimumAmount x 8 quotes) refused: edited, consistent lie, hidden order`);
}

// ── the messages say what is wrong ─────────────────────────────────────
{
  const q = FX['solana->bnb EXACT_INPUT']['quote/v2'];
  const want = ROUTES['solana->bnb EXACT_INPUT'];
  const ex = expectOf(q, want);
  const t = (edit) => { const c = clone(q); edit(c.protocol.v2.orderData); return relayOrderProblem(c, ex); };
  assert.match(t((o) => { o.output.payments[0].recipient = EVIL_EVM; }), /delivers to 0x9858Ef…, not your address/);
  assert.match(t((o) => { o.output.chainId = 'robinhood'; }), /delivers on robinhood, not bnb/);
  assert.match(t((o) => { o.output.payments[0].currency = USDT_BNB; }), /not the coin asked for/);
  assert.match(t((o) => { o.output.payments[0].minimumAmount = '1'; }), /guarantees 1, less than/);
  assert.match(t((o) => { o.output.payments[0].minimumAmount = '0'; }), /guarantees nothing/);
  // A zero floor is refused even when no minOutRaw is given.
  const z = clone(q);
  z.protocol.v2.orderData.output.payments[0].minimumAmount = '0';
  assert.match(relayOrderProblem(z, { recipient: EVM, destinationChainId: 56, destinationCurrency: EVM_NATIVE }), /guarantees nothing/);
  // Asked for a different destination than the order serves.
  assert.match(relayOrderProblem(q, { ...ex, destinationChainId: 4663 }), /delivers on bnb, not robinhood/);
  assert.match(relayOrderProblem(q, { ...ex, destinationChainId: 8453 }), /not one this app bridges to/);
  assert.match(relayOrderProblem(q, { ...ex, recipient: 'not-an-address' }), /is not an address on bnb/);
  // A Solana recipient is exact base58: another case is another key.
  const rs = FX['robinhood->solana']['quote/v2'];
  const rsEx = expectOf(rs, ROUTES['robinhood->solana']);
  assert.notEqual(relayOrderProblem(rs, { ...rsEx, recipient: SOL.toLowerCase() }), null);
  assert.notEqual(relayOrderProblem(rs, { ...rsEx, recipient: EVIL_SOL }), null);
  console.log('ok  each refusal names the field that is wrong');
}

// ── shapes nobody measured are refused ─────────────────────────────────
{
  const q = FX['bnb->robinhood']['quote/v2'];
  const ex = expectOf(q, ROUTES['bnb->robinhood']);
  const t = (edit) => { const c = clone(q); edit(c); return relayBindingProblem(c, ex); };
  assert.match(t((c) => { delete c.protocol; }), /protocol data missing/);
  assert.match(t((c) => { c.protocol.v2.orderData.version = 'v2'; }), /not the measured v1/);
  assert.match(t((c) => { c.protocol.v2.orderData.output.payments.push({ ...payment(c), recipient: EVIL_EVM }); }), /pays 2 recipients/);
  assert.match(t((c) => { c.protocol.v2.orderData.output.calls.push('0xdeadbeef'); }), /runs calls/);
  assert.match(t((c) => {
    c.protocol.v2.orderData.fees.push({ recipientChainId: 'bnb', recipient: EVIL_EVM, currencyChainId: 'bnb', currency: EVM_NATIVE, amount: '1' });
  }), /pays fees/);
  assert.match(t((c) => { c.protocol.v2.orderData.inputs[0].refunds[0].chainId = 'base'; }), /chain "base", which this app does not bridge/);
  assert.match(t((c) => { c.protocol.v2.orderData.output.payments[0].minimumAmount = '1e18'; }), /not a whole number/);
  assert.match(t((c) => { c.protocol.v2.orderData.salt = 'zz'; }), /salt is not a whole number/);
  assert.match(t((c) => { c.protocol.v2.orderData.output.extraData = '0x123'; }), /not hex bytes/);
  assert.throws(() => relayOrderId({ version: 'v1' }), /solver chain is missing/);
  const noOutput = clone(q.protocol.v2.orderData);
  delete noOutput.output;
  assert.throws(() => relayOrderId(noOutput), /no output/);
  assert.throws(() => relayOrderId(null), /no order/);
  console.log('ok  missing protocol data, other versions, extra payments, calls, fees, unknown chains, malformed numbers: refused');
}

// ── refunds and expiry, when asked ─────────────────────────────────────
{
  for (const { name, q, want } of QUOTES) {
    const ex = expectOf(q, want);
    const r = clone(q);
    const ref = r.protocol.v2.orderData.inputs[0].refunds.find((x) => x.chainId !== 'solana');
    ref.recipient = EVIL_EVM;
    assert.match(relayOrderProblem(r, ex) ?? '', /refunds to an address on .* that is not yours/, `${name}: a refund to someone else`);
    assert.equal(relayOrderProblem(r, { ...ex, refundRecipients: undefined }), null, 'refunds unchecked when not asked');
    assert.notEqual(relayCommitmentProblem(r), null, `${name}: and the edited refund breaks the commitment anyway`);
    const deadline = q.protocol.v2.orderData.output.deadline;
    assert.equal(relayOrderProblem(q, { ...ex, nowSec: deadline - 1 }), null);
    assert.equal(relayOrderProblem(q, { ...ex, nowSec: deadline }), 'the order has expired');
  }
  console.log('ok  refunds to anyone else and an expired order are refused when asked');
}

// ── the deposit itself ─────────────────────────────────────────────────
{
  for (const { name, q } of QUOTES) {
    // Any commitment but the order's is refused.
    const flip = clone(q);
    const id = relayDepositCommitment(q);
    recommit(flip, `0x${id.slice(2, 64)}${id.slice(64) === '00' ? '01' : '00'}`);
    assert.notEqual(relayDepositCommitment(flip), id);
    assert.match(relayCommitmentProblem(flip) ?? '', /commits to order/, `${name}: a different commitment`);

    // The id does not cover what moves: the amount is checked separately.
    const more = clone(q);
    const d = more.steps[0].items[0].data;
    if (d.instructions) {
      const amt = BigInt(q.protocol.v2.orderData.inputs[0].payment.amount) + 1n;
      let le = '';
      for (let i = 0n; i < 8n; i++) le += ((amt >> (8n * i)) & 0xffn).toString(16).padStart(2, '0');
      d.instructions[0].data = d.instructions[0].data.slice(0, 16) + le + d.instructions[0].data.slice(32);
    } else {
      d.value = (BigInt(d.value) + 1n).toString();
    }
    assert.match(relayCommitmentProblem(more) ?? '', /the deposit moves \d+, but the order is paid \d+/, `${name}: a deposit of another amount`);

    // A deposit to anything but the pinned depository has no readable commitment.
    const elsewhere = clone(q);
    const e = elsewhere.steps[0].items[0].data;
    if (e.instructions) e.instructions[0].programId = EVIL_SOL;
    else e.to = EVIL_EVM;
    assert.equal(relayDepositCommitment(elsewhere), null);
    assert.match(relayCommitmentProblem(elsewhere), /no commitment this app can read/);

    // Two steps is not the measured shape.
    const twoSteps = clone(q);
    twoSteps.steps.push(clone(twoSteps.steps[0]));
    assert.equal(relayDepositCommitment(twoSteps), null);
  }
  // The order paid on another chain than the deposit's.
  const q = clone(FX['bnb->robinhood']['quote/v2']);
  q.protocol.v2.orderData.inputs[0].payment.chainId = 'robinhood';
  recommit(q, relayOrderId(q.protocol.v2.orderData));
  assert.match(relayCommitmentProblem(q), /paid on robinhood, not the chain the deposit is on/);
  // The order paid in a token while the deposit sends the native coin.
  const tok = clone(FX['bnb->robinhood']['quote/v2']);
  tok.protocol.v2.orderData.inputs[0].payment.currency = USDT_BNB;
  recommit(tok, relayOrderId(tok.protocol.v2.orderData));
  assert.match(relayCommitmentProblem(tok), /paid in a token/);
  console.log('ok  the deposit must commit to the order, pay its exact input on its chain, to the pinned depository');
}

console.log('relayorder: all passed');
