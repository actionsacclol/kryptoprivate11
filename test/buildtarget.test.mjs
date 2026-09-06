// Packaging must refuse V8 bytecode built for another platform: the app
// would die at boot with "cachedDataRejected" and no other clue.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertBytecodeMatchesTarget } = require('../scripts/apply-fuses.cjs');

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-target-'));
fs.mkdirSync(path.join(tmp, 'dist-electron'));
const stamp = path.join(tmp, 'dist-electron', 'bytecode-target.json');
const write = (o) => fs.writeFileSync(stamp, JSON.stringify(o));
process.chdir(tmp);
try {
  // No stamp: a plain (unobfuscated) build is portable, so this is allowed.
  assertBytecodeMatchesTarget({ electronPlatformName: 'darwin', arch: 3 });
  console.log('ok  a build with no bytecode packages for any platform');

  write({ platform: 'win32', arch: 'x64' });
  assertBytecodeMatchesTarget({ electronPlatformName: 'win32', arch: 1 });
  console.log('ok  Windows x64 bytecode packages for Windows x64');

  assert.throws(() => assertBytecodeMatchesTarget({ electronPlatformName: 'darwin', arch: 3 }), /compiled for win32 x64.*packaging for darwin arm64/s);
  console.log('ok  Windows bytecode refuses to be packaged for macOS');

  assert.throws(() => assertBytecodeMatchesTarget({ electronPlatformName: 'win32', arch: 3 }), /cachedDataRejected/);
  console.log('ok  x64 bytecode refuses to be packaged for arm64');

  write({ platform: 'linux', arch: 'x64' });
  assertBytecodeMatchesTarget({ electronPlatformName: 'linux', arch: 1 });
  console.log('ok  Linux x64 bytecode packages for Linux x64');

  fs.writeFileSync(stamp, 'not json');
  assertBytecodeMatchesTarget({ electronPlatformName: 'linux', arch: 1 });
  console.log('ok  an unreadable stamp is not treated as a mismatch');
} finally {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('buildtarget: all tests passed');
