// The curve router's treasury is a COMPILE-TIME constant in Solidity, so it
// is the one copy of the fee destination no canary and no blob can protect.
// Rotating the treasury means editing shared/evm.ts, regenerating the blobs
// AND editing the .sol — forget the last step and every routed curve-buy fee
// would land on the old address, with the whole suite still green.
//
// This test is that missing link: the contract's TREASURY must equal the
// canonical treasury the integrity layer decodes.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalEvmTreasury } from './.evmfeeintegrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const solPath = path.join(root, 'contracts', 'KryptCurveRouter.sol');
const sol = fs.readFileSync(solPath, 'utf8');

ok('the router source declares one TREASURY constant', () => {
  const hits = sol.match(/address\s+public\s+constant\s+TREASURY\s*=\s*(0x[0-9a-fA-F]{40})\s*;/g) ?? [];
  assert.equal(hits.length, 1, 'expected exactly one TREASURY constant in KryptCurveRouter.sol');
});

ok('the router pays the SAME treasury the integrity blob decodes', () => {
  const m = sol.match(/address\s+public\s+constant\s+TREASURY\s*=\s*(0x[0-9a-fA-F]{40})\s*;/);
  assert.ok(m, 'no TREASURY constant found');
  const canonical = canonicalEvmTreasury();
  assert.notEqual(canonical, '', 'the integrity blob decodes to nothing — regenerate it');
  assert.equal(
    m[1].toLowerCase(),
    canonical.toLowerCase(),
    'KryptCurveRouter.sol pays a different address than the canonical treasury — rebuild the contract after a treasury change',
  );
});

// The built artifact is what actually gets deployed; if it is present its
// bytecode must contain the same address, or a stale build would be deployed.
ok('the built artifact (if present) embeds that treasury too', () => {
  const artifactPath = path.join(root, 'contracts', 'build', 'KryptCurveRouter.json');
  if (!fs.existsSync(artifactPath)) return;
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const code = String(artifact.deployedBytecode ?? '').toLowerCase();
  if (!code) return;
  const canonical = canonicalEvmTreasury().toLowerCase().replace(/^0x/, '');
  assert.ok(code.includes(canonical), 'the compiled router does not contain the canonical treasury — run npm run build:router');
});

console.log(`\n${passed} evm router pin cases passed`);
