// Compile contracts/KryptCurveRouter.sol with the pinned solc and write the
// artifact the deploy script, the live check and the app read.
//
//   node scripts/build-router.mjs
//
// Output: contracts/build/KryptCurveRouter.json — { abi, bytecode,
// deployedBytecode, solc, evmVersion, optimizer, sourceSha256 }. The
// runtime bytecode has NO immutables (the treasury is a compile-time
// constant), which is what lets test/evmrouter.live.mjs inject it with an
// eth_call state override and exercise it on a real curve before deploying.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'contracts', 'KryptCurveRouter.sol');
const outDir = path.join(root, 'contracts', 'build');
const source = fs.readFileSync(srcPath, 'utf8');

// Paris: no PUSH0 / transient storage, so the bytecode runs on any Nitro
// ArbOS version — the chain is young and its EVM version is not something
// this build should have to know.
const EVM_VERSION = 'paris';
const input = {
  language: 'Solidity',
  sources: { 'KryptCurveRouter.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: EVM_VERSION,
    metadata: { bytecodeHash: 'none' },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
for (const e of out.errors ?? []) console.log(`${e.severity}: ${e.formattedMessage}`);
if (errors.length) process.exit(1);

const c = out.contracts['KryptCurveRouter.sol'].KryptCurveRouter;
const immutables = Object.keys(c.evm.deployedBytecode.immutableReferences ?? {});
if (immutables.length) throw new Error('runtime bytecode has immutables; the state-override check needs none');

fs.mkdirSync(outDir, { recursive: true });
const artifact = {
  contract: 'KryptCurveRouter',
  solc: solc.version(),
  evmVersion: EVM_VERSION,
  optimizer: { enabled: true, runs: 200 },
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  abi: c.abi,
  bytecode: `0x${c.evm.bytecode.object}`,
  deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
};
fs.writeFileSync(path.join(outDir, 'KryptCurveRouter.json'), JSON.stringify(artifact, null, 2), 'utf8');
console.log(`built KryptCurveRouter: ${(artifact.bytecode.length - 2) / 2} bytes creation, ${(artifact.deployedBytecode.length - 2) / 2} bytes runtime, solc ${artifact.solc}`);
