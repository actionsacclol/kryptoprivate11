// Automatic decoder re-verification after a pump program redeploy.
//
// Background (2026-09-09): pump redeployed at slot 445691021. The watchdog
// correctly paused entries — and there was no way back. `acceptCurrent()` had
// no caller, `hardPauseReason` is never assigned null, and the baseline kept
// the old slot, so live buys were disabled permanently and across restarts,
// recoverable only by deleting program-baseline.json by hand.
//
// The property this suite defends is NOT "the pause can be lifted". It is
// "the pause is lifted ONLY when the decoder was actually re-read from chain
// and still matches". Every way of failing to know must keep the pause on,
// because a false clear re-arms a build whose instruction layout may be wrong.

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { verifyDecoder } from './.decoderverify.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const MINT = 'CopyMint111111111111111111111111111111111';
const RPC = 'https://rpc.example.invalid';
const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
const SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');

const anchorDisc = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

/** A Global account that parses: disc, fee recipient @41, reserved @483, an
 *  off-curve vault @965. 1045 bytes, as pump ships it. */
function goodGlobal() {
  const d = Buffer.alloc(1045);
  anchorDisc('Global').copy(d, 0);
  Buffer.alloc(32, 7).copy(d, 41);
  Buffer.alloc(32, 9).copy(d, 483);
  // Must be non-zero and OFF the ed25519 curve. All-0xFF is not a valid point.
  Buffer.alloc(32, 0xff).copy(d, 965);
  return d;
}

/** A bonding curve that parses, with non-zero reserves. */
function goodCurve() {
  const d = Buffer.alloc(151);
  anchorDisc('BondingCurve').copy(d, 0);
  d.writeBigUInt64LE(1_000_000_000n, 8); // virtual token
  d.writeBigUInt64LE(30_000_000_000n, 16); // virtual sol
  Buffer.alloc(32, 3).copy(d, 49); // creator
  return d;
}

/**
 * A fake RPC. `over` replaces individual responses so a test can break exactly
 * one thing and prove that alone keeps the pause on.
 */
function rpc(over = {}) {
  const calls = { accounts: [], sigs: 0, txs: 0 };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    // getAccountInfo answers under `value`; getTransaction answers directly.
    const acct = (data) => ({ context: { slot: 1 }, value: { owner: '11111111111111111111111111111111', lamports: 1, data: [data.toString('base64'), 'base64'], executable: false, rentEpoch: 0 } });

    if (body.method === 'getAccountInfo') {
      const addr = body.params[0];
      calls.accounts.push(addr);
      if (over.accountInfo) {
        const r = over.accountInfo(addr, calls.accounts.length);
        if (r !== undefined) return reply(r);
      }
      // Global is a 1045-byte account; anything else asked for here is a curve.
      const data = addr === calls.accounts[0] ? goodGlobal() : goodCurve();
      return reply(acct(data));
    }
    if (body.method === 'getSignaturesForAddress') {
      calls.sigs += 1;
      if (over.signatures) return reply(over.signatures());
      return reply([{ signature: 'sig1', err: null, slot: 1, blockTime: 1 }]);
    }
    if (body.method === 'getTransaction') {
      calls.txs += 1;
      if (over.transaction) return reply(over.transaction());
      return reply(tradeTx(BUY_DISC));
    }
    return reply(null);
  };
  return calls;
}

/** A confirmed transaction carrying one pump instruction with `disc`. */
function tradeTx(disc, accounts = 16) {
  const data = Buffer.concat([disc, Buffer.alloc(16)]);
  return {
    slot: 1,
    meta: {
      err: null,
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      message: {
        accountKeys: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
        instructions: [{ programIdIndex: 0, accounts: Array.from({ length: accounts }, () => 0), data: b58(data) }],
      },
    },
  };
}

test('a program that still matches this build clears every check', async () => {
  rpc();
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, true, v.summary);
  assert.deepEqual(v.checks.map((c) => c.name).sort(), ['curve-layout', 'global-layout', 'trade-interface']);
  assert.ok(v.checks.every((c) => c.pass));
});

test('a reshaped Global keeps the pause on', async () => {
  // Same length, wrong discriminator: parseGlobal falls back and fromChain
  // goes false, which is the signal that the offsets moved.
  rpc({
    accountInfo: (addr) => {
      const d = goodGlobal();
      d.fill(0, 0, 8);
      return { context: { slot: 1 }, value: { owner: '1', lamports: 1, data: [d.toString('base64'), 'base64'], executable: false, rentEpoch: 0 } };
    },
  });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, false);
  const g = v.checks.find((c) => c.name === 'global-layout');
  assert.equal(g.pass, false);
  assert.match(g.detail, /offsets this build expects/);
});

test('a curve that no longer parses keeps the pause on', async () => {
  rpc({
    accountInfo: (_addr, nth) => {
      if (nth === 1) return undefined; // Global: fine
      const d = goodCurve();
      d.fill(0, 0, 8); // wrong discriminator
      return { context: { slot: 1 }, value: { owner: '1', lamports: 1, data: [d.toString('base64'), 'base64'], executable: false, rentEpoch: 0 } };
    },
  });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.name === 'curve-layout').pass, false);
});

test('a trade whose discriminator this build does not know keeps the pause on', async () => {
  // The load-bearing case: pump changed the instruction. Everything else can
  // look fine and this must still refuse.
  rpc({ transaction: () => tradeTx(Buffer.from('deadbeefdeadbeef', 'hex')) });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, false);
  const t = v.checks.find((c) => c.name === 'trade-interface');
  assert.equal(t.pass, false);
  assert.match(t.detail, /none carried a discriminator this build knows/);
});

test('a sell discriminator verifies just as well as a buy', async () => {
  rpc({ transaction: () => tradeTx(SELL_DISC) });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, true, v.summary);
  assert.match(v.checks.find((c) => c.name === 'trade-interface').detail, /sell/);
});

test('an RPC that will not answer is NOT a pass', async () => {
  globalThis.fetch = async () => new Response('gateway timeout', { status: 504 });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, false, 'could not verify is never verified');
  assert.ok(v.checks.every((c) => !c.pass));
});

test('no recent mint to sample is NOT a pass', async () => {
  rpc();
  const v = await verifyDecoder(RPC, []);
  assert.equal(v.ok, false);
  assert.match(v.checks.find((c) => c.name === 'curve-layout').detail, /no recent pump mint/);
});

test('a FAILED transaction is never used as evidence', async () => {
  // A reverted trade says nothing about the interface — it could have failed
  // for any reason. With only failures available the check must not pass.
  rpc({ signatures: () => [{ signature: 'bad', err: { InstructionError: [3, { Custom: 6024 }] }, slot: 1, blockTime: 1 }] });
  const v = await verifyDecoder(RPC, [MINT]);
  assert.equal(v.ok, false);
  assert.match(v.checks.find((c) => c.name === 'trade-interface').detail, /could not read any recent pump transaction/);
});

const run = async () => {
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`ok  ${c.name}`);
    } catch (e) {
      console.log(`FAIL ${c.name}\n  ${e.message}`);
    }
  }
  console.log(`decoderverify: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
};

await run();
