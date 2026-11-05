// The rules behind the app password, authenticator codes and the proof gate:
// the crypto against published vectors, the state machine, and pins on the
// source for the things only a running app could otherwise show.

import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = await import('./.vaultharness.mjs');
const { crypto_: c, keyExport: kx } = h;
const totp = await import('./.totp.mjs');
const { qrEncode, QR_MAX_BYTES } = await import('./.qr.mjs');
const policy = await import('./.securitypolicy.mjs');

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ── Crypto ─────────────────────────────────────────────────────────────

test('sealed data opens only with the right key and the right binding', () => {
  const key = randomBytes(32);
  const blob = c.aesSeal(key, Buffer.from('secret'), 'wallet:sol:AAA');
  assert.equal(c.aesOpen(key, blob, 'wallet:sol:AAA').toString(), 'secret');
  assert.throws(() => c.aesOpen(randomBytes(32), blob, 'wallet:sol:AAA'), 'a wrong key');
  assert.throws(() => c.aesOpen(key, blob, 'wallet:sol:BBB'), 'one wallet ciphertext pasted onto another');
  const flipped = Buffer.from(blob);
  flipped[14] ^= 1;
  assert.throws(() => c.aesOpen(key, flipped, 'wallet:sol:AAA'), 'a changed byte');
  assert.throws(() => c.aesOpen(key, Buffer.alloc(10), 'x'), /too short/);
});

test('two seals of the same thing never match', () => {
  const key = randomBytes(32);
  assert.notDeepEqual(c.aesSeal(key, Buffer.from('x'), 'a'), c.aesSeal(key, Buffer.from('x'), 'a'));
});

test('scrypt parameters are bounded before any memory is asked for', () => {
  const ok = c.newKdfParams(2 ** 18);
  assert.equal(c.kdfParamsOk(ok, 'vault'), true);
  assert.equal(c.kdfParamsOk({ ...ok, N: 2 ** 20 }, 'vault'), true);
  assert.equal(c.kdfParamsOk({ ...ok, N: 2 ** 21 }, 'vault'), false);
  assert.equal(c.kdfParamsOk({ ...ok, N: 2 ** 20 }, 'file'), false, 'a file from outside gets a lower ceiling');
  assert.equal(c.kdfParamsOk({ ...ok, N: 2 ** 10 }, 'vault'), false);
  assert.equal(c.kdfParamsOk({ ...ok, N: 3000 }, 'vault'), false, 'not a power of two');
  assert.equal(c.kdfParamsOk({ ...ok, r: 64 }, 'vault'), false);
  assert.equal(c.kdfParamsOk({ ...ok, p: 16 }, 'vault'), false);
  assert.equal(c.kdfParamsOk({ ...ok, salt: 'c2hvcnQ=' }, 'vault'), false);
  assert.equal(c.kdfParamsOk({ ...ok, alg: 'md5' }, 'vault'), false);
  assert.equal(c.kdfParamsOk(null, 'vault'), false);
});

test('a password is judged on length, not on composition', () => {
  assert.ok(c.passwordProblem('short'));
  assert.ok(c.passwordProblem('password1234'));
  assert.ok(c.passwordProblem('aaaaaaaaaaaaaaaa'));
  assert.equal(c.passwordProblem('my dog eats socks'), null);
});

test('recovery codes are 125 bits, and forgiving about how they are typed', () => {
  const code = c.newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  assert.equal(c.normaliseCode(code.toLowerCase(), 25), code.replace(/-/g, ''));
  assert.equal(c.normaliseCode(` ${code.replace(/-/g, ' ')} `, 25), code.replace(/-/g, ''));
  assert.equal(c.normaliseCode('O0IL1'.repeat(5), 25), '00111'.repeat(5), 'O reads as 0, I and L as 1');
  assert.equal(c.normaliseCode('short', 25), null);
  assert.equal(c.normaliseCode('U'.repeat(25), 25), null, 'U is not in the alphabet');
  const many = new Set(Array.from({ length: 200 }, () => c.newRecoveryCode()));
  assert.equal(many.size, 200);
});

// ── TOTP ───────────────────────────────────────────────────────────────

