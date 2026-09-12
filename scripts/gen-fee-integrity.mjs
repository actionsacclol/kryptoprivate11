// Regenerate the obfuscated treasury blobs in shared/feeIntegrity.ts (Solana)
// and shared/evmFeeIntegrity.ts (Robinhood Chain).
//
// Run this after changing TREASURY_ADDRESS in shared/fees.ts or
// EVM_TREASURY_ADDRESS in shared/evm.ts:
//   node scripts/gen-fee-integrity.mjs
//
// Each reads its address from the one source of truth, re-encodes the blob
// and rewrites the two generated constants in its integrity module. The
// keystream parameters must match the ones in that module; the two modules
// use DIFFERENT seeds on purpose.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const A = 1103515245;
const C = 12345;
const M = 2 ** 31;

function encode(addr, s0) {
  let s = s0;
  const enc = [];
  for (let i = 0; i < addr.length; i++) {
    s = (A * s + C) % M;
    enc.push(addr.charCodeAt(i) ^ ((s >>> 7) & 0xff));
  }
  return enc;
}

function regenerate({ label, sourceFile, pattern, integrityFile, seed }) {
  const sourcePath = path.join(root, ...sourceFile);
  const integrityPath = path.join(root, ...integrityFile);
  const src = fs.readFileSync(sourcePath, 'utf8');
  const m = src.match(pattern);
  if (!m) throw new Error(`could not find the ${label} treasury constant in ${sourceFile.join('/')}`);
  const addr = m[1];
  let out = fs.readFileSync(integrityPath, 'utf8');
  if (!addr) {
    // An empty treasury is NOT a shippable state any more: canaries 13-18
    // read a blank EVM treasury as tampering, and their level is shared with
    // Solana, so such a build would corrode its own buys. Fail loudly.
    throw new Error(`${label}: the treasury constant is empty — set it in ${sourceFile.join('/')} before generating`);
  }
  const enc = encode(addr, seed);
  const sum = crypto.createHash('sha256').update(addr).digest('hex');
  out = out.replace(/const BLOB: number\[\] = \[[\s\S]*?\];/, `const BLOB: number[] = [\n  ${enc.join(', ')},\n];`);
  out = out.replace(/const CANON_SHA256 = '[0-9a-f]*';/, `const CANON_SHA256 = '${sum}';`);
  fs.writeFileSync(integrityPath, out, 'utf8');
  console.log(`${label}: re-encoded treasury ${addr.slice(0, 6)}…${addr.slice(-4)} into ${integrityFile.join('/')} (${enc.length} bytes)`);
}

regenerate({
  label: 'solana',
  sourceFile: ['shared', 'fees.ts'],
  pattern: /export const TREASURY_ADDRESS = '([^']*)'/,
  integrityFile: ['shared', 'feeIntegrity.ts'],
  seed: 0x4b525950,
});

regenerate({
  label: 'robinhood',
  sourceFile: ['shared', 'evm.ts'],
  pattern: /export const EVM_TREASURY_ADDRESS = '([^']*)'/,
  integrityFile: ['shared', 'evmFeeIntegrity.ts'],
  seed: 0x484f4f44,
});
