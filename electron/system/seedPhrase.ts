// One recovery phrase for every chain — the All-in-One wallet's keys.
//
// Pure: no `electron` import, no file access, nothing kept. The phrase goes
// in, raw key bytes come out, and the caller hands them to the wallet stores
// that already know how to encrypt and sign with them (wallet.ts for Solana,
// evmWallet.ts for BNB and Robinhood). So the All-in-One wallet adds no new
// signer — the keys it derives sign through exactly the code every other
// wallet signs through.
//
// THE PATHS ARE PHANTOM'S AND METAMASK'S, on purpose. The phrase is the
// user's backup, and a backup that only this app can open is a trap: the
// same twelve words typed into Phantom must show the same Solana address,
// and into MetaMask the same EVM address. So:
//
//   Solana  m/44'/501'/{i}'/0'   SLIP-10 ed25519 (every level hardened —
//                                ed25519 has no unhardened derivation)
//   EVM     m/44'/60'/0'/0/{i}   BIP-32 secp256k1. One address on BNB,
//                                Robinhood and every other EVM chain.
//
// Phantom pairs the two at the same index i. Account 0 is the wallet.
// Verified against independent implementations in test/seedphrase.test.mjs.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

/** 128 bits of entropy = twelve words, what Phantom and MetaMask create. */
const STRENGTH_BITS = 128;

/** Hardened offset, BIP-32 / SLIP-10. */
const HARDENED = 0x80000000;

/** Account indexes beyond this are refused: nobody has a thousand accounts
 *  under one phrase, and a typo'd huge index would silently derive a fresh
 *  empty wallet. */
const MAX_ACCOUNT = 1000;

/** A fresh twelve-word English phrase. */
export function newSeedPhrase(): string {
  return generateMnemonic(wordlist, STRENGTH_BITS);
}

/**
 * The phrase as the user meant it: lower case, single spaces, no stray
 * punctuation from a copy-paste. Never changes a word — a misspelling stays
 * a misspelling and fails the checksum below.
 */
export function normaliseSeedPhrase(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\s,;]+/g, ' ')
    .trim();
}

/** Why a phrase cannot be used, or null when it can. Checks the word count,
 *  every word against the list, and the checksum, in that order — so the
 *  message names the first real problem. */
export function seedPhraseProblem(input: string): string | null {
  const phrase = normaliseSeedPhrase(input);
  if (!phrase) return 'Enter the recovery phrase.';
  const words = phrase.split(' ');
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return `A recovery phrase has 12 or 24 words — this has ${words.length}.`;
  }
  const unknown = words.findIndex((w) => !wordlist.includes(w));
  if (unknown >= 0) return `Word ${unknown + 1} ("${words[unknown]}") is not a recovery-phrase word. Check the spelling.`;
  if (!validateMnemonic(phrase, wordlist)) {
    return 'The words are real but the phrase does not check out — one word is wrong or two are swapped.';
  }
  return null;
}

function seedOf(phrase: string): Uint8Array {
  const problem = seedPhraseProblem(phrase);
  if (problem) throw new Error(problem);
  return mnemonicToSeedSync(normaliseSeedPhrase(phrase));
}

function checkAccount(account: number): void {
  if (!Number.isInteger(account) || account < 0 || account > MAX_ACCOUNT) {
    throw new Error(`account index must be an integer 0-${MAX_ACCOUNT}`);
  }
}

/** SLIP-10 ed25519 from a BIP-39 seed. Every index is hardened. */
export function slip10Ed25519(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** The 32-byte ed25519 seed of Solana account `account` — exactly what
 *  wallet.ts stores and `Keypair.fromSeed` takes. */
export function solanaSeedFromPhrase(phrase: string, account = 0): Uint8Array {
  checkAccount(account);
  return slip10Ed25519(seedOf(phrase), [44, 501, account, 0]);
}

/** The 32-byte ed25519 seed at an explicit SLIP-10 path (all hardened). */
export function solanaSeedAtPath(phrase: string, path: number[]): Uint8Array {
  if (!Array.isArray(path) || path.length < 2 || path.length > 5 || path.some((n) => !Number.isInteger(n) || n < 0 || n > 0x7fffffff)) {
    throw new Error('Invalid Solana derivation path');
  }
  return slip10Ed25519(seedOf(phrase), path);
}

/** The secp256k1 private key at an explicit BIP-32 path. */
export function evmPrivateKeyAtPath(phrase: string, path: string): Uint8Array {
  if (!/^m(\/\d+'?){3,6}$/.test(path)) throw new Error('Invalid EVM derivation path');
  const node = HDKey.fromMasterSeed(seedOf(phrase)).derive(path);
  if (!node.privateKey) throw new Error('EVM derivation produced no private key');
  return node.privateKey;
}

/** The 32-byte secp256k1 private key of EVM account `account`. */
export function evmPrivateKeyFromPhrase(phrase: string, account = 0): Uint8Array {
  checkAccount(account);
  const node = HDKey.fromMasterSeed(seedOf(phrase)).derive(`m/44'/60'/0'/0/${account}`);
  if (!node.privateKey) throw new Error('EVM derivation produced no private key');
  return node.privateKey;
}