test('authenticator codes match RFC 6238', () => {
  const secret = Buffer.from('12345678901234567890');
  // The RFC's SHA-1 vectors are 8 digits.
  for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totp.hotp(secret, totp.stepAt(time * 1000), 8), code, `time ${time}`);
  }
  assert.equal(totp.hotp(secret, totp.stepAt(59_000)), '287082', 'and six digits, as the apps show');
});

test('base32 round-trips, and matches RFC 4648', () => {
  assert.equal(totp.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(totp.base32Decode('mzxw 6ytb oi').toString(), 'foobar');
  const r = randomBytes(20);
  assert.ok(totp.base32Decode(totp.base32Encode(r)).equals(r));
  assert.equal(totp.newTotpSecret().length, 32);
});

test('a code works one step either side, and never twice', () => {
  const s = totp.newTotpSecret();
  const raw = totp.base32Decode(s);
  const now = 1_700_000_000_000;
  const step = totp.stepAt(now);
  assert.equal(totp.matchStep(s, totp.hotp(raw, step), now, -1), step);
  assert.equal(totp.matchStep(s, totp.hotp(raw, step - 1), now, -1), step - 1);
  assert.equal(totp.matchStep(s, totp.hotp(raw, step + 1), now, -1), step + 1);
  assert.equal(totp.matchStep(s, totp.hotp(raw, step + 2), now, -1), null, 'too far ahead');
  assert.equal(totp.matchStep(s, totp.hotp(raw, step - 2), now, -1), null, 'too old');
  assert.equal(totp.matchStep(s, totp.hotp(raw, step), now, step), null, 'the same code cannot be used again');
  assert.equal(totp.matchStep(s, totp.hotp(raw, step - 1), now, step), null, 'nor an older one after a newer');
  assert.equal(totp.matchStep(s, 'abcdef', now, -1), null);
  assert.equal(totp.matchStep(s, '12345', now, -1), null);
});

test('wrong codes lock out, doubling to an hour', () => {
  assert.deepEqual([4, 5, 6, 7, 8, 9, 20].map((n) => totp.lockoutMs(n) / 60_000), [0, 5, 10, 20, 40, 60, 60]);
});

test('the setup link is what authenticator apps read', () => {
  assert.equal(
    totp.otpauthUrl('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'my profile'),
    'otpauth://totp/Krypto%20Bot:my%20profile?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Krypto%20Bot&algorithm=SHA1&digits=6&period=30',
  );
});

// ── QR ─────────────────────────────────────────────────────────────────

test('the QR encoder still draws what an independent decoder read', () => {
  // Every length from 1 to 213 bytes was scanned by jsQR when this was written.
  // That decoder is not a dependency of the app, so the output is pinned to it.
  const pin = 'otpauth://totp/Krypto%20Bot:default?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Krypto%20Bot&algorithm=SHA1&digits=6&period=30';
  const m = qrEncode(pin);
  const flat = m.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('\n');
  assert.equal(m.length, 49);
  assert.equal(createHash('sha256').update(flat).digest('hex'), '39b672c326c14b0874943269723ae38d4d969806b00f36f4f1e96ef6191cea24');
  assert.equal(QR_MAX_BYTES, 213);
  assert.throws(() => qrEncode('x'.repeat(QR_MAX_BYTES + 1)), /too long/);
});

// ── Backup file format ─────────────────────────────────────────────────

const PAYLOAD = { solana: [{ label: 'a', publicKey: 'PUB', secret: 'SEC', homeAddress: null, maxBalanceSol: 1 }], evm: [], aio: null };

test('a key backup refuses tampering, wrong passwords, and hostile settings', async () => {
  const text = await kx.encryptBackup(PAYLOAD, 'file password here', '1.0.0');
  const f = JSON.parse(text);
  assert.ok(!text.includes('PUB') && !text.includes('SEC'), 'nothing in the clear');
  assert.equal((await kx.decryptBackup(text, 'file password here')).ok, true);
  assert.equal((await kx.decryptBackup(text, 'not the password!!')).reason, 'wrong-password');
  // The header is bound in, so editing it fails like a changed byte.
  assert.equal((await kx.decryptBackup(JSON.stringify({ ...f, app: '6.6.6' }), 'file password here')).ok, false);
  const ct = Buffer.from(f.ct, 'base64');
  ct[20] ^= 1;
  assert.equal((await kx.decryptBackup(JSON.stringify({ ...f, ct: ct.toString('base64') }), 'file password here')).ok, false);
  // A crafted file must be refused before scrypt asks for 16 GB.
  const started = Date.now();
  const hostile = await kx.decryptBackup(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 ** 27 } }), 'x');
  assert.equal(hostile.reason, 'not-a-backup');
  assert.ok(Date.now() - started < 500);
  assert.equal((await kx.decryptBackup('not json', 'x')).reason, 'not-a-backup');
  assert.equal((await kx.decryptBackup('{"format":"other"}', 'x')).reason, 'not-a-backup');
});

