// Obfuscate the built main-process bundle.
//
// ─── Scope, and why it is safe for speed ──────────────────────────────
//
// This touches ONLY dist-electron/*.js — the main process. That runs on its own
// thread; the renderer, the React tree and the 3D loop are never obfuscated, so
// there is zero effect on frame rate or UI responsiveness. The main-process
// hot path (the feed, decoders) runs a handful of times per event, not per
// frame, and the settings below deliberately avoid the transforms that carry a
// real CPU cost.
//
// ─── What is deliberately OFF ─────────────────────────────────────────
//
// `selfDefending` and `debugProtection` can wedge a process or spike CPU, and a
// trading app that freezes is worse than one that is readable. `controlFlow-
// Flattening` and `deadCodeInjection` are the expensive transforms; they are
// applied at a LOW threshold, not globally, so the sensitive modules get them
// without taxing the whole bundle.
//
// This raises the cost of reading the source. It is not a wall — see
// feeIntegrity.ts for the honest ceiling. It exists so the fee, signing and
// integrity logic is not sitting in the asar as plain, greppable JavaScript.
//
// ON BY DEFAULT for every production build, so a release can never accidentally
// ship as plain JavaScript. Only the dev server (`npm run dev` -> vite) skips
// this, because it never runs the build script at all — dev speed is untouched.
// Set KRYPT_OBFUSCATE=0 to opt OUT when debugging a production build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

if (process.env.KRYPT_OBFUSCATE === '0') {
  console.log('obfuscation OFF (KRYPT_OBFUSCATE=0) — debug build, do not ship this');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'dist-electron');

if (!fs.existsSync(dir)) {
  console.error('dist-electron not found — run the build first');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
let total = 0;

for (const f of files) {
  const full = path.join(dir, f);
  const src = fs.readFileSync(full, 'utf8');
  const before = src.length;
  const result = JavaScriptObfuscator.obfuscate(src, {
    compact: true,
    // Real transforms, applied at a fraction of nodes so cost stays bounded.
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    // String hiding is the highest-value, lowest-cost transform for this goal:
    // it stops a plain grep for "treasury", "bonding-curve-v2", the RPC hosts,
    // the fee constants, etc.
    stringArray: true,
    stringArrayThreshold: 0.9,
    stringArrayEncoding: ['base64'],
    stringArrayCallsTransform: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    identifierNamesGenerator: 'mangled',
    numbersToExpressions: true,
    simplify: true,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // OFF on purpose — these are the process-wedging / CPU-spiking ones.
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    // esbuild already bundled to a single file per entry; no need to reserve.
    target: 'node',
  });
  const out = result.getObfuscatedCode();
  fs.writeFileSync(full, out, 'utf8');
  total += 1;
  console.log(`  ${f}: ${(before / 1024).toFixed(0)}KB -> ${(out.length / 1024).toFixed(0)}KB`);
}

console.log(`obfuscated ${total} main-process file(s)`);
