// wallets.json holds the ONLY copy of every encrypted key. A file that
// cannot be read must never be mistaken for "this install has no wallets",
// because the next write would replace the keys with an empty file.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-wallet-'));
process.env.KRYPT_TEST_USERDATA = dir;
const walletFile = path.join(dir, 'wallets.json');

const fresh = async (tag) => import(`./.wallet.mjs?${tag}`);

{
  // A first run: no file at all is genuinely empty, and writing is allowed.
  const w = await fresh('empty');
  assert.equal(w.failure(), null);
  assert.equal(w.list().length, 0);
  const r = w.generate('first');
  assert.equal(r.ok, true, r.message);
  assert.ok(fs.existsSync(walletFile), 'the wallet file was written');
  console.log('ok  a missing file is a normal first run');
}

const good = fs.readFileSync(walletFile, 'utf8');
const keysBefore = JSON.parse(good).wallets.map((x) => x.publicKey);
assert.equal(keysBefore.length, 1);

{
  // The file is present but unreadable as JSON. The store must refuse.
  fs.writeFileSync(walletFile, '{ this is not json');
  const w = await fresh('corrupt');
  assert.match(w.failure() ?? '', /corrupt/i, 'the failure is reported');
  assert.equal(w.list().length, 0, 'no wallets are claimed while unreadable');
  const r = w.generate('should-not-write');
  assert.equal(r.ok, false, 'creating a wallet is refused');
  assert.match(r.message, /refusing to write|could not|corrupt/i);
  assert.equal(fs.readFileSync(walletFile, 'utf8'), '{ this is not json', 'the bytes are untouched');
  console.log('ok  a corrupt file is never overwritten, and the store says why');
}

{
  // Shape the parser rejects — same rule, since real keys may be inside.
  fs.writeFileSync(walletFile, JSON.stringify({ version: 99, wallets: 'nope' }));
  const w = await fresh('badshape');
  assert.ok(w.failure(), 'an unparseable shape is a failure, not an empty set');
  assert.equal(w.list().length, 0);
  assert.equal(w.generate('nope').ok, false);
  console.log('ok  an unrecognised shape is treated as unreadable, not as empty');
}

{
  // Restore the good file: the store recovers with the keys intact.
  fs.writeFileSync(walletFile, good);
  const w = await fresh('recovered');
  assert.equal(w.failure(), null);
  assert.deepEqual(w.list().map((x) => x.publicKey), keysBefore, 'the original key is back');
  assert.equal(w.generate('second').ok, true, 'writing works again');
  console.log('ok  once the file reads again, the keys are intact and writing resumes');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('walletintegrity: all tests passed');