test('a backup in a folder that syncs elsewhere is named', () => {
  assert.equal(kx.cloudSyncedPath('C:\\Users\\a\\OneDrive\\Documents\\k.kryptkeys'), 'OneDrive');
  assert.equal(kx.cloudSyncedPath('C:\\Users\\a\\OneDrive - Acme\\k.kryptkeys'), 'OneDrive');
  assert.equal(kx.cloudSyncedPath('/Users/a/Dropbox/k.kryptkeys'), 'Dropbox');
  assert.equal(kx.cloudSyncedPath('C:\\Users\\a\\Desktop\\k.kryptkeys'), null);
});

// ── Vault against a real file ──────────────────────────────────────────

async function freshVault() {
  process.env.KRYPT_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-sec-'));
  process.env.KRYPT_TEST_DPAPI_FAIL = '';
  h.vault.__resetForTest();
  h.securityState.__resetForTest();
  const p = await h.vault.prepare('correct horse battery');
  return { p, dir: process.env.KRYPT_TEST_USERDATA };
}

test('a lost OS key is told apart from a wrong password', async () => {
  const { p } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  h.vault.__resetForTest();
  assert.equal((await h.vault.unlock('nope nope nope')).reason, 'wrong-password');
  process.env.KRYPT_TEST_DPAPI_FAIL = '1';
  const r = await h.vault.unlock('correct horse battery');
  assert.equal(r.reason, 'os-key-lost');
  assert.match(r.message, /recovery code/);
  // And the recovery code gets back in: it never depended on the OS key store.
  const sealedBefore = h.vault.isSealed();
  assert.equal(sealedBefore, true);
  const rec = await h.vault.prepareRecovery(p.recoveryCode, 'a brand new password');
  assert.equal(rec.ok, true, rec.message);
  rec.commit();
  h.vault.__resetForTest();
  assert.equal((await h.vault.unlock('a brand new password')).ok, true, 'and the new password works on this Windows account');
  process.env.KRYPT_TEST_DPAPI_FAIL = '';
});

test('recovery changes nothing until the new code is confirmed', async () => {
  const { p } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  h.vault.__resetForTest();
  assert.equal((await h.vault.prepareRecovery('0'.repeat(25), 'a brand new password')).reason, 'wrong-password');
  const rec = await h.vault.prepareRecovery(p.recoveryCode, 'a brand new password');
  assert.equal(rec.ok, true);
  // Walked away: the old password and the old code both still work.
  assert.equal(h.vault.status(), 'sealed');
  h.vault.__resetForTest();
  assert.equal((await h.vault.unlock('correct horse battery')).ok, true);
  rec.commit();
  h.vault.__resetForTest();
  assert.equal((await h.vault.unlock('correct horse battery')).reason, 'wrong-password');
  assert.equal((await h.vault.unlock('a brand new password')).ok, true);
  h.vault.__resetForTest();
  assert.equal((await h.vault.prepareRecovery(p.recoveryCode, 'one more new password')).reason, 'wrong-password', 'the old code is spent');
  assert.equal((await h.vault.prepareRecovery(rec.recoveryCode, 'one more new password')).ok, true);
});

test('changing the password leaves the old one in no backup', async () => {
  const { p, dir } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')).password.dpapiSealed;
  await h.vault.changePassword('a different password');
  for (const n of ['vault.json', 'vault.json.bak']) assert.ok(!fs.readFileSync(path.join(dir, n), 'utf8').includes(before), n);
  assert.equal((await h.vault.checkPassword('a different password')).ok, true);
  assert.equal((await h.vault.checkPassword('correct horse battery')).ok, false);
});

