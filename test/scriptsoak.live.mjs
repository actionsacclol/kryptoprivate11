// Script soak — the real automation module and the real sandbox, in a real
// Electron, for as long as you give it (npm run test:soak).
//
// Not part of `npm test`: it is a measurement, not a pass/fail pin, and a
// useful run takes 30–60 minutes. It fails only on an uncaught error in main
// or on the script ending the run disabled. Everything else — memory curve,
// handler latency, restarts — is printed every minute and written to
// <out>/samples.jsonl and <out>/summary.json for a human to judge.
//
//   SOAK_MINUTES=60 SOAK_SCRIPT=private/scripts/scorenow.runner.js npm run test:soak
//
// See test/soakmain.cjs for the knobs and the fault schedule. Offline: the
// host is a mock and the sandbox has no network.

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
  const r = spawnSync(process.execPath, [esbuild, entry, '--bundle', '--format=cjs', '--platform=node', '--external:electron', `--alias:@shared=${path.join(root, 'shared')}`, `--outfile=${outfile}`, '--log-level=warning'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`esbuild failed for ${entry}`);
    process.exit(1);
  }
};
build('electron/system/scriptSandbox.ts', path.join(outDir, 'scriptsandbox.cjs'));
build('electron/scriptPreload.ts', path.join(outDir, 'scriptPreload.js'));
build('electron/engine/automation.ts', path.join(outDir, 'automation.cjs'));
build('shared/scriptInputs.ts', path.join(outDir, 'scriptinputs.cjs'));

const soakOut = process.env.SOAK_OUT || path.join(outDir, `soak-${Date.now()}`);
fs.mkdirSync(soakOut, { recursive: true });
const minutes = Number(process.env.SOAK_MINUTES || 5);
const electron = require('electron'); // the binary's path
const child = spawn(electron, [path.join(root, 'test', 'soakmain.cjs')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SOAK_OUT: soakOut, ELECTRON_ENABLE_LOGGING: '0' },
});
let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => {
  const s = String(d);
  if (/UNCAUGHT|UNHANDLED|Error|FAIL/.test(s)) process.stderr.write(s);
});
const timer = setTimeout(
  () => {
    console.error('script soak: timed out');
    child.kill();
    process.exit(1);
  },
  (minutes + 5) * 60_000,
);
child.on('exit', (code) => {
  clearTimeout(timer);
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(soakOut, 'summary.json'), 'utf8'));
  } catch {
    /* no summary: the run died */
  }
  const pass = code === 0 && summary && summary.stillEnabled === true && summary.uncaught.length === 0;
  console.log(`samples: ${path.join(soakOut, 'samples.jsonl')}`);
  console.log(pass ? 'script soak: PASS' : `script soak: FAIL (exit ${code}${summary ? `, enabled at end ${summary.stillEnabled}` : ', no summary'})`);
  process.exit(pass ? 0 : 1);
});
