// Token-2022 mint extensions — the bytes that tell a spam airdrop from a coin.
//
// Fixture: two REAL mint accounts captured 2026-09-07. `spam` is
// GNhCph…pump — a Token-2022 mint with a vanity `pump` suffix, a 3.96M
// supply, a PermanentDelegate and an advertisement for a name, airdropped
// into a user's wallet; the app showed it as a "previous run" holding and
// every sell route refused it. `pump` is a genuine pump.fun create_v2 mint
// (Token-2022 too — the token program alone proves nothing).

import assert from 'node:assert';
import fs from 'node:fs';
import { parseMintExtensions, mintWarning } from './.mintextensions.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/mint-extensions.json', import.meta.url), 'utf8'));
const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('a spam airdrop mint names its permanent delegate and carries its advertisement', () => {
  const ext = parseMintExtensions(bytes(FIXTURE.spam.dataB64));
  assert.ok(ext, 'parses as a Token-2022 mint');
  assert.equal(ext.permanentDelegate, 'sWicthYFXXjnUQMujs4mZqH1p9WynTVGppuSqyBJBwU');
  assert.equal(ext.nonTransferable, false);
  assert.equal(ext.transferHook, null);
  assert.ok(ext.name && ext.name.includes('PUMPAPI.IO'), `name is the advertisement: ${ext.name}`);
  const warning = mintWarning(ext);
  assert.ok(warning && /permanent delegate/.test(warning) && /airdrop/.test(warning), warning);
});

test('a real pump.fun Token-2022 mint carries nothing suspicious', () => {
  const ext = parseMintExtensions(bytes(FIXTURE.pump.dataB64));
  assert.ok(ext, 'parses as a Token-2022 mint');
  assert.equal(ext.permanentDelegate, null);
  assert.equal(ext.nonTransferable, false);
  assert.equal(ext.transferHook, null);
  assert.equal(mintWarning(ext), null, 'no warning on a genuine coin');
});

test('a classic 82-byte SPL mint has no extensions and no warning', () => {
  const ext = parseMintExtensions(new Uint8Array(82));
  assert.ok(ext);
  assert.equal(mintWarning(ext), null);
});

test('a non-transferable mint is called out ahead of anything else', () => {
  // Hand-built: 165 bytes of base+padding, account type 1, then a
  // PermanentDelegate TLV and a NonTransferable TLV.
  const d = Buffer.alloc(166 + 4 + 32 + 4);
  d[165] = 1;
  d.writeUInt16LE(12, 166);
  d.writeUInt16LE(32, 168);
  d.fill(7, 170, 202);
  d.writeUInt16LE(9, 202);
  d.writeUInt16LE(0, 204);
  const ext = parseMintExtensions(d);
  assert.ok(ext.permanentDelegate);
  assert.equal(ext.nonTransferable, true);
  assert.ok(/non-transferable/.test(mintWarning(ext)));
});

test('a token ACCOUNT (not a mint) and a truncated tail never throw', () => {
  const acct = Buffer.alloc(170);
  acct[165] = 2; // account type: token account
  assert.equal(parseMintExtensions(acct), null);
  const trunc = Buffer.from(bytes(FIXTURE.spam.dataB64)).subarray(0, 300);
  assert.doesNotThrow(() => parseMintExtensions(trunc));
});

for (const c of cases) {
  try {
    c.fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${c.name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`mintextensions: ${passed}/${cases.length} passed`);