test('checking the password never replaces the key in memory', async () => {
  const { p } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  const sealed = h.vault.seal(Buffer.from('x'), 'b');
  await h.vault.checkPassword('wrong wrong wrong');
  assert.equal(h.vault.open(sealed, 'b').toString(), 'x');
  await h.vault.checkPassword('correct horse battery');
  assert.equal(h.vault.open(sealed, 'b').toString(), 'x');
});

test('starting fresh moves everything aside and deletes nothing', async () => {
  const { p, dir } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  fs.writeFileSync(path.join(dir, 'wallets.json'), '{"keep":"me"}');
  h.vault.__resetForTest();
  const aside = h.vault.setAsideLockedVault('2026-11-04');
  assert.equal(h.vault.status(), 'none');
  assert.equal(fs.readFileSync(path.join(aside, 'wallets.json'), 'utf8'), '{"keep":"me"}');
  assert.ok(fs.existsSync(path.join(aside, 'vault.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'vault.json')));
});

// ── 2FA state ──────────────────────────────────────────────────────────

async function with2fa() {
  const { p, dir } = await freshVault();
  h.vault.beginEnable(p);
  h.vault.commitEnable();
  h.securityState.initForNewVault();
  const secret = totp.newTotpSecret();
  const now = Date.now();
  const r = h.securityState.prepareEnable(secret, totp.hotp(totp.base32Decode(secret), totp.stepAt(now)), now);
  assert.equal(r.ok, true);
  return { secret, now, backupCodes: r.backupCodes, commit: r.commit, dir };
}

test('2FA is off until the backup codes have been seen', async () => {
  const { commit } = await with2fa();
  assert.equal(h.securityState.totpOn(), false, 'a good scan alone does not turn it on');
  commit();
  assert.equal(h.securityState.totpOn(), true);
  assert.equal(h.securityState.backupCodesLeft(), policy.BACKUP_CODE_COUNT);
});

test('a code is spent on disk, so a restart cannot reuse it', async () => {
  const { secret, now, commit } = await with2fa();
  commit();
  const next = totp.hotp(totp.base32Decode(secret), totp.stepAt(now) + 1);
  assert.equal(h.securityState.verifyCode(next, now).ok, true);
  h.securityState.__resetForTest();
  assert.equal(h.securityState.verifyCode(next, now).ok, false);
});

test('a backup code works once', async () => {
  const { backupCodes, commit, now } = await with2fa();
  commit();
  assert.equal(h.securityState.verifyCode(backupCodes[0].toLowerCase(), now).ok, true);
  assert.equal(h.securityState.verifyCode(backupCodes[0], now).ok, false);
  assert.equal(h.securityState.backupCodesLeft(), policy.BACKUP_CODE_COUNT - 1);
});

test('five wrong codes lock it, even with the right one next, and the lock survives a restart', async () => {
  const { secret, now, commit } = await with2fa();
  commit();
  for (let i = 0; i < 5; i++) assert.equal(h.securityState.verifyCode('000000', now).ok, false);
  const good = totp.hotp(totp.base32Decode(secret), totp.stepAt(now) + 1);
  assert.match(h.securityState.verifyCode(good, now).message, /Too many/);
  h.securityState.__resetForTest();
  assert.match(h.securityState.verifyCode(good, now).message, /Too many/);
  const later = now + 6 * 60_000;
  assert.equal(h.securityState.verifyCode(totp.hotp(totp.base32Decode(secret), totp.stepAt(later)), later).ok, true);
});

test('a missing or damaged security file reads as ON and blocks, never as off', async () => {
  const { commit, dir } = await with2fa();
  commit();
  fs.writeFileSync(path.join(dir, 'security.json'), 'junk');
  h.securityState.__resetForTest();
  assert.equal(h.securityState.totpOn(), true);
  assert.ok(h.securityState.problem());
  fs.rmSync(path.join(dir, 'security.json'));
  h.securityState.__resetForTest();
  assert.equal(h.securityState.totpOn(), true);
  assert.ok(h.securityState.problem());
  // The recovery code's route puts it right.
  h.securityState.resetAfterRecovery();
  assert.equal(h.securityState.problem(), null);
  assert.equal(h.securityState.totpOn(), false);
});

test('a lost phone waits out 72 hours, and can be called off', async () => {
  const { commit, now } = await with2fa();
  commit();
  assert.equal(h.securityState.requestReset(now), true);
  assert.equal(h.securityState.resetDueAt(), now + policy.TOTP_RESET_WAIT_MS);
  assert.equal(h.securityState.finishReset(now + policy.TOTP_RESET_WAIT_MS - 1).ok, false);
  assert.equal(h.securityState.totpOn(), true);
  assert.equal(h.securityState.cancelReset(), true);
  assert.equal(h.securityState.finishReset(now + policy.TOTP_RESET_WAIT_MS + 1).ok, false, 'called off');
  assert.equal(h.securityState.requestReset(now), true);
  assert.equal(h.securityState.finishReset(now + policy.TOTP_RESET_WAIT_MS).ok, true);
  assert.equal(h.securityState.totpOn(), false);
});

// ── Policy ─────────────────────────────────────────────────────────────

test('withdrawals need a code only when the user turned codes on', () => {
  const { proofLevel: l } = policy;
  assert.equal(l('money', false, false), 'none');
  assert.equal(l('money', true, false), 'none', 'the owner: "its up to the user, if they toggle on"');
  assert.equal(l('money', true, true), 'code');
  assert.equal(l('keys', false, false), 'none');
  assert.equal(l('keys', true, false), 'password');
  assert.equal(l('keys', true, true), 'password+code');
  assert.equal(l('security', true, false), 'password');
  assert.equal(l('security', true, true), 'password+code');
});

test('only widening a money setting counts; turning one off stays one click', () => {
  const { gatedSettingsDiff: d } = policy;
  const before = {
    execution: { autoCashout: false, cashoutThresholdSol: 1 },
    aio: { floatEnabled: false, floatUsd: 50 },
    bridge: { enabled: false },
    launch: { enabled: false },
    bots: { telegram: { token: 'a' }, discord: { token: '' }, trading: { enabled: false, maxBuySol: 1 } },
  };
  assert.deepEqual(d(before, { theme: 'x' }), []);
  assert.deepEqual(d(before, before), [], 'a spread of the same settings is not a change');
  assert.equal(d(before, { execution: { autoCashout: true, cashoutThresholdSol: 1 } }).length, 1);
  assert.equal(d(before, { execution: { autoCashout: false, cashoutThresholdSol: 0.5 } }).length, 1);
  assert.equal(d(before, { execution: { autoCashout: false, cashoutThresholdSol: 2 } }).length, 0);
  assert.equal(d(before, { aio: { floatEnabled: true, floatUsd: 50 } }).length, 1);
  assert.equal(d(before, { aio: { floatEnabled: false, floatUsd: 100 } }).length, 1);
  assert.equal(d(before, { bridge: { enabled: true } }).length, 1);
  assert.equal(d(before, { launch: { enabled: true } }).length, 1);
  assert.equal(d(before, { bots: { telegram: { token: 'b' } } }).length, 1);
  assert.equal(d(before, { bots: { telegram: { token: '' } } }).length, 0, 'clearing a token closes a door');
  assert.equal(d(before, { bots: { trading: { enabled: true, maxBuySol: 1 } } }).length, 1);
  const on = { ...before, execution: { autoCashout: true, cashoutThresholdSol: 1 }, bridge: { enabled: true }, bots: { ...before.bots, trading: { enabled: true, maxBuySol: 1 } } };
  assert.deepEqual(d(on, { execution: { autoCashout: false, cashoutThresholdSol: 1 }, bridge: { enabled: false }, bots: { trading: { enabled: false, maxBuySol: 1 } } }), []);
  assert.equal(d(on, { bots: { trading: { enabled: true, maxBuySol: 5 } } }).length, 1, 'widening a limit counts');
});

// ── Source pins ────────────────────────────────────────────────────────

const ipc = read('electron/ipc.ts').replace(/\r\n/g, '\n');

/** The body of one handler, by channel. */
function handlerBody(channel) {
  const start = ipc.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `no handler for ${channel}`);
  const end = ipc.indexOf('\n  ipcMain.handle(', start + 10);
  return ipc.slice(start, end === -1 ? undefined : end);
}

test('every channel on the list asks for proof', () => {
  for (const ch of policy.PROOF_CHANNELS) {
    const body = handlerBody(ch);
    assert.ok(/requireProof\(|exportPlaintextKey\(/.test(body), `${ch} does not call requireProof`);
  }
});

test('getting out of a position is never gated', () => {
  for (const ch of policy.NEVER_GATED_CHANNELS) assert.ok(!/requireProof\(/.test(handlerBody(ch)), `${ch} must not need proof`);
  for (const ch of ['lab:fund', 'lab:collect', 'aio:refuel']) assert.ok(!/requireProof\(/.test(handlerBody(ch)), `${ch} moves between keys already held`);
});

test('the export-all plaintext file and the phrase-to-page paths are gone', () => {
  assert.ok(!/ipcMain\.handle\('wallet:export'/.test(ipc));
  assert.ok(!/ipcMain\.handle\('evm:wallet:export'/.test(ipc));
  assert.ok(!/ipcMain\.handle\('wallet:backup'/.test(ipc));
  assert.ok(!/exportAllToFile/.test(read('electron/system/wallet.ts')));
  assert.ok(!/exportAllToFile/.test(read('electron/evm/evmWallet.ts')));
  assert.ok(!/phrase: r\.phrase/.test(handlerBody('aio:create')), 'the phrase must not go back to the page');
  assert.ok(!/ok\('ok', r\.phrase\)/.test(handlerBody('aio:reveal')), 'the phrase must not go back to the page');
  const page = read('src/pages/AioWallet.tsx');
  assert.ok(!/PhraseSheet/.test(page));
});

test('a plaintext export is one key, behind a warning, proof and a typed phrase', () => {
  const flows = read('electron/system/securityFlows.ts').replace(/\r\n/g, '\n');
  const start = flows.indexOf('export async function exportPlaintextKey');
  const body = flows.slice(start, flows.indexOf('/** Show a recovery phrase', start));
  const warning = body.indexOf('showMessageBox');
  const proof = body.indexOf('requireProof(');
  const typed = body.indexOf('EXPORT_CONFIRM_PHRASE');
  const save = body.indexOf('showSaveDialog');
  assert.ok(warning > 0 && warning < proof && proof < typed && typed < save, 'in that order, before any file dialog');
});

test('the page never receives a secret from the security flows', () => {
  const page = read('src/pages/Security.tsx');
  assert.ok(!/type="password"|<input/.test(page), 'no field for a password on the page');
  const pre = read('electron/preload.ts');
  const start = pre.indexOf('security: {');
  const block = pre.slice(start, pre.indexOf('},', start));
  assert.ok(!/password\b.*string|code: string/.test(block), 'no secret passes through the page API');
});

const main = read('electron/main.ts').replace(/\r\n/g, '\n');

test('the lock is the first thing bootstrap does', () => {
  const start = main.indexOf('async function bootstrap(): Promise<void> {');
  const gate = main.indexOf('await lockGate.run()', start);
  assert.ok(gate > start);
  for (const later of ['installNetAgent()', 'installPumpTransport()', 'pumpAuth.startSessionKeepAlive()', 'registerIpc()', 'getEngine()']) {
    const at = main.indexOf(later, start);
    assert.ok(at === -1 || at > gate, `${later} runs before the lock`);
  }
});

test('nothing outside bootstrap can build the engine while locked', () => {
  const guarded = (marker) => {
    const at = main.indexOf(marker);
    assert.ok(at >= 0, marker);
    return main.slice(at, at + 260);
  };
  assert.match(guarded("app.on('before-quit'"), /lockGate\.isBooted\(\)/);
  assert.match(guarded("powerMonitor.on('suspend'"), /lockGate\.isBooted\(\)/);
  assert.match(guarded("powerMonitor.on('resume'"), /lockGate\.isBooted\(\)/);
  assert.match(guarded("app.on('second-instance'"), /lockGate\.focusIfLocked\(\)/);
});

test('the password offer follows a first wallet however it arrived', () => {
  for (const ch of ['wallet:generate', 'wallet:import', 'evm:wallet:generate', 'evm:wallet:import', 'aio:create', 'aio:import']) {
    const at = ipc.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(at > 0, ch);
    const next = ipc.indexOf('ipcMain.handle(', at + 10);
    const body = ipc.slice(at, next);
    const had = body.indexOf('hasAnyKeys()');
    const store = body.search(/\.(generate|importSecret|importPhrase|create)\(/);
    assert.ok(had > 0 && had < store, `${ch}: whether keys existed is read before the new one is stored`);
    assert.match(body, /offerPasswordAfterFirstKey\(e\.sender, hadKeys\)/, ch);
  }
});

test('closing the password window does not quit the app that is about to open', () => {
  const at = main.indexOf("app.on('window-all-closed'");
  assert.match(main.slice(at, at + 300), /mainWindowEverOpened/);
  assert.match(main, /mainWindowEverOpened = true/);
});

test('the idle lock leaves trading alone', () => {
  const gate = read('electron/system/lockGate.ts');
  const start = gate.indexOf('export function lockScreen');
  const body = gate.slice(start, gate.indexOf('let idleTimer', start));
  for (const banned of ['getEngine', 'disarm', '.stop(', 'automation', 'dek']) assert.ok(!body.includes(banned), `lockScreen must not touch ${banned}`);
  assert.ok(!/__resetForTest|fill\(0\)/.test(body), 'the key stays in memory while locked');
});

test('the security window is cut off from the app', () => {
  const p = read('electron/system/securityPrompt.ts');
  assert.match(p, /partition: 'security-prompt'/);
  assert.match(p, /sandbox: true/);
  assert.match(p, /setContentProtection\(true\)/);
  assert.match(p, /securityPreload\.js/);
  assert.match(read('vite.config.ts'), /electron\/securityPreload\.ts/);
  const preload = read('electron/securityPreload.ts');
  assert.ok(!/preload'|krypt:/.test(preload));
  const html = read('public/security.html');
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'/);
  const js = read('public/security.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), 'text only, never markup');
  const gate = read('electron/system/securityGate.ts');
  assert.match(gate, /sender\.session !== session\.defaultSession/, 'a script sandbox or a webview cannot raise it');
});

test('a key file is written durably, and a removal scrubs the backup', () => {
  for (const f of ['electron/system/wallet.ts', 'electron/evm/evmWallet.ts', 'electron/system/aioWallet.ts']) {
    const src = read(f);
    assert.match(src, /durableWrite\(file\(\)/, f);
    assert.match(src, /'scrub'/, f);
    assert.ok(!/renameSync/.test(src), `${f} still has its own rename`);
  }
  const d = read('electron/system/durableWrite.ts');
  const a = d.indexOf('fs.fsyncSync(fd)');
  assert.ok(a > 0 && a < d.indexOf('fs.renameSync'), 'flushed before the rename');
});

test('every place that seals a secret goes through the vault when it is on', () => {
  for (const f of ['electron/system/wallet.ts', 'electron/evm/evmWallet.ts', 'electron/system/aioWallet.ts', 'electron/system/pumpAuth.ts']) {
    const src = read(f);
    for (const line of src.split('\n').filter((l) => l.includes('safeStorage.encryptString'))) {
      assert.ok(line.includes('safeStorage'), line);
    }
    assert.match(src, /vault\.writesKv1\(\)/, `${f} must check the write mode`);
    assert.match(src, /vault\.isKv1\(/, `${f} must read both formats`);
  }
  const all = fs.readdirSync(new URL('../electron/system/', import.meta.url)).filter((n) => n.endsWith('.ts'));
  const seal = all.filter((n) => read(`electron/system/${n}`).includes('safeStorage.encryptString'));
  assert.deepEqual(seal.sort(), ['aioWallet.ts', 'pumpAuth.ts', 'vault.ts', 'wallet.ts'], 'a new store must join the migration');
});

test('the wording promises only what is true', () => {
  const page = read('src/pages/Security.tsx');
  assert.match(page, /No server checks them/);
  assert.match(page, /do not protect your keys from malware/);
  assert.match(page, /does not protect you from malware running while the app is open/);
  assert.match(page, /nothing can sell until you unlock/);
  assert.match(page, /Trading and selling never need one/);
});

// ── Run ────────────────────────────────────────────────────────────────

for (const { name, fn } of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}\n${e.stack}`);
    process.exit(1);
  }
}
console.log(`security: ${passed} passed`);
