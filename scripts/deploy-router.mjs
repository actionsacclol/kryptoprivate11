// Deploy contracts/KryptCurveRouter.sol to Robinhood Chain.
//
//   KRYPT_DEPLOYER_KEY=0x… node scripts/deploy-router.mjs [--write]
//
// Needs a funded deployer key (a few thousandths of an ETH covers it many
// times over at the chain's fee level). Deploys the artifact from
// scripts/build-router.mjs, waits for the receipt, reads the code back and
// checks it matches the built runtime byte for byte, then prints the address.
// With --write it also patches ADDR.kryptRouter in electron/evm/chain.ts and
// the pin in test/evmchain.test.mjs so the rail starts using it.
//
// The key is read from the environment only, never from a file in the repo,
// and is never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.KRYPT_EVM_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'build', 'KryptCurveRouter.json'), 'utf8'));

// The key comes from KRYPT_DEPLOYER_KEY, or from a file named with
// --key-file <path> (first line, 0x-prefixed or bare 64 hex). The file route
// exists so the key never has to appear on a command line or in a chat
// transcript; the file is wiped and deleted after it is read unless
// --keep-key-file is given.
const argv = process.argv.slice(2);
const keyFileIdx = argv.indexOf('--key-file');
const keyFile = keyFileIdx >= 0 ? argv[keyFileIdx + 1] : null;
let rawKey = (process.env.KRYPT_DEPLOYER_KEY ?? '').trim();
if (!rawKey && keyFile) {
  try {
    // A bare key on the first line, or the app's own "Export all" file
    // (header lines, then `label<tab>address<tab>0xkey`): the first 64-hex
    // key found anywhere in the file is used.
    const text = fs.readFileSync(keyFile, 'utf8');
    const m = text.match(/(?:^|[^0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/m);
    rawKey = m ? m[1] : '';
  } catch (e) {
    console.error(`Could not read the key file: ${e.message}`);
    process.exit(2);
  }
  if (!argv.includes('--keep-key-file')) {
    try {
      fs.writeFileSync(keyFile, '0'.repeat(Math.max(64, fs.statSync(keyFile).size)), 'utf8');
      fs.unlinkSync(keyFile);
      console.log(`key file ${keyFile} wiped and deleted`);
    } catch {
      console.warn(`could not delete ${keyFile} — delete it yourself`);
    }
  }
}
const key = rawKey ? `0x${rawKey.replace(/^0x/i, '').toLowerCase()}` : '';
if (!/^0x[0-9a-f]{64}$/.test(key)) {
  console.error('Provide the deployer key: KRYPT_DEPLOYER_KEY=0x… or --key-file <path> (a funded Robinhood Chain account).');
  process.exit(2);
}

const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, account, transport: http(RPC) });

const balance = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address} · balance ${formatEther(balance)} ETH · rpc ${new URL(RPC).host}`);
const gas = await pub.estimateGas({ account: account.address, data: artifact.bytecode });
const block = await pub.getBlock();
const cost = gas * (block.baseFeePerGas ?? 0n) * 2n;
console.log(`deploy gas ≈ ${gas} · worst-case cost ≈ ${formatEther(cost)} ETH`);
if (balance < cost) {
  console.error('Insufficient balance for the deployment.');
  process.exit(3);
}

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
console.log(`sent ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 60_000 });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  console.error('deployment reverted');
  process.exit(4);
}
const address = receipt.contractAddress;
const code = await pub.getCode({ address });
const matches = (code ?? '').toLowerCase() === artifact.deployedBytecode.toLowerCase();
console.log(`deployed KryptCurveRouter at ${address} in block ${receipt.blockNumber} · gas used ${receipt.gasUsed} · code ${matches ? 'matches the build' : 'DOES NOT MATCH THE BUILD'}`);
if (!matches) process.exit(5);

const treasury = await pub.readContract({ address, abi: artifact.abi, functionName: 'TREASURY' });
console.log(`on-chain TREASURY ${treasury}`);
// The deployed constant is the fee destination for every routed curve buy.
// If it is not the treasury this build believes in, the deployment is stale
// (the .sol was not rebuilt after a treasury change) — refuse to wire it up.
{
  const evmSrc = fs.readFileSync(path.join(root, 'shared', 'evm.ts'), 'utf8');
  const m = evmSrc.match(/EVM_TREASURY_ADDRESSs*=s*'(0x[0-9a-fA-F]{40})'/);
  const expected = m ? m[1] : '';
  if (!expected || String(treasury).toLowerCase() !== expected.toLowerCase()) {
    console.error(`TREASURY MISMATCH: deployed ${treasury}, this build expects ${expected || '(none found in shared/evm.ts)'} — rebuild the router and deploy again`);
    process.exit(6);
  }
}

if (process.argv.includes('--write')) {
  const chainTs = path.join(root, 'electron', 'evm', 'chain.ts');
  let src = fs.readFileSync(chainTs, 'utf8');
  src = src.replace(/kryptRouter: '[^']*' as Address \| '',/, `kryptRouter: '${address}' as Address | '',`);
  fs.writeFileSync(chainTs, src, 'utf8');
  const testPath = path.join(root, 'test', 'evmchain.test.mjs');
  if (fs.existsSync(testPath)) {
    let t = fs.readFileSync(testPath, 'utf8');
    t = t.replace(/const KRYPT_ROUTER = '[^']*';/, `const KRYPT_ROUTER = '${address}';`);
    fs.writeFileSync(testPath, t, 'utf8');
  }
  console.log('wrote the address into electron/evm/chain.ts and test/evmchain.test.mjs — run npm test -- evmchain');
} else {
  console.log(`\nNext: put ${address} into ADDR.kryptRouter (electron/evm/chain.ts) and KRYPT_ROUTER in test/evmchain.test.mjs, or re-run with --write.`);
}
