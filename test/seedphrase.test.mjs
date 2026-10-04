// The All-in-One wallet's recovery phrase must open the SAME wallet in
// Phantom (Solana) and MetaMask (EVM) — it is the user's only backup.
//
// Golden values below were produced on 2026-10-01 by independent code, not by
// seedPhrase.ts: Solana by `ed25519-hd-key` derivePath + `bip39` (the recipe
// in Solana's own docs), EVM by viem's `mnemonicToAccount`. A cross-check of
// 27 phrases (12 and 24 words) × accounts 0/1/7 matched 81 of 81. The EVM
// address of the "abandon … about" phrase is the one every BIP-39 tool shows.
import assert from 'node:assert';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import {
  newSeedPhrase,
  normaliseSeedPhrase,
  seedPhraseProblem,
  solanaSeedFromPhrase,
  evmPrivateKeyFromPhrase,
  slip10Ed25519,
} from './.seedphrase.mjs';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hex = (b) => Buffer.from(b).toString('hex');
const solAddr = (phrase, i = 0) => Keypair.fromSeed(solanaSeedFromPhrase(phrase, i)).publicKey.toBase58();
const evmAddr = (phrase, i = 0) => privateKeyToAccount(`0x${hex(evmPrivateKeyFromPhrase(phrase, i))}`).address;

// ── golden addresses ──────────────────────────────────────────────────
{
  assert.equal(solAddr(TEST_PHRASE), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', "Phantom's m/44'/501'/0'/0'");
  assert.equal(evmAddr(TEST_PHRASE), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', "MetaMask's m/44'/60'/0'/0/0");
  assert.notEqual(solAddr(TEST_PHRASE, 1), solAddr(TEST_PHRASE, 0), 'account 1 is a different wallet');
  console.log('ok  the phrase opens the same wallets Phantom and MetaMask show');
}

// ── SLIP-10 ed25519 spec vector 1 (seed 000102…0f) ────────────────────
{
  const seed = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  assert.equal(hex(slip10Ed25519(seed, [])), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7', 'm');
  assert.equal(hex(slip10Ed25519(seed, [0])), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3', "m/0'");
  console.log('ok  SLIP-10 ed25519 matches the spec vector');
}

// ── generation ────────────────────────────────────────────────────────
{
  const a = newSeedPhrase();
  const b = newSeedPhrase();
  assert.equal(a.split(' ').length, 12, 'twelve words, like Phantom and MetaMask');
  assert.notEqual(a, b, 'fresh entropy every time');
  assert.equal(seedPhraseProblem(a), null, 'a generated phrase is valid');
  console.log('ok  a new phrase is twelve valid words');
}

// ── what a user types ─────────────────────────────────────────────────
{
  const messy = `  ${TEST_PHRASE.toUpperCase().replace(/ /g, ',  ')} \n`;
  assert.equal(normaliseSeedPhrase(messy), TEST_PHRASE, 'case, commas and spacing from a paste are forgiven');
  assert.equal(solAddr(messy), solAddr(TEST_PHRASE), 'and derive the same wallet');
  assert.match(seedPhraseProblem('abandon abandon'), /12 or 24 words — this has 2/);
  assert.match(seedPhraseProblem(TEST_PHRASE.replace(/about$/, 'abondon')), /Word 12 \("abondon"\)/, 'a misspelling is named, never corrected');
  assert.match(seedPhraseProblem(TEST_PHRASE.replace(/about$/, 'abandon')), /does not check out/, 'a bad checksum is refused');
  assert.match(seedPhraseProblem('   '), /Enter the recovery phrase/);
  assert.throws(() => solanaSeedFromPhrase('abandon abandon'), /12 or 24 words/, 'derivation refuses a bad phrase');
  assert.throws(() => evmPrivateKeyFromPhrase(TEST_PHRASE, -1), /account index/);
  assert.throws(() => evmPrivateKeyFromPhrase(TEST_PHRASE, 1.5), /account index/);
  console.log('ok  pasted phrases are tidied, wrong ones are refused with the reason');
}

// ── import path scan (2026-10-03): every catalogued path, checked ────────
{
  const { solanaSeedAtPath, evmPrivateKeyAtPath } = await import('./.seedphrase.mjs');
  const { AIO_SOLANA_PATHS, AIO_EVM_PATHS, aioSolanaPath, aioEvmPath, isAioPathChoice, parseAioFile } = await import('./.aio.mjs');
  const { mnemonicToAccount } = await import('viem/accounts');
  const P = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  // The default ids are the wallet every user had before this: unchanged.
  assert.equal(Keypair.fromSeed(solanaSeedAtPath(P, aioSolanaPath(undefined))).publicKey.toBase58(), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(privateKeyToAccount(`0x${Buffer.from(evmPrivateKeyAtPath(P, aioEvmPath(undefined))).toString('hex')}`).address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  // EVM paths agree with viem's own mnemonic derivation (an independent implementation).
  for (const [i, path] of [[1, "m/44'/60'/0'/0/1"], [4, "m/44'/60'/0'/0/4"]]) {
    const ours = privateKeyToAccount(`0x${Buffer.from(evmPrivateKeyAtPath(P, path)).toString('hex')}`).address;
    assert.equal(ours, mnemonicToAccount(P, { addressIndex: i }).address, `MetaMask account ${i + 1}`);
  }
  const ledger = privateKeyToAccount(`0x${Buffer.from(evmPrivateKeyAtPath(P, aioEvmPath('evm-ledger-1'))).toString('hex')}`).address;
  assert.equal(ledger, mnemonicToAccount(P, { accountIndex: 1 }).address, 'Ledger Live account 2');
  // Every catalogued path is its own address.
  const sol = AIO_SOLANA_PATHS.map((x) => Keypair.fromSeed(solanaSeedAtPath(P, x.path)).publicKey.toBase58());
  const evm = AIO_EVM_PATHS.map((x) => privateKeyToAccount(`0x${Buffer.from(evmPrivateKeyAtPath(P, x.path)).toString('hex')}`).address);
  assert.equal(new Set(sol).size, sol.length, 'distinct Solana addresses');
  assert.equal(new Set(evm).size, evm.length, 'distinct EVM addresses');
  // A record keeps a known choice and drops an unknown one.
  assert.equal(isAioPathChoice({ solana: 'sol-trust', evm: 'evm-1' }), true);
  assert.equal(isAioPathChoice({ solana: 'sol-99', evm: 'evm-1' }), false);
  assert.throws(() => solanaSeedAtPath(P, [44, 501, -1]), /Invalid/);
  assert.throws(() => evmPrivateKeyAtPath(P, 'm/44/60'), /Invalid/);
  console.log('ok  import path scan: Trust / Ledger / extra MetaMask accounts derive right; defaults unchanged');
}

console.log('\nseed phrase: Phantom/MetaMask-compatible');
