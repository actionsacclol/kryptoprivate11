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

test('the TokenMetadata extension yields the name, the symbol AND the uri', () => {
  // Hand-built: base+padding, account type 1, then one TokenMetadata TLV —
  // update_authority 32 · mint 32 · name · symbol · uri (u32-length strings).
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const body = Buffer.concat([Buffer.alloc(64), str('Source'), str('SOURCE'), str('https://ipfs.io/ipfs/bafkreifperm6h64s2pan3jgsq2p6xbxlqf2tnwbd65bs44vzabsoqmp254'), Buffer.alloc(4)]);
  const head = Buffer.alloc(166);
  head[165] = 1;
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(body.length, 2);
  const ext = parseMintExtensions(Buffer.concat([head, tlv, body]));
  assert.ok(ext);
  assert.equal(ext.name, 'Source');
  assert.equal(ext.symbol, 'SOURCE');
  // Until 2026-09-20 the walk stopped at the symbol; 94BZEtg9…pump (a
  // runner flag with an X and a website on pump.fun) had neither in the app.
  assert.equal(ext.uri, 'https://ipfs.io/ipfs/bafkreifperm6h64s2pan3jgsq2p6xbxlqf2tnwbd65bs44vzabsoqmp254');
  assert.equal(mintWarning(ext), null);
  // A uri whose length prefix claims more bytes than the extension holds is
  // no uri at all, rather than junk — the name and symbol before it stand.
  const claim = Buffer.alloc(4);
  claim.writeUInt32LE(200, 0);
  const shortBody = Buffer.concat([Buffer.alloc(64), str('Source'), str('SOURCE'), claim, Buffer.from('https://', 'utf8')]);
  const shortTlv = Buffer.alloc(4);
  shortTlv.writeUInt16LE(19, 0);
  shortTlv.writeUInt16LE(shortBody.length, 2);
  const partial = parseMintExtensions(Buffer.concat([head, shortTlv, shortBody]));
  assert.ok(partial);
  assert.equal(partial.name, 'Source');
  assert.equal(partial.uri, null);
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
