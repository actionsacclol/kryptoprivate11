// The bytecode check must look where electron-builder actually put app.asar:
// flat on Windows and Linux, inside the .app bundle on macOS. The first macOS
// CI run (2026-09-12) died with "no app.asar at release/mac-arm64/resources/
// app.asar" while Windows and Linux passed, because only the flat layout was
// known. A wrong path here fails every macOS build; a check that looks in a
// place that never has the asar cannot catch the 2026-09-09 stub-only ship.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertBytecodeIsPackaged, packagedAsarPath } = require('../scripts/apply-fuses.cjs');

const packager = { appInfo: { productFilename: 'Krypto Bot' } };
const ctx = (appOutDir, electronPlatformName) => ({ appOutDir, electronPlatformName, packager });

// A minimal asar: a size pickle, a header pickle, then the header JSON — the
// same bytes @electron/asar writes, laid out the way apply-fuses reads them.
function writeAsar(file, entries) {
  const json = Buffer.from(JSON.stringify({ files: { 'dist-electron': { files: entries } } }), 'utf8');
  const padded = (json.length + 3) & ~3;
  const buf = Buffer.alloc(16 + padded);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(8 + padded, 4);
  buf.writeUInt32LE(4 + padded, 8);
  buf.writeUInt32LE(json.length, 12);
  json.copy(buf, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

const whole = { 'main2.jsc': { size: 11_000_000, offset: '0' }, 'fanout.jsc': { size: 13_000, offset: '11000000' } };

// ── The locator itself ──────────────────────────────────────────────────
const mac = packagedAsarPath(ctx(path.join('release', 'mac-arm64'), 'darwin'));
assert.strictEqual(mac, path.join('release', 'mac-arm64', 'Krypto Bot.app', 'Contents', 'Resources', 'app.asar'));
console.log('ok  macOS: app.asar is inside <Product>.app/Contents/Resources');

for (const [platform, dir] of [
  ['win32', 'win-unpacked'],
  ['linux', 'linux-unpacked'],
]) {
  const flat = packagedAsarPath(ctx(path.join('release', dir), platform));
  assert.strictEqual(flat, path.join('release', dir, 'resources', 'app.asar'));
}
console.log('ok  Windows and Linux: app.asar is flat under resources/');

// ── The check, against real files in every layout ───────────────────────
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-asar-'));
fs.mkdirSync(path.join(tmp, 'dist-electron'));
const stamp = path.join(tmp, 'dist-electron', 'bytecode-target.json');
fs.writeFileSync(stamp, JSON.stringify({ platform: 'darwin', arch: 'arm64' }));
for (const jsc of Object.keys(whole)) fs.writeFileSync(path.join(tmp, 'dist-electron', jsc), 'bytecode');
process.chdir(tmp);
try {
  // macOS, laid out the way electron-builder lays it out: passes.
  const macOut = path.join(tmp, 'mac-arm64');
  writeAsar(path.join(macOut, 'Krypto Bot.app', 'Contents', 'Resources', 'app.asar'), whole);
  assertBytecodeIsPackaged(ctx(macOut, 'darwin'));
  console.log('ok  a macOS bundle with its bytecode passes');

  // macOS with only a flat resources/ dir — the 2026-09-12 CI failure in
  // reverse: the check must NOT accept an asar outside the bundle, since
  // that is not the one the app will load.
  const macFlat = path.join(tmp, 'mac-flat');
  writeAsar(path.join(macFlat, 'resources', 'app.asar'), whole);
  assert.throws(() => assertBytecodeIsPackaged(ctx(macFlat, 'darwin')), /no app\.asar at .*Krypto Bot\.app/);
  console.log('ok  a macOS check looks inside the bundle, not beside it');

  // Windows and Linux, flat: passes.
  for (const [platform, dir] of [
    ['win32', 'win-unpacked'],
    ['linux', 'linux-unpacked'],
  ]) {
    const out = path.join(tmp, dir);
    writeAsar(path.join(out, 'resources', 'app.asar'), whole);
    assertBytecodeIsPackaged(ctx(out, platform));
  }
  console.log('ok  Windows and Linux flat layouts with their bytecode pass');

  // The layout fix must not loosen the original guard: a bundle whose asar
  // lacks a .jsc the build produced still fails, naming the file.
  const macShort = path.join(tmp, 'mac-short');
  writeAsar(path.join(macShort, 'Krypto Bot.app', 'Contents', 'Resources', 'app.asar'), {
    'main2.jsc': whole['main2.jsc'],
    'fanout.jsc': { size: 77, offset: '0' }, // a bytenode stub's size, not bytecode
  });
  assert.throws(() => assertBytecodeIsPackaged(ctx(macShort, 'darwin')), /missing its V8 bytecode[\s\S]*fanout\.jsc \(77 B\)/);
  console.log('ok  a macOS bundle missing a .jsc still fails the build');

  // No stamp = plain-JavaScript build: nothing to verify, no asar needed.
  fs.rmSync(stamp);
  assertBytecodeIsPackaged(ctx(path.join(tmp, 'nowhere'), 'darwin'));
  console.log('ok  a plain build with no bytecode stamp is not checked');
} finally {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('asarlayout: all tests passed');
