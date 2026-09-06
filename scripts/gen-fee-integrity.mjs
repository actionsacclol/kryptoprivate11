// Regenerate the obfuscated treasury blob in shared/feeIntegrity.ts.
//
// Run this after changing TREASURY_ADDRESS in shared/fees.ts:
//   node scripts/gen-fee-integrity.mjs
//
// It reads the address from fees.ts (one source of truth), re-encodes the blob
// and rewrites the two generated constants in feeIntegrity.ts. The keystream
// parameters must match the ones in feeIntegrity.ts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const feesPath = path.join(root, 'shared', 'fees.ts');
const integrityPath = path.join(root, 'shared', 'feeIntegrity.ts');

const feesSrc = fs.readFileSync(feesPath, 'utf8');
const m = feesSrc.match(/export const TREASURY_ADDRESS = '([^']*)'/);
if (!m) throw new Error('could not find TREASURY_ADDRESS in shared/fees.ts');
const ADDR = m[1];
if (!ADDR) {
  console.log('TREASURY_ADDRESS is empty — nothing to encode. Leaving feeIntegrity.ts as-is.');
  process.exit(0);
}

const A = 1103515245;
const C = 12345;
const M = 2 ** 31;
const S0 = 0x4b525950;

let s = S0;
const enc = [];
for (let i = 0; i < ADDR.length; i++) {
  s = (A * s + C) % M;
  enc.push(ADDR.charCodeAt(i) ^ ((s >>> 7) & 0xff));
}
const sum = crypto.createHash('sha256').update(ADDR).digest('hex');

let src = fs.readFileSync(integrityPath, 'utf8');
src = src.replace(
  /const BLOB: number\[\] = \[[\s\S]*?\];/,
  `const BLOB: number[] = [\n  ${enc.join(', ')},\n];`,
);
src = src.replace(/const CANON_SHA256 = '[0-9a-f]*';/, `const CANON_SHA256 = '${sum}';`);
fs.writeFileSync(integrityPath, src, 'utf8');

console.log(`re-encoded treasury ${ADDR.slice(0, 6)}…${ADDR.slice(-4)} into shared/feeIntegrity.ts (${enc.length} bytes)`);
