// Launch the bytecode compiler under Electron's V8 — in APP mode.
//
// Runs scripts/compile-bytecode.cjs as an Electron main script (not with
// ELECTRON_RUN_AS_NODE) so the produced .jsc matches the exact process type
// that will load it. V8 cached data carries a hash of the V8 flags in force
// when it was compiled; from Electron 43 (Node 24) the run-as-node flag set
// no longer matches the browser-process flag set, so bytecode compiled the
// old way is rejected at boot with "Invalid or incompatible cached data
// (cachedDataRejected)" — which reads as "the app does nothing". Compiling in
// app mode removes the mismatch by construction. Skipped for debug builds
// (KRYPT_OBFUSCATE=0), same gate as obfuscation, so a debug build stays plain.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.KRYPT_OBFUSCATE === '0') {
  console.log('bytecode skipped (KRYPT_OBFUSCATE=0) — debug build');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electron = require('electron'); // resolves to the electron.exe path
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env, KRYPT_BYTECODE_APP_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE; // must NOT be set — see the header comment

const r = spawnSync(electron, [path.join(root, 'scripts', 'compile-bytecode.cjs')], {
  stdio: 'inherit',
  env,
});
if (r.status !== 0) {
  console.error('bytecode compilation failed');
  process.exit(r.status ?? 1);
}

// V8 cached data is only accepted by a V8 with the same version, flags AND
// CPU features, so bytecode compiled here runs only on this platform and
// architecture. Cross-packaging (electron-builder --mac from Windows) would
// produce an app that fails at boot with "cachedDataRejected" and no other
// clue. Stamp what this build targets; apply-fuses refuses a mismatch.
fs.writeFileSync(
  path.join(root, 'dist-electron', 'bytecode-target.json'),
  JSON.stringify({ platform: process.platform, arch: process.arch, electron: require('electron/package.json').version }, null, 2),
);
console.log(`  bytecode target: ${process.platform} ${process.arch} — package this build on this platform only`);
