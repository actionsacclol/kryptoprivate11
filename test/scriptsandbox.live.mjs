// Script sandbox — the real one, in a real Electron.
//
// The unit tests drive automation.ts through a fake sandbox; this proves
// the sandbox itself: a hidden sandboxed renderer with the preload bridge
// and the locked-down session. It bundles the sandbox module and its
// preload beside each other (the module finds the preload next to itself),
// launches Electron on test/sandboxmain.cjs, and passes on its verdict.
// Networked: none. Needs the Electron binary (npm run test:sandbox).

import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outDir = path.join(root, 'test', '.sandbox');
fs.mkdirSync(outDir, { recursive: true });

const esbuild = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
const build = (entry, outfile) => {
  const r = spawnSync(process.execPath, [esbuild, entry, '--bundle', '--format=cjs', '--platform=node', '--external:electron', `--alias:@shared=${path.join(root, 'shared')}`, `--outfile=${outfile}`], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`esbuild failed for ${entry}`);
    process.exit(1);
  }
};
build('electron/system/scriptSandbox.ts', path.join(outDir, 'scriptsandbox.cjs'));
build('electron/scriptPreload.ts', path.join(outDir, 'scriptPreload.js'));

const electron = require('electron'); // the binary's path
const child = spawn(electron, [path.join(root, 'test', 'sandboxmain.cjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  const s = String(d);
  // Chromium's own chatter is not a failure.
  if (/SANDBOX|Error|FAIL/.test(s)) process.stderr.write(s);
});
const timer = setTimeout(() => {
  console.error('sandbox live test: timed out');
  child.kill();
  process.exit(1);
}, 60_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const pass = code === 0 && /SANDBOX LIVE: PASS/.test(stdout);
  console.log(pass ? 'scriptsandbox live: PASS' : `scriptsandbox live: FAIL (exit ${code})`);
  process.exit(pass ? 0 : 1);
});
