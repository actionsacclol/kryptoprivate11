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

// Linux: Chromium's SUID sandbox helper must be root-owned with mode 4755,
// which it is not in a fresh node_modules — a GitHub runner aborts with
// "The SUID sandbox helper binary was found, but is not configured
// correctly" and the build dies here (2026-09-06, the linux job). This
// process only compiles bytecode: it loads no page, runs no renderer and
// opens no window, so it has nothing to sandbox. The shipped app is
// untouched — its sandbox is a runtime property of the packaged binary, not
// of this build step.
const args = [path.join(root, 'scripts', 'compile-bytecode.cjs')];
if (process.platform === 'linux') args.unshift('--no-sandbox');

const r = spawnSync(electron, args, {
  stdio: 'inherit',
  env,
});
if (r.status !== 0) {
  console.error('bytecode compilation failed');
  process.exit(r.status ?? 1);
}

// A preload must stay plain JS. Electron loads a preload BY PATH, and the
// script sandbox's preload runs SANDBOXED — it has no Node `require`, so a
// bytenode stub throws on its first line, the bridge is never installed, and
// every code script fails to start with nothing but "no ready within 8000 ms".
// compile-bytecode.cjs skips them by name; this asserts the artefact, because
// the live sandbox test builds the preload from source and would never see a
// hardened one.
const distDir = path.join(root, 'dist-electron');
const preloads = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && /preload/i.test(e.name) && e.name.endsWith('.js')) preloads.push(p);
  }
};
walk(distDir);
if (preloads.length === 0) {
  console.error('bytecode check: no *preload*.js in dist-electron — renamed, or the build did not run');
  process.exit(1);
}
for (const p of preloads) {
  if (fs.readFileSync(p, 'utf8').includes('bytenode')) {
    console.error(`bytecode check FAILED: ${path.relative(root, p)} was compiled to bytecode.`);
    console.error('  A sandboxed preload has no Node require: the stub throws and every code script');
    console.error('  silently fails to start. Add it to SKIP in scripts/compile-bytecode.cjs.');
    process.exit(1);
  }
}
console.log(`  preload check: ${preloads.map((p) => path.basename(p)).join(', ')} left as plain JS`);

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
